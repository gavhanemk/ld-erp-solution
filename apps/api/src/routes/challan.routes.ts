import { Router } from 'express'
import type { ChallanStatus, Prisma, SalesOrderStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AuthRequest, requirePermission } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { assertNotCancelling } from '../services/orderCancel.service'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
import { amountInWords, getPrintHeader } from '../lib/printData'
import { balanceOf, recordMovement } from '../services/stock.service'
import { lockRow } from '../lib/lockRow'
import { OPEN_ORDER_STATUSES } from '../services/salesOrder.service'
import { closeCheck } from '../services/reconciliation.service'
import { afterChallanCancelled, afterChallanDispatched } from '../services/garmentHooks.service'
import { cartonsAfterCancel, cartonsAfterDispatch, cartonsOnChallan } from '../services/fgCartonHooks.service'
import { netSizeChanges } from '../services/sizeChanges.service'
import { orderBrand } from '../lib/orderBrand'
import { fabricTrace } from '../services/fabricTrace.service'

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
 * Sending more than the order line still wants, all its sizes together, is
 * allowed for an edge case, with a note saying why (the business's answer of
 * 9 Oct 2026). Within the line's total the sizes may differ from the order
 * with no note: pieces cut as one size are sometimes made as another at
 * stitching (a size jump), the order keeps the buyer's sizes, and the challan
 * is where it is decided how many of each go (the business's answer of 6 Nov
 * 2026). A size's sent can then pass what it ordered; the line's pending is
 * what completes the order. A size the order line does not carry is refused:
 * amend the order to add it.
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
  /** "B" for B-grade pieces, sent on a line of their own and billed at the B-grade rate. */
  grade: z.enum(['A', 'B']).optional(),
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
  /** Bale or package numbers, as written on them: "1, 2" or "B-14 to B-16". */
  baleNumbers: z.string().trim().max(200).optional().nullable(),
  packingListRef: z.string().trim().max(60).optional().nullable(),
  /** Gross weight, kg. */
  grossWeight: z.number().min(0).max(99_999_999).optional().nullable(),
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

/**
 * Whose finished stock an order is sent from: ours, or on a job-work order
 * the customer's — the garments made from their fabric, booked in as theirs.
 */
const ownerFor = (order: { isJobWork: boolean; customerId: string }) =>
  order.isJobWork ? { ownership: 'CUSTOMER_OWNED' as const, ownerCustomerId: order.customerId } : { ownership: 'OWNED' as const, ownerCustomerId: null }

/** What is on hand of one garment in one size and grade, in one store, for that owner. */
const onHand = (
  db: Prisma.TransactionClient | typeof prisma,
  itemId: string,
  warehouseId: string,
  sizeId: string | null,
  owner: ReturnType<typeof ownerFor> = ownerFor({ isJobWork: false, customerId: '' }),
  grade: 'A' | 'B' = 'A',
) => balanceOf(db as Prisma.TransactionClient, { itemId, warehouseId, sizeId, grade, ...owner }).then((b) => b.qty)

/**
 * The store a challan starts from: the finished-goods store when one is named
 * so, else the one holding the most of this order's garments, else the first.
 */
async function defaultStore(itemIds: string[], owner: ReturnType<typeof ownerFor>) {
  const stores = await prisma.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  const named = stores.find((w) => /finish/i.test(w.name))
  if (named || stores.length <= 1) return { stores, id: named?.id ?? stores[0]?.id ?? null }
  const held = await prisma.stockLedger.groupBy({
    by: ['warehouseId'],
    where: { itemId: { in: itemIds }, ownership: owner.ownership, ownerCustomerId: owner.ownerCustomerId },
    _sum: { inQty: true, outQty: true },
  })
  const best = held
    .map((h) => ({ id: h.warehouseId, qty: Number(h._sum.inQty ?? 0) - Number(h._sum.outQty ?? 0) }))
    .sort((a, b) => b.qty - a.qty)[0]
  return { stores, id: best && best.qty > 0 ? best.id : stores[0].id }
}

