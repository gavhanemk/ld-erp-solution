import { Router } from 'express'
import type { Prisma, SalesOrderStatus } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AuthRequest, isAdmin, requirePermission, userCan } from '../middleware/auth'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { applyRoundOff, nextDocumentNumber, resolvePlaceOfSupply } from '../lib/docNumber'
import { findHsn, gstRateFor, loadHsnIndex } from '../lib/hsn'
import { GST_STATES, stateName } from '../lib/gstStates'
import { amountInWords, getPrintHeader } from '../lib/printData'
import {
  MAX_FILES_PER_DOCUMENT,
  MAX_FILE_BYTES,
  removeObject,
  signedDownloadUrl,
  signedUploadUrl,
  statObject,
  storagePathFor,
} from '../lib/storage'
import {
  OPEN_ORDER_STATUSES,
  checkCredit,
  confirmMessage,
  confirmOrHold,
  creditPosition,
  type ConfirmOutcome,
} from '../services/salesOrder.service'

const router = Router()
const MODULE = 'sales'

const ORDER_STATUSES: SalesOrderStatus[] = [
  'DRAFT',
  'CONFIRMED',
  'IN_PRODUCTION',
  'PARTIALLY_DISPATCHED',
  'COMPLETED',
  'CANCELLED',
]

/**
 * A sales order used to be created straight from `req.body` with no validation
 * at all, which meant a missing quantity became NaN and a bad customer id
 * surfaced as a database error.
 *
 * There is no GST rate here. It used to be taken from the browser; it is now
 * worked out on the server from the item's HSN code, so a screen cannot send
 * the wrong one. A caller that still sends `gstRate` is not refused — the
 * field is simply dropped.
 */
const salesOrderLineSchema = z.object({
  itemId: z.string().min(1, 'Pick an item'),
  styleCode: z.string().max(50).optional().nullable(),
  color: z.string().max(50).optional().nullable(),
  totalQty: z.number().positive('Quantity must be more than zero'),
  unitPrice: z.number().min(0, 'Rate cannot be negative'),
  discount: z.number().min(0).max(100).optional(),
  /** As on the size-run master. */
  gender: z.enum(['MALE', 'FEMALE', 'UNISEX']).optional().nullable(),
  fabric: z.string().trim().max(80).optional().nullable(),
  printName: z.string().trim().max(80).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  /** No GST on this line, whatever the item's HSN code says. */
  taxExempt: z.boolean().optional(),
  /** The size run for this line. Quantities must add up to the line total. */
  sizes: z
    .array(z.object({ sizeId: z.string().min(1), qty: z.number().min(0) }))
    .optional(),
})

/** The order as the form sends it, before the checks that span its lines. */
const salesOrderBaseSchema = z.object({
  customerId: z.string().min(1, 'Pick a customer'),
  brandId: z.string().min(1, 'Pick a brand'),
  orderDate: z.coerce.date().optional(),
  deliveryDate: z.coerce.date().optional().nullable(),
  customerPORef: z.string().max(60).optional().nullable(),
  customerPODate: z.coerce.date().optional().nullable(),
  deliveryAddress: z.string().max(500).optional().nullable(),
  billingAddress: z.string().max(500).optional().nullable(),
  reference: z.string().trim().max(80).optional().nullable(),
  /**
   * The state the goods go to, when this order is delivered somewhere other
   * than the customer's own state. Decides CGST + SGST or IGST.
   */
  placeOfSupplyCode: z
    .string()
    .refine((c) => c in GST_STATES, 'That is not a GST state code')
    .optional()
    .nullable(),
  salesperson: z.string().max(120).optional().nullable(),
  brokerId: z.string().optional().nullable(),
  brokeragePercent: z.number().min(0).max(100).optional().nullable(),
  discountAmount: z.number().min(0).optional(),
  isJobWork: z.boolean().optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().max(1000).optional().nullable(),
  terms: z.string().max(2000).optional().nullable(),
  /** Transport, freight, packing: picked from Masters → Charges, each taxed at its own rate. */
  charges: z
    .array(
      z.object({
        chargeTypeId: z.string().min(1, 'Pick the charge'),
        amount: z.number().min(0, 'A charge cannot be negative'),
        /** The GST on this charge; the charge master's rate when not sent. */
        gstRate: z.number().min(0).max(100).optional().nullable(),
      }),
    )
    .max(20)
    .optional(),
  /** Added after tax and carrying none of its own. */
  otherCharges: z.number().min(0).optional(),
  /**
   * Save and confirm in one go, rather than keep it as a draft. A customer over
   * their credit limit puts it on hold for a manager instead (confirmOrHold).
   */
  confirm: z.boolean().optional(),
  /** Releasing a credit hold while confirming: only the Admin or an approver. */
  creditReleaseReason: z.string().trim().min(5, 'Say why the credit hold is released, in a few words').max(500).optional().nullable(),
  lines: z.array(salesOrderLineSchema).min(1, 'An order needs at least one line'),
})

/**
 * A size run that does not add up to the line quantity is the classic way a
 * cutting sheet and an invoice quietly stop agreeing. Kept apart from the
 * object so the amend schema can extend the object and still be checked —
 * a refined schema can no longer be extended.
 */
function checkSizeRuns(
  order: { lines: Array<{ totalQty: number; sizes?: Array<{ sizeId: string; qty: number }> }> },
  ctx: z.RefinementCtx,
) {
  order.lines.forEach((line, i) => {
    if (!line.sizes?.length) return
    const sum = line.sizes.reduce((s, x) => s + x.qty, 0)
    if (Math.abs(sum - line.totalQty) > 0.001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines', i, 'sizes'],
        message: `Size quantities add up to ${sum}, but the line total is ${line.totalQty}`,
      })
    }
    const ids = line.sizes.map((s) => s.sizeId)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines', i, 'sizes'],
        message: 'The same size appears twice on this line',
      })
    }
  })
}

/** One row per kind of charge: two "Transport" rows on one order are a slip. */
function checkCharges(order: { charges?: Array<{ chargeTypeId: string }> }, ctx: z.RefinementCtx) {
  const ids = (order.charges ?? []).map((c) => c.chargeTypeId)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['charges'], message: 'The same charge appears twice. Put it on one row.' })
  }
}

export const createSalesOrderSchema = salesOrderBaseSchema.superRefine(checkSizeRuns).superRefine(checkCharges)

/**
 * An amendment: the whole order again, each line carrying the id it already
 * has (a new line has none), and why it changed. Ids keep a line the same
 * line across versions, so what is later delivered against it stays tied
 * to it.
 */
