import { prisma } from '@ld-erp/database'
import { onHand, reorderStatus } from './stock.service'
import { getNumericPreference } from '../lib/preferences'

/**
 * The home dashboard: the whole mill in one call.
 *
 * Two kinds of figure, kept apart the way the purchase and inventory
 * dashboards keep them. Where things stand now — open orders, stock, what is
 * owed either way — whatever the period. And what moved in the chosen period —
 * ordered, received, made, invoiced, collected — each against the period
 * before it.
 *
 * Every section belongs to a module. A section the signed-in role may not see
 * comes back null, never zero: zero is a fact, and it would be the wrong one
 * (docs/03-build-rules.md §6). Money owed either way is an accounts fact.
 *
 * Order values are before GST, as on the purchase dashboard; invoices, bills
 * and payments are what was actually charged and paid.
 *
 * Days are Indian days. The server runs on UTC.
 */

const DAY = 86_400_000
const IST = 330 * 60_000
const r2 = (n: number) => Math.round(n * 100) / 100

/** The Indian calendar day of a moment, as YYYY-MM-DD. */
const istDay = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10)
/** Midnight in India at the start of that day. */
const istStart = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - IST)
/** That day moved on by n days. */
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
/** The Monday of that day's week. */
const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7))
/** Change against the period before, as a fraction; null when there is nothing to compare with. */
const change = (now: number, before: number) => (before > 0 ? r2((now - before) / before) : null)

export interface HomeAccess {
  sales: boolean
  purchase: boolean
  inventory: boolean
  production: boolean
  /** Invoices, bills, receipts and payments — accounts:view. */
  money: boolean
  masters: boolean
  settings: boolean
}

type Bucket = 'day' | 'week' | 'month'
type Tone = 'rose' | 'amber' | 'violet' | 'blue'

/** One check the dashboard runs; a count of nought means it is clear. */
interface Check {
  key: string
  module: 'sales' | 'purchase' | 'inventory' | 'production' | 'accounts'
  /** What is wrong, when something is. */
  label: string
  /** What it says when nothing is. */
  clear: string
  count: number
  value: number | null
  tone: Tone
  href: string | null
}

const SO_OPEN = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] as const
const PO_OPEN = new Set(['SENT', 'PARTIALLY_RECEIVED'])

const SO_STAGES: Array<[string, string]> = [
  ['DRAFT', 'Draft'],
  ['CONFIRMED', 'Confirmed'],
  ['IN_PRODUCTION', 'In production'],
  ['PARTIALLY_DISPATCHED', 'Part dispatched'],
  ['COMPLETED', 'Completed'],
  ['CANCELLED', 'Cancelled'],
]
const PO_STAGES: Array<[string, string]> = [
  ['DRAFT', 'Not sent'],
  ['SENT', 'Sent'],
  ['PARTIALLY_RECEIVED', 'Part received'],
  ['COMPLETED', 'Received'],
  ['CANCELLED', 'Cancelled'],
]
const MO_STAGES: Array<[string, string]> = [
  ['DRAFT', 'Draft'],
  ['RELEASED', 'Released'],
  ['CUTTING', 'Cutting'],
  ['STITCHING', 'Stitching'],
  ['FINISHING', 'Finishing'],
  ['QC', 'QC'],
  ['PACKING', 'Packing'],
  ['COMPLETED', 'Completed'],
  ['CLOSED', 'Closed'],
]
const ITEM_TYPES: Record<string, string> = {
  RAW_MATERIAL: 'Raw material',
  SEMI_FINISHED: 'Semi-finished',
  FINISHED_GOOD: 'Finished goods',
  CONSUMABLE: 'Consumables',
  PACKING_MATERIAL: 'Packing',
  TRIM: 'Trims',
}

/** Which permission lets somebody see a module's lines in the activity feed. */
const AUDIT_GATE: Record<string, keyof HomeAccess> = {
  sales: 'sales',
  purchase: 'purchase',
  inventory: 'inventory',
  production: 'production',
  masters: 'masters',
  accounts: 'money',
  admin: 'settings',
  settings: 'settings',
}

