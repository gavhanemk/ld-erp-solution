import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { requirePermission } from '../middleware/auth'

/*
 * The Purchase dashboard.
 *
 * Two kinds of figure, and the split is the point:
 *
 *   - RIGHT NOW is operational: which orders are late, what is due this week,
 *     what is still in draft, what came in without a bill. Never limited to
 *     the period — an order raised in March that is still late in September
 *     is exactly the one a buyer needs to see.
 *   - THE PERIOD is analytical: what was ordered in the last 7, 30, 90 or 365
 *     days, from whom, of what, how fast it came, how much is billed and paid.
 *
 * The counting rules are the Purchase Order Status report's, so the two
 * screens cannot disagree: a cancelled receipt booked nothing in, a
 * short-closed line is settled rather than pending, and a reject still counts
 * as delivered (it is settled with a debit note, not owed by the order).
 *
 * Values are before GST — line amounts, not order totals — so a category
 * filter can split an order by its lines, and ordered, received, billed and
 * paid are all measured in the same rupee. Quantities are never added across
 * units: metres stay with metres, pieces with pieces.
 *
 * Days are Indian days. The server runs on UTC, so every "which day" question
 * goes through `dayNum`, which counts days on the Kolkata calendar.
 */

const MODULE = 'purchase'
const router = Router()

const DAY_MS = 86_400_000
const IST_MS = 330 * 60_000
const OPEN = new Set(['SENT', 'PARTIALLY_RECEIVED'])
const STATUS_WORDS: Record<string, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  PARTIALLY_RECEIVED: 'Part received',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
}

const r2 = (n: number) => Math.round(n * 100) / 100
/** The day a moment falls on in India, as a whole number of days. */
const dayNum = (d: Date) => Math.floor((d.getTime() + IST_MS) / DAY_MS)
const isoOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10)
const isoDay = (d: Date) => isoOf(dayNum(d))
const daysBetween = (a: Date, b: Date) => dayNum(b) - dayNum(a)
const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)
const shortDay = (n: number) =>
  new Date(n * DAY_MS).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })

type Qty = Array<{ uom: string; qty: number }>
const addQty = (m: Map<string, number>, uom: string, qty: number) => m.set(uom, (m.get(uom) ?? 0) + qty)
const qtyList = (m: Map<string, number>): Qty =>
  [...m.entries()].map(([uom, qty]) => ({ uom, qty: r2(qty) })).sort((a, b) => b.qty - a.qty)

