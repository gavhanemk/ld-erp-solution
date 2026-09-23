import type { PurchaseNoteReason } from '@prisma/client'
import type { Matrix, Panel, ReportDefinition } from '../types'
import { dateRangeFilters, mean, ratio, round2, supplierFilter } from './shared'
import {
  GOODS_FAILURE_REASONS,
  NOTE_REASON_WORDS,
  locationFilter,
  noteWhere,
  postedOnlyFilter,
  taxOf,
} from './note-shared'

/**
 * Why the mill loses money on what it buys, ranked.
 *
 * The only report here whose rows are not documents. One row per reason, so
 * the sheet is ten rows long and every one of them is a decision somebody
 * could act on: quality rejections that keep recurring are a supplier
 * conversation, rate differences that keep recurring are a purchase-order
 * conversation, and short quantities are a gate conversation. A register
 * cannot show that, because a register buries the pattern under the instances.
 *
 * **No Pivot sheet, deliberately.** A pivot over ten rows with no repeating key
 * is the same ten rows again with a Grand Total nobody asked for.
 */

export const adjustmentReasons: ReportDefinition = {
  id: 'adjustment-reasons',
  module: 'purchase',
  title: 'Reason-wise Adjustments',
  description:
    'Why purchases get adjusted, ranked by what each reason costs. Ten rows, each one a different conversation — with a supplier, with the buyer, or with the gate.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    {
      key: 'noteType',
      label: 'Document',
      type: 'select',
      options: [
        { value: 'DEBIT', label: 'Debit notes (ours)' },
        { value: 'CREDIT', label: "Credit notes (supplier's)" },
      ],
    },
    locationFilter,
    postedOnlyFilter,
  ],

  columns: [
    { key: 'reason', label: 'What Happened', type: 'text', width: 24 },
    { key: 'kind', label: 'Fault Lies With', type: 'text', width: 16 },
    { key: 'noteCount', label: 'Notes', type: 'integer', total: 'sum', width: 8 },
    { key: 'supplierCount', label: 'Suppliers', type: 'integer', total: 'none', width: 11 },
    { key: 'billCount', label: 'Bills', type: 'integer', total: 'none', width: 8 },
    { key: 'taxable', label: 'Taxable', type: 'money', total: 'sum' },
    { key: 'tax', label: 'Tax', type: 'money', total: 'sum' },
    { key: 'total', label: 'Total', type: 'money', total: 'sum' },
    { key: 'share', label: 'Share', type: 'percent', total: 'none', width: 9 },
    { key: 'avgNote', label: 'Average Note', type: 'money', total: 'none' },
    { key: 'postedAmount', label: 'Posted', type: 'money', total: 'sum' },
    { key: 'worstSupplier', label: 'Most Against', type: 'text', width: 28 },
  ],

  summary: {
    title: 'What each reason costs',
    columns: ['reason', 'kind', 'noteCount', 'supplierCount', 'total', 'share', 'worstSupplier'],
    by: 'total',
    limit: 12,
  },

  async run({ tx, params }) {
    const where = {
      ...noteWhere(params),
      ...(params.noteType ? { noteType: params.noteType as 'DEBIT' | 'CREDIT' } : {}),
    }

    const notes = await tx.purchaseNote.findMany({
      where,
      select: {
        reason: true,
        noteType: true,
        status: true,
        noteDate: true,
        taxableAmount: true,
        cgst: true,
        sgst: true,
        igst: true,
        totalAmount: true,
        supplier: { select: { name: true } },
        bill: { select: { billNumber: true } },
      },
    })

    const grand = round2(notes.reduce((s, n) => s + Number(n.totalAmount), 0))

    // One row per reason that actually occurred. A row of noughts for a reason
    // nobody has ever used trains the reader to skim the sheet.
    const present = [...new Set(notes.map((n) => n.reason))] as PurchaseNoteReason[]

    const rows = present
      .map((reason) => {
        const mine = notes.filter((n) => n.reason === reason)
        const total = round2(mine.reduce((s, n) => s + Number(n.totalAmount), 0))

        const bySupplier = new Map<string, number>()
        for (const n of mine) {
          bySupplier.set(
            n.supplier.name,
            (bySupplier.get(n.supplier.name) ?? 0) + Number(n.totalAmount)
          )
        }
        const worst = [...bySupplier.entries()].sort((a, b) => b[1] - a[1])[0]

        return {
          reason: NOTE_REASON_WORDS[reason],
          kind: GOODS_FAILURE_REASONS.includes(reason) ? 'The goods' : 'The billing',
          noteCount: mine.length,
          supplierCount: bySupplier.size,
          billCount: new Set(mine.map((n) => n.bill?.billNumber).filter(Boolean)).size,
          taxable: round2(mine.reduce((s, n) => s + Number(n.taxableAmount), 0)),
          tax: round2(mine.reduce((s, n) => s + taxOf(n), 0)),
          total,
          share: ratio(total, grand) ?? 0,
          avgNote: mean(total, mine.length) ?? 0,
          postedAmount: round2(
            mine.filter((n) => n.status === 'POSTED').reduce((s, n) => s + Number(n.totalAmount), 0)
          ),
          worstSupplier: worst ? `${worst[0]} (₹${round2(worst[1]).toLocaleString('en-IN')})` : '',
          _reason: reason,
        }
      })
      .sort((a, b) => b.total - a.total)

    const goods = round2(
      rows.filter((r) => r.kind === 'The goods').reduce((s, r) => s + r.total, 0)
    )
    const billing = round2(
      rows.filter((r) => r.kind === 'The billing').reduce((s, r) => s + r.total, 0)
    )

    // ── The grid: reason against supplier ───────────────────────────────────
    const suppliers = [
      ...notes.reduce((m, n) => {
        m.set(n.supplier.name, (m.get(n.supplier.name) ?? 0) + Number(n.totalAmount))
        return m
      }, new Map<string, number>()),
    ]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name]) => name)

    const matrix: Matrix | undefined =
      rows.length > 1 && suppliers.length > 1
        ? {
            title: 'Which supplier each reason is really about',
            rowLabel: 'What happened',
            columns: suppliers,
            rows: rows.map((r) => ({
              label: r.reason,
              values: suppliers.map((s) => {
                const v = round2(
                  notes
                    .filter((n) => n.reason === r._reason && n.supplier.name === s)
                    .reduce((x, n) => x + Number(n.totalAmount), 0)
                )
                // Null rather than nought: this never happened with that
                // supplier, which is an absence and not a measurement of zero.
                return v > 0 ? v : null
              }),
            })),
            format: 'money',
          }
        : undefined

    // ── What the figures say ────────────────────────────────────────────────
    const insights: string[] = []
    const top = rows[0]
    if (top) {
      insights.push(
        `${top.reason} is the biggest single cause — ₹${top.total.toLocaleString('en-IN')} across ${top.noteCount} notes and ${top.supplierCount} ${top.supplierCount === 1 ? 'supplier' : 'suppliers'}.`
      )
      if (top.supplierCount === 1) {
        insights.push(
          `All of it is against one supplier: ${top.worstSupplier}. That is a conversation, not a process.`
        )
      } else {
        insights.push(
          `It is spread across ${top.supplierCount} suppliers, so it is a process problem rather than one supplier's.`
        )
      }
    }
    if (goods > 0 && billing > 0) {
      insights.push(
        goods > billing
          ? `More is lost to the goods themselves (₹${goods.toLocaleString('en-IN')}) than to billing mistakes (₹${billing.toLocaleString('en-IN')}). That points at inspection and at who is being bought from.`
          : `More is lost to billing mistakes (₹${billing.toLocaleString('en-IN')}) than to the goods (₹${goods.toLocaleString('en-IN')}). That points at the order rates and at what is checked before a bill is booked.`
      )
    }
    const recurring = rows.filter((r) => r.noteCount >= 3)
    if (recurring.length) {
      insights.push(
        `${recurring.length} ${recurring.length === 1 ? 'reason has' : 'reasons have'} come up three times or more: ${recurring.map((r) => r.reason.toLowerCase()).join(', ')}. A thing that happens once is bad luck.`
      )
    }
    if (rows.length === 0) {
      insights.push('Nothing was adjusted in this period.')
    }

    return {
      rows: rows.map(({ _reason, ...r }) => r),
      analysis: {
        headline:
          rows.length === 0
            ? 'Nothing was adjusted in this period.'
            : `₹${grand.toLocaleString('en-IN')} adjusted across ${rows.length} ${rows.length === 1 ? 'reason' : 'different reasons'} and ${notes.length} notes.`,
        kpis: [
          {
            label: 'Adjusted in all',
            value: rows.length ? grand : null,
            format: 'money',
            basis: `${notes.length} notes across ${rows.length} reasons`,
          },
          {
            label: 'Blamed on the goods',
            value: goods || null,
            format: 'money',
            basis:
              grand > 0 ? `${Math.round((goods / grand) * 100)}% of the total` : 'nothing adjusted',
            tone: goods > billing ? 'warn' : undefined,
          },
          {
            label: 'Blamed on the billing',
            value: billing || null,
            format: 'money',
            basis:
              grand > 0
                ? `${Math.round((billing / grand) * 100)}% of the total`
                : 'nothing adjusted',
            tone: billing > goods ? 'warn' : undefined,
          },
          {
            label: 'Most common cause',
            value: top ? top.noteCount : null,
            format: 'integer',
            basis: top
              ? `${top.reason.toLowerCase()}, worth ₹${top.total.toLocaleString('en-IN')}`
              : 'nothing adjusted',
          },
        ],
        matrix,
        panels: (
          [
            {
              title: 'What each reason costs',
              question: 'ranking',
              format: 'money',
              points: rows.map((r) => ({ label: r.reason, value: r.total })),
            },
            {
              title: 'Share of everything adjusted',
              question: 'composition',
              format: 'money',
              points: [
                ...rows.slice(0, 4).map((r) => ({ label: r.reason, value: r.total })),
                // Excel rebases a doughnut's percentages over the points it is
                // given, so a top-four share without an "everything else"
                // slice prints figures that contradict the ranking beside it.
                ...(rows.length > 4
                  ? [
                      {
                        label: 'Everything else',
                        value: round2(rows.slice(4).reduce((s, r) => s + r.total, 0)),
                      },
                    ]
                  : []),
              ],
            },
            {
              /*
               * How often against how much.
               *
               * The two do not move together, and the gap is the finding: a
               * reason with many small notes is a process bleeding steadily,
               * and one with a single large note is an incident. They need
               * different answers, and a value ranking alone hides which is
               * which.
               */
              title: 'How often each one happens',
              question: 'ranking',
              format: 'integer',
              points: [...rows]
                .sort((a, b) => b.noteCount - a.noteCount)
                .map((r) => ({ label: r.reason, value: r.noteCount })),
              note: 'Compare with the chart above: many small notes is a process, one large note is an incident.',
            },
            {
              title: 'Where the fault lies',
              question: 'composition',
              format: 'money',
              points: [
                { label: 'The goods themselves', value: goods, tone: 'bad' as const },
                { label: 'What was billed', value: billing, tone: 'info' as const },
              ].filter((p) => p.value > 0),
            },
            {
              title: 'What has actually come off a bill',
              question: 'split',
              format: 'money',
              points: rows.map((r) => ({ label: r.reason, value: r.total })),
              series: [
                { name: 'Posted', tone: 'good', values: rows.map((r) => r.postedAmount) },
                {
                  name: 'Still waiting',
                  tone: 'warn',
                  values: rows.map((r) => round2(r.total - r.postedAmount)),
                },
              ],
            },
          ] as Panel[]
        ).filter((p) => p.points.length > 0),
        insights,
        caveats: [
          'One row per reason that actually occurred. A reason nobody has used is not listed rather than listed at nought.',
          'Cancelled and refused notes are excluded — they cost nothing.',
          '"Fault lies with" is a fixed grouping of the reasons, not a judgement made per note: returns, damage, rejections, wrong material and short supply are the goods; everything else is the billing.',
          'There is no Pivot sheet. A pivot over ten rows with no repeating key is the same ten rows with a Grand Total added.',
        ],
      },
    }
  },
}