/**
 * Pieces of these garments sealed in finished-goods cartons in one store, by
 * garment, size and grade, with the cartons' codes. They leave only with their
 * carton (Finished Goods → Cartons → Dispatch) or once it is opened — the
 * stock check refuses them on a typed challan — so the form counts them apart
 * from the loose pieces rather than offering what cannot go.
 */
async function sealedInCartons(itemIds: string[], warehouseId: string) {
  const lines = await prisma.fgCartonLine.findMany({
    where: { itemId: { in: itemIds }, carton: { status: 'PACKED', warehouseId } },
    select: { itemId: true, sizeId: true, grade: true, qty: true, carton: { select: { code: true } } },
  })
  const held = new Map<string, { qty: number; codes: string[] }>()
  for (const l of lines) {
    const key = `${l.itemId}|${l.sizeId}|${l.grade}`
    const hit = held.get(key) ?? { qty: 0, codes: [] }
    hit.qty += l.qty
    if (!hit.codes.includes(l.carton.code)) hit.codes.push(l.carton.code)
    held.set(key, hit)
  }
  return (itemId: string, sizeId: string, grade: 'A' | 'B') => held.get(`${itemId}|${sizeId}|${grade}`) ?? { qty: 0, codes: [] }
}

/**
 * Pieces already on draft challans leaving this store, by garment, size and
 * grade, with the drafts' numbers — the same owner's stock only (our own, or
 * this job-work customer's). A draft moves no stock, but two drafts must not
 * promise the same pieces; dispatching checks the stock again either way.
 */
async function heldOnDrafts(itemIds: string[], warehouseId: string, owner: ReturnType<typeof ownerFor>, exceptDcId: string) {
  const lines = await prisma.deliveryChallanLine.findMany({
    where: {
      itemId: { in: itemIds },
      dc: {
        status: 'DRAFT',
        warehouseId,
        id: { not: exceptDcId },
        so: owner.ownership === 'OWNED' ? { isJobWork: false } : { isJobWork: true, customerId: owner.ownerCustomerId ?? '' },
      },
    },
    select: { itemId: true, grade: true, qty: true, dc: { select: { dcNumber: true } }, sizes: { select: { sizeId: true, qty: true } } },
  })
  const held = new Map<string, { qty: number; on: string[] }>()
  const add = (key: string, qty: number, dcNumber: string) => {
    const hit = held.get(key) ?? { qty: 0, on: [] }
    hit.qty += qty
    if (!hit.on.includes(dcNumber)) hit.on.push(dcNumber)
    held.set(key, hit)
  }
  for (const l of lines) {
    if (!l.itemId) continue
    if (l.sizes.length) for (const s of l.sizes) add(`${l.itemId}|${s.sizeId ?? ''}|${l.grade}`, Number(s.qty), l.dc.dcNumber)
    else add(`${l.itemId}||${l.grade}`, Number(l.qty), l.dc.dcNumber)
  }
  return (itemId: string, sizeId: string | null, grade: 'A' | 'B') => held.get(`${itemId}|${sizeId ?? ''}|${grade}`) ?? { qty: 0, on: [] }
}

/**
 * GET /api/sales/challans/prepare?soId=&warehouseId=&dcId=
 *
 * Everything the challan form needs for one order: its lines, each size's
 * ordered, sent and pending pieces (never below nothing; `over` is what was
 * sent beyond the size's order, after a size jump), and what is loose in the
 * chosen store — pieces sealed in a carton are `sealed`, with the cartons'
 * codes, and are not counted in `inStock`; nor are pieces already on another
 * draft challan from that store (`held`, with the drafts' numbers), so two
 * drafts never promise the same pieces. With `dcId`, that draft's own pieces
 * are not counted against it.
 *
 * Also: the order's other open drafts (open one instead of starting another),
 * the cartons already packed for it, and on a job-work order the fabric each
 * garment was made from, read from production (services/fabricTrace).
 * Stock is read here, under the sales permission, so a sales coordinator does
 * not need Inventory rights to see what can be sent.
 */
