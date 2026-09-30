import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { requirePermission } from '../middleware/auth'

/*
 * The Purchase Order dashboard.
 *
 * Two halves, answering two different questions, and the split is the point:
 *
 *   - RIGHT NOW is operational: which orders are late, what is due this week,
 *     what is still sitting in draft. It is never limited to the period,
 *     because an order raised in March that is still late in September is
 *     exactly the one a buyer needs to see — a date filter would hide it.
 *   - THE PERIOD is analytical: what was ordered between two dates, from
 *     whom, how fast it came and how much of it has been billed and paid.
 *
 * The counting rules are the Purchase Order Status report's, so the two
 * screens cannot disagree: a cancelled receipt booked nothing in, a
 * short-closed line is settled rather than pending, and a reject still counts
 * as delivered (it is settled with a debit note, not owed by the order).
 *
 * Values are before GST throughout — line amounts, not order totals — so a
 * category filter can split an order by its lines, and ordered, received,
 * billed and paid are all measured in the same rupee.
 */

const MODULE = 'purchase'
const router = Router()

const DAY_MS = 86_400_000
const OPEN = new Set(['SENT', 'PARTIALLY_RECEIVED'])
const STATUS_WORDS: Record<string, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  PARTIALLY_RECEIVED: 'Part received',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
}

const r2 = (n: number) => Math.round(n * 100) / 100
const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const daysBetween = (a: Date, b: Date) =>
  Math.round((dayOf(b).getTime() - dayOf(a).getTime()) / DAY_MS)
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
const monthLabel = (key: string) => {
  const [y, m] = key.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
}
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The top n by value, the rest folded into one row so shares still add to the whole. */
function topWithRest<T extends { name: string; value: number }>(
  rows: T[],
  n: number,
  rest: (value: number, count: number) => T
): T[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value)
  if (sorted.length <= n) return sorted
  const tail = sorted.slice(n)
  return [...sorted.slice(0, n), rest(r2(tail.reduce((s, r) => s + r.value, 0)), tail.length)]
}

