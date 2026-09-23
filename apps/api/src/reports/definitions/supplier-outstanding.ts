import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import {
  dateRangeFilters,
  dayRange,
  mean,
  round2,
  searchFilter,
  supplierFilter,
  topWithRest,
} from './shared'

/**
 * What is still owed to suppliers, aged.
 *
 * Deliberately a snapshot of today rather than of a period: a payables ageing
 * asks "what do we owe now", and a date range on it produces a figure that is
 * true of no moment at all.
 */

const BUCKETS = ['Not yet due', '1-30 days', '31-60 days', '61-90 days', 'Over 90 days'] as const
type Bucket = (typeof BUCKETS)[number]

function bucketFor(days: number): Bucket {
  if (days <= 0) return 'Not yet due'
  if (days <= 30) return '1-30 days'
  if (days <= 60) return '31-60 days'
  if (days <= 90) return '61-90 days'
  return 'Over 90 days'
}

export const supplierOutstanding: ReportDefinition = {
  id: 'supplier-outstanding',
  module: 'purchase',
  title: 'Supplier Outstanding',
  description:
    'Every bill still owed, aged from its due date. A snapshot of today, not of a period — a payables ageing with a date range on it is true of no moment at all.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    {
      key: 'bucket',
      label: 'Ageing',
      type: 'select',
      options: BUCKETS.map((b) => ({ value: b, label: b })),
    },
    {
      key: 'overdueOnly',
      label: 'Overdue only',
      type: 'boolean',
      help: 'Leave off to include bills that are not yet due',
    },
    searchFilter,
  ],
  columns: [
    { key: 'supplier', label: 'Supplier', type: 'text', width: 30 },
    { key: 'billNumber', label: 'Our Ref', type: 'text', width: 16 },
    { key: 'supplierInvoiceNo', label: 'Their Bill No.', type: 'text', width: 18 },
    { key: 'billDate', label: 'Bill Date', type: 'date', width: 14 },
    { key: 'dueDate', label: 'Due', type: 'date', width: 14 },
    { key: 'daysOverdue', label: 'Days Overdue', type: 'integer', width: 13 },
    { key: 'bucket', label: 'Ageing', type: 'text', width: 14 },
    { key: 'total', label: 'Bill Total', type: 'money', total: 'sum' },
    { key: 'paid', label: 'Paid', type: 'money', total: 'sum' },
    { key: 'balance', label: 'Outstanding', type: 'money', total: 'sum' },
    { key: 'isMsme', label: 'MSME', type: 'text', width: 8 },
  ],

  /**
   * By supplier, with ageing and MSME on slicers.
   *
   * Those two are what turn this from a list into a decision: the ageing band
   * says which money has waited longest, and MSME says which of it carries a
   * statutory clock rather than a conversation.
   */
  pivot: {
    rows: 'supplier',
    values: ['balance', 'total', 'paid'],
    slicers: ['bucket', 'isMsme'],
    note: 'What is still owed, by supplier. Ageing narrows it to one band; MSME to the suppliers with a statutory payment clock.',
  },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const where: Prisma.PurchaseInvoiceWhereInput = {
      status: { in: ['UNPAID', 'PARTIAL'] },
      ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      // The same clauses the Supplier Payments screen runs, so the Export
      // button there reports on exactly the bills it is showing.
      ...(range ? { billDate: range } : {}),
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

    const totalRows = await tx.purchaseInvoice.count({ where })
    const bills = await tx.purchaseInvoice.findMany({
      where,
      take: rowCap,
      orderBy: [{ dueDate: 'asc' }, { billDate: 'asc' }],
      select: {
        billNumber: true,
        supplierInvoiceNo: true,
        billDate: true,
        dueDate: true,
        totalAmount: true,
        paidAmount: true,
        balanceAmount: true,
        supplier: { select: { name: true, isMsme: true } },
      },
    })

    const today = new Date()
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())

    let rows = bills.map((b) => {
      // Aged from the due date where the supplier gave terms and from the
      // bill date where they did not — an undated bill is not "not yet due",
      // it is due now.
      const reference = b.dueDate ?? b.billDate
      const refDay = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate())
      const days = Math.floor((startOfToday.getTime() - refDay.getTime()) / 86_400_000)
      return {
        supplier: b.supplier?.name ?? '',
        billNumber: b.billNumber,
        supplierInvoiceNo: b.supplierInvoiceNo,
        billDate: b.billDate,
        dueDate: b.dueDate,
        daysOverdue: days > 0 ? days : 0,
        bucket: bucketFor(days),
        total: Number(b.totalAmount),
        paid: Number(b.paidAmount),
        balance: Number(b.balanceAmount),
        isMsme: b.supplier?.isMsme ? 'Yes' : '',
      }
    })

    if (params.overdueOnly === 'true') rows = rows.filter((r) => r.daysOverdue > 0)
    // The band is worked out from the due date after the rows come back, so
    // it is filtered here rather than in SQL — the same place `overdueOnly`
    // has always been applied, and for the same reason.
    if (params.bucket) rows = rows.filter((r) => r.bucket === params.bucket)

    const owed = round2(rows.reduce((s, r) => s + r.balance, 0))
    const overdue = rows.filter((r) => r.daysOverdue > 0)
    const overdueAmount = round2(overdue.reduce((s, r) => s + r.balance, 0))
    const oldest = rows.reduce((m, r) => Math.max(m, r.daysOverdue), 0)

    // MSME suppliers must be paid within 45 days by law, so anything past it
    // is the one thing on this sheet that draws red.
    const msmeLate = rows.filter((r) => r.isMsme === 'Yes' && r.daysOverdue > 45)
    const msmeLateAmount = round2(msmeLate.reduce((s, r) => s + r.balance, 0))

    const ageing = BUCKETS.map((b) => ({
      label: b,
      value: round2(rows.filter((r) => r.bucket === b).reduce((s, r) => s + r.balance, 0)),
      exception: b === 'Over 90 days',
    })).filter((p) => p.value > 0)

    const bySupplier = new Map<string, number>()
    for (const r of rows) bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.balance)

    const insights: string[] = []
    if (overdueAmount > 0) {
      insights.push(
        `₹${overdueAmount.toLocaleString('en-IN')} is past its date across ${overdue.length} bills — ${owed > 0 ? Math.round((overdueAmount / owed) * 100) : 0}% of everything owed.`
      )
    }
    if (msmeLate.length) {
      insights.push(
        `${msmeLate.length} MSME ${msmeLate.length === 1 ? 'bill is' : 'bills are'} past 45 days, holding ₹${msmeLateAmount.toLocaleString('en-IN')}. Interest is payable on these by law.`
      )
    }
    const worst = [...bySupplier.entries()].sort((a, b) => b[1] - a[1])[0]
    if (worst) {
      insights.push(`Most is owed to ${worst[0]} — ₹${round2(worst[1]).toLocaleString('en-IN')}.`)
    }
    if (rows.length && overdueAmount === 0) {
      insights.push('Nothing is past its date. Everything owed is still within terms.')
    }

    return {
      rows,
      /*
       * Only when the cap actually bit.
       *
       * `totalRows` counts what the query matched; the overdue and ageing
       * filters run afterwards, on the mapped rows, because the band is
       * worked out from the due date rather than stored. So `rows.length` is
       * routinely below `totalRows` with nothing having been truncated — and
       * the engine reads a gap between those two as truncation and puts
       * _PARTIAL in the file name. Asking whether the fetch hit the ceiling
       * is the question that was actually meant.
       */
      totalRows: bills.length >= rowCap ? totalRows : undefined,
      analysis: {
        headline:
          rows.length === 0
            ? 'Nothing is outstanding — every supplier bill is paid in full.'
            : `₹${owed.toLocaleString('en-IN')} owed across ${rows.length} bills to ${bySupplier.size} suppliers.`,
        kpis: [
          {
            label: 'Total outstanding',
            value: rows.length ? owed : null,
            format: 'money',
            basis: `across ${rows.length} unpaid bills`,
          },
          {
            label: 'Past its date',
            value: rows.length ? overdueAmount : null,
            format: 'money',
            basis: `${overdue.length} of ${rows.length} bills`,
            tone: overdueAmount > 0 ? 'warn' : 'good',
          },
          {
            label: 'Oldest',
            value: rows.length ? oldest : null,
            format: 'days',
            basis: oldest > 0 ? 'past due on the longest-standing bill' : 'nothing is past due',
            tone: oldest > 90 ? 'bad' : oldest > 0 ? 'warn' : 'good',
          },
          {
            label: 'Average bill owed',
            value: mean(owed, rows.length),
            format: 'money',
            basis: rows.length
              ? `₹${owed.toLocaleString('en-IN')} over ${rows.length} bills`
              : 'nothing outstanding',
          },
        ],
        panels: (
          [
            {
              title: 'What is owed, by age',
              question: 'ageing',
              format: 'money',
              points: ageing,
              note: 'Aged from the due date, or from the bill date where the supplier gave no terms.',
            },
            {
              title: 'Who is owed most',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                [...bySupplier].map(([label, value]) => ({ label, value: round2(value) })),
                8
              ),
            },
            {
              /*
               * How concentrated the debt is.
               *
               * The ranking says who is owed most. This says how many
               * conversations it would take to clear most of what is owed —
               * which is the question when cash is short.
               */
              title: 'How few suppliers the debt sits with',
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
               * The ageing chart, split by whether the clock is statutory.
               *
               * An MSME bill past 45 days accrues interest by law. Sitting
               * inside the same bar as everything else it is invisible; as its
               * own segment the band that needs paying first is obvious.
               */
              title: 'What is owed by age, and how much of it is MSME',
              question: 'split',
              format: 'money',
              points: ageing.map((b) => ({ label: b.label, value: b.value })),
              series: [
                {
                  name: 'MSME supplier',
                  values: ageing.map((b) =>
                    round2(
                      rows
                        .filter((r) => r.bucket === b.label && r.isMsme === 'Yes')
                        .reduce((s, r) => s + r.balance, 0)
                    )
                  ),
                },
                {
                  name: 'Everyone else',
                  values: ageing.map((b) =>
                    round2(
                      rows
                        .filter((r) => r.bucket === b.label && r.isMsme !== 'Yes')
                        .reduce((s, r) => s + r.balance, 0)
                    )
                  ),
                },
              ],
              note: 'An MSME bill past 45 days carries interest by law, whatever the agreed terms said.',
            },
          ] as Panel[]
        ).filter((p) => p.points.length > 0),
        insights,
        caveats: [
          'A snapshot of today. Run it again tomorrow and the ageing moves by a day.',
          'Cancelled bills are excluded, and so is anything already paid in full.',
          'A bill with no due date is aged from its bill date, so it reads as due now rather than as not yet due.',
          'Debit notes raised against a supplier are not netted off here.',
        ],
      },
    }
  },
}