const amendSalesOrderSchema = salesOrderBaseSchema
  .extend({
    reason: z.string().trim().min(5, 'Say why the order is changing, in a few words').max(500),
    lines: z
      .array(salesOrderLineSchema.extend({ id: z.string().optional() }))
      .min(1, 'An order needs at least one line'),
  })
  .superRefine(checkSizeRuns)
  .superRefine(checkCharges)

/** Why an order is cancelled or short-closed. */
const reasonBody = z.object({
  reason: z.string().trim().min(5, 'Say why, in a few words').max(500),
})

/** A non-empty trimmed query value, or nothing. */
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** A yyyy-mm-dd query value as a date, refusing anything else. */
function dateParam(v: unknown, name: string): Date | undefined {
  const s = text(v)
  if (!s) return undefined
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) throw new AppError(`'${name}' is not a date`, 400, 'BAD_DATE')
  return d
}

/**
 * Midnight today on the server's clock. Delivery dates are stored as dates, so
 * "overdue" means due before today, not before this minute.
 */
function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

/**
 * GET /api/sales/orders/options
 *
 * Order numbers to pick from on other modules' screens — customer material in,
 * requisitions. The store has no sales permission and must not need one to say
 * which order a roll of fabric is for, so this answers anybody who can see
 * sales or inventory, and carries no money.
 */
router.get('/orders/options', async (req: AuthRequest, res) => {
  if (!userCan(req.user, MODULE, 'view') && !userCan(req.user, 'inventory', 'view')) {
    throw new AppError('You do not have permission to view sales orders', 403, 'FORBIDDEN')
  }
  const openOnly = req.query.open === '1' || req.query.open === 'true'

  const orders = await prisma.salesOrder.findMany({
    where: openOnly ? { status: { notIn: ['COMPLETED', 'CANCELLED'] } } : {},
    select: {
      id: true,
      soNumber: true,
      status: true,
      isJobWork: true,
      deliveryDate: true,
      customerId: true,
      customer: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, Math.max(1, Number(req.query.limit) || 300)),
  })
  res.json({ success: true, data: orders })
})

/**
 * GET /api/sales/orders/summary
 *
 * The four figures over the order list: what is open and worth, pieces still
 * to go, what is due this week and what is already late.
 */
router.get('/orders/summary', requirePermission(MODULE, 'view'), async (_req, res) => {
  const today = startOfToday()
  const weekEnd = addDays(today, 7)
  const open: Prisma.SalesOrderWhereInput = { status: { in: OPEN_ORDER_STATUSES } }
  const dueThisWeek: Prisma.SalesOrderWhereInput = { ...open, deliveryDate: { gte: today, lt: weekEnd } }
  const late: Prisma.SalesOrderWhereInput = { ...open, deliveryDate: { lt: today } }
  const brief = { id: true, soNumber: true, deliveryDate: true, customer: { select: { name: true } } }

  const awaiting: Prisma.SalesOrderWhereInput = {
    status: 'DRAFT',
    approvedAt: null,
    sentForApprovalAt: { not: null },
  }

  const [openAgg, pending, dueCount, nextDue, lateCount, oldestLate, awaitingCount] = await Promise.all([
    prisma.salesOrder.aggregate({ where: open, _count: { _all: true }, _sum: { taxableAmount: true } }),
    prisma.salesOrderLine.aggregate({ where: { so: open }, _sum: { pendingQty: true } }),
    prisma.salesOrder.count({ where: dueThisWeek }),
    prisma.salesOrder.findFirst({ where: dueThisWeek, orderBy: { deliveryDate: 'asc' }, select: brief }),
    prisma.salesOrder.count({ where: late }),
    prisma.salesOrder.findFirst({ where: late, orderBy: { deliveryDate: 'asc' }, select: brief }),
    prisma.salesOrder.count({ where: awaiting }),
  ])

  res.json({
    success: true,
    data: {
      open: { count: openAgg._count._all, value: Number(openAgg._sum.taxableAmount ?? 0) },
      piecesToDispatch: Number(pending._sum.pendingQty ?? 0),
      dueThisWeek: { count: dueCount, next: nextDue },
      overdue: { count: lateCount, oldest: oldestLate },
      awaitingApproval: awaitingCount,
    },
  })
})

/**
 * GET /api/sales/orders
 *
 * Filters: q (order number, buyer PO or customer), status, open=1 (still to
 * deliver), awaiting=1 (sent for approval, not decided), customerId, brandId,
 * type (own | job-work), from / to (order date), due (overdue | week | month —
 * open orders only), page, limit.
 */
router.get('/orders', requirePermission(MODULE, 'view'), async (req: AuthRequest, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))

  const and: Prisma.SalesOrderWhereInput[] = []

  const status = text(req.query.status)
  if (status) {
    if (!ORDER_STATUSES.includes(status as SalesOrderStatus)) {
      throw new AppError(`Unknown status '${status}'`, 400, 'BAD_STATUS')
    }
    and.push({ status: status as SalesOrderStatus })
  }

  // The list's cards: every order still to be delivered, and the drafts sent
  // for approval that nobody has decided yet.
  if (req.query.open === '1') and.push({ status: { in: OPEN_ORDER_STATUSES } })
  if (req.query.awaiting === '1') {
    and.push({ status: 'DRAFT', approvedAt: null, sentForApprovalAt: { not: null } })
  }

  const customerId = text(req.query.customerId)
  if (customerId) and.push({ customerId })
  const brandId = text(req.query.brandId)
  if (brandId) and.push({ brandId })

  const type = text(req.query.type)
  if (type === 'own') and.push({ isJobWork: false })
  else if (type === 'job-work') and.push({ isJobWork: true })
  else if (type) throw new AppError(`Unknown order type '${type}'`, 400, 'BAD_TYPE')

  const from = dateParam(req.query.from, 'from')
  const to = dateParam(req.query.to, 'to')
  // `to` is a whole day: an order dated that day is in.
  if (from || to) and.push({ orderDate: { ...(from && { gte: from }), ...(to && { lt: addDays(to, 1) }) } })

  const q = text(req.query.q)
  if (q) {
    and.push({
      OR: [
        { soNumber: { contains: q, mode: 'insensitive' } },
        { customerPORef: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
      ],
    })
  }

  // Late or due soon only means something for an order still to be delivered.
  const due = text(req.query.due)
  if (due) {
    const today = startOfToday()
    const window =
      due === 'overdue'
        ? { lt: today }
        : due === 'week'
          ? { gte: today, lt: addDays(today, 7) }
          : due === 'month'
            ? { gte: new Date(today.getFullYear(), today.getMonth(), 1), lt: new Date(today.getFullYear(), today.getMonth() + 1, 1) }
            : null
    if (!window) throw new AppError(`Unknown delivery filter '${due}'`, 400, 'BAD_DUE')
    and.push({ status: { in: OPEN_ORDER_STATUSES }, deliveryDate: window })
  }

  const where: Prisma.SalesOrderWhereInput = and.length ? { AND: and } : {}

  const [orders, total] = await Promise.all([
    prisma.salesOrder.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, type: true, billingCity: true, shippingCity: true } },
        brand: { select: { id: true, name: true, type: true } },
        lines: { select: { totalQty: true, deliveredQty: true, pendingQty: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.salesOrder.count({ where }),
  ])

  // Pieces, not lines, are what the list reads: how many were ordered, how
  // many have gone, and how many are still to go.
  const data = orders.map(({ lines, ...o }) => ({
    ...o,
    pieces: lines.reduce((s, l) => s + Number(l.totalQty), 0),
    dispatched: lines.reduce((s, l) => s + Number(l.deliveredQty), 0),
    pending: lines.reduce((s, l) => s + Number(l.pendingQty), 0),
  }))

  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  })
})

