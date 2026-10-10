import { Router } from 'express'
import type { ChallanStatus, Prisma, SalesOrderStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AuthRequest, requirePermission } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
import { amountInWords, getPrintHeader } from '../lib/printData'
import { balanceOf, recordMovement } from '../services/stock.service'
import { OPEN_ORDER_STATUSES } from '../services/salesOrder.service'

/**
 * Delivery challans: the goods leaving for the buyer against a sales order.
 *
 * Kept as simple as the order: a challan is saved as a draft or dispatched in
 * one step, and dispatching is what moves things —
 *
 *   - the pieces leave the finished-goods store by size, through stock.service
 *     (never more than is there, and the shortfall named by size);
 *   - each order line's sent and pending pieces move, size by size;
 *   - the order becomes Part dispatched, or Completed with nothing pending.
 *
 * Sending more than the order still wants is allowed for an edge case, with a
 * note saying why (the business's answer of 9 Oct 2026). A size the order line
 * does not carry is refused: amend the order to add it.
 *
 * Mounted at /api/sales/challans, under the sales permissions.
 */

const router = Router()
const MODULE = 'sales'

const lineSchema = z.object({
  soLineId: z.string().min(1),
  /** Pieces by size, for a garment with a size run. */
  sizes: z.array(z.object({ sizeId: z.string().min(1), qty: z.number().min(0) })).optional(),
  /** Pieces, for a garment with none. */
  qty: z.number().min(0).optional(),
  /** Why more went than the order line still wanted. */
  overNote: z.string().trim().max(300).optional().nullable(),
})

const challanSchema = z.object({
  soId: z.string().min(1, 'Pick the order'),
  dcDate: z.coerce.date().optional(),
  warehouseId: z.string().min(1, 'Pick the store the goods leave from'),
  deliveryAddress: z.string().max(500).optional().nullable(),
  transporter: z.string().max(120).optional().nullable(),
  vehicleNumber: z.string().max(30).optional().nullable(),
  lrNumber: z.string().max(60).optional().nullable(),
  eWayBillNumber: z.string().max(30).optional().nullable(),
  cartons: z.number().int().min(0).optional().nullable(),
  packingNote: z.string().max(500).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  /** Dispatch on saving, rather than keep it as a draft. */
  dispatch: z.boolean().optional(),
  lines: z.array(lineSchema).min(1, 'Put at least one item on the challan'),
})

const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(500) })

const round2 = (n: number) => Math.round(n * 100) / 100
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** The order with what each line and size has ordered, sent and still wants. */
const orderForDispatch = {
  customer: {
    select: {
      id: true,
      name: true,
      gstin: true,
      billingCity: true,
      shippingCity: true,
      shippingAddress: true,
      shippingState: true,
      shippingPincode: true,
    },
  },
  brand: { select: { name: true } },
  lines: {
    orderBy: { sortOrder: 'asc' },
    include: {
      item: { select: { id: true, code: true, name: true, color: true, hsnCode: true, uomId: true } },
      sizes: { include: { size: { select: { id: true, code: true, sequence: true } } }, orderBy: { size: { sequence: 'asc' } } },
    },
  },
} satisfies Prisma.SalesOrderInclude

type OrderForDispatch = Prisma.SalesOrderGetPayload<{ include: typeof orderForDispatch }>

/** What is on hand of one garment in one size, in one store. */
const onHand = (db: Prisma.TransactionClient | typeof prisma, itemId: string, warehouseId: string, sizeId: string | null) =>
  balanceOf(db as Prisma.TransactionClient, { itemId, warehouseId, sizeId }).then((b) => b.qty)

/**
 * The store a challan starts from: the finished-goods store when one is named
 * so, else the one holding the most of this order's garments, else the first.
 */
async function defaultStore(itemIds: string[]) {
  const stores = await prisma.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  const named = stores.find((w) => /finish/i.test(w.name))
  if (named || stores.length <= 1) return { stores, id: named?.id ?? stores[0]?.id ?? null }
  const held = await prisma.stockLedger.groupBy({
    by: ['warehouseId'],
    where: { itemId: { in: itemIds }, ownership: 'OWNED' },
    _sum: { inQty: true, outQty: true },
  })
  const best = held
    .map((h) => ({ id: h.warehouseId, qty: Number(h._sum.inQty ?? 0) - Number(h._sum.outQty ?? 0) }))
    .sort((a, b) => b.qty - a.qty)[0]
  return { stores, id: best && best.qty > 0 ? best.id : stores[0].id }
}

