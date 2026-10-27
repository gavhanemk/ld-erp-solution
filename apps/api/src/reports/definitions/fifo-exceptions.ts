import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import { dateRangeFilters, periodLabel } from './shared'
import { categoryFilter, loadCategories, warehouseFilter } from './inventory-shared'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Each time a newer package went out before an older one of the same item,
 * store and owner that still had stock — first in, first out broken on
 * purpose. Only the store manager can allow it, and gives a reason; this is
 * the list of those, with who allowed it and why.
 */
export const fifoExceptions: ReportDefinition = {
  id: 'fifo-exceptions',
  module: 'inventory',
  title: 'FIFO Exceptions',
  description:
    'Every time a newer roll, box or packet went out before an older one still on the rack — the package that went, the one left behind, the reason and who allowed it.',
  filters: [...dateRangeFilters, warehouseFilter, categoryFilter],
  columns: [
    { key: 'date', label: 'Date', type: 'date', width: 14 },
    { key: 'what', label: 'What', type: 'badge', width: 10,
      badges: { ISSUED: 'Went out', TRANSFERRED: 'Moved' },
      badgeTones: { ISSUED: 'warn', TRANSFERRED: 'neutral' } },
    { key: 'sticker', label: 'Went First', type: 'text', width: 14 },
    { key: 'skipped', label: 'Older One Left', type: 'text', width: 14 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'category', label: 'Category', type: 'text', width: 18 },
    { key: 'store', label: 'Store', type: 'text', width: 18 },
    { key: 'qty', label: 'Qty', type: 'qty', total: 'none' },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'reference', label: 'Against', type: 'text', width: 16 },
    { key: 'reason', label: 'Reason', type: 'text', width: 30 },
    { key: 'by', label: 'Allowed By', type: 'text', width: 18 },
  ],

  async run({ tx, params, rowCap }) {
    const from = params.from ? new Date(`${params.from}T00:00:00`) : undefined
    const to = params.to ? new Date(`${params.to}T23:59:59.999`) : undefined
    const cats = await loadCategories(tx)
    const catIds = cats.under(params.categoryId)

    const where: Prisma.StockPackageMoveWhereInput = {
      fifoReason: { not: null },
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(catIds ? { package: { item: { categoryId: { in: catIds } } } } : {}),
    }
    const moves = await tx.stockPackageMove.findMany({
      where,
      take: rowCap,
      orderBy: { createdAt: 'asc' },
      select: {
        type: true,
        qty: true,
        warehouseId: true,
        referenceNumber: true,
        fifoSkippedId: true,
        fifoReason: true,
        createdAt: true,
        createdBy: { select: { name: true } },
        package: { select: { code: true, item: { select: { code: true, name: true, categoryId: true, uom: { select: { symbol: true } } } } } },
      },
    })
    const ids = [...new Set(moves.map((m) => m.fifoSkippedId).filter((x): x is string => !!x))]
    const stores = [...new Set(moves.map((m) => m.warehouseId))]
    const [skipped, warehouses] = await Promise.all([
      ids.length ? tx.stockPackage.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } }) : [],
      stores.length ? tx.warehouse.findMany({ where: { id: { in: stores } }, select: { id: true, name: true } }) : [],
    ])
    const codeOf = new Map(skipped.map((p) => [p.id, p.code]))
    const storeOf = new Map(warehouses.map((w) => [w.id, w.name]))

    const rows = moves.map((m) => ({
      date: m.createdAt,
      what: m.type === 'TRANSFERRED' ? 'TRANSFERRED' : 'ISSUED',
      sticker: m.package.code,
      skipped: (m.fifoSkippedId && codeOf.get(m.fifoSkippedId)) || '',
      itemCode: m.package.item.code,
      item: m.package.item.name,
      category: cats.names(m.package.item.categoryId).category,
      store: storeOf.get(m.warehouseId) ?? '',
      qty: r3(Math.abs(Number(m.qty))),
      uom: m.package.item.uom?.symbol ?? '',
      reference: m.referenceNumber ?? '',
      reason: m.fifoReason ?? '',
      by: m.createdBy?.name ?? '',
    }))

    const count = (key: (r: (typeof rows)[number]) => string) => {
      const m = new Map<string, number>()
      for (const r of rows) m.set(key(r) || 'Not given', (m.get(key(r) || 'Not given') ?? 0) + 1)
      return [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)
    }
    const byReason = count((r) => r.reason)
    const byStore = count((r) => r.store)
    const byPerson = count((r) => r.by)
    const items = new Set(rows.map((r) => r.itemCode)).size

    const insights: string[] = []
    if (byReason.length) insights.push(`The most common reason was "${byReason[0].label}" (${byReason[0].value} of ${rows.length}).`)
    if (byStore.length > 1) insights.push(`${byStore[0].label} had the most: ${byStore[0].value}.`)
    if (byPerson.length) insights.push(`Allowed by ${byPerson.map((p) => `${p.label} (${p.value})`).join(', ')}.`)

    return {
      rows,
      analysis: {
        headline: rows.length
          ? `${rows.length} ${rows.length === 1 ? 'time' : 'times'} a newer package went before an older one, ${periodLabel(params).toLowerCase()}.`
          : `First in, first out was kept every time, ${periodLabel(params).toLowerCase()}.`,
        kpis: [
          { label: 'Exceptions', value: rows.length, format: 'integer', basis: 'newer package went first', tone: rows.length ? 'warn' : 'good' },
          { label: 'Items', value: rows.length ? items : null, format: 'integer', basis: 'with an exception' },
          { label: 'Allowed by', value: rows.length ? byPerson.length : null, format: 'integer', basis: 'people' },
        ],
        panels: (
          [
            { title: 'Why', question: 'ranking', format: 'integer', points: byReason },
            { title: 'By store', question: 'comparison', format: 'integer', points: byStore },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'A newer package goes before an older one only when the store manager allows it, with a reason. Each time is listed here.',
          'Packages from the same receipt count as the same age, so taking them in any order is not an exception.',
          'Packages on hold (rejected at receipt) never count as older: they cannot go out.',
        ],
      },
    }
  },
}
