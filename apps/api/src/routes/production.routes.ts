import { Router } from 'express'
import type { MOStatus, Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, userCan, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
import { assertStylesInProduction } from '../lib/styleStage'
import { createRequisitionSchema } from '../schemas/inventory.schemas'
import { createRequisition } from './inventory.routes'
import { ensureJobCards, jobCardSchema, updateJobCard } from '../services/jobCard.service'
import { attachLateBoms, findBom, materialPlan, MO_STAGES, moStages, orderForPlanning, PLANNABLE_ORDER_STATUSES, stageWhere, workStarted, type MoStage } from '../services/manufacturing.service'
import { garmentTemplate } from '../services/openingStock.service'
import { breakupOf, cancelCutting, createCutting, cuttingPrep, cuttingSchema, cutterIssueDetailsSchema, piecesBeingSaved, updateCutterIssue } from '../services/cutting.service'
import { applyRouting, routingProblem, stylesOfMo } from '../services/route.service'
import floorRoutes from './productionFloor.routes'
import { assertNotCancelling } from '../services/orderCancel.service'
import { moChanges, moHistory } from '../services/moHistory.service'

/**
 * Manufacturing orders: what the factory is to make — for a sales order, or,
 * direct, for stock or samples (style, colour and sizes picked on the form,
 * linked to a sales order later if one comes for them).
 *
 * Raised from a confirmed order — its lines, by style, colour and size, with
 * what is still to plan filled in — as a draft, then released to the floor.
 * Releasing puts the sales order In production. Each line carries the
 * approved BOM it will be made to, and the material plan multiplies that out:
 * every material the order needs, against what is in the stores and what has
 * already been asked for. One press raises the requisitions, one per
 * department the BOM gives the materials to, into the store's ordinary
 * approve-issue-or-buy flow.
 *
 * Packed pieces are the finished goods booked in against the order (see
 * finishedGoods.routes), never typed. A manufacturing order is closed with a
 * reason, never deleted.
 */

const router = Router()
const MODULE = 'production'

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const MO_STATUSES: MOStatus[] = ['DRAFT', 'RELEASED', 'CUTTING', 'STITCHING', 'FINISHING', 'QC', 'PACKING', 'COMPLETED', 'CLOSED']
/** Released and not finished: work the floor has in hand. */
const LIVE: MOStatus[] = ['RELEASED', 'CUTTING', 'STITCHING', 'FINISHING', 'QC', 'PACKING']

const pieces = z.number().int('Pieces are whole numbers').min(0, 'Pieces cannot be less than nothing').max(1_000_000)

const moLineSchema = z.object({
  /** The sales order line it makes; left out on a direct order. */
  soLineId: z.string().min(1).optional(),
  /** A direct order's line: the style and colour it makes. */
  styleId: z.string().min(1).optional(),
  color: z.string().trim().max(60).optional().nullable(),
  sizes: z.array(z.object({ sizeId: z.string().min(1), qty: pieces })).optional(),
  qty: pieces.optional(),
})

/** What a direct order is made for: stock, samples, or a customer whose order is not raised (yet). */
const directPurpose = z.enum(['STOCK', 'SAMPLE', 'CUSTOMER'])

const moFields = {
  plannedStartDate: z.coerce.date().optional().nullable(),
  plannedEndDate: z.coerce.date().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  /** The routing whose steps the order takes. Needed before it is released. */
  routingId: z.string().optional().nullable(),
  lines: z.array(moLineSchema).min(1, 'Put at least one line on it'),
}

type MoLineInput = z.infer<typeof moLineSchema>

function checkMo(d: { plannedStartDate?: Date | null; plannedEndDate?: Date | null; lines: MoLineInput[] }, ctx: z.RefinementCtx) {
  if (d.plannedStartDate && d.plannedEndDate && d.plannedEndDate < d.plannedStartDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['plannedEndDate'], message: 'It cannot finish before it starts' })
  }
  // A line is an order line, or on a direct order a style and colour: the same one twice is a slip.
  const ids = d.lines.map((l) => l.soLineId ?? `${l.styleId}|${(l.color ?? '').trim().toLowerCase()}`)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'The same line appears twice' })
}

const moBodySchema = z
  .object({
    ...moFields,
    /** A direct order's brand (one of our own) and what it is for: kept as they are when left out. */
    brandId: z.string().min(1).optional(),
    purpose: directPurpose.optional(),
    /** A direct order for a customer: who it is for. */
    customerId: z.string().min(1).optional().nullable(),
  })
  .superRefine(checkMo)

export const createMoSchema = z
  .object({
    ...moFields,
    /** The sales order it makes; left out for a direct order (stock or samples). */
    soId: z.string().min(1).optional().nullable(),
    /** A direct order: the brand it is made under (one of our own), and what it is for. */
    brandId: z.string().min(1).optional(),
    purpose: directPurpose.optional(),
    /** A direct order for a customer: who it is for. */
    customerId: z.string().min(1).optional().nullable(),
    /** Release to the floor on saving, rather than keep it as a draft. */
    release: z.boolean().optional(),
  })
  .superRefine(checkMo)
  .superRefine((d, ctx) => {
    if (d.soId) {
      if (d.lines.some((l) => !l.soLineId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'Say which order line each line makes' })
      return
    }
    if (!d.brandId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['brandId'], message: 'Pick the brand it is made under' })
    if (d.purpose === 'CUSTOMER' && !d.customerId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['customerId'], message: 'Pick the customer it is made for' })
    if (d.lines.some((l) => !l.styleId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'Pick the style of each line' })
  })

const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(500) })

/**
 * The lines of a manufacturing order, checked against the order they make:
 * each must be one of its lines, with a style to make it to, and sizes the
 * order line carries. Lines with nothing to make are left off.
 */
async function shapeLines(tx: Prisma.TransactionClient, soId: string, input: z.infer<typeof moBodySchema>, exceptMoId?: string) {
  await assertNotCancelling(tx, soId, 'nothing more is planned for it')
  const { so, lines } = await orderForPlanning(tx, soId, exceptMoId)
  if (!(PLANNABLE_ORDER_STATUSES as readonly string[]).includes(so.status)) {
    throw new AppError(
      so.status === 'DRAFT'
        ? `${so.soNumber} is still a draft. Confirm it before planning production.`
        : `${so.soNumber} is ${so.status.toLowerCase().replace(/_/g, ' ')}, so nothing more is to be made for it`,
      409,
      'ORDER_NOT_OPEN',
    )
  }
  const byId = new Map(lines.map((l) => [l.soLineId, l]))
  const shaped = input.lines
    .map((l, i) => {
      const line = l.soLineId ? byId.get(l.soLineId) : undefined
      if (!line) throw new AppError(`Line ${i + 1} is not on ${so.soNumber}`, 400, 'BAD_LINE')
      const known = new Set(line.sizes.map((s) => s.sizeId))
      const sizes = line.sizes.length ? (l.sizes ?? []).filter((s) => s.qty > 0) : []
      for (const s of sizes) {
        if (!known.has(s.sizeId)) throw new AppError(`${line.item.code}: one of the sizes is not on the order line`, 400, 'BAD_SIZE')
      }
      const total = line.sizes.length ? sizes.reduce((t, s) => t + s.qty, 0) : l.qty ?? 0
      if (total <= 0) return null
      if (!line.style) throw new AppError(line.problem ?? `${line.item.code} has no style`, 400, 'NO_STYLE')
      return { line, sizes, total }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
  if (!shaped.length) throw new AppError('Put the pieces to make against at least one line', 400, 'NOTHING_TO_MAKE')
  // Nothing goes to the floor in a style still being sampled.
  await assertStylesInProduction(tx, shaped.map((s) => s.line.style!.id))

  return {
    so,
    total: shaped.reduce((t, s) => t + s.total, 0),
    create: shaped.map((s) => ({
      styleId: s.line.style!.id,
      color: s.line.color ?? '',
      totalQty: s.total,
      soLineId: s.line.soLineId,
      bomId: s.line.bom?.id ?? null,
      sizes: s.sizes.length ? { create: s.sizes.map((z) => ({ sizeId: z.sizeId, qty: z.qty })) } : undefined,
    })),
  }
}

/**
 * A direct order's lines: a style, one of its colours, and the pieces by
 * size of its size run (or a total for a style without one). The finished
 * item for that style and colour must be in Items & Products — the pieces
 * are booked in as it when packed — and the line takes the style's approved
 * BOM for the colour, as an order's line does. Lines with nothing to make
 * are left off.
 */
async function shapeDirectLines(tx: Prisma.TransactionClient, input: { lines: MoLineInput[] }) {
  const ids = [...new Set(input.lines.map((l) => l.styleId).filter((x): x is string => !!x))]
  const styles = await tx.style.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, isActive: true, colors: true, sizeGroupId: true },
  })
  const byId = new Map(styles.map((st) => [st.id, st]))
  const groups = [...new Set(styles.map((st) => st.sizeGroupId).filter((x): x is string => !!x))]
  const sizes = groups.length ? await tx.size.findMany({ where: { sizeGroupId: { in: groups } }, select: { id: true, sizeGroupId: true } }) : []
  const shaped: Array<{ styleId: string; color: string; total: number; sizes: Array<{ sizeId: string; qty: number }>; bomId: string | null }> = []
  for (const [i, l] of input.lines.entries()) {
    const st = l.styleId ? byId.get(l.styleId) : undefined
    if (!st) throw new AppError(`Line ${i + 1}: pick the style to make.`, 400, 'BAD_LINE')
    if (!st.isActive) throw new AppError(`${st.code} is switched off in Masters → Styles, so nothing is made in it.`, 400, 'INACTIVE')
    const typed = (l.color ?? '').trim()
    const color = st.colors.find((c) => c.trim().toLowerCase() === typed.toLowerCase()) ?? null
    if (st.colors.length && !color) {
      throw new AppError(typed ? `${st.code} does not come in ${typed}. Its colours: ${st.colors.join(', ')}.` : `${st.code}: pick the colour to make.`, 400, 'BAD_COLOUR')
    }
    const known = new Set(sizes.filter((z) => z.sizeGroupId === st.sizeGroupId).map((z) => z.id))
    const picked = known.size ? (l.sizes ?? []).filter((z) => z.qty > 0) : []
    for (const z of picked) if (!known.has(z.sizeId)) throw new AppError(`${st.code}: one of the sizes is not in its size run.`, 400, 'BAD_SIZE')
    const total = known.size ? picked.reduce((t, z) => t + z.qty, 0) : l.qty ?? 0
    if (total <= 0) continue
    const item = await tx.item.findFirst({
      where: { styleId: st.id, type: 'FINISHED_GOOD', isActive: true, ...(color ? { color: { equals: color, mode: 'insensitive' } } : {}) },
      select: { id: true },
    })
    if (!item) {
      throw new AppError(`${st.code}${color ? ` ${color}` : ''} has no finished item yet, to book its pieces in as: add it first (Add item, on the line, or Masters → Items & Products).`, 400, 'NO_ITEM')
    }
    const bom = await findBom(tx, st.id, color)
    shaped.push({ styleId: st.id, color: color ?? '', total, sizes: picked, bomId: bom?.id ?? null })
  }
  if (!shaped.length) throw new AppError('Put the pieces to make on at least one line', 400, 'NOTHING_TO_MAKE')
  // Nothing goes to the floor in a style still being sampled.
  await assertStylesInProduction(tx, shaped.map((x) => x.styleId))
  return {
    total: shaped.reduce((t, x) => t + x.total, 0),
    create: shaped.map((x) => ({
      styleId: x.styleId,
      color: x.color,
      totalQty: x.total,
      soLineId: null,
      bomId: x.bomId,
      sizes: x.sizes.length ? { create: x.sizes.map((z) => ({ sizeId: z.sizeId, qty: z.qty })) } : undefined,
    })),
  }
}

