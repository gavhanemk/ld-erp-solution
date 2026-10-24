import { Router } from 'express'
import type { MOStatus, Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, userCan, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
import { createRequisitionSchema } from '../schemas/inventory.schemas'
import { createRequisition } from './inventory.routes'
import { ensureJobCards } from '../services/jobCard.service'
import { attachLateBoms, materialPlan, orderForPlanning, PLANNABLE_ORDER_STATUSES } from '../services/manufacturing.service'
import { cancelCutting, createCutting, cuttingPrep, cuttingSchema } from '../services/cutting.service'
import { applyRouting, routingProblem, stylesOfMo } from '../services/route.service'
import floorRoutes from './productionFloor.routes'

/**
 * Manufacturing orders: what the factory is to make for a sales order.
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
  soLineId: z.string().min(1, 'Say which order line'),
  sizes: z.array(z.object({ sizeId: z.string().min(1), qty: pieces })).optional(),
  qty: pieces.optional(),
})

const moFields = {
  plannedStartDate: z.coerce.date().optional().nullable(),
  plannedEndDate: z.coerce.date().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  /** The routing whose steps the order takes. Needed before it is released. */
  routingId: z.string().optional().nullable(),
  lines: z.array(moLineSchema).min(1, 'Put at least one line on it'),
}

function checkMo(d: { plannedStartDate?: Date | null; plannedEndDate?: Date | null; lines: Array<{ soLineId: string }> }, ctx: z.RefinementCtx) {
  if (d.plannedStartDate && d.plannedEndDate && d.plannedEndDate < d.plannedStartDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['plannedEndDate'], message: 'It cannot finish before it starts' })
  }
  const ids = d.lines.map((l) => l.soLineId)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'The same order line appears twice' })
}

const moBodySchema = z.object(moFields).superRefine(checkMo)

export const createMoSchema = z
  .object({
    ...moFields,
    soId: z.string().min(1, 'Pick the sales order'),
    /** Release to the floor on saving, rather than keep it as a draft. */
    release: z.boolean().optional(),
  })
  .superRefine(checkMo)

const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(500) })

/**
 * The lines of a manufacturing order, checked against the order they make:
 * each must be one of its lines, with a style to make it to, and sizes the
 * order line carries. Lines with nothing to make are left off.
 */
async function shapeLines(tx: Prisma.TransactionClient, soId: string, input: z.infer<typeof moBodySchema>, exceptMoId?: string) {
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
      const line = byId.get(l.soLineId)
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
  so: {
    select: {
      id: true,
      soNumber: true,
      status: true,
      isJobWork: true,
      deliveryDate: true,
      customerPORef: true,
      customer: { select: { id: true, name: true } },
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

// GET /api/production/orders — filters: q, status, soId, brandId, open=1, page, limit.
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
  const q = text(req.query.q)
  if (q) {
    and.push({
      OR: [
        { moNumber: { contains: q, mode: 'insensitive' } },
        { so: { soNumber: { contains: q, mode: 'insensitive' } } },
        { so: { customer: { name: { contains: q, mode: 'insensitive' } } } },
        { lines: { some: { style: { code: { contains: q, mode: 'insensitive' } } } } },
      ],
    })
  }
  const where: Prisma.ManufacturingOrderWhereInput = and.length ? { AND: and } : {}
  // Lines planned before their BOM was approved pick it up, so "without a BOM" is true.
  await attachLateBoms(prisma)

  const [orders, total] = await Promise.all([
    prisma.manufacturingOrder.findMany({
      where,
      include: {
        brand: { select: { id: true, name: true, type: true } },
        so: { select: { id: true, soNumber: true, deliveryDate: true, customer: { select: { name: true } } } },
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

  res.json({
    success: true,
    data: orders.map((mo) => ({
      id: mo.id,
      moNumber: mo.moNumber,
      status: mo.status,
      brand: mo.brand,
      soId: mo.so?.id ?? null,
      customer: mo.so?.customer.name ?? null,
      soNumber: mo.so?.soNumber ?? null,
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
  res.json({ success: true, data: order })
})

/** Raises a manufacturing order inside the caller's transaction. Exported for the checks that roll it back. */
export async function createMo(tx: Prisma.TransactionClient, data: z.infer<typeof createMoSchema>, userId: string) {
  const { so, total, create } = await shapeLines(tx, data.soId, data)
  // Every check first: a refused order takes no number.
  const moNumber = await nextDocumentNumber(tx, 'MO', new Date())
  const mo = await tx.manufacturingOrder.create({
    data: {
      moNumber,
      soId: so.id,
      brandId: so.brandId,
      plannedStartDate: data.plannedStartDate ?? null,
      plannedEndDate: data.plannedEndDate ?? so.deliveryDate ?? null,
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
    message: `${mo.moNumber} ${mo.status === 'RELEASED' ? 'released to the floor' : 'saved as a draft'}: ${mo.totalPlannedQty.toLocaleString('en-IN')} pcs for ${mo.so?.soNumber}.`,
    data: mo,
  })
})

/** PATCH /api/production/orders/:id — a draft changed: dates, notes, pieces. */
router.patch('/orders/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = moBodySchema.parse(req.body)
  const { before, after } = await prisma.$transaction(
    async (tx) => {
      const before = await tx.manufacturingOrder.findUnique({ where: { id: req.params.id }, include: moInclude })
      if (!before) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
      if (before.status !== 'DRAFT') throw new AppError(`${before.moNumber} has been released, so its plan can no longer be changed`, 409, 'NOT_DRAFT')
      if (!before.soId) throw new AppError(`${before.moNumber} is not for a sales order`, 409, 'NO_ORDER')
      const { total, create } = await shapeLines(tx, before.soId, data, before.id)
      await tx.mOLine.deleteMany({ where: { moId: before.id } })
      await tx.manufacturingOrder.update({
        where: { id: before.id },
        data: {
          plannedStartDate: data.plannedStartDate ?? null,
          plannedEndDate: data.plannedEndDate ?? null,
          notes: data.notes ?? null,
          totalPlannedQty: total,
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
  res.json({ success: true, message: `${after.moNumber} saved`, data: after })
})

/** Releases a draft inside the caller's transaction. */
export async function releaseMo(tx: Prisma.TransactionClient, id: string) {
  const mo = await tx.manufacturingOrder.findUnique({ where: { id }, select: { id: true, moNumber: true, status: true, soId: true } })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  if (mo.status !== 'DRAFT') throw new AppError(`${mo.moNumber} is already ${mo.status.toLowerCase()}`, 409, 'NOT_DRAFT')
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
 * GET  /api/production/orders/:id/cutting — what the cutting form needs: the
 *      fabric issued to the order and how much is accounted for, pieces by
 *      size planned and cut, earlier cuttings, panel items and stores.
 * POST /api/production/orders/:id/cutting — one cutting: fabric used, waste,
 *      pieces by size, and optionally the panels into a store.
 * POST /api/production/cutting/:id/cancel — takes it back, with a reason.
 */
router.get('/orders/:id/cutting', requirePermission(MODULE, 'view'), async (req, res) => {
  res.json({ success: true, data: await prisma.$transaction((tx) => cuttingPrep(tx, req.params.id)) })
})

router.post('/orders/:id/cutting', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
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
