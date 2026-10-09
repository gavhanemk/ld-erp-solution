import { Router } from 'express'
import type { Prisma, SalesOrderStatus } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AuthRequest, requirePermission, userCan } from '../middleware/auth'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { applyRoundOff, nextDocumentNumber, resolvePlaceOfSupply } from '../lib/docNumber'
import { findHsn, gstRateFor, loadHsnIndex } from '../lib/hsn'
import { OPEN_ORDER_STATUSES, checkCredit, creditPosition } from '../services/salesOrder.service'

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
  /** The size run for this line. Quantities must add up to the line total. */
  sizes: z
    .array(z.object({ sizeId: z.string().min(1), qty: z.number().min(0) }))
    .optional(),
})

export const createSalesOrderSchema = z
  .object({
    customerId: z.string().min(1, 'Pick a customer'),
    brandId: z.string().min(1, 'Pick a brand'),
    orderDate: z.coerce.date().optional(),
    deliveryDate: z.coerce.date().optional().nullable(),
    customerPORef: z.string().max(60).optional().nullable(),
    customerPODate: z.coerce.date().optional().nullable(),
    deliveryAddress: z.string().max(500).optional().nullable(),
    salesperson: z.string().max(120).optional().nullable(),
    brokerId: z.string().optional().nullable(),
    brokeragePercent: z.number().min(0).max(100).optional().nullable(),
    discountAmount: z.number().min(0).optional(),
    isJobWork: z.boolean().optional(),
    currency: z.string().length(3).optional(),
    notes: z.string().max(1000).optional().nullable(),
    /** Save and send for approval in one go, rather than keep it as a draft. */
    sendForApproval: z.boolean().optional(),
    lines: z.array(salesOrderLineSchema).min(1, 'An order needs at least one line'),
  })
  // A size run that does not add up to the line quantity is the classic way a
  // cutting sheet and an invoice quietly stop agreeing.
  .superRefine((order, ctx) => {
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

  const [openAgg, pending, dueCount, nextDue, lateCount, oldestLate] = await Promise.all([
    prisma.salesOrder.aggregate({ where: open, _count: { _all: true }, _sum: { taxableAmount: true } }),
    prisma.salesOrderLine.aggregate({ where: { so: open }, _sum: { pendingQty: true } }),
    prisma.salesOrder.count({ where: dueThisWeek }),
    prisma.salesOrder.findFirst({ where: dueThisWeek, orderBy: { deliveryDate: 'asc' }, select: brief }),
    prisma.salesOrder.count({ where: late }),
    prisma.salesOrder.findFirst({ where: late, orderBy: { deliveryDate: 'asc' }, select: brief }),
  ])

  res.json({
    success: true,
    data: {
      open: { count: openAgg._count._all, value: Number(openAgg._sum.taxableAmount ?? 0) },
      piecesToDispatch: Number(pending._sum.pendingQty ?? 0),
      dueThisWeek: { count: dueCount, next: nextDue },
      overdue: { count: lateCount, oldest: oldestLate },
    },
  })
})

/**
 * GET /api/sales/orders
 *
 * Filters: q (order number, buyer PO or customer), status, customerId,
 * brandId, type (own | job-work), from / to (order date), due (overdue | week |
 * month — open orders only), page, limit.
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
      deliveryChallans: true,
      invoices: true,
      manufacturingOrders: { select: { id: true, moNumber: true, status: true, totalPackedQty: true } },
    },
  })
  if (!order) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: order })
})

/**
 * GET /api/sales/customers/:id/credit?value=
 *
 * What the customer owes and has on order against their credit limit, and
 * whether an order of `value` more would need a manager's release. The order
 * form shows it as the customer is picked.
 */
router.get('/customers/:id/credit', requirePermission(MODULE, 'view'), async (req, res) => {
  const value = Number(req.query.value) || 0
  const position = await creditPosition(prisma, req.params.id)
  res.json({ success: true, data: checkCredit(position, value) })
})

