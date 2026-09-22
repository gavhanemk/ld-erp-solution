import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import {
  dateRangeFilters,
  dayRange,
  itemFilter,
  ratio,
  round2,
  searchFilter,
  supplierFilter,
  topWithRest,
} from './shared'

const STATUS_WORDS: Record<string, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  PARTIALLY_RECEIVED: 'Part received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
  CLOSED: 'Closed',
}

/**
 * Ordered against received against billed, one row per order.
 *
 * The three-way match as a report rather than as a guard: the guard refuses a
 * bill that runs ahead of its receipts, and this is where somebody sees how
 * far behind the goods are before anybody tries to bill them.
 */
export const purchaseOrderStatus: ReportDefinition = {
  id: 'purchase-order-status',
  module: 'purchase',
  title: 'Purchase Order Status',
  description:
    'Every order raised in the period, with how much has arrived against it and how much has been billed.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    itemFilter,
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: Object.entries(STATUS_WORDS).map(([value, label]) => ({ value, label })),
    },
    searchFilter,
  ],
  columns: [
    { key: 'poDate', label: 'Order Date', type: 'date', width: 14 },
    { key: 'poNumber', label: 'Order No.', type: 'text', width: 14 },
    { key: 'supplier', label: 'Supplier', type: 'text', width: 30 },
    { key: 'reference', label: 'Reference', type: 'text', width: 18 },
    { key: 'deliveryDate', label: 'Wanted By', type: 'date', width: 14 },
    { key: 'lines', label: 'Lines', type: 'integer', width: 8 },
    { key: 'orderedQty', label: 'Ordered', type: 'qty', total: 'sum' },
    { key: 'receivedQty', label: 'Received', type: 'qty', total: 'sum' },
    { key: 'pendingQty', label: 'Still Due', type: 'qty', total: 'sum' },
    { key: 'orderValue', label: 'Order Value', type: 'money', total: 'sum' },
    { key: 'billedValue', label: 'Billed', type: 'money', total: 'sum' },
    { key: 'status', label: 'Status', type: 'badge', badges: STATUS_WORDS, width: 15 },
    { key: 'daysOpen', label: 'Days Open', type: 'integer', width: 11 },
  ],

  /**
   * By supplier, because a late order is chased with a supplier.
   *
   * Money only. The quantity columns add metres to pieces to kilograms, and
   * while the Data sheet totals them the same way, a pivot invites the reader
   * to trust a subtotal it puts in front of them — so this one does not offer
   * a figure that cannot be trusted.
   */
  pivot: {
    rows: 'supplier',
    values: ['orderValue', 'billedValue'],
    slicers: ['status'],
    note: 'Ordered against billed, by supplier. Use the Status buttons to see only what is still open.',
  },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const where: Prisma.PurchaseOrderWhereInput = {
      deletedAt: null,
      ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      ...(params.status
        ? { status: params.status as Prisma.EnumPurchaseOrderStatusFilter['equals'] }
        : {}),
      ...(range ? { poDate: range } : {}),
      // The same two clauses the Purchase Orders list runs, so the Export
      // button on that screen reports on exactly the rows it is showing.
      ...(params.itemId ? { lines: { some: { itemId: params.itemId } } } : {}),
      ...(params.q
        ? {
            OR: [
              { poNumber: { contains: params.q, mode: 'insensitive' as const } },
              { supplier: { name: { contains: params.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    }

    const totalRows = await tx.purchaseOrder.count({ where })
    const orders = await tx.purchaseOrder.findMany({
      where,
      take: rowCap,
      orderBy: [{ poDate: 'asc' }, { poNumber: 'asc' }],
      select: {
        poNumber: true,
        poDate: true,
        deliveryDate: true,
        reference: true,
        status: true,
        totalAmount: true,
        supplier: { select: { name: true } },
        lines: {
          select: {
            qty: true,
            shortClosed: true,
            grnLines: { select: { acceptedQty: true, grn: { select: { status: true } } } },
          },
        },
        invoices: { select: { totalAmount: true, status: true } },
      },
    })

    const today = new Date()
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())

    const rows = orders.map((o) => {
      const orderedQty = o.lines.reduce((s, l) => s + Number(l.qty), 0)
      // Cancelled receipts booked nothing in, so they count toward nothing.
      const receivedQty = o.lines.reduce(
        (s, l) =>
          s +
          l.grnLines
            .filter((g) => g.grn.status !== 'CANCELLED')
            .reduce((n, g) => n + Number(g.acceptedQty), 0),
        0
      )
      // A short-closed line is settled, not pending. Counting its balance as
      // still due keeps an order open for ever on goods nobody expects.
      const pendingQty = o.lines.reduce((s, l) => {
        if (l.shortClosed) return s
        const got = l.grnLines
          .filter((g) => g.grn.status !== 'CANCELLED')
          .reduce((n, g) => n + Number(g.acceptedQty), 0)
        return s + Math.max(0, Number(l.qty) - got)
      }, 0)

      const billedValue = o.invoices
        .filter((i) => i.status !== 'CANCELLED')
        .reduce((s, i) => s + Number(i.totalAmount), 0)

      const poDay = new Date(o.poDate.getFullYear(), o.poDate.getMonth(), o.poDate.getDate())
      const open = o.status === 'SENT' || o.status === 'PARTIALLY_RECEIVED'

      return {
        poDate: o.poDate,
        poNumber: o.poNumber,
        supplier: o.supplier?.name ?? '',
        reference: o.reference ?? '',
        deliveryDate: o.deliveryDate,
        lines: o.lines.length,
        orderedQty: round2(orderedQty),
        receivedQty: round2(receivedQty),
        pendingQty: round2(pendingQty),
        orderValue: Number(o.totalAmount),
        billedValue: round2(billedValue),
        status: o.status,
        daysOpen: open ? Math.floor((startOfToday.getTime() - poDay.getTime()) / 86_400_000) : 0,
      }
    })

    const live = rows.filter((r) => r.status !== 'CANCELLED')
    const cancelled = rows.length - live.length
    const ordered = round2(live.reduce((s, r) => s + r.orderValue, 0))
    const billed = round2(live.reduce((s, r) => s + r.billedValue, 0))
    const stillDue = live.filter((r) => r.pendingQty > 0)
    const openOrders = live.filter((r) => r.daysOpen > 0)
    const late = live.filter(
      (r) => r.deliveryDate != null && r.deliveryDate < startOfToday && r.pendingQty > 0
    )

    const funnel = [
      { label: 'Ordered', value: round2(live.reduce((s, r) => s + r.orderedQty, 0)) },
      { label: 'Received', value: round2(live.reduce((s, r) => s + r.receivedQty, 0)) },
      { label: 'Still due', value: round2(live.reduce((s, r) => s + r.pendingQty, 0)) },
    ].filter((p) => p.value > 0)

    const byStatus = Object.keys(STATUS_WORDS)
      .map((s) => ({ label: STATUS_WORDS[s], value: rows.filter((r) => r.status === s).length }))
      .filter((p) => p.value > 0)

    const bySupplier = new Map<string, number>()
    for (const r of live)
      bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.orderValue)

    const insights: string[] = []
    if (late.length) {
      insights.push(
        `${late.length} ${late.length === 1 ? 'order is' : 'orders are'} past the date they were wanted by and still have goods outstanding.`
      )
    }
    if (openOrders.length) {
      const oldest = openOrders.reduce((m, r) => (r.daysOpen > m.daysOpen ? r : m))
      insights.push(
        `${openOrders.length} orders are still open, the oldest ${oldest.poNumber} at ${oldest.daysOpen} days.`
      )
    }
    if (ordered > 0) {
      insights.push(
        `₹${billed.toLocaleString('en-IN')} of ₹${ordered.toLocaleString('en-IN')} ordered has been billed — ${Math.round((billed / ordered) * 100)}%.`
      )
    }

    return {
      rows,
      totalRows,
      analysis: {
        headline:
          live.length === 0
            ? 'No orders were raised in this period.'
            : `${live.length} orders worth ₹${ordered.toLocaleString('en-IN')}, ${stillDue.length} still waiting on goods.`,
        kpis: [
          {
            label: 'Orders raised',
            value: live.length || null,
            format: 'integer',
            basis: `worth ₹${ordered.toLocaleString('en-IN')}`,
          },
          {
            label: 'Waiting on goods',
            value: live.length ? stillDue.length : null,
            format: 'integer',
            basis: `of ${live.length} orders`,
            tone: stillDue.length > 0 ? 'warn' : 'good',
          },
          {
            label: 'Past the wanted date',
            value: live.length ? late.length : null,
            format: 'integer',
            basis: late.length
              ? 'orders overdue with goods outstanding'
              : 'nothing overdue with goods outstanding',
            tone: late.length > 0 ? 'bad' : 'good',
          },
          {
            label: 'Billed against ordered',
            value: ratio(billed, ordered),
            format: 'percent',
            basis:
              ordered > 0
                ? `₹${billed.toLocaleString('en-IN')} of ₹${ordered.toLocaleString('en-IN')}`
                : 'nothing ordered to measure against',
          },
        ],
        panels: (
          [
            {
              title: 'Ordered, received, still due',
              question: 'funnel',
              format: 'qty',
              points: funnel,
              note: 'Quantities across every item, so units are mixed. Comparable as a shape, not as a figure.',
            },
            {
              title: 'Orders by stage',
              question: 'comparison',
              format: 'integer',
              points: byStatus,
            },
            {
              title: 'Biggest suppliers by value ordered',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                [...bySupplier].map(([label, value]) => ({ label, value: round2(value) })),
                8
              ),
            },
          ] as Panel[]
        ).filter((p) => p.points.length > 0),
        insights,
        caveats: [
          cancelled > 0
            ? `${cancelled} cancelled ${cancelled === 1 ? 'order is' : 'orders are'} on the Data sheet and counted nowhere here.`
            : 'No cancelled orders fell in this period.',
          'A line closed short is treated as settled, so its unreceived balance is not counted as still due.',
          'Quantities add across items in different units. Use them per filtered item, not as a sheet total.',
          'Billed value is the whole bill, which can cover deliveries against more than one order.',
        ],
      },
    }
  },
}