router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const q = req.query as Record<string, string | undefined>
  const today = dayOf(new Date())

  // The period. Blank means everything on record, as on every report.
  const from = q.from ? new Date(`${q.from}T00:00:00`) : null
  const to = q.to ? new Date(`${q.to}T23:59:59.999`) : null
  // The same length of time immediately before, for "up or down on last time".
  const span = from && to ? to.getTime() - from.getTime() : null
  const prevFrom = from && span != null ? new Date(from.getTime() - span - 1) : null
  const prevTo = from ? new Date(from.getTime() - 1) : null

  const supplierId = q.supplierId || undefined
  const categoryId = q.categoryId || undefined

  /** A line belongs to the chosen category if its item's category, or that category's parent, is it. */
  const lineInCategory: Prisma.PurchaseOrderLineWhereInput | undefined = categoryId
    ? {
        item: {
          OR: [{ categoryId }, { category: { parentId: categoryId } }],
        },
      }
    : undefined

  const base: Prisma.PurchaseOrderWhereInput = {
    deletedAt: null,
    ...(supplierId ? { supplierId } : {}),
    ...(lineInCategory ? { lines: { some: lineInCategory } } : {}),
  }

  // One read: the period (and the one before it, for comparison), every order
  // still open whenever it was raised, and the last year's orders — goods
  // received and not yet billed are somebody's job whatever period is picked.
  const earliest = prevFrom ?? from
  const yearAgo = new Date(today.getTime() - 365 * DAY_MS)
  const orders = await prisma.purchaseOrder.findMany({
    where: {
      ...base,
      // With no dates at all there is nothing to OR: everything is wanted.
      // (An empty `{}` inside OR does not mean "true" to Prisma — it is
      // dropped, which left only the open orders and hid every completed one.)
      ...(earliest || to
        ? {
            OR: [
              { poDate: { ...(earliest ? { gte: earliest } : {}), ...(to ? { lte: to } : {}) } },
              { status: { in: ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] as const } },
              { poDate: { gte: yearAgo } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      poNumber: true,
      poDate: true,
      deliveryDate: true,
      status: true,
      supplier: { select: { id: true, name: true } },
      lines: {
        ...(lineInCategory ? { where: lineInCategory } : {}),
        select: {
          qty: true,
          unitRate: true,
          amount: true,
          shortClosed: true,
          item: {
            select: {
              id: true,
              name: true,
              uom: { select: { symbol: true } },
              category: {
                select: { id: true, name: true, parent: { select: { id: true, name: true } } },
              },
            },
          },
          grnLines: {
            select: {
              receivedQty: true,
              grn: { select: { id: true, status: true, grnDate: true } },
              billLines: {
                select: {
                  taxableValue: true,
                  bill: { select: { status: true, totalAmount: true, paidAmount: true } },
                },
              },
            },
          },
        },
      },
    },
  })

  /* ---- Per order, the figures everything below is built from ---- */
  const rows = orders.map((o) => {
    let ordered = 0
    let received = 0
    let pending = 0
    let billed = 0
    let paid = 0
    const receipts = new Map<string, Date>()
    const items: Array<{
      id: string
      name: string
      uom: string
      category: { id: string; name: string }
      value: number
      qty: number
      rate: number
    }> = []

    for (const l of o.lines) {
      const qty = Number(l.qty)
      const amount = Number(l.amount)
      const live = l.grnLines.filter((g) => g.grn.status !== 'CANCELLED')
      const got = live.reduce((s, g) => s + Number(g.receivedQty), 0)
      ordered += amount
      if (qty > 0) {
        received += (Math.min(got, qty) / qty) * amount
        if (!l.shortClosed) pending += (Math.max(0, qty - got) / qty) * amount
      }
      for (const g of live) {
        receipts.set(g.grn.id, g.grn.grnDate)
        for (const b of g.billLines) {
          if (b.bill.status === 'CANCELLED') continue
          const value = Number(b.taxableValue)
          billed += value
          const total = Number(b.bill.totalAmount)
          const share = total > 0 ? Math.min(1, Math.max(0, Number(b.bill.paidAmount) / total)) : 0
          paid += value * share
        }
      }
      // Rolled up to the top of the tree: "Yarn", not "Yarn › 30s combed".
      const cat = l.item.category.parent ?? l.item.category
      items.push({
        id: l.item.id,
        name: l.item.name,
        uom: l.item.uom?.symbol ?? '',
        category: { id: cat.id, name: cat.name },
        value: amount,
        qty,
        rate: Number(l.unitRate),
      })
    }

    const receiptDates = [...receipts.values()].sort((a, b) => a.getTime() - b.getTime())
    const firstReceipt = receiptDates[0] ?? null
    const wanted = o.deliveryDate ? dayOf(o.deliveryDate) : null
    const onTime = wanted ? receiptDates.filter((d) => dayOf(d) <= wanted).length : 0
    const late = wanted ? receiptDates.length - onTime : 0

    return {
      id: o.id,
      poNumber: o.poNumber,
      poDate: o.poDate,
      deliveryDate: o.deliveryDate,
      status: o.status as string,
      supplier: o.supplier,
      ordered: r2(ordered),
      received: r2(received),
      pending: r2(pending),
      billed: r2(billed),
      paid: r2(paid),
      // Goods in the gate with no supplier's bill against them yet.
      unbilled: r2(Math.max(0, received - billed)),
      receiptDates,
      firstReceipt,
      onTime,
      late,
      items,
    }
  })

  const inPeriod = (d: Date) => (!from || d >= from) && (!to || d <= to)
  const period = rows.filter((r) => inPeriod(r.poDate))
  const live = period.filter((r) => r.status !== 'CANCELLED')
  const prev =
    prevFrom && prevTo
      ? rows.filter((r) => r.status !== 'CANCELLED' && r.poDate >= prevFrom && r.poDate <= prevTo)
      : null

  /* =================== RIGHT NOW — never limited to the period =================== */
  const open = rows.filter((r) => OPEN.has(r.status) && r.pending > 0)
  const drafts = rows.filter((r) => r.status === 'DRAFT')
  const overdue = open
    .filter((r) => r.deliveryDate && dayOf(r.deliveryDate) < today)
    .map((r) => ({ ...r, daysLate: daysBetween(r.deliveryDate as Date, today) }))
    .sort((a, b) => b.daysLate - a.daysLate)
  const dueSoon = open
    .filter((r) => r.deliveryDate && dayOf(r.deliveryDate) >= today)
    .map((r) => ({ ...r, dueIn: daysBetween(today, r.deliveryDate as Date) }))
    .filter((r) => r.dueIn <= 14)
    .sort((a, b) => a.dueIn - b.dueIn)

  // When the outstanding goods are expected — the week-by-week load on the gate.
  const schedule = [
    { key: 'overdue', label: 'Overdue', tone: 'bad', test: (d: number | null) => d != null && d < 0 },
    { key: 'week', label: 'This week', tone: 'warn', test: (d: number | null) => d != null && d >= 0 && d <= 7 },
    { key: 'next', label: 'Next week', tone: 'info', test: (d: number | null) => d != null && d > 7 && d <= 14 },
    { key: 'weeks34', label: 'In 3–4 weeks', tone: 'info', test: (d: number | null) => d != null && d > 14 && d <= 28 },
    { key: 'later', label: 'Later', tone: 'info', test: (d: number | null) => d != null && d > 28 },
    { key: 'none', label: 'No date given', tone: 'neutral', test: (d: number | null) => d == null },
  ].map((b) => {
    const hit = open.filter((r) => b.test(r.deliveryDate ? daysBetween(today, r.deliveryDate) : null))
    return { key: b.key, label: b.label, tone: b.tone, orders: hit.length, value: r2(hit.reduce((s, r) => s + r.pending, 0)) }
  })

  // How long the open value has been waiting, counted from the order date.
  const ageing = [
    { label: '0–15 days', min: 0, max: 15 },
    { label: '16–30 days', min: 16, max: 30 },
    { label: '31–60 days', min: 31, max: 60 },
    { label: '61–90 days', min: 61, max: 90 },
    { label: 'Over 90 days', min: 91, max: Infinity },
  ].map((b) => {
    const hit = open.filter((r) => {
      const age = daysBetween(r.poDate, today)
      return age >= b.min && age <= b.max
    })
    return { label: b.label, orders: hit.length, value: r2(hit.reduce((s, r) => s + r.pending, 0)) }
  })

  const pipeline = (['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] as const).map((s) => {
    const hit = s === 'DRAFT' ? drafts : open.filter((r) => r.status === s)
    return {
      status: s,
      label: STATUS_WORDS[s],
      orders: hit.length,
      value: r2(hit.reduce((sum, r) => sum + (s === 'DRAFT' ? r.ordered : r.pending), 0)),
    }
  })

  const brief = (r: (typeof rows)[number]) => ({
    id: r.id,
    poNumber: r.poNumber,
    supplier: r.supplier.name,
    poDate: isoDay(r.poDate),
    deliveryDate: r.deliveryDate ? isoDay(r.deliveryDate) : null,
    ordered: r.ordered,
    pending: r.pending,
    receivedPct: r.ordered > 0 ? r.received / r.ordered : null,
  })

  // Received but not billed, oldest delivery first to chase. A rupee of
  // rounding between a receipt and its bill is not a bill to chase.
  const unbilled = rows
    .filter((r) => r.status !== 'CANCELLED' && r.unbilled >= 1 && r.receiptDates.length)
    .map((r) => ({ ...r, sinceReceipt: daysBetween(r.receiptDates[r.receiptDates.length - 1], today) }))
    .sort((a, b) => b.unbilled - a.unbilled)

  const now = {
    kpis: {
      unbilledOrders: unbilled.length,
      unbilledValue: r2(unbilled.reduce((s, r) => s + r.unbilled, 0)),
      openOrders: open.length,
      openValue: r2(open.reduce((s, r) => s + r.pending, 0)),
      overdueOrders: overdue.length,
      overdueValue: r2(overdue.reduce((s, r) => s + r.pending, 0)),
      dueThisWeek: dueSoon.filter((r) => r.dueIn <= 7).length,
      dueThisWeekValue: r2(dueSoon.filter((r) => r.dueIn <= 7).reduce((s, r) => s + r.pending, 0)),
      drafts: drafts.length,
      draftValue: r2(drafts.reduce((s, r) => s + r.ordered, 0)),
      noDate: open.filter((r) => !r.deliveryDate).length,
    },
    schedule,
    ageing,
    pipeline,
    overdue: overdue.slice(0, 10).map((r) => ({ ...brief(r), daysLate: r.daysLate })),
    dueSoon: dueSoon.slice(0, 10).map((r) => ({ ...brief(r), dueIn: r.dueIn })),
    drafts: drafts
      .map((r) => ({ ...brief(r), ageDays: daysBetween(r.poDate, today) }))
      .sort((a, b) => b.ageDays - a.ageDays)
      .slice(0, 8),
    unbilled: unbilled.slice(0, 10).map((r) => ({
      ...brief(r),
      unbilled: r.unbilled,
      sinceReceipt: r.sinceReceipt,
    })),
  }

  /* =================== THE PERIOD =================== */
  const sum = (list: typeof rows, pick: (r: (typeof rows)[number]) => number) =>
    r2(list.reduce((s, r) => s + pick(r), 0))

  const orderedValue = sum(live, (r) => r.ordered)
  const receivedValue = sum(live, (r) => r.received)
  const billedValue = sum(live, (r) => r.billed)
  const paidValue = sum(live, (r) => r.paid)
  const onTimeReceipts = live.reduce((s, r) => s + r.onTime, 0)
  const lateReceipts = live.reduce((s, r) => s + r.late, 0)
  const leads = live.filter((r) => r.firstReceipt).map((r) => daysBetween(r.poDate, r.firstReceipt as Date))
  const suppliersUsed = new Set(live.map((r) => r.supplier.id))

  // Months across the whole period, empty ones included — a gap is a finding.
  const monthKeys: string[] = []
  {
    const first = from ?? (live.length ? live.reduce((m, r) => (r.poDate < m ? r.poDate : m), live[0].poDate) : null)
    const last = to ?? today
    if (first) {
      const cur = new Date(first.getFullYear(), first.getMonth(), 1)
      while (cur <= last && monthKeys.length < 36) {
        monthKeys.push(monthKey(cur))
        cur.setMonth(cur.getMonth() + 1)
      }
    }
  }
  const trend = monthKeys.map((k) => {
    const raised = live.filter((r) => monthKey(r.poDate) === k)
    // Received by the month the goods came in, on this period's orders.
    let inMonth = 0
    for (const r of live) {
      if (!r.receiptDates.length || r.received === 0) continue
      const share = r.received / r.receiptDates.length
      inMonth += r.receiptDates.filter((d) => monthKey(d) === k).length * share
    }
    return {
      key: k,
      label: monthLabel(k),
      ordered: sum(raised, (r) => r.ordered),
      received: r2(inMonth),
      orders: raised.length,
    }
  })

  const statusMix = Object.keys(STATUS_WORDS)
    .map((s) => {
      const hit = period.filter((r) => r.status === s)
      return { status: s, label: STATUS_WORDS[s], orders: hit.length, value: sum(hit, (r) => r.ordered) }
    })
    .filter((s) => s.orders > 0)

  // Per supplier: value, speed and reliability, for the ranking and the quadrant.
  const bySupplier = new Map<
    string,
    { id: string; name: string; value: number; orders: number; onTime: number; late: number; leads: number[] }
  >()
  for (const r of live) {
    const s = bySupplier.get(r.supplier.id) ?? {
      id: r.supplier.id,
      name: r.supplier.name,
      value: 0,
      orders: 0,
      onTime: 0,
      late: 0,
      leads: [],
    }
    s.value += r.ordered
    s.orders += 1
    s.onTime += r.onTime
    s.late += r.late
    if (r.firstReceipt) s.leads.push(daysBetween(r.poDate, r.firstReceipt))
    bySupplier.set(r.supplier.id, s)
  }
  const suppliers = [...bySupplier.values()].map((s) => ({
    id: s.id,
    name: s.name,
    value: r2(s.value),
    orders: s.orders,
    onTime: s.onTime,
    late: s.late,
    onTimeRate: s.onTime + s.late > 0 ? s.onTime / (s.onTime + s.late) : null,
    avgLead: s.leads.length ? r2(s.leads.reduce((a, b) => a + b, 0) / s.leads.length) : null,
  }))

  const topSuppliers = topWithRest(suppliers, 8, (value, count) => ({
    id: '',
    name: `${count} other ${count === 1 ? 'supplier' : 'suppliers'}`,
    value,
    orders: 0,
    onTime: 0,
    late: 0,
    onTimeRate: null,
    avgLead: null,
  }))

  const byCategory = new Map<string, { id: string; name: string; value: number }>()
  const byItem = new Map<string, { id: string; name: string; value: number; orders: Set<string> }>()
  for (const r of live) {
    for (const it of r.items) {
      const c = byCategory.get(it.category.id) ?? { ...it.category, value: 0 }
      c.value += it.value
      byCategory.set(it.category.id, c)
      const i = byItem.get(it.id) ?? { id: it.id, name: it.name, value: 0, orders: new Set<string>() }
      i.value += it.value
      i.orders.add(r.id)
      byItem.set(it.id, i)
    }
  }
  const categories = topWithRest(
    [...byCategory.values()].map((c) => ({ ...c, value: r2(c.value) })),
    6,
    (value, count) => ({ id: '', name: `${count} other ${count === 1 ? 'category' : 'categories'}`, value })
  )
  const topItems = [...byItem.values()]
    .map((i) => ({ id: i.id, name: i.name, value: r2(i.value), orders: i.orders.size }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)

  const leadBuckets = [
    { label: '0–3', min: 0, max: 3 },
    { label: '4–7', min: 4, max: 7 },
    { label: '8–14', min: 8, max: 14 },
    { label: '15–30', min: 15, max: 30 },
    { label: '31+', min: 31, max: Infinity },
  ].map((b) => ({ label: b.label, orders: leads.filter((d) => d >= b.min && d <= b.max).length }))

  // Top suppliers by value across the months of the period, for the heat map.
  const heatSuppliers = [...suppliers].sort((a, b) => b.value - a.value).slice(0, 6)
  const heatmap = {
    months: monthKeys.map(monthLabel),
    rows: heatSuppliers.map((s) => ({
      id: s.id,
      name: s.name,
      values: monthKeys.map((k) => {
        const v = live
          .filter((r) => r.supplier.id === s.id && monthKey(r.poDate) === k)
          .reduce((a, r) => a + r.ordered, 0)
        return v > 0 ? r2(v) : null
      }),
    })),
  }

  /*
   * One row per supplier: what was ordered from them in the period, how they
   * delivered, and what is still outstanding with them today. The last two
   * columns are not limited to the period — a supplier with nothing ordered
   * this month can still owe goods, or a bill, from last month.
   */
  const card = new Map<
    string,
    (typeof suppliers)[number] & { open: number; unbilled: number; share: number | null }
  >()
  for (const s of suppliers) card.set(s.id, { ...s, open: 0, unbilled: 0, share: null })
  const cardFor = (r: (typeof rows)[number]) => {
    const got = card.get(r.supplier.id)
    if (got) return got
    const fresh = {
      id: r.supplier.id,
      name: r.supplier.name,
      value: 0,
      orders: 0,
      onTime: 0,
      late: 0,
      onTimeRate: null,
      avgLead: null,
      open: 0,
      unbilled: 0,
      share: null,
    }
    card.set(r.supplier.id, fresh)
    return fresh
  }
  for (const r of open) cardFor(r).open += r.pending
  for (const r of unbilled) cardFor(r).unbilled += r.unbilled
  const scorecard = [...card.values()]
    .map((s) => ({
      ...s,
      open: r2(s.open),
      unbilled: r2(s.unbilled),
      share: orderedValue > 0 ? s.value / orderedValue : null,
    }))
    .sort((a, b) => b.value - a.value || b.open - a.open)

  /*
   * Price watch: an item bought more than once in the period, its latest rate
   * against its usual one. The usual rate is weighted by quantity, so a
   * sample of two metres does not count for as much as a roll of two thousand.
   */
  const rateLines = new Map<
    string,
    { id: string; name: string; uom: string; lines: Array<{ rate: number; qty: number; poNumber: string; date: Date }> }
  >()
  for (const r of [...live].sort((a, b) => a.poDate.getTime() - b.poDate.getTime())) {
    for (const it of r.items) {
      if (it.rate <= 0 || it.qty <= 0) continue
      const e = rateLines.get(it.id) ?? { id: it.id, name: it.name, uom: it.uom, lines: [] }
      e.lines.push({ rate: it.rate, qty: it.qty, poNumber: r.poNumber, date: r.poDate })
      rateLines.set(it.id, e)
    }
  }
  const priceWatch = [...rateLines.values()]
    .filter((e) => e.lines.length >= 2)
    .map((e) => {
      const qty = e.lines.reduce((s, l) => s + l.qty, 0)
      const avg = e.lines.reduce((s, l) => s + l.rate * l.qty, 0) / qty
      const latest = e.lines[e.lines.length - 1]
      const rates = e.lines.map((l) => l.rate)
      return {
        id: e.id,
        name: e.name,
        uom: e.uom,
        buys: e.lines.length,
        avgRate: r2(avg),
        minRate: Math.min(...rates),
        maxRate: Math.max(...rates),
        latestRate: latest.rate,
        latestPo: latest.poNumber,
        latestDate: isoDay(latest.date),
        change: avg > 0 ? latest.rate / avg - 1 : null,
        history: e.lines.slice(-12).map((l) => ({ rate: l.rate, poNumber: l.poNumber, date: isoDay(l.date) })),
      }
    })
    .sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0))
    .slice(0, 10)

  const prevValue = prev ? sum(prev, (r) => r.ordered) : null
  const change = (cur: number, before: number | null) =>
    before == null || before === 0 ? null : (cur - before) / before

  /* ---- In words, what the figures say ---- */
  const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`
  const insights: string[] = []
  if (overdue.length) {
    const worst = overdue[0]
    insights.push(
      `${overdue.length} ${overdue.length === 1 ? 'order is' : 'orders are'} past the wanted date with ${inr(now.kpis.overdueValue)} of goods still to come — the latest is ${worst.poNumber} from ${worst.supplier.name}, ${worst.daysLate} ${worst.daysLate === 1 ? 'day' : 'days'} late.`
    )
  }
  if (live.length && prevValue != null) {
    const c = change(orderedValue, prevValue)
    if (c != null) {
      insights.push(
        `Ordering is ${c >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(c * 100))}% on the period before (${inr(orderedValue)} against ${inr(prevValue)}).`
      )
    }
  }
  if (suppliers.length >= 2 && orderedValue > 0) {
    const top = [...suppliers].sort((a, b) => b.value - a.value)
    const share = top[0].value / orderedValue
    if (share >= 0.4) {
      insights.push(
        `${top[0].name} takes ${Math.round(share * 100)}% of the period's ordering — one late delivery from them moves the whole book.`
      )
    }
  }
  if (onTimeReceipts + lateReceipts > 0) {
    const rated = suppliers.filter((s) => s.onTimeRate != null && s.onTime + s.late >= 2)
    const worst = rated.sort((a, b) => (a.onTimeRate ?? 1) - (b.onTimeRate ?? 1))[0]
    if (worst && (worst.onTimeRate ?? 1) < 0.7) {
      insights.push(
        `${worst.name} delivered ${Math.round((worst.onTimeRate ?? 0) * 100)}% of receipts on time — the weakest of the suppliers with more than one delivery.`
      )
    }
  }
  if (unbilled.length) {
    const oldest = unbilled.reduce((m, r) => (r.sinceReceipt > m.sinceReceipt ? r : m))
    insights.push(
      `${inr(now.kpis.unbilledValue)} of goods is in the gate with no supplier's bill against it, across ${unbilled.length} ${unbilled.length === 1 ? 'order' : 'orders'} — the longest wait is ${oldest.poNumber} from ${oldest.supplier.name}, ${oldest.sinceReceipt} ${oldest.sinceReceipt === 1 ? 'day' : 'days'} since the goods came.`
    )
  }
  {
    const rise = priceWatch.find((p) => (p.change ?? 0) >= 0.05)
    if (rise) {
      insights.push(
        `${rise.name} was last bought at ₹${rise.latestRate.toLocaleString('en-IN')}${rise.uom ? `/${rise.uom}` : ''}, ${Math.round((rise.change ?? 0) * 100)}% above its usual ₹${rise.avgRate.toLocaleString('en-IN')} — worth a word with the supplier before the next order.`
      )
    }
  }
  if (drafts.length) {
    const oldest = now.drafts[0]
    insights.push(
      `${drafts.length} ${drafts.length === 1 ? 'order is' : 'orders are'} still in draft, worth ${inr(now.kpis.draftValue)}${oldest ? ` — ${oldest.poNumber} has waited ${oldest.ageDays} ${oldest.ageDays === 1 ? 'day' : 'days'}` : ''}. The supplier has not been sent ${drafts.length === 1 ? 'it' : 'them'}.`
    )
  }
  if (now.kpis.noDate) {
    insights.push(
      `${now.kpis.noDate} open ${now.kpis.noDate === 1 ? 'order has' : 'orders have'} no wanted-by date, so ${now.kpis.noDate === 1 ? 'it' : 'they'} can never show as late. Add one to track ${now.kpis.noDate === 1 ? 'it' : 'them'}.`
    )
  }

  // What the filter dropdowns offer: every supplier and category ever ordered from.
  const [supplierOptions, categoryRows] = await Promise.all([
    prisma.supplier.findMany({
      where: { purchaseOrders: { some: { deletedAt: null } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.itemCategory.findMany({
      where: {
        OR: [
          { items: { some: { poLines: { some: { po: { deletedAt: null } } } } } },
          { children: { some: { items: { some: { poLines: { some: { po: { deletedAt: null } } } } } } } },
        ],
      },
      select: { id: true, name: true, parent: { select: { id: true, name: true } } },
    }),
  ])
  const categoryOptions = [
    ...new Map(categoryRows.map((c) => [(c.parent ?? c).id, { id: (c.parent ?? c).id, name: (c.parent ?? c).name }])).values(),
  ].sort((a, b) => a.name.localeCompare(b.name))

  res.json({
    success: true,
    data: {
      asOf: new Date().toISOString(),
      period: { from: q.from ?? null, to: q.to ?? null },
      options: { suppliers: supplierOptions, categories: categoryOptions },
      now,
      analysis: {
        kpis: {
          orders: live.length,
          ordersChange: prev ? change(live.length, prev.length) : null,
          value: orderedValue,
          valueChange: change(orderedValue, prevValue),
          avgOrder: live.length ? r2(orderedValue / live.length) : null,
          suppliers: suppliersUsed.size,
          onTimeRate: onTimeReceipts + lateReceipts > 0 ? onTimeReceipts / (onTimeReceipts + lateReceipts) : null,
          receipts: onTimeReceipts + lateReceipts,
          avgLead: leads.length ? r2(leads.reduce((a, b) => a + b, 0) / leads.length) : null,
          receivedRate: orderedValue > 0 ? receivedValue / orderedValue : null,
          billedRate: orderedValue > 0 ? billedValue / orderedValue : null,
          cancelled: period.length - live.length,
        },
        funnel: [
          { label: 'Ordered', value: orderedValue },
          { label: 'Received', value: receivedValue },
          { label: 'Billed', value: billedValue },
          { label: 'Paid', value: r2(paidValue) },
        ],
        trend,
        statusMix,
        topSuppliers,
        supplierQuadrant: suppliers
          .filter((s) => s.onTimeRate != null && s.avgLead != null)
          .map((s) => ({ id: s.id, name: s.name, value: s.value, onTimeRate: s.onTimeRate, avgLead: s.avgLead, receipts: s.onTime + s.late })),
        onTimeBySupplier: suppliers
          .filter((s) => s.onTime + s.late > 0)
          .sort((a, b) => b.onTime + b.late - (a.onTime + a.late))
          .slice(0, 8)
          .map((s) => ({ id: s.id, name: s.name, onTime: s.onTime, late: s.late })),
        categories,
        topItems,
        leadTime: leadBuckets,
        heatmap,
        scorecard,
        priceWatch,
        insights,
      },
    },
  })
})

export default router