// GET /api/sales/orders/:id
router.get('/orders/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const order = await prisma.salesOrder.findUnique({
    where: { id: req.params.id },
    include: {
      customer: true,
      brand: true,
      broker: { select: { id: true, name: true, brokeragePercent: true } },
      createdBy: { select: { id: true, name: true } },
      approvedBy: { select: { id: true, name: true } },
      creditReleasedBy: { select: { id: true, name: true } },
      cancelledBy: { select: { id: true, name: true } },
      shortClosedBy: { select: { id: true, name: true } },
      // The list of earlier versions; each one's full snapshot is fetched on
      // its own when somebody opens it.
      revisions: {
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          reason: true,
          changedAt: true,
          changedBy: { select: { id: true, name: true } },
        },
      },
      lines: {
        orderBy: { sortOrder: 'asc' },
        include: {
          item: {
            select: {
              id: true,
              code: true,
              name: true,
              hsnCode: true,
              color: true,
              style: { select: { id: true, code: true, name: true } },
            },
          },
          sizes: { include: { size: true }, orderBy: { size: { sequence: 'asc' } } },
        },
      },
      charges: { include: { chargeType: { select: { id: true, name: true } } }, orderBy: { sortOrder: 'asc' } },
      _count: { select: { attachments: true } },
      deliveryChallans: true,
      invoices: true,
      manufacturingOrders: { select: { id: true, moNumber: true, status: true, totalPackedQty: true } },
      materialRequisitions: { select: { id: true, mrNumber: true, status: true, closedAt: true } },
    },
  })
  if (!order) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: order })
})

/**
 * GET /api/sales/orders/:id/print
 *
 * Everything the order confirmation prints: the company and the Sales Order
 * template from Settings → Documents, the order with its lines and size runs,
 * the total in words, and which tax rows to show. Brokerage travels with the
 * order but the sheet never prints it.
 */
router.get('/orders/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const order = await prisma.salesOrder.findUnique({
    where: { id: req.params.id },
    include: {
      customer: true,
      brand: { select: { name: true, type: true } },
      createdBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      cancelledBy: { select: { name: true } },
      shortClosedBy: { select: { name: true } },
      lines: {
        orderBy: { sortOrder: 'asc' },
        include: {
          item: {
            select: {
              code: true,
              name: true,
              color: true,
              hsnCode: true,
              uom: { select: { symbol: true } },
              style: { select: { code: true, name: true } },
            },
          },
          sizes: { include: { size: true }, orderBy: { size: { sequence: 'asc' } } },
        },
      },
      charges: { include: { chargeType: { select: { name: true } } }, orderBy: { sortOrder: 'asc' } },
    },
  })
  if (!order) throw new AppError('Sales order not found', 404, 'NOT_FOUND')

  const header = await getPrintHeader('SO')
  const taxMode = Number(order.igst) > 0 ? 'IGST' : Number(order.cgst) > 0 ? 'CGST_SGST' : 'NONE'

  res.json({
    success: true,
    data: {
      ...header,
      order,
      totalInWords: amountInWords(Number(order.totalAmount)),
      taxMode,
      placeOfSupplyState: stateName(order.placeOfSupplyCode),
    },
  })
})

/**
 * GET /api/sales/customers/:id/context?value=
 *
 * What the order form shows the moment a customer is picked: where the goods
 * are taxed (inside the state or across it), and what the customer owes and
 * has on order against their credit limit — with whether an order of `value`
 * more would need a manager's release.
 *
 * A customer with no state code still answers: `placeOfSupply` comes back
 * null with the reason, so the form can say what to fix instead of failing.
 */
router.get('/customers/:id/context', requirePermission(MODULE, 'view'), async (req, res) => {
  const value = Number(req.query.value) || 0
  const position = await creditPosition(prisma, req.params.id)
  // ?state=27: the order goes to another state than the customer's own.
  const shipTo = text(req.query.state)
  if (shipTo && !(shipTo in GST_STATES)) throw new AppError(`'${shipTo}' is not a GST state code`, 400, 'BAD_STATE')

  let placeOfSupply: { code: string; state: string; isIntraState: boolean } | null = null
  let placeOfSupplyProblem: string | null = null
  try {
    const pos = await resolvePlaceOfSupply(prisma, req.params.id, shipTo)
    placeOfSupply = {
      code: pos.placeOfSupplyCode,
      state: stateName(pos.placeOfSupplyCode) ?? '',
      isIntraState: pos.isIntraState,
    }
  } catch (err) {
    if (!(err instanceof AppError)) throw err
    placeOfSupplyProblem = err.message
  }

  res.json({
    success: true,
    data: { credit: checkCredit(position, value), placeOfSupply, placeOfSupplyProblem },
  })
})

/**
 * GET /api/sales/customers/:id/last-rates
 *
 * The rate this customer last ordered each item at, with the order it was on.
 * The form shows it under the rate box: the rate itself is still typed every
 * time, as on purchase orders, never filled in.
 */
router.get('/customers/:id/last-rates', requirePermission(MODULE, 'view'), async (req, res) => {
  const lines = await prisma.salesOrderLine.findMany({
    where: { so: { customerId: req.params.id, status: { not: 'CANCELLED' } } },
    orderBy: [{ so: { orderDate: 'desc' } }, { so: { createdAt: 'desc' } }],
    select: { itemId: true, unitPrice: true, so: { select: { soNumber: true, orderDate: true } } },
    take: 1000,
  })

  const last: Record<string, { unitPrice: number; soNumber: string; orderDate: Date }> = {}
  for (const l of lines) {
    if (last[l.itemId]) continue
    last[l.itemId] = { unitPrice: Number(l.unitPrice), soNumber: l.so.soNumber, orderDate: l.so.orderDate }
  }
  res.json({ success: true, data: last })
})

