import type { ChargeResolveOptions } from '../services/chargeConfiguration'
import { Router } from 'express'
import type { Prisma, SalesOrderStatus } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AuthRequest, isAdmin, requirePermission, userCan } from '../middleware/auth'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { postWithin } from '../services/accounts/posting.service'
import { nextDocumentNumber, resolvePlaceOfSupply } from '../lib/docNumber'
import { findHsn, gstRateFor, loadHsnIndex } from '../lib/hsn'
import { closeCheck, orderReconciliation } from '../services/reconciliation.service'
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
  creditForAmendment,
  creditPosition,
  type ConfirmOutcome,
} from '../services/salesOrder.service'
import { priceSale, type SaleLineInput } from '@ld-erp/shared'
import { chargeRows, resolveSaleCharges, saleChargeSchema } from '../services/salesCharges'
import { winQuote } from '../services/quotation.service'
import { workStarted } from '../services/manufacturing.service'
import { closeMo } from './production.routes'
import { assertNotCancelling, CANCELLABLE, cancellationImpact, requestCancellation, withdrawCancellation } from '../services/orderCancel.service'

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

/** Job work is billed as a service: SAC 9988, at 5% unless the HSN master says otherwise. */
export const JOB_WORK_SAC = '9988'
export const JOB_WORK_DEFAULT_GST = 5

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
  /**
   * On a job-work order: the SAC/HSN the job charge is billed under and its
   * GST rate. Job work is a service, so the garment's own HSN does not apply;
   * empty means SAC 9988, at the HSN master's rate for it (5% if it has none).
   */
  jobHsnCode: z.string().trim().max(20).optional().nullable(),
  jobGstRate: z.number().min(0).max(28).optional().nullable(),
  /** What a B-grade piece is billed at; empty bills it at the line's rate. */
  bGradeRate: z.number().min(0).optional().nullable(),
  /** The size run for this line. Quantities must add up to the line total. */
  sizes: z
    .array(z.object({ sizeId: z.string().min(1), qty: z.number().min(0) }))
    .optional(),
})

/** The order as the form sends it, before the checks that span its lines. */
const salesOrderBaseSchema = z.object({
  customerId: z.string().min(1, 'Pick a customer'),
  /** Not asked on the form: worked out from the garments' styles when left out (brandOf). */
  brandId: z.string().min(1).optional().nullable(),
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
  /**
   * A job-work order: our own material used on it (trims, thread) is covered
   * by the job charge, or billed to the customer separately, as agreed.
   */
  ownMaterialBilling: z.enum(['IN_JOB_CHARGE', 'BILLED']).optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().max(1000).optional().nullable(),
  terms: z.string().max(2000).optional().nullable(),
  /**
   * Transport, freight, packing: picked from Masters → Charges, each with GST
   * included in the figure, added on top, or none, as its row says.
   */
  charges: z.array(saleChargeSchema).max(20).optional(),
  /** Added after tax and carrying none of its own. */
  otherCharges: z.number().min(0).optional(),
  /** The quotation this order was won from: it is marked won when the order is saved. */
  quotationId: z.string().optional().nullable(),
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
  /**
   * A job-work order whose customer material is not all accounted for: why it
   * may close anyway. A manager's exception, kept with the order.
   */
  materialException: z.string().trim().min(10, 'Say why the order can close with this material unaccounted for — a sentence').max(1000).optional(),
})

/**
 * A job-work order's customer material must all be accounted for before the
 * order is closed or cancelled: used, wasted, sent back or used at a job
 * worker. Otherwise it closes only on an exception — a manager who approves
 * both orders and stock, with a reason — and what was not accounted for is
 * kept with the order as it stood then. Returns what to write on the order.
 */