/** One of our own brands, switched on: what a direct order is made under. */
async function ownBrand(tx: Prisma.TransactionClient, brandId: string) {
  const brand = await tx.brand.findUnique({ where: { id: brandId }, select: { id: true, name: true, isActive: true, type: true } })
  if (!brand) throw new AppError('That brand does not exist', 400, 'BAD_BRAND')
  if (!brand.isActive) throw new AppError(`The brand ${brand.name} is switched off`, 400, 'INACTIVE')
  if (brand.type === 'CUSTOM') throw new AppError(`${brand.name} is a customer's brand. Pick one of your own, from Masters → In House Brands.`, 400, 'NOT_OWN_BRAND')
  return brand
}

/** A customer a direct order is made for: there, and switched on. */
async function directCustomer(tx: Prisma.TransactionClient, customerId: string) {
  const c = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true, isActive: true } })
  if (!c) throw new AppError('That customer does not exist', 400, 'BAD_CUSTOMER')
  if (!c.isActive) throw new AppError(`${c.name} is switched off in Masters → Customers`, 400, 'INACTIVE')
  return c
}

/** What a manufacturing order is made for, in a few words: its sales order, or stock, samples, or the customer. */
const madeFor = (mo: { purpose: string; so?: { soNumber: string } | null; customer?: { name: string } | null }) =>
  mo.so ? mo.so.soNumber : mo.purpose === 'SAMPLE' ? 'samples' : mo.purpose === 'CUSTOMER' ? (mo.customer?.name ?? 'a customer') : 'stock'

/** Released: the floor has it, and the sales order is in production. */
async function release(tx: Prisma.TransactionClient, moId: string) {
  const mo = await tx.manufacturingOrder.update({
    where: { id: moId },
    data: { status: 'RELEASED' },
    select: { soId: true },
  })
  if (mo.soId) await tx.salesOrder.updateMany({ where: { id: mo.soId, status: 'CONFIRMED' }, data: { status: 'IN_PRODUCTION' } })
  // One job card per colour, for the floor's sheets.
  await ensureJobCards(tx, moId)
}

