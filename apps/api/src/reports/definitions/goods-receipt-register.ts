import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition, Tone } from '../types'
import {
  byMonth,
  dateRangeFilters,
  dayRange,
  mean,
  round2,
  supplierFilter,
  searchFilter,
  itemFilter,
  topWithRest,
} from './shared'

/** Refused is the one state on a receipt that needs somebody to act. */
const STATUS_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  QC_PENDING: 'warn',
  ACCEPTED: 'good',
  REJECTED: 'bad',
  CANCELLED: 'neutral',
}

const STATUS_WORDS: Record<string, string> = {
  DRAFT: 'Draft',
  QC_PENDING: 'Waiting for checking',
  ACCEPTED: 'Received',
  REJECTED: 'Refused',
  CANCELLED: 'Cancelled',
}

/*
 * Whether the supplier's bill for a delivery has been booked — the same test
 * the Goods Receipt screen and the bill form use: what arrived against what
 * live bills have claimed. Cancelled bills claim nothing.
 */
const BILLING_WORDS: Record<string, string> = {
  NOT_BILLED: 'Not billed',
  PART_BILLED: 'Part billed',
  BILLED: 'Billed',
}

const BILLING_TONE: Record<string, Tone> = {
  NOT_BILLED: 'warn',
  PART_BILLED: 'info',
  BILLED: 'good',
}

const DAY = 86_400_000

/**
 * What actually arrived, one row per item on each receipt — and whether the
 * supplier's bill for it has been booked.
 *
 * Per line rather than per receipt, because a receipt's whole substance is
 * what turned up and how much of it went back, and because a receipt can be
 * part billed. This was two reports — this register and "GRN Against Bill" —
 * reading the same receipt lines; the billing columns and the Billing filter
 * are that second report, here.
 *
 * The value not billed is at the receipt's own rate, before tax: what the
 * goods are in stock at, and so what the books carry with no bill behind it.
 */
