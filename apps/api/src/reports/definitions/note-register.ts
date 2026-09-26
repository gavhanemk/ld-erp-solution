import type { PurchaseAdjustmentDoc, PurchaseNoteReason, PurchaseNoteStatus } from '@prisma/client'
import type { Exception, Panel, ReportDefinition } from '../types'
import {
  byMonth,
  dateRangeFilters,
  itemFilter,
  mean,
  round2,
  searchFilter,
  supplierFilter,
  topWithRest,
} from './shared'
import {
  NOTE_REASON_WORDS,
  NOTE_STATUS_WORDS,
  locationFilter,
  noteSelect,
  noteStatusFilter,
  noteTypeFilter,
  noteWhere,
  postedOnlyFilter,
  reasonFilter,
  sizeFilter,
  statusColumn,
  taxOf,
  typeColumn,
  waitingDays,
} from './note-shared'

/**
 * The register of debit and credit notes together.
 *
 * They used to be two reports built off one factory — same columns, same
 * query, different document. That was right until somebody wanted to look
 * at what the purchase side is claiming AND what suppliers are granting in
 * one sitting, which the split never let them do: a debit note that reduced
 * a supplier's payable and a credit note that did the same sat in two files
 * with no figure that added the two together. One report, with a Type
 * column doing the work the filename used to.
 *
 * ── What the sheet is for ───────────────────────────────────────────────────
 *
 * Not "how much did we claim" or "how much were we granted" — either of
 * those is one number and does not need a workbook. It is **what is
 * stuck**: a note sitting in draft was never sent, one approved and not
 * posted has been agreed by everybody and still has not come off the bill,
 * and both of those are money the mill believes is settled and has not
 * actually moved. Those are the exceptions at the top, and they are the
 * reason this report exists rather than a list screen.
 */

/*
 * Split by direction, not by the document's name.
 *
 * It used to be debit-versus-credit, which held only while both kinds came
 * off the bill. A supplier's debit note is a debit note that ADDS to what we
 * owe, so the old pair silently added an increase to a reduction and called
 * the sum "claimed". What a reader of this register wants is the two
 * directions, and `effect` is the column that carries them.
 */
const reducesAmount = (n: { effect: string; totalAmount: unknown }) =>
  n.effect === 'REDUCES_PAYABLE' ? Number(n.totalAmount) : 0
const increasesAmount = (n: { effect: string; totalAmount: unknown }) =>
  n.effect === 'INCREASES_PAYABLE' ? Number(n.totalAmount) : 0