router.get('/prepare', requirePermission(MODULE, 'view'), async (req, res) => {
  const soId = text(req.query.soId)
  if (!soId) throw new AppError('Say which order', 400, 'NO_ORDER')
  const order = await prisma.salesOrder.findUnique({ where: { id: soId }, include: orderForDispatch })
  if (!order) throw new AppError('Sales order not found', 404, 'NOT_FOUND')

  const owner = ownerFor(order)
  const { stores, id: fallback } = await defaultStore(order.lines.map((l) => l.itemId), owner)
  const warehouseId = text(req.query.warehouseId) ?? fallback
  const dcId = text(req.query.dcId) ?? ''

  // What size changes at stitching added to each size of each line: "Fill what can go" makes up a
  // line's total only from those, never from other stock of a size the buyer did not ask for.
  const moLines = await prisma.mOLine.findMany({ where: { soLineId: { in: order.lines.map((l) => l.id) } }, select: { id: true, soLineId: true } })
  const net = moLines.length ? await netSizeChanges(prisma, { moLineId: { in: moLines.map((m) => m.id) } }) : () => 0
  const gainedOf = (soLineId: string, sizeId: string) => Math.max(0, moLines.filter((m) => m.soLineId === soLineId).reduce((t, m) => t + net(m.id, sizeId), 0))
  // Only our own pieces are held by a carton, as in the stock check.
  const sealed =
    warehouseId && owner.ownership === 'OWNED'
      ? await sealedInCartons(order.lines.map((l) => l.itemId), warehouseId)
      : () => ({ qty: 0, codes: [] as string[] })
  const held = warehouseId ? await heldOnDrafts(order.lines.map((l) => l.itemId), warehouseId, owner, dcId) : () => ({ qty: 0, on: [] as string[] })

  // Job work: which of the customer's rolls each garment was made from, from production.
  const traces = order.isJobWork ? await fabricTrace(prisma, order.lines.map((l) => l.id)) : null

  const lines = await Promise.all(
    order.lines.map(async (l) => {
      const ordered = Number(l.totalQty)
      const sent = Number(l.deliveredQty)
      const sizes = l.sizes.length
        ? await Promise.all(
            l.sizes.map(async (s) => {
              const a = sealed(l.itemId, s.sizeId, 'A')
              const b = sealed(l.itemId, s.sizeId, 'B')
              const ha = held(l.itemId, s.sizeId, 'A')
              const hb = held(l.itemId, s.sizeId, 'B')
              const inA = warehouseId ? await onHand(prisma, l.itemId, warehouseId, s.sizeId, owner) : 0
              const inB = warehouseId ? await onHand(prisma, l.itemId, warehouseId, s.sizeId, owner, 'B') : 0
              return {
                sizeId: s.sizeId,
                code: s.size.code,
                sequence: s.size.sequence,
                ordered: Number(s.qty),
                sent: Number(s.deliveredQty),
                pending: Math.max(0, round2(Number(s.qty) - Number(s.deliveredQty))),
                over: Math.max(0, round2(Number(s.deliveredQty) - Number(s.qty))),
                gained: gainedOf(l.id, s.sizeId),
                inStock: Math.max(0, round2(inA - a.qty - ha.qty)),
                inStockB: Math.max(0, round2(inB - b.qty - hb.qty)),
                sealed: a.qty,
                sealedB: b.qty,
                cartons: [...new Set([...a.codes, ...b.codes])],
                held: round2(ha.qty + hb.qty),
                heldOn: [...new Set([...ha.on, ...hb.on])],
              }
            })
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
        inStock: sizes
          ? sizes.reduce((s, z) => s + z.inStock, 0)
          : warehouseId
            ? Math.max(0, round2((await onHand(prisma, l.itemId, warehouseId, null, owner)) - held(l.itemId, null, 'A').qty))
            : 0,
        inStockB: sizes
          ? sizes.reduce((s, z) => s + z.inStockB, 0)
          : warehouseId
            ? Math.max(0, round2((await onHand(prisma, l.itemId, warehouseId, null, owner, 'B')) - held(l.itemId, null, 'B').qty))
            : 0,
        held: sizes ? round2(sizes.reduce((s, z) => s + z.held, 0)) : round2(held(l.itemId, null, 'A').qty + held(l.itemId, null, 'B').qty),
        heldOn: sizes ? [...new Set(sizes.flatMap((z) => z.heldOn))] : [...new Set([...held(l.itemId, null, 'A').on, ...held(l.itemId, null, 'B').on])],
        sealed: sizes ? sizes.reduce((s, z) => s + z.sealed + z.sealedB, 0) : 0,
        cartons: sizes ? [...new Set(sizes.flatMap((z) => z.cartons))].sort() : [],
        bGradeRate: l.bGradeRate != null ? Number(l.bGradeRate) : null,
        sizes,
        trace: traces?.get(l.id) ?? null,
      }
    })
  )
  const [otherDrafts, packedCartons] = await Promise.all([
    prisma.deliveryChallan.findMany({
      where: { soId: order.id, status: 'DRAFT', id: { not: dcId } },
      select: { id: true, dcNumber: true, dcDate: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.fgCarton.findMany({
      where: { soId: order.id, status: 'PACKED' },
      select: { code: true, dc: { select: { dcNumber: true } }, lines: { select: { qty: true } } },
      orderBy: { code: 'asc' },
    }),
  ])

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
      otherDrafts,
      packedCartons: packedCartons.map((c) => ({ code: c.code, pieces: c.lines.reduce((s, x) => s + x.qty, 0), onChallan: c.dc?.dcNumber ?? null })),
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
      brand: { select: { name: true, type: true } },
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

const challanCustomerSelect = { id: true, name: true, gstin: true, billingCity: true, shippingCity: true } as const
const challanInclude = {
  so: { select: { id: true, soNumber: true, status: true, isJobWork: true, customerPORef: true, brand: { select: { name: true, type: true } }, customer: { select: challanCustomerSelect } } },
  customer: { select: challanCustomerSelect },
  warehouse: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  dispatchedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  lines: {
    include: {
      item: { select: { id: true, code: true, name: true, color: true, hsnCode: true } },
      uom: { select: { symbol: true } },
      soLine: { select: { id: true, unitPrice: true, gstRate: true, discount: true } },
      sizes: { include: { size: { select: { id: true, code: true, sequence: true } } } },
    },
  },
  /** The invoice billing it, if any: a challan is billed once. */
  invoices: { where: { status: { not: 'CANCELLED' } }, select: { id: true, invoiceNumber: true } },
  /** The cartons loaded on it, for its packing list. */
  fgCartons: {
    select: {
      code: true,
      lines: {
        select: { qty: true, grade: true, item: { select: { code: true, name: true, color: true, style: { select: { code: true } } } }, size: { select: { code: true, sequence: true } } },
        orderBy: [{ item: { code: 'asc' as const } }, { size: { sequence: 'asc' as const } }],
      },
    },
    orderBy: { code: 'asc' as const },
  },
} satisfies Prisma.DeliveryChallanInclude

/**
 * Whether a draft can be dispatched as it stands: every piece on it is in its
 * store, loose (not sealed in a carton), for the order's owner. Shown on the
 * list as "Ready to dispatch"; dispatching checks the stock again.
 */
async function draftReady(dc: {
  warehouseId: string | null
  customerId: string | null
  so: { isJobWork: boolean }
  lines: Array<{ itemId: string | null; grade: string; qty: unknown; sizes: Array<{ sizeId: string | null; qty: unknown }> }>
}) {
  if (!dc.warehouseId || !dc.lines.length) return false
  const owner = ownerFor({ isJobWork: dc.so.isJobWork, customerId: dc.customerId ?? '' })
  const itemIds = dc.lines.map((l) => l.itemId).filter((x): x is string => !!x)
  const sealed = owner.ownership === 'OWNED' ? await sealedInCartons(itemIds, dc.warehouseId) : () => ({ qty: 0, codes: [] as string[] })
  for (const l of dc.lines) {
    if (!l.itemId) continue
    const grade = l.grade === 'B' ? 'B' : 'A'
    const parts = l.sizes.length ? l.sizes.map((s) => ({ sizeId: s.sizeId, qty: Number(s.qty) })) : [{ sizeId: null, qty: Number(l.qty) }]
    for (const p of parts) {
      if (p.qty <= 0) continue
      const have = await onHand(prisma, l.itemId, dc.warehouseId, p.sizeId, owner, grade)
      const loose = have - (p.sizeId ? sealed(l.itemId, p.sizeId, grade).qty : 0)
      if (loose + 1e-9 < p.qty) return false
    }
  }
  return true
}

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
        { customerId: null, so: { customer: { name: { contains: q, mode: 'insensitive' } } } },
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
  if (customerId) and.push({ OR: [{ customerId }, { customerId: null, so: { customerId } }] })
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
  // A draft is ready to dispatch when its store holds every piece on it, loose (28 Nov 2026).
  const ready = new Map<string, boolean>()
  for (const r of rows) if (r.status === 'DRAFT') ready.set(r.id, await draftReady(r))
  // Legacy challans predate the direct customer link. Resolve from the order on
  // read, retaining any explicitly recorded customer and leaving history intact.
  const data = rows.map((r) => ({
    ...r,
    customer: r.customer ?? r.so.customer,
    pieces: r.lines.reduce((s, l) => s + Number(l.qty), 0),
    ready: r.status === 'DRAFT' ? (ready.get(r.id) ?? false) : null,
  }))
  res.json({ success: true, data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
})

// GET /api/sales/challans/:id
router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const dc = await prisma.deliveryChallan.findUnique({ where: { id: req.params.id }, include: challanInclude })
  if (!dc) throw new AppError('Delivery challan not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: { ...dc, customer: dc.customer ?? dc.so.customer } })
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
    // Good and B-grade pieces of one order line go on a line each.
    const key = `${line.id}|${input.grade ?? 'A'}`
    if (seen.has(key)) throw new AppError(`${line.item.code}${input.grade === 'B' ? ' (B-grade)' : ''} appears twice on the challan`, 400, 'BAD_LINE')
    seen.add(key)

    // Only sizes the order line carries: a size jump at stitching goes only
    // to one of them, so anything else is a mistake or a change to the order.
    const ordered = new Map(line.sizes.map((s) => [s.sizeId, s]))
    let sizes: Array<{ sizeId: string; code: string; qty: number }> = []
    let qty: number
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
          return { sizeId: s.sizeId, code: o.size.code, qty: s.qty }
        })
      qty = sizes.reduce((s, z) => s + z.qty, 0)
    } else {
      qty = input.qty ?? 0
    }
    const pending = Math.max(0, round2(Number(line.totalQty) - Number(line.deliveredQty)))
    return { input, line, sizes, qty, pending }
  })

  const real = out.filter((l) => l.qty > 0)
  if (real.length === 0) throw new AppError('Put the pieces to send against at least one line', 400, 'NOTHING_TO_SEND')

  // More than the order line still wants, all its sizes together: allowed,
  // but only with a word on why. A size over its own pending within the
  // line's total needs none — sizes may differ from the order after a size
  // jump (ordered M 200 / L 150, made M 180 / L 170: all 350 go, no note).
  // Good and B-grade pieces of one order line count together against it.
  const sentFor = (soLineId: string) => round2(real.filter((x) => x.line.id === soLineId).reduce((s, x) => s + x.qty, 0))
  for (const l of real) {
    const sending = sentFor(l.line.id)
    const noted = real.some((x) => x.line.id === l.line.id && x.input.overNote?.trim())
    if (sending > l.pending && !noted) {
      const n = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 })
      throw new AppError(
        l.pending > 0
          ? `${l.line.item.code}: ${n(sending)} pcs is more than the ${n(l.pending)} the order still wants. Add a note saying why.`
          : `${l.line.item.code}: all the order wanted has been sent. Add a note saying why ${n(sending)} more pcs go.`,
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
  const so = await tx.salesOrder.findUniqueOrThrow({ where: { id: dc.soId }, select: { isJobWork: true, customerId: true } })
  const owner = ownerFor(so)

  for (const line of dc.lines) {
    if (!line.itemId || !line.soLineId) continue
    const parts = line.sizes.length ? line.sizes.map((s) => ({ sizeId: s.sizeId as string | null, qty: Number(s.qty) })) : [{ sizeId: null, qty: Number(line.qty) }]
    for (const part of parts) {
      if (part.qty <= 0) continue
      await recordMovement(tx, {
        itemId: line.itemId,
        warehouseId: dc.warehouseId,
        sizeId: part.sizeId,
        grade: line.grade,
        ...owner,
        transactionType: 'SALE',
        direction: 'OUT',
        qty: part.qty,
        referenceType: 'DELIVERY_CHALLAN',
        referenceId: dc.id,
        transactionDate: dc.dcDate,
        notes: `Dispatched on ${dc.dcNumber}`,
        // A draft dated last week and sent today goes out today in the ledger.
        earlierDate: 'move-up',
        // Pieces sealed in the cartons loaded on it leave with them.
        cartonsOn: dc.id,
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
  let status = statusAfter(
    order.status,
    order.lines.map((l) => ({ pendingQty: Number(l.pendingQty), deliveredQty: Number(l.deliveredQty) })),
    order._count.manufacturingOrders > 0,
  )
  // Everything sent on a job-work order does not close it while the
  // customer's material is not all accounted for: it stays open, to be
  // closed from the order once that is put right, or on a manager's exception.
  const materialOpen = status === 'COMPLETED' && so.isJobWork && (await closeCheck(tx, dc.soId)).gaps.length > 0
  if (materialOpen) status = 'PARTIALLY_DISPATCHED'
  await tx.salesOrder.update({ where: { id: dc.soId }, data: { status } })
  await tx.deliveryChallan.update({
    where: { id: dc.id },
    data: { status: 'DISPATCHED', dispatchedAt: new Date(), dispatchedById: userId },
  })
  // Tagged pieces scanned onto it are gone with it.
  await afterChallanDispatched(tx, dc.id, userId)
  // And the cartons loaded on it.
  await cartonsAfterDispatch(tx, dc.id)
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
    baleNumbers: data.baleNumbers?.trim() || null,
    packingListRef: data.packingListRef?.trim() || null,
    grossWeight: data.grossWeight ?? null,
    packingNote: data.packingNote ?? null,
    notes: data.notes ?? null,
  }
  const lines = shaped.map((l) => ({
    soLineId: l.line.id,
    itemId: l.line.itemId,
    grade: l.input.grade ?? 'A',
    description: `${l.line.item.name}${l.line.item.color ? ` · ${l.line.item.color}` : ''}${l.input.grade === 'B' ? ' · B-grade' : ''}`,
    qty: l.qty,
    uomId: l.line.item.uomId,
    overNote: l.input.overNote?.trim() || null,
    sizes: l.sizes.length ? { create: l.sizes.map((s) => ({ sizeId: s.sizeId, qty: s.qty })) } : undefined,
  }))

  let dc
  if (existing) {
    await tx.deliveryChallanLine.deleteMany({ where: { dcId: existing.id } })
    dc = await tx.deliveryChallan.update({ where: { id: existing.id }, data: { ...header, lines: { create: lines } } })
  } else {
    const dcNumber = await nextDocumentNumber(tx, 'DC', header.dcDate)
    dc = await tx.deliveryChallan.create({ data: { ...header, dcNumber, createdById: userId, lines: { create: lines } } })
  }
  return dc
}

export async function loadOpenOrder(tx: Prisma.TransactionClient, soId: string) {
  // One dispatch at a time per order, each reading what was sent fresh.
  await tx.$queryRaw`SELECT id FROM ld_erp.sales_orders WHERE id = ${soId} FOR UPDATE`
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
  await assertNotCancelling(tx, order.id, 'nothing is dispatched for it')
  return order
}

/** "DC-… dispatched: 238.17 mtr · 20 pcs out of stock" — each unit on its own, never added together. */
const dispatchedMessage = (dcNumber: string, lines: Array<{ qty: unknown; uom?: { symbol: string } | null }>) => {
  const byUnit = new Map<string, number>()
  for (const l of lines) byUnit.set(l.uom?.symbol ?? 'pcs', (byUnit.get(l.uom?.symbol ?? 'pcs') ?? 0) + Number(l.qty))
  const text = [...byUnit.entries()].map(([unit, n]) => `${n.toLocaleString('en-IN')} ${unit}`).join(' · ')
  return `${dcNumber} dispatched: ${text} out of stock`
}

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
  res.status(201).json({
    success: true,
    message: data.dispatch ? dispatchedMessage(dc.dcNumber, dc.lines) : `${dc.dcNumber} saved as a draft`,
    data: dc,
  })
})

// PATCH /api/sales/challans/:id — change a draft; dispatch it too with `dispatch`.
router.patch('/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = challanSchema.parse(req.body)
  const { before, after } = await prisma.$transaction(
    async (tx) => {
      // Held first: a double click on "Save and dispatch" must find it gone.
      await lockRow(tx, 'deliveryChallan', req.params.id)
      const before = await tx.deliveryChallan.findUnique({ where: { id: req.params.id }, include: challanInclude })
      if (!before) throw new AppError('Delivery challan not found', 404, 'NOT_FOUND')
      if (before.status !== 'DRAFT') throw new AppError(`${before.dcNumber} has gone; it can no longer be changed`, 409, 'NOT_DRAFT')
      if (data.soId !== before.soId) throw new AppError('A challan cannot move to another order', 400, 'ORDER_CHANGED')
      if (await cartonsOnChallan(tx, before.id)) {
        throw new AppError(`${before.dcNumber}'s lines come from the cartons loaded on it: change them on Inventory → Finished Goods → Cartons → Dispatch.`, 409, 'HAS_CARTONS')
      }
      const order = await loadOpenOrder(tx, before.soId)
      await writeChallan(tx, order, data, { id: before.id }, req.user!.id)
      if (data.dispatch) await dispatchChallan(tx, before.id, req.user!.id)
      const after = await tx.deliveryChallan.findUniqueOrThrow({ where: { id: before.id }, include: challanInclude })
      return { before, after }
    },
    { timeout: 30_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'DeliveryChallan', entityId: after.id, before, after })
  res.json({
    success: true,
    message: data.dispatch ? dispatchedMessage(after.dcNumber, after.lines) : `${after.dcNumber} saved`,
    data: after,
  })
})

// POST /api/sales/challans/:id/dispatch — send a saved draft.
router.post('/:id/dispatch', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { before, after } = await prisma.$transaction(
    async (tx) => {
      // Locked first: a double click or a second tab must find it already gone,
      // not send the same goods out twice.
      await tx.$queryRaw`SELECT id FROM ld_erp.delivery_challans WHERE id = ${req.params.id} FOR UPDATE`
      const before = await tx.deliveryChallan.findUnique({ where: { id: req.params.id }, include: challanInclude })
      if (!before) throw new AppError('Delivery challan not found', 404, 'NOT_FOUND')
      if (before.status !== 'DRAFT') throw new AppError(`${before.dcNumber} has already gone`, 409, 'NOT_DRAFT')
      const order = await loadOpenOrder(tx, before.soId)
      // A draft does not move what is pending, so one checked when it was saved may now go past what the line still wants.
      shapeLines(order, {
        soId: before.soId,
        warehouseId: before.warehouseId ?? '',
        lines: before.lines
          .filter((l) => l.soLineId)
          .map((l) => ({
            soLineId: l.soLineId!,
            grade: l.grade === 'B' ? ('B' as const) : ('A' as const),
            sizes: l.sizes.filter((z) => z.sizeId).map((z) => ({ sizeId: z.sizeId!, qty: Number(z.qty) })),
            qty: Number(l.qty),
            overNote: l.overNote,
          })),
      })
      await dispatchChallan(tx, before.id, req.user!.id)
      const after = await tx.deliveryChallan.findUniqueOrThrow({ where: { id: before.id }, include: challanInclude })
      return { before, after }
    },
    { timeout: 30_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'DeliveryChallan', entityId: after.id, before, after })
  res.json({ success: true, message: dispatchedMessage(after.dcNumber, after.lines), data: after })
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
  // Two clicks at once would both find it out and bring the goods back twice.
  await lockRow(tx, 'deliveryChallan', dcId)
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
        grade: o.grade,
        ownership: o.ownership,
        ownerCustomerId: o.ownerCustomerId,
        transactionType: 'RETURN',
        direction: 'IN',
        qty: Number(o.outQty),
        unitRate: Number(o.unitRate ?? 0),
        referenceType: 'DELIVERY_CHALLAN_CANCEL',
        referenceId: before.id,
        notes: `Cancelled ${before.dcNumber}: ${reason}`,
        earlierDate: 'move-up',
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

  // Its tagged pieces are back in the store and free for another challan.
  await afterChallanCancelled(tx, before.id, userId)
  // Its cartons stay sealed in the store, free for another challan.
  await cartonsAfterCancel(tx, before.id)
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
  const printCustomerSelect = {
    name: true, gstin: true, phone: true, billingAddress: true, billingCity: true, billingState: true, billingStateCode: true, billingPincode: true,
    // The consignee: where the goods go, and the GSTIN they are taken under there.
    shippingAddress: true, shippingCity: true, shippingState: true, shippingPincode: true, shippingGstin: true,
  } as const
  const dc = await prisma.deliveryChallan.findUnique({
    where: { id: req.params.id },
    include: {
      ...challanInclude,
      so: {
        select: {
          id: true, soNumber: true, orderDate: true, customerPORef: true, customerPODate: true, isJobWork: true, placeOfSupplyCode: true,
          customer: { select: printCustomerSelect },
          broker: { select: { name: true } },
        },
      },
      customer: { select: printCustomerSelect },
      // Every detail of each garment, as the sales order prints it (28 Nov 2026).
      lines: {
        include: {
          item: {
            select: { id: true, code: true, name: true, color: true, hsnCode: true, uom: { select: { symbol: true } }, style: { select: { code: true, name: true } } },
          },
          soLine: {
            select: {
              id: true, unitPrice: true, gstRate: true, discount: true,
              styleCode: true, color: true, gender: true, fabric: true, printName: true, description: true, hsnCode: true,
            },
          },
          sizes: { include: { size: { select: { id: true, code: true, sequence: true } } }, orderBy: { size: { sequence: 'asc' } } },
        },
      },
    },
  })
  if (!dc) throw new AppError('Delivery challan not found', 404, 'NOT_FOUND')
  // One title for every delivery challan, "DELIVERY CHALLAN" (the user's decision of
  // 28 Nov 2026): job work is said on its Type line and by what it carries, not the title.
  // The JW template is the job work challan to job workers, a different document.
  const header = await getPrintHeader('DC')

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
    data: {
      ...header,
      brand: await orderBrand(prisma, { soId: dc.soId }),
      challan: { ...dc, customer: dc.customer ?? dc.so.customer },
      value,
      gst,
      valueInWords: amountInWords(round2(value + gst)),
      ...(await printTrace(dc.so.isJobWork, dc.lines.map((l) => l.soLineId).filter((x): x is string => !!x))),
    },
  })
})