// POST /api/sales/orders
router.post('/orders', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createSalesOrderSchema.parse(req.body)

  const order = await prisma.$transaction(async (tx) => {
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
      for (const s of l.sizes ?? []) {
        const size = sizeById.get(s.sizeId)
        if (!size) throw new AppError(`Line ${i + 1}: one of the sizes does not exist`, 400, 'BAD_SIZE')
        if (item.style?.sizeGroupId && size.sizeGroupId !== item.style.sizeGroupId) {
          throw new AppError(
            `Line ${i + 1}: size ${size.code} is not in ${item.code}'s size run`,
            400,
            'BAD_SIZE',
          )
        }
      }
    })

    const soNumber = await nextDocumentNumber(tx, 'SO', data.orderDate ?? new Date())
    const { placeOfSupplyCode, isIntraState } = await resolvePlaceOfSupply(tx, data.customerId)

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
      const item = itemById.get(l.itemId)!
      const hsn = findHsn(hsnIndex, item.hsnCode)
      if (hsn) {
        const perPiece = l.unitPrice * (1 - (l.discount ?? 0) / 100) * discountFactor
        return gstRateFor(hsn, perPiece)
      }
      if (item.taxRate) return Number(item.taxRate.rate)
      throw new AppError(
        `${item.code} has no HSN code or GST rate. Set one on the item before ordering it.`,
        400,
        'NO_GST_RATE',
      )
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
    cgst = round2(cgst)
    sgst = round2(sgst)
    igst = round2(igst)

    const beforeRounding = taxableAmount + cgst + sgst + igst
    const { rounded, roundOff } = applyRoundOff(beforeRounding)

    // Brokerage falls on the order value, not on the tax.
    const brokeragePercent = data.brokeragePercent ?? (await defaultBrokerage(tx, data.customerId, data.brokerId))
    const brokerageAmount = round2((taxableAmount * (brokeragePercent ?? 0)) / 100)

    return tx.salesOrder.create({
      data: {
        soNumber,
        customerId: data.customerId,
        brandId: data.brandId,
        orderDate: data.orderDate ?? new Date(),
        deliveryDate: data.deliveryDate ?? undefined,
        customerPORef: data.customerPORef ?? null,
        customerPODate: data.customerPODate ?? undefined,
        deliveryAddress: data.deliveryAddress ?? null,
        salesperson: data.salesperson ?? null,
        brokerId: data.brokerId ?? null,
        brokeragePercent: brokeragePercent ?? null,
        brokerageAmount,
        placeOfSupplyCode,
        isJobWork: data.isJobWork ?? false,
        currency: data.currency ?? 'INR',
        notes: data.notes ?? null,
        sentForApprovalAt: data.sendForApproval ? new Date() : null,
        subtotal,
        discountAmount,
        taxableAmount,
        cgst,
        sgst,
        igst,
        roundOff,
        totalAmount: rounded,
        createdById: req.user!.id,
        lines: {
          create: data.lines.map((l, i) => {
            const item = itemById.get(l.itemId)!
            return {
              itemId: l.itemId,
              // Copied from the item when the screen does not send them, so the
              // order still reads right if the item is renamed later.
              styleCode: l.styleCode ?? item.style?.code ?? null,
              color: l.color ?? item.color ?? null,
              totalQty: l.totalQty,
              unitPrice: l.unitPrice,
              discount: l.discount ?? 0,
              gstRate: gstRates[i],
              hsnCode: item.hsnCode ?? null,
              amount: round2(lineTotals[i]),
              pendingQty: l.totalQty,
              sortOrder: i,
              sizes: l.sizes?.length
                ? { create: l.sizes.map((s) => ({ sizeId: s.sizeId, qty: s.qty })) }
                : undefined,
            }
          }),
        },
      },
      include: {
        customer: { select: { id: true, name: true, gstin: true } },
        brand: { select: { id: true, name: true } },
        broker: { select: { id: true, name: true } },
        lines: { include: { sizes: { include: { size: true } } }, orderBy: { sortOrder: 'asc' } },
      },
    })
  })

  await writeAuditLog(req, {
    module: 'sales',
    action: 'CREATE',
    entityType: 'SalesOrder',
    entityId: order.id,
    after: order,
  })

  res.status(201).json({ success: true, data: order })
})

/**
 * POST /api/sales/orders/:id/send
 *
 * A draft saved earlier goes to the approvals list. Until it is sent it is
 * still being typed, and nobody is asked to approve it.
 */
router.post('/orders/:id/send', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const before = await prisma.salesOrder.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  if (before.status !== 'DRAFT') {
    throw new AppError(`${before.soNumber} is no longer a draft`, 409, 'NOT_DRAFT')
  }
  if (before.sentForApprovalAt) {
    throw new AppError(`${before.soNumber} is already waiting for approval`, 409, 'ALREADY_SENT')
  }

  const after = await prisma.salesOrder.update({
    where: { id: before.id },
    data: { sentForApprovalAt: new Date() },
  })
  await writeAuditLog(req, {
    module: 'sales',
    action: 'UPDATE',
    entityType: 'SalesOrder',
    entityId: before.id,
    before,
    after,
  })
  res.json({ success: true, message: `${before.soNumber} sent for approval`, data: after })
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

// Approving and rejecting a sales order is done through /api/approvals, which
// holds the rules (draft only, not by whoever raised it, credit hold).

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
