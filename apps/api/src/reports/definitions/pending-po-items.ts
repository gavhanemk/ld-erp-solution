import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition, Tone } from '../types'
import {
  dateRangeFilters,
  dayRange,
  itemFilter,
  round2,
  searchFilter,
  supplierFilter,
  topWithRest,
} from './shared'

/** The orders that can still have goods coming. */
const OPEN_WORDS: Record<string, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  PARTIALLY_RECEIVED: 'Part received',
}

const OPEN_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  SENT: 'info',
  PARTIALLY_RECEIVED: 'warn',
}

const DAY = 86_400_000

/** How late the pending goods are, measured from the wanted-by date. */
const LATE_BANDS = [
  { label: 'Not due yet', max: 0 },
  { label: '1-7 days late', max: 7 },
  { label: '8-15 days late', max: 15 },
  { label: '16-30 days late', max: 30 },
  { label: 'Over 30 days late', max: Infinity },
]

/**
 * Every order line with goods still to come.
 *
 * One row per order line rather than per order. Purchase Order Status adds an
 * order's quantities into one figure, which is right for "how far along is
 * this order" and wrong for "what is the supplier still to send" — 1,000
 * rolls and 250 pieces are not 1,250 of anything. Here each item keeps its
 * own unit, and the pending value is in rupees so it can be added up.
 *
 * Lines closed short are settled, not pending, and are left out.
 */