const moInclude = {
  brand: { select: { id: true, name: true, type: true } },
  // A direct order made for a customer: who.
  customer: { select: { id: true, name: true } },
  so: {
    select: {
      id: true,
      soNumber: true,
      status: true,
      isJobWork: true,
      deliveryDate: true,
      customerPORef: true,
      customer: { select: { id: true, name: true } },
      // Short-closed or cancelled: when and why, for an order still open under it.
      shortClosedAt: true,
      shortCloseReason: true,
      cancelledAt: true,
      cancelReason: true,
    },
  },
  lines: {
    include: {
      style: { select: { id: true, code: true, name: true } },
      sizes: { include: { size: { select: { id: true, code: true, sequence: true } } }, orderBy: { size: { sequence: 'asc' } } },
      soLine: { select: { id: true, item: { select: { id: true, code: true, name: true } } } },
      bom: { select: { id: true, version: true, color: true, status: true } },
    },
  },
  materialRequisitions: {
    select: {
      id: true,
      mrNumber: true,
      status: true,
      requestDate: true,
      issuedAt: true,
      closedAt: true,
      department: { select: { name: true } },
      _count: { select: { lines: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
  fgReceipts: {
    select: { id: true, fgrNumber: true, receiptDate: true, cancelledAt: true, lines: { select: { qty: true } } },
    orderBy: { receiptDate: 'asc' },
  },
  cuttingOrders: {
    select: {
      id: true,
      cutOrderNumber: true,
      cutDate: true,
      status: true,
      fabricUsed: true,
      wastage: true,
      actualPieces: true,
      lotNo: true,
      ratio: true,
      cutterName: true,
      noOfLayers: true,
      bundleSize: true,
      sizeBreakup: true,
      moLine: { select: { color: true, style: { select: { code: true } } } },
      fabricItem: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
      panelItem: { select: { code: true } },
      _count: { select: { bundles: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
  routing: { select: { id: true, code: true, name: true, version: true } },
  steps: {
    orderBy: { sequence: 'asc' },
    select: { id: true, sequence: true, name: true, kind: true, execution: true, isQcStep: true, skippedAt: true, department: { select: { name: true } } },
  },
  heldBy: { select: { name: true } },
  createdBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
} satisfies Prisma.ManufacturingOrderInclude

// GET /api/production/orders — filters: q, status, stage (see moStages), soId, brandId, open=1, page, limit.
router.get('/orders', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const and: Prisma.ManufacturingOrderWhereInput[] = []
  const status = text(req.query.status)
  if (status) {
    if (!MO_STATUSES.includes(status as MOStatus)) throw new AppError(`Unknown status '${status}'`, 400, 'BAD_STATUS')
    and.push({ status: status as MOStatus })
  }
  if (req.query.open === '1') and.push({ status: { in: ['DRAFT', ...LIVE] } })
  const brandId = text(req.query.brandId)
  if (brandId) and.push({ brandId })
  const soId = text(req.query.soId)
  if (soId) and.push({ soId })
  // direct=1: made with no sales order, for stock or samples.
  if (text(req.query.direct) === '1') and.push({ soId: null })
  const q = text(req.query.q)
  if (q) {
    and.push({
      OR: [
        { moNumber: { contains: q, mode: 'insensitive' } },
        { so: { soNumber: { contains: q, mode: 'insensitive' } } },
        { so: { customer: { name: { contains: q, mode: 'insensitive' } } } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
        { lines: { some: { style: { code: { contains: q, mode: 'insensitive' } } } } },
      ],
    })
  }
  // Lines planned before their BOM was approved pick it up, so "without a BOM" is true.
  await attachLateBoms(prisma)
  // Where the work stands: the list's Status filter.
  const stage = text(req.query.stage)
  if (stage) {
    if (!(MO_STAGES as readonly string[]).includes(stage)) throw new AppError(`Unknown stage '${stage}'`, 400, 'BAD_STAGE')
    and.push(await stageWhere(prisma, stage as MoStage, { AND: [...and] }))
  }
  const where: Prisma.ManufacturingOrderWhereInput = and.length ? { AND: and } : {}

  const [orders, total] = await Promise.all([
    prisma.manufacturingOrder.findMany({
      where,
      include: {
        brand: { select: { id: true, name: true, type: true } },
        so: { select: { id: true, soNumber: true, status: true, shortClosedAt: true, deliveryDate: true, customer: { select: { name: true } } } },
        // A direct order made for a customer: who.
        customer: { select: { name: true } },
        lines: { select: { color: true, bomId: true, style: { select: { code: true } } } },
        routing: { select: { code: true } },
        _count: { select: { materialRequisitions: true, steps: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.manufacturingOrder.count({ where }),
  ])
  // Which of them work has started on (material issued, cutting recorded, packed): not to be edited.
  const ids = orders.map((o) => o.id)
  const [issuedTo, cutOn, packedOn] = ids.length
    ? await Promise.all([
        prisma.materialRequisition.findMany({ where: { moId: { in: ids }, lines: { some: { issuedQty: { gt: 0 } } } }, select: { moId: true }, distinct: ['moId'] }),
        prisma.cuttingOrder.findMany({ where: { moId: { in: ids }, status: { not: 'CANCELLED' } }, select: { moId: true }, distinct: ['moId'] }),
        prisma.manufacturingOrder.findMany({ where: { id: { in: ids }, fgReceipts: { some: { cancelledAt: null } } }, select: { id: true } }),
      ])
    : [[], [], []]
  const issued = new Set(issuedTo.map((m) => m.moId))
  const cut = new Set(cutOn.map((c) => c.moId))
  const packed = new Set(packedOn.map((m) => m.id))
  /** Why a row's plan can no longer be changed, in a few words; null while it can. */
  const blockOf = (mo: (typeof orders)[number]) =>
    mo.status === 'COMPLETED' || mo.status === 'CLOSED'
      ? `${mo.moNumber} is ${mo.status.toLowerCase()}`
      : mo.so && !(PLANNABLE_ORDER_STATUSES as readonly string[]).includes(mo.so.status)
        ? `${mo.so.soNumber} is ${mo.so.shortClosedAt ? 'short-closed' : mo.so.status.toLowerCase().replace(/_/g, ' ')}, so nothing more is planned for it`
        : issued.has(mo.id)
          ? 'The store has issued material to it'
          : cut.has(mo.id)
            ? 'Cutting is recorded on it'
            : packed.has(mo.id)
              ? 'Pieces of it are packed'
              : null
  const stages = await moStages(prisma, orders.map((o) => ({ ...o, soStatus: o.so?.status ?? null })))

  res.json({
    success: true,
    data: orders.map((mo) => ({
      id: mo.id,
      moNumber: mo.moNumber,
      status: mo.status,
      // Where the work stands (materials asked, issued, in production, packing): its status says only "released".
      stage: stages.get(mo.id)?.stage ?? mo.status,
      materialItems: stages.get(mo.id)?.materialItems ?? null,
      materialItemsInFull: stages.get(mo.id)?.materialItemsInFull ?? null,
      // Its plan can still be changed (nothing issued to it, cut or packed; it and its order open), and if not, why.
      editable: blockOf(mo) === null,
      editBlock: blockOf(mo),
      brand: mo.brand,
      soId: mo.so?.id ?? null,
      customer: mo.so?.customer.name ?? mo.customer?.name ?? null,
      soNumber: mo.so?.soNumber ?? null,
      purpose: mo.purpose,
      deliveryDate: mo.so?.deliveryDate ?? null,
      // A manufacturing order can cover several styles, so the list gets all
      // their codes and decides how many to show.
      styles: mo.lines.map((l) => (l.color ? `${l.style.code} ${l.color}` : l.style.code)),
      withoutBom: mo.lines.filter((l) => !l.bomId).length,
      requisitions: mo._count.materialRequisitions,
      plannedStartDate: mo.plannedStartDate,
      plannedEndDate: mo.plannedEndDate,
      createdAt: mo.createdAt,
      closeReason: mo.closeReason,
      totalPlannedQty: mo.totalPlannedQty,
      totalCutQty: mo.totalCutQty,
      totalStitchedQty: mo.totalStitchedQty,
      totalFinishedQty: mo.totalFinishedQty,
      totalPackedQty: mo.totalPackedQty,
      // Where the work stands across its route, and whether it has one.
      progress: mo.progress,
      routing: mo.routing?.code ?? null,
      routed: mo._count.steps > 0,
      held: !!mo.heldAt,
      holdReason: mo.holdReason,
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

/**
 * GET /api/production/plan?soId=&moId=
 *
 * A sales order as the manufacturing-order form plans it: each line's style,
 * colour and BOM, and by size what is ordered, already planned and left.
 * `moId` leaves out a draft being edited, so its own pieces count as left.
 */
router.get('/plan', requirePermission(MODULE, 'view'), async (req, res) => {
  const soId = text(req.query.soId)
  if (!soId) throw new AppError('Pick the sales order', 400, 'NO_ORDER')
  const { so, lines } = await orderForPlanning(prisma, soId, text(req.query.moId))
  res.json({ success: true, data: { order: so, lines } })
})

/** GET /api/production/plannable — sales orders with pieces still to plan, for the picker. */
router.get('/plannable', requirePermission(MODULE, 'view'), async (_req, res) => {
  const orders = await prisma.salesOrder.findMany({
    where: { status: { in: [...PLANNABLE_ORDER_STATUSES] } },
    select: {
      id: true,
      soNumber: true,
      deliveryDate: true,
      customer: { select: { name: true } },
      lines: { select: { totalQty: true, moLines: { where: { mo: { status: { not: 'CLOSED' } } }, select: { totalQty: true } } } },
    },
    orderBy: [{ deliveryDate: { sort: 'asc', nulls: 'last' } }, { orderDate: 'asc' }],
    take: 300,
  })
  res.json({
    success: true,
    data: orders
      .map((o) => {
        const ordered = o.lines.reduce((s, l) => s + Number(l.totalQty), 0)
        const planned = o.lines.reduce((s, l) => s + l.moLines.reduce((t, m) => t + m.totalQty, 0), 0)
        return { id: o.id, soNumber: o.soNumber, deliveryDate: o.deliveryDate, customer: o.customer.name, ordered, planned, toPlan: Math.max(0, ordered - planned) }
      })
      .filter((o) => o.toPlan > 0),
  })
})

// GET /api/production/orders/:id
router.get('/orders/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  // A BOM approved after the order was made is picked up now.
  await attachLateBoms(prisma, req.params.id)
  const order = await prisma.manufacturingOrder.findUnique({ where: { id: req.params.id }, include: moInclude })
  if (!order) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  const [editBlock, detailsBlock, stages] = await Promise.all([
    moEditBlock(prisma, order),
    moDetailsBlock(prisma, order),
    moStages(prisma, [{ ...order, soStatus: order.so?.status ?? null }]),
  ])
  res.json({ success: true, data: { ...order, editBlock, detailsBlock, stage: stages.get(order.id)?.stage ?? order.status } })
})

/** GET /api/production/orders/:id/history — who changed what on it, and when, newest first. */
router.get('/orders/:id/history', requirePermission(MODULE, 'view'), async (req, res) => {
  res.json({ success: true, data: await moHistory(prisma, req.params.id) })
})

/** Raises a manufacturing order inside the caller's transaction. Exported for the checks that roll it back. */
export async function createMo(tx: Prisma.TransactionClient, data: z.infer<typeof createMoSchema>, userId: string) {
  // From a sales order, its lines; direct, the styles picked, under a brand of our own.
  const { so, total, create } = data.soId ? await shapeLines(tx, data.soId, data) : { so: null, ...(await shapeDirectLines(tx, data)) }
  const brandId = so ? so.brandId : (await ownBrand(tx, data.brandId!)).id
  const purpose = so ? 'ORDER' : (data.purpose ?? 'STOCK')
  const customerId = purpose === 'CUSTOMER' ? (await directCustomer(tx, data.customerId!)).id : null
  // Every check first: a refused order takes no number.
  const moNumber = await nextDocumentNumber(tx, 'MO', new Date())
  const mo = await tx.manufacturingOrder.create({
    data: {
      moNumber,
      soId: so?.id ?? null,
      brandId,
      purpose,
      customerId,
      plannedStartDate: data.plannedStartDate ?? null,
      plannedEndDate: data.plannedEndDate ?? so?.deliveryDate ?? null,
      totalPlannedQty: total,
      notes: data.notes ?? null,
      createdById: userId,
      lines: { create },
    },
  })
  // Its own copy of the routing's steps, checked against the styles it makes.
  if (data.routingId) await applyRouting(tx, mo.id, data.routingId)
  if (data.release) await release(tx, mo.id)
  return tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id }, include: moInclude })
}

// POST /api/production/orders
router.post('/orders', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createMoSchema.parse(req.body)
  const mo = await prisma.$transaction((tx) => createMo(tx, data, req.user!.id), { timeout: 30_000 })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'ManufacturingOrder', entityId: mo.id, after: mo })
  res.status(201).json({
    success: true,
    message: `${mo.moNumber} ${mo.status === 'RELEASED' ? 'released to the floor' : 'saved as a draft'}: ${mo.totalPlannedQty.toLocaleString('en-IN')} pcs for ${madeFor(mo)}.`,
    data: mo,
  })
})

/**
 * Why a manufacturing order can no longer be changed, or null when it can.
 *
 * Its plan stays open, released or not and with requisitions raised or not,
 * until work has really started on it: material issued from the store to
 * it, cutting recorded, pieces packed, or the order finished. After that the
 * floor is working to the plan as it stands.
 */
export async function moEditBlock(db: Prisma.TransactionClient | typeof prisma, mo: { id: string; moNumber: string; status: string }) {
  if (mo.status === 'COMPLETED' || mo.status === 'CLOSED') return `${mo.moNumber} is ${mo.status.toLowerCase()}, so it can no longer be changed.`
  const order = await db.manufacturingOrder.findUnique({ where: { id: mo.id }, select: { so: { select: { soNumber: true, status: true, shortClosedAt: true } } } })
  if (order?.so && !(PLANNABLE_ORDER_STATUSES as readonly string[]).includes(order.so.status)) {
    const word = order.so.shortClosedAt ? 'short-closed' : order.so.status.toLowerCase().replace(/_/g, ' ')
    return `${order.so.soNumber} is ${word}, so nothing more is planned for it and ${mo.moNumber} can no longer be changed.`
  }
  const issued = await db.materialRequisition.findFirst({
    where: { moId: mo.id, lines: { some: { issuedQty: { gt: 0 } } } },
    select: { mrNumber: true },
  })
  if (issued) return `The store has issued material to ${mo.moNumber} (${issued.mrNumber}), so its plan can no longer be changed.`
  const cut = await db.cuttingOrder.findFirst({ where: { moId: mo.id, status: { not: 'CANCELLED' } }, select: { cutOrderNumber: true } })
  if (cut) return `Cutting is recorded on ${mo.moNumber} (${cut.cutOrderNumber}), so its plan can no longer be changed.`
  const packed = await db.manufacturingOrder.count({ where: { id: mo.id, fgReceipts: { some: { cancelledAt: null } } } })
  if (packed) return `Pieces of ${mo.moNumber} are packed, so its plan can no longer be changed.`
  return null
}

/**
 * Why a manufacturing order's details can no longer be changed, or null when
 * they can.
 *
 * The details — its dates and note, each job card's lot no., metres, ratio
 * and the like, and a lay still with its cutting contractor — stay open after
 * material is issued and cutting has begun, until cutting is complete: every
 * planned piece cut, and no lay still out with a contractor. Its plan (pieces,
 * sizes, routing) closes earlier, when material is issued: see moEditBlock.
 */
export async function moDetailsBlock(
  db: Prisma.TransactionClient | typeof prisma,
  mo: { id: string; moNumber: string; status: string; totalPlannedQty: number; totalCutQty: number },
) {
  if (mo.status === 'COMPLETED' || mo.status === 'CLOSED') return `${mo.moNumber} is ${mo.status.toLowerCase()}, so it can no longer be changed.`
  if (mo.totalPlannedQty > 0 && mo.totalCutQty >= mo.totalPlannedQty) {
    const withCutters = await db.cuttingOrder.count({ where: { moId: mo.id, status: 'IN_PROGRESS' } })
    if (!withCutters) return `Cutting is complete on ${mo.moNumber}, so its details can no longer be changed.`
  }
  return null
}

/**
 * PATCH /api/production/orders/:id — the plan changed: dates, notes, pieces,
 * routing. A draft, or a released order nothing has been issued to yet.
 */
router.patch('/orders/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = moBodySchema.parse(req.body)
  const { before, after } = await prisma.$transaction(
    async (tx) => {
      const before = await tx.manufacturingOrder.findUnique({ where: { id: req.params.id }, include: moInclude })
      if (!before) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
      const block = await moEditBlock(tx, before)
      if (block) throw new AppError(block, 409, 'MO_STARTED')
      // A direct order's lines are its styles; its brand and purpose may change with them.
      const { total, create } = before.soId ? await shapeLines(tx, before.soId, data, before.id) : await shapeDirectLines(tx, data)
      const purpose = data.purpose ?? before.purpose
      const direct = !before.soId
        ? {
            ...(data.brandId ? { brandId: (await ownBrand(tx, data.brandId)).id } : {}),
            ...(data.purpose ? { purpose: data.purpose } : {}),
            // For a customer: the one picked (or kept); for stock or samples, none.
            customerId:
              purpose === 'CUSTOMER'
                ? (await directCustomer(tx, data.customerId ?? before.customerId ?? (() => { throw new AppError('Pick the customer it is made for', 400, 'NO_CUSTOMER') })())).id
                : null,
          }
        : {}
      await tx.mOLine.deleteMany({ where: { moId: before.id } })
      await tx.manufacturingOrder.update({
        where: { id: before.id },
        data: {
          plannedStartDate: data.plannedStartDate ?? null,
          plannedEndDate: data.plannedEndDate ?? null,
          notes: data.notes ?? null,
          totalPlannedQty: total,
          ...direct,
          lines: { create },
        },
      })
      // A different routing is copied afresh; the same one is checked against
      // the lines as they now are; none takes the route off.
      if (data.routingId === null) {
        await tx.mOStep.deleteMany({ where: { moId: before.id } })
        await tx.manufacturingOrder.update({ where: { id: before.id }, data: { routingId: null, routingVersion: null } })
      } else if (data.routingId && data.routingId !== before.routingId) {
        await applyRouting(tx, before.id, data.routingId)
      } else if (before.routingId) {
        const routing = await tx.routing.findUniqueOrThrow({ where: { id: before.routingId }, select: { code: true, styleId: true, category: true, style: { select: { code: true } } } })
        const problem = routingProblem(routing, await stylesOfMo(tx, before.id))
        if (problem) throw new AppError(`${routing.code} no longer suits these lines. ${problem}`, 400, 'ROUTING_DOES_NOT_FIT')
      }
      const after = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: before.id }, include: moInclude })
      return { before, after }
    },
    { timeout: 30_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: after.id, before, after })
  const waiting = await prisma.materialRequisition.findMany({
    where: { moId: after.id, closedAt: null, status: { in: ['PENDING', 'APPROVED'] } },
    select: { mrNumber: true },
  })
  const note = waiting.length
    ? ` ${waiting.map((m) => m.mrNumber).join(', ')} ${waiting.length === 1 ? 'was' : 'were'} raised for the plan before: check ${waiting.length === 1 ? 'it' : 'them'} against Materials, which shows what is still to ask for.`
    : ''
  const changes = moChanges(before, after)
  const said = changes.length
    ? `: ${changes.slice(0, 4).join('; ')}${changes.length > 4 ? `; and ${changes.length - 4} more (see History)` : ''}`
    : ', nothing changed'
  res.json({ success: true, message: `${after.moNumber} saved${said}.${note}`, data: after })
})

/**
 * GET /api/production/orders/:id/details — what can still be changed on an
 * order once its plan is fixed: its dates and note, each job card's details,
 * and the lays still with cutting contractors, with the fabric issued to it.
 */
router.get('/orders/:id/details', requirePermission(MODULE, 'view'), async (req, res) => {
  const mo = await prisma.manufacturingOrder.findUnique({
    where: { id: req.params.id },
    select: { id: true, moNumber: true, status: true, totalPlannedQty: true, totalCutQty: true, plannedStartDate: true, plannedEndDate: true, notes: true },
  })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  const [planBlock, detailsBlock, jobCards, prep] = await Promise.all([
    moEditBlock(prisma, mo),
    moDetailsBlock(prisma, mo),
    prisma.jobCard.findMany({
      where: { moId: mo.id },
      orderBy: { jobCardNumber: 'asc' },
      select: {
        id: true,
        jobCardNumber: true,
        orderNo: true,
        projectId: true,
        description: true,
        fabricQuality: true,
        designNo: true,
        lotNo: true,
        meters: true,
        average: true,
        ratio: true,
        notes: true,
        moLine: { select: { color: true, style: { select: { code: true } } } },
      },
    }),
    cuttingPrep(prisma, mo.id),
  ])
  res.json({
    success: true,
    data: {
      ...mo,
      planBlock,
      detailsBlock,
      jobCards,
      // Only the lays still out: one that has come back cut is done.
      cuttingIssues: prep.cuttings
        .filter((c) => c.status === 'IN_PROGRESS')
        .map((c) => {
          const line = prep.lines.find((l) => l.id === c.moLineId)
          const mine = breakupOf(c.plannedBreakup)
          return {
            id: c.id,
            cutOrderNumber: c.cutOrderNumber,
            moLineId: c.moLineId,
            cutterName: c.cutterName,
            issuedOn: c.cutDate,
            lotNo: c.lotNo,
            ratio: c.ratio,
            noOfLayers: c.noOfLayers,
            fabricItemId: c.fabricItemId,
            fabricGiven: c.fabricIssued,
            plannedPieces: c.plannedPieces,
            notes: c.notes,
            /*
             * Its pieces by size, beside what each size is to make and has had
             * cut. The screen takes off what the other lays here hold — every
             * lay still out is in this list — as the server does when it checks.
             */
            sizes: (line?.sizes ?? []).map((z) => ({ sizeId: z.sizeId, code: z.code, toMake: z.planned, cut: z.cut, qty: Number(mine[z.sizeId] ?? 0) })),
            // A colour without sizes: its pieces as one number, against the same totals.
            line: line ? { toMake: line.totalQty, cut: line.cut } : null,
          }
        }),
      fabrics: prep.fabrics.filter((f) => f.issued > 0).map((f) => ({ itemId: f.itemId, code: f.code, name: f.name, uom: f.uom })),
    },
  })
})

const moDetailsSchema = z
  .object({
    plannedStartDate: z.coerce.date().optional().nullable(),
    plannedEndDate: z.coerce.date().optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
    jobCards: z.array(jobCardSchema.extend({ id: z.string().min(1) })).max(100).optional(),
    cuttingIssues: z.array(cutterIssueDetailsSchema).max(100).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.plannedStartDate && d.plannedEndDate && d.plannedEndDate < d.plannedStartDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['plannedEndDate'], message: 'It cannot finish before it starts' })
    }
  })

/**
 * PATCH /api/production/orders/:id/details — the details changed, after the
 * plan is fixed and until cutting is complete: dates, note, job card details,
 * and the lays still with cutting contractors. All in one go, or none.
 */
router.patch('/orders/:id/details', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = moDetailsSchema.parse(req.body)
  const { before, after, lays } = await prisma.$transaction(
    async (tx) => {
      const before = await tx.manufacturingOrder.findUnique({ where: { id: req.params.id }, include: moInclude })
      if (!before) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
      const block = await moDetailsBlock(tx, before)
      if (block) throw new AppError(block, 409, 'CUTTING_DONE')
      await tx.manufacturingOrder.update({
        where: { id: before.id },
        data: {
          ...(data.plannedStartDate !== undefined ? { plannedStartDate: data.plannedStartDate } : {}),
          ...(data.plannedEndDate !== undefined ? { plannedEndDate: data.plannedEndDate } : {}),
          ...(data.notes !== undefined ? { notes: data.notes?.trim() || null } : {}),
        },
      })
      for (const card of data.jobCards ?? []) {
        const mine = await tx.jobCard.findFirst({ where: { id: card.id, moId: before.id }, select: { id: true } })
        if (!mine) throw new AppError(`That job card is not on ${before.moNumber}`, 404, 'NOT_FOUND')
        const { id, ...fields } = card
        await updateJobCard(tx, id, fields)
      }
      const mayApprove = userCan(req.user, MODULE, 'approve')
      // Lays saved together are each checked against what the others will hold after this save.
      const saving = piecesBeingSaved(data.cuttingIssues ?? [])
      const lays: Array<{ was: unknown; now: { id: string } }> = []
      for (const issue of data.cuttingIssues ?? []) {
        const was = await tx.cuttingOrder.findUnique({ where: { id: issue.id } })
        lays.push({ was, now: await updateCutterIssue(tx, before.id, issue, { mayApprove, saving }) })
      }
      const after = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: before.id }, include: moInclude })
      return { before, after, lays }
    },
    { timeout: 30_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: after.id, before, after })
  // Each lay on its own too: its pieces can change here, and who changed them should show.
  for (const l of lays) await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'CuttingOrder', entityId: l.now.id, before: l.was, after: l.now })
  const parts = [
    data.plannedStartDate !== undefined || data.plannedEndDate !== undefined || data.notes !== undefined ? 'dates and note' : null,
    data.jobCards?.length ? `${data.jobCards.length} job card${data.jobCards.length === 1 ? '' : 's'}` : null,
    data.cuttingIssues?.length ? `${data.cuttingIssues.length} lay${data.cuttingIssues.length === 1 ? '' : 's'} with cutting contractors` : null,
  ].filter(Boolean)
  res.json({ success: true, message: `${after.moNumber} details saved${parts.length ? `: ${parts.join(', ')}` : ''}.`, data: after })
})

