import type { Panel, ReportDefinition } from '../types'
import { round2, topWithRest } from './shared'
import { asOnEnd, asOnFilter, asOnLabel, pctOf, rupees, warehouseFilter } from './inventory-shared'

/**
 * Fabric in the stores, by design and colour (27 Nov 2026).
 *
 * Fabric items are set up one design and colour each in the Items master
 * (lib/fabric). This lists them — what came in, what went out, what is left
 * and what it is worth, as at any day. Brand is not on stock yet: it comes
 * with the multi-brand allocation, which earmarks stock to a brand.
 */
export const fabricStock: ReportDefinition = {
  id: 'fabric-stock',
  module: 'inventory',
  title: 'Fabric Stock — Design & Colour',
  description:
    'Fabric on hand fabric by fabric, by design number and colour: received, issued, balance and value on any date.',
  filters: [asOnFilter, warehouseFilter],
  columns: [
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 14 },
    { key: 'fabric', label: 'Fabric', type: 'text', width: 30 },
    { key: 'designNo', label: 'Design No.', type: 'text', width: 12 },
    { key: 'colour', label: 'Colour', type: 'text', width: 14 },
    { key: 'store', label: 'Store', type: 'text', width: 18 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'received', label: 'Received', type: 'qty', total: 'sum' },
    { key: 'issued', label: 'Issued', type: 'qty', total: 'sum' },
    { key: 'qty', label: 'On Hand', type: 'qty', total: 'sum' },
    { key: 'rate', label: 'Avg Rate', type: 'money', total: 'none' },
    { key: 'value', label: 'Value', type: 'money', total: 'sum' },
  ],
  summary: {
    title: 'Biggest fabric holdings by value',
    columns: ['fabric', 'designNo', 'colour', 'qty', 'uom', 'value'],
    by: 'value',
    limit: 12,
  },
  pivot: {
    rows: ['fabric', 'designNo', 'colour'],
    values: ['qty', 'value'],
    slicers: ['store'],
    note: 'Open a fabric to see its designs, a design to see its colours.',
  },

  async run({ tx, params, rowCap }) {
    const end = asOnEnd(params)
    const found = await tx.$queryRaw<
      Array<{
        itemCode: string
        fabric: string
        designNo: string | null
        colour: string | null
        store: string
        uom: string
        received: number
        issued: number
        qty: number
        value: number
      }>
    >`
      SELECT i.code AS "itemCode",
             i.name AS fabric,
             i."designNo",
             i.color AS colour,
             w.name AS store,
             u.symbol AS uom,
             SUM(s."inQty")::float8 AS received,
             SUM(s."outQty")::float8 AS issued,
             SUM(s."inQty" - s."outQty")::float8 AS qty,
             SUM((s."inQty" - s."outQty") * COALESCE(s."unitRate", 0))::float8 AS value
      FROM ld_erp.stock_ledger s
      JOIN ld_erp.items i ON i.id = s."itemId"
      JOIN ld_erp.item_categories c ON c.id = i."categoryId"
      LEFT JOIN ld_erp.item_categories pc ON pc.id = c."parentId"
      JOIN ld_erp.uom u ON u.id = i."uomId"
      JOIN ld_erp.warehouses w ON w.id = s."warehouseId"
      WHERE s."transactionDate" <= ${end}
        AND s.ownership::text = 'OWNED'
        AND (c.name ILIKE '%fabric%' OR pc.name ILIKE '%fabric%')
        AND (${params.warehouseId ?? null}::text IS NULL OR s."warehouseId" = ${params.warehouseId ?? null})
      GROUP BY i.code, i.name, i."designNo", i.color, w.name, u.symbol
      HAVING ABS(SUM(s."inQty" - s."outQty")) > 0.0005 OR SUM(s."inQty") > 0
      ORDER BY i.name, i."designNo" NULLS FIRST, i.color NULLS FIRST, w.name
    `

    const rows = found.slice(0, rowCap).map((r) => ({
      itemCode: r.itemCode,
      fabric: r.fabric,
      designNo: r.designNo ?? '',
      colour: r.colour ?? '',
      store: r.store,
      uom: r.uom,
      received: Math.round(r.received * 1000) / 1000,
      issued: Math.round(r.issued * 1000) / 1000,
      qty: Math.round(r.qty * 1000) / 1000,
      rate: r.qty > 0 ? round2(r.value / r.qty) : 0,
      value: round2(r.value),
    }))

    const value = round2(rows.reduce((s, r) => s + r.value, 0))
    const sumBy = (key: (r: (typeof rows)[number]) => string) => {
      const m = new Map<string, number>()
      for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.value)
      return [...m].map(([label, v]) => ({ label, value: round2(v) })).sort((a, b) => b.value - a.value)
    }
    const byFabric = sumBy((r) => r.fabric)
    const byStore = sumBy((r) => r.store)
    const lines = new Set(rows.map((r) => r.itemCode)).size

    const insights: string[] = []
    if (byFabric.length) insights.push(`${byFabric[0].label} is the biggest fabric holding at ${rupees(byFabric[0].value)}, ${pctOf(byFabric[0].value, value)} of the value.`)
    const plain = rows.filter((r) => !r.designNo && !r.colour && r.qty > 0).length
    if (plain) insights.push(`${plain} fabric items have no design or colour set in the Items master.`)

    return {
      rows,
      totalRows: found.length > rowCap ? found.length : undefined,
      analysis: {
        headline: rows.length
          ? `${lines} fabric items as on ${asOnLabel(params)}, worth ${rupees(value)}.`
          : `No fabric in stock as on ${asOnLabel(params)} for these filters.`,
        kpis: [
          { label: 'Fabric value', value: rows.length ? value : null, format: 'money', basis: 'at average rate' },
          { label: 'Fabric items', value: rows.length ? lines : null, format: 'integer', basis: 'one design and colour each' },
          { label: 'Fabrics', value: rows.length ? byFabric.length : null, format: 'integer', basis: 'distinct fabrics' },
          { label: 'Stores', value: rows.length ? byStore.length : null, format: 'integer', basis: 'holding fabric' },
        ],
        exceptions: [],
        panels: (
          [
            { title: 'Biggest fabrics by value', question: 'pareto', format: 'money', points: byFabric.slice(0, 12) },
            { title: 'Fabric value by store', question: 'composition', format: 'money', points: topWithRest(byStore, 5) },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Fabric is any item filed under a Fabric category, each with the Design No. and Colour set for it in the Items master.',
          "Our own fabric only; a customer's fabric is in the Customer Material report.",
          'Value is at the average rate each line was received at.',
          'Brand is not on stock yet. It comes with the multi-brand allocation, which earmarks these lines to a brand.',
        ],
      },
    }
  },
}
