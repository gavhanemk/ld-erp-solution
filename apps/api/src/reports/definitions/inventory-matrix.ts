import type { Panel, ReportDefinition, ReportFilter } from '../types'
import { round2, topWithRest } from './shared'
import { asOnEnd, asOnFilter, asOnLabel, brandFilter, pctOf, rupees, warehouseFilter } from './inventory-shared'

/**
 * The Inventory Matrix (multi-brand phase 5): the mill's own stock as one
 * company and brand by brand.
 *
 * The stock ledger is the only record. Each balance's stock is the company's,
 * held as shares — central stock, for no brand, and each brand's earmark — so
 * every quantity here is a share of a balance, and the shares of a balance
 * always add up to it (Stock Reconciliation checks that they do).
 *
 * For each share it sorts the stock by where it is and what it is:
 *   - in transit: in a transit store, on its way between two stores;
 *   - WIP: on a process floor or at a job worker's;
 *   - rejected and held: graded R, or in a QC hold, reject or scrap store;
 *   - finished goods: finished garments in a store, first quality or B-grade;
 *   - raw and semi-finished: everything else in a store;
 * and, on top of that, what is reserved (held for a requisition) and what is
 * free to use (first quality in a store goods are issued from, less what is
 * held) — the one availability rule every screen uses. Physical is all of it.
 *
 * Value is each row at the rate it moved at, so each brand's share keeps its
 * own moving average (decision 5). A customer's material is never a brand's
 * and carries no value of ours: it is listed apart.
 */

const KIND_FILTER: ReportFilter = {
  key: 'kind',
  label: 'What',
  type: 'select',
  options: [
    { value: 'FABRIC', label: 'Fabric' },
    { value: 'THREAD', label: 'Thread' },
    { value: 'RAW', label: 'Raw materials (all)' },
    { value: 'SEMI', label: 'Semi-finished' },
    { value: 'FG', label: 'Finished goods' },
  ],
  emptyLabel: 'Everything',
}

const BUCKETS = ['rawSemi', 'finished', 'wip', 'rejected', 'transit'] as const
type Bucket = (typeof BUCKETS)[number]
const BUCKET_LABEL: Record<Bucket, string> = {
  rawSemi: 'Raw & semi-finished',
  finished: 'Finished goods',
  wip: 'WIP (floors, job workers)',
  rejected: 'Rejected & held',
  transit: 'In transit',
}