type OrderInput = z.infer<typeof createSalesOrderSchema>

/**
 * Checks an order and prices it.
 *
 * The one road both a new order and an edited draft go down, so the two can
 * never be priced two ways. Returns the header's fields and the lines ready
 * to create; the number is the caller's business.
 */
export async function prepareOrder(tx: Prisma.TransactionClient, data: OrderInput) {
  const [customer, brand] = await Promise.all([
    tx.customer.findUnique({ where: { id: data.customerId }, select: { name: true, isActive: true } }),
    tx.brand.findUnique({ where: { id: data.brandId }, select: { name: true, isActive: true } }),
  ])
  if (!customer) throw new AppError('That customer does not exist', 400, 'BAD_CUSTOMER')
  // A blacklisted customer can still have a draft: the approver decides.
  if (!customer.isActive) {
    throw new AppError(`${customer.name} is switched off. Reactivate them in Masters to order for them.`, 400, 'INACTIVE')
  }
  if (!brand) throw new AppError('That brand does not exist', 400, 'BAD_BRAND')
  if (!brand.isActive) throw new AppError(`The brand ${brand.name} is switched off`, 400, 'INACTIVE')

  const items = await tx.item.findMany({
    where: { id: { in: [...new Set(data.lines.map((l) => l.itemId))] } },
    select: {
      id: true,
      code: true,
      type: true,
      isActive: true,
      hsnCode: true,
      color: true,
      taxRate: { select: { rate: true } },
      style: { select: { code: true, sizeGroupId: true } },
    },
  })
  const itemById = new Map(items.map((i) => [i.id, i]))

  const sizeIds = [...new Set(data.lines.flatMap((l) => l.sizes?.map((s) => s.sizeId) ?? []))]
  const sizes = sizeIds.length
    ? await tx.size.findMany({ where: { id: { in: sizeIds } }, select: { id: true, code: true, sizeGroupId: true } })
    : []
  const sizeById = new Map(sizes.map((s) => [s.id, s]))

  // A sales order sells garments: one finished-goods item per style and
  // colour, split into that style's own sizes.
  data.lines.forEach((l, i) => {
    const item = itemById.get(l.itemId)
    if (!item) throw new AppError(`Line ${i + 1}: that item does not exist`, 400, 'BAD_ITEM')
    if (!item.isActive) throw new AppError(`Line ${i + 1}: ${item.code} is switched off`, 400, 'INACTIVE')
    if (item.type !== 'FINISHED_GOOD') {
      throw new AppError(
        `Line ${i + 1}: ${item.code} is not a finished good. Pick the garment's style-and-colour item.`,
        400,
        'NOT_FINISHED_GOOD',
      )
    }
    // The style's own size run when it has one; otherwise any one run the
    // line picks, but only one — sizes from two runs cannot be one garment.
    const runs = new Set<string>()
    for (const s of l.sizes ?? []) {
      const size = sizeById.get(s.sizeId)
      if (!size) throw new AppError(`Line ${i + 1}: one of the sizes does not exist`, 400, 'BAD_SIZE')
      if (item.style?.sizeGroupId && size.sizeGroupId !== item.style.sizeGroupId) {
        throw new AppError(`Line ${i + 1}: size ${size.code} is not in ${item.code}'s size run`, 400, 'BAD_SIZE')
      }
      runs.add(size.sizeGroupId)
    }
    if (runs.size > 1) throw new AppError(`Line ${i + 1}: the sizes come from two different size runs`, 400, 'BAD_SIZE')
  })

  const { placeOfSupplyCode, isIntraState } = await resolvePlaceOfSupply(tx, data.customerId, data.placeOfSupplyCode)

  // Line discounts first, then a discount on the whole bill. LD prices at
  // invoice level, so taxing before that discount would overstate the GST.
  const lineTotals = data.lines.map((l) => l.totalQty * l.unitPrice * (1 - (l.discount ?? 0) / 100))
  const subtotal = round2(lineTotals.reduce((s, n) => s + n, 0))

  const discountAmount = round2(Math.min(data.discountAmount ?? 0, subtotal))
  const taxableAmount = round2(subtotal - discountAmount)

  // The bill-level discount is spread across the lines in proportion, so each
  // line is taxed on what the customer is actually being charged for it.
  const discountFactor = subtotal > 0 ? taxableAmount / subtotal : 1

  // The rate comes from the item's HSN code, at the price each piece is
  // actually sold for: ready-made garments change rate above a price per
  // piece. An item whose code is not in the HSN master keeps its own rate.
  const hsnIndex = await loadHsnIndex(tx)
  const gstRates = data.lines.map((l) => {
    if (l.taxExempt) return 0
    const item = itemById.get(l.itemId)!
    const hsn = findHsn(hsnIndex, item.hsnCode)
    if (hsn) {
      const perPiece = l.unitPrice * (1 - (l.discount ?? 0) / 100) * discountFactor
      return gstRateFor(hsn, perPiece)
    }
    if (item.taxRate) return Number(item.taxRate.rate)
    throw new AppError(`${item.code} has no HSN code or GST rate. Set one on the item before ordering it.`, 400, 'NO_GST_RATE')
  })

  let cgst = 0
  let sgst = 0
  let igst = 0
  data.lines.forEach((_line, i) => {
    const tax = lineTotals[i] * discountFactor * (gstRates[i] / 100)
    if (isIntraState) {
      cgst += tax / 2
      sgst += tax / 2
    } else {
      igst += tax
    }
  })
  // Charges: each from the charge master, taxed at its own rate (the
  // master's unless the form sent one), split the same way as the goods.
  const chargeInput = (data.charges ?? []).filter((c) => c.amount > 0)
  const chargeTypes = chargeInput.length
    ? await tx.chargeType.findMany({
        where: { id: { in: chargeInput.map((c) => c.chargeTypeId) } },
        select: { id: true, name: true, defaultGstRate: true, isActive: true, applyOnSale: true },
      })
    : []
  const chargeTypeById = new Map(chargeTypes.map((c) => [c.id, c]))
  const charges = chargeInput.map((c, i) => {
    const type = chargeTypeById.get(c.chargeTypeId)
    if (!type) throw new AppError('One of the charges does not exist', 400, 'BAD_CHARGE')
    if (!type.isActive || !type.applyOnSale) {
      throw new AppError(`${type.name} is not a sales charge. Turn it on for sales under Masters → Charges.`, 400, 'BAD_CHARGE')
    }
    const amount = round2(c.amount)
    const gstRate = c.gstRate ?? Number(type.defaultGstRate)
    const tax = (amount * gstRate) / 100
    return {
      chargeTypeId: type.id,
      amount,
      gstRate,
      cgst: isIntraState ? round2(tax / 2) : 0,
      sgst: isIntraState ? round2(tax / 2) : 0,
      igst: isIntraState ? 0 : round2(tax),
      sortOrder: i,
    }
  })
  const chargeTotal = round2(charges.reduce((s, c) => s + c.amount, 0))
  cgst = round2(cgst + charges.reduce((s, c) => s + c.cgst, 0))
  sgst = round2(sgst + charges.reduce((s, c) => s + c.sgst, 0))
  igst = round2(igst + charges.reduce((s, c) => s + c.igst, 0))
  const otherCharges = round2(data.otherCharges ?? 0)

  const { rounded, roundOff } = applyRoundOff(taxableAmount + chargeTotal + cgst + sgst + igst + otherCharges)

  // Brokerage falls on the order value, not on the tax.
  const brokeragePercent = data.brokeragePercent ?? (await defaultBrokerage(tx, data.customerId, data.brokerId))
  const brokerageAmount = round2((taxableAmount * (brokeragePercent ?? 0)) / 100)

  const header = {
    customerId: data.customerId,
    brandId: data.brandId,
    deliveryDate: data.deliveryDate ?? null,
    customerPORef: data.customerPORef ?? null,
    customerPODate: data.customerPODate ?? null,
    deliveryAddress: data.deliveryAddress ?? null,
    billingAddress: data.billingAddress ?? null,
    reference: data.reference || null,
    salesperson: data.salesperson ?? null,
    brokerId: data.brokerId ?? null,
    brokeragePercent: brokeragePercent ?? null,
    brokerageAmount,
    placeOfSupplyCode,
    isJobWork: data.isJobWork ?? false,
    currency: data.currency ?? 'INR',
    notes: data.notes ?? null,
    terms: data.terms ?? null,
    otherCharges,
    subtotal,
    discountAmount,
    taxableAmount,
    cgst,
    sgst,
    igst,
    roundOff,
    totalAmount: rounded,
  }

  const lines: Prisma.SalesOrderLineCreateWithoutSoInput[] = data.lines.map((l, i) => {
    const item = itemById.get(l.itemId)!
    return {
      item: { connect: { id: l.itemId } },
      // Copied from the item when the screen does not send them, so the order
      // still reads right if the item is renamed later.
      styleCode: l.styleCode ?? item.style?.code ?? null,
      color: l.color ?? item.color ?? null,
      gender: l.gender ?? null,
      fabric: l.fabric || null,
      printName: l.printName || null,
      description: l.description || null,
      taxExempt: l.taxExempt ?? false,
      totalQty: l.totalQty,
      unitPrice: l.unitPrice,
      discount: l.discount ?? 0,
      gstRate: gstRates[i],
      hsnCode: item.hsnCode ?? null,
      amount: round2(lineTotals[i]),
      pendingQty: l.totalQty,
      sortOrder: i,
      sizes: l.sizes?.length
        ? { create: l.sizes.filter((s) => s.qty > 0).map((s) => ({ sizeId: s.sizeId, qty: s.qty })) }
        : undefined,
    }
  })

  return { header, lines, charges }
}

