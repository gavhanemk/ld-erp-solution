import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition, Tone } from '../types'
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
   * By order date, with suppliers nested inside it.
   *
   * The date outermost is what makes the sheet collapsible: shut the days and
   * it is a daily total, open one and it is who was ordered from that day.
   * Supplier alone gave a flat list that answered only one question.
   *
   * Quantity leads the measures even though it adds metres to pieces to
   * kilograms across items. On one supplier on one day it is a real figure
   * and the one a buyer asks for first; the note says what it is not, and the
   * Data sheet carries the unit per line.
   */
  pivot: {
    rows: ['poDate', 'supplier'],
    values: ['orderedQty', 'orderValue', 'billedValue'],
    slicers: ['status'],
    note: 'Quantity adds across items of different units — read it per supplier, not as a sheet total.',
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

    // Colour says what each bar means, not how long it is: what was asked
    // for, what has arrived, and what is still somebody's job.
    const funnel = (
      [
        {
          label: 'Ordered',
          value: round2(live.reduce((s, r) => s + r.orderedQty, 0)),
          tone: 'info' as const,
        },
        {
          label: 'Received',
          value: round2(live.reduce((s, r) => s + r.receivedQty, 0)),
          tone: 'good' as const,
        },
        {
          label: 'Still due',
          value: round2(live.reduce((s, r) => s + r.pendingQty, 0)),
          tone: 'warn' as const,
        },
      ]
    ).filter((p) => p.value > 0)

    /** A stage is a state, and every state here has a settled colour. */
    const STATUS_TONE: Record<string, Tone> = {
      DRAFT: 'neutral',
      SENT: 'info',
      PARTIALLY_RECEIVED: 'warn',
      RECEIVED: 'good',
      CANCELLED: 'neutral',
      CLOSED: 'good',
    }

    const byStatus = Object.keys(STATUS_WORDS)
      .map((s) => ({
        label: STATUS_WORDS[s],
        value: rows.filter((r) => r.status === s).length,
        tone: STATUS_TONE[s],
      }))
      .filter((p) => p.value > 0)

    const bySupplier = new Map<string, number>()
    for (const r of live)
      bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.orderValue)

    /* Six, because a stacked bar needs height to divide legibly. */
    const topSuppliers = [...bySupplier.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name]) => name)

    const supplierSum = (supplier: string, pick: (r: (typeof live)[number]) => number) =>
      round2(live.filter((r) => r.supplier === supplier).reduce((s, r) => s + pick(r), 0))

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
            {
              title: 'How few suppliers the order book rests on',
              question: 'pareto',
              format: 'money',
              points: topWithRest(
                [...bySupplier].map(([label, value]) => ({ label, value: round2(value) })),
                9
              ),
              note: 'The line is the share reached by that supplier and every bigger one, so it ends at 100%.',
            },
            {
              /*
               * How long the open orders have been open.
               *
               * The stage chart says how many are open. This says how long
               * they have been — which is the difference between a busy
               * fortnight and an order everybody has forgotten about.
               */
              title: 'How long the open orders have waited',
              question: 'ageing',
              format: 'integer',
              points: (
                [
                  { label: 'Within a week', max: 7 },
                  { label: '8-15 days', max: 15 },
                  { label: '16-30 days', max: 30 },
                  { label: '31-60 days', max: 60 },
                  { label: 'Over 60 days', max: Infinity },
                ] as const
              )
                .map((band, i, all) => {
                  const floor = i === 0 ? 1 : all[i - 1].max + 1
                  return {
                    label: band.label,
                    value: openOrders.filter(
                      (r) => r.daysOpen >= floor && r.daysOpen <= band.max
                    ).length,
                    // Only the oldest band is an exception. Everything else
                    // is an order in progress, and colouring those red would
                    // make the one that matters invisible.
                    exception: band.max === Infinity,
                  }
                })
                .filter((p) => p.value > 0),
              note: 'Counted from the order date, for orders not yet fully received.',
            },
            {
              title: 'Received against still due, by supplier',
              question: 'split',
              format: 'qty',
              points: topSuppliers.map((s) => ({
                label: s,
                value: supplierSum(s, (r) => r.orderedQty),
              })),
              series: [
                {
                  name: 'Received',
                  values: topSuppliers.map((s) => supplierSum(s, (r) => r.receivedQty)),
                  tone: 'good',
                },
                {
                  name: 'Still due',
                  values: topSuppliers.map((s) => supplierSum(s, (r) => r.pendingQty)),
                  tone: 'warn',
                },
              ],
              note: 'The six biggest suppliers by value ordered. Units are mixed across items.',
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
