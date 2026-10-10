import { Router } from 'express'
import type { InvoiceStatus, Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AuthRequest, requirePermission, userCan } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { applyRoundOff, nextDocumentNumber, resolvePlaceOfSupply } from '../lib/docNumber'
import { amountInWords, getPrintHeader } from '../lib/printData'
import { stateName } from '../lib/gstStates'
import { priceSalesCharges } from '../services/salesCharges'

/**
 * Sales invoices: the tax invoice for goods that have gone out on a challan.
 *
 * One invoice bills one dispatched challan — the pieces on it, at the rates
 * agreed on the order. Nothing on the lines is typed: the quantity is what
 * the challan sent, the rate, discount and GST rate are the order line's,
 * and the order's discount on the whole bill is shared out in proportion.
 * What is typed is what an invoice carries beyond the goods: its date and
 * due date, the addresses, the transport and e-way bill, and the charges —
 * offered as whatever of the order's charges no earlier invoice has billed.
 *
 * An invoice is final when saved: there is no draft. A mistake is cancelled,
 * with a reason, while nothing has been received against it, and the challan
 * can then be billed again. No IRN: LD is below the e-invoice limit (the
 * business's answer of 9 Oct 2026).
 *
 * Mounted at /api/sales/invoices, ahead of /api/sales. Read by Sales and by
 * Accounts, who chase the money.
 */

const router = Router()
const MODULE = 'sales'

const round2 = (n: number) => Math.round(n * 100) / 100
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Sales and Accounts both read invoices. */
function mustSee(req: AuthRequest) {
  if (!userCan(req.user, MODULE, 'view') && !userCan(req.user, 'accounts', 'view')) {
    throw new AppError('You do not have permission to view invoices', 403, 'FORBIDDEN')
  }
}

const chargeSchema = z.object({
  chargeTypeId: z.string().min(1, 'Pick the charge'),
  amount: z.number().min(0, 'A charge cannot be negative'),
  gstRate: z.number().min(0).max(100).optional().nullable(),
})

export const invoiceSchema = z
  .object({
    dcId: z.string().min(1, 'Say which challan to bill'),
    invoiceDate: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional().nullable(),
    billingAddress: z.string().max(500).optional().nullable(),
    shippingAddress: z.string().max(500).optional().nullable(),
    transporter: z.string().max(120).optional().nullable(),
    vehicleNumber: z.string().max(30).optional().nullable(),
    lrNumber: z.string().max(60).optional().nullable(),
    eWayBillNumber: z.string().max(30).optional().nullable(),
    eWayBillDate: z.coerce.date().optional().nullable(),
    charges: z.array(chargeSchema).max(20).optional(),
    otherCharges: z.number().min(0).optional(),
    notes: z.string().max(1000).optional().nullable(),
    terms: z.string().max(2000).optional().nullable(),
  })
  .superRefine((d, ctx) => {
    const ids = (d.charges ?? []).map((c) => c.chargeTypeId)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['charges'], message: 'The same charge appears twice. Put it on one row.' })
    }
    if (d.invoiceDate && d.dueDate && d.dueDate < d.invoiceDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dueDate'], message: 'The due date cannot be before the invoice date' })
    }
  })

type InvoiceInput = z.infer<typeof invoiceSchema>

/** A challan with what billing it needs: its order, the order's lines and charges, and what is billed already. */
const billableInclude = {
  so: {
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          gstin: true,
          creditDays: true,
          billingAddress: true,
          billingCity: true,
          billingState: true,
          billingPincode: true,
        },
      },
      charges: { include: { chargeType: { select: { id: true, name: true } } }, orderBy: { sortOrder: 'asc' } },
      invoices: {
        where: { status: { not: 'CANCELLED' } },
        select: { id: true, invoiceNumber: true, otherCharges: true, charges: { select: { chargeTypeId: true, amount: true } } },
      },
    },
  },
  lines: {
    include: {
      item: { select: { id: true, code: true, name: true, color: true, hsnCode: true } },
      soLine: true,
      sizes: { include: { size: { select: { code: true, sequence: true } } }, orderBy: { size: { sequence: 'asc' } } },
    },
  },
  invoices: { where: { status: { not: 'CANCELLED' } }, select: { id: true, invoiceNumber: true } },
} satisfies Prisma.DeliveryChallanInclude