/** What a saved order is sent back with: enough for the form to reopen it. */
const savedOrderInclude = {
  customer: { select: { id: true, name: true, gstin: true } },
  brand: { select: { id: true, name: true } },
  broker: { select: { id: true, name: true } },
  lines: { include: { sizes: { include: { size: true } } }, orderBy: { sortOrder: 'asc' } },
  charges: { include: { chargeType: { select: { id: true, name: true } } }, orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.SalesOrderInclude

// POST /api/sales/orders
router.post('/orders', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createSalesOrderSchema.parse(req.body)

  const { order, confirmed } = await prisma.$transaction(async (tx) => {
    // Checked and priced first, so a refused order never takes a number.
    const { header, lines, charges } = await prepareOrder(tx, data)
    const soNumber = await nextDocumentNumber(tx, 'SO', data.orderDate ?? new Date())

    const created = await tx.salesOrder.create({
      data: {
        ...header,
        soNumber,
        orderDate: data.orderDate ?? new Date(),
        createdById: req.user!.id,
        lines: { create: lines },
        charges: { create: charges },
      },
    })
    // Saving and confirming are one act: a confirm refused for want of a
    // release reason takes the new order, and its number, back with it.
    const confirmed: ConfirmOutcome | null = data.confirm
      ? await confirmOrHold(tx, created.id, req.user!.id, confirmOptions(req, data.creditReleaseReason))
      : null
    const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: created.id }, include: savedOrderInclude })
    return { order, confirmed }
  })

  await writeAuditLog(req, {
    module: 'sales',
    action: 'CREATE',
    entityType: 'SalesOrder',
    entityId: order.id,
    after: order,
  })

  res.status(201).json({
    success: true,
    message: confirmed ? confirmMessage(order.soNumber, confirmed) : `${order.soNumber} saved as a draft`,
    data: order,
  })
})

/**
 * PATCH /api/sales/orders/:id
 *
 * Changes a draft — the whole order, header and lines, as the form sends it.
 * Only while it is a draft and not on credit hold: once confirmed it changes
 * only by amending, which keeps the old version.
 */
router.patch('/orders/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = createSalesOrderSchema.parse(req.body)

  const { before, after, confirmed } = await prisma.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({
      where: { id: req.params.id },
      include: savedOrderInclude,
    })
    if (!before) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
    if (before.status !== 'DRAFT') {
      throw new AppError(`${before.soNumber} is no longer a draft. Amend it instead.`, 409, 'NOT_DRAFT')
    }
    if (before.sentForApprovalAt) {
      throw new AppError(`${before.soNumber} is on credit hold, waiting for a manager, and cannot be changed now`, 409, 'ON_HOLD')
    }

    const { header, lines, charges } = await prepareOrder(tx, data)

    // The lines are replaced whole. A draft has nothing pointing at its lines
    // yet — no production, no challan — so nothing is cut loose.
    await tx.salesOrderLine.deleteMany({ where: { soId: before.id } })
    await tx.salesOrderCharge.deleteMany({ where: { soId: before.id } })
    await tx.salesOrder.update({
      where: { id: before.id },
      data: {
        ...header,
        orderDate: data.orderDate ?? before.orderDate,
        lines: { create: lines },
        charges: { create: charges },
      },
    })
    const confirmed: ConfirmOutcome | null = data.confirm
      ? await confirmOrHold(tx, before.id, req.user!.id, confirmOptions(req, data.creditReleaseReason))
      : null
    const after = await tx.salesOrder.findUniqueOrThrow({ where: { id: before.id }, include: savedOrderInclude })
    return { before, after, confirmed }
  })

  await writeAuditLog(req, {
    module: 'sales',
    action: 'UPDATE',
    entityType: 'SalesOrder',
    entityId: after.id,
    before,
    after,
  })

  res.json({
    success: true,
    message: confirmed ? confirmMessage(after.soNumber, confirmed) : `${after.soNumber} saved`,
    data: after,
  })
})