/** Releases a draft inside the caller's transaction. */
export async function releaseMo(tx: Prisma.TransactionClient, id: string) {
  const mo = await tx.manufacturingOrder.findUnique({ where: { id }, select: { id: true, moNumber: true, status: true, soId: true } })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  if (mo.status !== 'DRAFT') throw new AppError(`${mo.moNumber} is already ${mo.status.toLowerCase()}`, 409, 'NOT_DRAFT')
  await assertNotCancelling(tx, mo.soId, `${mo.moNumber} is not released`)
  if (mo.soId) {
    const so = await tx.salesOrder.findUniqueOrThrow({ where: { id: mo.soId }, select: { soNumber: true, status: true } })
    if (!(PLANNABLE_ORDER_STATUSES as readonly string[]).includes(so.status)) {
      throw new AppError(`${so.soNumber} is ${so.status.toLowerCase().replace(/_/g, ' ')}, so it cannot be released`, 409, 'ORDER_NOT_OPEN')
    }
  }
  await release(tx, mo.id)
  return tx.manufacturingOrder.findUniqueOrThrow({ where: { id: mo.id }, include: moInclude })
}

// POST /api/production/orders/:id/release
// ─── Direct orders: for stock or samples ─────────────────────

/** GET /direct/styles — the styles a direct order can make: on, and out of sampling. */
router.get('/direct/styles', requirePermission(MODULE, 'view'), async (_req, res) => {
  const styles = await prisma.style.findMany({
    where: { isActive: true, stage: { not: 'DEVELOPMENT' } },
    select: { id: true, code: true, name: true, brandType: true, colors: true },
    orderBy: { code: 'asc' },
  })
  res.json({ success: true, data: styles })
})