router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const q = req.query as Record<string, string | undefined>
  const now = new Date()
  const today = dayNum(now)

  // The period, on Indian days. Blank means everything on record.
  const from = q.from ? new Date(`${q.from}T00:00:00+05:30`) : null
  const to = q.to ? new Date(`${q.to}T23:59:59.999+05:30`) : null
  // The same length of time immediately before, for "up or down on last time".
  const span = from && to ? to.getTime() - from.getTime() : null
  const prevFrom = from && span != null ? new Date(from.getTime() - span - 1) : null
  const prevTo = from ? new Date(from.getTime() - 1) : null

  const supplierId = q.supplierId || undefined
  const categoryId = q.categoryId || undefined

  /** A line belongs to the chosen category if its item's category, or that category's parent, is it. */
  const lineInCategory: Prisma.PurchaseOrderLineWhereInput | undefined = categoryId
    ? { item: { OR: [{ categoryId }, { category: { parentId: categoryId } }] } }
    : undefined

  const base: Prisma.PurchaseOrderWhereInput = {
    deletedAt: null,
    ...(supplierId ? { supplierId } : {}),
    ...(lineInCategory ? { lines: { some: lineInCategory } } : {}),
  }

  // One read: the period and the one before it, every order still open
  // whenever it was raised, and the last year's orders — goods received and
  // not billed are somebody's job whatever period is picked.
  const earliest = prevFrom ?? from
  const yearAgo = new Date(now.getTime() - 365 * DAY_MS)
  const orders = await prisma.purchaseOrder.findMany({
    where: {
      ...base,
      // With no dates at all there is nothing to OR: everything is wanted.
      // (An empty `{}` inside OR does not mean "true" to Prisma — it is
      // dropped, which once hid every completed order.)
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
                select: {
                  id: true,
                  name: true,
                  department: { select: { name: true } },
                  parent: { select: { id: true, name: true, department: { select: { name: true } } } },
                },
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
    const lines: Array<{
      itemId: string
      name: string
      uom: string
      category: { id: string; name: string }
      sub: { id: string; name: string } | null
      department: string
      value: number
      qty: number
      got: number
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
      // Rolled up to the top of the tree for the category; the sub-category is
      // the item's own when it sits one level down.
      const c = l.item.category
      const top = c.parent ?? c
      lines.push({
        itemId: l.item.id,
        name: l.item.name,
        uom: l.item.uom?.symbol ?? '',
        category: { id: top.id, name: top.name },
        sub: c.parent ? { id: c.id, name: c.name } : null,
        department: c.department?.name ?? c.parent?.department?.name ?? 'No department',
        value: amount,
        qty,
        got,
        rate: Number(l.unitRate),
      })
    }

    const receiptDates = [...receipts.values()].sort((a, b) => a.getTime() - b.getTime())
    const firstReceipt = receiptDates[0] ?? null
    const wanted = o.deliveryDate ? dayNum(o.deliveryDate) : null
    const onTime = wanted != null ? receiptDates.filter((d) => dayNum(d) <= wanted).length : 0
    const late = wanted != null ? receiptDates.length - onTime : 0

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
      lines,
    }
  })
  type Row = (typeof rows)[number]

  const inPeriod = (d: Date) => (!from || d >= from) && (!to || d <= to)
  const period = rows.filter((r) => inPeriod(r.poDate))
  const live = period.filter((r) => r.status !== 'CANCELLED')
  const prev =
    prevFrom && prevTo
      ? rows.filter((r) => r.status !== 'CANCELLED' && r.poDate >= prevFrom && r.poDate <= prevTo)
      : null
  const sum = (list: Row[], pick: (r: Row) => number) => r2(list.reduce((s, r) => s + pick(r), 0))

  /* =================== RIGHT NOW — never limited to the period =================== */
  const open = rows.filter((r) => OPEN.has(r.status) && r.pending > 0)
  const drafts = rows.filter((r) => r.status === 'DRAFT')
  const overdue = open
    .filter((r) => r.deliveryDate && dayNum(r.deliveryDate) < today)
    .map((r) => ({ ...r, daysLate: today - dayNum(r.deliveryDate as Date) }))
    .sort((a, b) => b.daysLate - a.daysLate)
  const dueSoon = open
    .filter((r) => r.deliveryDate && dayNum(r.deliveryDate) >= today)
    .map((r) => ({ ...r, dueIn: dayNum(r.deliveryDate as Date) - today }))
    .filter((r) => r.dueIn <= 14)
    .sort((a, b) => a.dueIn - b.dueIn)
  // Received but not billed. A rupee of rounding between a receipt and its
  // bill is not a bill to chase.
  const unbilled = rows
    .filter((r) => r.status !== 'CANCELLED' && r.unbilled >= 1 && r.receiptDates.length)
    .map((r) => ({ ...r, sinceReceipt: today - dayNum(r.receiptDates[r.receiptDates.length - 1]) }))
    .sort((a, b) => b.unbilled - a.unbilled)

  // When the outstanding goods are expected — the week-by-week load on the gate.
  const schedule = [
    { key: 'overdue', label: 'Late', hint: 'Past the wanted-by date', tone: 'rose', test: (d: number | null) => d != null && d < 0 },
    { key: 'week', label: '7d', hint: 'Due in the next 7 days', tone: 'amber', test: (d: number | null) => d != null && d >= 0 && d <= 7 },
    { key: 'next', label: '14d', hint: 'Due in 8 to 14 days', tone: 'blue', test: (d: number | null) => d != null && d > 7 && d <= 14 },
    { key: 'weeks34', label: '28d', hint: 'Due in 15 to 28 days', tone: 'sky', test: (d: number | null) => d != null && d > 14 && d <= 28 },
    { key: 'later', label: 'Later', hint: 'Due after four weeks', tone: 'teal', test: (d: number | null) => d != null && d > 28 },
    { key: 'none', label: 'No date', hint: 'No wanted-by date given', tone: 'slate', test: (d: number | null) => d == null },
  ].map((b) => {
    const hit = open.filter((r) => b.test(r.deliveryDate ? dayNum(r.deliveryDate) - today : null))
    return { key: b.key, label: b.label, hint: b.hint, tone: b.tone, orders: hit.length, value: sum(hit, (r) => r.pending) }
  })

  const pipeline = (['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] as const).map((s) => {
    const hit = s === 'DRAFT' ? drafts : open.filter((r) => r.status === s)
    return {
      status: s,
      label: STATUS_WORDS[s],
      orders: hit.length,
      value: sum(hit, (r) => (s === 'DRAFT' ? r.ordered : r.pending)),
    }
  })

  const brief = (r: Row) => ({
    id: r.id,
    poNumber: r.poNumber,
    supplier: r.supplier.name,
    poDate: isoDay(r.poDate),
    deliveryDate: r.deliveryDate ? isoDay(r.deliveryDate) : null,
    ordered: r.ordered,
    pending: r.pending,
    receivedPct: r.ordered > 0 ? r.received / r.ordered : null,
  })

  // Indents: approved requisition lines the store marked "to be bought",
  // less what live orders already cover. Not a supplier's figure, so the
  // supplier filter leaves it alone; the category filter still applies.
  const indentLines = await prisma.materialRequisitionLine.findMany({
    where: {
      fulfilment: 'PURCHASE',
      mr: { status: 'APPROVED', closedAt: null },
      ...(categoryId ? { item: { OR: [{ categoryId }, { category: { parentId: categoryId } }] } } : {}),
    },
    select: {
      itemId: true,
      requestedQty: true,
      poLines: { where: { po: { deletedAt: null, status: { not: 'CANCELLED' } } }, select: { qty: true } },
    },
  })
  const waitingIndents = indentLines.filter(
    (l) => Number(l.requestedQty) - l.poLines.reduce((s, p) => s + Number(p.qty), 0) > 0
  )

  const nowBlock = {
    kpis: {
      openOrders: open.length,
      openValue: sum(open, (r) => r.pending),
      overdueOrders: overdue.length,
      overdueValue: sum(overdue, (r) => r.pending),
      dueThisWeek: dueSoon.filter((r) => r.dueIn <= 7).length,
      dueThisWeekValue: sum(dueSoon.filter((r) => r.dueIn <= 7), (r) => r.pending),
      drafts: drafts.length,
      draftValue: sum(drafts, (r) => r.ordered),
      noDate: open.filter((r) => !r.deliveryDate).length,
      unbilledOrders: unbilled.length,
      unbilledValue: sum(unbilled, (r) => r.unbilled),
      indentLines: waitingIndents.length,
      indentItems: new Set(waitingIndents.map((l) => l.itemId)).size,
    },
    schedule,
    pipeline,
    overdue: overdue.slice(0, 10).map((r) => ({ ...brief(r), daysLate: r.daysLate })),
    dueSoon: dueSoon.slice(0, 10).map((r) => ({ ...brief(r), dueIn: r.dueIn })),
    drafts: drafts
      .map((r) => ({ ...brief(r), ageDays: today - dayNum(r.poDate) }))
      .sort((a, b) => b.ageDays - a.ageDays)
      .slice(0, 10),
    unbilled: unbilled.slice(0, 10).map((r) => ({ ...brief(r), unbilled: r.unbilled, sinceReceipt: r.sinceReceipt })),
  }

  /* =================== THE PERIOD =================== */
  const orderedValue = sum(live, (r) => r.ordered)
  const receivedValue = sum(live, (r) => r.received)
  const billedValue = sum(live, (r) => r.billed)
  const paidValue = sum(live, (r) => r.paid)
  const onTimeReceipts = live.reduce((s, r) => s + r.onTime, 0)
  const lateReceipts = live.reduce((s, r) => s + r.late, 0)
  const leads = live.filter((r) => r.firstReceipt).map((r) => daysBetween(r.poDate, r.firstReceipt as Date))
  const suppliersUsed = new Set(live.map((r) => r.supplier.id))
  const allLines = live.flatMap((r) => r.lines.map((l) => ({ ...l, order: r })))

  /*
   * The trend, bucketed to suit the period: days for a week or a month, weeks
   * for a quarter, months for a year. Empty buckets are kept — a gap is a
   * finding, and a line that skips it tells a different story.
   */
  const firstDay = from ? dayNum(from) : live.length ? Math.min(...live.map((r) => dayNum(r.poDate))) : today
  const lastDay = to ? dayNum(to) : today
  const spanDays = lastDay - firstDay + 1
  const bucket: 'day' | 'week' | 'month' = spanDays <= 31 ? 'day' : spanDays <= 120 ? 'week' : 'month'
  const keyOf = (n: number) => {
    if (bucket === 'day') return String(n)
    if (bucket === 'week') {
      // Weeks start on Monday; day 0 of the epoch was a Thursday.
      const dow = (n + 3) % 7
      return String(n - dow)
    }
    return isoOf(n).slice(0, 7)
  }
  const buckets: string[] = []
  for (let n = firstDay; n <= lastDay; n++) {
    const k = keyOf(n)
    if (buckets[buckets.length - 1] !== k) buckets.push(k)
  }
  const labelOf = (k: string) =>
    bucket === 'month'
      ? new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' })
      : bucket === 'week'
        ? `w/c ${shortDay(Number(k))}`
        : shortDay(Number(k))
  const trendMap = new Map(buckets.map((k) => [k, { ordered: 0, received: 0, orders: 0 }]))
  for (const r of live) {
    const t = trendMap.get(keyOf(dayNum(r.poDate)))
    if (t) {
      t.ordered += r.ordered
      t.orders += 1
    }
    // Received by the day the goods came in, split evenly across receipts.
    if (r.receiptDates.length && r.received > 0) {
      const share = r.received / r.receiptDates.length
      for (const d of r.receiptDates) {
        const g = trendMap.get(keyOf(dayNum(d)))
        if (g) g.received += share
      }
    }
  }
  const trend = buckets.map((k) => {
    const t = trendMap.get(k)!
    return { key: k, label: labelOf(k), ordered: r2(t.ordered), received: r2(t.received), orders: t.orders }
  })

  // By supplier: value, speed and reliability.
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
  const suppliers = [...bySupplier.values()]
    .map((s) => ({
      id: s.id,
      name: s.name,
      value: r2(s.value),
      orders: s.orders,
      onTime: s.onTime,
      late: s.late,
      onTimeRate: s.onTime + s.late > 0 ? s.onTime / (s.onTime + s.late) : null,
      avgLead: s.leads.length ? r2(s.leads.reduce((a, b) => a + b, 0) / s.leads.length) : null,
    }))
    .sort((a, b) => b.value - a.value)

  /*
   * Every supplier on one sheet: the period's ordering and delivery, and what
   * is outstanding with them today — open goods and unbilled receipts are not
   * limited to the period.
   */
  const card = new Map<string, (typeof suppliers)[number] & { open: number; unbilled: number }>()
  for (const s of suppliers) card.set(s.id, { ...s, open: 0, unbilled: 0 })
  const cardFor = (r: Row) => {
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

  /* ---- Quantity, unit by unit ---- */
  const unitMap = new Map<string, { ordered: number; received: number; value: number; items: Set<string>; lines: number }>()
  for (const l of allLines) {
    const u = unitMap.get(l.uom) ?? { ordered: 0, received: 0, value: 0, items: new Set<string>(), lines: 0 }
    u.ordered += l.qty
    u.received += Math.min(l.got, l.qty)
    u.value += l.value
    u.items.add(l.itemId)
    u.lines += 1
    unitMap.set(l.uom, u)
  }
  const units = [...unitMap.entries()]
    .map(([uom, u]) => ({
      uom: uom || 'unit',
      orderedQty: r2(u.ordered),
      receivedQty: r2(u.received),
      value: r2(u.value),
      items: u.items.size,
      lines: u.lines,
    }))
    .sort((a, b) => b.value - a.value)

  /* ---- Category › sub-category, and department › category ---- */
  type Acc = { name: string; value: number; lines: number; items: Set<string>; qty: Map<string, number>; kids: Map<string, Acc> }
  const acc = (name: string): Acc => ({ name, value: 0, lines: 0, items: new Set(), qty: new Map(), kids: new Map() })
  const feed = (a: Acc, l: (typeof allLines)[number]) => {
    a.value += l.value
    a.lines += 1
    a.items.add(l.itemId)
    addQty(a.qty, l.uom || 'unit', l.qty)
  }
  const byCat = new Map<string, Acc & { id: string }>()
  const byDept = new Map<string, Acc>()
  for (const l of allLines) {
    const c = byCat.get(l.category.id) ?? { ...acc(l.category.name), id: l.category.id }
    feed(c, l)
    const subName = l.sub?.name ?? 'No sub-category'
    const s = c.kids.get(subName) ?? acc(subName)
    feed(s, l)
    c.kids.set(subName, s)
    byCat.set(l.category.id, c)

    const d = byDept.get(l.department) ?? acc(l.department)
    feed(d, l)
    const dc = d.kids.get(l.category.name) ?? acc(l.category.name)
    feed(dc, l)
    d.kids.set(l.category.name, dc)
    byDept.set(l.department, d)
  }
  type BreakRow = {
    name: string
    value: number
    lines: number
    items: number
    share: number
    qty: Qty
    children?: BreakRow[]
  }
  const shape = (a: Acc): BreakRow => ({
    name: a.name,
    value: r2(a.value),
    lines: a.lines,
    items: a.items.size,
    share: pctOf(a.value, orderedValue),
    qty: qtyList(a.qty),
    ...(a.kids.size ? { children: [...a.kids.values()].map(shape).sort((x, y) => y.value - x.value) } : {}),
  })
  const breakdown = {
    categories: [...byCat.values()].map((c) => ({ id: c.id, ...shape(c) })).sort((a, b) => b.value - a.value),
    departments: [...byDept.values()].map(shape).sort((a, b) => b.value - a.value),
  }

  /* ---- The items that took the money, with their quantity ---- */
  const byItem = new Map<string, { id: string; name: string; uom: string; value: number; qty: number; orders: Set<string> }>()
  for (const l of allLines) {
    const i = byItem.get(l.itemId) ?? { id: l.itemId, name: l.name, uom: l.uom, value: 0, qty: 0, orders: new Set<string>() }
    i.value += l.value
    i.qty += l.qty
    i.orders.add(l.order.id)
    byItem.set(l.itemId, i)
  }
  const topItems = [...byItem.values()]
    .map((i) => ({ id: i.id, name: i.name, uom: i.uom, value: r2(i.value), qty: r2(i.qty), orders: i.orders.size }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)

  /*
   * Price watch: an item bought more than once in the period, its latest rate
   * against its usual one, weighted by quantity so a sample of two metres
   * does not count for as much as a roll of two thousand.
   */
  const rateLines = new Map<
    string,
    { id: string; name: string; uom: string; lines: Array<{ rate: number; qty: number; poNumber: string; date: Date }> }
  >()
  for (const l of [...allLines].sort((a, b) => a.order.poDate.getTime() - b.order.poDate.getTime())) {
    if (l.rate <= 0 || l.qty <= 0) continue
    const e = rateLines.get(l.itemId) ?? { id: l.itemId, name: l.name, uom: l.uom, lines: [] }
    e.lines.push({ rate: l.rate, qty: l.qty, poNumber: l.order.poNumber, date: l.order.poDate })
    rateLines.set(l.itemId, e)
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
      }
    })
    .sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0))
    .slice(0, 8)

  const leadTime = [
    { label: '0–3 days', min: 0, max: 3 },
    { label: '4–7 days', min: 4, max: 7 },
    { label: '8–14 days', min: 8, max: 14 },
    { label: '15–30 days', min: 15, max: 30 },
    { label: '31+ days', min: 31, max: Infinity },
  ].map((b) => ({ label: b.label, orders: leads.filter((d) => d >= b.min && d <= b.max).length }))

  const statusMix = Object.keys(STATUS_WORDS)
    .map((s) => {
      const hit = period.filter((r) => r.status === s)
      return { status: s, label: STATUS_WORDS[s], orders: hit.length, value: sum(hit, (r) => r.ordered) }
    })
    .filter((s) => s.orders > 0)

  const prevValue = prev ? sum(prev, (r) => r.ordered) : null
  const change = (cur: number, before: number | null) =>
    before == null || before === 0 ? null : (cur - before) / before

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
      asOf: now.toISOString(),
      period: { from: q.from ?? null, to: q.to ?? null, bucket },
      options: { suppliers: supplierOptions, categories: categoryOptions },
      now: nowBlock,
      analysis: {
        kpis: {
          orders: live.length,
          ordersChange: prev ? change(live.length, prev.length) : null,
          value: orderedValue,
          valueChange: change(orderedValue, prevValue),
          suppliers: suppliersUsed.size,
          onTime: onTimeReceipts,
          late: lateReceipts,
          onTimeRate: onTimeReceipts + lateReceipts > 0 ? onTimeReceipts / (onTimeReceipts + lateReceipts) : null,
          avgLead: leads.length ? r2(leads.reduce((a, b) => a + b, 0) / leads.length) : null,
          received: receivedValue,
          billed: billedValue,
          paid: r2(paidValue),
          cancelled: period.length - live.length,
        },
        trend,
        statusMix,
        suppliers: suppliers.map(({ id, name, value, orders }) => ({ id, name, value, orders })),
        scorecard,
        units,
        breakdown,
        topItems,
        priceWatch,
        leadTime,
      },
    },
  })
})

export default router
