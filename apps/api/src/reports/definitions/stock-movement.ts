import { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import { byMonth, dateRangeFilters, periodLabel, round2 } from './shared'
import {
  BUCKET_LABEL,
  BUCKET_TONE,
  bucketOf,
  categoryFilter,
  daysBetween,
  loadCategories,
  ownershipFilter,
  ownershipsOf,
  rupees,
  warehouseFilter,
  type Bucket,
} from './inventory-shared'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Opening, what came in and went out, and closing — item by item.
 *
 * The stock statement for a period. Each movement is put under what it was
 * (bought, issued, sent for job work, counted) so the reader sees why a
 * balance moved, not just that it did. Turnover and days of cover are worked
 * out from the same figures.
 */
export const stockMovement: ReportDefinition = {
  id: 'stock-movement',
  module: 'inventory',
  title: 'Stock Movement Summary',
  description:
    'For each item and store: opening stock, what was bought, issued, sent for job work, moved and counted in the period, and closing stock — with values, turnover and days of cover.',
  filters: [...dateRangeFilters, warehouseFilter, categoryFilter, ownershipFilter],
  columns: [
    { key: 'category', label: 'Category', type: 'text', width: 18 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'store', label: 'Store', type: 'text', width: 18 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'opening', label: 'Opening', type: 'qty', total: 'sum' },
    { key: 'openingEntry', label: 'Opening Entry', type: 'qty', total: 'sum' },
    { key: 'purchase', label: 'Bought (net)', type: 'qty', total: 'sum' },
    { key: 'customer', label: 'Customer Material', type: 'qty', total: 'sum' },
    { key: 'issue', label: 'Issued', type: 'qty', total: 'sum' },
    { key: 'jobwork', label: 'Job Work (net)', type: 'qty', total: 'sum' },
    { key: 'transfer', label: 'Transfers (net)', type: 'qty', total: 'sum' },
    { key: 'adjustment', label: 'Adjusted', type: 'qty', total: 'sum' },
    { key: 'closing', label: 'Closing', type: 'qty', total: 'sum' },
    { key: 'openingValue', label: 'Opening Value', type: 'money', total: 'sum' },
    { key: 'inValue', label: 'Value In', type: 'money', total: 'sum' },
    { key: 'outValue', label: 'Value Out', type: 'money', total: 'sum' },
    { key: 'closingValue', label: 'Closing Value', type: 'money', total: 'sum' },
  ],
  summary: {
    title: 'Items that moved the most value',
    columns: ['item', 'store', 'opening', 'issue', 'closing', 'outValue'],
    by: 'outValue',
    limit: 12,
  },
  pivot: {
    rows: ['category', 'item'],
    values: ['openingValue', 'inValue', 'outValue', 'closingValue'],
    slicers: ['store'],
    note: 'Values add up across items; quantities only within one item.',
  },

  async run({ tx, params, rowCap }) {
    const from = params.from ? new Date(`${params.from}T00:00:00`) : new Date(0)
    const to = params.to ? new Date(`${params.to}T23:59:59.999`) : new Date()
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
        type: string
        ref: string | null
        before: boolean
        qty: number
        value: number
        inValue: number
        outValue: number
      }>
    >`
      SELECT i.id AS "itemId", i.code AS "itemCode", i.name AS "itemName", i."categoryId",
             u.symbol AS uom, w.id AS "warehouseId", w.name AS store,
             s."transactionType"::text AS type, s."referenceType" AS ref,
             (s."transactionDate" < ${from}) AS before,
             SUM(s."inQty" - s."outQty")::float8 AS qty,
             SUM((s."inQty" - s."outQty") * COALESCE(s."unitRate", 0))::float8 AS value,
             SUM(s."inQty" * COALESCE(s."unitRate", 0))::float8 AS "inValue",
             SUM(s."outQty" * COALESCE(s."unitRate", 0))::float8 AS "outValue"
      FROM ld_erp.stock_ledger s
      JOIN ld_erp.items i ON i.id = s."itemId"
      JOIN ld_erp.uom u ON u.id = i."uomId"
      JOIN ld_erp.warehouses w ON w.id = s."warehouseId"
      WHERE s."transactionDate" <= ${to}
        AND s.ownership::text IN (${Prisma.join(owners)})
        AND (${params.warehouseId ?? null}::text IS NULL OR s."warehouseId" = ${params.warehouseId ?? null})
        AND (${catIds}::text[] IS NULL OR i."categoryId" = ANY(${catIds}::text[]))
      -- By position: the "before" column is a parameter, and Postgres will not
      -- match a second copy of it in GROUP BY to the one in SELECT.
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    `

    type Row = {
      category: string
      itemCode: string
      item: string
      store: string
      uom: string
      opening: number
      openingEntry: number
      openingValue: number
      closing: number
      closingValue: number
      inValue: number
      outValue: number
    } & Record<Bucket, number>
    const byKey = new Map<string, Row>()
    // Value moved by kind across the period, for the panel.
    const valueByBucket = new Map<Bucket, number>()
    for (const f of found) {
      const key = `${f.itemId}|${f.warehouseId}`
      let r = byKey.get(key)
      if (!r) {
        r = {
          category: cats.names(f.categoryId).category,
          itemCode: f.itemCode,
          item: f.itemName,
          store: f.store,
          uom: f.uom,
          opening: 0,
          openingValue: 0,
          closing: 0,
          closingValue: 0,
          inValue: 0,
          outValue: 0,
          openingEntry: 0,
          purchase: 0,
          customer: 0,
          issue: 0,
          jobwork: 0,
          transfer: 0,
          adjustment: 0,
          sale: 0,
        }
        byKey.set(key, r)
      }
      r.closing += f.qty
      r.closingValue += f.value
      if (f.before) {
        r.opening += f.qty
        r.openingValue += f.value
        continue
      }
      const b = bucketOf(f.type, f.ref)
      if (b === 'opening') r.openingEntry += f.qty
      else if (b === 'issue' || b === 'sale') r.issue += -f.qty
      else r[b] += f.qty
      r.inValue += f.inValue
      r.outValue += f.outValue
      // Moves inside the mill (between stores, to the job work godown) are
      // not value gained or lost, so the panel shows the net per kind.
      valueByBucket.set(b, (valueByBucket.get(b) ?? 0) + f.value)
    }

    const all = [...byKey.values()]
      .map(({ sale: _sale, ...r }) => ({
        ...r,
        opening: r3(r.opening),
        openingEntry: r3(r.openingEntry),
        purchase: r3(r.purchase),
        customer: r3(r.customer),
        issue: r3(r.issue),
        jobwork: r3(r.jobwork),
        transfer: r3(r.transfer),
        adjustment: r3(r.adjustment),
        closing: r3(r.closing),
        openingValue: round2(r.openingValue),
        closingValue: round2(r.closingValue),
        inValue: round2(r.inValue),
        outValue: round2(r.outValue),
      }))
      .filter((r) => r.opening || r.closing || r.inValue || r.outValue)
      .sort((a, b) => a.item.localeCompare(b.item) || a.store.localeCompare(b.store))
    const rows = all.slice(0, rowCap)

    const openingValue = round2(all.reduce((s, r) => s + r.openingValue, 0))
    const closingValue = round2(all.reduce((s, r) => s + r.closingValue, 0))
    const issuedValue = round2(-(valueByBucket.get('issue') ?? 0) - (valueByBucket.get('sale') ?? 0))
    const boughtValue = round2(valueByBucket.get('purchase') ?? 0)
    const days = Math.max(1, daysBetween(params.from ? from : (await firstMovement(tx)) ?? to, to))
    const avgStock = (openingValue + closingValue) / 2
    const turnover = avgStock > 0 ? issuedValue / avgStock : null
    const cover = issuedValue > 0 ? Math.round(closingValue / (issuedValue / days)) : null

    // Issues by month, from the ledger itself so the trend has its own dates.
    const issues = await tx.stockLedger.findMany({
      where: {
        transactionType: 'ISSUE',
        transactionDate: { gte: from, lte: to },
        ownership: { in: owners },
        ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
        ...(catIds ? { item: { categoryId: { in: catIds } } } : {}),
      },
      select: { transactionDate: true, outQty: true, inQty: true, unitRate: true },
    })
    const monthly = byMonth(issues, (r) => r.transactionDate, (r) => (Number(r.outQty) - Number(r.inQty)) * Number(r.unitRate ?? 0))

    const movers = all
      .map((r) => ({ label: r.item, value: r.outValue }))
      .reduce((m, e) => m.set(e.label, (m.get(e.label) ?? 0) + e.value), new Map<string, number>())
    const idle = all.filter((r) => r.closing > 0 && r.inValue === 0 && r.outValue === 0)
    const idleValue = round2(idle.reduce((s, r) => s + r.closingValue, 0))

    const insights: string[] = []
    if (turnover !== null)
      insights.push(
        turnover >= 0.1
          ? `Stock turned ${turnover.toFixed(1)} times in ${days} days: ${rupees(issuedValue)} issued against ${rupees(avgStock)} held on average.`
          : `Stock barely turned: ${rupees(issuedValue)} issued in ${days} days against ${rupees(avgStock)} held on average.`,
      )
    if (cover !== null)
      insights.push(
        cover <= 730
          ? `Closing stock covers about ${cover} days of issues at the rate of this period.`
          : 'At the rate material was issued in this period, closing stock would last more than two years.',
      )
    if (idle.length) insights.push(`${idle.length} item-store lines worth ${rupees(idleValue)} did not move at all in the period.`)
    const adj = round2(valueByBucket.get('adjustment') ?? 0)
    if (adj) insights.push(`Stock adjustments (counts and manual corrections) ${adj < 0 ? 'wrote off' : 'added'} ${rupees(Math.abs(adj))} in the period.`)

    return {
      rows,
      totalRows: all.length > rowCap ? all.length : undefined,
      analysis: {
        headline: all.length
          ? `${periodLabel(params)}: stock went from ${rupees(openingValue)} to ${rupees(closingValue)}.`
          : 'No stock moved in this period.',
        kpis: [
          { label: 'Opening value', value: all.length ? openingValue : null, format: 'money', basis: 'at the start of the period' },
          { label: 'Bought (net of returns)', value: all.length ? boughtValue : null, format: 'money', basis: 'received on GRNs less returns' },
          { label: 'Issued', value: all.length ? issuedValue : null, format: 'money', basis: 'to production and despatched' },
          { label: 'Closing value', value: all.length ? closingValue : null, format: 'money', basis: 'at the end of the period' },
          {
            label: 'Days of cover',
            value: cover !== null && cover <= 730 ? cover : null,
            format: 'days',
            basis: cover !== null && cover > 730 ? 'over two years at this rate of issue' : 'closing stock ÷ daily issues',
          },
        ],
        trend:
          monthly.length > 1
            ? { title: 'Value issued, by month', valueLabel: 'Issued', format: 'money', points: monthly }
            : undefined,
        panels: (
          [
            {
              title: 'Net value moved, by kind',
              question: 'comparison',
              format: 'money',
              points: (['purchase', 'customer', 'issue', 'jobwork', 'transfer', 'adjustment', 'opening'] as Bucket[])
                .map((b) => ({ label: BUCKET_LABEL[b], value: round2(Math.abs(valueByBucket.get(b) ?? 0)), tone: BUCKET_TONE[b] }))
                .filter((p) => p.value > 0),
            },
            {
              title: 'Most value issued, by item',
              question: 'ranking',
              format: 'money',
              points: [...movers].map(([label, value]) => ({ label, value: round2(value) })).sort((a, b) => b.value - a.value).slice(0, 10),
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          params.ownership && params.ownership !== 'OWNED'
            ? "Customers' material has no value, so it only moves the quantity columns."
            : "Our own stock only. Customers' material is in the Customer Material report.",
          'Transfers and job work move stock between our own stores; across all stores they net to nought except material lost or converted at the job worker.',
          'Bought is net of goods returned to suppliers. Issued includes anything despatched.',
          'A cancelled document is reversed in the ledger, so it nets to nought here rather than being left out.',
        ],
      },
    }
  },
}

async function firstMovement(tx: Prisma.TransactionClient): Promise<Date | null> {
  const r = await tx.stockLedger.findFirst({ orderBy: { transactionDate: 'asc' }, select: { transactionDate: true } })
  return r?.transactionDate ?? null
}