/**
 * GET /direct/styles/:id — one style as a direct order's line needs it: its
 * size run, and by colour the finished item its pieces are booked in as and
 * the approved BOM it is made to.
 */
router.get('/direct/styles/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const st = await prisma.style.findUnique({
    where: { id: req.params.id },
    select: { id: true, code: true, name: true, brandType: true, colors: true, sizeGroupId: true },
  })
  if (!st) throw new AppError('That style does not exist', 404, 'NOT_FOUND')
  const [sizes, items] = await Promise.all([
    st.sizeGroupId ? prisma.size.findMany({ where: { sizeGroupId: st.sizeGroupId }, select: { id: true, code: true }, orderBy: { sequence: 'asc' } }) : [],
    prisma.item.findMany({ where: { styleId: st.id, type: 'FINISHED_GOOD', isActive: true }, select: { id: true, code: true, name: true, color: true } }),
  ])
  const colours = await Promise.all(
    (st.colors.length ? st.colors : ['']).map(async (color) => {
      const item = items.find((i) => (i.color ?? '').trim().toLowerCase() === color.trim().toLowerCase()) ?? null
      const bom = await findBom(prisma, st.id, color || null)
      return { color, item: item && { id: item.id, code: item.code, name: item.name }, bom }
    }),
  )
  res.json({ success: true, data: { style: { id: st.id, code: st.code, name: st.name, brandType: st.brandType }, sizes, colours } })
})

/**
 * GET /direct/item-template?styleId=&colour= — what the item form starts at
 * for a style's colour with no finished item yet: like the style's other
 * colours (category, unit, HSN), or the finished-goods category that is
 * plainly the style's; its rate the cost per piece of the style's approved
 * BOM for that colour (else its colourless one), so it matches the costing —
 * none when it has no approved BOM with a cost. `rateFrom` says which BOM.
 * Only a suggestion: the item is added on the Items & Products form itself,
 * under its own permission, every field there to check.
 */
router.get('/direct/item-template', requirePermission(MODULE, 'view'), async (req, res) => {
  const styleId = text(req.query.styleId)
  const colour = text(req.query.colour) ?? ''
  if (!styleId) throw new AppError('Pick the style', 400, 'NO_STYLE')
  const style = await prisma.style.findUnique({ where: { id: styleId }, select: { id: true, code: true, name: true, category: true, colors: true } })
  if (!style) throw new AppError('That style does not exist', 404, 'NOT_FOUND')
  const color = style.colors.find((c) => c.trim().toLowerCase() === colour.toLowerCase()) ?? colour
  const found = await garmentTemplate(style)
  const values: Record<string, unknown> = { group: 'FINISHED_GOODS', name: `${style.name}${color ? ` — ${color}` : ''}`, styleId: style.id, color }
  let copiedFrom: string | null = null
  if (!('needCategory' in found)) {
    const t = found.template
    const cat = await prisma.itemCategory.findUnique({ where: { id: t.categoryId }, select: { id: true, parentId: true } })
    Object.assign(values, {
      mainCategoryId: cat?.parentId ?? cat?.id,
      subCategoryId: cat?.parentId ? cat.id : undefined,
      uomId: t.uomId,
      hsnCode: t.hsnCode ?? undefined,
    })
    copiedFrom = found.copiedFrom
  }
  // The rate: the approved BOM's cost per piece, this colour's or the style's colourless one.
  const picked = await findBom(prisma, style.id, color || null)
  const bom = picked ? await prisma.bOM.findUnique({ where: { id: picked.id }, select: { id: true, version: true, color: true, costPerPiece: true, approvedAt: true } }) : null
  const rateFrom =
    bom?.costPerPiece != null
      ? { bomId: bom.id, style: style.code, version: bom.version, color: bom.color, costPerPiece: Number(bom.costPerPiece), approvedAt: bom.approvedAt }
      : null
  if (rateFrom) values.standardRate = rateFrom.costPerPiece
  res.json({ success: true, data: { values, copiedFrom, rateFrom, bom: picked ? { version: picked.version, color: picked.color } : null } })
})

/**
 * POST /orders/:id/link — a direct order taken over by a sales order: each of
 * its lines to the order's line of the same finished item. It takes the
 * order's brand and shows its customer from then on; its pieces already
 * tagged are kept for the order. Pieces it makes beyond what the order still
 * needs go to stock, as they would have.
 */