export const inventoryMatrix: ReportDefinition = {
  id: 'inventory-matrix',
  module: 'inventory',
  title: 'Inventory Matrix — Company & Brands',
  description:
    'Our own stock as one company and brand by brand: physical, free, reserved, central, WIP, finished goods, rejected and in transit, with values at each brand’s own average, on any date.',
  filters: [asOnFilter, warehouseFilter, brandFilter, KIND_FILTER],
  columns: [
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 14 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'designNo', label: 'Design No.', type: 'text', width: 12 },
    { key: 'colour', label: 'Colour', type: 'text', width: 12 },
    { key: 'kind', label: 'Kind', type: 'text', width: 14 },
    { key: 'share', label: 'Share', type: 'text', width: 16 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'physical', label: 'Physical', type: 'qty', total: 'none' },
    { key: 'free', label: 'Free', type: 'qty', total: 'none' },
    { key: 'reserved', label: 'Reserved', type: 'qty', total: 'none' },
    { key: 'rawSemi', label: 'Raw & Semi', type: 'qty', total: 'none' },
    { key: 'finished', label: 'Finished', type: 'qty', total: 'none' },
    { key: 'wip', label: 'WIP', type: 'qty', total: 'none' },
    { key: 'rejected', label: 'Rejected & Held', type: 'qty', total: 'none' },
    { key: 'transit', label: 'In Transit', type: 'qty', total: 'none' },
    { key: 'value', label: 'Value', type: 'money', total: 'sum' },
    { key: 'freeValue', label: 'Free Value', type: 'money', total: 'sum' },
  ],
  summary: {
    title: 'Biggest holdings by value',
    columns: ['item', 'designNo', 'colour', 'share', 'physical', 'uom', 'value'],
    by: 'value',
    limit: 12,
  },
  pivot: {
    rows: ['item', 'designNo', 'colour'],
    values: ['value', 'freeValue'],
    slicers: ['share', 'kind'],
    note: 'Open an item to see its designs and colours; slice by share to see one brand, or central stock.',
  },

  async run({ tx, params, rowCap }) {
    const end = asOnEnd(params)
    const store = params.warehouseId ?? null
    const brand = params.brandId ?? null
    const kind = params.kind ?? null

    // Every balance of our own stock, as at the day, with where it is and what it is.
    const found = await tx.$queryRaw<
      Array<{
        itemId: string
        itemCode: string
        item: string
        designNo: string | null
        colour: string | null
        type: string
        category: string | null
        parent: string | null
        uom: string
        brandId: string | null
        brand: string | null
        storeKind: string
        storeId: string
        grade: string
        sized: boolean
        qty: number
        value: number
      }>
    >`
      SELECT s."itemId", i.code AS "itemCode", i.name AS item, i."designNo", i.color AS colour, i.type::text AS type,
             c.name AS category, pc.name AS parent, u.symbol AS uom,
             s."brandId", b.name AS brand, w.kind::text AS "storeKind", w.id AS "storeId", s.grade,
             (s."sizeId" IS NOT NULL) AS sized,
             SUM(s."inQty" - s."outQty")::float8 AS qty,
             SUM((s."inQty" - s."outQty") * COALESCE(s."unitRate", 0))::float8 AS value
      FROM ld_erp.stock_ledger s
      JOIN ld_erp.items i ON i.id = s."itemId"
      JOIN ld_erp.item_categories c ON c.id = i."categoryId"
      LEFT JOIN ld_erp.item_categories pc ON pc.id = c."parentId"
      JOIN ld_erp.uom u ON u.id = i."uomId"
      JOIN ld_erp.warehouses w ON w.id = s."warehouseId"
      LEFT JOIN ld_erp.brands b ON b.id = s."brandId"
      WHERE s."transactionDate" <= ${end}
        AND s.ownership::text = 'OWNED'
        AND i.type::text <> 'FIXED_ASSET'
        AND (${store}::text IS NULL OR s."warehouseId" = ${store})
        AND (${brand}::text IS NULL OR s."brandId" IS NOT DISTINCT FROM (CASE WHEN ${brand}::text = 'central' THEN NULL ELSE ${brand}::text END))
      GROUP BY s."itemId", i.code, i.name, i."designNo", i.color, i.type, c.name, pc.name, u.symbol, s."brandId", b.name, w.kind, w.id, s.grade, (s."sizeId" IS NOT NULL)
      HAVING ABS(SUM(s."inQty" - s."outQty")) > 0.0005 OR ABS(SUM((s."inQty" - s."outQty") * COALESCE(s."unitRate", 0))) > 0.005
    `
    // Holds today, by item, store and share: what is reserved inside the shares above.
    const holds = await tx.$queryRaw<Array<{ itemId: string; warehouseId: string; brandId: string | null; qty: number }>>`
      SELECT "itemId", "warehouseId", "brandId", SUM(qty)::float8 AS qty
      FROM ld_erp.stock_reservations WHERE status::text = 'ACTIVE'
      GROUP BY 1, 2, 3`
    const heldAt = new Map(holds.map((h) => [`${h.itemId}|${h.warehouseId}|${h.brandId ?? ''}`, Number(h.qty)]))
    // Customers' material: listed apart, never a brand's, at no value of ours.
    const [customer] = await tx.$queryRaw<Array<{ lines: number }>>`
      SELECT COUNT(*)::int AS lines FROM (
        SELECT 1 FROM ld_erp.stock_ledger s
        WHERE s.ownership::text = 'CUSTOMER_OWNED' AND s."transactionDate" <= ${end}
          AND (${store}::text IS NULL OR s."warehouseId" = ${store})
        GROUP BY s."itemId", s."warehouseId", s."ownerCustomerId", s."sizeId", s.grade
        HAVING ABS(SUM(s."inQty" - s."outQty")) > 0.0005) x`

    const isFabric = (r: { category: string | null; parent: string | null }) => /fabric/i.test(r.category ?? '') || /fabric/i.test(r.parent ?? '')
    const isThread = (r: { category: string | null; parent: string | null }) => /thread/i.test(r.category ?? '') || /thread/i.test(r.parent ?? '')
    const kindOf = (r: { type: string; category: string | null; parent: string | null }) =>
      r.type === 'FINISHED_GOOD' ? 'Finished goods' : r.type === 'SEMI_FINISHED' ? 'Semi-finished' : isFabric(r) ? 'Fabric' : isThread(r) ? 'Thread' : 'Raw material'
    const wanted = (r: (typeof found)[number]) =>
      !kind ||
      (kind === 'FABRIC' && isFabric(r)) ||
      (kind === 'THREAD' && isThread(r)) ||
      (kind === 'RAW' && r.type !== 'FINISHED_GOOD' && r.type !== 'SEMI_FINISHED') ||
      (kind === 'SEMI' && r.type === 'SEMI_FINISHED') ||
      (kind === 'FG' && r.type === 'FINISHED_GOOD')
    const bucketOf = (r: (typeof found)[number]): Bucket =>
      r.storeKind === 'TRANSIT'
        ? 'transit'
        : r.storeKind === 'WIP' || r.storeKind === 'JOB_WORK'
          ? 'wip'
          : r.grade === 'R' || ['QC_HOLD', 'REJECTED', 'SCRAP'].includes(r.storeKind)
            ? 'rejected'
            : r.type === 'FINISHED_GOOD'
              ? 'finished'
              : 'rawSemi'
    const offers = (r: (typeof found)[number]) => !['QC_HOLD', 'REJECTED', 'SCRAP', 'TRANSIT', 'SAMPLE'].includes(r.storeKind) && r.grade === 'A'

    // Rows: one an item and share, everything in it sorted into its buckets.
    type Row = {
      itemCode: string
      item: string
      designNo: string
      colour: string
      kind: string
      share: string
      brandId: string | null
      uom: string
      physical: number
      free: number
      reserved: number
      rawSemi: number
      finished: number
      wip: number
      rejected: number
      transit: number
      value: number
      freeValue: number
      bucketValue: Record<Bucket, number>
      reservedValue: number
    }
    const byRow = new Map<string, Row>()
    for (const r of found.filter(wanted)) {
      const k = `${r.itemId}|${r.brandId ?? ''}`
      const row =
        byRow.get(k) ??
        ({
          itemCode: r.itemCode,
          item: r.item,
          designNo: r.designNo ?? '',
          colour: r.colour ?? '',
          kind: kindOf(r),
          share: r.brand ?? 'Central',
          brandId: r.brandId,
          uom: r.uom,
          physical: 0,
          free: 0,
          reserved: 0,
          rawSemi: 0,
          finished: 0,
          wip: 0,
          rejected: 0,
          transit: 0,
          value: 0,
          freeValue: 0,
          bucketValue: { rawSemi: 0, finished: 0, wip: 0, rejected: 0, transit: 0 },
          reservedValue: 0,
        } as Row)
      const b = bucketOf(r)
      row.physical += r.qty
      row[b] += r.qty
      row.value += r.value
      row.bucketValue[b] += r.value
      if (offers(r)) {
        // Holds are on unsized stock only, as the stock writer counts them.
        const held = r.sized ? 0 : Math.min(Math.max(0, r.qty), heldAt.get(`${r.itemId}|${r.storeId}|${r.brandId ?? ''}`) ?? 0)
        const rate = r.qty > 0 ? r.value / r.qty : 0
        row.reserved += held
        row.reservedValue += held * rate
        row.free += Math.max(0, r.qty - held)
        row.freeValue += Math.max(0, r.qty - held) * rate
      }
      byRow.set(k, row)
    }
    const r3 = (n: number) => Math.round(n * 1000) / 1000
    const all = [...byRow.values()]
      .map((r) => ({
        ...r,
        physical: r3(r.physical),
        free: r3(r.free),
        reserved: r3(r.reserved),
        rawSemi: r3(r.rawSemi),
        finished: r3(r.finished),
        wip: r3(r.wip),
        rejected: r3(r.rejected),
        transit: r3(r.transit),
        value: round2(r.value),
        freeValue: round2(r.freeValue),
      }))
      .sort((a, b) => a.item.localeCompare(b.item) || a.designNo.localeCompare(b.designNo) || a.colour.localeCompare(b.colour) || Number(a.brandId !== null) - Number(b.brandId !== null) || a.share.localeCompare(b.share))
    const rows = all.slice(0, rowCap).map(({ bucketValue: _b, reservedValue: _r, brandId: _id, ...rest }) => rest)

    // Material issued to orders still open, by the share it left: in their cost, not in stock.
    const issued = await tx.$queryRaw<Array<{ brandId: string | null; value: number }>>`
      SELECT s."brandId",
             SUM(CASE WHEN s."referenceType" = 'MATERIAL_REQUISITION' THEN s."outQty" * COALESCE(s."unitRate", 0) ELSE 0 END
               - CASE WHEN s."referenceType" = 'MR_RETURN' THEN s."inQty" * COALESCE(s."unitRate", 0) ELSE 0 END
               + CASE WHEN s."referenceType" = 'MR_RETURN_CANCELLED' THEN s."outQty" * COALESCE(s."unitRate", 0) ELSE 0 END)::float8 AS value
      FROM ld_erp.stock_ledger s
      JOIN ld_erp.material_requisitions mr ON mr.id = s."referenceId"
      JOIN ld_erp.manufacturing_orders mo ON mo.id = mr."moId"
      WHERE s.ownership::text = 'OWNED' AND s."transactionDate" <= ${end}
        AND s."referenceType" IN ('MATERIAL_REQUISITION', 'MR_RETURN', 'MR_RETURN_CANCELLED')
        AND mo.status::text NOT IN ('COMPLETED', 'CLOSED')
        AND (${store}::text IS NULL OR s."warehouseId" = ${store})
      GROUP BY s."brandId"`

    // The company and each share, in rupees: quantities of different units are never added up.
    const shareNames = new Map<string, string>()
    for (const r of all) shareNames.set(r.brandId ?? '', r.share)
    for (const i of issued) if (!shareNames.has(i.brandId ?? '')) shareNames.set(i.brandId ?? '', i.brandId ? ((await tx.brand.findUnique({ where: { id: i.brandId }, select: { name: true } }))?.name ?? 'A brand') : 'Central')
    const shareKeys = [...shareNames.keys()].sort((a, b) => Number(a !== '') - Number(b !== '') || shareNames.get(a)!.localeCompare(shareNames.get(b)!))
    const sum = (rs: typeof all, f: (r: (typeof all)[number]) => number) => round2(rs.reduce((t, r) => t + f(r), 0))
    const columns = ['Physical', ...BUCKETS.map((b) => BUCKET_LABEL[b]), 'Reserved', 'Free', 'Issued to open MOs']
    const valuesFor = (rs: typeof all, issuedValue: number) => [
      sum(rs, (r) => r.value),
      ...BUCKETS.map((b) => sum(rs, (r) => r.bucketValue[b])),
      sum(rs, (r) => r.reservedValue),
      sum(rs, (r) => r.freeValue),
      round2(issuedValue),
    ]
    const issuedOf = (k: string) => issued.filter((i) => (i.brandId ?? '') === k).reduce((t, i) => t + Number(i.value), 0)
    const matrixRows = [
      { label: 'Company', values: valuesFor(all, issued.reduce((t, i) => t + Number(i.value), 0)) },
      ...shareKeys.map((k) => ({ label: shareNames.get(k)!, values: valuesFor(all.filter((r) => (r.brandId ?? '') === k), issuedOf(k)) })),
    ].map((r) => ({ label: r.label, values: r.values.map((v) => (Math.abs(v) < 0.005 ? null : v)) }))

    const value = sum(all, (r) => r.value)
    const central = sum(all.filter((r) => r.brandId === null), (r) => r.value)
    const earmarked = round2(value - central)
    const items = new Set(all.map((r) => r.itemCode)).size
    const byShare = shareKeys.map((k) => ({ label: shareNames.get(k)!, value: sum(all.filter((r) => (r.brandId ?? '') === k), (r) => r.value) })).filter((p) => p.value > 0)
    const byBucket = BUCKETS.map((b) => ({ label: BUCKET_LABEL[b], value: sum(all, (r) => r.bucketValue[b]) })).filter((p) => p.value > 0)
    const negative = all.filter((r) => r.physical < -0.0005)

    const insights: string[] = []
    if (value > 0) insights.push(`${pctOf(earmarked, value)} of the stock's value is earmarked for brands; ${pctOf(central, value)} is central stock any brand can use.`)
    const reservedValue = sum(all, (r) => r.reservedValue)
    if (reservedValue > 0) insights.push(`${rupees(reservedValue)} is held for requisitions, inside the shares it is on.`)
    if (customer?.lines) insights.push(`${customer.lines} balances of customers' material are left out: they are never a brand's and carry no value of ours (Customer Material report).`)

    return {
      rows,
      totalRows: all.length > rowCap ? all.length : undefined,
      analysis: {
        headline: all.length
          ? `${items} items as on ${asOnLabel(params)}: ${rupees(value)} of our own stock, ${rupees(central)} central and ${rupees(earmarked)} earmarked for brands.`
          : `No stock of our own as on ${asOnLabel(params)} for these filters.`,
        kpis: [
          { label: 'Physical stock value', value: all.length ? value : null, format: 'money', basis: 'every share, at its own average' },
          { label: 'Central stock', value: all.length ? central : null, format: 'money', basis: 'for any brand' },
          { label: 'Earmarked for brands', value: all.length ? earmarked : null, format: 'money', basis: 'the brands’ shares together' },
          { label: 'Free to use', value: all.length ? sum(all, (r) => r.freeValue) : null, format: 'money', basis: 'first quality in issuing stores, less holds' },
          { label: 'WIP on floors', value: all.length ? sum(all, (r) => r.bucketValue.wip) : null, format: 'money', basis: 'process floors and job workers' },
          { label: 'In transit', value: all.length ? sum(all, (r) => r.bucketValue.transit) : null, format: 'money', basis: 'between two stores' },
        ],
        exceptions: negative.length
          ? [{ label: 'Shares below nothing', value: negative.length, format: 'integer', basis: 'run Stock Reconciliation', tone: 'bad' }]
          : [],
        matrix: matrixRows.length > 1
          ? { title: 'Stock value — the company and each share', rowLabel: 'Share', columns, rows: matrixRows, format: 'money' }
          : undefined,
        panels: (
          [
            { title: 'Stock value by share', question: 'composition', format: 'money', points: topWithRest(byShare, 6) },
            { title: 'Stock value by where it is', question: 'composition', format: 'money', points: byBucket },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Share is whose the stock is: Central for the company’s stock that no brand has yet, or the brand it is earmarked for. The shares of a balance always add up to it.',
          'Physical is all of a share: raw and semi-finished, finished goods, WIP, rejected and held, and in transit. Free and Reserved are within it: free is first quality in a store goods are issued from, less what is held for requisitions.',
          'Value is at the rate each movement was made at, so each brand’s share keeps its own average; the values add up to the stock the books carry.',
          'Issued to open MOs is material already issued to orders still being made, by the share it left: it is in those orders’ cost, not in stock.',
          "Our own stock only; customers' material is in the Customer Material report. Fixed assets are not stock.",
        ],
      },
    }
  },
}