async function materialClosure(
  tx: Prisma.TransactionClient,
  req: AuthRequest,
  so: { id: string; soNumber: string; isJobWork: boolean },
  act: 'short-closed' | 'cancelled',
  exception: string | undefined,
) {
  if (!so.isJobWork) return {}
  const { gaps } = await closeCheck(tx, so.id)
  if (!gaps.length) return {}
  if (!exception) {
    throw new AppError(
      `${so.soNumber} cannot be ${act}: the customer's material is not all accounted for. ${gaps.map((g) => g.text).join('; ')}. Put it right first, or a manager can let it close with a reason.`,
      409,
      'MATERIAL_UNACCOUNTED',
    )
  }
  if (!(userCan(req.user, MODULE, 'approve') && userCan(req.user, 'inventory', 'approve'))) {
    throw new AppError(`Only a manager who approves both orders and stock can let ${so.soNumber} close with the customer's material not accounted for.`, 403, 'NEEDS_MANAGER')
  }
  return {
    materialExceptionById: req.user!.id,
    materialExceptionAt: new Date(),
    materialExceptionReason: exception,
    materialExceptionSnapshot: { act, gaps } as unknown as Prisma.InputJsonValue,
  }
}

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

  // Work started on one of their manufacturing orders (material issued, cut,
  // packed): such an order is short-closed, never cancelled.
  const mos = orders.length
    ? await prisma.manufacturingOrder.findMany({ where: { soId: { in: orders.map((o) => o.id) }, status: { not: 'CLOSED' } }, select: { id: true, soId: true } })
    : []
  const started = await workStarted(prisma, mos.map((m) => m.id))
  const startedFor = new Set(mos.filter((m) => started.has(m.id)).map((m) => m.soId))

  // Pieces, not lines, are what the list reads: how many were ordered, how
  // many have gone, and how many are still to go.
  const data = orders.map(({ lines, ...o }) => ({
    ...o,
    pieces: lines.reduce((s, l) => s + Number(l.totalQty), 0),
    dispatched: lines.reduce((s, l) => s + Number(l.deliveredQty), 0),
    pending: lines.reduce((s, l) => s + Number(l.pendingQty), 0),
    workStarted: startedFor.has(o.id),
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
      cancelRequestedBy: { select: { id: true, name: true } },
      materialExceptionBy: { select: { id: true, name: true } },
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
      // The customer's own material received against it, for job work.
      customerMaterial: { select: { id: true, grnNumber: true, status: true, receiptDate: true }, orderBy: { receiptDate: 'asc' } },
    },
  })
  if (!order) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  // What has been done on each manufacturing order (material issued, cut, packed); null for one nothing was made on.
  const started = await workStarted(prisma, order.manufacturingOrders.map((m) => m.id))
  res.json({
    success: true,
    data: { ...order, manufacturingOrders: order.manufacturingOrders.map((m) => ({ ...m, workStarted: started.get(m.id) ?? null })) },
  })
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
 * The brand an order is booked under, which the form no longer asks for.
 *
 * VHAGAR is a brand of LD Cotton Mills, not a company of its own, so every
 * sale is LD Cotton's; the brand only says whose label the garments carry,
 * for the dashboard and the reports. That is in the styles: an order whose
 * every garment is a VHAGAR style is a VHAGAR order, anything else (a mix,
 * a customer's own label, a garment with no style, job work) the mill's own.
 */
async function brandOf(
  tx: Prisma.TransactionClient,
  data: OrderInput,
  itemById: Map<string, { style: { brandType: string } | null }>,
): Promise<string> {
  const brands = await tx.brand.findMany({ where: { isActive: true }, select: { id: true, type: true }, orderBy: { createdAt: 'asc' } })
  const own = brands.find((b) => b.type === 'LD_COTTON_MILLS') ?? brands[0]
  if (!own) throw new AppError('No brand is set up. Add LD Cotton Mills in Masters → Brands.', 400, 'NO_BRAND')
  const vhagar = brands.find((b) => b.type === 'VHAGAR')
  if (!vhagar || data.isJobWork) return own.id
  // A style number typed on the line is the garment's style when the master
  // has it; else the item's own.
  const typed = [...new Set(data.lines.map((l) => l.styleCode?.trim()).filter((c): c is string => Boolean(c)))]
  const styles = typed.length
    ? await tx.style.findMany({ where: { OR: typed.map((code) => ({ code: { equals: code, mode: 'insensitive' as const } })) }, select: { code: true, brandType: true } })
    : []
  const typedType = new Map(styles.map((s) => [s.code.toLowerCase(), s.brandType as string]))
  const allVhagar = data.lines.every((l) => {
    const code = l.styleCode?.trim()
    return ((code && typedType.get(code.toLowerCase())) || itemById.get(l.itemId)?.style?.brandType) === 'VHAGAR'
  })
  return allVhagar ? vhagar.id : own.id
}

/**
 * Checks an order and prices it.
 *
 * The one road both a new order and an edited draft go down, so the two can
 * never be priced two ways. Returns the header's fields and the lines ready
 * to create; the number is the caller's business.
 */
export async function prepareOrder(
  tx: Prisma.TransactionClient,
  data: OrderInput,
  /** A quotation is priced by the piece; an order is split into sizes. */
  opts: ChargeResolveOptions & { piecesOnly?: boolean } = {},
) {
  const customer = await tx.customer.findUnique({ where: { id: data.customerId }, select: { name: true, isActive: true } })
  if (!customer) throw new AppError('That customer does not exist', 400, 'BAD_CUSTOMER')
  // A blacklisted customer can still have a draft: the approver decides.
  if (!customer.isActive) {
    throw new AppError(`${customer.name} is switched off. Reactivate them in Masters to order for them.`, 400, 'INACTIVE')
  }
  // An order cannot be shipped before it is placed.
  const dayOf = (d: Date) => d.toISOString().slice(0, 10)
  if (data.deliveryDate && dayOf(data.deliveryDate) < dayOf(data.orderDate ?? new Date())) {
    throw new AppError('The shipment / delivery date is before the order date.', 400, 'BAD_DATE')
  }

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
      style: { select: { code: true, sizeGroupId: true, brandType: true } },
    },
  })
  const itemById = new Map(items.map((i) => [i.id, i]))

  const brandId = data.brandId || (await brandOf(tx, data, itemById))
  const brand = await tx.brand.findUnique({ where: { id: brandId }, select: { name: true, isActive: true } })
  if (!brand) throw new AppError('That brand does not exist', 400, 'BAD_BRAND')
  if (!brand.isActive) throw new AppError(`The brand ${brand.name} is switched off`, 400, 'INACTIVE')

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
    // A garment made in sizes is ordered in sizes: the size-wise figures are
    // what cutting, stock and dispatch all work from.
    if (!opts.piecesOnly && item.style?.sizeGroupId && !(l.sizes ?? []).some((s) => s.qty > 0)) {
      throw new AppError(`Line ${i + 1}: ${item.code} is made in sizes. Enter its pieces size by size.`, 400, 'NEEDS_SIZES')
    }
  })

  const { placeOfSupplyCode, isIntraState } = await resolvePlaceOfSupply(tx, data.customerId, data.placeOfSupplyCode)

  // Each line's GST rate. A garment's comes from its HSN code, read at the
  // price each piece is actually sold for (ready-made garments change rate
  // above a price per piece), which the pricing works out once the discounts
  // are known. An item whose code is not in the HSN master keeps its own rate.
  const hsnIndex = await loadHsnIndex(tx)
  // A job charge is a service: its own SAC and rate, not the garment's.
  const jobCode = (l: (typeof data.lines)[number]) => l.jobHsnCode?.trim() || JOB_WORK_SAC
  const rateOf = (l: (typeof data.lines)[number]): Pick<SaleLineInput, 'rate' | 'band'> => {
    if (l.taxExempt) return { rate: 0 }
    if (data.isJobWork) {
      if (l.jobGstRate != null) return { rate: l.jobGstRate }
      const sac = findHsn(hsnIndex, jobCode(l))
      return { rate: sac ? gstRateFor(sac) : JOB_WORK_DEFAULT_GST }
    }
    const item = itemById.get(l.itemId)!
    const hsn = findHsn(hsnIndex, item.hsnCode)
    if (hsn) {
      return { band: { gstRate: Number(hsn.gstRate), priceLimit: hsn.priceLimit != null ? Number(hsn.priceLimit) : null, rateAbove: hsn.rateAbove != null ? Number(hsn.rateAbove) : null } }
    }
    if (item.taxRate) return { rate: Number(item.taxRate.rate) }
    throw new AppError(`${item.code} has no HSN code or GST rate. Set one on the item before ordering it.`, 400, 'NO_GST_RATE')
  }

  // Brokerage falls on the order value, not on the tax.
  const brokeragePercent = data.brokeragePercent ?? (await defaultBrokerage(tx, data.customerId, data.brokerId))

  // Priced by the one sales engine the quotation and order forms run too:
  // line discounts first, then the discount on the whole bill spread across
  // the lines by value (LD prices at invoice level, so taxing before it would
  // overstate the GST); each line's GST at its rate; each charge as its row
  // says (GST included, added on top, or none); the other charges; rounded.
  const quoteCharges = !opts.saved && data.quotationId
    ? await tx.salesQuotationCharge.findMany({ where: { quoteId: data.quotationId }, include: { chargeType: { select: { name: true } } } }) : undefined
  const resolvedCharges = await resolveSaleCharges(tx, data.charges, { ...opts, saved: opts.saved ?? quoteCharges })
  const priced = priceSale({
    lines: data.lines.map((l) => ({ qty: l.totalQty, price: l.unitPrice, discountPct: l.discount ?? 0, ...rateOf(l) })),
    orderDiscount: data.discountAmount ?? 0,
    charges: resolvedCharges,
    otherCharges: data.otherCharges ?? 0,
    intra: isIntraState,
    brokeragePct: brokeragePercent ?? 0,
  })
  const charges = chargeRows(resolvedCharges, priced.charges)
  const { subtotal, goodsTaxable: taxableAmount, cgst, sgst, igst, roundOff, otherCharges } = priced
  const discountAmount = priced.discount
  const rounded = priced.total
  const brokerageAmount = priced.brokerage

  const header = {
    customerId: data.customerId,
    brandId,
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
    // Only a job-work order uses our material on someone else's goods.
    ownMaterialBilling: data.isJobWork ? (data.ownMaterialBilling ?? 'IN_JOB_CHARGE') : 'IN_JOB_CHARGE',
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
      gstRate: priced.lines[i].gstRate ?? 0,
      hsnCode: data.isJobWork ? jobCode(l) : (item.hsnCode ?? null),
      bGradeRate: l.bGradeRate ?? null,
      amount: priced.lines[i].amount,
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

/**
 * GET /api/sales/orders/:id/reconciliation
 *
 * The customer's fabric on the order — received, issued, cut, returned,
 * counted, held — and its pieces — cut, packed good and B-grade, damaged at
 * job workers, sent — so the order is closed with everything accounted for.
 */
router.get('/orders/:id/reconciliation', requirePermission(MODULE, 'view'), async (req, res) => {
  res.json({ success: true, data: await prisma.$transaction((tx) => orderReconciliation(tx, req.params.id)) })
})

/**
 * GET /api/sales/orders/:id/close-check
 *
 * Before closing or cancelling: what of the customer's material stops it, any
 * notes that do not, and whether this user may record an exception.
 */
router.get('/orders/:id/close-check', requirePermission(MODULE, 'view'), async (req: AuthRequest, res) => {
  const check = await prisma.$transaction((tx) => closeCheck(tx, req.params.id))
  res.json({ success: true, data: { ...check, mayException: userCan(req.user, MODULE, 'approve') && userCan(req.user, 'inventory', 'approve') } })
})

// POST /api/sales/orders
router.post('/orders', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createSalesOrderSchema.parse(req.body)

  const { order, confirmed } = await prisma.$transaction(async (tx) => {
    // Checked and priced first, so a refused order never takes a number.
    const { header, lines, charges } = await prepareOrder(tx, data, { canOverride: userCan(req.user, 'masters', 'edit') })
    if (data.quotationId) await winQuote(tx, data.quotationId, data.customerId)
    const soNumber = await nextDocumentNumber(tx, 'SO', data.orderDate ?? new Date())

    const created = await tx.salesOrder.create({
      data: {
        ...header,
        quotationId: data.quotationId || null,
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

    // A form that leaves it out keeps how the order bills our own material.
    data.ownMaterialBilling = data.ownMaterialBilling ?? (before.ownMaterialBilling as 'IN_JOB_CHARGE' | 'BILLED')
    const { header, lines, charges } = await prepareOrder(tx, data, { saved: before.charges, canOverride: userCan(req.user, 'masters', 'edit') })

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
    await assertNotCancelling(tx, req.params.id, 'the order is not changed')
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
    // Own order or job work stays what it was once anything has been built on
    // it: the customer's fabric received, production planned, goods sent.
    // A form that leaves the flag out keeps the order's own.
    data.isJobWork = data.isJobWork ?? before.isJobWork
    data.ownMaterialBilling = data.ownMaterialBilling ?? (before.ownMaterialBilling as 'IN_JOB_CHARGE' | 'BILLED')
    if (data.isJobWork !== before.isJobWork) {
      const [grns, mos, dcs] = await Promise.all([
        tx.customerGRN.count({ where: { soId: before.id, cancelledAt: null } }),
        tx.manufacturingOrder.count({ where: { soId: before.id, status: { not: 'CLOSED' } } }),
        tx.deliveryChallan.count({ where: { soId: before.id, status: { not: 'CANCELLED' } } }),
      ])
      if (grns + mos + dcs > 0) {
        throw new AppError(
          `${before.soNumber} already has ${[grns && "the customer's material received", mos && 'production planned', dcs && 'goods sent'].filter(Boolean).join(', ')}, so it cannot change between own order and job work.`,
          409,
          'JOB_WORK_LOCKED',
        )
      }
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

    // Each size keeps what was already sent in it: a size cannot be lowered
    // below that, nor come off a line while any of it has gone. Dispatch may
    // send a size over its order within the line's total (sizes made as other
    // sizes at stitching), so a size left as it was stands even then.
    data.lines.forEach((l, i) => {
      if (!l.id) return
      const old = oldLines.get(l.id)!
      const wanted = new Map((l.sizes ?? []).map((s) => [s.sizeId, s.qty]))
      for (const os of old.sizes) {
        const sent = Number(os.deliveredQty)
        const want = wanted.get(os.sizeId) ?? 0
        if (sent > 0 && want < sent && want < Number(os.qty)) {
          const floor = Math.min(sent, Number(os.qty))
          throw new AppError(
            `Line ${i + 1}: ${sent} pieces of ${old.item.code} in size ${os.size.code} have already been sent, so that size cannot go below ${floor}`,
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

    const { header, lines, charges } = await prepareOrder(tx, data, { saved: before.charges, canOverride: userCan(req.user, 'masters', 'edit') })

    // A change that raises the order's value meets the credit limit, as confirming it did.
    const release = await creditForAmendment(
      tx,
      before,
      Number(header.totalAmount),
      req.user!.id,
      confirmOptions(req, data.creditReleaseReason),
    )

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
        ...release,
        orderDate: data.orderDate ?? before.orderDate,
        version: before.version + 1,
        charges: { create: charges },
      },
      include: savedOrderInclude,
    })
    // The order's brand is where its invoices' sales are booked; a new brand
    // moves them, and their credit notes, to the new brand's profit.
    if (after.brandId !== before.brandId) {
      const invoices = await tx.salesInvoice.findMany({ where: { soId: before.id }, select: { id: true, creditNotes: { select: { id: true } } } })
      for (const inv of invoices) {
        await postWithin(tx, 'SALES_INVOICE', inv.id, req.user!.id)
        for (const cn of inv.creditNotes) await postWithin(tx, 'CREDIT_NOTE', cn.id, req.user!.id)
      }
    }
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
 * Calls an order off before anything has been asked for, made or sent against
 * it: no manufacturing order, no requisition in use, no challan, no invoice. A
 * draft is cancelled by whoever can edit orders; a confirmed one, which the
 * customer has been promised, only by someone who can approve them.
 *
 * With any of those, the order is called off by asking for its cancellation
 * (below): its manufacturing orders go on hold, all it touches is laid out,
 * and an approver decides.
 */
router.post('/orders/:id/cancel', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason, materialException } = reasonBody.parse(req.body)

  const before = await prisma.salesOrder.findUnique({
    where: { id: req.params.id },
    include: {
      // A closed manufacturing order made nothing, and stands in nobody's way.
      manufacturingOrders: { where: { status: { not: 'CLOSED' } }, select: { moNumber: true } },
      deliveryChallans: { where: { status: { not: 'CANCELLED' } }, select: { dcNumber: true } },
      invoices: { where: { status: { not: 'CANCELLED' } }, select: { invoiceNumber: true } },
      // Requisitions still asking, or with something issued on them.
      materialRequisitions: {
        where: { status: { not: 'REJECTED' }, OR: [{ closedAt: null }, { lines: { some: { issuedQty: { gt: 0 } } } }] },
        select: { mrNumber: true },
      },
    },
  })
  if (!before) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  if (before.cancelRequestedAt && CANCELLABLE.includes(before.status)) {
    throw new AppError(`A cancellation of ${before.soNumber} is already waiting: approve or withdraw it in its cancellation window.`, 409, 'CANCEL_REQUESTED')
  }
  if (before.status !== 'DRAFT' && before.status !== 'CONFIRMED' && before.status !== 'IN_PRODUCTION') {
    throw new AppError(
      before.status === 'CANCELLED'
        ? `${before.soNumber} is already cancelled`
        : before.status === 'COMPLETED'
          ? `${before.soNumber} is completed and cannot be cancelled. A return goes through a credit note.`
          : `Goods have gone out against ${before.soNumber}. Ask for its cancellation instead: once approved it is short-closed at what was sent.`,
      409,
      before.status === 'CANCELLED' || before.status === 'COMPLETED' ? 'CANNOT_CANCEL' : 'NEEDS_REQUEST',
    )
  }
  if (before.status !== 'DRAFT' && !userCan(req.user, MODULE, 'approve')) {
    throw new AppError(
      `${before.soNumber} has been confirmed to the customer, so only someone who approves orders can cancel it`,
      403,
      'FORBIDDEN',
    )
  }
  const inUse = [
    ...before.manufacturingOrders.map((m) => m.moNumber),
    ...before.materialRequisitions.map((m) => m.mrNumber),
    ...before.deliveryChallans.map((d) => d.dcNumber),
    ...before.invoices.map((i) => i.invoiceNumber),
  ]
  if (inUse.length) {
    throw new AppError(
      `${before.soNumber} already has ${inUse.join(', ')} against it. Ask for its cancellation instead: its manufacturing orders go on hold, and an approver sees all it touches before it is cancelled.`,
      409,
      'NEEDS_REQUEST',
    )
  }

  // The customer's material received for it is sent back, or the cancel is a manager's exception.
  const exception = await prisma.$transaction((tx) => materialClosure(tx, req, before, 'cancelled', materialException))
  const after = await prisma.salesOrder.update({
    where: { id: before.id },
    data: { status: 'CANCELLED', cancelledById: req.user!.id, cancelledAt: new Date(), cancelReason: reason, ...exception },
  })
  await writeAuditLog(req, {
    module: 'sales',
    action: 'UPDATE',
    entityType: 'SalesOrder',
    entityId: before.id,
    before,
    after,
  })
  if (exception.materialExceptionReason) {
    await writeAuditLog(req, { module: 'sales', action: 'APPROVE', entityType: 'SalesOrderMaterialException', entityId: before.id, after: { soNumber: before.soNumber, act: 'cancelled', reason: exception.materialExceptionReason, unaccounted: exception.materialExceptionSnapshot } })
  }
  res.json({ success: true, message: `${before.soNumber} cancelled${exception.materialExceptionReason ? ', with the material exception recorded' : ''}`, data: after })
})

/**
 * GET /api/sales/orders/:id/cancellation
 *
 * What cancelling the order touches, as it stands: its manufacturing orders
 * and their pieces, material issued, used and still out, its requisitions,
 * purchase raised for them, finished goods, a job-work customer's material;
 * what approving does, and what to see to first.
 */
router.get('/orders/:id/cancellation', requirePermission(MODULE, 'view'), async (req, res) => {
  res.json({ success: true, data: await cancellationImpact(prisma, req.params.id) })
})

/**
 * POST /api/sales/orders/:id/cancellation/request
 *
 * The customer is calling the order off, at whatever stage it is. Its
 * manufacturing orders go on hold: nothing more is issued, cut, moved, packed
 * or sent for it, and the order is not changed, until someone who approves
 * orders approves the cancellation or it is withdrawn.
 */
router.post('/orders/:id/cancellation/request', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonBody.pick({ reason: true }).parse(req.body)
  const { before, after, held } = await prisma.$transaction((tx) => requestCancellation(tx, req.params.id, reason, req.user!.id), { timeout: 30_000 })
  await writeAuditLog(req, { module: 'sales', action: 'UPDATE', entityType: 'SalesOrder', entityId: after.id, before, after })
  for (const mo of held) {
    await writeAuditLog(req, { module: 'production', action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: mo.id, after: { heldAt: new Date(), holdReason: mo.reason } })
  }
  const names = held.map((m) => m.moNumber)
  res.json({
    success: true,
    message: `Cancellation of ${after.soNumber} asked for${names.length ? `; ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} on hold` : ''}. Nothing more is issued, moved, packed or sent for it until it is approved or withdrawn.`,
    data: after,
  })
})

/** POST /api/sales/orders/:id/cancellation/withdraw — the customer changed their mind; work carries on. */
router.post('/orders/:id/cancellation/withdraw', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { before, after, resumed } = await prisma.$transaction((tx) => withdrawCancellation(tx, req.params.id), { timeout: 30_000 })
  await writeAuditLog(req, { module: 'sales', action: 'UPDATE', entityType: 'SalesOrder', entityId: after.id, before, after })
  for (const mo of resumed) {
    await writeAuditLog(req, { module: 'production', action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: mo.id, after: { heldAt: null, resumedBecause: `Cancellation of ${after.soNumber} withdrawn` } })
  }
  const names = resumed.map((m) => m.moNumber)
  res.json({
    success: true,
    message: `The cancellation of ${after.soNumber} is withdrawn${names.length ? `; ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} off hold again` : ''}.`,
    data: after,
  })
})

/**
 * POST /api/sales/orders/:id/cancellation/approve
 *
 * By someone who approves orders. Its requisitions still asking close and the
 * stock held for the order is freed; its manufacturing orders close; and the
 * order is cancelled, or, when goods already went out, short-closed at what
 * was sent. A job-work order's customer material must be accounted for, or a
 * manager makes an exception. Nothing recorded is undone or deleted: material
 * still on the floor goes back on a floor return when the store has it.
 */
router.post('/orders/:id/cancellation/approve', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const { materialException } = reasonBody.pick({ materialException: true }).parse(req.body ?? {})
  const userId = req.user!.id
  const { before, after, exception, closedMos, closedMrs, released, sent } = await prisma.$transaction(
    async (tx) => {
      const before = await tx.salesOrder.findUnique({
        where: { id: req.params.id },
        include: {
          lines: { select: { deliveredQty: true } },
          manufacturingOrders: { where: { status: { notIn: ['CLOSED', 'COMPLETED'] } }, select: { id: true, moNumber: true } },
          _count: { select: { deliveryChallans: { where: { status: { not: 'CANCELLED' } } } } },
        },
      })
      if (!before) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
      if (!before.cancelRequestedAt || !CANCELLABLE.includes(before.status)) {
        throw new AppError(`No cancellation of ${before.soNumber} is waiting for approval.`, 409, 'NOT_REQUESTED')
      }
      const reason = before.cancelRequestReason ?? 'Cancelled'
      // Nothing sent: cancelled. Goods already out: short-closed at what was sent.
      const sent = before._count.deliveryChallans > 0 || before.lines.some((l) => Number(l.deliveredQty) > 0)
      const exception = await materialClosure(tx, req, before, sent ? 'short-closed' : 'cancelled', materialException)
      const now = new Date()
      const why = `${before.soNumber} cancelled: ${reason}`
      // Requisitions still asking close: nothing more is issued. What was issued stays issued.
      const openMrs = await tx.materialRequisition.findMany({
        where: { OR: [{ soId: before.id }, { mo: { soId: before.id } }], closedAt: null, issuedAt: null, status: { not: 'REJECTED' } },
        select: { id: true, mrNumber: true },
      })
      if (openMrs.length) {
        await tx.materialRequisition.updateMany({ where: { id: { in: openMrs.map((m) => m.id) } }, data: { closedAt: now, closedById: userId, closeReason: why } })
      }
      const released = await tx.stockReservation.updateMany({
        where: { status: 'ACTIVE', OR: [{ soId: before.id }, { mr: { soId: before.id } }, { mr: { mo: { soId: before.id } } }] },
        data: { status: 'RELEASED', qty: 0, releasedAt: now, releasedById: userId, releaseReason: why },
      })
      const closedMos = []
      for (const m of before.manufacturingOrders) closedMos.push(await closeMo(tx, m.id, userId, why))
      if (sent) await tx.salesOrderLine.updateMany({ where: { soId: before.id }, data: { pendingQty: 0 } })
      const after = await tx.salesOrder.update({
        where: { id: before.id },
        data: sent
          ? { status: 'COMPLETED', shortClosedById: userId, shortClosedAt: now, shortCloseReason: reason, ...exception }
          : { status: 'CANCELLED', cancelledById: userId, cancelledAt: now, cancelReason: reason, ...exception },
      })
      return { before, after, exception, closedMos, closedMrs: openMrs, released: released.count, sent }
    },
    { timeout: 60_000 },
  )
  await writeAuditLog(req, { module: 'sales', action: 'APPROVE', entityType: 'SalesOrder', entityId: after.id, before, after })
  for (const m of closedMos) {
    await writeAuditLog(req, { module: 'production', action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: m.after.id, before: m.before, after: m.after })
  }
  for (const m of closedMrs) {
    await writeAuditLog(req, { module: 'inventory', action: 'UPDATE', entityType: 'MaterialRequisition', entityId: m.id, after: { closed: true, closeReason: `${after.soNumber} cancelled` } })
  }
  if (exception.materialExceptionReason) {
    await writeAuditLog(req, { module: 'sales', action: 'APPROVE', entityType: 'SalesOrderMaterialException', entityId: after.id, after: { soNumber: after.soNumber, act: sent ? 'short-closed' : 'cancelled', reason: exception.materialExceptionReason, unaccounted: exception.materialExceptionSnapshot } })
  }
  const mos = closedMos.map((m) => m.after.moNumber)
  const mrs = closedMrs.map((m) => m.mrNumber)
  res.json({
    success: true,
    message:
      `${after.soNumber} ${sent ? 'short-closed at what was sent' : 'cancelled'}` +
      (mos.length ? `; ${mos.join(', ')} closed` : '') +
      (mrs.length ? `; ${mrs.join(', ')} closed, nothing more issued` : '') +
      (released ? `; ${released} stock hold${released === 1 ? '' : 's'} freed` : '') +
      (exception.materialExceptionReason ? '; the material exception is recorded with it' : '') +
      '. Everything already issued, made and sent stays on record.',
    data: after,
  })
})

/**
 * POST /api/sales/orders/:id/short-close
 *
 * Ends an order at what has been made and sent, the rest no longer wanted —
 * the buyer called off the balance, or production came out a few short.
 * Every line's pending pieces go to nothing; what was sent stays. Only for an
 * order something has happened to: one with nothing made or sent is
 * cancelled instead. Made means work on a manufacturing order — material
 * issued to it, cutting, packing — not just one released.
 *
 * Its manufacturing orders nothing was made on close with it. One with work
 * on the floor stays open, to finish or close in Production.
 */
router.post('/orders/:id/short-close', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const { reason, materialException } = reasonBody.parse(req.body)

  const { before, after, released, exception, closedMos, stillOpen } = await prisma.$transaction(async (tx) => {
    const before = await tx.salesOrder.findUnique({
      where: { id: req.params.id },
      include: {
        lines: { select: { deliveredQty: true } },
        manufacturingOrders: { where: { status: { not: 'CLOSED' } }, select: { id: true, moNumber: true, status: true } },
        _count: { select: { deliveryChallans: { where: { status: { not: 'CANCELLED' } } } } },
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
    await assertNotCancelling(tx, before.id, 'it is not short-closed')
    const made = await workStarted(tx, before.manufacturingOrders.map((m) => m.id))
    const anythingDone = made.size > 0 || before._count.deliveryChallans > 0 || before.lines.some((l) => Number(l.deliveredQty) > 0)
    if (!anythingDone) {
      const untouched = before.manufacturingOrders.map((m) => m.moNumber)
      throw new AppError(
        untouched.length
          ? `Nothing has been made or sent against ${before.soNumber} yet: nothing was issued, cut or packed on ${untouched.join(', ')}. Cancel it instead; ${untouched.length === 1 ? 'that order closes' : 'those orders close'} with it.`
          : `Nothing has been made or sent against ${before.soNumber} yet. Cancel it instead.`,
        409,
        'NOTHING_STARTED',
      )
    }

    // A job-work order closes with the customer's material accounted for, or on a manager's exception.
    const exception = await materialClosure(tx, req, before, 'short-closed', materialException)

    await tx.salesOrderLine.updateMany({ where: { soId: before.id }, data: { pendingQty: 0 } })
    const after = await tx.salesOrder.update({
      where: { id: before.id },
      data: {
        status: 'COMPLETED',
        shortClosedById: req.user!.id,
        shortClosedAt: new Date(),
        shortCloseReason: reason,
        ...exception,
      },
    })
    // Material held for the order, or for its manufacturing orders, is no
    // longer held: the rest of the order is not coming, so it is free stock.
    const released = await tx.stockReservation.updateMany({
      where: { status: 'ACTIVE', OR: [{ soId: before.id }, { mr: { soId: before.id } }, { mr: { mo: { soId: before.id } } }] },
      data: { status: 'RELEASED', qty: 0, releasedAt: new Date(), releasedById: req.user!.id, releaseReason: `${before.soNumber} short-closed: ${reason}` },
    })
    // Its manufacturing orders nothing was made on close with it; those with work on the floor stay open.
    const closedMos = []
    for (const m of before.manufacturingOrders) {
      if (!made.has(m.id) && m.status !== 'COMPLETED') closedMos.push(await closeMo(tx, m.id, req.user!.id, `${before.soNumber} short-closed: ${reason}`))
    }
    const stillOpen = before.manufacturingOrders.filter((m) => made.has(m.id) && m.status !== 'COMPLETED').map((m) => m.moNumber)
    return { before, after, released: released.count, exception, closedMos, stillOpen }
  }, { timeout: 30_000 })

  await writeAuditLog(req, {
    module: 'sales',
    action: 'UPDATE',
    entityType: 'SalesOrder',
    entityId: before.id,
    before,
    after,
  })
  for (const m of closedMos) {
    await writeAuditLog(req, { module: 'production', action: 'UPDATE', entityType: 'ManufacturingOrder', entityId: m.after.id, before: m.before, after: m.after })
  }
  if (exception.materialExceptionReason) {
    await writeAuditLog(req, { module: 'sales', action: 'APPROVE', entityType: 'SalesOrderMaterialException', entityId: before.id, after: { soNumber: before.soNumber, act: 'short-closed', reason: exception.materialExceptionReason, unaccounted: exception.materialExceptionSnapshot } })
  }
  const closedNames = closedMos.map((m) => m.after.moNumber)
  res.json({
    success: true,
    message:
      `${before.soNumber} short-closed at what was sent${released ? `; ${released} material hold${released === 1 ? '' : 's'} for it released` : ''}` +
      (closedNames.length ? `; ${closedNames.join(', ')} closed with it, nothing having been made on ${closedNames.length === 1 ? 'it' : 'them'}` : '') +
      (stillOpen.length ? `; ${stillOpen.join(', ')} still ${stillOpen.length === 1 ? 'has' : 'have'} work on the floor: finish or close ${stillOpen.length === 1 ? 'it' : 'them'} in Production` : '') +
      (exception.materialExceptionReason ? '; the material exception is recorded with it' : ''),
    data: after,
  })
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