router.post('/orders/:id/link', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { soId } = z.object({ soId: z.string().min(1, 'Pick the sales order') }).parse(req.body)
  const out = await prisma.$transaction(
    async (tx) => {
      const mo = await tx.manufacturingOrder.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          moNumber: true,
          status: true,
          soId: true,
          brandId: true,
          customerId: true,
          customer: { select: { name: true } },
          lines: { select: { id: true, styleId: true, color: true, totalQty: true, style: { select: { code: true } } } },
        },
      })
      if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
      if (mo.soId) throw new AppError(`${mo.moNumber} is already for a sales order.`, 409, 'HAS_ORDER')
      if (mo.status === 'COMPLETED' || mo.status === 'CLOSED') throw new AppError(`${mo.moNumber} is ${mo.status.toLowerCase()}: its pieces are in stock, and go out on the order's challans from there.`, 409, 'MO_DONE')
      await assertNotCancelling(tx, soId, 'nothing more is planned for it')
      const { so, lines } = await orderForPlanning(tx, soId)
      if (!(PLANNABLE_ORDER_STATUSES as readonly string[]).includes(so.status)) {
        throw new AppError(so.status === 'DRAFT' ? `${so.soNumber} is still a draft. Confirm it first.` : `${so.soNumber} is ${so.status.toLowerCase().replace(/_/g, ' ')}, so nothing more is made for it.`, 409, 'ORDER_NOT_OPEN')
      }
      if (so.isJobWork) throw new AppError(`${so.soNumber} is job work, made from the customer's fabric: a run from our own cannot become it.`, 400, 'JOB_WORK')
      if (mo.customerId && so.customerId !== mo.customerId) {
        throw new AppError(`${mo.moNumber} is made for ${mo.customer?.name}; ${so.soNumber} is ${so.customer.name}'s.`, 400, 'OTHER_CUSTOMER')
      }
      const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
      const matched = mo.lines.map((l) => {
        const line = lines.find((x) => x.style?.id === l.styleId && same(x.color, l.color))
        if (!line) throw new AppError(`${l.style.code}${l.color ? ` ${l.color}` : ''} is not on ${so.soNumber}, so ${mo.moNumber} cannot be made for it.`, 400, 'NOT_ON_ORDER')
        return { l, line }
      })
      for (const { l, line } of matched) await tx.mOLine.update({ where: { id: l.id }, data: { soLineId: line.soLineId } })
      await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { soId: so.id, brandId: so.brandId } })
      // Pieces already tagged, still in the store: kept for the order.
      const kept = await tx.garment.updateMany({ where: { moId: mo.id, soId: null, status: { in: ['IN_STOCK', 'PACKED'] } }, data: { soId: so.id } })
      if (mo.status !== 'DRAFT') await tx.salesOrder.updateMany({ where: { id: so.id, status: 'CONFIRMED' }, data: { status: 'IN_PRODUCTION' } })
      const extra = matched.reduce((t, { l, line }) => t + Math.max(0, l.totalQty - line.remaining), 0)
      return { mo, so, kept: kept.count, extra, brandChanged: mo.brandId !== so.brandId, brand: so.brand.name }
    },
    { timeout: 30_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: out.mo.id, after: { linkedTo: out.so.soNumber, garmentsKept: out.kept } })
  res.json({
    success: true,
    message:
      `${out.mo.moNumber} is now made for ${out.so.soNumber} (${out.so.customer.name})` +
      `${out.brandChanged ? `, under ${out.brand}` : ''}` +
      `${out.kept ? `; ${out.kept} ${out.kept === 1 ? 'piece' : 'pieces'} already tagged kept for it` : ''}` +
      `${out.extra ? `. ${out.extra.toLocaleString('en-IN')} pcs more than the order still needs go to stock` : ''}.`,
  })
})

/**
 * GET /orders/:id/linkable — the sales orders a direct order can be made
 * for: open, not job work, with every style and colour it makes on a line.
 */
router.get('/orders/:id/linkable', requirePermission(MODULE, 'view'), async (req, res) => {
  const mo = await prisma.manufacturingOrder.findUnique({ where: { id: req.params.id }, select: { soId: true, customerId: true, lines: { select: { styleId: true, color: true } } } })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  if (mo.soId) {
    res.json({ success: true, data: [] })
    return
  }
  const styleIds = [...new Set(mo.lines.map((l) => l.styleId))]
  const orders = await prisma.salesOrder.findMany({
    where: {
      status: { in: [...PLANNABLE_ORDER_STATUSES] },
      isJobWork: false,
      cancelRequestedAt: null,
      // Made for a customer: only their orders.
      ...(mo.customerId ? { customerId: mo.customerId } : {}),
      lines: { some: { item: { styleId: { in: styleIds } } } },
    },
    select: {
      id: true,
      soNumber: true,
      deliveryDate: true,
      customer: { select: { name: true } },
      brand: { select: { name: true } },
      lines: { select: { item: { select: { styleId: true, color: true } } } },
    },
    orderBy: [{ deliveryDate: { sort: 'asc', nulls: 'last' } }, { orderDate: 'asc' }],
    take: 300,
  })
  const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
  res.json({
    success: true,
    data: orders
      .filter((o) => mo.lines.every((l) => o.lines.some((x) => x.item.styleId === l.styleId && same(x.item.color, l.color))))
      .map((o) => ({ id: o.id, soNumber: o.soNumber, customer: o.customer.name, deliveryDate: o.deliveryDate, brand: o.brand.name })),
  })
})

/**
 * POST /orders/:id/unlink — a direct order given back to stock: the sales
 * order it was linked to no longer takes it. Only one raised direct; one
 * raised from a sales order belongs to it. Pieces tagged for the order and
 * still in the store go back to stock.
 */
router.post('/orders/:id/unlink', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const out = await prisma.$transaction(async (tx) => {
    const mo = await tx.manufacturingOrder.findUnique({
      where: { id: req.params.id },
      select: { id: true, moNumber: true, status: true, purpose: true, soId: true, so: { select: { soNumber: true } }, customer: { select: { name: true } } },
    })
    if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
    if (!mo.soId || !mo.so) throw new AppError(`${mo.moNumber} is not for a sales order.`, 409, 'NO_ORDER')
    if (mo.purpose === 'ORDER') throw new AppError(`${mo.moNumber} was raised for ${mo.so.soNumber}, so it stays with it.`, 409, 'RAISED_FOR_ORDER')
    if (mo.status === 'COMPLETED' || mo.status === 'CLOSED') throw new AppError(`${mo.moNumber} is ${mo.status.toLowerCase()}, so it stays as it is.`, 409, 'MO_DONE')
    await tx.mOLine.updateMany({ where: { moId: mo.id }, data: { soLineId: null } })
    await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { soId: null } })
    const freed = await tx.garment.updateMany({ where: { moId: mo.id, soId: mo.soId, status: { in: ['IN_STOCK', 'PACKED'] } }, data: { soId: null } })
    return { mo, freed: freed.count }
  })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: out.mo.id, after: { unlinkedFrom: out.mo.so?.soNumber } })
  res.json({
    success: true,
    message: `${out.mo.moNumber} is no longer for ${out.mo.so?.soNumber}: it is made for ${madeFor({ purpose: out.mo.purpose, customer: out.mo.customer })} again${out.freed ? `, and ${out.freed} tagged ${out.freed === 1 ? 'piece goes' : 'pieces go'} back to stock` : ''}.`,
  })
})

router.post('/orders/:id/release', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const after = await prisma.$transaction((tx) => releaseMo(tx, req.params.id))
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: after.id, after })
  res.json({ success: true, message: `${after.moNumber} released to the floor.${after.so ? ` ${after.so.soNumber} is in production.` : ''}`, data: after })
})

/** Closes a manufacturing order inside the caller's transaction. */
export async function closeMo(tx: Prisma.TransactionClient, id: string, userId: string, reason: string) {
  const before = await tx.manufacturingOrder.findUnique({ where: { id }, include: moInclude })
  if (!before) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  if (before.status === 'CLOSED') throw new AppError(`${before.moNumber} is already closed`, 409, 'ALREADY_CLOSED')
  // What is still asked of the store for it is no longer wanted: those
  // requisitions close and whatever was held for them goes back. Anything
  // already handed over stays issued.
  const open = await tx.materialRequisition.findMany({
    where: { moId: before.id, closedAt: null, issuedAt: null, status: { not: 'REJECTED' } },
    select: { id: true },
  })
  if (open.length) {
    const ids = open.map((m) => m.id)
    const why = `${before.moNumber} closed: ${reason}`
    await tx.materialRequisition.updateMany({ where: { id: { in: ids } }, data: { closedAt: new Date(), closedById: userId, closeReason: why } })
    await tx.stockReservation.updateMany({
      where: { mrId: { in: ids }, status: 'ACTIVE' },
      data: { status: 'RELEASED', qty: 0, releasedAt: new Date(), releasedById: userId, releaseReason: why },
    })
  }
  const after = await tx.manufacturingOrder.update({
    where: { id: before.id },
    data: { status: 'CLOSED', closedAt: new Date(), closedById: userId, closeReason: reason, heldAt: null, heldById: null, holdReason: null },
    include: moInclude,
  })
  // The order goes back to Confirmed when nothing else is being made for it.
  if (before.soId) {
    const others = await tx.manufacturingOrder.count({ where: { soId: before.soId, status: { in: LIVE } } })
    if (!others) await tx.salesOrder.updateMany({ where: { id: before.soId, status: 'IN_PRODUCTION' }, data: { status: 'CONFIRMED' } })
  }
  return { before, after }
}

/**
 * Finished with fewer pieces than planned — 597 of 600, the other 3 spoiled.
 * Not "called off": what was packed stands, the order is Completed, and the
 * pieces never made are free to plan again on the sales order. Needs at
 * least one piece packed, and a reason.
 */
export async function completeShortMo(tx: Prisma.TransactionClient, id: string, userId: string, reason: string) {
  const before = await tx.manufacturingOrder.findUnique({ where: { id }, include: moInclude })
  if (!before) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  if (before.status === 'DRAFT' || before.status === 'CLOSED' || before.status === 'COMPLETED') {
    throw new AppError(`${before.moNumber} is ${before.status.toLowerCase()}, so it cannot be completed short`, 409, 'NOT_OPEN')
  }
  if (before.totalPackedQty <= 0) {
    throw new AppError(`Nothing is packed on ${before.moNumber} yet. Close it instead if it is called off.`, 409, 'NOTHING_PACKED')
  }
  if (before.totalPackedQty >= before.totalPlannedQty) {
    throw new AppError(`${before.moNumber} is fully packed; it completes by itself.`, 409, 'NOT_SHORT')
  }
  const after = await tx.manufacturingOrder.update({
    where: { id: before.id },
    data: {
      status: 'COMPLETED',
      actualEndDate: new Date(),
      closedAt: new Date(),
      closedById: userId,
      closeReason: `Completed short, ${before.totalPackedQty} of ${before.totalPlannedQty}: ${reason}`,
    },
    include: moInclude,
  })
  return { before, after }
}

/**
 * POST /api/production/orders/:id/complete-short
 *
 * Completes it with what was packed; the rest is free to plan again.
 */