export const noteRegister: ReportDefinition = {
  id: 'note-register',
  module: 'purchase',
  title: 'Purchase Adjustment Register',
  description:
    'Every adjustment against a supplier bill in one register — our own claims, their credit notes and their debit notes — what for, how much, which way it moves the money, against which bill, and how far each has got toward actually changing what is owed.',
  filters: [
    ...dateRangeFilters,
    noteTypeFilter,
    supplierFilter,
    reasonFilter,
    noteStatusFilter,
    locationFilter,
    itemFilter,
    sizeFilter,
    postedOnlyFilter,
    searchFilter,
  ],

  columns: [
    typeColumn,
    { key: 'noteNumber', label: 'Note No.', type: 'text', width: 16 },
    { key: 'noteDate', label: 'Date', type: 'date', width: 13 },
    { key: 'supplier', label: 'Supplier', type: 'text', width: 28 },
    { key: 'billNumber', label: 'Against Bill', type: 'text', width: 16 },
    { key: 'supplierInvoiceNo', label: 'Their Bill No.', type: 'text', width: 17 },
    { key: 'supplierDocNo', label: 'Their Note No.', type: 'text', width: 17 },
    { key: 'reason', label: 'What Happened', type: 'text', width: 22 },
    { key: 'detail', label: 'Detail', type: 'text', width: 30 },
    { key: 'lines', label: 'Lines', type: 'integer', width: 7 },
    { key: 'taxable', label: 'Taxable', type: 'money', total: 'sum' },
    { key: 'tax', label: 'Tax', type: 'money', total: 'sum' },
    { key: 'total', label: 'Note Total', type: 'money', total: 'sum' },
    statusColumn,
    { key: 'waiting', label: 'Days Waiting', type: 'integer', width: 12 },
    { key: 'godown', label: 'Godown', type: 'text', width: 20 },
    { key: 'raisedBy', label: 'Raised By', type: 'text', width: 18 },
  ],

  summary: {
    title: 'Biggest notes in this period',
    columns: ['noteDate', 'type', 'noteNumber', 'supplier', 'total', 'status', 'waiting'],
    by: 'total',
    limit: 12,
  },

  /**
   * By type, then supplier, then reason.
   *
   * Type outermost so the reader can collapse straight to "just debit" or
   * "just credit" and read the subtotal — the question the two-report split
   * used to answer by which file was opened. Supplier next because "what is
   * this supplier costing us, and why" is the question underneath that;
   * reason is what answers it.
   */
  pivot: {
    rows: ['type', 'supplier', 'reason'],
    values: ['total', 'taxable', 'lines'],
    slicers: ['status'],
    note: 'What has been claimed and what has been granted, by type and then by supplier. Collapse a level to read its subtotal.',
  },

  async run({ tx, params, rowCap }) {
    const where = noteWhere(params, params.type as PurchaseAdjustmentDoc | undefined)

    const totalRows = await tx.purchaseNote.count({ where })
    const notes = await tx.purchaseNote.findMany({
      where,
      take: rowCap,
      orderBy: [{ noteDate: 'desc' }, { noteNumber: 'desc' }],
      select: noteSelect,
    })

    const rows = notes.map((n) => ({
      type: n.docType,
      noteNumber: n.noteNumber,
      noteDate: n.noteDate,
      supplier: n.supplier.name,
      billNumber: n.bill?.billNumber ?? '',
      supplierInvoiceNo: n.bill?.supplierInvoiceNo ?? '',
      supplierDocNo: n.supplierDocNo ?? '',
      reason: NOTE_REASON_WORDS[n.reason],
      detail: n.reasonNote ?? '',
      lines: n._count.lines,
      taxable: round2(Number(n.taxableAmount)),
      tax: taxOf(n),
      total: round2(Number(n.totalAmount)),
      status: n.status,
      waiting: waitingDays(n) ?? 0,
      godown: n.warehouse?.name ?? '',
      raisedBy: n.createdBy?.name ?? '',
    }))

    // ── The position ──────────────────────────────────────────────────────
    const claimed = round2(rows.reduce((s, r) => s + r.total, 0))
    const reducesTotal = round2(notes.reduce((s, n) => s + reducesAmount(n), 0))
    const increasesTotal = round2(notes.reduce((s, n) => s + increasesAmount(n), 0))
    const reducesNotes = notes.filter((n) => n.effect === 'REDUCES_PAYABLE')
    const increasesNotes = notes.filter((n) => n.effect === 'INCREASES_PAYABLE')

    const posted = notes.filter((n) => n.status === 'POSTED')
    const postedAmount = round2(posted.reduce((s, n) => s + Number(n.totalAmount), 0))

    const waitingNotes = notes.filter((n) => waitingDays(n) !== null)
    const waitingAmount = round2(waitingNotes.reduce((s, n) => s + Number(n.totalAmount), 0))

    const drafts = notes.filter((n) => n.status === 'DRAFT')
    const draftAmount = round2(drafts.reduce((s, n) => s + Number(n.totalAmount), 0))

    const agreedNotTaken = notes.filter((n) => n.status === 'APPROVED')
    const agreedAmount = round2(agreedNotTaken.reduce((s, n) => s + Number(n.totalAmount), 0))

    const unlinked = notes.filter((n) => !n.bill)
    const unlinkedAmount = round2(unlinked.reduce((s, n) => s + Number(n.totalAmount), 0))

    const oldestWaiting = waitingNotes.reduce((m, n) => Math.max(m, waitingDays(n) ?? 0), 0)

    // ── The cuts ──────────────────────────────────────────────────────────
    const bySupplier = new Map<string, number>()
    const byReason = new Map<PurchaseNoteReason, number>()
    const byStatus = new Map<PurchaseNoteStatus, number>()
    for (const n of notes) {
      const v = Number(n.totalAmount)
      bySupplier.set(n.supplier.name, (bySupplier.get(n.supplier.name) ?? 0) + v)
      byReason.set(n.reason, (byReason.get(n.reason) ?? 0) + v)
      byStatus.set(n.status, (byStatus.get(n.status) ?? 0) + v)
    }

    const suppliers = [...bySupplier].map(([label, value]) => ({ label, value: round2(value) }))

    /*
     * The stages, in the order a note walks them.
     *
     * Fixed rather than sorted by size, because this is a funnel: the shape
     * only means something if the bars stay in workflow order. Sorted by
     * value it would reshuffle between two runs and stop being readable.
     */
    const STAGES: PurchaseNoteStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED']
    const funnel = STAGES.map((s) => ({
      label: NOTE_STATUS_WORDS[s],
      value: round2(byStatus.get(s) ?? 0),
      tone:
        s === 'POSTED'
          ? ('good' as const)
          : s === 'DRAFT'
            ? ('neutral' as const)
            : ('warn' as const),
    })).filter((p) => p.value > 0)

    const reasonPoints = [...byReason]
      .map(([r, value]) => ({ label: NOTE_REASON_WORDS[r], value: round2(value) }))
      .sort((a, b) => b.value - a.value)

    /*
     * Months, kept as one set of keys so the debit and credit lines line up
     * point for point. Building them separately — a debit bucket off debit
     * rows, a credit bucket off credit rows — would drop a month that had
     * credit notes and no debit ones from the debit series entirely, and the
     * two lines would stop being comparable at the same label.
     */
    const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const monthKeys = [...new Set(notes.map((n) => monthKey(n.noteDate)))].sort()
    const monthLabel = (key: string) => {
      const [y, m] = key.split('-').map(Number)
      return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
    }
    const sumByMonth = (subset: typeof notes) => {
      const buckets = new Map<string, number>()
      for (const n of subset) {
        const key = monthKey(n.noteDate)
        buckets.set(key, (buckets.get(key) ?? 0) + Number(n.totalAmount))
      }
      return monthKeys.map((k) => round2(buckets.get(k) ?? 0))
    }
    const reducesByMonth = sumByMonth(reducesNotes)
    const increasesByMonth = sumByMonth(increasesNotes)
    const months = monthKeys.map((k, i) => ({
      label: monthLabel(k),
      // The net, because the two go opposite ways. Adding them would make a
      // month of heavy claims and heavy back-charges look like a busy month
      // rather than the quiet one it actually was.
      value: round2(reducesByMonth[i] - increasesByMonth[i]),
    }))

    // ── What needs a decision ─────────────────────────────────────────────
    const exceptions: Exception[] = [
      {
        label: 'Agreed but never taken off a bill',
        value: agreedAmount || null,
        format: 'money',
        basis: `${agreedNotTaken.length} ${agreedNotTaken.length === 1 ? 'note is' : 'notes are'} approved and not posted — one press away`,
        tone: 'bad',
      },
      {
        label: 'Still in draft',
        value: draftAmount || null,
        format: 'money',
        basis: `${drafts.length} ${drafts.length === 1 ? 'note' : 'notes'} not yet sent for approval`,
        tone: 'warn',
      },
      {
        label: 'Longest wait',
        value: oldestWaiting || null,
        format: 'days',
        basis: 'since the oldest unposted note was raised',
        tone: oldestWaiting > 30 ? 'bad' : 'warn',
      },
      {
        label: 'With no bill behind them',
        value: unlinkedAmount || null,
        format: 'money',
        basis: `${unlinked.length} ${unlinked.length === 1 ? 'note has' : 'notes have'} nothing to check the figure against`,
        tone: 'warn',
      },
    ]

    // ── What the figures say ──────────────────────────────────────────────
    const insights: string[] = []
    if (agreedNotTaken.length) {
      insights.push(
        `₹${agreedAmount.toLocaleString('en-IN')} has been approved and not posted. Until it is, the supplier is still shown the full bill.`
      )
    }
    if (increasesTotal > 0) {
      insights.push(
        `₹${reducesTotal.toLocaleString('en-IN')} comes off the bills and ₹${increasesTotal.toLocaleString('en-IN')} goes back on — a net ₹${round2(reducesTotal - increasesTotal).toLocaleString('en-IN')}. The second figure is suppliers billing us more after the event, not less.`
      )
    }
    const topReason = reasonPoints[0]
    if (topReason && claimed > 0) {
      insights.push(
        `${topReason.label} accounts for ₹${topReason.value.toLocaleString('en-IN')} — ${Math.round((topReason.value / claimed) * 100)}% of everything on this sheet.`
      )
    }
    const worstSupplier = [...suppliers].sort((a, b) => b.value - a.value)[0]
    if (worstSupplier && suppliers.length > 1) {
      insights.push(
        `Most of it is against ${worstSupplier.label} — ₹${worstSupplier.value.toLocaleString('en-IN')} across ${notes.filter((n) => n.supplier.name === worstSupplier.label).length} notes.`
      )
    }
    if (postedAmount > 0) {
      insights.push(
        `₹${postedAmount.toLocaleString('en-IN')} has actually come off the bills — ${claimed > 0 ? Math.round((postedAmount / claimed) * 100) : 0}% of what was raised.`
      )
    }
    if (rows.length === 0) {
      insights.push(
        'No notes in this period. Either nothing went wrong, or nothing was written down.'
      )
    }

    return {
      rows,
      totalRows: notes.length >= rowCap ? totalRows : undefined,
      analysis: {
        headline:
          rows.length === 0
            ? 'No notes on record for this period.'
            : `₹${claimed.toLocaleString('en-IN')} across ${rows.length} ${rows.length === 1 ? 'note' : 'notes'} (₹${reducesTotal.toLocaleString('en-IN')} off the bills, ₹${increasesTotal.toLocaleString('en-IN')} back on), of which ₹${postedAmount.toLocaleString('en-IN')} has reached a bill.`,
        exceptions,
        kpis: [
          {
            label: 'Coming off the bills',
            value: rows.length ? reducesTotal : null,
            format: 'money',
            basis: `${reducesNotes.length} ${reducesNotes.length === 1 ? 'adjustment' : 'adjustments'}`,
          },
          {
            label: 'Going back on',
            value: rows.length ? increasesTotal : null,
            format: 'money',
            basis: `${increasesNotes.length} ${increasesNotes.length === 1 ? 'adjustment' : 'adjustments'}`,
            // Only ever a warning or nothing. A Kpi has no neutral tone,
            // and an increase is the figure worth noticing here.
            ...(increasesTotal > 0 ? { tone: 'warn' as const } : {}),
          },
          {
            label: 'Actually off the bills',
            value: rows.length ? postedAmount : null,
            format: 'money',
            basis: `${posted.length} of ${rows.length} posted`,
            tone: posted.length === rows.length ? 'good' : 'warn',
          },
          {
            label: 'Still waiting',
            value: waitingAmount || null,
            format: 'money',
            basis: `${waitingNotes.length} ${waitingNotes.length === 1 ? 'note has' : 'notes have'} not reached a bill`,
            tone: waitingAmount > 0 ? 'warn' : 'good',
          },
          {
            label: 'Average note',
            value: mean(claimed, rows.length),
            format: 'money',
            basis: rows.length
              ? `₹${claimed.toLocaleString('en-IN')} over ${rows.length}`
              : 'nothing raised',
          },
        ],
        trend:
          months.length > 1
            ? {
                title: 'What was raised, month by month',
                valueLabel: 'Note value',
                format: 'money',
                points: months,
              }
            : undefined,
        panels: (
          [
            {
              title: 'How far each stage has got',
              question: 'funnel',
              format: 'money',
              points: funnel,
              note: 'In workflow order, not by size. Only the last bar has changed what a supplier is owed.',
            },
            ...(monthKeys.length > 1 && reducesTotal > 0 && increasesTotal > 0
              ? [
                  {
                    title: 'Off the bills and back on, month by month',
                    question: 'split',
                    format: 'money',
                    points: months,
                    series: [
                      { name: 'Off the bills', values: reducesByMonth },
                      { name: 'Back on', tone: 'normal' as const, values: increasesByMonth },
                    ],
                  },
                ]
              : []),
            {
              title: 'What went wrong, by value',
              question: 'ranking',
              format: 'money',
              points: reasonPoints,
            },
            {
              title: 'Which suppliers it is against',
              question: 'ranking',
              format: 'money',
              points: topWithRest(suppliers, 8),
            },
            {
              title: 'Share by reason',
              question: 'composition',
              format: 'money',
              points: topWithRest(reasonPoints, 4),
            },
            {
              /*
               * The reasons, split by whether the money has actually moved.
               *
               * A reason with a tall bar and nothing posted is a claim the
               * mill keeps raising and never collecting, which is a
               * different problem from one that is simply large.
               */
              title: 'What has landed on a bill, and what has not',
              question: 'split',
              format: 'money',
              points: reasonPoints,
              series: [
                {
                  name: 'Posted',
                  tone: 'good',
                  values: reasonPoints.map((p) =>
                    round2(
                      notes
                        .filter(
                          (n) => NOTE_REASON_WORDS[n.reason] === p.label && n.status === 'POSTED'
                        )
                        .reduce((s, n) => s + Number(n.totalAmount), 0)
                    )
                  ),
                },
                {
                  name: 'Still waiting',
                  tone: 'warn',
                  values: reasonPoints.map((p) =>
                    round2(
                      notes
                        .filter(
                          (n) => NOTE_REASON_WORDS[n.reason] === p.label && n.status !== 'POSTED'
                        )
                        .reduce((s, n) => s + Number(n.totalAmount), 0)
                    )
                  ),
                },
              ],
            },
            {
              title: 'How few suppliers it sits with',
              question: 'pareto',
              format: 'money',
              points: topWithRest(suppliers, 9),
              note: 'The line is the share reached by that supplier and every bigger one, so it ends at 100%.',
            },
          ] as Panel[]
        ).filter((p) => p.points.length > 0),
        insights,
        caveats: [
          'Cancelled and refused notes are left out — they claim nothing. Ask for that status explicitly to see them.',
          'Only a posted note has changed what a supplier is owed. Everything else on this sheet is an intention.',
          `"Days waiting" is blank for anything posted, cancelled or refused — those are not waiting on anybody.`,
          'A note raised with no bill behind it was never checked against what was charged.',
        ],
      },
    }
  },
}
