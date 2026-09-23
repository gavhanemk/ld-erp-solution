import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
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

const STATUS_WORDS: Record<string, string> = {
  UNPAID: 'Unpaid',
  PARTIAL: 'Part paid',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
}

/**
 * Every supplier bill booked in a period, and what it was taxed at.
 *
 * The report the accounts team reconciles GSTR-2B against, so the tax split is
 * on the row rather than rolled into one figure: input credit is claimed
 * CGST/SGST or IGST, never "GST".
 */
export const purchaseRegister: ReportDefinition = {
  id: 'purchase-register',
  module: 'purchase',
  title: 'Purchase Register',
  description:
    'Every supplier bill booked in the period, with its tax split, what has been paid against it and what is still owed.',
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
      key: 'overdue',
      label: 'Overdue only',
      type: 'boolean',
      help: 'Only bills past their due date and not settled',
    },
    searchFilter,
  ],
  columns: [
    { key: 'billDate', label: 'Booked On', type: 'date', width: 14 },
    { key: 'billNumber', label: 'Our Ref', type: 'text', width: 16 },
    { key: 'supplierInvoiceNo', label: 'Their Bill No.', type: 'text', width: 18 },
    { key: 'supplierInvoiceDate', label: 'Their Bill Date', type: 'date', width: 14 },
    { key: 'supplier', label: 'Supplier', type: 'text', width: 30 },
    { key: 'gstin', label: 'GSTIN', type: 'text', width: 18 },
    { key: 'poNumber', label: 'Order No.', type: 'text', width: 14 },
    { key: 'taxable', label: 'Taxable', type: 'money', total: 'sum' },
    { key: 'cgst', label: 'CGST', type: 'money', total: 'sum' },
    { key: 'sgst', label: 'SGST', type: 'money', total: 'sum' },
    { key: 'igst', label: 'IGST', type: 'money', total: 'sum' },
    { key: 'total', label: 'Bill Total', type: 'money', total: 'sum' },
    { key: 'tds', label: 'TDS', type: 'money', total: 'sum' },
    { key: 'paid', label: 'Paid', type: 'money', total: 'sum' },
    { key: 'balance', label: 'Outstanding', type: 'money', total: 'sum' },
    { key: 'status', label: 'Status', type: 'badge', badges: STATUS_WORDS, width: 12 },
    { key: 'dueDate', label: 'Due', type: 'date', width: 14 },
  ],

  /**
   * By supplier: billed, settled, and what is left of it.
   *
   * Taxable rather than the bill total leads, because that is the figure the
   * purchase ledger and the GST return both work from.
   */
  pivot: {
    rows: 'supplier',
    values: ['taxable', 'total', 'paid', 'balance'],
    slicers: ['status'],
    note: 'What each supplier billed, what has gone out to them, and what is still to go.',
  },

  async run({ tx, params, rowCap }) {
    const where: Prisma.PurchaseInvoiceWhereInput = {
      ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      ...(params.status
        ? { status: params.status as Prisma.EnumInvoiceStatusFilter['equals'] }
        : {}),
      ...((): Prisma.PurchaseInvoiceWhereInput => {
        const range = dayRange(params)
        return range ? { billDate: range } : {}
      })(),
      // The same clauses the Purchase Bills list runs, so the Export button on
      // that screen reports on exactly the rows it is showing.
      ...(params.itemId ? { lines: { some: { itemId: params.itemId } } } : {}),
      // An AND rather than two more top-level keys: `status` is already set
      // above when the picker chose one, and a second `status` in the same
      // object silently replaces the first. Under AND, asking for PAID and
      // overdue at once correctly returns nothing instead of quietly
      // returning one of the two filters the reader did not ask for.
      ...(params.overdue === 'true'
        ? {
            AND: [
              { dueDate: { lt: new Date() } },
              { status: { in: ['UNPAID', 'PARTIAL'] as const } },
            ],
          }
        : {}),
      ...(params.q
        ? {
            OR: [
              { billNumber: { contains: params.q, mode: 'insensitive' as const } },
              { supplierInvoiceNo: { contains: params.q, mode: 'insensitive' as const } },
              { supplier: { name: { contains: params.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    }

    // Counted before the rows are fetched, so the cap can be reported against
    // what was really there rather than against what came back.
    const totalRows = await tx.purchaseInvoice.count({ where })

    const bills = await tx.purchaseInvoice.findMany({
      where,
      take: rowCap,
      orderBy: [{ billDate: 'asc' }, { billNumber: 'asc' }],
      select: {
        billNumber: true,
        supplierInvoiceNo: true,
        supplierInvoiceDate: true,
        billDate: true,
        dueDate: true,
        taxableAmount: true,
        cgst: true,
        sgst: true,
        igst: true,
        totalAmount: true,
        tdsAmount: true,
        paidAmount: true,
        balanceAmount: true,
        status: true,
        isReverseCharge: true,
        supplier: { select: { name: true, gstin: true } },
        po: { select: { poNumber: true } },
      },
    })

    const rows = bills.map((b) => ({
      billDate: b.billDate,
      billNumber: b.billNumber,
      supplierInvoiceNo: b.supplierInvoiceNo,
      supplierInvoiceDate: b.supplierInvoiceDate,
      supplier: b.supplier?.name ?? '',
      gstin: b.supplier?.gstin ?? '',
      poNumber: b.po?.poNumber ?? '',
      taxable: Number(b.taxableAmount),
      cgst: Number(b.cgst),
      sgst: Number(b.sgst),
      igst: Number(b.igst),
      total: Number(b.totalAmount),
      tds: Number(b.tdsAmount),
      paid: Number(b.paidAmount),
      balance: Number(b.balanceAmount),
      status: b.status,
      dueDate: b.dueDate,
    }))

    // Cancelled bills are listed but never counted. A cancelled bill is part
    // of what happened; it is not part of what was bought.
    const live = rows.filter((r) => r.status !== 'CANCELLED')
    const cancelled = rows.length - live.length

    const taxable = round2(live.reduce((s, r) => s + r.taxable, 0))
    const gst = round2(live.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0))
    const billed = round2(live.reduce((s, r) => s + r.total, 0))
    const outstanding = round2(live.reduce((s, r) => s + r.balance, 0))

    const withinState = round2(live.filter((r) => r.cgst > 0).reduce((s, r) => s + r.taxable, 0))
    const otherState = round2(live.filter((r) => r.igst > 0).reduce((s, r) => s + r.taxable, 0))
    const noGst = round2(taxable - withinState - otherState)

    const bySupplier = new Map<string, number>()
    for (const r of live) bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.total)

    const byStatus = Object.keys(STATUS_WORDS)
      .filter((s) => s !== 'CANCELLED')
      .map((s) => ({
        label: STATUS_WORDS[s],
        value: live.filter((r) => r.status === s).length,
      }))
      .filter((p) => p.value > 0)

    /*
     * The biggest suppliers, and what each of them is made of.
     *
     * Eight, because a stacked bar with three segments needs the bar to be
     * tall enough to divide — past about eight the segments are hairlines and
     * the chart says less than the ranking beside it already did.
     */
    const topSuppliers = [...bySupplier.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name]) => name)

    const sumBy = (supplier: string, pick: (r: (typeof live)[number]) => number) =>
      round2(live.filter((r) => r.supplier === supplier).reduce((s, r) => s + pick(r), 0))

    const panels: Panel[] = [
      {
        title: 'Biggest suppliers by value billed',
        question: 'ranking',
        format: 'money',
        points: topWithRest(
          [...bySupplier].map(([label, value]) => ({ label, value: round2(value) })),
          8
        ),
        note: 'Bill totals including tax. Cancelled bills are not counted.',
      },
      {
        /*
         * Concentration, which a ranking cannot show.
         *
         * A ranking says who is biggest. This says how much of the mill's
         * buying rests on how few names — the question behind whether a
         * supplier going quiet is an inconvenience or a stoppage.
         */
        title: 'How few suppliers make up the spend',
        question: 'pareto',
        format: 'money',
        points: topWithRest(
          [...bySupplier].map(([label, value]) => ({ label, value: round2(value) })),
          9
        ),
        note: 'The line is the share reached by that supplier and every bigger one, so it ends at 100%.',
      },
      {
        title: 'Settled against still owed, by supplier',
        question: 'split',
        format: 'money',
        points: topSuppliers.map((s) => ({ label: s, value: round2(bySupplier.get(s) ?? 0) })),
        series: [
          { name: 'Paid', values: topSuppliers.map((s) => sumBy(s, (r) => r.paid)) },
          { name: 'Still owed', values: topSuppliers.map((s) => sumBy(s, (r) => r.balance)) },
        ],
        note: 'The eight biggest suppliers by value billed.',
      },
      {
        /*
         * The same three-way tax split as the doughnut, but per supplier.
         *
         * The doughnut says how much of the period carries IGST. This says
         * which suppliers it comes from, which is the one a person can act
         * on — an interstate supplier's credit is claimed on a different line
         * of the return.
         */
        title: 'How each supplier was taxed',
        question: 'split',
        format: 'money',
        points: topSuppliers.map((s) => ({ label: s, value: sumBy(s, (r) => r.taxable) })),
        series: [
          {
            name: 'Within the state',
            values: topSuppliers.map((s) =>
              round2(
                live
                  .filter((r) => r.supplier === s && r.cgst > 0)
                  .reduce((n, r) => n + r.taxable, 0)
              )
            ),
          },
          {
            name: 'Other state (IGST)',
            values: topSuppliers.map((s) =>
              round2(
                live
                  .filter((r) => r.supplier === s && r.igst > 0)
                  .reduce((n, r) => n + r.taxable, 0)
              )
            ),
          },
          {
            name: 'No GST',
            values: topSuppliers.map((s) =>
              round2(
                live
                  .filter((r) => r.supplier === s && r.cgst === 0 && r.igst === 0)
                  .reduce((n, r) => n + r.taxable, 0)
              )
            ),
          },
        ],
        note: 'Taxable value, so each bar matches that supplier’s share of the taxable total.',
      },
      {
        title: 'Where the goods were taxed',
        question: 'composition',
        format: 'money',
        points: [
          { label: 'Within the state (CGST+SGST)', value: withinState },
          { label: 'Other state (IGST)', value: otherState },
          { label: 'No GST charged', value: noGst },
        ].filter((p) => p.value > 0),
        note: 'Taxable value, so the three add up to the taxable total above.',
      },
      {
        title: 'Bills by settlement',
        question: 'comparison',
        format: 'integer',
        points: byStatus,
      },
    ]

    const trendPoints = byMonth(
      live,
      (r) => r.billDate,
      (r) => r.taxable
    )

    const biggest = [...bySupplier.entries()].sort((a, b) => b[1] - a[1])[0]
    const insights: string[] = []
    if (biggest && billed > 0) {
      insights.push(
        `${biggest[0]} accounts for ₹${round2(biggest[1]).toLocaleString('en-IN')} of the ₹${billed.toLocaleString('en-IN')} billed — ${Math.round((biggest[1] / billed) * 100)}% of the period.`
      )
    }
    if (otherState > 0 && withinState > 0) {
      insights.push(
        `₹${otherState.toLocaleString('en-IN')} of taxable value came from outside the state and carries IGST, which is claimed separately from the CGST/SGST on the rest.`
      )
    }
    if (outstanding > 0) {
      insights.push(
        `₹${outstanding.toLocaleString('en-IN')} of the ₹${billed.toLocaleString('en-IN')} billed is still owed across ${live.filter((r) => r.balance > 0).length} bills.`
      )
    }
    if (noGst > 0) {
      insights.push(
        `₹${noGst.toLocaleString('en-IN')} of taxable value carries no GST — unregistered suppliers, or bills under reverse charge where the tax is ours to pay.`
      )
    }

    const caveats = [
      'Booked on the bill date, not the date goods arrived. A delivery at the end of one month billed in the next falls in the later month here.',
      cancelled > 0
        ? `${cancelled} cancelled ${cancelled === 1 ? 'bill is' : 'bills are'} listed on the Data sheet but counted nowhere on this Dashboard.`
        : 'No cancelled bills fell in this period.',
      'Input credit shown is what the supplier charged. It is not a claim — reconcile against GSTR-2B before filing.',
    ]

    return {
      rows,
      totalRows,
      analysis: {
        headline:
          live.length === 0
            ? 'No bills were booked in this period.'
            : `₹${billed.toLocaleString('en-IN')} billed across ${live.length} bills from ${bySupplier.size} suppliers.`,
        kpis: [
          {
            label: 'Taxable value',
            value: live.length ? taxable : null,
            format: 'money',
            basis: `across ${live.length} bills`,
          },
          {
            label: 'GST charged',
            value: live.length ? gst : null,
            format: 'money',
            basis: `on ${live.filter((r) => r.cgst + r.sgst + r.igst > 0).length} bills carrying tax`,
          },
          {
            label: 'Average bill',
            value: mean(billed, live.length),
            format: 'money',
            basis: live.length
              ? `${billed.toLocaleString('en-IN')} over ${live.length} bills`
              : 'no bills in this period',
          },
          {
            label: 'Still outstanding',
            value: live.length ? outstanding : null,
            format: 'money',
            basis: `of ₹${billed.toLocaleString('en-IN')} billed`,
            tone: outstanding > 0 ? 'warn' : 'good',
          },
        ],
        trend:
          trendPoints.length > 1
            ? {
                title: 'Taxable value booked, by month',
                valueLabel: 'Taxable value',
                format: 'money',
                points: trendPoints,
              }
            : undefined,
        panels: panels.filter((p) => p.points.length > 0),
        insights,
        caveats,
      },
    }
  },
}
