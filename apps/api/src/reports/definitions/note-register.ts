import type { PurchaseNoteReason, PurchaseNoteStatus, PurchaseNoteType } from '@prisma/client'
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
  noteWhere,
  postedOnlyFilter,
  reasonFilter,
  sizeFilter,
  statusColumn,
  taxOf,
  waitingDays,
} from './note-shared'

/**
 * The register of debit or credit notes — one factory, two reports.
 *
 * They hold the same columns, run the same query and ask the same questions of
 * it; what differs is which document they are about and therefore how the
 * sentences read. Two files would have been two of everything, drifting from
 * the first change only one of them got — the same argument that made the
 * screens and the router shared.
 *
 * ── What the sheet is for ───────────────────────────────────────────────────
 *
 * Not "how much did we claim". That is one number and it does not need a
 * workbook. It is **what is stuck**: a claim sitting in draft was never made,
 * one approved and not posted has been agreed by everybody and has still not
 * come off the bill, and both of those are money the mill has decided it is
 * owed and has not collected. Those are the exceptions at the top, and they
 * are the reason this report exists rather than a list screen.
 */

function noteRegister(noteType: PurchaseNoteType): ReportDefinition {
  const debit = noteType === 'DEBIT'
  const one = debit ? 'debit note' : 'credit note'
  const many = debit ? 'debit notes' : 'credit notes'

  return {
    id: debit ? 'debit-note-register' : 'credit-note-register',
    module: 'purchase',
    title: debit ? 'Debit Note Register' : 'Credit Note Register',
    description: debit
      ? 'Every claim raised against a supplier — what for, how much, and how far it has got. The block at the top is what is stuck: claimed and never sent, or agreed and never taken off the bill.'
      : 'Every credit a supplier has granted, and whether it has reached the bill it belongs to. A credit recorded and not posted is a reduction the mill has been given and has not taken.',
    filters: [
      ...dateRangeFilters,
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
      { key: 'noteNumber', label: 'Note No.', type: 'text', width: 16 },
      { key: 'noteDate', label: 'Date', type: 'date', width: 13 },
      { key: 'supplier', label: 'Supplier', type: 'text', width: 28 },
      { key: 'billNumber', label: 'Against Bill', type: 'text', width: 16 },
      { key: 'supplierInvoiceNo', label: 'Their Bill No.', type: 'text', width: 17 },
      ...(debit
        ? []
        : [
            {
              key: 'supplierDocNo',
              label: 'Their Note No.',
              type: 'text' as const,
              width: 17,
            },
          ]),
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
      title: debit ? 'Biggest claims in this period' : 'Biggest credits in this period',
      columns: ['noteDate', 'noteNumber', 'supplier', 'reason', 'total', 'status', 'waiting'],
      by: 'total',
      limit: 12,
    },

    /**
     * By supplier and reason, with status on a slicer.
     *
     * Nested that way round because the question a buyer asks is "what is this
     * supplier costing us, and why" — supplier first, reason underneath. The
     * other way round answers a question nobody asked.
     */
    pivot: {
      rows: ['supplier', 'reason'],
      values: ['total', 'taxable', 'lines'],
      slicers: ['status', 'reason'],
      note: `${debit ? 'What is being claimed back' : 'What has been granted'}, by supplier and then by what happened. Collapse a supplier to read their total.`,
    },

    async run({ tx, params, rowCap }) {
      const where = noteWhere(params, noteType)

      const totalRows = await tx.purchaseNote.count({ where })
      const notes = await tx.purchaseNote.findMany({
        where,
        take: rowCap,
        orderBy: [{ noteDate: 'desc' }, { noteNumber: 'desc' }],
        select: noteSelect,
      })

      const rows = notes.map((n) => ({
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

      const months = byMonth(
        notes,
        (n) => n.noteDate,
        (n) => Number(n.totalAmount)
      )

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
          label: debit ? 'Claimed but never sent' : 'Recorded but never submitted',
          value: draftAmount || null,
          format: 'money',
          basis: `${drafts.length} still in draft`,
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
          `No ${many} in this period. Either nothing went wrong, or nothing was written down.`
        )
      }

      return {
        rows,
        totalRows: notes.length >= rowCap ? totalRows : undefined,
        analysis: {
          headline:
            rows.length === 0
              ? `No ${many} on record for this period.`
              : `₹${claimed.toLocaleString('en-IN')} across ${rows.length} ${rows.length === 1 ? one : many}, of which ₹${postedAmount.toLocaleString('en-IN')} has reached a bill.`,
          exceptions,
          kpis: [
            {
              label: debit ? 'Claimed in all' : 'Granted in all',
              value: rows.length ? claimed : null,
              format: 'money',
              basis: `across ${rows.length} ${rows.length === 1 ? one : many}`,
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
              label: `Average ${one}`,
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
                  title: `${debit ? 'What was claimed' : 'What was granted'}, month by month`,
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
}

export const debitNoteRegister = noteRegister('DEBIT')
export const creditNoteRegister = noteRegister('CREDIT')
