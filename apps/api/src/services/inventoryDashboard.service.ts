import { prisma, Prisma } from '@ld-erp/database'
import { onHand, reorderStatus } from './stock.service'

/**
 * Everything the inventory dashboard shows, in one call.
 *
 * Stock figures are for today (optionally one store); movement figures are for
 * the chosen number of days. Our own stock only is valued — a customer's cloth
 * in our godown is counted apart and never priced, as everywhere else.
 */

const DAY = 86400000
const round2 = (n: number) => Math.round(n * 100) / 100

/** Days since, in whole days; null when never. */
const age = (d: Date | null) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null)

const AGE_BUCKETS = [
  { key: '0-30', label: '0–30 days', max: 30 },
  { key: '31-60', label: '31–60 days', max: 60 },
  { key: '61-90', label: '61–90 days', max: 90 },
  { key: '91-180', label: '91–180 days', max: 180 },
  { key: '180+', label: 'Over 180 days', max: Infinity },
]

export async function inventoryDashboard(opts: { warehouseId?: string; days: number }) {
  const { warehouseId } = opts
  const days = Math.min(365, Math.max(7, opts.days))
  const since = new Date(Date.now() - (days - 1) * DAY)
  since.setHours(0, 0, 0, 0)
  // The activity calendar always shows twelve weeks, whatever the period.
  const heatDays = 84
  const from = new Date(Date.now() - (Math.max(days, heatDays) - 1) * DAY)
  from.setHours(0, 0, 0, 0)
  const store = warehouseId ? Prisma.sql`AND s."warehouseId" = ${warehouseId}` : Prisma.empty

  const [rows, reorder, daily, mix, movers, mrPending, mrApproved, mrPartly, mrIssued, mrRejected, challans] =
    await Promise.all([
      onHand(prisma, { warehouseId }),
      reorderStatus(prisma),
      prisma.$queryRaw<Array<{ day: string; inValue: number; outValue: number; moves: number; ins: number; outs: number }>>`
        SELECT
          to_char((s."transactionDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
          COALESCE(SUM(s."inQty"  * COALESCE(s."unitRate", 0)), 0)::float8 AS "inValue",
          COALESCE(SUM(s."outQty" * COALESCE(s."unitRate", 0)), 0)::float8 AS "outValue",
          COUNT(*)::int AS moves,
          COUNT(*) FILTER (WHERE s."inQty" > 0)::int AS ins,
          COUNT(*) FILTER (WHERE s."inQty" <= 0)::int AS outs
        FROM ld_erp.stock_ledger s
        WHERE s."transactionDate" >= ${from} ${store}
        GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<Array<{ type: string; moves: number; value: number }>>`
        SELECT s."transactionType"::text AS type, COUNT(*)::int AS moves,
          COALESCE(SUM((s."inQty" + s."outQty") * COALESCE(s."unitRate", 0)), 0)::float8 AS value
        FROM ld_erp.stock_ledger s
        WHERE s."transactionDate" >= ${since} ${store}
        GROUP BY 1`,
      prisma.$queryRaw<Array<{ itemId: string; code: string; name: string; uom: string; moves: number; inValue: number; outValue: number }>>`
        SELECT s."itemId", MAX(i.code) AS code, MAX(i.name) AS name, MAX(u.symbol) AS uom, COUNT(*)::int AS moves,
          COALESCE(SUM(s."inQty"  * COALESCE(s."unitRate", 0)), 0)::float8 AS "inValue",
          COALESCE(SUM(s."outQty" * COALESCE(s."unitRate", 0)), 0)::float8 AS "outValue"
        FROM ld_erp.stock_ledger s
        JOIN ld_erp.items i ON i.id = s."itemId"
        JOIN ld_erp.uom u ON u.id = i."uomId"
        WHERE s."transactionDate" >= ${since} ${store}
        GROUP BY s."itemId"
        ORDER BY SUM((s."inQty" + s."outQty") * COALESCE(s."unitRate", 0)) DESC, COUNT(*) DESC
        LIMIT 8`,
      prisma.materialRequisition.count({ where: { status: 'PENDING', closedAt: null } }),
      prisma.materialRequisition.count({
        where: { status: 'APPROVED', closedAt: null, issuedAt: null, lines: { none: { issuedQty: { gt: 0 } } } },
      }),
      prisma.materialRequisition.count({
        where: { status: 'APPROVED', closedAt: null, issuedAt: null, lines: { some: { issuedQty: { gt: 0 } } } },
      }),
      prisma.materialRequisition.count({ where: { issuedAt: { gte: since } } }),
      prisma.materialRequisition.count({ where: { status: 'REJECTED', updatedAt: { gte: since } } }),
      prisma.jobWorkChallan.findMany({
        where: { status: { in: ['SENT', 'PARTLY_BACK'] } },
        orderBy: { challanDate: 'asc' },
        include: {
          jobWorker: { select: { name: true } },
          lines: { select: { id: true, qty: true, unitRate: true, returnLines: { select: { consumedQty: true } } } },
        },
      }),
    ])

  // ── what each item is ──
  const ids = [...new Set([...rows.map((r) => r.itemId), ...reorder.map((r) => r.itemId)])]
  const items = await prisma.item.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, type: true,
      category: { select: { name: true, parent: { select: { name: true } } } },
      department: { select: { name: true } },
    },
  })
  const about = new Map(
    items.map((i) => [
      i.id,
      {
        type: i.type as string,
        category: i.category.parent?.name ?? i.category.name,
        sub: i.category.parent ? i.category.name : null,
        department: i.department?.name ?? 'No department',
      },
    ]),
  )

  const owned = rows.filter((r) => r.ownership === 'OWNED' && r.qty > 0)
  const theirs = rows.filter((r) => r.ownership === 'CUSTOMER_OWNED' && r.qty > 0)
  const stockValue = owned.reduce((t, r) => t + r.value, 0)

  const groupBy = (key: (r: (typeof owned)[number]) => string) => {
    const m = new Map<string, { name: string; value: number; lines: number; items: Set<string> }>()
    for (const r of owned) {
      const k = key(r)
      const cur = m.get(k) ?? { name: k, value: 0, lines: 0, items: new Set<string>() }
      cur.value += r.value
      cur.lines += 1
      cur.items.add(r.itemId)
      m.set(k, cur)
    }
    return [...m.values()]
      .map((g) => ({ name: g.name, value: round2(g.value), lines: g.lines, items: g.items.size }))
      .sort((a, b) => b.value - a.value)
  }

  const byStore = (() => {
    const m = new Map<string, { id: string; name: string; value: number; lines: number }>()
    for (const r of owned) {
      const cur = m.get(r.warehouseId) ?? { id: r.warehouseId, name: r.warehouseName, value: 0, lines: 0 }
      cur.value += r.value
      cur.lines += 1
      m.set(r.warehouseId, cur)
    }
    return [...m.values()].map((s) => ({ ...s, value: round2(s.value) })).sort((a, b) => b.value - a.value)
  })()

  // Category, with its sub-categories inside, for the treemap.
  const byCategory = (() => {
    const m = new Map<string, { name: string; value: number; children: Map<string, number> }>()
    for (const r of owned) {
      const a = about.get(r.itemId)
      const cat = a?.category ?? r.categoryName
      const sub = a?.sub ?? cat
      const cur = m.get(cat) ?? { name: cat, value: 0, children: new Map() }
      cur.value += r.value
      cur.children.set(sub, (cur.children.get(sub) ?? 0) + r.value)
      m.set(cat, cur)
    }
    return [...m.values()]
      .map((c) => ({
        name: c.name,
        value: round2(c.value),
        children: [...c.children.entries()].map(([name, value]) => ({ name, value: round2(value) })).sort((a, b) => b.value - a.value),
      }))
      .sort((a, b) => b.value - a.value)
  })()

  const byDepartment = groupBy((r) => about.get(r.itemId)?.department ?? 'No department')
  const byType = groupBy((r) => about.get(r.itemId)?.type ?? 'OTHER')

  // ── ageing: how long since each line last moved ──
  const ageing = AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label, value: 0, lines: 0 }))
  for (const r of owned) {
    const d = age(r.lastMovedAt) ?? 9999
    const i = AGE_BUCKETS.findIndex((b) => d <= b.max)
    ageing[i].value += r.value
    ageing[i].lines += 1
  }
  ageing.forEach((a) => (a.value = round2(a.value)))
  const dead = owned
    .filter((r) => (age(r.lastMovedAt) ?? 9999) > 90)
    .sort((a, b) => b.value - a.value)
  const deadValue = dead.reduce((t, r) => t + r.value, 0)

  // ── ABC: the few items that hold most of the value ──
  const perItem = new Map<string, { itemId: string; code: string; name: string; value: number }>()
  for (const r of owned) {
    const cur = perItem.get(r.itemId) ?? { itemId: r.itemId, code: r.itemCode, name: r.itemName, value: 0 }
    cur.value += r.value
    perItem.set(r.itemId, cur)
  }
  const ranked = [...perItem.values()].filter((i) => i.value > 0).sort((a, b) => b.value - a.value)
  let run = 0
  const abcAll = ranked.map((i) => {
    const before = run
    run += i.value
    const cls = stockValue && before / stockValue < 0.8 ? 'A' : stockValue && before / stockValue < 0.95 ? 'B' : 'C'
    return { ...i, value: round2(i.value), cumPct: stockValue ? Math.round((run / stockValue) * 1000) / 10 : 0, cls }
  })
  const abcSummary = (['A', 'B', 'C'] as const).map((c) => {
    const inClass = abcAll.filter((i) => i.cls === c)
    return { cls: c, items: inClass.length, value: round2(inClass.reduce((t, i) => t + i.value, 0)) }
  })

  // ── reorder watch ──
  const low = reorder
    .filter((r) => r.isLow)
    .map((r) => ({
      itemId: r.itemId,
      code: r.itemCode,
      name: r.itemName,
      uom: r.uom,
      category: about.get(r.itemId)?.category ?? r.categoryName,
      onHand: r.onHand,
      reorderLevel: r.reorderLevel,
      cover: r.reorderLevel ? Math.round((r.onHand / r.reorderLevel) * 100) : 0,
    }))
    .sort((a, b) => a.cover - b.cover)

  // ── movement over time ──
  const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const byDay = new Map(daily.map((d) => [d.day, d]))
  const series: Array<{ day: string; inValue: number; outValue: number; moves: number; ins: number; outs: number }> = []
  for (let t = since.getTime(); t <= Date.now(); t += DAY) {
    const k = dayKey(new Date(t))
    const d = byDay.get(k)
    series.push({ day: k, inValue: round2(d?.inValue ?? 0), outValue: round2(d?.outValue ?? 0), moves: d?.moves ?? 0, ins: d?.ins ?? 0, outs: d?.outs ?? 0 })
  }
  const heat: Array<{ day: string; moves: number }> = []
  for (let t = Date.now() - (heatDays - 1) * DAY; t <= Date.now(); t += DAY) {
    const k = dayKey(new Date(t))
    heat.push({ day: k, moves: byDay.get(k)?.moves ?? 0 })
  }
  const inValue = series.reduce((t, d) => t + d.inValue, 0)
  const outValue = series.reduce((t, d) => t + d.outValue, 0)

  // ── goods at job workers ──
  const now = Date.now()
  const jobWork = challans.map((c) => {
    let outValue = 0
    let outLines = 0
    for (const l of c.lines) {
      const left = Number(l.qty) - l.returnLines.reduce((t, r) => t + Number(r.consumedQty), 0)
      if (left > 0.0005) {
        outLines += 1
        outValue += left * Number(l.unitRate ?? 0)
      }
    }
    const daysOut = Math.floor((now - c.challanDate.getTime()) / DAY)
    const gstDue = new Date(c.challanDate)
    gstDue.setFullYear(gstDue.getFullYear() + 1)
    return {
      id: c.id,
      challanNumber: c.challanNumber,
      jobWorker: c.jobWorker.name,
      process: c.process,
      status: c.status,
      challanDate: c.challanDate,
      expectedBackOn: c.expectedBackOn,
      daysOut,
      overdue: Boolean(c.expectedBackOn && c.expectedBackOn.getTime() < now),
      gstDaysLeft: Math.ceil((gstDue.getTime() - now) / DAY),
      outLines,
      outValue: round2(outValue),
    }
  })

  // ── customers' material held ──
  const custMap = new Map<string, { name: string; lines: number }>()
  for (const r of theirs) {
    const k = r.ownerCustomerId ?? 'unknown'
    const cur = custMap.get(k) ?? { name: r.ownerName ?? 'Customer', lines: 0 }
    cur.lines += 1
    custMap.set(k, cur)
  }

  return {
    period: { days, from: dayKey(since), to: dayKey(new Date()) },
    kpis: {
      stockValue: round2(stockValue),
      items: new Set(owned.map((r) => r.itemId)).size,
      lines: owned.length,
      stores: new Set(owned.map((r) => r.warehouseId)).size,
      toReorder: low.length,
      deadValue: round2(deadValue),
      deadLines: dead.length,
      mrWaiting: mrPending + mrApproved + mrPartly,
      mrPending,
      openChallans: jobWork.length,
      overdueChallans: jobWork.filter((j) => j.overdue).length,
      atJobWorkers: round2(jobWork.reduce((t, j) => t + j.outValue, 0)),
      customerLines: theirs.length,
      customers: custMap.size,
      inValue: round2(inValue),
      outValue: round2(outValue),
      moves: series.reduce((t, d) => t + d.moves, 0),
    },
    byStore,
    byCategory,
    byDepartment,
    byType,
    ageing,
    dead: dead.slice(0, 8).map((r) => ({
      itemId: r.itemId, code: r.itemCode, name: r.itemName, store: r.warehouseName,
      qty: r.qty, uom: r.uom, value: round2(r.value), days: age(r.lastMovedAt),
    })),
    abc: { top: abcAll.slice(0, 20), summary: abcSummary, total: abcAll.length },
    reorder: low.slice(0, 12),
    series,
    heat,
    mix: mix.map((m) => ({ ...m, value: round2(m.value) })).sort((a, b) => b.moves - a.moves),
    movers: movers.map((m) => ({ ...m, inValue: round2(m.inValue), outValue: round2(m.outValue) })),
    requisitions: { pending: mrPending, approved: mrApproved, partly: mrPartly, issued: mrIssued, rejected: mrRejected },
    jobWork: jobWork.slice(0, 10),
    customers: [...custMap.values()].sort((a, b) => b.lines - a.lines),
  }
}
