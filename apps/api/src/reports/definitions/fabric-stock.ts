import type { Panel, ReportDefinition } from '../types'
import { round2, topWithRest } from './shared'
import { asOnEnd, asOnFilter, asOnLabel, brandFilter, pctOf, rupees, warehouseFilter } from './inventory-shared'

/**
 * Fabric in the stores, by design, colour and brand (27 Nov 2026).
 *
 * Fabric is bought by design number and colour for one of the mill's own
 * brands, and each combination is a stock line of its own under the fabric
 * (lib/fabricLines). This lists them fabric by fabric — what came in, what
 * went out, what is left and what it is worth, as at any day — so the stock
 * and cost of a brand's fabric can be read on its own.
 */
export const fabricStock: ReportDefinition = {
  id: 'fabric-stock',
  module: 'inventory',
  title: 'Fabric Stock — Design, Colour & Brand',
  description:
    'Fabric on hand fabric by fabric, by design number, colour and brand: received, issued, balance and value on any date.',
  filters: [asOnFilter, warehouseFilter, brandFilter],
  columns: [
    { key: 'fabricCode', label: 'Fabric Code', type: 'text', width: 14 },
    { key: 'fabric', label: 'Fabric', type: 'text', width: 30 },
    { key: 'designNo', label: 'Design No.', type: 'text', width: 12 },
    { key: 'colour', label: 'Colour', type: 'text', width: 14 },
    { key: 'brand', label: 'Brand', type: 'text', width: 18 },
    { key: 'itemCode', label: 'Stock Line', type: 'text', width: 16 },
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
    columns: ['fabric', 'designNo', 'colour', 'brand', 'qty', 'uom', 'value'],
    by: 'value',
    limit: 12,
  },
  pivot: {
    rows: ['brand', 'fabric', 'designNo', 'colour'],
    values: ['qty', 'value'],
    slicers: ['store'],
    note: 'Open a brand to see its fabrics, a fabric to see its designs and colours.',
  },

  async run({ tx, params, rowCap }) {
    const end = asOnEnd(params)
    const found = await tx.$queryRaw<
      Array<{
        itemCode: string
        fabricCode: string
        fabric: string
        designNo: string | null
        colour: string | null
        brand: string | null
        store: string
        uom: string
        received: number
        issued: number
        qty: number
        value: number
      }>
    >`
      SELECT i.code AS "itemCode",
             COALESCE(p.code, i.code) AS "fabricCode",
             COALESCE(p.name, i.name) AS fabric,
             i."designNo",
             CASE WHEN i."parentItemId" IS NOT NULL THEN i.color END AS colour,
             b.name AS brand,
             w.name AS store,
             u.symbol AS uom,
             SUM(s."inQty")::float8 AS received,
             SUM(s."outQty")::float8 AS issued,
             SUM(s."inQty" - s."outQty")::float8 AS qty,
             SUM((s."inQty" - s."outQty") * COALESCE(s."unitRate", 0))::float8 AS value
      FROM ld_erp.stock_ledger s
      JOIN ld_erp.items i ON i.id = s."itemId"
      LEFT JOIN ld_erp.items p ON p.id = i."parentItemId"
      JOIN ld_erp.item_categories c ON c.id = COALESCE(p."categoryId", i."categoryId")
      LEFT JOIN ld_erp.item_categories pc ON pc.id = c."parentId"
      JOIN ld_erp.uom u ON u.id = i."uomId"
      JOIN ld_erp.warehouses w ON w.id = s."warehouseId"
      LEFT JOIN ld_erp.brands b ON b.id = i."brandId"
      WHERE s."transactionDate" <= ${end}
        AND s.ownership::text = 'OWNED'
        AND (c.name ILIKE '%fabric%' OR pc.name ILIKE '%fabric%')
        AND (${params.warehouseId ?? null}::text IS NULL OR s."warehouseId" = ${params.warehouseId ?? null})
        AND (${params.brandId ?? null}::text IS NULL OR i."brandId" = ${params.brandId ?? null})
      GROUP BY i.code, p.code, p.name, i.name, i."designNo", i."parentItemId", i.color, b.name, w.name, u.symbol
      HAVING ABS(SUM(s."inQty" - s."outQty")) > 0.0005 OR SUM(s."inQty") > 0
      ORDER BY COALESCE(p.name, i.name), i."designNo" NULLS FIRST, i.color NULLS FIRST, b.name NULLS FIRST, w.name
    `

    const rows = found.slice(0, rowCap).map((r) => ({
      fabricCode: r.fabricCode,
      fabric: r.fabric,
      designNo: r.designNo ?? '',
      colour: r.colour ?? '',
      brand: r.brand ?? 'Common',
      itemCode: r.itemCode,
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
    const byBrand = sumBy((r) => r.brand)
    const byFabric = sumBy((r) => r.fabric)
    const lines = new Set(rows.map((r) => r.itemCode)).size

    const insights: string[] = []
    if (byBrand.length > 1) insights.push(`${byBrand[0].label} holds the most fabric: ${rupees(byBrand[0].value)}, ${pctOf(byBrand[0].value, value)} of the value.`)
    if (byFabric.length) insights.push(`${byFabric[0].label} is the biggest fabric holding at ${rupees(byFabric[0].value)}.`)
    const common = rows.filter((r) => r.brand === 'Common' && r.qty > 0).length
    if (common) insights.push(`${common} lines are common fabric, bought without a brand and open to every brand's orders.`)

    return {
      rows,
      totalRows: found.length > rowCap ? found.length : undefined,
      analysis: {
        headline: rows.length
          ? `${lines} fabric lines as on ${asOnLabel(params)}, worth ${rupees(value)}.`
          : `No fabric in stock as on ${asOnLabel(params)} for these filters.`,
        kpis: [
          { label: 'Fabric value', value: rows.length ? value : null, format: 'money', basis: 'at average rate' },
          { label: 'Fabric lines', value: rows.length ? lines : null, format: 'integer', basis: 'fabric × design × colour × brand' },
          { label: 'Fabrics', value: rows.length ? byFabric.length : null, format: 'integer', basis: 'distinct fabrics' },
          { label: 'Brands', value: rows.length ? byBrand.length : null, format: 'integer', basis: 'including common fabric' },
        ],
        exceptions: [],
        panels: (
          [
            { title: 'Fabric value by brand', question: 'composition', format: 'money', points: topWithRest(byBrand, 5) },
            { title: 'Biggest fabrics by value', question: 'pareto', format: 'money', points: byFabric.slice(0, 12) },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Fabric is any item filed under a Fabric category. A fabric bought without a design, colour or brand is listed as itself, under Common.',
          'Our own fabric only; a customer\'s fabric is in the Customer Material report.',
          'Value is at the average rate each line was received at.',
        ],
      },
    }
  },
}