type Billable = Prisma.DeliveryChallanGetPayload<{ include: typeof billableInclude }>

/** A challan that can be billed now: dispatched, and not billed already. */
export async function loadBillable(db: Prisma.TransactionClient | typeof prisma, dcId: string): Promise<Billable> {
  const dc = await db.deliveryChallan.findUnique({ where: { id: dcId }, include: billableInclude })
  if (!dc) throw new AppError('Delivery challan not found', 404, 'NOT_FOUND')
  if (dc.status !== 'DISPATCHED' && dc.status !== 'DELIVERED') {
    throw new AppError(
      dc.status === 'DRAFT'
        ? `${dc.dcNumber} is still a draft. Dispatch it before billing it.`
        : `${dc.dcNumber} is ${dc.status.toLowerCase()}, so there is nothing to bill`,
      409,
      'NOT_DISPATCHED',
    )
  }
  if (dc.invoices.length) {
    throw new AppError(`${dc.dcNumber} is already billed on ${dc.invoices[0].invoiceNumber}`, 409, 'ALREADY_INVOICED')
  }
  return dc
}

/** The challan's lines as they bill: its pieces at the order line's terms. */
function billLines(dc: Billable) {
  const lines = dc.lines
    .filter((l) => l.soLine && Number(l.qty) > 0)
    .map((l) => {
      const so = l.soLine!
      const qty = Number(l.qty)
      const unitPrice = Number(so.unitPrice)
      const discount = Number(so.discount)
      return {
        dcLine: l,
        soLine: so,
        qty,
        unitPrice,
        discount,
        gstRate: Number(so.gstRate),
        gross: round2(qty * unitPrice * (1 - discount / 100)),
      }
    })
  if (!lines.length) throw new AppError(`${dc.dcNumber} has nothing on it to bill`, 409, 'NOTHING_TO_BILL')
  return lines
}

/**
 * What of the order's charges is still to be billed: each charge less what
 * earlier invoices of the order carried, and the same for other charges.
 * The first invoice of an order is usually offered all of them.
 */
export function chargesStillToBill(dc: Billable) {
  const billed = new Map<string, number>()
  let otherBilled = 0
  for (const inv of dc.so.invoices) {
    otherBilled += Number(inv.otherCharges)
    for (const c of inv.charges) billed.set(c.chargeTypeId, (billed.get(c.chargeTypeId) ?? 0) + Number(c.amount))
  }
  return {
    charges: dc.so.charges
      .map((c) => ({
        chargeTypeId: c.chargeTypeId,
        name: c.chargeType.name,
        amount: round2(Math.max(0, Number(c.amount) - (billed.get(c.chargeTypeId) ?? 0))),
        gstRate: Number(c.gstRate),
      }))
      .filter((c) => c.amount > 0),
    otherCharges: round2(Math.max(0, Number(dc.so.otherCharges) - otherBilled)),
  }
}

/**
 * Prices an invoice for a challan. The server's figures are the record; the
 * form shows the same sums as a preview.
 */