export const goodsReceiptRegister: ReportDefinition = {
  id: 'goods-receipt-register',
  module: 'purchase',
  title: 'Goods Receipt Register',
  description:
    'Every item booked in at the gate — ordered, received, refused and into stock — and how much of it the supplier has billed.',
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
    {
      key: 'billing',
      label: 'Billing',
      type: 'select',
      options: Object.entries(BILLING_WORDS).map(([value, label]) => ({ value, label })),
    },
    searchFilter,
  ],
  columns: [
    { key: 'grnDate', label: 'Received On', type: 'date', width: 14 },
    { key: 'grnNumber', label: 'GRN No.', type: 'text', width: 16 },
    { key: 'poNumber', label: 'Order No.', type: 'text', width: 14 },
    { key: 'supplier', label: 'Supplier', type: 'text', width: 28 },
    { key: 'challanNo', label: 'Challan No.', type: 'text', width: 14 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 16 },
    { key: 'item', label: 'Item', type: 'text', width: 30 },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'ordered', label: 'Ordered', type: 'qty', total: 'sum' },
    { key: 'received', label: 'Received', type: 'qty', total: 'sum' },
    { key: 'rejected', label: 'Rejected', type: 'qty', total: 'sum' },
    { key: 'accepted', label: 'Into Stock', type: 'qty', total: 'sum' },
    { key: 'billedQty', label: 'Billed', type: 'qty', total: 'sum' },
    { key: 'unbilledQty', label: 'Not Billed', type: 'qty', total: 'sum' },
    { key: 'unbilledValue', label: 'Value Not Billed', type: 'money', total: 'sum' },
    { key: 'billNumbers', label: 'Our Bill Ref(s)', type: 'text', width: 18 },
    { key: 'theirBills', label: 'Their Bill No(s).', type: 'text', width: 20 },
    { key: 'store', label: 'Store', type: 'text', width: 22 },
    {
      key: 'status',
      label: 'Status',
      type: 'badge',
      badges: STATUS_WORDS,
      badgeTones: STATUS_TONE,
      width: 18,
    },
    {
      key: 'billing',
      label: 'Billing',
      type: 'badge',
      badges: BILLING_WORDS,
      badgeTones: BILLING_TONE,
      width: 13,
    },
    { key: 'daysUnbilled', label: 'Days Unbilled', type: 'integer', width: 13 },
  ],

  summary: {
    // By what was refused, not by what arrived: the biggest delivery is
    // rarely the one a manager needs to look at, and the worst one always is.
    title: 'Most refused at the gate',
    columns: ['grnDate', 'grnNumber', 'supplier', 'item', 'received', 'rejected', 'status'],
    by: 'rejected',
    limit: 12,
  },

  /**
   * By supplier, with the unit on a slicer.
   *
   * Receipts are the one register whose quantities genuinely cannot be added
   * down a column — metres and pieces sit in the same one. A slicer is the
   * fix rather than a caveat: pick a UOM and every total under it is in that
   * unit.
   */
  pivot: {
    rows: 'supplier',
    values: ['received', 'rejected', 'accepted'],
    slicers: ['status', 'store', 'uom'],
    note: 'Quantities in different units share these columns. Pick a UOM before reading a total.',
  },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const where: Prisma.GRNWhereInput = {
      ...(params.status ? { status: params.status as Prisma.EnumGRNStatusFilter['equals'] } : {}),
      ...(params.supplierId ? { po: { supplierId: params.supplierId } } : {}),
      ...(range ? { grnDate: range } : {}),
      // The same two clauses the Goods Receipt list runs, so the Export button
      // on that screen reports on exactly the rows it is showing.
      ...(params.itemId ? { lines: { some: { itemId: params.itemId } } } : {}),
      ...(params.q
        ? {
            OR: [
              { grnNumber: { contains: params.q, mode: 'insensitive' as const } },
              { po: { poNumber: { contains: params.q, mode: 'insensitive' as const } } },
              { po: { supplier: { name: { contains: params.q, mode: 'insensitive' as const } } } },
            ],
          }
        : {}),
    }

    // The cap counts receipts, since that is what is fetched; the rows it
    // produces are their lines, and the Notes sheet says which is which.
    const totalRows = await tx.gRN.count({ where })
    const receipts = await tx.gRN.findMany({
      where,
      take: rowCap,
      orderBy: [{ grnDate: 'asc' }, { grnNumber: 'asc' }],
      select: {
        grnNumber: true,
        grnDate: true,
        challanNo: true,
        status: true,
        po: { select: { poNumber: true, supplier: { select: { name: true } } } },
        lines: {
          select: {
            orderedQty: true,
            receivedQty: true,
            rejectedQty: true,
            acceptedQty: true,
            unitRate: true,
            poLine: { select: { unitRate: true, discount: true } },
            billLines: {
              where: { bill: { status: { not: 'CANCELLED' } } },
              select: {
                qty: true,
                bill: { select: { billNumber: true, supplierInvoiceNo: true } },
              },
            },
            item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
            warehouse: { select: { name: true } },
          },
        },
      },
    })

    const today = new Date()
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())

    const all = receipts.flatMap((g) =>
      g.lines.map((l) => {
        const received = Number(l.receivedQty)
        const cancelledReceipt = g.status === 'CANCELLED'
        const billedQty = round2(l.billLines.reduce((s, b) => s + Number(b.qty), 0))
        const unbilledQty = cancelledReceipt ? 0 : round2(Math.max(0, received - billedQty))
        // The receipt's own rate, falling back to the order line's net of its
        // discount for a receipt booked before receipts carried one.
        const receiptRate = Number(l.unitRate)
        const rate =
          receiptRate > 0
            ? receiptRate
            : round2(Number(l.poLine?.unitRate ?? 0) * (1 - Number(l.poLine?.discount ?? 0) / 100))
        const day = new Date(g.grnDate.getFullYear(), g.grnDate.getMonth(), g.grnDate.getDate())
        return {
          grnDate: g.grnDate,
          grnNumber: g.grnNumber,
          poNumber: g.po?.poNumber ?? '',
          supplier: g.po?.supplier?.name ?? '',
          challanNo: g.challanNo ?? '',
          itemCode: l.item.code,
          item: l.item.name,
          uom: l.item.uom?.symbol ?? '',
          ordered: Number(l.orderedQty),
          received,
          rejected: Number(l.rejectedQty),
          accepted: Number(l.acceptedQty),
          billedQty,
          unbilledQty,
          unbilledValue: round2(unbilledQty * rate),
          billNumbers: [...new Set(l.billLines.map((b) => b.bill.billNumber))].join(', '),
          theirBills: [...new Set(l.billLines.map((b) => b.bill.supplierInvoiceNo ?? ''))]
            .filter(Boolean)
            .join(', '),
          store: l.warehouse?.name ?? '',
          status: g.status,
          // A cancelled receipt has nothing to bill, so it carries no billing.
          billing: cancelledReceipt
            ? ''
            : billedQty <= 0
              ? 'NOT_BILLED'
              : billedQty < received
                ? 'PART_BILLED'
                : 'BILLED',
          daysUnbilled:
            unbilledQty > 0
              ? Math.max(0, Math.floor((startOfToday.getTime() - day.getTime()) / DAY))
              : 0,
        }
      })
    )
    const rows = params.billing ? all.filter((r) => r.billing === params.billing) : all

    // A cancelled receipt is listed and counted nowhere — it booked nothing in.
    const live = rows.filter((r) => r.status !== 'CANCELLED')
    const cancelled = rows.length - live.length
    const received = round2(live.reduce((s, r) => s + r.received, 0))
    const rejected = round2(live.reduce((s, r) => s + r.rejected, 0))
    const accepted = round2(live.reduce((s, r) => s + r.accepted, 0))
    const deliveries = new Set(live.map((r) => r.grnNumber)).size

    const byItem = new Map<string, number>()
    for (const r of live) byItem.set(r.item, (byItem.get(r.item) ?? 0) + r.accepted)

    const bySupplierRejects = new Map<string, number>()
    for (const r of live) {
      if (r.rejected > 0)
        bySupplierRejects.set(r.supplier, (bySupplierRejects.get(r.supplier) ?? 0) + r.rejected)
    }

    const rejectRate = received === 0 ? null : rejected / received

    // Goods in stock with no bill behind them yet, and the ones waiting long.
    const unbilled = live.filter((r) => r.unbilledQty > 0)
    const unbilledValue = round2(unbilled.reduce((s, r) => s + r.unbilledValue, 0))
    const staleUnbilled = unbilled.filter((r) => r.daysUnbilled > 30)
    const staleUnbilledValue = round2(staleUnbilled.reduce((s, r) => s + r.unbilledValue, 0))

    const bySupplier = new Map<string, number>()
    for (const r of live) bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.accepted)

    const byStore = new Map<string, number>()
    for (const r of live) {
      if (r.store) byStore.set(r.store, (byStore.get(r.store) ?? 0) + r.accepted)
    }

    /*
     * The six biggest suppliers by what actually reached stock.
     *
     * Ranked on accepted rather than received, because a supplier who sends a
     * great deal and has most of it refused is not a big supplier — they are
     * a problem, and the split panel below is where that shows.
     */
    const topSuppliers = [...bySupplier.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name]) => name)

    const supplierSum = (supplier: string, pick: (r: (typeof live)[number]) => number) =>
      round2(live.filter((r) => r.supplier === supplier).reduce((s, r) => s + pick(r), 0))

    const insights: string[] = []
    if (rejected > 0) {
      insights.push(
        `${rejected.toLocaleString('en-IN')} of ${received.toLocaleString('en-IN')} received was refused at the gate — ${((rejected / received) * 100).toFixed(1)}%.`
      )
      const worst = [...bySupplierRejects.entries()].sort((a, b) => b[1] - a[1])[0]
      if (worst)
        insights.push(
          `Most refusals came against ${worst[0]} — ${round2(worst[1]).toLocaleString('en-IN')} units.`
        )
    } else if (live.length) {
      insights.push('Nothing was refused at the gate in this period.')
    }
    if (unbilled.length) {
      insights.push(
        `₹${unbilledValue.toLocaleString('en-IN')} of goods received is still waiting for the supplier's bill, on ${new Set(unbilled.map((r) => r.grnNumber)).size} receipt${new Set(unbilled.map((r) => r.grnNumber)).size === 1 ? '' : 's'}.`
      )
    }
    if (deliveries) {
      insights.push(
        `${deliveries} ${deliveries === 1 ? 'delivery' : 'deliveries'} across ${new Set(live.map((r) => r.supplier)).size} suppliers, covering ${byItem.size} items.`
      )
    }

    return {
      rows,
      totalRows,
      analysis: {
        exceptions: [
          {
            label: 'Refused at the gate',
            value: rejected || null,
            format: 'qty',
            basis: `of ${received.toLocaleString('en-IN')} received — raise a debit note if it has been billed`,
            tone: 'bad',
          },
          {
            label: 'Refusal rate',
            // Only when it is above the two percent the mill treats as
            // ordinary wastage. Below that it is a KPI, not an exception.
            value: rejectRate != null && rejectRate > 0.02 ? rejectRate : null,
            format: 'percent',
            basis: 'above the 2% treated as ordinary wastage',
            tone: 'bad',
          },
          {
            label: 'Not billed for over 30 days',
            value: staleUnbilledValue || null,
            format: 'money',
            basis: `${staleUnbilled.length} line${staleUnbilled.length === 1 ? '' : 's'} — ask the supplier for the bill`,
            tone: 'warn',
          },
          {
            label: 'Waiting for checking',
            value: live.filter((r) => r.status === 'QC_PENDING').length || null,
            format: 'integer',
            basis: 'receipt lines booked in but not yet passed or refused',
            tone: 'warn',
          },
        ],
        headline:
          live.length === 0
            ? 'Nothing was booked in during this period.'
            : `${deliveries} deliveries booked in, ${accepted.toLocaleString('en-IN')} units reaching stock.`,
        kpis: [
          {
            label: 'Deliveries',
            value: live.length ? deliveries : null,
            format: 'integer',
            basis: `${live.length} item lines across them`,
          },
          {
            label: 'Received',
            value: live.length ? received : null,
            format: 'qty',
            basis: 'total units booked at the gate',
          },
          {
            label: 'Refused',
            value: live.length ? rejected : null,
            format: 'qty',
            basis: `of ${received.toLocaleString('en-IN')} received`,
            tone: rejected > 0 ? 'warn' : 'good',
          },
          {
            label: 'Refusal rate',
            value: rejectRate,
            format: 'percent',
            basis:
              received > 0
                ? `${rejected.toLocaleString('en-IN')} of ${received.toLocaleString('en-IN')}`
                : 'nothing received to measure against',
            tone: rejectRate != null && rejectRate > 0.02 ? 'bad' : rejectRate ? 'warn' : 'good',
          },
        ],
        trend:
          byMonth(
            live,
            (r) => r.grnDate,
            (r) => r.accepted
          ).length > 1
            ? {
                title: 'Units reaching stock, by month',
                valueLabel: 'Into stock',
                format: 'qty',
                points: byMonth(
                  live,
                  (r) => r.grnDate,
                  (r) => r.accepted
                ),
              }
            : undefined,
        panels: (
          [
            {
              title: 'Most received items',
              question: 'ranking',
              format: 'qty',
              points: topWithRest(
                [...byItem].map(([label, value]) => ({ label, value: round2(value) })),
                8
              ),
              note: 'Quantity that reached stock. Units differ by item — see the Data sheet.',
            },
            {
              title: 'Refusals by supplier',
              question: 'ranking',
              format: 'qty',
              points: [...bySupplierRejects]
                .map(([label, value]) => ({ label, value: round2(value), exception: true }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 6),
              note: 'Every bar here is an exception, so every bar is red.',
            },
            {
              /*
               * Quality, per supplier, in one bar each.
               *
               * The refusals ranking above says who was refused most in units,
               * which flatters a small supplier and punishes a large one. This
               * puts the refusal beside what the same supplier got right, so a
               * short red tip on a long bar reads differently from a short red
               * tip on a short one.
               */
              title: 'What each supplier delivered, and what was refused',
              question: 'split',
              format: 'qty',
              points: topSuppliers.map((s) => ({ label: s, value: supplierSum(s, (r) => r.received) })),
              series: [
                {
                  name: 'Into stock',
                  values: topSuppliers.map((s) => supplierSum(s, (r) => r.accepted)),
                  tone: 'good',
                },
                {
                  name: 'Refused',
                  values: topSuppliers.map((s) => supplierSum(s, (r) => r.rejected)),
                  tone: 'bad',
                },
              ],
              note: 'The six biggest suppliers by what reached stock. Units differ by item.',
            },
            {
              title: 'Where the goods were put away',
              question: 'comparison',
              format: 'qty',
              points: [...byStore]
                .map(([label, value]) => ({ label, value: round2(value) }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 8),
              note: 'Quantity into each store. A receipt split across stores counts in each.',
            },
          ] as Panel[]
        ).filter((p) => p.points.length > 0),
        insights,
        caveats: [
          cancelled > 0
            ? `${cancelled} line${cancelled === 1 ? '' : 's'} on cancelled receipts appear on the Data sheet and are counted nowhere on this Dashboard.`
            : 'No cancelled receipts fell in this period.',
          'Quantities are in each item’s own unit and are not comparable across items. The totals add unlike units and are there for a filtered column, not for the whole sheet.',
          'A receipt still in draft has booked nothing into stock, but its ordered and received figures are counted here.',
          'Billed counts live bills only. The value not billed is at the receipt rate, before tax.',
        ],
      },
    }
  },
}
