import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import { byMonth, dateRangeFilters, periodLabel, round2, topWithRest } from './shared'
import { categoryFilter, loadCategories, pctOf, rupees, warehouseFilter } from './inventory-shared'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * What the physical counts found against the book.
 *
 * One row per item counted. A shortage is stock the ledger said was there
 * and was not; an excess is the opposite. Where the shortages cluster — one
 * store, one category, one reason — is where the leak is.
 */
export const stockCountVariance: ReportDefinition = {
  id: 'stock-count-variance',
  module: 'inventory',
  title: 'Stock Count Variance',
  description:
    'Every stock count — book quantity, counted quantity, the difference and its value — to see where stock goes missing and how accurate the books are.',
  filters: [...dateRangeFilters, warehouseFilter, categoryFilter],
  columns: [
    { key: 'result', label: 'Result', type: 'badge', width: 12,
      badges: { SHORT: 'Short', EXCESS: 'Excess', MATCH: 'Matched' },
      badgeTones: { SHORT: 'bad', EXCESS: 'warn', MATCH: 'good' } },
    { key: 'date', label: 'Counted On', type: 'date', width: 14 },
    { key: 'number', label: 'Adjustment', type: 'text', width: 16 },
    { key: 'store', label: 'Store', type: 'text', width: 18 },
    { key: 'reason', label: 'Reason', type: 'text', width: 28 },
    { key: 'category', label: 'Category', type: 'text', width: 18 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'book', label: 'Book', type: 'qty', total: 'none' },
    { key: 'counted', label: 'Counted', type: 'qty', total: 'none' },
    { key: 'difference', label: 'Difference', type: 'qty', total: 'none' },
    { key: 'variance', label: 'Variance %', type: 'percent', total: 'none' },
    { key: 'rate', label: 'Rate', type: 'money', total: 'none' },
    { key: 'value', label: 'Value (+/−)', type: 'money', total: 'sum' },
    { key: 'loss', label: 'Value Missing', type: 'money', total: 'sum' },
  ],
  summary: {
    title: 'Biggest shortages found',
    columns: ['date', 'store', 'item', 'book', 'counted', 'value'],
    by: 'loss',
    limit: 12,
  },
  pivot: {
    rows: ['store', 'category'],
    values: ['value'],
    slicers: ['result', 'reason'],
    note: 'Open a store to see which categories it lost or gained.',
  },

  async run({ tx, params, rowCap }) {
    const from = params.from ? new Date(`${params.from}T00:00:00`) : undefined
    const to = params.to ? new Date(`${params.to}T23:59:59.999`) : undefined
    const cats = await loadCategories(tx)
    const catIds = cats.under(params.categoryId)

    const where: Prisma.StockAdjustmentLineWhereInput = {
      adjustment: {
        ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
        ...(from || to ? { adjustmentDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      ...(catIds ? { item: { categoryId: { in: catIds } } } : {}),
    }
    const lines = await tx.stockAdjustmentLine.findMany({
      where,
      take: rowCap,
      orderBy: { adjustment: { adjustmentDate: 'asc' } },
      select: {
        bookQty: true,
        countedQty: true,
        difference: true,
        unitRate: true,
        item: { select: { code: true, name: true, categoryId: true, standardRate: true, uom: { select: { symbol: true } } } },
        adjustment: { select: { adjustmentNumber: true, adjustmentDate: true, reason: true, warehouse: { select: { name: true } } } },
      },
    })

    const rows = lines.map((l) => {
      const book = Number(l.bookQty)
      const diff = Number(l.difference)
      const rate = Number(l.unitRate ?? l.item.standardRate ?? 0)
      const value = round2(diff * rate)
      return {
        result: Math.abs(diff) < 0.0005 ? 'MATCH' : diff < 0 ? 'SHORT' : 'EXCESS',
        date: l.adjustment.adjustmentDate,
        number: l.adjustment.adjustmentNumber,
        store: l.adjustment.warehouse.name,
        reason: l.adjustment.reason,
        category: cats.names(l.item.categoryId).category,
        itemCode: l.item.code,
        item: l.item.name,
        uom: l.item.uom?.symbol ?? '',
        book: r3(book),
        counted: r3(Number(l.countedQty)),
        difference: r3(diff),
        variance: book !== 0 ? diff / book : null,
        rate,
        value,
        loss: value < 0 ? -value : 0,
      }
    })

    const lost = round2(rows.reduce((s, r) => s + r.loss, 0))
    const found = round2(rows.reduce((s, r) => s + Math.max(r.value, 0), 0))
    const net = round2(found - lost)
    const matched = rows.filter((r) => r.result === 'MATCH').length
    const counts = new Set(rows.map((r) => r.number)).size
    const lossBy = (key: (r: (typeof rows)[number]) => string) => {
      const m = new Map<string, number>()
      for (const r of rows) if (r.loss) m.set(key(r) || 'Not given', (m.get(key(r) || 'Not given') ?? 0) + r.loss)
      return [...m].map(([label, value]) => ({ label, value: round2(value) })).sort((a, b) => b.value - a.value)
    }
    const byStore = lossBy((r) => r.store)
    const byCat = lossBy((r) => r.category)
    const monthly = byMonth(rows, (r) => r.date, (r) => r.loss)

    const insights: string[] = []
    if (rows.length) insights.push(`${pctOf(matched, rows.length)} of items counted matched the book exactly.`)
    if (lost) insights.push(`Counts found ${rupees(lost)} of stock missing and ${rupees(found)} extra, a net ${net < 0 ? 'loss' : 'gain'} of ${rupees(Math.abs(net))}.`)
    if (byStore.length > 1) insights.push(`${byStore[0].label} accounts for ${pctOf(byStore[0].value, lost)} of the value missing.`)
    const worst = [...rows].sort((a, b) => b.loss - a.loss)[0]
    if (worst?.loss) insights.push(`The biggest shortage was ${worst.item} in ${worst.store}: ${Math.abs(worst.difference).toLocaleString('en-IN')} ${worst.uom}, ${rupees(worst.loss)}.`)

    return {
      rows,
      analysis: {
        headline: rows.length
          ? `${counts} stock counts, ${periodLabel(params).toLowerCase()}: net ${net < 0 ? 'loss' : 'gain'} of ${rupees(Math.abs(net))}.`
          : 'No stock counts were recorded in this period.',
        kpis: [
          { label: 'Count accuracy', value: rows.length ? matched / rows.length : null, format: 'percent', basis: `items matching the book, of ${rows.length}` },
          { label: 'Value missing', value: rows.length ? lost : null, format: 'money', basis: 'shortages found', tone: lost ? 'bad' : undefined },
          { label: 'Value found extra', value: rows.length ? found : null, format: 'money', basis: 'excesses found' },
          { label: 'Net effect', value: rows.length ? net : null, format: 'money', basis: 'on the stock value' },
        ],
        trend: monthly.length > 1 ? { title: 'Value missing, by month', valueLabel: 'Missing', format: 'money', points: monthly } : undefined,
        panels: (
          [
            { title: 'Value missing, by store', question: 'comparison', format: 'money', points: byStore.map((p) => ({ ...p, tone: 'bad' as const })) },
            { title: 'Value missing, by category', question: 'ranking', format: 'money', points: topWithRest(byCat, 8) },
            {
              title: 'Count results',
              question: 'composition',
              format: 'integer',
              points: [
                { label: 'Matched', value: matched, tone: 'good' as const },
                { label: 'Short', value: rows.filter((r) => r.result === 'SHORT').length, tone: 'bad' as const },
                { label: 'Excess', value: rows.filter((r) => r.result === 'EXCESS').length, tone: 'warn' as const },
              ],
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Value is at the rate the stock was carried at on the day of the count, or the standard rate where none was recorded.',
          'Only items that were counted are listed; an item never counted is not shown as matching.',
          'Corrections made without a count sheet are not here. They are in the Stock Movement Summary and the Item Stock Ledger.',
          'The period is the date of the count.',
        ],
      },
    }
  },
}
