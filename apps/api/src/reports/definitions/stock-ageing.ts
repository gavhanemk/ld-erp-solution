import type { Panel, ReportDefinition } from '../types'
import { round2 } from './shared'
import {
  categoryFilter,
  daysBetween,
  loadCategories,
  pctOf,
  rupees,
  warehouseFilter,
} from './inventory-shared'

const BANDS = [
  { key: 'MOVING', label: 'Used in 30 days', upTo: 30 },
  { key: 'SLOW', label: '31–90 days', upTo: 90 },
  { key: 'IDLE', label: '91–180 days', upTo: 180 },
  { key: 'DEAD', label: 'Over 180 days', upTo: Infinity },
] as const
type Band = (typeof BANDS)[number]['key'] | 'NEVER'

const BAND_LABEL: Record<Band, string> = {
  MOVING: 'Moving',
  SLOW: 'Slow',
  IDLE: 'Non-moving',
  DEAD: 'Dead stock',
  NEVER: 'Never used',
}

/**
 * How long stock has sat, and what that is worth.
 *
 * Aged by the days since the item last left the store for use — issued to
 * the floor or despatched — and, for stock never used at all, since it first
 * came in. Money in a rack nobody has touched for six months is the first
 * place to look for cash, and the first thing to stop buying.
 */
