import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import { categoryFilter, loadCategories, ownershipFilter, ownershipsOf, warehouseFilter } from './inventory-shared'

const r3 = (n: number) => Math.round(n * 1000) / 1000
const DAY = 24 * 60 * 60 * 1000

const PACK: Record<string, string> = { ROLL: 'Roll', BOX: 'Box', CARTON: 'Carton', BAG: 'Bag', BUNDLE: 'Bundle', PACKET: 'Packet', OTHER: 'Other' }

/**
 * Every stickered package still on the racks, with what was packed, what has
 * gone out of it and what is left: the same sticker all its life, 50, then
 * 40, then 35.
 *
 * Oldest first within each item and store, which is the order FIFO issues
 * them in, so the list is also the store's picking order.
 */
export const packetBalances: ReportDefinition = {
  id: 'packet-balances',
  module: 'inventory',
  title: 'Packet Balances',
  description:
    'Every stickered roll, box and packet still in stock — packed, issued and left on each — oldest first, the order first-in-first-out takes them.',
  filters: [warehouseFilter, categoryFilter, ownershipFilter],
  columns: [
    { key: 'sticker', label: 'Sticker', type: 'text', width: 14 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'category', label: 'Category', type: 'text', width: 18 },
    { key: 'store', label: 'Store', type: 'text', width: 18 },
    { key: 'rack', label: 'Rack', type: 'text', width: 10 },
    { key: 'pack', label: 'Package', type: 'text', width: 10 },
    { key: 'receivedOn', label: 'Received On', type: 'date', width: 14 },
    { key: 'from', label: 'Came In On', type: 'text', width: 18 },
    { key: 'lot', label: 'Lot', type: 'text', width: 12 },
    { key: 'packed', label: 'Packed', type: 'qty', total: 'none' },
    { key: 'issued', label: 'Gone Out', type: 'qty', total: 'none' },
    { key: 'balance', label: 'Left', type: 'qty', total: 'none' },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'days', label: 'Days In Store', type: 'integer', total: 'none' },
    { key: 'state', label: 'State', type: 'badge', width: 12,
      badges: { FULL: 'Unopened', OPEN: 'Opened', HELD: 'On hold' },
      badgeTones: { FULL: 'good', OPEN: 'warn', HELD: 'bad' } },
  ],
  summary: {
    title: 'Longest on the racks',
    columns: ['sticker', 'item', 'store', 'rack', 'balance', 'days'],
    by: 'days',
    limit: 12,
  },

  async run({ tx, params, rowCap }) {
    const cats = await loadCategories(tx)
    const catIds = cats.under(params.categoryId)
    const where: Prisma.StockPackageWhereInput = {
      status: 'IN_STOCK',
      ownership: { in: ownershipsOf(params) },
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(catIds ? { item: { categoryId: { in: catIds } } } : {}),
    }
    const packages = await tx.stockPackage.findMany({
      where,
      take: rowCap,
      orderBy: [{ item: { name: 'asc' } }, { warehouse: { name: 'asc' } }, { createdAt: 'asc' }, { code: 'asc' }],
      select: {
        code: true,
        packType: true,
        initialQty: true,
        qty: true,
        rack: true,
        lotNo: true,
        grade: true,
        sourceRef: true,
        createdAt: true,
        item: { select: { code: true, name: true, categoryId: true, uom: { select: { symbol: true } } } },
        warehouse: { select: { name: true } },
      },
    })

    const now = Date.now()
    const rows = packages.map((p) => {
      const packed = r3(Number(p.initialQty))
      const balance = r3(Number(p.qty))
      return {
        sticker: p.code,
        itemCode: p.item.code,
        item: p.item.name,
        category: cats.names(p.item.categoryId).category,
        store: p.warehouse.name,
        rack: p.rack ?? '',
        pack: PACK[p.packType] ?? p.packType,
        receivedOn: p.createdAt,
        from: p.sourceRef ?? '',
        lot: p.lotNo ?? '',
        packed,
        issued: r3(Math.max(0, packed - balance)),
        balance,
        uom: p.item.uom?.symbol ?? '',
        days: Math.max(0, Math.floor((now - p.createdAt.getTime()) / DAY)),
        state: p.grade === 'R' ? 'HELD' : balance < packed - 0.0005 ? 'OPEN' : 'FULL',
      }
    })

    const opened = rows.filter((r) => r.state === 'OPEN').length
    const held = rows.filter((r) => r.state === 'HELD').length
    const old = rows.filter((r) => r.days > 90).length
    const items = new Set(rows.map((r) => r.itemCode)).size
    const oldest = rows.reduce((m, r) => Math.max(m, r.days), 0)

    const byStore = new Map<string, number>()
    for (const r of rows) byStore.set(r.store, (byStore.get(r.store) ?? 0) + 1)
    const bands = [
      { label: 'Up to 30 days', value: rows.filter((r) => r.days <= 30).length, tone: 'good' as const },
      { label: '31 to 90 days', value: rows.filter((r) => r.days > 30 && r.days <= 90).length },
      { label: '91 to 180 days', value: rows.filter((r) => r.days > 90 && r.days <= 180).length, tone: 'warn' as const },
      { label: 'Over 180 days', value: rows.filter((r) => r.days > 180).length, tone: 'bad' as const },
    ]

    const insights: string[] = []
    if (rows.length) insights.push(`${rows.length} packages of ${items} items are on the racks.`)
    if (opened) insights.push(`${opened} ${opened === 1 ? 'is' : 'are'} opened: part has gone out and the rest is still on the same sticker.`)
    if (old) insights.push(`${old} ${old === 1 ? 'has' : 'have'} been in store for more than 90 days. First in, first out takes ${old === 1 ? 'it' : 'them'} before anything newer of the same item.`)
    if (held) insights.push(`${held} ${held === 1 ? 'is' : 'are'} on hold (rejected at receipt) and cannot be issued until released.`)

    return {
      rows,
      analysis: {
        headline: rows.length
          ? `${rows.length} packages on the racks; the oldest has been in store for ${oldest} ${oldest === 1 ? 'day' : 'days'}.`
          : 'No stickered packages are in stock for these filters.',
        kpis: [
          { label: 'Packages in stock', value: rows.length, format: 'integer', basis: `of ${items} items` },
          { label: 'Opened', value: rows.length ? opened : null, format: 'integer', basis: 'part gone out, rest on the same sticker' },
          { label: 'Over 90 days', value: rows.length ? old : null, format: 'integer', basis: 'in store since they came in', tone: old ? 'warn' : undefined },
          { label: 'On hold', value: rows.length ? held : null, format: 'integer', basis: 'rejected at receipt', tone: held ? 'bad' : undefined },
        ],
        panels: (
          [
            { title: 'Packages by store', question: 'comparison', format: 'integer', points: [...byStore].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value) },
            { title: 'How long they have been in store', question: 'composition', format: 'integer', points: bands },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Received On is the day the sticker was made. For stock labelled after it came in, that is the day it was labelled.',
          'Quantities are in each item’s own unit, so they are not added up across items.',
          'Within each item and store the list is oldest first: the order first-in-first-out issues them.',
        ],
      },
    }
  },
}