/** Who is confirming, for the credit-hold rule. */
function confirmOptions(req: AuthRequest, creditReleaseReason?: string | null) {
  return {
    admin: isAdmin(req.user),
    canApprove: userCan(req.user, MODULE, 'approve'),
    creditReleaseReason: creditReleaseReason ?? null,
  }
}

const confirmBody = z.object({
  creditReleaseReason: z
    .string()
    .trim()
    .min(5, 'Say why the credit hold is released, in a few words')
    .max(500)
    .optional()
    .nullable(),
})

/**
 * POST /api/sales/orders/:id/confirm
 *
 * A saved draft is confirmed: the customer is promised it. Within their credit
 * limit that is the whole of it. Over the limit or blacklisted it goes on
 * credit hold for a manager, unless the person confirming may release it and
 * gives a reason (see confirmOrHold).
 */
router.post('/orders/:id/confirm', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { creditReleaseReason } = confirmBody.parse(req.body ?? {})

  const { before, after, outcome } = await prisma.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({ where: { id: req.params.id } })
    if (!before) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
    const outcome = await confirmOrHold(tx, before.id, req.user!.id, confirmOptions(req, creditReleaseReason))
    const after = await tx.salesOrder.findUniqueOrThrow({ where: { id: before.id } })
    return { before, after, outcome }
  })

  await writeAuditLog(req, {
    module: 'sales',
    action: outcome.outcome === 'CONFIRMED' ? 'APPROVE' : 'UPDATE',
    entityType: 'SalesOrder',
    entityId: before.id,
    before,
    after,
  })
  res.json({ success: true, message: confirmMessage(before.soNumber, outcome), data: after })
})

/** Money is stored to two decimals; accumulating floats without rounding drifts. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Brokerage falls back to the rate on the broker, then to the rate agreed with
 * the customer, so nobody has to retype it on every order.
 */
async function defaultBrokerage(
  tx: Prisma.TransactionClient,
  customerId: string,
  brokerId?: string | null,
): Promise<number | null> {
  if (brokerId) {
    const broker = await tx.broker.findUnique({
      where: { id: brokerId },
      select: { brokeragePercent: true },
    })
    if (broker) return Number(broker.brokeragePercent)
  }

  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: { brokeragePercent: true },
  })
  return customer?.brokeragePercent != null ? Number(customer.brokeragePercent) : null
}

/**
 * POST /api/sales/orders/:id/amend
 *
 * Changes a confirmed order: quantities, sizes, rates, dates, the address.
 * What it said before is kept whole as a revision, and the order's version
 * goes up by one. The customer cannot change — that is a different order.
 *
 * Lines are matched by id rather than replaced, so a line stays the same line
 * from one version to the next. A line cannot go below what has already been
 * sent against it, nor be taken off once anything has.
 */
router.post('/orders/:id/amend', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = amendSalesOrderSchema.parse(req.body)

  const { before, after } = await prisma.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({
      where: { id: req.params.id },
      include: {
        ...savedOrderInclude,
        // Enough of each item for an earlier version to be read back on its
        // own, even after the item is renamed.
        lines: {
          include: {
            item: {
              select: { code: true, name: true, color: true, style: { select: { code: true, name: true } } },
            },
            sizes: { include: { size: true } },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    })
    if (!before) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
    if (before.status === 'DRAFT') {
      throw new AppError(`${before.soNumber} is still a draft: change it with Edit instead`, 409, 'IS_DRAFT')
    }
    if (!OPEN_ORDER_STATUSES.includes(before.status)) {
      throw new AppError(
        `${before.soNumber} is ${before.status.toLowerCase().replace(/_/g, ' ')}, so it can no longer be amended`,
        409,
        'NOT_OPEN',
      )
    }
    if (data.customerId !== before.customerId) {
      throw new AppError(
        'The customer cannot change on an amendment. Cancel this order and raise a new one for the other customer.',
        400,
        'CUSTOMER_CHANGED',
      )
    }

    const oldLines = new Map(before.lines.map((l) => [l.id, l]))
    const keptIds = new Set<string>()
    data.lines.forEach((l, i) => {
      if (!l.id) return
      const old = oldLines.get(l.id)
      if (!old) throw new AppError(`Line ${i + 1} is not on ${before.soNumber}`, 400, 'BAD_LINE')
      if (keptIds.has(l.id)) throw new AppError(`Line ${i + 1} appears twice`, 400, 'BAD_LINE')
      keptIds.add(l.id)
      const sent = Number(old.deliveredQty)
      if (l.totalQty < sent) {
        throw new AppError(
          `Line ${i + 1}: ${sent} pieces of ${old.item.code} have already been sent, so the quantity cannot go below that`,
          409,
          'BELOW_DELIVERED',
        )
      }
    })
    for (const old of before.lines) {
      if (!keptIds.has(old.id) && Number(old.deliveredQty) > 0) {
        throw new AppError(
          `${old.item.code} cannot come off the order: ${Number(old.deliveredQty)} pieces of it have already been sent`,
          409,
          'LINE_DELIVERED',
        )
      }
    }

    // Each size keeps what was already sent in it. A size cannot drop below
    // that, nor come off a line while any of it has gone.
    data.lines.forEach((l, i) => {
      if (!l.id) return
      const old = oldLines.get(l.id)!
      const wanted = new Map((l.sizes ?? []).map((s) => [s.sizeId, s.qty]))
      for (const os of old.sizes) {
        const sent = Number(os.deliveredQty)
        if (sent > 0 && (wanted.get(os.sizeId) ?? 0) < sent) {
          throw new AppError(
            `Line ${i + 1}: ${sent} pieces of ${old.item.code} in size ${os.size.code} have already been sent, so that size cannot go below ${sent}`,
            409,
            'BELOW_DELIVERED',
          )
        }
      }
    })

    // A line with a challan still standing against it, even a draft one,
    // cannot come off: the challan would be left pointing at nothing.
    const leaving = before.lines.filter((l) => !keptIds.has(l.id)).map((l) => l.id)
    if (leaving.length) {
      const onChallan = await tx.deliveryChallanLine.findFirst({
        where: { soLineId: { in: leaving }, dc: { status: { not: 'CANCELLED' } } },
        select: { dc: { select: { dcNumber: true } }, soLine: { select: { item: { select: { code: true } } } } },
      })
      if (onChallan) {
        throw new AppError(
          `${onChallan.soLine?.item.code ?? 'A line'} cannot come off the order: it is on challan ${onChallan.dc.dcNumber}. Cancel that challan first.`,
          409,
          'LINE_ON_CHALLAN',
        )
      }
    }

    const { header, lines, charges } = await prepareOrder(tx, data)

    // The order as it stood, whole, before this change. Plain JSON, so it
    // reads back the same however the tables change later.
    await tx.salesOrderRevision.create({
      data: {
        soId: before.id,
        version: before.version,
        snapshot: JSON.parse(JSON.stringify(before)) as Prisma.InputJsonValue,
        reason: data.reason,
        changedById: req.user!.id,
      },
    })

    // Lines taken off first, so the new ones are not caught by the sweep.
    await tx.salesOrderLine.deleteMany({ where: { soId: before.id, id: { notIn: [...keptIds] } } })
    for (let i = 0; i < data.lines.length; i++) {
      const input = data.lines[i]
      const line = lines[i]
      if (input.id) {
        const old = oldLines.get(input.id)!
        const sent = Number(old.deliveredQty)
        // The sizes are written afresh, carrying over what each had sent.
        const sentBySize = new Map(old.sizes.map((os) => [os.sizeId, Number(os.deliveredQty)]))
        const sizeRows = (input.sizes ?? [])
          .filter((sz) => sz.qty > 0)
          .map((sz) => ({ sizeId: sz.sizeId, qty: sz.qty, deliveredQty: sentBySize.get(sz.sizeId) ?? 0 }))
        await tx.salesOrderLineSize.deleteMany({ where: { lineId: input.id } })
        await tx.salesOrderLine.update({
          where: { id: input.id },
          data: {
            ...line,
            sizes: sizeRows.length ? { create: sizeRows } : undefined,
            pendingQty: Math.max(0, round2(input.totalQty - sent)),
          } as Prisma.SalesOrderLineUpdateInput,
        })
      } else {
        await tx.salesOrderLine.create({ data: { ...line, so: { connect: { id: before.id } } } })
      }
    }

    await tx.salesOrderCharge.deleteMany({ where: { soId: before.id } })
    const after = await tx.salesOrder.update({
      where: { id: before.id },
      data: {
        ...header,
        orderDate: data.orderDate ?? before.orderDate,
        version: before.version + 1,
        charges: { create: charges },
      },
      include: savedOrderInclude,
    })
    return { before, after }
  })

  await writeAuditLog(req, {
    module: 'sales',
    action: 'UPDATE',
    entityType: 'SalesOrder',
    entityId: after.id,
    before,
    after,
  })

  res.json({
    success: true,
    message: `${after.soNumber} amended — now version ${after.version}. Version ${before.version} is kept in its history.`,
    data: after,
  })
})