export const stockAgeing: ReportDefinition = {
  id: 'stock-ageing',
  module: 'inventory',
  title: 'Stock Ageing & Slow-Moving',
  description:
    'Stock on hand grouped by how long since it was last used — moving, slow, non-moving, dead, never used — with the value tied up in each.',
  filters: [warehouseFilter, categoryFilter],
  columns: [
    { key: 'band', label: 'Ageing', type: 'badge', width: 14, badges: BAND_LABEL,
      badgeTones: { MOVING: 'good', SLOW: 'normal', IDLE: 'warn', DEAD: 'bad', NEVER: 'bad' } },
    { key: 'category', label: 'Category', type: 'text', width: 18 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'store', label: 'Store', type: 'text', width: 18 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'qty', label: 'On Hand', type: 'qty', total: 'sum' },
    { key: 'value', label: 'Value', type: 'money', total: 'sum' },
    { key: 'firstIn', label: 'First Received', type: 'date', width: 14 },
    { key: 'lastIn', label: 'Last Received', type: 'date', width: 14 },
    { key: 'lastUsed', label: 'Last Used', type: 'date', width: 14 },
    { key: 'days', label: 'Days Idle', type: 'integer', total: 'none' },
  ],
  summary: {
    title: 'Most money in stock that is not being used',
    columns: ['band', 'item', 'store', 'qty', 'value', 'days'],
    by: 'value',
    limit: 12,
  },
  pivot: {
    rows: ['band', 'category'],
    values: ['value'],
    slicers: ['store', 'category'],
    note: 'Open a band to see which categories hold the idle money.',
  },

  async run({ tx, params, rowCap }) {
    const cats = await loadCategories(tx)
    const catIds = cats.under(params.categoryId)
    const now = new Date()

    const found = await tx.$queryRaw<
      Array<{
        itemCode: string
        itemName: string
        categoryId: string
        uom: string
        store: string
        qty: number
        value: number
        firstIn: Date | null
        lastIn: Date | null
        lastUsed: Date | null
      }>
    >`
      SELECT i.code AS "itemCode", i.name AS "itemName", i."categoryId", u.symbol AS uom, w.name AS store,
             SUM(s."inQty" - s."outQty")::float8 AS qty,
             SUM((s."inQty" - s."outQty") * COALESCE(s."unitRate", 0))::float8 AS value,
             MIN(s."transactionDate") FILTER (WHERE s."inQty" > 0) AS "firstIn",
             MAX(s."transactionDate") FILTER (WHERE s."inQty" > 0 AND s."transactionType" IN ('PURCHASE','OPENING','PRODUCTION')) AS "lastIn",
             (SELECT MAX(x."transactionDate") FROM ld_erp.stock_ledger x
               WHERE x."itemId" = i.id AND x.ownership = 'OWNED' AND x."outQty" > 0
                 AND x."transactionType" IN ('ISSUE','SALE')) AS "lastUsed"
      FROM ld_erp.stock_ledger s
      JOIN ld_erp.items i ON i.id = s."itemId"
      JOIN ld_erp.uom u ON u.id = i."uomId"
      JOIN ld_erp.warehouses w ON w.id = s."warehouseId"
      WHERE s.ownership = 'OWNED'
        AND (${params.warehouseId ?? null}::text IS NULL OR s."warehouseId" = ${params.warehouseId ?? null})
        AND (${catIds}::text[] IS NULL OR i."categoryId" = ANY(${catIds}::text[]))
      GROUP BY i.id, i.code, i.name, i."categoryId", u.symbol, w.id, w.name
      HAVING SUM(s."inQty" - s."outQty") > 0.0005
    `

    const all = found
      .map((f) => {
        // Used anywhere in the mill counts: an item issued from one store is
        // not dead because a second store holds some too.
        const since = f.lastUsed ?? f.firstIn ?? now
        const days = daysBetween(since, now)
        const band: Band = f.lastUsed ? BANDS.find((b) => days <= b.upTo)!.key : 'NEVER'
        return {
          band,
          category: cats.names(f.categoryId).category,
          itemCode: f.itemCode,
          item: f.itemName,
          store: f.store,
          uom: f.uom,
          qty: Math.round(f.qty * 1000) / 1000,
          value: round2(f.value),
          firstIn: f.firstIn,
          lastIn: f.lastIn,
          lastUsed: f.lastUsed,
          days,
        }
      })
      .sort((a, b) => b.days - a.days || b.value - a.value)
    const rows = all.slice(0, rowCap)

    const total = round2(all.reduce((s, r) => s + r.value, 0))
    const valueOf = (b: Band) => round2(all.filter((r) => r.band === b).reduce((s, r) => s + r.value, 0))
    const idleValue = round2(valueOf('IDLE') + valueOf('DEAD') + valueOf('NEVER'))
    const neverItems = new Set(all.filter((r) => r.band === 'NEVER').map((r) => r.itemCode)).size

    // Value by category and band, for the grid.
    const catList = [...new Set(all.map((r) => r.category || 'No category'))].sort()
    const bandOrder: Band[] = ['MOVING', 'SLOW', 'IDLE', 'DEAD', 'NEVER']

    const insights: string[] = []
    if (total) insights.push(`${pctOf(idleValue, total)} of stock value (${rupees(idleValue)}) has not been used for over 90 days, or ever.`)
    const worst = all.filter((r) => r.band !== 'MOVING').sort((a, b) => b.value - a.value)[0]
    if (worst) insights.push(`The biggest idle holding is ${worst.item} in ${worst.store}: ${rupees(worst.value)}, ${worst.lastUsed ? `last used ${worst.days} days ago` : `never used in ${worst.days} days`}.`)
    if (neverItems) insights.push(`${neverItems} items have been received but never issued — check whether they are still needed before buying more.`)

    return {
      rows,
      totalRows: all.length > rowCap ? all.length : undefined,
      analysis: {
        headline: all.length
          ? `${rupees(idleValue)} of ${rupees(total)} in stock has not been used for 90 days or more.`
          : 'Nothing in stock for these filters.',
        kpis: [
          { label: 'Stock value', value: total || null, format: 'money', basis: `${all.length} item-store lines` },
          { label: 'Moving', value: valueOf('MOVING') || null, format: 'money', basis: 'used in the last 30 days' },
          { label: 'Idle over 90 days', value: idleValue || null, format: 'money', basis: `${pctOf(idleValue, total)} of stock value`, tone: idleValue > total * 0.3 ? 'bad' : 'warn' },
          { label: 'Never used', value: neverItems || null, format: 'integer', basis: 'items received but never issued' },
        ],
        exceptions: valueOf('DEAD')
          ? [{ label: 'Dead stock', value: valueOf('DEAD'), format: 'money', basis: 'not used for over 180 days — sell, return or use up', tone: 'bad' }]
          : [],
        panels: (
          [
            {
              title: 'Stock value by how long it has sat',
              question: 'ageing',
              format: 'money',
              points: bandOrder.map((b) => ({
                label: BAND_LABEL[b],
                value: valueOf(b),
                tone: b === 'MOVING' ? 'good' : b === 'SLOW' ? 'normal' : b === 'IDLE' ? 'warn' : 'bad',
              })),
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        matrix: catList.length > 1
          ? {
              title: 'Stock value by category and age',
              rowLabel: 'Category',
              columns: bandOrder.map((b) => BAND_LABEL[b]),
              rows: catList.map((c) => ({
                label: c,
                values: bandOrder.map((b) => round2(all.filter((r) => (r.category || 'No category') === c && r.band === b).reduce((s, r) => s + r.value, 0)) || null),
              })),
              format: 'money',
            }
          : undefined,
        insights,
        caveats: [
          'Aged by the last day the item was issued or despatched anywhere in the mill; never-used stock is aged from when it first came in.',
          'Our own stock only. Transfers between stores and stock counts do not count as use.',
          'Stock with a job worker sits in the Job Work Godown and is aged there.',
        ],
      },
    }
  },
}