/** The fields a logged record is most likely to be known by, best first. */
const LABEL_KEYS = [
  'poNumber', 'grnNumber', 'billNumber', 'soNumber', 'mrNumber', 'invoiceNumber', 'challanNumber',
  'paymentNumber', 'receiptNumber', 'noteNumber', 'enquiryNumber', 'returnNumber', 'moNumber',
  'transferNumber', 'adjustmentNumber', 'docNumber', 'number', 'code', 'name', 'fileName',
]

const labelOf = (...snapshots: unknown[]) => {
  for (const s of snapshots) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    for (const k of LABEL_KEYS) if (typeof o[k] === 'string' && o[k]) return String(o[k])
  }
  return null
}

/** Ageing of what is owed, by days past its due date. */
const AGE = [
  { key: 'notDue', label: 'Not yet due' },
  { key: 'd30', label: '1–30 days late' },
  { key: 'd60', label: '31–60 days late' },
  { key: 'd90', label: '61–90 days late' },
  { key: 'older', label: 'Over 90 days' },
] as const

export async function homeDashboard(opts: { days: number; access: HomeAccess }) {
  const { access } = opts
  const days = [7, 30, 90, 365].includes(opts.days) ? opts.days : 30
  const today = istDay(new Date())
  const fromDay = addDays(today, -(days - 1))
  const prevFromDay = addDays(fromDay, -days)
  const from = istStart(fromDay)
  const prevFrom = istStart(prevFromDay)
  const todayStart = istStart(today)
  const weekEnd = addDays(today, 6)
  const bucket: Bucket = days <= 31 ? 'day' : days <= 120 ? 'week' : 'month'

  const inPeriod = (d: Date) => d >= from
  const inPrev = (d: Date) => d >= prevFrom && d < from

  /* ── the buckets every trend is drawn on — each one, including the empty ones ── */
  const keyOf = (day: string) => (bucket === 'day' ? day : bucket === 'week' ? mondayOf(day) : day.slice(0, 7))
  const trend = new Map<string, { key: string; label: string; [series: string]: number | string }>()
  for (let d = fromDay; d <= today; d = addDays(d, 1)) {
    const key = keyOf(d)
    if (trend.has(key)) continue
    const at = new Date(`${bucket === 'month' ? `${key}-01` : key}T00:00:00Z`)
    trend.set(key, {
      key,
      label: at.toLocaleDateString('en-IN', bucket === 'month' ? { month: 'short', year: '2-digit', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' }),
    })
  }
  const series = (name: string) => {
    for (const b of trend.values()) b[name] = 0
  }
  const add = (name: string, when: Date | string, value: number) => {
    const day = typeof when === 'string' ? when : istDay(when)
    if (day < fromDay) return
    const b = trend.get(keyOf(day))
    if (b) b[name] = r2(Number(b[name] ?? 0) + value)
  }

  const checks: Check[] = []

  /* ═════════════════════════════ SALES ═════════════════════════════ */
  const salesP = access.sales
    ? (async () => {
        const [orders, byStatus] = await Promise.all([
          prisma.salesOrder.findMany({
            where: { OR: [{ orderDate: { gte: prevFrom } }, { status: { in: [...SO_OPEN] } }] },
            select: {
              orderDate: true,
              deliveryDate: true,
              status: true,
              taxableAmount: true,
              customer: { select: { id: true, name: true } },
            },
          }),
          prisma.salesOrder.groupBy({ by: ['status'], _count: { _all: true }, _sum: { taxableAmount: true } }),
        ])
        const value = (o: (typeof orders)[number]) => Number(o.taxableAmount)
        const open = orders.filter((o) => (SO_OPEN as readonly string[]).includes(o.status))
        const late = open.filter((o) => o.deliveryDate && istDay(o.deliveryDate) < today)
        const dueWeek = open.filter((o) => o.deliveryDate && istDay(o.deliveryDate) >= today && istDay(o.deliveryDate) <= weekEnd)
        // A draft is still being typed and a cancelled order never was: neither is business booked.
        const booked = orders.filter((o) => o.status !== 'DRAFT' && o.status !== 'CANCELLED')
        const now = booked.filter((o) => inPeriod(o.orderDate))
        const before = booked.filter((o) => inPrev(o.orderDate))

        series('booked')
        for (const o of now) add('booked', o.orderDate, value(o))

        const customers = new Map<string, { id: string; name: string; value: number; orders: number }>()
        for (const o of now) {
          const c = customers.get(o.customer.id) ?? { ...o.customer, value: 0, orders: 0 }
          c.value += value(o)
          c.orders += 1
          customers.set(o.customer.id, c)
        }

        checks.push({
          key: 'so-late',
          module: 'sales',
          label: 'Sales orders past their delivery date',
          clear: 'No sales order is late',
          count: late.length,
          value: r2(late.reduce((t, o) => t + value(o), 0)),
          tone: 'rose',
          href: '/sales/orders',
        })

        const count = (s: string) => byStatus.find((g) => g.status === s)?._count._all ?? 0
        return {
          openOrders: open.length,
          openValue: r2(open.reduce((t, o) => t + value(o), 0)),
          late: late.length,
          dueWeek: dueWeek.length,
          drafts: count('DRAFT'),
          booked: {
            value: r2(now.reduce((t, o) => t + value(o), 0)),
            orders: now.length,
            change: change(now.reduce((t, o) => t + value(o), 0), before.reduce((t, o) => t + value(o), 0)),
          },
          status: SO_STAGES.map(([status, label]) => ({
            status,
            label,
            count: count(status),
            value: r2(Number(byStatus.find((g) => g.status === status)?._sum.taxableAmount ?? 0)),
          })),
          customers: [...customers.values()]
            .map((c) => ({ ...c, value: r2(c.value) }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 8),
        }
      })()
    : null

  /* ═════════════════════════════ PURCHASE ═════════════════════════════ */
  const purchaseP = access.purchase
    ? (async () => {
        // Every order still open whenever it was raised, and the last year's —
        // goods received and not billed are somebody's job whatever the period.
        const yearAgo = istStart(addDays(today, -365))
        const earliest = prevFrom < yearAgo ? prevFrom : yearAgo
        const [orders, byStatus] = await Promise.all([
          prisma.purchaseOrder.findMany({
            where: {
              deletedAt: null,
              OR: [{ status: { in: ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] } }, { poDate: { gte: earliest } }],
            },
            select: {
              poDate: true,
              deliveryDate: true,
              status: true,
              supplier: { select: { id: true, name: true } },
              lines: {
                select: {
                  qty: true,
                  amount: true,
                  shortClosed: true,
                  grnLines: {
                    select: {
                      receivedQty: true,
                      grn: { select: { status: true, grnDate: true } },
                      billLines: { select: { taxableValue: true, bill: { select: { status: true } } } },
                    },
                  },
                },
              },
            },
          }),
          prisma.purchaseOrder.groupBy({
            by: ['status'],
            where: { deletedAt: null },
            _count: { _all: true },
            _sum: { taxableAmount: true },
          }),
        ])

        series('ordered')
        series('received')

        // The same arithmetic as the purchase dashboard: received and pending
        // by the share of each line's quantity, billed by the bill lines
        // against its receipts, short-closed lines settled rather than owed.
        const rows = orders.map((o) => {
          let ordered = 0
          let received = 0
          let pending = 0
          let billed = 0
          for (const l of o.lines) {
            const qty = Number(l.qty)
            const amount = Number(l.amount)
            const live = l.grnLines.filter((g) => g.grn.status !== 'CANCELLED')
            const got = live.reduce((s, g) => s + Number(g.receivedQty), 0)
            ordered += amount
            if (qty > 0) {
              received += (Math.min(got, qty) / qty) * amount
              if (!l.shortClosed) pending += (Math.max(0, qty - got) / qty) * amount
              if (o.status !== 'CANCELLED')
                for (const g of live) add('received', g.grn.grnDate, (Math.min(Number(g.receivedQty), qty) / qty) * amount)
            }
            for (const g of live)
              for (const b of g.billLines) if (b.bill.status !== 'CANCELLED') billed += Number(b.taxableValue)
          }
          return { ...o, ordered, received, pending, unbilled: Math.max(0, received - billed) }
        })

        const open = rows.filter((r) => PO_OPEN.has(r.status) && r.pending > 0.005)
        const late = open.filter((r) => r.deliveryDate && istDay(r.deliveryDate) < today)
        const unbilled = rows.filter((r) => r.status !== 'CANCELLED' && r.unbilled > 1)
        const live = rows.filter((r) => r.status !== 'CANCELLED')
        const now = live.filter((r) => inPeriod(r.poDate))
        const before = live.filter((r) => inPrev(r.poDate))
        for (const r of now) add('ordered', r.poDate, r.ordered)

        const suppliers = new Map<string, { id: string; name: string; value: number; orders: number }>()
        for (const r of now) {
          const s = suppliers.get(r.supplier.id) ?? { ...r.supplier, value: 0, orders: 0 }
          s.value += r.ordered
          s.orders += 1
          suppliers.set(r.supplier.id, s)
        }

        const count = (s: string) => byStatus.find((g) => g.status === s)?._count._all ?? 0
        const sum = (list: typeof rows, pick: (r: (typeof rows)[number]) => number) => r2(list.reduce((t, r) => t + pick(r), 0))

        checks.push(
          {
            key: 'po-late',
            module: 'purchase',
            label: 'Purchase orders past their wanted-by date',
            clear: 'No purchase order is late',
            count: late.length,
            value: sum(late, (r) => r.pending),
            tone: 'rose',
            href: '/purchase/dashboard',
          },
          {
            key: 'po-draft',
            module: 'purchase',
            label: 'Purchase orders not yet sent',
            clear: 'Every purchase order has gone out',
            count: count('DRAFT'),
            value: r2(Number(byStatus.find((g) => g.status === 'DRAFT')?._sum.taxableAmount ?? 0)),
            tone: 'amber',
            href: '/purchase/orders',
          },
          {
            key: 'po-unbilled',
            module: 'purchase',
            label: 'Deliveries waiting for the supplier’s bill',
            clear: 'Every delivery is billed',
            count: unbilled.length,
            value: sum(unbilled, (r) => r.unbilled),
            tone: 'amber',
            href: '/reports/grn-against-bill',
          },
        )

        const receivedNow = rows
          .filter((r) => r.status !== 'CANCELLED')
          .flatMap((r) => r.lines)
          .reduce((t, l) => {
            const qty = Number(l.qty)
            if (qty <= 0) return t
            return (
              t +
              l.grnLines
                .filter((g) => g.grn.status !== 'CANCELLED' && inPeriod(g.grn.grnDate))
                .reduce((s, g) => s + (Math.min(Number(g.receivedQty), qty) / qty) * Number(l.amount), 0)
            )
          }, 0)

        return {
          openOrders: open.length,
          openValue: sum(open, (r) => r.pending),
          late: late.length,
          lateValue: sum(late, (r) => r.pending),
          drafts: count('DRAFT'),
          unbilled: unbilled.length,
          unbilledValue: sum(unbilled, (r) => r.unbilled),
          ordered: {
            value: sum(now, (r) => r.ordered),
            orders: now.length,
            change: change(sum(now, (r) => r.ordered), sum(before, (r) => r.ordered)),
          },
          received: r2(receivedNow),
          status: PO_STAGES.map(([status, label]) => ({
            status,
            label,
            count: count(status),
            value: r2(Number(byStatus.find((g) => g.status === status)?._sum.taxableAmount ?? 0)),
          })),
          suppliers: [...suppliers.values()]
            .map((s) => ({ ...s, value: r2(s.value) }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 8),
        }
      })()
    : null

  /* ═════════════════════════════ STORES ═════════════════════════════ */
  const inventoryP = access.inventory
    ? (async () => {
        const [rows, reorder, bufferPercent, flows, mrPending, mrToIssue, challans] = await Promise.all([
          onHand(prisma),
          reorderStatus(prisma),
          getNumericPreference('lowStockBufferPercent', 0),
          prisma.$queryRaw<Array<{ day: string; type: string; inValue: number; outValue: number; moves: number }>>`
            SELECT
              to_char((s."transactionDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
              s."transactionType"::text AS type,
              COALESCE(SUM(s."inQty"  * COALESCE(s."unitRate", 0)), 0)::float8 AS "inValue",
              COALESCE(SUM(s."outQty" * COALESCE(s."unitRate", 0)), 0)::float8 AS "outValue",
              COUNT(*)::int AS moves
            FROM ld_erp.stock_ledger s
            WHERE s."transactionDate" >= ${prevFrom} AND s.ownership = 'OWNED'
            GROUP BY 1, 2`,
          prisma.materialRequisition.count({ where: { status: 'PENDING', closedAt: null } }),
          prisma.materialRequisition.count({ where: { status: 'APPROVED', closedAt: null, issuedAt: null } }),
          prisma.jobWorkChallan.findMany({
            where: { status: { in: ['SENT', 'PARTLY_BACK'] } },
            select: { expectedBackOn: true },
          }),
        ])

        // Our own stock only: a customer's cloth in our godown is never in our value.
        const owned = rows.filter((r) => r.ownership === 'OWNED' && r.qty > 0)
        const types = await prisma.item.findMany({
          where: { id: { in: [...new Set(owned.map((r) => r.itemId))] } },
          select: { id: true, type: true },
        })
        const typeOf = new Map(types.map((t) => [t.id, t.type as string]))
        const byType = new Map<string, { type: string; label: string; value: number; items: Set<string> }>()
        for (const r of owned) {
          const t = typeOf.get(r.itemId) ?? 'RAW_MATERIAL'
          const g = byType.get(t) ?? { type: t, label: ITEM_TYPES[t] ?? t, value: 0, items: new Set<string>() }
          g.value += r.value
          g.items.add(r.itemId)
          byType.set(t, g)
        }

        // The same warning as the stock screen and the low-stock card.
        const warned = reorder
          .map((i) => ({
            itemId: i.itemId,
            name: i.itemName,
            uom: i.uom,
            onHand: i.onHand,
            reorderLevel: i.reorderLevel,
            cover: i.reorderLevel > 0 ? Math.round((i.onHand / i.reorderLevel) * 100) : 0,
            low: i.isLow,
          }))
          .filter((i) => i.onHand <= i.reorderLevel * (1 + bufferPercent / 100))
          .sort((a, b) => Number(b.low) - Number(a.low) || a.cover - b.cover)

        series('stockIn')
        series('stockOut')
        let inNow = 0
        let outNow = 0
        let receivedNow = 0
        let issuedNow = 0
        let moves = 0
        for (const f of flows) {
          add('stockIn', f.day, f.inValue)
          add('stockOut', f.day, f.outValue)
          if (f.day < fromDay) continue
          inNow += f.inValue
          outNow += f.outValue
          moves += f.moves
          if (f.type === 'PURCHASE') receivedNow += f.inValue
          if (f.type === 'ISSUE') issuedNow += f.outValue
        }

        const jobLate = challans.filter((c) => c.expectedBackOn && istDay(c.expectedBackOn) < today).length
        const toReorder = warned.filter((i) => i.low).length

        checks.push(
          {
            key: 'stock-low',
            module: 'inventory',
            label: 'Items at or below their reorder level',
            clear: 'Nothing needs reordering',
            count: toReorder,
            value: null,
            tone: 'amber',
            href: '/inventory/stock?low=true',
          },
          {
            key: 'mr-issue',
            module: 'inventory',
            label: 'Approved requisitions waiting to be issued',
            clear: 'Every approved requisition is issued',
            count: mrToIssue,
            value: null,
            tone: 'blue',
            href: '/inventory/requisitions',
          },
          {
            key: 'jobwork-late',
            module: 'inventory',
            label: 'Job work past its expected return',
            clear: 'No job work is overdue',
            count: jobLate,
            value: null,
            tone: 'rose',
            href: '/inventory/job-work',
          },
        )

        const stockValue = owned.reduce((t, r) => t + r.value, 0)
        return {
          stockValue: r2(stockValue),
          items: new Set(owned.map((r) => r.itemId)).size,
          byType: [...byType.values()]
            .map((g) => ({ type: g.type, label: g.label, value: r2(g.value), items: g.items.size }))
            .sort((a, b) => b.value - a.value),
          toReorder,
          comingUp: warned.length - toReorder,
          reorder: warned.slice(0, 6),
          mrPending,
          mrToIssue,
          jobWorkOpen: challans.length,
          jobWorkLate: jobLate,
          period: { inValue: r2(inNow), outValue: r2(outNow), received: r2(receivedNow), issued: r2(issuedNow), moves },
        }
      })()
    : null

  /* ═════════════════════════════ PRODUCTION ═════════════════════════════ */
  const productionP = access.production
    ? (async () => {
        const fortnight = addDays(today, -13)
        const since = istStart(fortnight < prevFromDay ? fortnight : prevFromDay)
        const [byStatus, entries, lateMOs] = await Promise.all([
          prisma.manufacturingOrder.groupBy({
            by: ['status'],
            _count: { _all: true },
            _sum: { totalPlannedQty: true, totalFinishedQty: true },
          }),
          prisma.productionEntry.findMany({
            where: { entryDate: { gte: since } },
            select: { entryDate: true, target: true, achieved: true, rejection: true, workstationId: true },
          }),
          prisma.manufacturingOrder.count({
            where: { status: { notIn: ['DRAFT', 'COMPLETED', 'CLOSED'] }, plannedEndDate: { lt: todayStart } },
          }),
        ])

        series('produced')
        const daily = new Map<string, { target: number; achieved: number; rejection: number }>()
        for (let d = fortnight; d <= today; d = addDays(d, 1)) daily.set(d, { target: 0, achieved: 0, rejection: 0 })
        const lines = new Map<string, { target: number; achieved: number; rejection: number }>()
        let madeNow = 0
        let madeBefore = 0
        for (const e of entries) {
          const day = istDay(e.entryDate)
          add('produced', day, e.achieved)
          if (day >= fromDay) madeNow += e.achieved
          else if (day >= prevFromDay) madeBefore += e.achieved
          const d = daily.get(day)
          if (d) {
            d.target += e.target
            d.achieved += e.achieved
            d.rejection += e.rejection
          }
          if (day === today) {
            const k = e.workstationId ?? ''
            const l = lines.get(k) ?? { target: 0, achieved: 0, rejection: 0 }
            l.target += e.target
            l.achieved += e.achieved
            l.rejection += e.rejection
            lines.set(k, l)
          }
        }

        // Most lines are outside job-work units, so the unit's name rides along.
        const stations = lines.size
          ? await prisma.workstation.findMany({
              where: { id: { in: [...lines.keys()].filter(Boolean) } },
              select: { id: true, name: true, type: true },
            })
          : []
        const station = new Map(stations.map((s) => [s.id, s]))
        const t = daily.get(today) ?? { target: 0, achieved: 0, rejection: 0 }
        const count = (s: string) => byStatus.find((g) => g.status === s)?._count._all ?? 0

        checks.push({
          key: 'mo-late',
          module: 'production',
          label: 'Manufacturing orders past their planned finish',
          clear: 'No manufacturing order is behind plan',
          count: lateMOs,
          value: null,
          tone: 'rose',
          href: '/production/orders',
        })

        return {
          today: {
            target: t.target,
            achieved: t.achieved,
            rejection: t.rejection,
            efficiency: t.target > 0 ? Math.round((t.achieved / t.target) * 100) : null,
          },
          lines: [...lines.entries()]
            .map(([id, l]) => ({
              line: station.get(id)?.name ?? 'Unassigned',
              isJobWork: station.get(id)?.type === 'JOB_WORK',
              ...l,
              efficiency: l.target > 0 ? Math.round((l.achieved / l.target) * 100) : null,
            }))
            .sort((a, b) => a.line.localeCompare(b.line, undefined, { numeric: true })),
          fortnight: [...daily.entries()].map(([day, d]) => ({ day, ...d })),
          stages: MO_STAGES.map(([status, label]) => ({
            status,
            label,
            count: count(status),
            planned: byStatus.find((g) => g.status === status)?._sum.totalPlannedQty ?? 0,
          })),
          activeOrders: byStatus
            .filter((g) => !['DRAFT', 'COMPLETED', 'CLOSED'].includes(g.status))
            .reduce((n, g) => n + g._count._all, 0),
          lateOrders: lateMOs,
          made: { pieces: madeNow, change: change(madeNow, madeBefore) },
        }
      })()
    : null

  /* ═════════════════════════════ MONEY ═════════════════════════════ */
  const moneyP = access.money
    ? (async () => {
        const [owedToUs, owedByUs, invoices, bills, receipts, payments] = await Promise.all([
          prisma.salesInvoice.findMany({
            where: { status: { in: ['UNPAID', 'PARTIAL'] } },
            select: { balanceAmount: true, dueDate: true },
          }),
          prisma.purchaseInvoice.findMany({
            where: { status: { in: ['UNPAID', 'PARTIAL'] } },
            select: { balanceAmount: true, dueDate: true },
          }),
          prisma.salesInvoice.findMany({
            where: { invoiceDate: { gte: prevFrom }, status: { not: 'CANCELLED' } },
            select: { invoiceDate: true, totalAmount: true },
          }),
          prisma.purchaseInvoice.findMany({
            where: { billDate: { gte: prevFrom }, status: { not: 'CANCELLED' } },
            select: { billDate: true, totalAmount: true },
          }),
          prisma.paymentReceipt.findMany({
            where: { receiptDate: { gte: prevFrom } },
            select: { receiptDate: true, amount: true },
          }),
          prisma.supplierPayment.findMany({
            where: { paymentDate: { gte: prevFrom }, status: 'POSTED' },
            select: { paymentDate: true, amount: true },
          }),
        ])

        /** What is owed, by how late it is. A document with no due date is not yet due. */
        const ageing = (list: Array<{ balanceAmount: unknown; dueDate: Date | null }>) => {
          const b = Object.fromEntries(AGE.map((a) => [a.key, { value: 0, count: 0 }])) as Record<(typeof AGE)[number]['key'], { value: number; count: number }>
          let dueWeek = 0
          for (const d of list) {
            const v = Number(d.balanceAmount)
            if (v <= 0) continue
            const due = d.dueDate ? istDay(d.dueDate) : null
            const late = due ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DAY) : 0
            const key = late <= 0 ? 'notDue' : late <= 30 ? 'd30' : late <= 60 ? 'd60' : late <= 90 ? 'd90' : 'older'
            b[key].value += v
            b[key].count += 1
            if (due && due >= today && due <= weekEnd) dueWeek += v
          }
          const total = AGE.reduce((t, a) => t + b[a.key].value, 0)
          const overdue = total - b.notDue.value
          return {
            total: r2(total),
            overdue: r2(overdue),
            overdueCount: AGE.slice(1).reduce((n, a) => n + b[a.key].count, 0),
            dueWeek: r2(dueWeek),
            buckets: AGE.map((a) => ({ key: a.key, label: a.label, value: r2(b[a.key].value), count: b[a.key].count })),
          }
        }

        const flow = <T>(list: T[], date: (x: T) => Date, amount: (x: T) => number, name: string) => {
          series(name)
          let now = 0
          let before = 0
          for (const x of list) {
            const d = date(x)
            const v = Number(amount(x))
            if (inPeriod(d)) {
              now += v
              add(name, d, v)
            } else if (inPrev(d)) before += v
          }
          return { value: r2(now), change: change(now, before) }
        }

        const receivable = ageing(owedToUs)
        const payable = ageing(owedByUs)

        checks.push(
          {
            key: 'recv-overdue',
            module: 'accounts',
            label: 'Customer invoices past their due date',
            clear: 'No customer is overdue',
            count: receivable.overdueCount,
            value: receivable.overdue,
            tone: 'rose',
            href: null,
          },
          {
            key: 'pay-overdue',
            module: 'accounts',
            label: 'Supplier bills past their due date',
            clear: 'No supplier bill is overdue',
            count: payable.overdueCount,
            value: payable.overdue,
            tone: 'rose',
            href: '/reports/supplier-outstanding',
          },
        )

        return {
          receivable,
          payable,
          invoiced: flow(invoices, (i) => i.invoiceDate, (i) => Number(i.totalAmount), 'invoiced'),
          billed: flow(bills, (b) => b.billDate, (b) => Number(b.totalAmount), 'billed'),
          collected: flow(receipts, (r) => r.receiptDate, (r) => Number(r.amount), 'collected'),
          paid: flow(payments, (p) => p.paymentDate, (p) => Number(p.amount), 'paid'),
        }
      })()
    : null

  /* ═════════════════════════════ ACTIVITY ═════════════════════════════ */
  // Who did what, only in the modules this person may look at.
  const modules = Object.entries(AUDIT_GATE)
    .filter(([, gate]) => access[gate])
    .map(([m]) => m)
  const heatFromDay = addDays(today, -83)
  const activityP = modules.length
    ? Promise.all([
        prisma.$queryRaw<Array<{ day: string; module: string; n: number }>>`
          SELECT
            to_char((a."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
            a.module,
            COUNT(*)::int AS n
          FROM ld_erp.audit_logs a
          WHERE a."createdAt" >= ${istStart(heatFromDay)} AND a.module = ANY(${modules})
          GROUP BY 1, 2`,
        prisma.auditLog.groupBy({
          by: ['module', 'action'],
          where: { createdAt: { gte: from }, module: { in: modules } },
          _count: { _all: true },
        }),
        prisma.auditLog.findMany({
          where: { module: { in: modules } },
          orderBy: { createdAt: 'desc' },
          take: 14,
          select: {
            id: true,
            module: true,
            action: true,
            entityType: true,
            entityId: true,
            before: true,
            after: true,
            createdAt: true,
            user: { select: { name: true } },
          },
        }),
      ])
    : Promise.resolve([[], [], []] as const)

  // The sections are independent: ask for them all at once.
  const [sales, purchase, inventory, production, money, [heatRows, byModule, feed]] = await Promise.all([
    salesP,
    purchaseP,
    inventoryP,
    productionP,
    moneyP,
    activityP,
  ])
  // They report in whatever order they finish; the checks read best in the mill's order.
  const ORDER = ['approvals', 'sales', 'purchase', 'inventory', 'production', 'accounts']
  checks.sort((a, b) => ORDER.indexOf(a.module) - ORDER.indexOf(b.module))

  const heat = new Map<string, { day: string; total: number; byModule: Record<string, number> }>()
  for (let d = heatFromDay; d <= today; d = addDays(d, 1)) heat.set(d, { day: d, total: 0, byModule: {} })
  for (const h of heatRows) {
    const cell = heat.get(h.day)
    if (!cell) continue
    cell.total += h.n
    cell.byModule[h.module] = (cell.byModule[h.module] ?? 0) + h.n
  }

  const moduleTotals = new Map<string, { module: string; total: number; created: number; changed: number; approved: number; removed: number }>()
  for (const g of byModule) {
    const m = moduleTotals.get(g.module) ?? { module: g.module, total: 0, created: 0, changed: 0, approved: 0, removed: 0 }
    const n = g._count._all
    m.total += n
    if (g.action === 'CREATE') m.created += n
    else if (g.action === 'DELETE') m.removed += n
    else if (g.action === 'APPROVE' || g.action === 'REJECT') m.approved += n
    else m.changed += n
    moduleTotals.set(g.module, m)
  }

  return {
    generatedAt: new Date().toISOString(),
    today,
    period: { days, from: fromDay, to: today, bucket },
    sales,
    purchase,
    inventory,
    production,
    money,
    trend: [...trend.values()],
    checks,
    activity: {
      heat: [...heat.values()],
      modules: [...moduleTotals.values()].sort((a, b) => b.total - a.total),
      feed: feed.map((f) => ({
        id: f.id,
        at: f.createdAt.toISOString(),
        user: f.user?.name ?? 'Someone',
        module: f.module,
        action: f.action,
        entityType: f.entityType,
        label: labelOf(f.after, f.before),
      })),
    },
  }
}

export type HomeDashboard = Awaited<ReturnType<typeof homeDashboard>>