async function priceInvoice(tx: Prisma.TransactionClient, dc: Billable, data: InvoiceInput) {
  const order = dc.so
  const { placeOfSupplyCode, isIntraState } = await resolvePlaceOfSupply(tx, order.customerId, order.placeOfSupplyCode)
  const bills = billLines(dc)

  // The order's discount on the whole bill, shared out by this invoice's share of the goods.
  const subtotal = round2(bills.reduce((s, b) => s + b.gross, 0))
  const orderSubtotal = Number(order.subtotal)
  const discountAmount =
    orderSubtotal > 0 ? round2(Math.min(subtotal, (Number(order.discountAmount) * subtotal) / orderSubtotal)) : 0
  const taxableAmount = round2(subtotal - discountAmount)
  const factor = subtotal > 0 ? taxableAmount / subtotal : 1

  const lines = bills.map((b, i) => {
    const taxableValue = round2(b.gross * factor)
    const tax = (taxableValue * b.gstRate) / 100
    const cgst = isIntraState ? round2(tax / 2) : 0
    const sgst = isIntraState ? round2(tax / 2) : 0
    const igst = isIntraState ? 0 : round2(tax)
    return {
      itemId: b.dcLine.itemId ?? b.soLine.itemId,
      soLineId: b.soLine.id,
      description: b.soLine.description,
      hsnCode: b.soLine.hsnCode ?? b.dcLine.item?.hsnCode ?? null,
      qty: b.qty,
      unitPrice: b.unitPrice,
      discount: b.discount,
      taxableValue,
      gstRate: b.gstRate,
      cgst,
      sgst,
      igst,
      /** The line's value with its GST. */
      amount: round2(taxableValue + cgst + sgst + igst),
      sortOrder: i,
    }
  })

  const charges = await priceSalesCharges(tx, data.charges, isIntraState)
  const chargeTotal = round2(charges.reduce((s, c) => s + c.amount, 0))
  const sum = (k: 'cgst' | 'sgst' | 'igst') =>
    round2(lines.reduce((s, l) => s + l[k], 0) + charges.reduce((s, c) => s + c[k], 0))
  const cgst = sum('cgst')
  const sgst = sum('sgst')
  const igst = sum('igst')
  const otherCharges = round2(data.otherCharges ?? 0)
  const { rounded, roundOff } = applyRoundOff(taxableAmount + chargeTotal + cgst + sgst + igst + otherCharges)

  // Brokerage falls on the goods, at the order's rate.
  const brokeragePercent = order.brokeragePercent != null ? Number(order.brokeragePercent) : null
  const brokerageAmount = round2((taxableAmount * (brokeragePercent ?? 0)) / 100)

  return {
    placeOfSupplyCode,
    isIntraState,
    lines,
    charges: charges.map(({ sortOrder: _s, ...c }) => c),
    subtotal,
    discountAmount,
    taxableAmount,
    cgst,
    sgst,
    igst,
    otherCharges,
    roundOff,
    totalAmount: rounded,
    brokeragePercent,
    brokerageAmount,
  }
}

const joinAddress = (...parts: Array<string | null | undefined>) =>
  parts.map((p) => p?.trim()).filter(Boolean).join(', ')