/**
 * GET /api/sales/challans/prepare?soId=&warehouseId=
 *
 * Everything the challan form needs for one order: its lines, each size's
 * ordered, sent and pending pieces, and what is packed in the chosen store.
 * Stock is read here, under the sales permission, so a sales coordinator does
 * not need Inventory rights to see what can be sent.
 */
router.get('/prepare', requirePermission(MODULE, 'view'), async (req, res) => {
  const soId = text(req.query.soId)
  if (!soId) throw new AppError('Say which order', 400, 'NO_ORDER')
  const order = await prisma.salesOrder.findUnique({ where: { id: soId }, include: orderForDispatch })
  if (!order) throw new AppError('Sales order not found', 404, 'NOT_FOUND')

  const { stores, id: fallback } = await defaultStore(order.lines.map((l) => l.itemId))
  const warehouseId = text(req.query.warehouseId) ?? fallback

  const lines = await Promise.all(
    order.lines.map(async (l) => {
      const ordered = Number(l.totalQty)
      const sent = Number(l.deliveredQty)
      const sizes = l.sizes.length
        ? await Promise.all(
            l.sizes.map(async (s) => ({
              sizeId: s.sizeId,
              code: s.size.code,
              sequence: s.size.sequence,
              ordered: Number(s.qty),
              sent: Number(s.deliveredQty),
              pending: Math.max(0, Number(s.qty) - Number(s.deliveredQty)),
              inStock: warehouseId ? await onHand(prisma, l.itemId, warehouseId, s.sizeId) : 0,
            }))
          )
        : null
      return {
        soLineId: l.id,
        item: l.item,
        color: l.color,
        unitPrice: Number(l.unitPrice),
        discount: Number(l.discount),
        gstRate: Number(l.gstRate),
        ordered,
        sent,
        pending: Math.max(0, ordered - sent),
        inStock: sizes ? sizes.reduce((s, z) => s + z.inStock, 0) : warehouseId ? await onHand(prisma, l.itemId, warehouseId, null) : 0,
        sizes,
      }
    })
  )

  res.json({
    success: true,
    data: {
      order: {
        id: order.id,
        soNumber: order.soNumber,
        status: order.status,
        isJobWork: order.isJobWork,
        orderDate: order.orderDate,
        deliveryDate: order.deliveryDate,
        deliveryAddress: order.deliveryAddress,
        customerPORef: order.customerPORef,
        customer: order.customer,
        brand: order.brand,
      },
      stores,
      warehouseId,
      lines,
    },
  })
})

/**
 * GET /api/sales/challans/waiting
 *
 * Orders with pieces still to send: confirmed, in production or part
 * dispatched, each with what it still wants and the date it is due.
 */