/**
 * GET /api/sales/orders/:id/revisions/:version
 *
 * One earlier version of an order, whole, as it stood before it was amended.
 */
router.get('/orders/:id/revisions/:version', requirePermission(MODULE, 'view'), async (req, res) => {
  const revision = await prisma.salesOrderRevision.findUnique({
    where: { soId_version: { soId: req.params.id, version: Number(req.params.version) || 0 } },
    include: { changedBy: { select: { id: true, name: true } } },
  })
  if (!revision) throw new AppError('That version of the order was not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: revision })
})

/**
 * POST /api/sales/orders/:id/cancel
 *
 * Calls an order off before anything has been made or sent against it. After
 * that the way out is short-closing. A draft is cancelled by whoever can edit
 * orders; a confirmed one, which the customer has been promised, only by
 * someone who can approve them.
 */
router.post('/orders/:id/cancel', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonBody.parse(req.body)

  const before = await prisma.salesOrder.findUnique({
    where: { id: req.params.id },
    include: {
      manufacturingOrders: { select: { moNumber: true } },
      deliveryChallans: { where: { status: { not: 'CANCELLED' } }, select: { dcNumber: true } },
      invoices: { where: { status: { not: 'CANCELLED' } }, select: { invoiceNumber: true } },
      materialRequisitions: {
        where: { closedAt: null, status: { in: ['PENDING', 'APPROVED'] } },
        select: { mrNumber: true },
      },
    },
  })
  if (!before) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  if (before.status !== 'DRAFT' && before.status !== 'CONFIRMED') {
    throw new AppError(
      before.status === 'CANCELLED'
        ? `${before.soNumber} is already cancelled`
        : before.status === 'COMPLETED'
          ? `${before.soNumber} is completed and cannot be cancelled. A return goes through a credit note.`
          : `Work has started on ${before.soNumber}. Short-close it instead, at what has been sent.`,
      409,
      'CANNOT_CANCEL',
    )
  }
  if (before.status === 'CONFIRMED' && !userCan(req.user, MODULE, 'approve')) {
    throw new AppError(
      `${before.soNumber} has been confirmed to the customer, so only someone who approves orders can cancel it`,
      403,
      'FORBIDDEN',
    )
  }
  const started = [
    ...before.manufacturingOrders.map((m) => m.moNumber),
    ...before.deliveryChallans.map((d) => d.dcNumber),
    ...before.invoices.map((i) => i.invoiceNumber),
  ]
  if (started.length) {
    throw new AppError(
      `${before.soNumber} already has ${started.join(', ')} against it. Short-close it instead.`,
      409,
      'CANNOT_CANCEL',
    )
  }
  if (before.materialRequisitions.length) {
    throw new AppError(
      `Requisition ${before.materialRequisitions.map((m) => m.mrNumber).join(', ')} is still open for ${before.soNumber}. Close or reject it in Inventory first, so no material is held for an order that is not coming.`,
      409,
      'OPEN_REQUISITION',
    )
  }

  const after = await prisma.salesOrder.update({
    where: { id: before.id },
    data: { status: 'CANCELLED', cancelledById: req.user!.id, cancelledAt: new Date(), cancelReason: reason },
  })
  await writeAuditLog(req, {
    module: 'sales',
    action: 'UPDATE',
    entityType: 'SalesOrder',
    entityId: before.id,
    before,
    after,
  })
  res.json({ success: true, message: `${before.soNumber} cancelled`, data: after })
})

/**
 * POST /api/sales/orders/:id/short-close
 *
 * Ends an order at what has been made and sent, the rest no longer wanted —
 * the buyer called off the balance, or production came out a few short.
 * Every line's pending pieces go to nothing; what was sent stays. Only for an
 * order something has happened to: one with nothing made or sent is
 * cancelled instead.
 */
