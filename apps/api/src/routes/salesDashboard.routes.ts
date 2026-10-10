import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { requirePermission } from '../middleware/auth'

/**
 * GET /api/sales/dashboard?from=&to=&brandId=&customerId=
 *
 * The Sales dashboard in one read, in three parts:
 *
 *   - kpis and analysis: what happened in the chosen period — orders booked,
 *     goods sent, invoiced (less credit notes), money collected; the trend
 *     bucket by bucket; customers, styles, sizes, brands, salespeople and
 *     brokers; the quotation funnel; a scorecard per customer.
 *   - now: what stands today, whatever the period — the open order book and
 *     when it is due, what customers owe and how old it is, and the lists to
 *     act on: late orders, orders due soon, overdue invoices, challans gone
 *     without an invoice, quotations about to lapse, orders on credit hold.
 *   - options: the brands and customers the page can be narrowed to.
 *
 * Values are before GST unless named withGst. A brand narrows invoices,
 * credit notes and receipts through the order behind them, so an invoice
 * made without an order only shows under "All brands".
 *
 * Mounted at /api/sales/dashboard, ahead of /api/sales.
 */
const router = Router()
const round2 = (n: number) => Math.round(n * 100) / 100
const DAY = 86_400_000
const OPEN = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] as const
const BOOKED = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED', 'COMPLETED'] as const
const SENT_DC = ['DISPATCHED', 'DELIVERED'] as const
const STATUS_LABEL: Record<string, string> = { CONFIRMED: 'Confirmed', IN_PRODUCTION: 'In production', PARTIALLY_DISPATCHED: 'Part sent' }

const ymd = /^\d{4}-\d{2}-\d{2}$/
const querySchema = z.object({
  from: z.string().regex(ymd).optional(),
  to: z.string().regex(ymd).optional(),
  brandId: z.string().min(1).optional(),
  customerId: z.string().min(1).optional(),
})

const localDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const change = (now: number, before: number) => (before > 0 ? round2((now - before) / before) : null)