router.post('/orders/:id/complete-short', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const { before, after } = await prisma.$transaction((tx) => completeShortMo(tx, req.params.id, req.user!.id, reason))
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: after.id, before, after })
  res.json({
    success: true,
    message: `${after.moNumber} completed with ${after.totalPackedQty} of ${after.totalPlannedQty} pieces. The other ${after.totalPlannedQty - after.totalPackedQty} can be planned again on the order.`,
    data: after,
  })
})

/**
 * GET  /api/production/orders/:id/cutting — what the cutting sheet needs: the
 *      fabric issued to the order and how much is accounted for, pieces by
 *      size planned and cut, earlier cuttings, panel items and stores.
 * POST /api/production/orders/:id/cutting — one cutting in one step: fabric
 *      used, waste, pieces by size. Only on an order with stages, where it
 *      ties the pieces into bundles; nothing on the screens uses it any more.
 *      Since 6 Nov 2026 every order is cut on its cutting sheet once its
 *      stages are set up: sizes issued to a cutting contractor, then received
 *      back cut (productionFloor.routes: cutting-issues, cutting/:id/receive).
 *      Orders cut the old way, without stages, keep their cuttings.
 * POST /api/production/cutting/:id/cancel — takes it back, with a reason. An
 *      old cutting without stages is cancelled here too, which is how such an
 *      order can still take stages.
 */
router.get('/orders/:id/cutting', requirePermission(MODULE, 'view'), async (req, res) => {
  res.json({ success: true, data: await prisma.$transaction((tx) => cuttingPrep(tx, req.params.id)) })
})

router.post('/orders/:id/cutting', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  // No more cutting without stages (6 Nov 2026): the pieces would get no
  // bundles, so nothing could move them on or change their size.
  const mo = await prisma.manufacturingOrder.findUnique({
    where: { id: req.params.id },
    select: { moNumber: true, totalPackedQty: true, _count: { select: { steps: true, cuttingOrders: { where: { status: { not: 'CANCELLED' }, bundles: { none: {} } } } } } },
  })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  if (!mo._count.steps) {
    // Cut the old way already, or packed without stages: it cannot take stages, so say what it can still do.
    const legacy = mo._count.cuttingOrders > 0 || mo.totalPackedQty > 0
    throw new AppError(
      legacy
        ? `${mo.moNumber} was cut the old way, and more cutting is no longer recorded that way: book what is packed in Inventory → Finished Goods In.${mo.totalPackedQty > 0 ? '' : ' To use stages instead, first cancel its old cuttings under Cutting on the order.'}`
        : `Cutting is recorded on the cutting sheet once ${mo.moNumber}'s stages are set up: set up stages, then issue sizes to a cutting contractor.`,
      409,
      'NEEDS_STAGES',
    )
  }
  const data = cuttingSchema.parse(req.body)
  const cut = await prisma.$transaction((tx) => createCutting(tx, req.params.id, data, req.user!.id, { mayApprove: userCan(req.user, MODULE, 'approve') }), {
    timeout: 60_000,
  })
  const bundles = await prisma.productionBundle.count({ where: { cuttingOrderId: cut.id } })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'CuttingOrder', entityId: cut.id, after: cut })
  res.status(201).json({
    success: true,
    message: `${cut.cutOrderNumber}: ${cut.actualPieces.toLocaleString('en-IN')} pieces cut, ${Number(cut.fabricUsed)} used and ${Number(cut.wastage)} wasted.${bundles ? ` Tied into ${bundles} ${bundles === 1 ? 'bundle' : 'bundles'}, ready to send on — print the stickers.` : ''}${cut.panelItemId ? ' The panels are in the store.' : ''}`,
    data: { ...cut, bundles },
  })
})

router.post('/cutting/:id/cancel', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const after = await prisma.$transaction((tx) => cancelCutting(tx, req.params.id, reason, req.user!.id), { timeout: 60_000 })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'CuttingOrder', entityId: after.id, after })
  res.json({ success: true, message: `${after.cutOrderNumber} cancelled.`, data: after })
})

/**
 * POST /api/production/orders/:id/close
 *
 * Called off, with a reason. It stays on file as closed; its requisitions stay
 * as they are, for the store to close if the material is no longer wanted.
 */
router.post('/orders/:id/close', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const { before, after } = await prisma.$transaction((tx) => closeMo(tx, req.params.id, req.user!.id, reason))
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: after.id, before, after })
  const closed = before.materialRequisitions.filter((m) => !m.closedAt && !m.issuedAt && m.status !== 'REJECTED').map((m) => m.mrNumber)
  res.json({
    success: true,
    message: `${after.moNumber} closed.${closed.length ? ` ${closed.join(', ')} ${closed.length === 1 ? 'is' : 'are'} closed with it, and any stock held for ${closed.length === 1 ? 'it' : 'them'} is free again.` : ''}`,
    data: after,
  })
})

/** GET /api/production/orders/:id/materials — the material plan from the BOM. */
router.get('/orders/:id/materials', requirePermission(MODULE, 'view'), async (req, res) => {
  // ?swap=item|department,… turns those rows to the other owner.
  const swap = new Set(String(req.query.swap ?? '').split(',').filter(Boolean))
  await attachLateBoms(prisma, req.params.id)
  const plan = await materialPlan(prisma, req.params.id, { swap })
  const [departments, processes] = await Promise.all([
    prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    processesFor(req.params.id),
  ])
  res.json({
    success: true,
    data: {
      ...plan,
      departments,
      processes,
      rows: plan.rows.map((r) => ({ ...r, defaultProcessId: guessProcess(r, processes) })),
    },
  })
})

type ProcessOption = { id: string; name: string; kind: string; department: { id: string; name: string } }

/**
 * The processes a material can be asked for: the order's own stages once
 * loaded, else its style's routing, else every process — in the order the
 * floor works them. Checks are left out: nothing is issued to a check.
 */
