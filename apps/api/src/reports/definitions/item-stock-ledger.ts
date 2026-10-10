import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import { dateRangeFilters, itemFilter, periodLabel, round2 } from './shared'
import {
  BUCKET_LABEL,
  BUCKET_TONE,
  bucketOf,
  categoryFilter,
  documentNumbers,
  loadCategories,
  ownershipFilter,
  ownershipsOf,
  rupees,
  warehouseFilter,
  type Bucket,
} from './inventory-shared'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Every movement of stock, with the document behind it and the balance after.
 *
 * The answer to "where did it go?" for one item, or for a store over a week.
 * The balance runs per item, per store and per owner, starting from what was
 * there before the period, so the last line of an item is its stock.
 */
export const itemStockLedger: ReportDefinition = {
  id: 'item-stock-ledger',
  module: 'inventory',
  title: 'Item Stock Ledger',
  description:
    'Every receipt, issue, transfer, job work and stock count in the period, with its document number and the running balance — the trail behind any stock figure.',
  filters: [
    { ...itemFilter, help: 'Pick an item to read its whole history' },
    ...dateRangeFilters,
    warehouseFilter,
    categoryFilter,
    ownershipFilter,
  ],
  columns: [
    { key: 'date', label: 'Date', type: 'date', width: 14 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'store', label: 'Store', type: 'text', width: 18 },
    { key: 'owner', label: 'Owner', type: 'text', width: 18 },
    { key: 'movement', label: 'Movement', type: 'text', width: 20 },
    { key: 'document', label: 'Document', type: 'text', width: 18 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'inQty', label: 'In', type: 'qty', total: 'sum' },
    { key: 'outQty', label: 'Out', type: 'qty', total: 'sum' },
    { key: 'balance', label: 'Balance', type: 'qty', total: 'none' },
    { key: 'rate', label: 'Rate', type: 'money', total: 'none' },
    { key: 'value', label: 'Value (+/−)', type: 'money', total: 'sum' },
    { key: 'notes', label: 'Notes', type: 'text', width: 36 },
  ],
  pivot: {
    rows: ['item', 'movement'],
    values: ['inQty', 'outQty', 'value'],
    slicers: ['store', 'owner'],
    note: 'Open an item to see what moved it, kind by kind.',
  },

  async run({ tx, params, rowCap }) {
    const from = params.from ? new Date(`${params.from}T00:00:00`) : undefined
    const to = params.to ? new Date(`${params.to}T23:59:59.999`) : undefined
    const owners = ownershipsOf(params)
    const cats = await loadCategories(tx)
    const catIds = cats.under(params.categoryId)

    const base: Prisma.StockLedgerWhereInput = {
      ownership: { in: owners },
      ...(params.itemId ? { itemId: params.itemId } : {}),
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(catIds ? { item: { categoryId: { in: catIds } } } : {}),
    }
    const where: Prisma.StockLedgerWhereInput = {
      ...base,
      ...(from || to ? { transactionDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    }

    // What each item had in each store before the period opened.
    const before = from
      ? await tx.stockLedger.groupBy({
          by: ['itemId', 'warehouseId', 'ownership', 'ownerCustomerId'],
          where: { ...base, transactionDate: { lt: from } },
          _sum: { inQty: true, outQty: true },
        })
      : []
    const balance = new Map<string, number>()
    for (const b of before) {
      balance.set(
        `${b.itemId}|${b.warehouseId}|${b.ownership}|${b.ownerCustomerId ?? ''}`,
        Number(b._sum.inQty ?? 0) - Number(b._sum.outQty ?? 0),
      )
    }

    const totalRows = await tx.stockLedger.count({ where })
    const entries = await tx.stockLedger.findMany({
      where,
      take: rowCap,
      orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }],
      select: {
        itemId: true,
        warehouseId: true,
        ownership: true,
        ownerCustomerId: true,
        transactionType: true,
        referenceType: true,
        referenceId: true,
        inQty: true,
        outQty: true,
        unitRate: true,
        transactionDate: true,
        notes: true,
        item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
        warehouse: { select: { name: true } },
        ownerCustomer: { select: { name: true } },
      },
    })
    const docs = await documentNumbers(tx, entries)

    const valueByBucket = new Map<Bucket, number>()
    const rows = entries.map((e) => {
      const key = `${e.itemId}|${e.warehouseId}|${e.ownership}|${e.ownerCustomerId ?? ''}`
      const inQty = Number(e.inQty)
      const outQty = Number(e.outQty)
      const bal = (balance.get(key) ?? 0) + inQty - outQty
      balance.set(key, bal)
      const rate = Number(e.unitRate ?? 0)
      const value = round2((inQty - outQty) * rate)
      const b = bucketOf(e.transactionType, e.referenceType)
      valueByBucket.set(b, (valueByBucket.get(b) ?? 0) + Math.abs(value))
      return {
        date: e.transactionDate,
        itemCode: e.item.code,
        item: e.item.name,
        store: e.warehouse.name,
        owner: e.ownership === 'OWNED' ? 'Ours' : (e.ownerCustomer?.name ?? 'Customer'),
        movement: e.referenceType?.endsWith('CANCELLED') ? `${BUCKET_LABEL[b]} (cancelled)` : BUCKET_LABEL[b],
        document:
          (e.referenceId && docs.get(e.referenceId)) ||
          (e.referenceType === 'OPENING_STOCK' ? (e.referenceId ?? 'Opening') : ''),
        uom: e.item.uom?.symbol ?? '',
        inQty: r3(inQty),
        outQty: r3(outQty),
        balance: r3(bal),
        rate,
        value,
        notes: e.notes ?? '',
      }
    })

    const valueIn = round2(rows.reduce((s, r) => s + Math.max(r.value, 0), 0))
    const valueOut = round2(rows.reduce((s, r) => s + Math.max(-r.value, 0), 0))
    const items = new Set(rows.map((r) => r.itemCode)).size
    const single = items === 1 ? rows[0] : null
    const negative = rows.filter((r) => r.balance < -0.0005)

    const insights: string[] = []
    if (single) {
      const last = new Map<string, number>()
      for (const r of rows) last.set(r.store, r.balance)
      insights.push(
        `${single.item} ends the period with ${[...last].map(([s, q]) => `${q.toLocaleString('en-IN')} ${single.uom} in ${s}`).join(', ')}.`,
      )
      const inQ = rows.reduce((s, r) => s + r.inQty, 0)
      const outQ = rows.reduce((s, r) => s + r.outQty, 0)
      insights.push(`${r3(inQ).toLocaleString('en-IN')} ${single.uom} came in and ${r3(outQ).toLocaleString('en-IN')} ${single.uom} went out, over ${rows.length} movements.`)
    } else if (rows.length) {
      insights.push(`${rows.length} movements across ${items} items: ${rupees(valueIn)} in and ${rupees(valueOut)} out.`)
    }
    if (negative.length) insights.push(`The balance went below nought ${negative.length} times — an issue was posted before its receipt.`)

    return {
      rows,
      totalRows: totalRows > rows.length ? totalRows : undefined,
      analysis: {
        headline: rows.length
          ? `${rows.length} stock movements, ${periodLabel(params).toLowerCase()}.`
          : 'No stock moved for these filters.',
        kpis: [
          { label: 'Movements', value: rows.length || null, format: 'integer', basis: `across ${items} items` },
          { label: 'Value in', value: rows.length ? valueIn : null, format: 'money', basis: 'receipts and transfers in' },
          { label: 'Value out', value: rows.length ? valueOut : null, format: 'money', basis: 'issues and transfers out' },
        ],
        exceptions: negative.length
          ? [{ label: 'Balance below nought', value: negative.length, format: 'integer', basis: 'movements posted out of order', tone: 'warn' }]
          : [],
        panels: (
          [
            {
              title: 'Value moved, by kind',
              question: 'comparison',
              format: 'money',
              points: [...valueByBucket].map(([b, v]) => ({ label: BUCKET_LABEL[b], value: round2(v), tone: BUCKET_TONE[b] })),
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'The balance runs per item, per store and per owner. With several stores in the list, read it store by store.',
          'A cancelled document is not removed: it is reversed by a second line marked "(cancelled)", so both are shown.',
          from ? 'The balance starts from the stock held before the period.' : 'No start date, so the balance starts from nought.',
          'Quantities are in each item’s own unit.',
        ],
      },
    }
  },
}
