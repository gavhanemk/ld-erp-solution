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

/*
 * Whether the supplier's bill for a delivery has been booked.
 *
 * The same test the Goods Receipt screen and the bill form use: what arrived
 * against what live bills have claimed. Cancelled bills claim nothing.
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

/** How long unbilled goods have been in, in the bands the ageing chart uses. */
const AGE_BANDS = [
  { label: 'Within a week', max: 7 },
  { label: '8-15 days', max: 15 },
  { label: '16-30 days', max: 30 },
  { label: '31-60 days', max: 60 },
  { label: 'Over 60 days', max: Infinity },
]

/**
 * Every item received, and whether the bill for it has been booked.
 *
 * One row per receipt line, because a receipt can be part billed — two of
 * its three items on the supplier's first invoice, the third still to come —
 * and a row per receipt would call that "part billed" without saying which.
 *
 * The value waiting is at the receipt's own rate, before tax: what the goods
 * are in stock at, and so what the books are carrying with no bill behind it.
 */
export const grnAgainstBill: ReportDefinition = {
  id: 'grn-against-bill',
  module: 'purchase',
  title: 'GRN Against Bill',
  description:
    'Every item received at the gate, how much of it the supplier has billed, and the value still waiting for a bill.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    itemFilter,
    {
      key: 'billing',
      label: 'Billing',
      type: 'select',
      options: Object.entries(BILLING_WORDS).map(([value, label]) => ({ value, label })),
    },
    { ...searchFilter, help: 'GRN, order, challan or bill number, or supplier name' },
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
    { key: 'received', label: 'Received', type: 'qty', total: 'sum' },
    { key: 'billedQty', label: 'Billed', type: 'qty', total: 'sum' },
    { key: 'unbilledQty', label: 'Not Billed', type: 'qty', total: 'sum' },
    { key: 'rate', label: 'Rate', type: 'money', total: 'none' },
    { key: 'unbilledValue', label: 'Value Not Billed', type: 'money', total: 'sum' },
    { key: 'billNumbers', label: 'Our Bill Ref(s)', type: 'text', width: 18 },
    { key: 'theirBills', label: 'Their Bill No(s).', type: 'text', width: 20 },
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
    title: 'Biggest value still waiting for a bill',
    columns: [
      'grnDate',
      'grnNumber',
      'supplier',
      'item',
      'unbilledQty',
      'unbilledValue',
      'daysUnbilled',
    ],
    by: 'unbilledValue',
    limit: 12,
  },

  pivot: {
    rows: 'supplier',
    values: ['unbilledValue', 'received', 'billedQty', 'unbilledQty'],
    slicers: ['billing', 'uom'],
    note: 'The value is in rupees and adds across items. Pick a UOM before reading a quantity total.',
  },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const contains = (v: string) => ({ contains: v, mode: 'insensitive' as const })

    // A cancelled receipt put nothing in stock and has nothing to bill.
    const where: Prisma.GRNWhereInput = {
      status: { not: 'CANCELLED' },
      ...(params.supplierId ? { po: { supplierId: params.supplierId } } : {}),
      ...(range ? { grnDate: range } : {}),
      ...(params.itemId ? { lines: { some: { itemId: params.itemId } } } : {}),
      ...(params.q
        ? {
            OR: [
              { grnNumber: contains(params.q) },
              { challanNo: contains(params.q) },
              { po: { poNumber: contains(params.q) } },
              { po: { supplier: { name: contains(params.q) } } },
              {
                lines: {
                  some: {
                    billLines: {
                      some: {
                        bill: {
                          status: { not: 'CANCELLED' },
                          OR: [
                            { billNumber: contains(params.q) },
                            { supplierInvoiceNo: contains(params.q) },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            ],
          }
        : {}),
    }

    const cancelled = await tx.gRN.count({
      where: {
        status: 'CANCELLED',
        ...(range ? { grnDate: range } : {}),
        ...(params.supplierId ? { po: { supplierId: params.supplierId } } : {}),
      },
    })
    const totalRows = await tx.gRN.count({ where })
    const receipts = await tx.gRN.findMany({
      where,
      take: rowCap,
      orderBy: [{ grnDate: 'asc' }, { grnNumber: 'asc' }],
      select: {
        grnNumber: true,
        grnDate: true,
        challanNo: true,
        po: { select: { poNumber: true, supplier: { select: { name: true } } } },
        lines: {
          // An item filter narrows the lines too, so the sheet is that item's
          // rows and not every line on a receipt that happens to carry it.
          ...(params.itemId ? { where: { itemId: params.itemId } } : {}),
          select: {
            receivedQty: true,
            unitRate: true,
            poLine: { select: { unitRate: true, discount: true } },
            item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
            billLines: {
              where: { bill: { status: { not: 'CANCELLED' } } },
              select: {
                qty: true,
                bill: { select: { billNumber: true, supplierInvoiceNo: true } },
              },
            },
          },
        },
      },
    })

    const today = new Date()
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())

    const all = receipts.flatMap((g) =>
      g.lines.map((l) => {
        const received = Number(l.receivedQty)
        const billedQty = round2(l.billLines.reduce((s, b) => s + Number(b.qty), 0))
        const unbilledQty = round2(Math.max(0, received - billedQty))
        // The receipt's own rate, falling back to the order line's net of its
        // discount for a receipt booked before receipts carried one.
        const receiptRate = Number(l.unitRate)
        const rate =
          receiptRate > 0
            ? receiptRate
            : round2(Number(l.poLine?.unitRate ?? 0) * (1 - Number(l.poLine?.discount ?? 0) / 100))
        const billing =
          billedQty <= 0 ? 'NOT_BILLED' : billedQty < received ? 'PART_BILLED' : 'BILLED'
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
          received,
          billedQty,
          unbilledQty,
          rate,
          unbilledValue: round2(unbilledQty * rate),
          billNumbers: [...new Set(l.billLines.map((b) => b.bill.billNumber))].join(', '),
          theirBills: [...new Set(l.billLines.map((b) => b.bill.supplierInvoiceNo ?? ''))]
            .filter(Boolean)
            .join(', '),
          billing,
          daysUnbilled:
            unbilledQty > 0
              ? Math.max(0, Math.floor((startOfToday.getTime() - day.getTime()) / DAY))
              : 0,
        }
      })
    )

    const rows = params.billing ? all.filter((r) => r.billing === params.billing) : all

    const waiting = rows.filter((r) => r.unbilledQty > 0)
    const waitingValue = round2(waiting.reduce((s, r) => s + r.unbilledValue, 0))
    const receivedValue = round2(rows.reduce((s, r) => s + r.received * r.rate, 0))
    const over30 = waiting.filter((r) => r.daysUnbilled > 30)
    const over30Value = round2(over30.reduce((s, r) => s + r.unbilledValue, 0))
    const deliveries = new Set(rows.map((r) => r.grnNumber)).size
    const deliveriesWaiting = new Set(waiting.map((r) => r.grnNumber)).size

    const bySupplier = new Map<string, number>()
    for (const r of waiting)
      bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.unbilledValue)

    const ageing = AGE_BANDS.map((band, i) => {
      const min = i === 0 ? -1 : AGE_BANDS[i - 1].max
      const value = round2(
        waiting
          .filter((r) => r.daysUnbilled > min && r.daysUnbilled <= band.max)
          .reduce((s, r) => s + r.unbilledValue, 0)
      )
      return { label: band.label, value, exception: band.max > 30 && value > 0 }
    })

    const valueOf = (s: string) =>
      round2(rows.filter((r) => r.billing === s).reduce((n, r) => n + r.received * r.rate, 0))

    const insights: string[] = []
    if (waiting.length) {
      insights.push(
        `₹${waitingValue.toLocaleString('en-IN')} of goods from ${deliveriesWaiting} ${deliveriesWaiting === 1 ? 'delivery is' : 'deliveries are'} in stock with no bill booked for ${deliveriesWaiting === 1 ? 'it' : 'them'}.`
      )
      const top = [...bySupplier].sort((a, b) => b[1] - a[1])[0]
      if (top)
        insights.push(
          `The most is waiting on ${top[0]} — ₹${round2(top[1]).toLocaleString('en-IN')}.`
        )
    } else if (rows.length) {
      insights.push('Every delivery in this period has been billed in full.')
    }

    return {
      rows,
      totalRows: params.billing ? undefined : totalRows,
      analysis: {
        headline:
          rows.length === 0
            ? 'Nothing was received in this period.'
            : `${deliveries} deliveries, ${deliveriesWaiting} still waiting for a bill worth ₹${waitingValue.toLocaleString('en-IN')}.`,
        exceptions: [
          {
            label: 'Unbilled for over 30 days',
            value: over30Value || null,
            format: 'money',
            basis: `${over30.length} receipt line${over30.length === 1 ? '' : 's'} — chase the supplier for the invoice`,
            tone: 'bad',
          },
        ],
        kpis: [
          {
            label: 'Deliveries',
            value: rows.length ? deliveries : null,
            format: 'integer',
            basis: `${rows.length} item lines`,
          },
          {
            label: 'Billed in full',
            value: ratio(rows.filter((r) => r.billing === 'BILLED').length, rows.length),
            format: 'percent',
            basis: `${rows.filter((r) => r.billing === 'BILLED').length} of ${rows.length} lines`,
          },
          {
            label: 'Value not billed',
            value: rows.length ? waitingValue : null,
            format: 'money',
            basis: `of ₹${receivedValue.toLocaleString('en-IN')} received, before tax`,
            tone: waitingValue > 0 ? 'warn' : 'good',
          },
          {
            label: 'Oldest unbilled',
            value: waiting.length ? Math.max(...waiting.map((r) => r.daysUnbilled)) : null,
            format: 'days',
            basis: 'since the goods were received',
            tone: over30.length ? 'bad' : undefined,
          },
        ],
        panels: (
          [
            {
              title: 'Received value by billing',
              question: 'composition',
              format: 'money',
              points: (['BILLED', 'PART_BILLED', 'NOT_BILLED'] as const).map((s) => ({
                label: BILLING_WORDS[s],
                value: valueOf(s),
                tone: BILLING_TONE[s],
              })),
              note: 'Whole receipt lines at the receipt rate, before tax.',
            },
            {
              title: 'How long unbilled goods have been in',
              question: 'ageing',
              format: 'money',
              points: ageing,
            },
            {
              title: 'Who owes us a bill',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                [...bySupplier].map(([label, value]) => ({ label, value: round2(value) })),
                8
              ),
              note: 'Value received and not yet billed, by supplier.',
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          cancelled > 0
            ? `${cancelled} cancelled receipt${cancelled === 1 ? '' : 's'} in this period ${cancelled === 1 ? 'is' : 'are'} left out — nothing was received on ${cancelled === 1 ? 'it' : 'them'}.`
            : 'No cancelled receipts fell in this period.',
          'Values are at the receipt rate before GST, charges and discounts on the bill. The bill itself may come in at a different figure.',
          'Cancelled bills claim nothing, so goods on a cancelled bill show as not billed.',
          'Quantities are in each item’s own unit. The value columns add across items; the quantity columns do not.',
        ],
      },
    }
  },
}