async function processesFor(moId: string): Promise<ProcessOption[]> {
  const sel = { id: true, name: true, kind: true, department: { select: { id: true, name: true } } } as const
  const mo = await prisma.manufacturingOrder.findUnique({
    where: { id: moId },
    select: {
      routingId: true,
      steps: { orderBy: { sequence: 'asc' }, select: { operation: { select: sel } } },
      lines: { select: { styleId: true } },
    },
  })
  const workSteps = (ops: Array<{ id: string; name: string; kind: string; department: { id: string; name: string } }>) =>
    [...new Map(ops.filter((o) => o.kind !== 'QC').map((o) => [o.id, o])).values()]
  if (mo?.steps.length) return workSteps(mo.steps.map((s) => s.operation))
  const styleIds = [...new Set((mo?.lines ?? []).map((l) => l.styleId).filter((x): x is string => !!x))]
  const routing = await prisma.routing.findFirst({
    where: { isActive: true, OR: [...(mo?.routingId ? [{ id: mo.routingId }] : []), ...(styleIds.length ? [{ styleId: { in: styleIds } }] : [])] },
    orderBy: { version: 'desc' },
    select: { steps: { orderBy: { sequence: 'asc' }, select: { operation: { select: sel } } } },
  })
  const all = await prisma.operation.findMany({ where: { isActive: true }, select: sel, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
  // The routing's steps first, then any other process, should a material be for one off the route.
  const first = workSteps((routing?.steps ?? []).map((s) => s.operation))
  return workSteps([...first, ...all])
}

/**
 * Which process a material is most likely for, so the plan opens filled in:
 * the process of the BOM line's department where it names one; else fabric
 * to cutting, interlining to fusing, buttons to kaj-button, packing material
 * to packing, and everything else sewn on — thread, labels, trims — to
 * stitching.
 */
function guessProcess(
  r: { item: { name: string; type: string; category: string }; department: { id: string } | null },
  processes: ProcessOption[],
): string | null {
  if (r.department) {
    const own = processes.find((p) => p.department.id === r.department!.id)
    if (own) return own.id
  }
  const what = `${r.item.category} ${r.item.name}`
  const byKind = (kind: string) => processes.find((p) => p.kind === kind)?.id ?? null
  const byName = (re: RegExp) => processes.find((p) => re.test(p.name))?.id ?? null
  if (r.item.type === 'PACKING_MATERIAL' || /pack|poly ?bag|carton|tissue|collar clip|price tag|hang ?tag|barcode/i.test(what)) return byKind('PACKING')
  if (/interlining|fusing/i.test(what)) return byName(/fusing/i) ?? byKind('CUTTING')
  if (/button/i.test(what)) return byName(/kaj|button/i) ?? byKind('STITCHING')
  if (/fabric|cloth|poplin|twill|denim|shirting|suiting/i.test(what)) return byKind('CUTTING')
  return byKind('STITCHING')
}

export const raiseSchema = z.object({
  requiredDate: z.coerce.date().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  lines: z
    .array(
      z.object({
        itemId: z.string().min(1),
        /** The process it is for; the requisition goes from that process's department. */
        processId: z.string().min(1).optional().nullable(),
        departmentId: z.string().min(1).optional().nullable(),
        warehouseId: z.string().min(1, 'Say which store to ask'),
        qty: z.number().positive('Ask for more than nothing').max(10_000_000),
        ownership: z.enum(['OWNED', 'CUSTOMER_OWNED']).optional(),
        ownerCustomerId: z.string().optional().nullable(),
        styleNo: z.string().max(50).optional().nullable(),
      }),
    )
    .min(1, 'Pick at least one material to ask for'),
})

/** Raises a manufacturing order's requisitions inside the caller's transaction. */
export async function raiseRequisitions(tx: Prisma.TransactionClient, moId: string, data: z.infer<typeof raiseSchema>, userId: string) {
  const mo = await tx.manufacturingOrder.findUnique({
    where: { id: moId },
    select: { id: true, moNumber: true, status: true, soId: true, so: { select: { soNumber: true } } },
  })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  if (mo.status === 'DRAFT') throw new AppError(`Release ${mo.moNumber} before asking the store for its materials`, 409, 'NOT_RELEASED')
  if (mo.status === 'CLOSED' || mo.status === 'COMPLETED') throw new AppError(`${mo.moNumber} is ${mo.status.toLowerCase()}`, 409, 'NOT_OPEN')
  await assertNotCancelling(tx, mo.soId, 'nothing more is asked of the store for it')
  // Its sales order is over and nothing was made on it: nothing more is made for it. Work already
  // on the floor (issued, cut, packed) can still be given what it needs to finish.
  if (mo.soId) {
    const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: mo.soId }, select: { soNumber: true, status: true, shortClosedAt: true } })
    if ((order.status === 'COMPLETED' || order.status === 'CANCELLED') && !(await workStarted(tx, [mo.id])).size) {
      const word = order.status === 'CANCELLED' ? 'cancelled' : order.shortClosedAt ? 'short-closed' : 'completed'
      throw new AppError(`${order.soNumber} is ${word} and nothing was made on ${mo.moNumber}, so nothing is asked of the store for it. Close ${mo.moNumber} instead.`, 409, 'ORDER_NOT_OPEN')
    }
  }

  // Checked against the plan, so a double click or a stale screen cannot ask
  // for the same material twice, nor a customer's cloth be drawn for anyone
  // but this order's customer. Rows the person switched to the other owner
  // are switched here too before comparing.
  const so = mo.soId ? await tx.salesOrder.findUnique({ where: { id: mo.soId }, select: { customerId: true } }) : null
  for (const l of data.lines) {
    if (l.ownership === 'CUSTOMER_OWNED' && (!so || l.ownerCustomerId !== so.customerId)) {
      throw new AppError("A customer's material can only be asked for on their own order", 400, 'WRONG_OWNER')
    }
  }
  await attachLateBoms(tx, mo.id)
  const first = await materialPlan(tx, mo.id)
  const swap = new Set<string>()
  for (const l of data.lines) {
    for (const r of first.rows.filter((x) => x.item.id === l.itemId)) {
      if ((l.ownership ?? 'OWNED') !== r.defaultOwnership) swap.add(r.baseKey)
    }
  }
  const plan = swap.size ? await materialPlan(tx, mo.id, { swap }) : first
  const asking = new Map<string, number>()
  for (const l of data.lines) {
    const k = `${l.itemId}|${l.ownership ?? 'OWNED'}`
    asking.set(k, (asking.get(k) ?? 0) + l.qty)
  }
  for (const [k, qty] of asking) {
    const [itemId, ownership] = k.split('|')
    const rows = plan.rows.filter((r) => r.item.id === itemId && r.ownership === ownership)
    if (!rows.length) {
      throw new AppError(`One of those materials is not on ${mo.moNumber}'s plan. Refresh the plan and try again.`, 400, 'NOT_IN_PLAN')
    }
    const left = Math.round(rows.reduce((s, r) => s + r.toRequest, 0) * 1000) / 1000
    if (qty > left + 1e-9) {
      throw new AppError(
        left > 0
          ? `${rows[0].item.name}: only ${left} ${rows[0].item.uom ?? ''} is still to ask for on ${mo.moNumber}, and this asks for ${qty}.`
          : `${rows[0].item.name} has already been asked for in full on ${mo.moNumber}.`,
        409,
        'MORE_THAN_PLANNED',
      )
    }
  }

  // The process each material is for decides who asks: fabric for cutting is
  // asked by Cutting, buttons for stitching by Stitching.
  const processIds = [...new Set(data.lines.map((l) => l.processId).filter((x): x is string => !!x))]
  const processes = processIds.length
    ? await tx.operation.findMany({ where: { id: { in: processIds } }, select: { id: true, name: true, departmentId: true, isActive: true } })
    : []
  const processOf = new Map(processes.map((p) => [p.id, p]))
  const lines = data.lines.map((l) => {
    const p = l.processId ? processOf.get(l.processId) : undefined
    if (l.processId && !p) throw new AppError('One of those processes no longer exists. Refresh the plan and pick it again.', 400, 'BAD_PROCESS')
    const departmentId = p?.departmentId ?? l.departmentId
    if (!departmentId) throw new AppError('Say which process each material is for.', 400, 'NO_PROCESS')
    return { ...l, departmentId, processName: p?.name ?? null }
  })

  // One requisition per department: fabric to cutting, trims to stitching.
  const byDepartment = new Map<string, typeof lines>()
  for (const l of lines) byDepartment.set(l.departmentId, [...(byDepartment.get(l.departmentId) ?? []), l])

  const raised = []
  for (const [departmentId, deptLines] of byDepartment) {
    const input = createRequisitionSchema.parse({
      departmentId,
      moId: mo.id,
      soId: mo.soId,
      requiredDate: data.requiredDate ?? null,
      notes: data.notes?.trim() || `For ${mo.moNumber}${mo.so ? ` (${mo.so.soNumber})` : ''}`,
      lines: deptLines.map((l) => ({
        itemId: l.itemId,
        requestedQty: l.qty,
        warehouseId: l.warehouseId,
        purpose: l.processName ? `For ${mo.moNumber} — ${l.processName}` : `For ${mo.moNumber}`,
        styleNo: l.styleNo ?? null,
        ownership: l.ownership ?? 'OWNED',
        ownerCustomerId: l.ownership === 'CUSTOMER_OWNED' ? l.ownerCustomerId : null,
      })),
    })
    raised.push(await createRequisition(tx, input, userId))
  }
  return { mo, raised }
}

/**
 * POST /api/production/orders/:id/requisitions
 *
 * The material plan sent to the store: one requisition per department, each
 * line from the store named on it. They wait for approval like any other, and
 * the store then issues what it has and passes the rest to Purchase.
 */
router.post('/orders/:id/requisitions', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = raiseSchema.parse(req.body)
  const { mo, raised } = await prisma.$transaction((tx) => raiseRequisitions(tx, req.params.id, data, req.user!.id), { timeout: 60_000 })
  for (const mr of raised) {
    await writeAuditLog(req, { module: 'inventory', action: 'CREATE', entityType: 'MaterialRequisition', entityId: mr.id, after: mr })
  }
  res.status(201).json({
    success: true,
    message: `${raised.map((m) => m.mrNumber).join(', ')} raised for ${mo.moNumber}. They wait for approval in Inventory → Material Requisitions.`,
    data: raised.map((m) => ({ id: m.id, mrNumber: m.mrNumber })),
  })
})

// GET /api/production/entries?moId=&from=&to=
router.get('/entries', requirePermission(MODULE, 'view'), async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))

  const where: Record<string, unknown> = {}
  if (req.query.moId) where.moId = String(req.query.moId)

  if (req.query.from || req.query.to) {
    const range: Record<string, Date> = {}
    if (req.query.from) range.gte = new Date(String(req.query.from))
    // An end date is inclusive of that whole day, not midnight at its start.
    if (req.query.to) {
      const to = new Date(String(req.query.to))
      to.setHours(23, 59, 59, 999)
      range.lte = to
    }
    where.entryDate = range
  }

  const entries = await prisma.productionEntry.findMany({
    where,
    orderBy: { entryDate: 'desc' },
    take: limit,
    include: { mo: { select: { moNumber: true } } },
  })

  res.json({ success: true, data: entries })
})

// GET /api/production/cutting
// GET /api/production/cutting — the cutting documents, newest first: q, status, moId, page, limit.
router.get('/cutting', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
  const and: Prisma.CuttingOrderWhereInput[] = []
  const q = text(req.query.q)
  if (q) {
    and.push({
      OR: [
        { cutOrderNumber: { contains: q, mode: 'insensitive' } },
        { lotNo: { contains: q, mode: 'insensitive' } },
        { cutterName: { contains: q, mode: 'insensitive' } },
        { mo: { moNumber: { contains: q, mode: 'insensitive' } } },
        { moLine: { style: { code: { contains: q, mode: 'insensitive' } } } },
      ],
    })
  }
  const status = text(req.query.status)
  if (status === 'CANCELLED') and.push({ status: 'CANCELLED' })
  else if (status === 'LIVE') and.push({ status: { not: 'CANCELLED' } })
  const moId = text(req.query.moId)
  if (moId) and.push({ moId })
  const where: Prisma.CuttingOrderWhereInput = and.length ? { AND: and } : {}

  const [cutting, total] = await Promise.all([
    prisma.cuttingOrder.findMany({
      where,
      orderBy: [{ cutDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        mo: { select: { id: true, moNumber: true, so: { select: { soNumber: true, customer: { select: { name: true } } } } } },
        moLine: { select: { color: true, style: { select: { code: true } } } },
        fabricItem: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
        createdBy: { select: { name: true } },
        _count: { select: { bundles: true } },
      },
    }),
    prisma.cuttingOrder.count({ where }),
  ])

  res.json({ success: true, data: cutting, pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 } })
})

// GET /api/production/qc
router.get('/qc', requirePermission(MODULE, 'view'), async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))

  const records = await prisma.productionQC.findMany({
    orderBy: { qcDate: 'desc' },
    take: limit,
    include: { mo: { select: { moNumber: true } } },
  })

  res.json({ success: true, data: records })
})

// The floor: routes, transfer cards, work at each step, job work, desk queues.
router.use(floorRoutes)

export default router