router.get('/waiting', requirePermission(MODULE, 'view'), async (req, res) => {
  const q = text(req.query.q)
  const orders = await prisma.salesOrder.findMany({
    where: {
      status: { in: OPEN_ORDER_STATUSES },
      lines: { some: { pendingQty: { gt: 0 } } },
      ...(q
        ? {
            OR: [
              { soNumber: { contains: q, mode: 'insensitive' } },
              { customer: { name: { contains: q, mode: 'insensitive' } } },
              { customerPORef: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      soNumber: true,
      status: true,
      isJobWork: true,
      orderDate: true,
      deliveryDate: true,
      customerPORef: true,
      customer: { select: { name: true, shippingCity: true, billingCity: true } },
      lines: {
        orderBy: { sortOrder: 'asc' },
        select: { totalQty: true, deliveredQty: true, pendingQty: true, item: { select: { code: true, name: true, color: true } } },
      },
      deliveryChallans: { where: { status: 'DRAFT' }, select: { id: true, dcNumber: true } },
    },
    orderBy: [{ deliveryDate: { sort: 'asc', nulls: 'last' } }, { orderDate: 'asc' }],
    take: 200,
  })

  res.json({
    success: true,
    data: orders.map((o) => ({
      ...o,
      ordered: o.lines.reduce((s, l) => s + Number(l.totalQty), 0),
      sent: o.lines.reduce((s, l) => s + Number(l.deliveredQty), 0),
      pending: o.lines.reduce((s, l) => s + Number(l.pendingQty), 0),
    })),
  })
})

const challanInclude = {
  so: { select: { id: true, soNumber: true, status: true, isJobWork: true, customerPORef: true } },
  customer: { select: { id: true, name: true, gstin: true, billingCity: true, shippingCity: true } },
  warehouse: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  dispatchedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  lines: {
    include: {
      item: { select: { id: true, code: true, name: true, color: true, hsnCode: true } },
      soLine: { select: { id: true, unitPrice: true, gstRate: true, discount: true } },
      sizes: { include: { size: { select: { id: true, code: true, sequence: true } } } },
    },
  },
  /** The invoice billing it, if any: a challan is billed once. */
  invoices: { where: { status: { not: 'CANCELLED' } }, select: { id: true, invoiceNumber: true } },
} satisfies Prisma.DeliveryChallanInclude

/** GET /api/sales/challans — filters: q, status, customerId, soId, from, to, page, limit. */
router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const and: Prisma.DeliveryChallanWhereInput[] = []
  const q = text(req.query.q)
  if (q) {
    and.push({
      OR: [
        { dcNumber: { contains: q, mode: 'insensitive' } },
        { so: { soNumber: { contains: q, mode: 'insensitive' } } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
        { lrNumber: { contains: q, mode: 'insensitive' } },
        { vehicleNumber: { contains: q, mode: 'insensitive' } },
      ],
    })
  }
  const status = text(req.query.status)
  if (status) {
    if (!['DRAFT', 'DISPATCHED', 'DELIVERED', 'RETURNED', 'CANCELLED'].includes(status)) {
      throw new AppError(`Unknown status '${status}'`, 400, 'BAD_STATUS')
    }
    and.push({ status: status as ChallanStatus })
  }
  const customerId = text(req.query.customerId)
  if (customerId) and.push({ customerId })
  const soId = text(req.query.soId)
  if (soId) and.push({ soId })
  const from = text(req.query.from)
  const to = text(req.query.to)
  if (from || to) {
    const end = to ? new Date(to) : null
    if (end) end.setDate(end.getDate() + 1)
    and.push({ dcDate: { ...(from && { gte: new Date(from) }), ...(end && { lt: end }) } })
  }
  const where: Prisma.DeliveryChallanWhereInput = and.length ? { AND: and } : {}

  const [rows, total] = await Promise.all([
    prisma.deliveryChallan.findMany({
      where,
      include: challanInclude,
      orderBy: [{ dcDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.deliveryChallan.count({ where }),
  ])
  const data = rows.map((r) => ({ ...r, pieces: r.lines.reduce((s, l) => s + Number(l.qty), 0) }))
  res.json({ success: true, data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
})

// GET /api/sales/challans/:id
router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const dc = await prisma.deliveryChallan.findUnique({ where: { id: req.params.id }, include: challanInclude })
  if (!dc) throw new AppError('Delivery challan not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: dc })
})

type ChallanInput = z.infer<typeof challanSchema>

/**
 * Checks a challan's lines against its order and turns them into the rows to
 * write. Shared by saving a draft and dispatching it, so the two cannot read
 * the same challan two ways.
 */
function shapeLines(order: OrderForDispatch, data: ChallanInput) {
  const byId = new Map(order.lines.map((l) => [l.id, l]))
  const seen = new Set<string>()
  const out = data.lines.map((input, i) => {
    const line = byId.get(input.soLineId)
    if (!line) throw new AppError(`Line ${i + 1} is not on ${order.soNumber}`, 400, 'BAD_LINE')
    if (seen.has(line.id)) throw new AppError(`${line.item.code} appears twice on the challan`, 400, 'BAD_LINE')
    seen.add(line.id)

    const ordered = new Map(line.sizes.map((s) => [s.sizeId, s]))
    let sizes: Array<{ sizeId: string; code: string; qty: number; pending: number }> = []
    let qty: number
    let pending: number
    if (line.sizes.length) {
      sizes = (input.sizes ?? [])
        .filter((s) => s.qty > 0)
        .map((s) => {
          const o = ordered.get(s.sizeId)
          if (!o) {
            throw new AppError(
              `${line.item.code}: that size is not on ${order.soNumber}. Amend the order to add it first.`,
              400,
              'SIZE_NOT_ORDERED',
            )
          }
          return { sizeId: s.sizeId, code: o.size.code, qty: s.qty, pending: Math.max(0, Number(o.qty) - Number(o.deliveredQty)) }
        })
      qty = sizes.reduce((s, z) => s + z.qty, 0)
      pending = Math.max(0, Number(line.totalQty) - Number(line.deliveredQty))
    } else {
      qty = input.qty ?? 0
      pending = Math.max(0, Number(line.totalQty) - Number(line.deliveredQty))
    }
    return { input, line, sizes, qty, pending }
  })

  const real = out.filter((l) => l.qty > 0)
  if (real.length === 0) throw new AppError('Put the pieces to send against at least one line', 400, 'NOTHING_TO_SEND')

  // More than the order still wants: allowed, but only with a word on why.
  for (const l of real) {
    const over = l.line.sizes.length ? l.sizes.filter((s) => s.qty > s.pending) : l.qty > l.pending ? [{ code: '' }] : []
    if (over.length && !l.input.overNote?.trim()) {
      const which = over.map((s) => s.code).filter(Boolean).join(', ')
      throw new AppError(
        `${l.line.item.code}: more than the order still wants${which ? ` in size ${which}` : ''}. Add a note saying why.`,
        400,
        'OVER_NEEDS_NOTE',
      )
    }
  }
  return real
}

/** The order's status once its lines' pending pieces have moved. */
function statusAfter(
  current: SalesOrderStatus,
  lines: Array<{ pendingQty: number; deliveredQty: number }>,
  hasProduction: boolean,
): SalesOrderStatus {
  if (lines.every((l) => l.pendingQty <= 0)) return 'COMPLETED'
  if (lines.some((l) => l.deliveredQty > 0)) return 'PARTIALLY_DISPATCHED'
  return hasProduction || current === 'IN_PRODUCTION' ? 'IN_PRODUCTION' : 'CONFIRMED'
}

/**
 * Sends a saved challan: stock out by size, each order line's sent and pending
 * moved, and the order's status with them. Inside the caller's transaction.
 */
export async function dispatchChallan(tx: Prisma.TransactionClient, dcId: string, userId: string) {
  const dc = await tx.deliveryChallan.findUniqueOrThrow({
    where: { id: dcId },
    include: { lines: { include: { sizes: true } } },
  })
  if (!dc.warehouseId) throw new AppError('Say which store the goods leave from', 400, 'NO_WAREHOUSE')

  for (const line of dc.lines) {
    if (!line.itemId || !line.soLineId) continue
    const parts = line.sizes.length ? line.sizes.map((s) => ({ sizeId: s.sizeId as string | null, qty: Number(s.qty) })) : [{ sizeId: null, qty: Number(line.qty) }]
    for (const part of parts) {
      if (part.qty <= 0) continue
      await recordMovement(tx, {
        itemId: line.itemId,
        warehouseId: dc.warehouseId,
        sizeId: part.sizeId,
        transactionType: 'SALE',
        direction: 'OUT',
        qty: part.qty,
        referenceType: 'DELIVERY_CHALLAN',
        referenceId: dc.id,
        transactionDate: dc.dcDate,
        notes: `Dispatched on ${dc.dcNumber}`,
      })
      if (part.sizeId) {
        await tx.salesOrderLineSize.updateMany({
          where: { lineId: line.soLineId, sizeId: part.sizeId },
          data: { deliveredQty: { increment: part.qty } },
        })
      }
    }
    const soLine = await tx.salesOrderLine.findUniqueOrThrow({ where: { id: line.soLineId } })
    const delivered = round2(Number(soLine.deliveredQty) + Number(line.qty))
    await tx.salesOrderLine.update({
      where: { id: soLine.id },
      data: { deliveredQty: delivered, pendingQty: Math.max(0, round2(Number(soLine.totalQty) - delivered)) },
    })
  }

  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: dc.soId },
    select: { status: true, lines: { select: { pendingQty: true, deliveredQty: true } }, _count: { select: { manufacturingOrders: { where: { status: { notIn: ['DRAFT', 'CLOSED'] } } } } } },
  })
  const status = statusAfter(
    order.status,
    order.lines.map((l) => ({ pendingQty: Number(l.pendingQty), deliveredQty: Number(l.deliveredQty) })),
    order._count.manufacturingOrders > 0,
  )
  await tx.salesOrder.update({ where: { id: dc.soId }, data: { status } })
  await tx.deliveryChallan.update({
    where: { id: dc.id },
    data: { status: 'DISPATCHED', dispatchedAt: new Date(), dispatchedById: userId },
  })
}

/** Writes a challan's header and lines; the number is the caller's. */
export async function writeChallan(
  tx: Prisma.TransactionClient,
  order: OrderForDispatch,
  data: ChallanInput,
  existing: { id: string } | null,
  userId: string,
) {
  const shaped = shapeLines(order, data)
  const warehouse = await tx.warehouse.findUnique({ where: { id: data.warehouseId }, select: { name: true, isActive: true } })
  if (!warehouse) throw new AppError('That store does not exist', 400, 'BAD_WAREHOUSE')
  if (!warehouse.isActive) throw new AppError(`${warehouse.name} is switched off`, 400, 'INACTIVE')

  const header = {
    soId: order.id,
    customerId: order.customerId,
    dcDate: data.dcDate ?? new Date(),
    warehouseId: data.warehouseId,
    deliveryAddress: data.deliveryAddress ?? order.deliveryAddress ?? null,
    transporter: data.transporter ?? null,
    vehicleNumber: data.vehicleNumber?.toUpperCase() ?? null,
    lrNumber: data.lrNumber ?? null,
    eWayBillNumber: data.eWayBillNumber ?? null,
    cartons: data.cartons ?? null,
    packingNote: data.packingNote ?? null,
    notes: data.notes ?? null,
  }
  const lines = shaped.map((l) => ({
    soLineId: l.line.id,
    itemId: l.line.itemId,
    description: `${l.line.item.name}${l.line.item.color ? ` · ${l.line.item.color}` : ''}`,
    qty: l.qty,
    uomId: l.line.item.uomId,
    overNote: l.input.overNote?.trim() || null,
    sizes: l.sizes.length ? { create: l.sizes.map((s) => ({ sizeId: s.sizeId, qty: s.qty })) } : undefined,
  }))

  if (existing) {
    await tx.deliveryChallanLine.deleteMany({ where: { dcId: existing.id } })
    return tx.deliveryChallan.update({ where: { id: existing.id }, data: { ...header, lines: { create: lines } } })
  }
  const dcNumber = await nextDocumentNumber(tx, 'DC', header.dcDate)
  return tx.deliveryChallan.create({ data: { ...header, dcNumber, createdById: userId, lines: { create: lines } } })
}

export async function loadOpenOrder(tx: Prisma.TransactionClient, soId: string) {
  const order = await tx.salesOrder.findUnique({ where: { id: soId }, include: orderForDispatch })
  if (!order) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  if (!OPEN_ORDER_STATUSES.includes(order.status)) {
    throw new AppError(
      order.status === 'DRAFT'
        ? `${order.soNumber} is still a draft. Confirm it before sending anything against it.`
        : `${order.soNumber} is ${order.status.toLowerCase().replace(/_/g, ' ')}, so nothing more can be sent against it`,
      409,
      'ORDER_NOT_OPEN',
    )
  }
  return order
}

const dispatchedMessage = (dcNumber: string, pieces: number) =>
  `${dcNumber} dispatched: ${pieces.toLocaleString('en-IN')} pcs out of stock`

// POST /api/sales/challans — a draft, or dispatched straight away.
router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = challanSchema.parse(req.body)
  const dc = await prisma.$transaction(
    async (tx) => {
      const order = await loadOpenOrder(tx, data.soId)
      const created = await writeChallan(tx, order, data, null, req.user!.id)
      if (data.dispatch) await dispatchChallan(tx, created.id, req.user!.id)
      return tx.deliveryChallan.findUniqueOrThrow({ where: { id: created.id }, include: challanInclude })
    },
    { timeout: 30_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'DeliveryChallan', entityId: dc.id, after: dc })
  const pieces = dc.lines.reduce((s, l) => s + Number(l.qty), 0)
  res.status(201).json({
    success: true,
    message: data.dispatch ? dispatchedMessage(dc.dcNumber, pieces) : `${dc.dcNumber} saved as a draft`,
    data: dc,
  })
})

// PATCH /api/sales/challans/:id — change a draft; dispatch it too with `dispatch`.
router.patch('/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = challanSchema.parse(req.body)
  const { before, after } = await prisma.$transaction(
    async (tx) => {
      const before = await tx.deliveryChallan.findUnique({ where: { id: req.params.id }, include: challanInclude })
      if (!before) throw new AppError('Delivery challan not found', 404, 'NOT_FOUND')
      if (before.status !== 'DRAFT') throw new AppError(`${before.dcNumber} has gone; it can no longer be changed`, 409, 'NOT_DRAFT')
      if (data.soId !== before.soId) throw new AppError('A challan cannot move to another order', 400, 'ORDER_CHANGED')
      const order = await loadOpenOrder(tx, before.soId)
      await writeChallan(tx, order, data, { id: before.id }, req.user!.id)
      if (data.dispatch) await dispatchChallan(tx, before.id, req.user!.id)
      const after = await tx.deliveryChallan.findUniqueOrThrow({ where: { id: before.id }, include: challanInclude })
      return { before, after }
    },
    { timeout: 30_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'DeliveryChallan', entityId: after.id, before, after })
  const pieces = after.lines.reduce((s, l) => s + Number(l.qty), 0)
  res.json({
    success: true,
    message: data.dispatch ? dispatchedMessage(after.dcNumber, pieces) : `${after.dcNumber} saved`,
    data: after,
  })
})

// POST /api/sales/challans/:id/dispatch — send a saved draft.
router.post('/:id/dispatch', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { before, after } = await prisma.$transaction(
    async (tx) => {
      const before = await tx.deliveryChallan.findUnique({ where: { id: req.params.id }, include: challanInclude })
      if (!before) throw new AppError('Delivery challan not found', 404, 'NOT_FOUND')
      if (before.status !== 'DRAFT') throw new AppError(`${before.dcNumber} has already gone`, 409, 'NOT_DRAFT')
      await loadOpenOrder(tx, before.soId)
      await dispatchChallan(tx, before.id, req.user!.id)
      const after = await tx.deliveryChallan.findUniqueOrThrow({ where: { id: before.id }, include: challanInclude })
      return { before, after }
    },
    { timeout: 30_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'DeliveryChallan', entityId: after.id, before, after })
  res.json({ success: true, message: dispatchedMessage(after.dcNumber, after.lines.reduce((s, l) => s + Number(l.qty), 0)), data: after })
})

// POST /api/sales/challans/:id/delivered — the buyer has the goods.
router.post('/:id/delivered', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const before = await prisma.deliveryChallan.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('Delivery challan not found', 404, 'NOT_FOUND')
  if (before.status !== 'DISPATCHED') {
    throw new AppError(`${before.dcNumber} is ${before.status.toLowerCase()}, not on its way`, 409, 'NOT_DISPATCHED')
  }
  const after = await prisma.deliveryChallan.update({ where: { id: before.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'DeliveryChallan', entityId: after.id, before, after })
  res.json({ success: true, message: `${after.dcNumber} marked delivered`, data: after })
})

/**
 * Cancels a challan inside the caller's transaction. A draft is simply called
 * off; a dispatched one puts every piece back at the rate it left at, takes
 * them off the order's sent, and sets the order's status back to match.
 */
export async function cancelChallan(tx: Prisma.TransactionClient, dcId: string, userId: string, reason: string) {
  const before = await tx.deliveryChallan.findUnique({ where: { id: dcId }, include: challanInclude })
  if (!before) throw new AppError('Delivery challan not found', 404, 'NOT_FOUND')
  if (before.status === 'CANCELLED') throw new AppError(`${before.dcNumber} is already cancelled`, 409, 'ALREADY_CANCELLED')
  if (before.status === 'RETURNED') throw new AppError(`${before.dcNumber} has been returned`, 409, 'RETURNED')
  // Goods on an invoice cannot quietly come back: the invoice goes first.
  if (before.invoices.length) {
    throw new AppError(
      `${before.dcNumber} is billed on ${before.invoices[0].invoiceNumber}. Cancel that invoice first.`,
      409,
      'INVOICED',
    )
  }

  if (before.status === 'DISPATCHED' || before.status === 'DELIVERED') {
    // Back in at the rate each piece left at, so the store's value is
    // exactly what it was before the challan.
    const outs = await tx.stockLedger.findMany({
      where: { referenceType: 'DELIVERY_CHALLAN', referenceId: before.id, outQty: { gt: 0 } },
    })
    for (const o of outs) {
      await recordMovement(tx, {
        itemId: o.itemId,
        warehouseId: o.warehouseId,
        sizeId: o.sizeId,
        ownership: o.ownership,
        ownerCustomerId: o.ownerCustomerId,
        transactionType: 'RETURN',
        direction: 'IN',
        qty: Number(o.outQty),
        unitRate: Number(o.unitRate ?? 0),
        referenceType: 'DELIVERY_CHALLAN_CANCEL',
        referenceId: before.id,
        notes: `Cancelled ${before.dcNumber}: ${reason}`,
      })
    }
    for (const line of before.lines) {
      if (!line.soLineId) continue
      for (const s of line.sizes) {
        await tx.salesOrderLineSize.updateMany({
          where: { lineId: line.soLineId, sizeId: s.sizeId },
          data: { deliveredQty: { decrement: Number(s.qty) } },
        })
      }
      const soLine = await tx.salesOrderLine.findUniqueOrThrow({ where: { id: line.soLineId } })
      const delivered = Math.max(0, round2(Number(soLine.deliveredQty) - Number(line.qty)))
      await tx.salesOrderLine.update({
        where: { id: soLine.id },
        data: { deliveredQty: delivered, pendingQty: Math.max(0, round2(Number(soLine.totalQty) - delivered)) },
      })
    }
    const order = await tx.salesOrder.findUniqueOrThrow({
      where: { id: before.soId },
      select: { status: true, shortClosedAt: true, lines: { select: { pendingQty: true, deliveredQty: true } }, _count: { select: { manufacturingOrders: { where: { status: { notIn: ['DRAFT', 'CLOSED'] } } } } } },
    })
    // A short-closed order stays closed: what came back goes to stock.
    if (!order.shortClosedAt) {
      const status = statusAfter(
        order.status,
        order.lines.map((l) => ({ pendingQty: Number(l.pendingQty), deliveredQty: Number(l.deliveredQty) })),
        order._count.manufacturingOrders > 0,
      )
      await tx.salesOrder.update({ where: { id: before.soId }, data: { status } })
    }
  }

  const after = await tx.deliveryChallan.update({
    where: { id: before.id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: userId, cancelReason: reason },
    include: challanInclude,
  })
  return { before, after }
}

/**
 * POST /api/sales/challans/:id/cancel
 *
 * A draft is simply called off. A dispatched challan — the goods came back, or
 * it was raised by mistake — puts every piece back into the store at the rate
 * it left at, takes them off the order's sent, and sets the order's status
 * back to match.
 */
router.post('/:id/cancel', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const { before, after } = await prisma.$transaction((tx) => cancelChallan(tx, req.params.id, req.user!.id, reason), {
    timeout: 30_000,
  })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'DeliveryChallan', entityId: after.id, before, after })
  res.json({
    success: true,
    message:
      before.status === 'DRAFT'
        ? `${after.dcNumber} cancelled`
        : `${after.dcNumber} cancelled: its pieces are back in ${after.warehouse?.name ?? 'the store'} and back on the order`,
    data: after,
  })
})

