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

/*
 * The five states an order can be in — `PurchaseOrderStatus` in the schema,
 * and they must stay level with it. A word map with a key nothing uses is
 * silent, and a missing key falls through to the raw value.
 */
const STATUS_WORDS: Record<string, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  PARTIALLY_RECEIVED: 'Part received',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
}

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  SENT: 'info',
  PARTIALLY_RECEIVED: 'warn',
  COMPLETED: 'good',
  CANCELLED: 'neutral',
}

/** Orders that can still bring goods in. */
const OPEN = new Set(['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'])

const SHOW_WORDS: Record<string, string> = {
  DUE: 'Still due only',
}

const DAY = 86_400_000

/** How late the goods still owed are, for the ageing chart. */
const LATE_BANDS = [
  { label: 'Not due yet', max: 0 },
  { label: '1-7 days late', max: 7 },
  { label: '8-15 days late', max: 15 },
  { label: '16-30 days late', max: 30 },
  { label: 'Over 30 days late', max: Infinity },
]

/**
 * Every order, item by item: ordered, received, still due and billed.
 *
 * One report where there were two — an order-by-order status and a list of
 * items still to arrive. They read the same orders; the second was the first
 * with the delivered lines taken out. One row per order line answers both:
 * "Show: still due only" is the chase list, and the pivot folds the lines back
 * into orders for the overview.
 *
 * Values are at the order rate net of line discount, before GST — what the
 * order is worth on paper, and so what the goods still owed are worth.
 */
