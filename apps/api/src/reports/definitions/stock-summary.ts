import { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import { round2, topWithRest } from './shared'
import {
  asOnEnd,
  asOnFilter,
  asOnLabel,
  categoryFilter,
  loadCategories,
  ownershipFilter,
  ownershipsOf,
  pctOf,
  rupees,
  warehouseFilter,
} from './inventory-shared'

/**
 * What is in the stores, and what it is worth.
 *
 * One row per item per store (and per customer, for their material), as at
 * the end of a chosen day. The figure a stock statement, an insurance
 * declaration or a month-end close starts from.
 */
export const stockSummary: ReportDefinition = {
  id: 'stock-summary',
  module: 'inventory',
  title: 'Stock Summary',
  description:
    'Stock on hand item by item and store by store, on any date — quantity, average rate, value, and what is reserved for orders.',
  filters: [asOnFilter, warehouseFilter, categoryFilter, ownershipFilter],
  columns: [
    { key: 'category', label: 'Category', type: 'text', width: 18 },
    { key: 'subCategory', label: 'Sub-category', type: 'text', width: 18 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'store', label: 'Store', type: 'text', width: 18 },
    { key: 'owner', label: 'Owner', type: 'text', width: 20 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'qty', label: 'On Hand', type: 'qty', total: 'sum' },
    { key: 'reserved', label: 'Reserved', type: 'qty', total: 'sum' },
    { key: 'free', label: 'Free', type: 'qty', total: 'sum' },
    { key: 'rate', label: 'Avg Rate', type: 'money', total: 'none' },
    { key: 'value', label: 'Value', type: 'money', total: 'sum' },
    { key: 'lastMoved', label: 'Last Movement', type: 'date', width: 14 },
  ],
  summary: {
    title: 'Biggest stock holdings by value',
    columns: ['item', 'store', 'qty', 'uom', 'rate', 'value'],
    by: 'value',
    limit: 12,
  },
  pivot: {
    rows: ['category', 'item'],
    values: ['qty', 'value'],
    slicers: ['store', 'owner'],
    note: 'Open a category to see its items. Read quantity totals per item — units differ between items.',
  },

  async run({ tx, params, rowCap }) {
    const end = asOnEnd(params)
    const owners = ownershipsOf(params)
    const cats = await loadCategories(tx)
    const catIds = cats.under(params.categoryId)

    const found = await tx.$queryRaw<
      Array<{
        itemId: string
        itemCode: string
        itemName: string
        categoryId: string
        uom: string
        warehouseId: string
        store: string
        ownership: string
        owner: string | null
        qty: number
        value: number
        lastMoved: Date
      }>
    >`
      SELECT i.id AS "itemId", i.code AS "itemCode", i.name AS "itemName", i."categoryId",
             u.symbol AS uom, w.id AS "warehouseId", w.name AS store,
             s.ownership::text AS ownership, cust.name AS owner,
             SUM(s."inQty" - s."outQty")::float8 AS qty,
             SUM((s."inQty" - s."outQty") * COALESCE(s."unitRate", 0))::float8 AS value,
             MAX(s."transactionDate") AS "lastMoved"
      FROM ld_erp.stock_ledger s
      JOIN ld_erp.items i ON i.id = s."itemId"
      JOIN ld_erp.uom u ON u.id = i."uomId"
      JOIN ld_erp.warehouses w ON w.id = s."warehouseId"
      LEFT JOIN ld_erp.customers cust ON cust.id = s."ownerCustomerId"
      WHERE s."transactionDate" <= ${end}
        AND s.ownership::text IN (${Prisma.join(owners)})
        AND (${params.warehouseId ?? null}::text IS NULL OR s."warehouseId" = ${params.warehouseId ?? null})
        AND (${catIds}::text[] IS NULL OR i."categoryId" = ANY(${catIds}::text[]))
      GROUP BY i.id, i.code, i.name, i."categoryId", u.symbol, w.id, w.name, s.ownership, cust.name
      HAVING ABS(SUM(s."inQty" - s."outQty")) > 0.0005
      ORDER BY i.name, w.name
    `

    // Held for orders now. Only meaningful for today, and only on our stock.
    const reservations = await tx.stockReservation.groupBy({
      by: ['itemId', 'warehouseId'],
      where: { status: 'ACTIVE' },
      _sum: { qty: true },
    })
    const held = new Map(reservations.map((r) => [`${r.itemId}|${r.warehouseId}`, Number(r._sum.qty ?? 0)]))

    const rows = found.slice(0, rowCap).map((r) => {
      const own = r.ownership === 'OWNED'
      const reserved = own && !params.asOn ? Math.min(Math.max(r.qty, 0), held.get(`${r.itemId}|${r.warehouseId}`) ?? 0) : 0
      const { category, subCategory } = cats.names(r.categoryId)
      return {
        category,
        subCategory,
        itemCode: r.itemCode,
        item: r.itemName,
        store: r.store,
        owner: own ? 'Ours' : (r.owner ?? 'Customer'),
        uom: r.uom,
        qty: Math.round(r.qty * 1000) / 1000,
        reserved,
        free: Math.round((r.qty - reserved) * 1000) / 1000,
        rate: r.qty > 0 ? round2(r.value / r.qty) : 0,
        value: round2(r.value),
        lastMoved: r.lastMoved,
      }
    })

    const ours = rows.filter((r) => r.owner === 'Ours')
    const value = round2(ours.reduce((s, r) => s + r.value, 0))
    const items = new Set(rows.map((r) => r.itemCode)).size
    const negatives = rows.filter((r) => r.qty < 0)
    const reservedValue = round2(ours.reduce((s, r) => s + r.reserved * r.rate, 0))

    const sumBy = (key: (r: (typeof rows)[number]) => string) => {
      const m = new Map<string, number>()
      for (const r of ours) m.set(key(r), (m.get(key(r)) ?? 0) + r.value)
      return [...m].map(([label, v]) => ({ label, value: round2(v) }))
    }
    const byItem = sumBy((r) => r.item).sort((a, b) => b.value - a.value)
    const top10 = byItem.slice(0, 10).reduce((s, e) => s + e.value, 0)

    const insights: string[] = []
    if (byItem.length) {
      insights.push(
        `${byItem[0].label} is the biggest holding at ${rupees(byItem[0].value)}, ${pctOf(byItem[0].value, value)} of the stock value.`,
      )
    }
    if (byItem.length > 10) {
      insights.push(`The top 10 items hold ${pctOf(top10, value)} of the value; the other ${byItem.length - 10} hold the rest.`)
    }
    if (reservedValue > 0) {
      insights.push(`${rupees(reservedValue)} of stock is reserved for customer orders and cannot be issued to anyone else.`)
    }
    const customerLines = rows.length - ours.length
    if (customerLines) insights.push(`${customerLines} lines are customers' own material, kept out of the value.`)

    return {
      rows,
      totalRows: found.length > rowCap ? found.length : undefined,
      analysis: {
        headline: rows.length
          ? `${items} items in stock as on ${asOnLabel(params)}, worth ${rupees(value)}.`
          : `Nothing in stock as on ${asOnLabel(params)} for these filters.`,
        kpis: [
          { label: 'Stock value', value: rows.length ? value : null, format: 'money', basis: 'our own stock, at average rate' },
          { label: 'Items in stock', value: rows.length ? items : null, format: 'integer', basis: `across ${new Set(rows.map((r) => r.store)).size} stores` },
          { label: 'Reserved for orders', value: params.asOn ? null : reservedValue, format: 'money', basis: params.asOn ? 'only shown for today' : 'held against requisitions' },
          { label: 'Average per item', value: items ? round2(value / items) : null, format: 'money', basis: 'stock value per item held' },
        ],
        exceptions: negatives.length
          ? [
              {
                label: 'Negative balances',
                value: negatives.length,
                format: 'integer',
                basis: 'more issued than received — a receipt is missing or an issue was wrong',
                tone: 'bad',
              },
            ]
          : [],
        panels: (
          [
            { title: 'Stock value by store', question: 'comparison', format: 'money', points: sumBy((r) => r.store).sort((a, b) => b.value - a.value) },
            { title: 'Stock value by category', question: 'composition', format: 'money', points: topWithRest(sumBy((r) => r.category || 'No category'), 4) },
            { title: 'Biggest items by value', question: 'pareto', format: 'money', points: byItem.slice(0, 12) },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          params.ownership === 'CUSTOMER_OWNED' || params.ownership === 'ALL'
            ? "Customers' material is listed by quantity; it is not the mill's and is left out of every value."
            : "Our own stock only. Customers' material is in the Customer Material report.",
          'Value is at the average rate each item was received at, the same figure the Inventory dashboard shows.',
          params.asOn
            ? 'Reserved and free quantities are only worked out for today, so they are blank for a past date.'
            : 'Reserved is what is held for open requisitions right now.',
          'Stock sent out to job workers sits in the Job Work Godown and is counted there.',
        ],
      },
    }
  },
}