export const pendingPoItems: ReportDefinition = {
  id: 'pending-po-items',
  module: 'purchase',
  title: 'Pending Purchase Order Items',
  description:
    'Every item still to be delivered on an open purchase order — ordered, received, still due, its value and how late it is.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    itemFilter,
    {
      key: 'status',
      label: 'Order Status',
      type: 'select',
      options: Object.entries(OPEN_WORDS).map(([value, label]) => ({ value, label })),
    },
    { ...searchFilter, help: 'Order number, reference or supplier name' },
  ],
  columns: [
    { key: 'poDate', label: 'Order Date', type: 'date', width: 13 },
    { key: 'poNumber', label: 'Order No.', type: 'text', width: 14 },
    { key: 'supplier', label: 'Supplier', type: 'text', width: 28 },
    { key: 'reference', label: 'Reference', type: 'text', width: 16 },
    { key: 'deliveryDate', label: 'Wanted By', type: 'date', width: 13 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'orderedQty', label: 'Ordered', type: 'qty', total: 'sum' },
    { key: 'receivedQty', label: 'Received', type: 'qty', total: 'sum' },
    { key: 'pendingQty', label: 'Still Due', type: 'qty', total: 'sum' },
    { key: 'rate', label: 'Rate', type: 'money', total: 'none' },
    { key: 'pendingValue', label: 'Value Still Due', type: 'money', total: 'sum' },
    { key: 'store', label: 'Deliver To', type: 'text', width: 20 },
    {
      key: 'status',
      label: 'Order Status',
      type: 'badge',
      badges: OPEN_WORDS,
      badgeTones: OPEN_TONE,
      width: 14,
    },
    { key: 'daysLate', label: 'Days Late', type: 'integer', width: 11 },
  ],

  summary: {
    title: 'Biggest value still to arrive',
    columns: [
      'poNumber',
      'supplier',
      'item',
      'pendingQty',
      'pendingValue',
      'deliveryDate',
      'daysLate',
    ],
    by: 'pendingValue',
    limit: 12,
  },

  pivot: {
    rows: ['supplier', 'poNumber'],
    values: ['pendingValue', 'orderedQty', 'receivedQty', 'pendingQty'],
    slicers: ['status', 'uom'],
    note: 'Open a supplier to see which orders the goods are owed on. Pick a UOM before reading a quantity total.',
  },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const contains = (v: string) => ({ contains: v, mode: 'insensitive' as const })
    const wanted =
      params.status && params.status in OPEN_WORDS ? [params.status] : Object.keys(OPEN_WORDS)

    const where: Prisma.PurchaseOrderLineWhereInput = {
      shortClosed: false,
      ...(params.itemId ? { itemId: params.itemId } : {}),
      po: {
        deletedAt: null,
        status: { in: wanted as Prisma.EnumPurchaseOrderStatusFilter['in'] },
        ...(params.supplierId ? { supplierId: params.supplierId } : {}),
        ...(range ? { poDate: range } : {}),
        ...(params.q
          ? {
              OR: [
                { poNumber: contains(params.q) },
                { reference: contains(params.q) },
                { supplier: { name: contains(params.q) } },
              ],
            }
          : {}),
      },
    }

    const found = await tx.purchaseOrderLine.count({ where })
    const lines = await tx.purchaseOrderLine.findMany({
      where,
      take: rowCap,
      orderBy: [{ po: { poDate: 'asc' } }, { po: { poNumber: 'asc' } }, { sortOrder: 'asc' }],
      select: {
        qty: true,
        unitRate: true,
        discount: true,
        item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
        po: {
          select: {
            poNumber: true,
            poDate: true,
            deliveryDate: true,
            reference: true,
            status: true,
            supplier: { select: { name: true } },
            deliveryWarehouse: { select: { name: true } },
            deliveryCustomer: { select: { name: true } },
          },
        },
        grnLines: { select: { receivedQty: true, grn: { select: { status: true } } } },
      },
    })

    const today = new Date()
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())

    // Received is counted the way Purchase Order Status counts it: whole
    // deliveries, cancelled receipts excluded.
    const rows = lines
      .map((l) => {
        const orderedQty = Number(l.qty)
        const receivedQty = round2(
          l.grnLines
            .filter((g) => g.grn.status !== 'CANCELLED')
            .reduce((n, g) => n + Number(g.receivedQty), 0)
        )
        const pendingQty = round2(Math.max(0, orderedQty - receivedQty))
        const rate = round2(Number(l.unitRate) * (1 - Number(l.discount) / 100))
        const due = l.po.deliveryDate
        const dueDay = due ? new Date(due.getFullYear(), due.getMonth(), due.getDate()) : null
        return {
          poDate: l.po.poDate,
          poNumber: l.po.poNumber,
          supplier: l.po.supplier?.name ?? '',
          reference: l.po.reference ?? '',
          deliveryDate: due,
          itemCode: l.item.code,
          item: l.item.name,
          uom: l.item.uom?.symbol ?? '',
          orderedQty,
          receivedQty,
          pendingQty,
          rate,
          pendingValue: round2(pendingQty * rate),
          store: l.po.deliveryWarehouse?.name ?? l.po.deliveryCustomer?.name ?? '',
          status: l.po.status,
          daysLate: dueDay
            ? Math.max(0, Math.floor((startOfToday.getTime() - dueDay.getTime()) / DAY))
            : 0,
        }
      })
      .filter((r) => r.pendingQty > 0)

    const value = round2(rows.reduce((s, r) => s + r.pendingValue, 0))
    const late = rows.filter((r) => r.daysLate > 0)
    const lateValue = round2(late.reduce((s, r) => s + r.pendingValue, 0))
    const drafts = rows.filter((r) => r.status === 'DRAFT')
    const orders = new Set(rows.map((r) => r.poNumber)).size
    const noDate = rows.filter((r) => r.deliveryDate == null).length

    const bySupplier = new Map<string, number>()
    for (const r of rows)
      bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.pendingValue)
    const byItem = new Map<string, number>()
    for (const r of rows) byItem.set(r.item, (byItem.get(r.item) ?? 0) + r.pendingValue)

    const dated = rows.filter((r) => r.deliveryDate != null)
    const lateness = LATE_BANDS.map((band, i) => {
      const min = i === 0 ? -Infinity : LATE_BANDS[i - 1].max
      const v = round2(
        dated
          .filter((r) => r.daysLate > min && r.daysLate <= band.max)
          .reduce((s, r) => s + r.pendingValue, 0)
      )
      return { label: band.label, value: v, exception: band.max > 0 && v > 0 }
    })

    const insights: string[] = []
    if (rows.length) {
      insights.push(
        `₹${value.toLocaleString('en-IN')} of goods is still to come on ${orders} order${orders === 1 ? '' : 's'}, across ${byItem.size} item${byItem.size === 1 ? '' : 's'}.`
      )
      const worst = [...late].sort((a, b) => b.daysLate - a.daysLate)[0]
      if (worst) {
        insights.push(
          `The latest is ${worst.poNumber} from ${worst.supplier}: ${worst.pendingQty.toLocaleString('en-IN')} ${worst.uom} of ${worst.item}, ${worst.daysLate} days past the wanted date.`
        )
      }
    }
    if (drafts.length) {
      insights.push(
        `${drafts.length} line${drafts.length === 1 ? ' is' : 's are'} on draft orders not yet sent — the supplier does not know about ${drafts.length === 1 ? 'it' : 'them'}.`
      )
    }

    return {
      rows,
      // The cap counts order lines fetched, before the fully received ones are
      // dropped; the Notes sheet says so when it bites.
      totalRows: found > rowCap ? found : undefined,
      analysis: {
        headline:
          rows.length === 0
            ? 'Nothing is still due on an open order.'
            : `${rows.length} item line${rows.length === 1 ? '' : 's'} still due on ${orders} order${orders === 1 ? '' : 's'}, worth ₹${value.toLocaleString('en-IN')}.`,
        exceptions: [
          {
            label: 'Past the wanted date',
            value: lateValue || null,
            format: 'money',
            basis: `${late.length} line${late.length === 1 ? '' : 's'} — chase the supplier`,
            tone: 'bad',
          },
          {
            label: 'On orders not yet sent',
            value: drafts.length || null,
            format: 'integer',
            basis: 'lines on draft orders — send them or cancel them',
            tone: 'warn',
          },
        ],
        kpis: [
          {
            label: 'Lines still due',
            value: rows.length || null,
            format: 'integer',
            basis: `on ${orders} orders`,
          },
          {
            label: 'Value still due',
            value: rows.length ? value : null,
            format: 'money',
            basis: 'at the order rate, before tax',
          },
          {
            label: 'Late',
            value: rows.length ? late.length : null,
            format: 'integer',
            basis: `worth ₹${lateValue.toLocaleString('en-IN')}`,
            tone: late.length ? 'bad' : 'good',
          },
          {
            label: 'Most days late',
            value: late.length ? Math.max(...late.map((r) => r.daysLate)) : null,
            format: 'days',
            basis: 'past the wanted-by date',
          },
        ],
        panels: (
          [
            {
              title: 'How late the pending goods are',
              question: 'ageing',
              format: 'money',
              points: lateness,
              note: noDate
                ? `${noDate} line${noDate === 1 ? '' : 's'} with no wanted-by date are not in this chart.`
                : undefined,
            },
            {
              title: 'Who still owes us goods',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                [...bySupplier].map(([label, v]) => ({ label, value: round2(v) })),
                8
              ),
            },
            {
              title: 'Items still to arrive',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                [...byItem].map(([label, v]) => ({ label, value: round2(v) })),
                8
              ),
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Only draft, sent and part-received orders. Completed and cancelled orders, orders in the recycle bin, and lines closed short are left out.',
          'Values are at the order rate net of line discount, before GST and charges.',
          'A line that arrived in full is not listed, even if it arrived more than was ordered.',
          'Quantities are in each item’s own unit. The value column adds across items; the quantity columns do not.',
        ],
      },
    }
  },
}