/**
 * GET /api/sales/challans/:id/print
 *
 * What the challan prints: the company, the DC template from Settings →
 * Documents, the challan with its lines and sizes, and the value of the goods
 * at the order's rates — the figure an e-way bill is judged on.
 */
router.get('/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const dc = await prisma.deliveryChallan.findUnique({
    where: { id: req.params.id },
    include: {
      ...challanInclude,
      so: { select: { id: true, soNumber: true, orderDate: true, customerPORef: true, customerPODate: true, isJobWork: true, placeOfSupplyCode: true } },
      customer: {
        select: {
          name: true,
          gstin: true,
          phone: true,
          billingAddress: true,
          billingCity: true,
          billingState: true,
          billingStateCode: true,
          billingPincode: true,
        },
      },
    },
  })
  if (!dc) throw new AppError('Delivery challan not found', 404, 'NOT_FOUND')
  const header = await getPrintHeader(dc.so.isJobWork ? 'JW' : 'DC')

  const value = round2(
    dc.lines.reduce((s, l) => {
      const rate = Number(l.soLine?.unitPrice ?? 0) * (1 - Number(l.soLine?.discount ?? 0) / 100)
      return s + Number(l.qty) * rate
    }, 0),
  )
  const gst = round2(
    dc.lines.reduce((s, l) => {
      const rate = Number(l.soLine?.unitPrice ?? 0) * (1 - Number(l.soLine?.discount ?? 0) / 100)
      return s + Number(l.qty) * rate * (Number(l.soLine?.gstRate ?? 0) / 100)
    }, 0),
  )
  res.json({
    success: true,
    data: { ...header, challan: dc, value, gst, valueInWords: amountInWords(round2(value + gst)) },
  })
})

export default router