const addDays = (d: Date, days: number) => {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

/**
 * GET /api/sales/invoices/prepare?dcId=
 *
 * Everything the invoice form opens with for one challan: the order and the
 * customer, the lines at the order's terms with their sizes, the order's
 * charges still to bill, and the transport off the challan.
 */
router.get('/prepare', requirePermission(MODULE, 'create'), async (req, res) => {
  const dcId = text(req.query.dcId)
  if (!dcId) throw new AppError('Say which challan to bill', 400, 'NO_CHALLAN')
  const dc = await loadBillable(prisma, dcId)
  const order = dc.so
  const c = order.customer
  let isIntraState: boolean | null = null
  let placeOfSupplyProblem: string | null = null
  try {
    isIntraState = (await resolvePlaceOfSupply(prisma, order.customerId, order.placeOfSupplyCode)).isIntraState
  } catch (err) {
    if (!(err instanceof AppError)) throw err
    placeOfSupplyProblem = err.message
  }
  const still = chargesStillToBill(dc)
  const today = new Date()

  res.json({
    success: true,
    data: {
      challan: {
        id: dc.id,
        dcNumber: dc.dcNumber,
        dcDate: dc.dcDate,
        status: dc.status,
        deliveryAddress: dc.deliveryAddress,
        transporter: dc.transporter,
        vehicleNumber: dc.vehicleNumber,
        lrNumber: dc.lrNumber,
        eWayBillNumber: dc.eWayBillNumber,
        cartons: dc.cartons,
      },
      order: {
        id: order.id,
        soNumber: order.soNumber,
        orderDate: order.orderDate,
        customerPORef: order.customerPORef,
        customerPODate: order.customerPODate,
        isJobWork: order.isJobWork,
        placeOfSupplyCode: order.placeOfSupplyCode,
        placeOfSupplyState: stateName(order.placeOfSupplyCode),
        billingAddress: order.billingAddress,
        deliveryAddress: order.deliveryAddress,
        terms: order.terms,
        subtotal: Number(order.subtotal),
        discountAmount: Number(order.discountAmount),
        brokeragePercent: order.brokeragePercent != null ? Number(order.brokeragePercent) : null,
      },
      customer: {
        id: c.id,
        name: c.name,
        gstin: c.gstin,
        creditDays: c.creditDays,
        billingAddress: joinAddress(c.billingAddress, c.billingCity, c.billingState, c.billingPincode),
      },
      isIntraState,
      placeOfSupplyProblem,
      lines: billLines(dc).map((b) => ({
        soLineId: b.soLine.id,
        item: b.dcLine.item,
        styleCode: b.soLine.styleCode,
        color: b.soLine.color,
        gender: b.soLine.gender,
        fabric: b.soLine.fabric,
        printName: b.soLine.printName,
        description: b.soLine.description,
        hsnCode: b.soLine.hsnCode ?? b.dcLine.item?.hsnCode ?? null,
        taxExempt: b.soLine.taxExempt,
        qty: b.qty,
        unitPrice: b.unitPrice,
        discount: b.discount,
        gstRate: b.gstRate,
        sizes: b.dcLine.sizes.map((s) => ({ code: s.size.code, qty: Number(s.qty) })),
      })),
      charges: still.charges,
      otherCharges: still.otherCharges,
      defaults: { invoiceDate: today, dueDate: addDays(today, c.creditDays ?? 0) },
    },
  })
})

/**
 * GET /api/sales/invoices/waiting
 *
 * Challans that have gone and are not billed yet, oldest first: the work in
 * front of whoever raises invoices.
 */
router.get('/waiting', async (req: AuthRequest, res) => {
  mustSee(req)
  const q = text(req.query.q)
  const rows = await prisma.deliveryChallan.findMany({
    where: {
      status: { in: ['DISPATCHED', 'DELIVERED'] },
      invoices: { none: { status: { not: 'CANCELLED' } } },
      ...(q
        ? {
            OR: [
              { dcNumber: { contains: q, mode: 'insensitive' } },
              { so: { soNumber: { contains: q, mode: 'insensitive' } } },
              { customer: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      dcNumber: true,
      dcDate: true,
      status: true,
      eWayBillNumber: true,
      so: { select: { id: true, soNumber: true, customerPORef: true, isJobWork: true } },
      customer: { select: { id: true, name: true, billingCity: true, shippingCity: true } },
      lines: { select: { qty: true, soLine: { select: { unitPrice: true, discount: true } } } },
    },
    orderBy: [{ dcDate: 'asc' }, { createdAt: 'asc' }],
    take: 200,
  })
  res.json({
    success: true,
    data: rows.map(({ lines, ...r }) => ({
      ...r,
      pieces: lines.reduce((s, l) => s + Number(l.qty), 0),
      // Before GST and the order's discount on the whole bill: a guide, not the invoice.
      value: round2(
        lines.reduce(
          (s, l) => s + Number(l.qty) * Number(l.soLine?.unitPrice ?? 0) * (1 - Number(l.soLine?.discount ?? 0) / 100),
          0,
        ),
      ),
    })),
  })
})

const startOfToday = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** GET /api/sales/invoices/summary — what the cards on the invoice list show. */
router.get('/summary', async (req: AuthRequest, res) => {
  mustSee(req)
  const today = startOfToday()
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const open = { status: { in: ['UNPAID', 'PARTIAL'] as InvoiceStatus[] } }
  const [unpaid, overdue, month, waiting] = await Promise.all([
    prisma.salesInvoice.aggregate({ where: open, _count: true, _sum: { balanceAmount: true } }),
    prisma.salesInvoice.aggregate({ where: { ...open, dueDate: { lt: today } }, _count: true, _sum: { balanceAmount: true } }),
    prisma.salesInvoice.aggregate({
      where: { status: { not: 'CANCELLED' }, invoiceDate: { gte: monthStart } },
      _count: true,
      _sum: { totalAmount: true },
    }),
    prisma.deliveryChallan.count({
      where: { status: { in: ['DISPATCHED', 'DELIVERED'] }, invoices: { none: { status: { not: 'CANCELLED' } } } },
    }),
  ])
  res.json({
    success: true,
    data: {
      unpaid: { count: unpaid._count, amount: Number(unpaid._sum.balanceAmount ?? 0) },
      overdue: { count: overdue._count, amount: Number(overdue._sum.balanceAmount ?? 0) },
      thisMonth: { count: month._count, amount: Number(month._sum.totalAmount ?? 0) },
      waiting,
    },
  })
})

/** GET /api/sales/invoices — filters: q, status, customerId, soId, from, to, due=overdue, page, limit. */
router.get('/', async (req: AuthRequest, res) => {
  mustSee(req)
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
  const and: Prisma.SalesInvoiceWhereInput[] = []
  const q = text(req.query.q)
  if (q) {
    and.push({
      OR: [
        { invoiceNumber: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
        { so: { soNumber: { contains: q, mode: 'insensitive' } } },
        { dc: { dcNumber: { contains: q, mode: 'insensitive' } } },
      ],
    })
  }
  const status = text(req.query.status)
  if (status) {
    if (!['UNPAID', 'PARTIAL', 'PAID', 'CANCELLED'].includes(status)) {
      throw new AppError(`Unknown status '${status}'`, 400, 'BAD_STATUS')
    }
    and.push({ status: status as InvoiceStatus })
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
    and.push({ invoiceDate: { ...(from && { gte: new Date(from) }), ...(end && { lt: end }) } })
  }
  const due = text(req.query.due)
  if (due) {
    if (due !== 'overdue') throw new AppError(`Unknown due filter '${due}'`, 400, 'BAD_DUE')
    and.push({ status: { in: ['UNPAID', 'PARTIAL'] }, dueDate: { lt: startOfToday() } })
  }
  const where: Prisma.SalesInvoiceWhereInput = and.length ? { AND: and } : {}

  const [rows, total] = await Promise.all([
    prisma.salesInvoice.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, billingCity: true, shippingCity: true } },
        so: { select: { id: true, soNumber: true, customerPORef: true } },
        dc: { select: { id: true, dcNumber: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.salesInvoice.count({ where }),
  ])
  res.json({ success: true, data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
})

const invoiceInclude = {
  customer: true,
  so: { select: { id: true, soNumber: true, orderDate: true, customerPORef: true, customerPODate: true, isJobWork: true } },
  dc: {
    select: {
      id: true,
      dcNumber: true,
      dcDate: true,
      cartons: true,
      lines: {
        select: {
          soLineId: true,
          sizes: { select: { qty: true, size: { select: { code: true, sequence: true } } }, orderBy: { size: { sequence: 'asc' } } },
        },
      },
    },
  },
  lines: {
    orderBy: { sortOrder: 'asc' },
    include: {
      item: { select: { id: true, code: true, name: true, color: true, uom: { select: { symbol: true } } } },
      soLine: { select: { styleCode: true, color: true, gender: true, fabric: true, printName: true, taxExempt: true } },
    },
  },
  charges: { include: { chargeType: { select: { id: true, name: true } } } },
  createdBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  _count: { select: { payments: true, creditNotes: true } },
} satisfies Prisma.SalesInvoiceInclude

// GET /api/sales/invoices/:id
router.get('/:id', async (req: AuthRequest, res) => {
  mustSee(req)
  const invoice = await prisma.salesInvoice.findUnique({ where: { id: req.params.id }, include: invoiceInclude })
  if (!invoice) throw new AppError('Invoice not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: invoice })
})

/**
 * GET /api/sales/invoices/:id/print
 *
 * The tax invoice: the company and the INV template from Settings →
 * Documents, the invoice with each line's size breakup off the challan, the
 * HSN-wise tax summary GST asks for, and the total in words.
 */
router.get('/:id/print', async (req: AuthRequest, res) => {
  mustSee(req)
  const invoice = await prisma.salesInvoice.findUnique({ where: { id: req.params.id }, include: invoiceInclude })
  if (!invoice) throw new AppError('Invoice not found', 404, 'NOT_FOUND')
  const header = await getPrintHeader('INV')
  const taxMode = Number(invoice.igst) > 0 ? 'IGST' : Number(invoice.cgst) > 0 ? 'CGST_SGST' : 'NONE'

  // One row per HSN code and rate, goods first, then each charge.
  const summary = new Map<string, { hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number }>()
  for (const l of invoice.lines) {
    const key = `${l.hsnCode ?? '—'}|${Number(l.gstRate)}`
    const row = summary.get(key) ?? { hsn: l.hsnCode ?? '—', rate: Number(l.gstRate), taxable: 0, cgst: 0, sgst: 0, igst: 0 }
    row.taxable += Number(l.taxableValue)
    row.cgst += Number(l.cgst)
    row.sgst += Number(l.sgst)
    row.igst += Number(l.igst)
    summary.set(key, row)
  }
  for (const c of invoice.charges) {
    summary.set(`charge|${c.id}`, {
      hsn: c.chargeType.name,
      rate: Number(c.gstRate),
      taxable: Number(c.amount),
      cgst: Number(c.cgst),
      sgst: Number(c.sgst),
      igst: Number(c.igst),
    })
  }

  res.json({
    success: true,
    data: {
      ...header,
      invoice,
      taxMode,
      placeOfSupplyState: stateName(invoice.placeOfSupplyCode),
      totalInWords: amountInWords(Number(invoice.totalAmount)),
      taxInWords: amountInWords(round2(Number(invoice.cgst) + Number(invoice.sgst) + Number(invoice.igst))),
      hsnSummary: [...summary.values()].map((r) => ({
        ...r,
        taxable: round2(r.taxable),
        cgst: round2(r.cgst),
        sgst: round2(r.sgst),
        igst: round2(r.igst),
      })),
    },
  })
})

/**
 * POST /api/sales/invoices
 *
 * Bills a dispatched challan. Checked and priced first, so a refused invoice
 * never takes a number.
 */
/** Bills a challan inside the caller's transaction. Exported for the checks that roll it back. */
export async function createInvoice(tx: Prisma.TransactionClient, data: InvoiceInput, userId: string) {
  const dc = await loadBillable(tx, data.dcId)
  const order = dc.so
  const priced = await priceInvoice(tx, dc, data)
  const invoiceDate = data.invoiceDate ?? new Date()
  if (invoiceDate < new Date(order.orderDate.toDateString())) {
    throw new AppError(`The invoice cannot be dated before the order, ${order.soNumber}`, 400, 'BEFORE_ORDER')
  }
  const invoiceNumber = await nextDocumentNumber(tx, 'INV', invoiceDate)
  const created = await tx.salesInvoice.create({
    data: {
      invoiceNumber,
      soId: order.id,
      dcId: dc.id,
      customerId: order.customerId,
      invoiceDate,
      dueDate: data.dueDate ?? addDays(invoiceDate, order.customer.creditDays ?? 0),
      placeOfSupplyCode: priced.placeOfSupplyCode,
      brokerId: order.brokerId,
      brokeragePercent: priced.brokeragePercent,
      brokerageAmount: priced.brokerageAmount,
      subtotal: priced.subtotal,
      discountAmount: priced.discountAmount,
      taxableAmount: priced.taxableAmount,
      cgst: priced.cgst,
      sgst: priced.sgst,
      igst: priced.igst,
      otherCharges: priced.otherCharges,
      roundOff: priced.roundOff,
      totalAmount: priced.totalAmount,
      paidAmount: 0,
      balanceAmount: priced.totalAmount,
      status: 'UNPAID',
      billingAddress: data.billingAddress ?? order.billingAddress ?? null,
      shippingAddress: data.shippingAddress ?? dc.deliveryAddress ?? order.deliveryAddress ?? null,
      transporter: data.transporter ?? dc.transporter ?? null,
      vehicleNumber: data.vehicleNumber?.toUpperCase() ?? dc.vehicleNumber ?? null,
      lrNumber: data.lrNumber ?? dc.lrNumber ?? null,
      eWayBillNumber: data.eWayBillNumber ?? dc.eWayBillNumber ?? null,
      eWayBillDate: data.eWayBillDate ?? null,
      notes: data.notes ?? null,
      terms: data.terms ?? order.terms ?? null,
      createdById: userId,
      lines: { create: priced.lines },
      charges: { create: priced.charges },
    },
  })
  // An e-way bill typed here belongs on the challan too, which travels with the goods.
  if (data.eWayBillNumber && !dc.eWayBillNumber) {
    await tx.deliveryChallan.update({ where: { id: dc.id }, data: { eWayBillNumber: data.eWayBillNumber } })
  }
  return tx.salesInvoice.findUniqueOrThrow({ where: { id: created.id }, include: invoiceInclude })
}

/**
 * POST /api/sales/invoices
 *
 * Bills a dispatched challan. Checked and priced first, so a refused invoice
 * never takes a number.
 */
router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = invoiceSchema.parse(req.body)
  const invoice = await prisma.$transaction((tx) => createInvoice(tx, data, req.user!.id), { timeout: 30_000 })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'SalesInvoice', entityId: invoice.id, after: invoice })
  res.status(201).json({
    success: true,
    message: `${invoice.invoiceNumber} raised for ${invoice.dc?.dcNumber ?? 'the challan'} — ₹${Number(invoice.totalAmount).toLocaleString('en-IN')}`,
    data: invoice,
  })
})

const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(500) })

/**
 * POST /api/sales/invoices/:id/cancel
 *
 * A wrong invoice is called off with a reason, while nothing has been
 * received or credited against it. It keeps its number, marked cancelled,
 * and the challan can be billed again.
 */
/** Calls an invoice off inside the caller's transaction. */
export async function cancelInvoice(tx: Prisma.TransactionClient, id: string, userId: string, reason: string) {
  const before = await tx.salesInvoice.findUnique({ where: { id }, include: invoiceInclude })
  if (!before) throw new AppError('Invoice not found', 404, 'NOT_FOUND')
  if (before.status === 'CANCELLED') throw new AppError(`${before.invoiceNumber} is already cancelled`, 409, 'ALREADY_CANCELLED')
  if (Number(before.paidAmount) > 0 || before._count.payments > 0) {
    throw new AppError(`${before.invoiceNumber} has money received against it. Raise a credit note instead.`, 409, 'HAS_PAYMENTS')
  }
  if (before._count.creditNotes > 0) {
    throw new AppError(`${before.invoiceNumber} has a credit note against it and cannot be cancelled`, 409, 'HAS_CREDIT_NOTES')
  }
  const after = await tx.salesInvoice.update({
    where: { id: before.id },
    data: { status: 'CANCELLED', balanceAmount: 0, cancelledAt: new Date(), cancelledById: userId, cancelReason: reason },
    include: invoiceInclude,
  })
  return { before, after }
}

router.post('/:id/cancel', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const { before, after } = await prisma.$transaction((tx) => cancelInvoice(tx, req.params.id, req.user!.id, reason))
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'SalesInvoice', entityId: after.id, before, after })
  res.json({
    success: true,
    message: `${after.invoiceNumber} cancelled.${after.dc ? ` ${after.dc.dcNumber} can be billed again.` : ''}`,
    data: after,
  })
})

export default router