router.post('/orders/:id/short-close', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const { reason } = reasonBody.parse(req.body)

  const { before, after } = await prisma.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({
      where: { id: req.params.id },
      include: {
        lines: { select: { deliveredQty: true } },
        _count: {
          select: {
            manufacturingOrders: true,
            deliveryChallans: { where: { status: { not: 'CANCELLED' } } },
          },
        },
      },
    })
    if (!before) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
    if (!OPEN_ORDER_STATUSES.includes(before.status)) {
      throw new AppError(
        before.status === 'DRAFT'
          ? `${before.soNumber} is still a draft. Cancel it instead.`
          : `${before.soNumber} is ${before.status.toLowerCase()} already`,
        409,
        'CANNOT_SHORT_CLOSE',
      )
    }
    const anythingDone =
      before._count.manufacturingOrders > 0 ||
      before._count.deliveryChallans > 0 ||
      before.lines.some((l) => Number(l.deliveredQty) > 0)
    if (!anythingDone) {
      throw new AppError(
        `Nothing has been made or sent against ${before.soNumber} yet. Cancel it instead.`,
        409,
        'NOTHING_STARTED',
      )
    }

    await tx.salesOrderLine.updateMany({ where: { soId: before.id }, data: { pendingQty: 0 } })
    const after = await tx.salesOrder.update({
      where: { id: before.id },
      data: {
        status: 'COMPLETED',
        shortClosedById: req.user!.id,
        shortClosedAt: new Date(),
        shortCloseReason: reason,
      },
    })
    return { before, after }
  })

  await writeAuditLog(req, {
    module: 'sales',
    action: 'UPDATE',
    entityType: 'SalesOrder',
    entityId: before.id,
    before,
    after,
  })
  res.json({ success: true, message: `${before.soNumber} short-closed at what was sent`, data: after })
})

// Approving and rejecting a sales order is done through /api/approvals, which
// holds the rules (draft only, not by whoever raised it, credit hold).

// ── Files kept against an order ─────────────────────────────────────────────
//
// The buyer's PO, a sketch, a spec sheet. The same three steps as a purchase
// order's files: ask for a link, send the file straight to storage, then say
// it landed so the row is written. The bytes never pass through here.

const orderFileInclude = { uploadedBy: { select: { id: true, name: true } } }

router.get('/orders/:id/attachments', requirePermission(MODULE, 'view'), async (req, res) => {
  const rows = await prisma.salesOrderAttachment.findMany({
    where: { soId: req.params.id },
    include: orderFileInclude,
    orderBy: { createdAt: 'asc' },
  })
  res.json({ success: true, data: rows })
})

/** Step one: a one-use link to send the file to. Nothing is recorded yet. */
router.post('/orders/:id/attachments/upload-url', requirePermission(MODULE, 'edit'), async (req, res) => {
  const { fileName } = z
    .object({
      fileName: z.string().min(1, 'The file needs a name').max(255),
      sizeBytes: z
        .number()
        .int()
        .positive('That file is empty')
        .max(MAX_FILE_BYTES, `Files have to be ${MAX_FILE_BYTES / 1024 / 1024}MB or smaller`),
    })
    .parse(req.body)

  const so = await prisma.salesOrder.findUnique({ where: { id: req.params.id }, select: { id: true, soNumber: true } })
  if (!so) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  const already = await prisma.salesOrderAttachment.count({ where: { soId: so.id } })
  if (already >= MAX_FILES_PER_DOCUMENT) {
    throw new AppError(`${so.soNumber} already has ${MAX_FILES_PER_DOCUMENT} files. Remove one before adding another.`, 409, 'TOO_MANY_FILES')
  }

  const path = storagePathFor('sales-orders', so.id, fileName)
  const { uploadUrl } = await signedUploadUrl(path)
  res.json({ success: true, data: { uploadUrl, storagePath: path, fileName } })
})

/** Step three: the file is in storage, so record it. */
router.post('/orders/:id/attachments', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { fileName, storagePath } = z
    .object({ fileName: z.string().min(1).max(255), storagePath: z.string().min(1) })
    .parse(req.body)

  const so = await prisma.salesOrder.findUnique({ where: { id: req.params.id }, select: { id: true } })
  if (!so) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  // A path is handed out for one order only; this stops it being replayed on another.
  if (!storagePath.startsWith(`sales-orders/${so.id}/`)) {
    throw new AppError('That file does not belong to this order', 400, 'WRONG_DOCUMENT')
  }

  // The size as storage has it, not as the browser said.
  const { sizeBytes, mimeType } = await statObject(storagePath)
  if (sizeBytes > MAX_FILE_BYTES) {
    await removeObject(storagePath).catch(() => {})
    throw new AppError(
      `That file is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024}MB.`,
      400,
      'FILE_TOO_LARGE',
    )
  }

  const file = await prisma.salesOrderAttachment.create({
    data: { soId: so.id, fileName, storagePath, mimeType, sizeBytes, uploadedById: req.user!.id },
    include: orderFileInclude,
  })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'SalesOrderAttachment', entityId: file.id, after: file })
  res.status(201).json({ success: true, data: file })
})

/** A link that works for a few minutes. The bucket itself stays private. */
router.get('/order-attachments/:id/link', requirePermission(MODULE, 'view'), async (req, res) => {
  const file = await prisma.salesOrderAttachment.findUnique({ where: { id: req.params.id } })
  if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')
  res.json({ success: true, data: { url: await signedDownloadUrl(file.storagePath), fileName: file.fileName } })
})

router.delete('/order-attachments/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const file = await prisma.salesOrderAttachment.findUnique({ where: { id: req.params.id }, include: orderFileInclude })
  if (!file) throw new AppError('That file is no longer here', 404, 'NOT_FOUND')
  // The row first: a row pointing at a missing file is a broken download; a
  // file with no row merely wastes space.
  await prisma.salesOrderAttachment.delete({ where: { id: file.id } })
  await removeObject(file.storagePath).catch(() => {})
  await writeAuditLog(req, { module: MODULE, action: 'DELETE', entityType: 'SalesOrderAttachment', entityId: file.id, before: file })
  res.json({ success: true, message: `${file.fileName} removed.` })
})

// GET /api/sales/invoices
router.get('/invoices', requirePermission(MODULE, 'view'), async (req, res) => {
  const invoices = await prisma.salesInvoice.findMany({
    include: { customer: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  res.json({ success: true, data: invoices })
})

// GET /api/sales/outstanding — read by Sales and by Accounts, who chase it.
router.get('/outstanding', async (req: AuthRequest, res) => {
  if (!userCan(req.user, MODULE, 'view') && !userCan(req.user, 'accounts', 'view')) {
    throw new AppError('You do not have permission to view what customers owe', 403, 'FORBIDDEN')
  }
  const invoices = await prisma.salesInvoice.findMany({
    where: { status: { in: ['UNPAID', 'PARTIAL'] } },
    include: { customer: { select: { name: true, phone: true } } },
    orderBy: { dueDate: 'asc' },
  })
  res.json({ success: true, data: invoices })
})

export default router