/**
 * A job-work challan's fabric, for its print: each garment's rolls from
 * production (services/fabricTrace) and the old job challan's reconciliation
 * strip — one row per customer receipt those rolls came on, with what came in
 * on it (date, lots, their challan number, rolls and metres). The pieces
 * packed are the challan's own. Metres per piece and the shortage are left
 * out until the business confirms how they are worked out (28 Nov 2026).
 */
async function printTrace(isJobWork: boolean, soLineIds: string[]) {
  if (!isJobWork || !soLineIds.length) return { trace: {}, reconciliation: [] }
  const traces = await fabricTrace(prisma, [...new Set(soLineIds)])
  const rolls = [...traces.values()].flatMap((t) => t.rolls)
  const grnIds = [...new Set(rolls.map((r) => r.grnId).filter((x): x is string => !!x))]
  const grns = grnIds.length
    ? await prisma.customerGRN.findMany({
        where: { id: { in: grnIds } },
        select: { id: true, grnNumber: true, receiptDate: true, challanNumber: true, lines: { select: { rolls: { select: { meters: true } } } } },
        orderBy: { receiptDate: 'asc' },
      })
    : []
  return {
    trace: Object.fromEntries(traces),
    reconciliation: grns.map((g) => {
      const received = g.lines.flatMap((l) => l.rolls)
      return {
        grnNumber: g.grnNumber,
        receiptDate: g.receiptDate,
        partyChallan: g.challanNumber,
        lots: [...new Set(rolls.filter((r) => r.grnId === g.id).map((r) => r.lotNo).filter((x): x is string => !!x))],
        receivedRolls: received.length,
        receivedMeters: Math.round(received.reduce((s, r) => s + Number(r.meters), 0) * 1000) / 1000,
      }
    }),
  }
}

export default router
