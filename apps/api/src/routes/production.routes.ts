import { Router } from 'express'
import type { MOStatus, Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
import { createRequisitionSchema } from '../schemas/inventory.schemas'
import { createRequisition } from './inventory.routes'
import { materialPlan, orderForPlanning, PLANNABLE_ORDER_STATUSES } from '../services/manufacturing.service'

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

  const [orders, total] = await Promise.all([
    prisma.manufacturingOrder.findMany({
      where,
      include: {
        brand: { select: { id: true, name: true, type: true } },
        so: { select: { id: true, soNumber: true, deliveryDate: true, customer: { select: { name: true } } } },
        lines: { select: { color: true, bomId: true, style: { select: { code: true } } } },
        _count: { select: { materialRequisitions: true } },
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
  const after = await tx.manufacturingOrder.update({
    where: { id: before.id },
    data: { status: 'CLOSED', closedAt: new Date(), closedById: userId, closeReason: reason },
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
 * POST /api/production/orders/:id/close
 *
 * Called off, with a reason. It stays on file as closed; its requisitions stay
 * as they are, for the store to close if the material is no longer wanted.
 */
router.post('/orders/:id/close', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const { before, after } = await prisma.$transaction((tx) => closeMo(tx, req.params.id, req.user!.id, reason))
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: after.id, before, after })
  const open = after.materialRequisitions.filter((m) => !m.closedAt && m.status !== 'REJECTED').map((m) => m.mrNumber)
  res.json({
    success: true,
    message: `${after.moNumber} closed.${open.length ? ` ${open.join(', ')} ${open.length === 1 ? 'is' : 'are'} still open in Inventory.` : ''}`,
    data: after,
  })
})

/** GET /api/production/orders/:id/materials — the material plan from the BOM. */
router.get('/orders/:id/materials', requirePermission(MODULE, 'view'), async (req, res) => {
  const plan = await materialPlan(prisma, req.params.id)
  const departments = await prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  res.json({ success: true, data: { ...plan, departments } })
})

export const raiseSchema = z.object({
  requiredDate: z.coerce.date().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  lines: z
    .array(
      z.object({
        itemId: z.string().min(1),
        departmentId: z.string().min(1, 'Say which department asks for it'),
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

  // One requisition per department: fabric to cutting, trims to stitching —
  // whoever the BOM gives the material to is who asks the store for it.
  const byDepartment = new Map<string, typeof data.lines>()
  for (const l of data.lines) byDepartment.set(l.departmentId, [...(byDepartment.get(l.departmentId) ?? []), l])

  const raised = []
  for (const [departmentId, lines] of byDepartment) {
    const input = createRequisitionSchema.parse({
      departmentId,
      moId: mo.id,
      soId: mo.soId,
      requiredDate: data.requiredDate ?? null,
      notes: data.notes?.trim() || `For ${mo.moNumber}${mo.so ? ` (${mo.so.soNumber})` : ''}`,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        requestedQty: l.qty,
        warehouseId: l.warehouseId,
        purpose: `For ${mo.moNumber}`,
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
router.get('/cutting', requirePermission(MODULE, 'view'), async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))

  const cutting = await prisma.cuttingOrder.findMany({
    orderBy: { cutDate: 'desc' },
    take: limit,
    include: { mo: { select: { moNumber: true } } },
  })

  res.json({ success: true, data: cutting })
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

export default router
