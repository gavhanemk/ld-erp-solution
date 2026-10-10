import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { requirePermission } from '../middleware/auth'

/**
 * GET /api/sales/dashboard
 *
 * The Sales dashboard in one read: this month's orders, dispatches, invoices
 * and money in; what is still to send and still owed; six months of booked,
 * invoiced and received side by side; the biggest customers of the last year;
 * and the lists to act on — orders due soon, invoices overdue, challans not
 * billed, quotations unanswered.
 *
 * Mounted at /api/sales/dashboard, ahead of /api/sales.
 */
const router = Router()
const round2 = (n: number) => Math.round(n * 100) / 100

router.get('/', requirePermission('sales', 'view'), async (_req, res) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const sixMonths = new Date(today.getFullYear(), today.getMonth() - 5, 1)
  const yearAgo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate())
  const inTwoWeeks = new Date(today.getTime() + 14 * 86_400_000)
  const OPEN = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] as const
  const BOOKED = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED', 'COMPLETED'] as const

  const [
    bookedMonth,
    openLines,
    dispatchedMonth,
    invoicedMonth,
    receivedMonth,
    owed,
    overdue,
    ordersSix,
    invoicesSix,
    receiptsSix,
    creditsSix,
    topCustomers,
    dueSoon,
    overdueInvoices,
    toBill,
    quotesOpen,
    quotesExpired,
    creditHold,
  ] = await Promise.all([
    prisma.salesOrder.aggregate({ where: { status: { in: [...BOOKED] }, orderDate: { gte: monthStart } }, _count: true, _sum: { taxableAmount: true } }),
    prisma.salesOrderLine.findMany({
      where: { pendingQty: { gt: 0 }, so: { status: { in: [...OPEN] } } },
      select: { pendingQty: true, unitPrice: true, discount: true },
    }),
    prisma.deliveryChallanLine.aggregate({ where: { dc: { status: { in: ['DISPATCHED', 'DELIVERED'] }, dcDate: { gte: monthStart } } }, _sum: { qty: true } }),
    prisma.salesInvoice.aggregate({ where: { status: { not: 'CANCELLED' }, invoiceDate: { gte: monthStart } }, _count: true, _sum: { taxableAmount: true, totalAmount: true } }),
    prisma.paymentReceipt.aggregate({ where: { status: 'POSTED', receiptDate: { gte: monthStart } }, _count: true, _sum: { amount: true } }),
    prisma.salesInvoice.aggregate({ where: { status: { in: ['UNPAID', 'PARTIAL'] } }, _count: true, _sum: { balanceAmount: true } }),
    prisma.salesInvoice.aggregate({ where: { status: { in: ['UNPAID', 'PARTIAL'] }, dueDate: { lt: today } }, _count: true, _sum: { balanceAmount: true } }),
    prisma.salesOrder.findMany({ where: { status: { in: [...BOOKED] }, orderDate: { gte: sixMonths } }, select: { orderDate: true, taxableAmount: true } }),
    prisma.salesInvoice.findMany({ where: { status: { not: 'CANCELLED' }, invoiceDate: { gte: sixMonths } }, select: { invoiceDate: true, taxableAmount: true } }),
    prisma.paymentReceipt.findMany({ where: { status: 'POSTED', receiptDate: { gte: sixMonths } }, select: { receiptDate: true, amount: true } }),
    prisma.creditNote.findMany({ where: { status: 'ISSUED', noteDate: { gte: sixMonths } }, select: { noteDate: true, taxableAmount: true } }),
    prisma.salesInvoice.groupBy({
      by: ['customerId'],
      where: { status: { not: 'CANCELLED' }, invoiceDate: { gte: yearAgo } },
      _sum: { taxableAmount: true },
      orderBy: { _sum: { taxableAmount: 'desc' } },
      take: 8,
    }),
    prisma.salesOrder.findMany({
      where: { status: { in: [...OPEN] }, deliveryDate: { lte: inTwoWeeks }, lines: { some: { pendingQty: { gt: 0 } } } },
      select: { id: true, soNumber: true, deliveryDate: true, customer: { select: { name: true } }, lines: { select: { pendingQty: true } } },
      orderBy: { deliveryDate: 'asc' },
      take: 8,
    }),
    prisma.salesInvoice.findMany({
      where: { status: { in: ['UNPAID', 'PARTIAL'] }, dueDate: { lt: today } },
      select: { id: true, invoiceNumber: true, dueDate: true, balanceAmount: true, customer: { select: { id: true, name: true } } },
      orderBy: { dueDate: 'asc' },
      take: 8,
    }),
    prisma.deliveryChallan.count({ where: { status: { in: ['DISPATCHED', 'DELIVERED'] }, invoices: { none: { status: { not: 'CANCELLED' } } } } }),
    prisma.salesQuotation.aggregate({ where: { status: 'SENT', OR: [{ validUntil: null }, { validUntil: { gte: today } }] }, _count: true, _sum: { taxableAmount: true } }),
    prisma.salesQuotation.count({ where: { status: 'SENT', validUntil: { lt: today } } }),
    prisma.salesOrder.count({ where: { status: 'DRAFT', sentForApprovalAt: { not: null } } }),
  ])

  const names = topCustomers.length
    ? new Map((await prisma.customer.findMany({ where: { id: { in: topCustomers.map((t) => t.customerId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]))
    : new Map<string, string>()

  // Six months, oldest first, each with booked, invoiced (net of credit notes) and received.
  const months = Array.from({ length: 6 }, (_, i) => new Date(today.getFullYear(), today.getMonth() - 5 + i, 1))
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`
  const sumBy = <T,>(rows: T[], dateOf: (r: T) => Date, valueOf: (r: T) => number) => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(key(dateOf(r)), (m.get(key(dateOf(r))) ?? 0) + valueOf(r))
    return m
  }
  const booked = sumBy(ordersSix, (r) => r.orderDate, (r) => Number(r.taxableAmount))
  const invoiced = sumBy(invoicesSix, (r) => r.invoiceDate, (r) => Number(r.taxableAmount))
  const credited = sumBy(creditsSix, (r) => r.noteDate, (r) => Number(r.taxableAmount))
  const received = sumBy(receiptsSix, (r) => r.receiptDate, (r) => Number(r.amount))

  res.json({
    success: true,
    data: {
      month: {
        booked: { count: bookedMonth._count, value: Number(bookedMonth._sum.taxableAmount ?? 0) },
        dispatchedPieces: Number(dispatchedMonth._sum.qty ?? 0),
        invoiced: { count: invoicedMonth._count, value: Number(invoicedMonth._sum.taxableAmount ?? 0), withGst: Number(invoicedMonth._sum.totalAmount ?? 0) },
        received: { count: receivedMonth._count, value: Number(receivedMonth._sum.amount ?? 0) },
      },
      open: {
        pieces: openLines.reduce((s, l) => s + Number(l.pendingQty), 0),
        value: round2(openLines.reduce((s, l) => s + Number(l.pendingQty) * Number(l.unitPrice) * (1 - Number(l.discount) / 100), 0)),
      },
      owed: { count: owed._count, value: Number(owed._sum.balanceAmount ?? 0) },
      overdue: { count: overdue._count, value: Number(overdue._sum.balanceAmount ?? 0) },
      trend: months.map((d) => ({
        label: d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
        booked: round2(booked.get(key(d)) ?? 0),
        invoiced: round2((invoiced.get(key(d)) ?? 0) - (credited.get(key(d)) ?? 0)),
        received: round2(received.get(key(d)) ?? 0),
      })),
      topCustomers: topCustomers.map((t) => ({ name: names.get(t.customerId) ?? '—', value: Number(t._sum.taxableAmount ?? 0) })),
      dueSoon: dueSoon.map((o) => ({
        id: o.id,
        soNumber: o.soNumber,
        customer: o.customer.name,
        deliveryDate: o.deliveryDate,
        pending: o.lines.reduce((s, l) => s + Number(l.pendingQty), 0),
        late: !!o.deliveryDate && o.deliveryDate < today,
      })),
      overdueInvoices: overdueInvoices.map((i) => ({
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        customer: i.customer.name,
        customerId: i.customer.id,
        dueDate: i.dueDate,
        balance: Number(i.balanceAmount),
        days: i.dueDate ? Math.floor((today.getTime() - new Date(i.dueDate).setHours(0, 0, 0, 0)) / 86_400_000) : 0,
      })),
      toAct: {
        challansToBill: toBill,
        quotesOpen: { count: quotesOpen._count, value: Number(quotesOpen._sum.taxableAmount ?? 0) },
        quotesExpired,
        creditHold,
      },
    },
  })
})

export default router