type Bucket = 'day' | 'week' | 'month'
/** The bucket a date falls in: the day, the Monday of its week, or the first of its month. */
function bucketStart(d: Date, b: Bucket) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (b === 'week') x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  if (b === 'month') x.setDate(1)
  return x
}
function bucketLabel(d: Date, b: Bucket) {
  if (b === 'month') return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

type Db = Prisma.TransactionClient | typeof prisma
export type DashboardQuery = z.infer<typeof querySchema>

/** Everything the dashboard shows, read through `db` so a test can run it inside a transaction. */
export async function salesDashboard(db: Db, q: DashboardQuery) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = q.from ? localDay(q.from) : new Date(today.getTime() - 29 * DAY)
  const last = q.to ? localDay(q.to) : today
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1)
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY))
  const prevStart = new Date(start.getTime() - days * DAY)
  const bucket: Bucket = days <= 31 ? 'day' : days <= 120 ? 'week' : 'month'
  const inPeriod = { gte: start, lt: end }
  const inPrev = { gte: prevStart, lt: start }
  const week = new Date(today.getTime() + 7 * DAY)
  const fortnight = new Date(today.getTime() + 14 * DAY)

  // One filter for each kind of document, from the brand and customer picked.
  const soWhere: Prisma.SalesOrderWhereInput = { ...(q.brandId && { brandId: q.brandId }), ...(q.customerId && { customerId: q.customerId }) }
  const invWhere: Prisma.SalesInvoiceWhereInput = { ...(q.customerId && { customerId: q.customerId }), ...(q.brandId && { so: { brandId: q.brandId } }) }
  const cnWhere: Prisma.CreditNoteWhereInput = { status: 'ISSUED', ...(q.customerId && { customerId: q.customerId }), ...(q.brandId && { invoice: { so: { brandId: q.brandId } } }) }
  const dcWhere: Prisma.DeliveryChallanWhereInput = q.brandId || q.customerId ? { so: soWhere } : {}
  const qtWhere: Prisma.SalesQuotationWhereInput = { ...(q.brandId && { brandId: q.brandId }), ...(q.customerId && { customerId: q.customerId }) }

  /** Money in: whole receipts, or under a brand the part of each set against that brand's invoices. */
  const receiptsIn = async (range: { gte: Date; lt: Date }) =>
    q.brandId
      ? (
          await db.paymentReceiptAllocation.findMany({
            where: { invoice: { so: { brandId: q.brandId } }, receipt: { status: 'POSTED', receiptDate: range, ...(q.customerId && { customerId: q.customerId }) } },
            select: { amount: true, receiptId: true, receipt: { select: { receiptDate: true, customerId: true } } },
          })
        ).map((a) => ({ id: a.receiptId, date: a.receipt.receiptDate, customerId: a.receipt.customerId, amount: Number(a.amount) }))
      : (
          await db.paymentReceipt.findMany({
            where: { status: 'POSTED', receiptDate: range, ...(q.customerId && { customerId: q.customerId }) },
            select: { id: true, receiptDate: true, customerId: true, amount: true },
          })
        ).map((r) => ({ id: r.id, date: r.receiptDate, customerId: r.customerId, amount: Number(r.amount) }))

  const [
    orders,
    ordersPrev,
    invoices,
    invoicesPrev,
    credits,
    creditsPrev,
    receipts,
    receiptsPrev,
    openLines,
    openInvoices,
    challans,
    unbilled,
    quotes,
    quotesLapsing,
    creditHold,
    lastOrders,
    customers,
    brands,
  ] = await Promise.all([
    db.salesOrder.findMany({
      where: { ...soWhere, status: { in: [...BOOKED] }, orderDate: inPeriod },
      select: {
        id: true,
        orderDate: true,
        taxableAmount: true,
        customerId: true,
        isJobWork: true,
        salesperson: true,
        brand: { select: { id: true, name: true } },
        broker: { select: { name: true } },
        lines: {
          select: {
            totalQty: true,
            amount: true,
            styleCode: true,
            color: true,
            item: { select: { name: true, style: { select: { code: true, name: true, category: true } } } },
            sizes: { select: { qty: true, size: { select: { code: true, sequence: true } } } },
          },
        },
      },
    }),
    db.salesOrder.aggregate({ where: { ...soWhere, status: { in: [...BOOKED] }, orderDate: inPrev }, _sum: { taxableAmount: true } }),
    db.salesInvoice.findMany({
      where: { ...invWhere, status: { not: 'CANCELLED' }, invoiceDate: inPeriod },
      select: { invoiceDate: true, taxableAmount: true, totalAmount: true, customerId: true },
    }),
    db.salesInvoice.aggregate({ where: { ...invWhere, status: { not: 'CANCELLED' }, invoiceDate: inPrev }, _sum: { taxableAmount: true } }),
    db.creditNote.findMany({ where: { ...cnWhere, noteDate: inPeriod }, select: { noteDate: true, taxableAmount: true, customerId: true } }),
    db.creditNote.aggregate({ where: { ...cnWhere, noteDate: inPrev }, _sum: { taxableAmount: true } }),
    receiptsIn(inPeriod),
    receiptsIn(inPrev),
    db.salesOrderLine.findMany({
      where: { pendingQty: { gt: 0 }, so: { ...soWhere, status: { in: [...OPEN] } } },
      select: {
        pendingQty: true,
        unitPrice: true,
        discount: true,
        so: { select: { id: true, soNumber: true, status: true, deliveryDate: true, customer: { select: { name: true } } } },
      },
    }),
    db.salesInvoice.findMany({
      where: { ...invWhere, status: { in: ['UNPAID', 'PARTIAL'] } },
      select: { id: true, invoiceNumber: true, invoiceDate: true, dueDate: true, balanceAmount: true, customer: { select: { id: true, name: true } } },
    }),
    db.deliveryChallan.findMany({
      where: { ...dcWhere, status: { in: [...SENT_DC] }, dcDate: inPeriod },
      select: { dcDate: true, so: { select: { deliveryDate: true } }, lines: { select: { qty: true, soLine: { select: { unitPrice: true, discount: true } } } } },
    }),
    db.deliveryChallan.findMany({
      where: { ...dcWhere, status: { in: [...SENT_DC] }, invoices: { none: { status: { not: 'CANCELLED' } } } },
      select: { id: true, dcNumber: true, dcDate: true, so: { select: { soNumber: true, customer: { select: { name: true } } } }, lines: { select: { qty: true } } },
      orderBy: { dcDate: 'asc' },
    }),
    db.salesQuotation.findMany({
      where: { ...qtWhere, quoteDate: inPeriod },
      select: { status: true, validUntil: true, taxableAmount: true, lostReason: true },
    }),
    db.salesQuotation.findMany({
      where: { ...qtWhere, status: 'SENT', validUntil: { lte: week } },
      select: { id: true, quoteNumber: true, validUntil: true, taxableAmount: true, customer: { select: { name: true } } },
      orderBy: { validUntil: 'asc' },
    }),
    db.salesOrder.findMany({
      where: { ...soWhere, status: 'DRAFT', sentForApprovalAt: { not: null } },
      select: { id: true, soNumber: true, taxableAmount: true, sentForApprovalAt: true, customer: { select: { name: true } } },
      orderBy: { sentForApprovalAt: 'asc' },
    }),
    db.salesOrder.groupBy({ by: ['customerId'], where: { ...soWhere, status: { in: [...BOOKED] } }, _max: { orderDate: true } }),
    db.customer.findMany({ where: { isActive: true }, select: { id: true, name: true, creditLimit: true }, orderBy: { name: 'asc' } }),
    db.brand.findMany({ where: { isActive: true }, select: { id: true, name: true, type: true }, orderBy: { name: 'asc' } }),
  ])

  const nameOf = new Map(customers.map((c) => [c.id, c.name]))
  const limitOf = new Map(customers.map((c) => [c.id, c.creditLimit != null ? Number(c.creditLimit) : null]))
  const net = (price: unknown, disc: unknown) => Number(price) * (1 - Number(disc) / 100)

  // ── This period ──
  const booked = round2(orders.reduce((s, o) => s + Number(o.taxableAmount), 0))
  const pieces = orders.reduce((s, o) => s + o.lines.reduce((t, l) => t + Number(l.totalQty), 0), 0)
  const credited = round2(credits.reduce((s, c) => s + Number(c.taxableAmount), 0))
  const invoiced = round2(invoices.reduce((s, i) => s + Number(i.taxableAmount), 0) - credited)
  const invoicedGst = round2(invoices.reduce((s, i) => s + Number(i.totalAmount), 0))
  const collected = round2(receipts.reduce((s, r) => s + r.amount, 0))
  const dispatchedPieces = challans.reduce((s, c) => s + c.lines.reduce((t, l) => t + Number(l.qty), 0), 0)
  const dispatchedValue = round2(challans.reduce((s, c) => s + c.lines.reduce((t, l) => t + Number(l.qty) * (l.soLine ? net(l.soLine.unitPrice, l.soLine.discount) : 0), 0), 0))
  let onTime = 0
  let late = 0
  for (const c of challans) {
    if (!c.so.deliveryDate) continue
    if (bucketStart(c.dcDate, 'day') <= c.so.deliveryDate) onTime++
    else late++
  }

  // ── The trend, bucket by bucket ──
  const buckets: Array<{ key: string; label: string; booked: number; invoiced: number; collected: number; orders: number }> = []
  const at = new Map<string, (typeof buckets)[number]>()
  for (let d = bucketStart(start, bucket); d < end; ) {
    const row = { key: iso(d), label: bucketLabel(d, bucket), booked: 0, invoiced: 0, collected: 0, orders: 0 }
    buckets.push(row)
    at.set(row.key, row)
    d = bucket === 'day' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) : bucket === 'week' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7) : new Date(d.getFullYear(), d.getMonth() + 1, 1)
  }
  const into = (date: Date) => at.get(iso(bucketStart(date, bucket)))
  for (const o of orders) {
    const b = into(o.orderDate)
    if (b) {
      b.booked += Number(o.taxableAmount)
      b.orders++
    }
  }
  for (const i of invoices) {
    const b = into(i.invoiceDate)
    if (b) b.invoiced += Number(i.taxableAmount)
  }
  for (const c of credits) {
    const b = into(c.noteDate)
    if (b) b.invoiced -= Number(c.taxableAmount)
  }
  for (const r of receipts) {
    const b = into(r.date)
    if (b) b.collected += r.amount
  }
  for (const b of buckets) {
    b.booked = round2(b.booked)
    b.invoiced = round2(b.invoiced)
    b.collected = round2(b.collected)
  }

  // ── Customers, brands, people ──
  const tally = <K>(rows: Array<{ key: K; value: number }>) => {
    const m = new Map<K, { value: number; orders: number }>()
    for (const r of rows) {
      const t = m.get(r.key) ?? { value: 0, orders: 0 }
      t.value += r.value
      t.orders++
      m.set(r.key, t)
    }
    return [...m.entries()].map(([key, t]) => ({ key, value: round2(t.value), orders: t.orders })).sort((a, b) => b.value - a.value)
  }
  const byCustomer = tally(orders.map((o) => ({ key: o.customerId, value: Number(o.taxableAmount) })))
  const topCustomers = byCustomer.slice(0, 7).map((c) => ({ id: c.key, name: nameOf.get(c.key) ?? '—', value: c.value, orders: c.orders }))
  const rest = byCustomer.slice(7)
  if (rest.length) topCustomers.push({ id: '', name: `${rest.length} more`, value: round2(rest.reduce((s, c) => s + c.value, 0)), orders: rest.reduce((s, c) => s + c.orders, 0) })

  const brandMix = tally(orders.map((o) => ({ key: o.isJobWork ? 'Job work' : o.brand.name, value: Number(o.taxableAmount) }))).map((b) => ({ name: b.key, value: b.value, orders: b.orders }))
  const salespeople = tally(orders.map((o) => ({ key: o.salesperson?.trim() || 'Not named', value: Number(o.taxableAmount) }))).map((b) => ({ name: b.key, value: b.value, orders: b.orders }))
  const brokers = tally(orders.map((o) => ({ key: o.broker?.name ?? 'Direct (no broker)', value: Number(o.taxableAmount) }))).map((b) => ({ name: b.key, value: b.value, orders: b.orders }))

  // ── Styles, colours and sizes ──
  const styleCodes = [...new Set(orders.flatMap((o) => o.lines.map((l) => l.styleCode?.trim()).filter((c): c is string => !!c)))]
  const styleRows = styleCodes.length
    ? await db.style.findMany({ where: { code: { in: styleCodes, mode: 'insensitive' } }, select: { code: true, name: true, category: true } })
    : []
  const styleInfo = new Map(styleRows.map((s) => [s.code.toLowerCase(), s]))
  const groups = new Map<string, Map<string, number>>()
  const lineMix = new Map<string, { style: string; name: string; color: string; pieces: number; value: number; orders: Set<string> }>()
  const sizeMix = new Map<string, { label: string; sequence: number; pieces: number }>()
  for (const o of orders) {
    for (const l of o.lines) {
      const typed = l.styleCode?.trim() ? styleInfo.get(l.styleCode.trim().toLowerCase()) : undefined
      const st = typed ?? l.item.style ?? null
      const style = st?.code ?? l.styleCode?.trim() ?? l.item.name
      const category = st?.category?.trim() || 'Other'
      const g = groups.get(category) ?? new Map<string, number>()
      g.set(style, (g.get(style) ?? 0) + Number(l.amount))
      groups.set(category, g)
      const colour = l.color?.trim() || '—'
      const k = `${style}|${colour}`
      const row = lineMix.get(k) ?? { style, name: st?.name ?? l.item.name, color: colour, pieces: 0, value: 0, orders: new Set<string>() }
      row.pieces += Number(l.totalQty)
      row.value += Number(l.amount)
      row.orders.add(o.id)
      lineMix.set(k, row)
      for (const s of l.sizes) {
        const z = sizeMix.get(s.size.code) ?? { label: s.size.code, sequence: s.size.sequence, pieces: 0 }
        z.pieces += Number(s.qty)
        z.sequence = Math.min(z.sequence, s.size.sequence)
        sizeMix.set(s.size.code, z)
      }
    }
  }
  const styleTree = [...groups.entries()]
    .map(([name, g]) => ({
      id: name,
      name,
      value: round2([...g.values()].reduce((s, v) => s + v, 0)),
      children: [...g.entries()].map(([n, v]) => ({ name: n, value: round2(v) })).sort((a, b) => b.value - a.value),
    }))
    .sort((a, b) => b.value - a.value)
  const lineTotal = [...lineMix.values()].reduce((s, r) => s + r.value, 0)
  const topStyles = [...lineMix.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
    .map((r) => ({
      style: r.style,
      name: r.name,
      color: r.color,
      pieces: r.pieces,
      value: round2(r.value),
      orders: r.orders.size,
      rate: r.pieces ? round2(r.value / r.pieces) : 0,
      share: lineTotal ? Math.round((r.value / lineTotal) * 1000) / 10 : 0,
    }))
  const sizes = [...sizeMix.values()].sort((a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label, 'en', { numeric: true })).map((s) => ({ label: s.label, pieces: s.pieces }))

  // ── Quotations ──
  const quoted = round2(quotes.reduce((s, x) => s + Number(x.taxableAmount), 0))
  const qCount = (pred: (x: (typeof quotes)[number]) => boolean) => quotes.filter(pred)
  const won = qCount((x) => x.status === 'WON')
  const lost = qCount((x) => x.status === 'LOST')
  const expired = qCount((x) => x.status === 'SENT' && !!x.validUntil && x.validUntil < today)
  const waiting = qCount((x) => x.status === 'SENT' && !(x.validUntil && x.validUntil < today))
  const drafts = qCount((x) => x.status === 'DRAFT')
  const sumQ = (rows: typeof quotes) => round2(rows.reduce((s, x) => s + Number(x.taxableAmount), 0))
  const reasons = tally(lost.map((x) => ({ key: x.lostReason?.trim() || 'No reason given', value: 1 }))).map((r) => ({ reason: r.key, count: r.orders }))

  // ── Today: the open order book and when it is due ──
  const openOrders = new Map<string, { id: string; soNumber: string; status: string; customer: string; deliveryDate: Date | null; pending: number; value: number }>()
  for (const l of openLines) {
    const o = openOrders.get(l.so.id) ?? { id: l.so.id, soNumber: l.so.soNumber, status: l.so.status, customer: l.so.customer.name, deliveryDate: l.so.deliveryDate, pending: 0, value: 0 }
    o.pending += Number(l.pendingQty)
    o.value += Number(l.pendingQty) * net(l.unitPrice, l.discount)
    openOrders.set(l.so.id, o)
  }
  const open = [...openOrders.values()].map((o) => ({ ...o, value: round2(o.value) }))
  const byStatus = (['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] as const).map((s) => {
    const rows = open.filter((o) => o.status === s)
    return { key: s, label: STATUS_LABEL[s], orders: rows.length, value: round2(rows.reduce((t, o) => t + o.value, 0)) }
  })
  const slot = (o: (typeof open)[number]) =>
    !o.deliveryDate ? 'none' : o.deliveryDate < today ? 'late' : o.deliveryDate < week ? 'week' : o.deliveryDate < fortnight ? 'next' : 'later'
  const schedule = [
    { key: 'late', label: 'Late', hint: 'Past the delivery date', tone: 'rose' },
    { key: 'week', label: 'This week', hint: 'Due in the next 7 days', tone: 'amber' },
    { key: 'next', label: 'Next week', hint: 'Due in 8 to 14 days', tone: 'blue' },
    { key: 'later', label: 'Later', hint: 'Due after two weeks', tone: 'teal' },
    { key: 'none', label: 'No date', hint: 'No delivery date on the order', tone: 'slate' },
  ].map((s) => {
    const rows = open.filter((o) => slot(o) === s.key)
    return { ...s, orders: rows.length, pieces: rows.reduce((t, o) => t + o.pending, 0), value: round2(rows.reduce((t, o) => t + o.value, 0)) }
  })
  const dated = (rows: typeof open) => [...rows].sort((a, b) => (a.deliveryDate?.getTime() ?? 0) - (b.deliveryDate?.getTime() ?? 0))

  // ── Today: what customers owe, and how old it is ──
  const daysLate = (due: Date | null) => (due ? Math.floor((today.getTime() - new Date(due).setHours(0, 0, 0, 0)) / DAY) : 0)
  const ageing = [
    { key: 'current', label: 'Not due', tone: 'emerald', min: -Infinity, max: 0 },
    { key: 'd30', label: '1–30 days', tone: 'amber', min: 1, max: 30 },
    { key: 'd60', label: '31–60', tone: 'orange', min: 31, max: 60 },
    { key: 'd90', label: '61–90', tone: 'rose', min: 61, max: 90 },
    { key: 'd90plus', label: '90+', tone: 'rose', min: 91, max: Infinity },
  ].map((a) => {
    const rows = openInvoices.filter((i) => {
      const d = daysLate(i.dueDate)
      return d >= a.min && d <= a.max
    })
    return { key: a.key, label: a.label, tone: a.tone, invoices: rows.length, value: round2(rows.reduce((s, i) => s + Number(i.balanceAmount), 0)) }
  })
  const owed = round2(openInvoices.reduce((s, i) => s + Number(i.balanceAmount), 0))
  const overdueRows = openInvoices.filter((i) => i.dueDate && daysLate(i.dueDate) > 0).sort((a, b) => (a.dueDate?.getTime() ?? 0) - (b.dueDate?.getTime() ?? 0))

  // ── A scorecard per customer ──
  const card = new Map<string, { booked: number; orders: number; invoiced: number; collected: number; owed: number; overdue: number }>()
  const cardOf = (id: string) => {
    const c = card.get(id) ?? { booked: 0, orders: 0, invoiced: 0, collected: 0, owed: 0, overdue: 0 }
    card.set(id, c)
    return c
  }
  for (const o of orders) {
    const c = cardOf(o.customerId)
    c.booked += Number(o.taxableAmount)
    c.orders++
  }
  for (const i of invoices) cardOf(i.customerId).invoiced += Number(i.taxableAmount)
  for (const n of credits) cardOf(n.customerId).invoiced -= Number(n.taxableAmount)
  for (const r of receipts) cardOf(r.customerId).collected += r.amount
  for (const i of openInvoices) {
    const c = cardOf(i.customer.id)
    c.owed += Number(i.balanceAmount)
    if (i.dueDate && daysLate(i.dueDate) > 0) c.overdue += Number(i.balanceAmount)
  }
  const lastOrderOf = new Map(lastOrders.map((l) => [l.customerId, l._max.orderDate]))
  const scorecard = [...card.entries()]
    .map(([id, c]) => {
      const limit = limitOf.get(id) ?? null
      return {
        id,
        name: nameOf.get(id) ?? '—',
        orders: c.orders,
        booked: round2(c.booked),
        invoiced: round2(c.invoiced),
        collected: round2(c.collected),
        owed: round2(c.owed),
        overdue: round2(c.overdue),
        creditLimit: limit,
        creditUsed: limit ? Math.round((c.owed / limit) * 100) : null,
        lastOrder: lastOrderOf.get(id) ?? null,
      }
    })
    .sort((a, b) => b.booked + b.owed - (a.booked + a.owed))
    .slice(0, 15)

  const unbilledRows = unbilled.map((c) => ({
    id: c.id,
    dcNumber: c.dcNumber,
    dcDate: c.dcDate,
    soNumber: c.so.soNumber,
    customer: c.so.customer.name,
    pieces: c.lines.reduce((s, l) => s + Number(l.qty), 0),
  }))
  const TAKE = 10

  return {
    period: { from: iso(start), to: iso(last), days, bucket },
    options: { brands, customers: customers.map((c) => ({ id: c.id, name: c.name })) },
    kpis: {
      booked: { value: booked, orders: orders.length, pieces, change: change(booked, Number(ordersPrev._sum.taxableAmount ?? 0)), avgOrder: orders.length ? round2(booked / orders.length) : 0 },
      dispatched: { pieces: dispatchedPieces, value: dispatchedValue, challans: challans.length },
      invoiced: {
        value: invoiced,
        withGst: invoicedGst,
        invoices: invoices.length,
        credited,
        change: change(invoiced, Number(invoicesPrev._sum.taxableAmount ?? 0) - Number(creditsPrev._sum.taxableAmount ?? 0)),
      },
      collected: {
        value: collected,
        receipts: new Set(receipts.map((r) => r.id)).size,
        change: change(collected, receiptsPrev.reduce((s, r) => s + r.amount, 0)),
        rate: invoicedGst > 0 ? Math.round((collected / invoicedGst) * 100) : null,
      },
      onTime: { onTime, late, rate: onTime + late ? Math.round((onTime / (onTime + late)) * 100) : null },
    },
    analysis: {
      trend: buckets,
      customers: topCustomers,
      brandMix,
      salespeople,
      brokers,
      styleTree,
      topStyles,
      sizes,
      pipeline: { quoted, booked, dispatched: dispatchedValue, invoiced, collected },
      quotes: {
        made: quotes.length,
        value: quoted,
        drafts: drafts.length,
        waiting: { count: waiting.length, value: sumQ(waiting) },
        won: { count: won.length, value: sumQ(won) },
        lost: { count: lost.length, value: sumQ(lost) },
        expired: { count: expired.length, value: sumQ(expired) },
        winRate: won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : null,
        reasons: reasons.slice(0, 5),
      },
      scorecard,
    },
    now: {
      book: { orders: open.length, pieces: open.reduce((s, o) => s + o.pending, 0), value: round2(open.reduce((s, o) => s + o.value, 0)), byStatus },
      schedule,
      receivables: {
        value: owed,
        invoices: openInvoices.length,
        overdue: { value: round2(overdueRows.reduce((s, i) => s + Number(i.balanceAmount), 0)), invoices: overdueRows.length },
        ageing,
      },
      lists: {
        late: dated(open.filter((o) => slot(o) === 'late')).slice(0, TAKE),
        dueSoon: dated(open.filter((o) => slot(o) === 'week' || slot(o) === 'next')).slice(0, TAKE),
        overdue: overdueRows.slice(0, TAKE).map((i) => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          customer: i.customer.name,
          customerId: i.customer.id,
          dueDate: i.dueDate,
          balance: Number(i.balanceAmount),
          days: daysLate(i.dueDate),
        })),
        toBill: unbilledRows.slice(0, TAKE),
        quotes: quotesLapsing.slice(0, TAKE).map((x) => ({
          id: x.id,
          quoteNumber: x.quoteNumber,
          customer: x.customer.name,
          validUntil: x.validUntil,
          value: Number(x.taxableAmount),
          expired: !!x.validUntil && x.validUntil < today,
        })),
        hold: creditHold.slice(0, TAKE).map((o) => ({ id: o.id, soNumber: o.soNumber, customer: o.customer.name, value: Number(o.taxableAmount), since: o.sentForApprovalAt })),
      },
      counts: {
        late: open.filter((o) => slot(o) === 'late').length,
        dueSoon: open.filter((o) => slot(o) === 'week' || slot(o) === 'next').length,
        overdue: overdueRows.length,
        toBill: unbilledRows.length,
        quotes: quotesLapsing.length,
        hold: creditHold.length,
      },
    },
  }
}

router.get('/', requirePermission('sales', 'view'), async (req, res) => {
  res.json({ success: true, data: await salesDashboard(prisma, querySchema.parse(req.query)) })
})

export default router