export const purchaseOrderStatus: ReportDefinition = {
  id: 'purchase-order-status',
  module: 'purchase',
  title: 'Purchase Order Status',
  description:
    'Every order raised in the period, item by item — ordered, received, still due, billed and how late it is. "Still due only" gives the list to chase.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    itemFilter,
    {
      key: 'status',
      label: 'Order Status',
      type: 'select',
      options: Object.entries(STATUS_WORDS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'show',
      label: 'Show',
      type: 'select',
      options: Object.entries(SHOW_WORDS).map(([value, label]) => ({ value, label })),
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
    { key: 'billedQty', label: 'Billed', type: 'qty', total: 'sum' },
    { key: 'rate', label: 'Rate', type: 'money', total: 'none' },
    { key: 'lineValue', label: 'Order Value', type: 'money', total: 'sum' },
    { key: 'pendingValue', label: 'Value Still Due', type: 'money', total: 'sum' },
    {
      key: 'status',
      label: 'Order Status',
      type: 'badge',
      badges: STATUS_WORDS,
      badgeTones: STATUS_TONE,
      width: 14,
    },
    { key: 'daysLate', label: 'Days Late', type: 'integer', width: 11 },
  ],

  summary: {
    title: 'Biggest value still to arrive',
    columns: ['poNumber', 'supplier', 'item', 'pendingQty', 'pendingValue', 'deliveryDate', 'daysLate'],
    by: 'pendingValue',
    limit: 12,
  },

  /**
   * By supplier, then order — fold the item lines back into orders. The
   * value columns add across items; the quantity columns only make sense
   * within one item, hence the UOM slicer.
   */
  pivot: {
    rows: ['supplier', 'poNumber'],
    values: ['lineValue', 'pendingValue', 'orderedQty', 'receivedQty', 'pendingQty'],
    slicers: ['status', 'uom'],
    note: 'Open a supplier to see its orders. Pick a UOM before reading a quantity total.',
  },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const contains = (v: string) => ({ contains: v, mode: 'insensitive' as const })
    const dueOnly = params.show === 'DUE'
    const wanted =
      params.status && params.status in STATUS_WORDS
        ? [params.status]
        : dueOnly
          ? [...OPEN]
          : Object.keys(STATUS_WORDS)

    const where: Prisma.PurchaseOrderLineWhereInput = {
      ...(params.itemId ? { itemId: params.itemId } : {}),
      po: {
        deletedAt: null,
        // Goods orders: a service order is billed, not received.
        isService: false,
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
        shortClosed: true,
        item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
        po: {
          select: {
            poNumber: true,
            poDate: true,
            deliveryDate: true,
            reference: true,
            status: true,
            supplier: { select: { name: true } },
          },
        },
        grnLines: {
          select: {
            receivedQty: true,
            grn: { select: { status: true } },
            // What the supplier has billed against what arrived on this line.
            billLines: {
              where: { bill: { status: { not: 'CANCELLED' } } },
              select: { qty: true },
            },
          },
        },
      },
    })

    const today = new Date()
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())

    const all = lines.map((l) => {
      const arrived = l.grnLines.filter((g) => g.grn.status !== 'CANCELLED')
      const orderedQty = Number(l.qty)
      const receivedQty = round2(arrived.reduce((n, g) => n + Number(g.receivedQty), 0))
      const billedQty = round2(
        arrived.reduce((n, g) => n + g.billLines.reduce((m, b) => m + Number(b.qty), 0), 0)
      )
      // Nothing more is coming on a cancelled order or a line closed short.
      const stillComing = OPEN.has(l.po.status) && !l.shortClosed
      const pendingQty = stillComing ? round2(Math.max(0, orderedQty - receivedQty)) : 0
      const rate = round2(Number(l.unitRate) * (1 - Number(l.discount) / 100))
      const wantedBy = l.po.deliveryDate
      const dueDay = wantedBy
        ? new Date(wantedBy.getFullYear(), wantedBy.getMonth(), wantedBy.getDate())
        : null
      return {
        poDate: l.po.poDate,
        poNumber: l.po.poNumber,
        supplier: l.po.supplier?.name ?? '',
        reference: l.po.reference ?? '',
        deliveryDate: wantedBy,
        itemCode: l.item.code,
        item: l.item.name,
        uom: l.item.uom?.symbol ?? '',
        orderedQty,
        receivedQty,
        pendingQty,
        billedQty,
        rate,
        lineValue: round2(orderedQty * rate),
        pendingValue: round2(pendingQty * rate),
        status: l.po.status,
        daysLate:
          pendingQty > 0 && dueDay
            ? Math.max(0, Math.floor((startOfToday.getTime() - dueDay.getTime()) / DAY))
            : 0,
      }
    })

    const rows = dueOnly ? all.filter((r) => r.pendingQty > 0) : all

    const live = rows.filter((r) => r.status !== 'CANCELLED')
    const due = rows.filter((r) => r.pendingQty > 0)
    const orders = new Set(live.map((r) => r.poNumber)).size
    const ordersDue = new Set(due.map((r) => r.poNumber)).size
    const orderedValue = round2(live.reduce((s, r) => s + r.lineValue, 0))
    const dueValue = round2(due.reduce((s, r) => s + r.pendingValue, 0))
    const late = due.filter((r) => r.daysLate > 0)
    const lateValue = round2(late.reduce((s, r) => s + r.pendingValue, 0))
    const drafts = due.filter((r) => r.status === 'DRAFT')
    const noDate = due.filter((r) => r.deliveryDate == null).length

    const bySupplier = new Map<string, number>()
    for (const r of due) bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.pendingValue)

    const dated = due.filter((r) => r.deliveryDate != null)
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
    if (due.length) {
      insights.push(
        `₹${dueValue.toLocaleString('en-IN')} of goods is still to come on ${ordersDue} order${ordersDue === 1 ? '' : 's'}.`
      )
      const worst = [...late].sort((a, b) => b.daysLate - a.daysLate)[0]
      if (worst) {
        insights.push(
          `The latest is ${worst.poNumber} from ${worst.supplier}: ${worst.pendingQty.toLocaleString('en-IN')} ${worst.uom} of ${worst.item}, ${worst.daysLate} days past the wanted date.`
        )
      }
    } else if (live.length) {
      insights.push('Everything ordered in this period has arrived.')
    }
    if (drafts.length) {
      insights.push(
        `${drafts.length} line${drafts.length === 1 ? ' is' : 's are'} on draft orders not yet sent — the supplier does not know about ${drafts.length === 1 ? 'it' : 'them'}.`
      )
    }

    return {
      rows,
      // The cap counts order lines fetched; with "still due only" the fully
      // received ones are dropped after, which the Notes sheet says.
      totalRows: found > rowCap ? found : undefined,
      analysis: {
        headline:
          rows.length === 0
            ? dueOnly
              ? 'Nothing is still due on an open order.'
              : 'No orders were raised in this period.'
            : dueOnly
              ? `${due.length} item line${due.length === 1 ? '' : 's'} still due on ${ordersDue} order${ordersDue === 1 ? '' : 's'}, worth ₹${dueValue.toLocaleString('en-IN')}.`
              : `${orders} order${orders === 1 ? '' : 's'} worth ₹${orderedValue.toLocaleString('en-IN')}; ₹${dueValue.toLocaleString('en-IN')} of it still to arrive.`,
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
            label: 'Orders',
            value: live.length ? orders : null,
            format: 'integer',
            basis: `${live.length} item lines`,
          },
          {
            label: 'Value ordered',
            value: live.length ? orderedValue : null,
            format: 'money',
            basis: 'at the order rate, before tax',
          },
          {
            label: 'Value still due',
            value: rows.length ? dueValue : null,
            format: 'money',
            basis: `on ${ordersDue} order${ordersDue === 1 ? '' : 's'}`,
          },
          {
            label: 'Late lines',
            value: rows.length ? late.length : null,
            format: 'integer',
            basis: `worth ₹${lateValue.toLocaleString('en-IN')}`,
            tone: late.length ? 'bad' : 'good',
          },
        ],
        panels: (
          [
            {
              title: 'How late the goods still due are',
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
              title: 'Orders by stage',
              question: 'composition',
              format: 'integer',
              points: Object.keys(STATUS_WORDS).map((s) => ({
                label: STATUS_WORDS[s],
                value: new Set(rows.filter((r) => r.status === s).map((r) => r.poNumber)).size,
                tone: STATUS_TONE[s],
              })),
              note: 'Counted in orders, not lines.',
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Values are at the order rate net of line discount, before GST and charges.',
          'Still due is nothing on a cancelled order or a line closed short; a line that arrived in full or more is not due.',
          'Received and billed leave out cancelled receipts and cancelled bills. Orders in the recycle bin are not listed.',
          'Quantities are in each item’s own unit. The value columns add across items; the quantity columns do not.',
        ],
      },
    }
  },
}
