import type { Panel, ReportDefinition } from '../types'
import { round2, topWithRest } from './shared'
import { categoryFilter, loadCategories, rupees, warehouseFilter } from './inventory-shared'

const r3 = (n: number) => Math.round(n * 1000) / 1000
const items = (n: number) => `${n} item${n === 1 ? '' : 's'}`

const STATUS = {
  OUT: 'Out of stock',
  BELOW_MIN: 'Below minimum',
  REORDER: 'Reorder now',
  OVER_MAX: 'Over maximum',
  OK: 'Enough',
  NO_LEVEL: 'No levels set',
} as const
type Status = keyof typeof STATUS

/**
 * What to buy, and what is sitting in excess.
 *
 * For every item with stock levels set: what is on hand, what open
 * requisitions still want from it, what is already on order, and so what the
 * stock will be once both land. An item is flagged on that projected figure,
 * not on the shelf alone — fifty metres short means nothing if a hundred are
 * arriving on Monday.
 */
export const reorderStatus: ReportDefinition = {
  id: 'reorder-status',
  module: 'inventory',
  title: 'Reorder & Low Stock',
  description:
    'Items out of stock, below their minimum or reorder level, or over their maximum — counting what open requisitions want and what is already on order — with a suggested quantity to buy.',
  filters: [
    warehouseFilter,
    categoryFilter,
    { key: 'all', label: 'Include items with enough stock', type: 'boolean' },
  ],
  columns: [
    { key: 'status', label: 'Status', type: 'badge', width: 16,
      badges: STATUS,
      badgeTones: { OUT: 'bad', BELOW_MIN: 'bad', REORDER: 'warn', OVER_MAX: 'warn', OK: 'good', NO_LEVEL: 'neutral' } },
    { key: 'category', label: 'Category', type: 'text', width: 18 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'onHand', label: 'On Hand', type: 'qty', total: 'none' },
    { key: 'reserved', label: 'Reserved', type: 'qty', total: 'none' },
    { key: 'wanted', label: 'Wanted on Requisitions', type: 'qty', total: 'none' },
    { key: 'onOrder', label: 'On Order', type: 'qty', total: 'none' },
    { key: 'projected', label: 'Projected', type: 'qty', total: 'none' },
    { key: 'minStock', label: 'Minimum', type: 'qty', total: 'none' },
    { key: 'reorderLevel', label: 'Reorder Level', type: 'qty', total: 'none' },
    { key: 'maxStock', label: 'Maximum', type: 'qty', total: 'none' },
    { key: 'suggested', label: 'Suggested Buy', type: 'qty', total: 'none' },
    { key: 'rate', label: 'Rate', type: 'money', total: 'none' },
    { key: 'suggestedValue', label: 'Suggested Value', type: 'money', total: 'sum' },
    { key: 'excessValue', label: 'Excess Value', type: 'money', total: 'sum' },
  ],
  summary: {
    title: 'Biggest buys suggested',
    columns: ['status', 'item', 'onHand', 'projected', 'reorderLevel', 'suggested', 'suggestedValue'],
    by: 'suggestedValue',
    limit: 12,
  },
  pivot: {
    rows: ['status', 'category'],
    values: ['suggestedValue', 'excessValue'],
    slicers: ['category'],
    note: 'Open a status to see which categories need buying.',
  },

  async run({ tx, params, rowCap }) {
    const cats = await loadCategories(tx)
    const catIds = cats.under(params.categoryId)
    const store = params.warehouseId

    const catalogue = await tx.item.findMany({
      where: { isActive: true, ...(catIds ? { categoryId: { in: catIds } } : {}) },
      select: {
        id: true, code: true, name: true, categoryId: true,
        reorderLevel: true, minStock: true, maxStock: true, standardRate: true,
        uom: { select: { symbol: true } },
      },
    })
    const ids = catalogue.map((i) => i.id)

    const [stock, reserved, wanted, ordered] = await Promise.all([
      tx.stockLedger.groupBy({
        by: ['itemId'],
        where: { itemId: { in: ids }, ownership: 'OWNED', ...(store ? { warehouseId: store } : {}) },
        _sum: { inQty: true, outQty: true },
      }),
      tx.stockReservation.groupBy({
        by: ['itemId'],
        where: { itemId: { in: ids }, status: 'ACTIVE', ...(store ? { warehouseId: store } : {}) },
        _sum: { qty: true },
      }),
      // What open requisitions still want issued from our stock.
      tx.materialRequisitionLine.findMany({
        where: {
          itemId: { in: ids },
          ownership: 'OWNED',
          ...(store ? { warehouseId: store } : {}),
          mr: { status: { in: ['PENDING', 'APPROVED'] }, closedAt: null },
        },
        select: { itemId: true, requestedQty: true, issuedQty: true },
      }),
      // What is ordered and not yet in. A draft has not been sent to anyone.
      tx.purchaseOrderLine.findMany({
        where: { itemId: { in: ids }, pendingQty: { gt: 0 }, po: { status: { in: ['SENT', 'PARTIALLY_RECEIVED'] }, deletedAt: null } },
        select: { itemId: true, pendingQty: true },
      }),
    ])
    // The rate the stock is carried at, for valuing a suggestion.
    const values = await tx.$queryRaw<Array<{ itemId: string; qty: number; value: number }>>`
      SELECT "itemId", SUM("inQty" - "outQty")::float8 AS qty,
             SUM(("inQty" - "outQty") * COALESCE("unitRate", 0))::float8 AS value
      FROM ld_erp.stock_ledger WHERE ownership = 'OWNED' GROUP BY "itemId"`
    const avgRate = new Map(values.map((v) => [v.itemId, v.qty > 0 ? v.value / v.qty : 0]))

    const sum = <T>(list: T[], id: (t: T) => string, n: (t: T) => number) => {
      const m = new Map<string, number>()
      for (const x of list) m.set(id(x), (m.get(id(x)) ?? 0) + n(x))
      return m
    }
    const onHandOf = new Map(stock.map((s) => [s.itemId, Number(s._sum.inQty ?? 0) - Number(s._sum.outQty ?? 0)]))
    const reservedOf = new Map(reserved.map((s) => [s.itemId, Number(s._sum.qty ?? 0)]))
    const wantedOf = sum(wanted, (w) => w.itemId, (w) => Math.max(0, Number(w.requestedQty) - Number(w.issuedQty)))
    const orderedOf = sum(ordered, (o) => o.itemId, (o) => Number(o.pendingQty))

    const all = catalogue.map((i) => {
      const onHand = onHandOf.get(i.id) ?? 0
      const want = wantedOf.get(i.id) ?? 0
      const onOrder = orderedOf.get(i.id) ?? 0
      const projected = onHand - want + onOrder
      const min = i.minStock == null ? null : Number(i.minStock)
      const reorder = i.reorderLevel == null ? null : Number(i.reorderLevel)
      const max = i.maxStock == null ? null : Number(i.maxStock)
      let status: Status
      if (onHand <= 0 && (want > 0 || reorder != null || min != null)) status = 'OUT'
      else if (min != null && onHand - want < min) status = 'BELOW_MIN'
      else if (reorder != null && projected <= reorder) status = 'REORDER'
      else if (max != null && onHand > max) status = 'OVER_MAX'
      else if (reorder == null && min == null && max == null) status = 'NO_LEVEL'
      else status = 'OK'
      // Up to the maximum where one is set; otherwise back over the reorder level.
      const target = max ?? reorder ?? min ?? 0
      const needs = status === 'OUT' || status === 'BELOW_MIN' || status === 'REORDER'
      const suggested = needs ? r3(Math.max(0, target - projected, want - onHand - onOrder)) : 0
      const rate = round2(avgRate.get(i.id) || Number(i.standardRate ?? 0))
      return {
        status,
        category: cats.names(i.categoryId).category,
        itemCode: i.code,
        item: i.name,
        uom: i.uom?.symbol ?? '',
        onHand: r3(onHand),
        reserved: r3(reservedOf.get(i.id) ?? 0),
        wanted: r3(want),
        onOrder: r3(onOrder),
        projected: r3(projected),
        minStock: min ?? '',
        reorderLevel: reorder ?? '',
        maxStock: max ?? '',
        suggested,
        rate,
        suggestedValue: round2(suggested * rate),
        excessValue: status === 'OVER_MAX' && max != null ? round2((onHand - max) * rate) : 0,
      }
    })

    // An item nobody stocks, wants or has levels for is not worth a line.
    const relevant = all.filter((r) => r.status !== 'NO_LEVEL' || r.onHand !== 0 || r.wanted > 0)
    const order: Status[] = ['OUT', 'BELOW_MIN', 'REORDER', 'OVER_MAX', 'OK', 'NO_LEVEL']
    const shown = relevant
      .filter((r) => params.all || (r.status !== 'OK' && r.status !== 'NO_LEVEL'))
      .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.suggestedValue - a.suggestedValue)
    const rows = shown.slice(0, rowCap)

    const count = (s: Status) => relevant.filter((r) => r.status === s).length
    const buyValue = round2(rows.reduce((s, r) => s + r.suggestedValue, 0))
    const excess = round2(rows.reduce((s, r) => s + r.excessValue, 0))
    const noLevels = count('NO_LEVEL')

    const byCat = new Map<string, number>()
    for (const r of rows) if (r.suggestedValue) byCat.set(r.category || 'No category', (byCat.get(r.category || 'No category') ?? 0) + r.suggestedValue)

    const insights: string[] = []
    const urgent = rows.filter((r) => r.status === 'OUT' && r.wanted > 0)
    if (urgent.length)
      insights.push(`${items(urgent.length)} out of stock while requisitions are waiting for them: ${urgent.slice(0, 3).map((r) => r.item).join(', ')}${urgent.length > 3 ? '…' : ''}.`)
    if (buyValue) insights.push(`Buying everything suggested would cost about ${rupees(buyValue)}, at the rates the stock is carried at.`)
    if (excess) insights.push(`${rupees(excess)} is tied up above the maximum levels set.`)
    const covered = rows.filter((r) => r.status === 'REORDER' && r.onOrder > 0)
    if (covered.length) insights.push(`${items(covered.length)} to reorder already on order in part; the suggestion is only the gap.`)

    return {
      rows,
      totalRows: shown.length > rowCap ? shown.length : undefined,
      analysis: {
        headline: count('OUT') + count('BELOW_MIN') + count('REORDER')
          ? `${items(count('OUT') + count('BELOW_MIN') + count('REORDER'))} need buying; ${items(count('OVER_MAX'))} over the maximum.`
          : 'No item is short of its levels.',
        kpis: [
          { label: 'Items to buy', value: count('OUT') + count('BELOW_MIN') + count('REORDER'), format: 'integer', basis: `of ${items(relevant.length)} stocked or wanted` },
          { label: 'Suggested buying', value: buyValue || null, format: 'money', basis: 'to bring them back to level' },
          { label: 'Over maximum', value: excess || null, format: 'money', basis: `excess on ${items(count('OVER_MAX'))}` },
          { label: 'Items with no levels', value: noLevels, format: 'integer', basis: 'set them on the item master' },
        ],
        exceptions: [
          ...(count('OUT') ? [{ label: 'Out of stock', value: count('OUT'), format: 'integer' as const, basis: 'nothing on hand', tone: 'bad' as const }] : []),
          ...(count('BELOW_MIN') ? [{ label: 'Below minimum', value: count('BELOW_MIN'), format: 'integer' as const, basis: 'after what requisitions want', tone: 'bad' as const }] : []),
          ...(count('REORDER') ? [{ label: 'At reorder level', value: count('REORDER'), format: 'integer' as const, basis: 'counting what is on order', tone: 'warn' as const }] : []),
        ],
        panels: (
          [
            {
              title: 'Items by stock status',
              question: 'comparison',
              format: 'integer',
              points: (['OUT', 'BELOW_MIN', 'REORDER', 'OVER_MAX', 'OK'] as Status[]).map((s) => ({
                label: STATUS[s],
                value: count(s),
                tone: s === 'OUT' || s === 'BELOW_MIN' ? 'bad' : s === 'OK' ? 'good' : 'warn',
              })),
            },
            {
              title: 'Suggested buying, by category',
              question: 'ranking',
              format: 'money',
              points: topWithRest([...byCat].map(([label, value]) => ({ label, value: round2(value) })), 8),
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Projected = on hand − still wanted on open requisitions + pending on sent purchase orders. Draft orders are not counted.',
          'The suggestion fills up to the maximum, or back to the reorder level where no maximum is set. Check it against lead time and pack sizes.',
          "Our own stock only; customers' material cannot be issued for our orders.",
          params.warehouseId ? 'Stock, reservations and requisitions are for the chosen store only; orders are for the whole mill.' : 'All stores together.',
        ],
      },
    }
  },
}
