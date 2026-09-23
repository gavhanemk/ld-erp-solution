import type { PurchaseNoteReason } from '@prisma/client'
import type { Matrix, Panel, ReportDefinition } from '../types'
import {
  dateRangeFilters,
  itemFilter,
  round2,
  searchFilter,
  supplierFilter,
  topWithRest,
} from './shared'
import {
  GOODS_FAILURE_REASONS,
  NOTE_REASON_WORDS,
  NOTE_TYPE_WORDS,
  locationFilter,
  noteSelect,
  noteStatusFilter,
  noteWhere,
  postedOnlyFilter,
  reasonFilter,
  signedEffect,
  sizeFilter,
  statusColumn,
  taxOf,
} from './note-shared'

/**
 * Supplier → bill → note → reason → amount, which is the chain somebody walks
 * when they are deciding whether to keep buying from a supplier.
 *
 * It carries **both** documents, which is what makes it different from the two
 * registers: a supplier who sends their own credit note the moment a fault is
 * reported is a different proposition from one who has to be chased with a
 * debit note, and neither register can show you that because each holds only
 * half of it.
 *
 * The heat map is the point of the sheet. A ranking says who cost most; the
 * grid says *what kind* of trouble each one is — a column that lights up under
 * Quality rejection is a different conversation from one under Wrong rate
 * charged, and one is about the goods while the other is about the office.
 */

export const supplierAdjustments: ReportDefinition = {
  id: 'supplier-adjustments',
  module: 'purchase',
  title: 'Supplier-wise Adjustments',
  description:
    'Every debit and credit note, supplier first, down to the bill and the reason. Answers which suppliers cost the most in returns and claims — and whether the fault is in the goods or in the paperwork.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    reasonFilter,
    noteStatusFilter,
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
    itemFilter,
    sizeFilter,
    postedOnlyFilter,
    searchFilter,
  ],

  columns: [
    { key: 'supplier', label: 'Supplier', type: 'text', width: 28 },
    { key: 'supplierCode', label: 'Code', type: 'text', width: 12 },
    { key: 'billNumber', label: 'Bill', type: 'text', width: 16 },
    { key: 'supplierInvoiceNo', label: 'Their Bill No.', type: 'text', width: 17 },
    { key: 'billValue', label: 'Bill Value', type: 'money', total: 'none' },
    { key: 'noteNumber', label: 'Note', type: 'text', width: 16 },
    { key: 'noteType', label: 'Document', type: 'text', width: 13 },
    { key: 'noteDate', label: 'Note Date', type: 'date', width: 13 },
    { key: 'reason', label: 'What Happened', type: 'text', width: 22 },
    { key: 'taxable', label: 'Taxable', type: 'money', total: 'sum' },
    { key: 'tax', label: 'Tax', type: 'money', total: 'sum' },
    { key: 'total', label: 'Note Total', type: 'money', total: 'sum' },
    {
      key: 'effect',
      label: 'Against Payable',
      type: 'money',
      total: 'sum',
      // Signed, so the column adds up to the net movement rather than to the
      // sum of two things pulling opposite ways.
    },
    statusColumn,
  ],

  summary: {
    title: 'Largest adjustments, whoever they are against',
    columns: ['supplier', 'billNumber', 'noteNumber', 'reason', 'noteType', 'total', 'status'],
    by: 'total',
    limit: 12,
  },

  pivot: {
    rows: ['supplier', 'billNumber'],
    values: ['total', 'taxable', 'effect'],
    slicers: ['reason', 'noteType', 'status'],
    note: 'Supplier, then the bill each note is against. Collapse a supplier to read what they have cost in all; the slicers narrow it to one kind of trouble.',
  },

  async run({ tx, params, rowCap }) {
    const where = {
      ...noteWhere(params),
      ...(params.noteType ? { noteType: params.noteType as 'DEBIT' | 'CREDIT' } : {}),
    }

    const totalRows = await tx.purchaseNote.count({ where })
    const notes = await tx.purchaseNote.findMany({
      where,
      take: rowCap,
      // Supplier first, because that is the order the sheet is read in. The
      // date inside it, so one supplier's notes run newest to oldest.
      orderBy: [{ supplier: { name: 'asc' } }, { noteDate: 'desc' }],
      select: noteSelect,
    })

    const rows = notes.map((n) => ({
      supplier: n.supplier.name,
      supplierCode: n.supplier.code,
      billNumber: n.bill?.billNumber ?? '',
      supplierInvoiceNo: n.bill?.supplierInvoiceNo ?? '',
      billValue: n.bill ? round2(Number(n.bill.totalAmount)) : 0,
      noteNumber: n.noteNumber,
      noteType: NOTE_TYPE_WORDS[n.noteType],
      noteDate: n.noteDate,
      reason: NOTE_REASON_WORDS[n.reason],
      taxable: round2(Number(n.taxableAmount)),
      tax: taxOf(n),
      total: round2(Number(n.totalAmount)),
      effect: signedEffect(n),
      status: n.status,
    }))

    // ── Per supplier ────────────────────────────────────────────────────────
    interface Tally {
      name: string
      total: number
      debit: number
      credit: number
      goodsFault: number
      paperFault: number
      notes: number
      bills: Set<string>
    }

    const bySupplier = new Map<string, Tally>()
    for (const n of notes) {
      const key = n.supplier.name
      const t =
        bySupplier.get(key) ??
        ({
          name: key,
          total: 0,
          debit: 0,
          credit: 0,
          goodsFault: 0,
          paperFault: 0,
          notes: 0,
          bills: new Set<string>(),
        } as Tally)
      const v = Number(n.totalAmount)
      t.total += v
      t.notes += 1
      if (n.noteType === 'DEBIT') t.debit += v
      else t.credit += v
      if (GOODS_FAILURE_REASONS.includes(n.reason)) t.goodsFault += v
      else t.paperFault += v
      if (n.bill) t.bills.add(n.bill.billNumber)
      bySupplier.set(key, t)
    }

    const tallies = [...bySupplier.values()].sort((a, b) => b.total - a.total)
    const claimed = round2(notes.reduce((s, n) => s + Number(n.totalAmount), 0))
    const goodsFault = round2(tallies.reduce((s, t) => s + t.goodsFault, 0))
    const paperFault = round2(tallies.reduce((s, t) => s + t.paperFault, 0))

    const debitTotal = round2(
      notes.filter((n) => n.noteType === 'DEBIT').reduce((s, n) => s + Number(n.totalAmount), 0)
    )
    const creditTotal = round2(
      notes.filter((n) => n.noteType === 'CREDIT').reduce((s, n) => s + Number(n.totalAmount), 0)
    )

    // ── The grid ────────────────────────────────────────────────────────────
    //
    // Only reasons that actually occur, and only the suppliers worth a row —
    // a grid of forty names against ten columns is a wall, not a reading.
    const liveReasons = [...new Set(notes.map((n) => n.reason))].sort(
      (a, b) =>
        notes.filter((n) => n.reason === b).reduce((s, n) => s + Number(n.totalAmount), 0) -
        notes.filter((n) => n.reason === a).reduce((s, n) => s + Number(n.totalAmount), 0)
    ) as PurchaseNoteReason[]

    const gridSuppliers = tallies.slice(0, 12)

    const matrix: Matrix | undefined =
      gridSuppliers.length > 1 && liveReasons.length > 1
        ? {
            title: 'What kind of trouble each supplier is',
            rowLabel: 'Supplier',
            columns: liveReasons.map((r) => NOTE_REASON_WORDS[r]),
            rows: gridSuppliers.map((t) => ({
              label: t.name,
              values: liveReasons.map((r) => {
                const v = round2(
                  notes
                    .filter((n) => n.supplier.name === t.name && n.reason === r)
                    .reduce((s, n) => s + Number(n.totalAmount), 0)
                )
                // Null, not nought. A supplier this has never happened to is
                // an absence; a nought is a claim that it was measured at zero.
                return v > 0 ? v : null
              }),
            })),
            format: 'money',
          }
        : undefined

    // ── What the figures say ────────────────────────────────────────────────
    const insights: string[] = []
    const worst = tallies[0]
    if (worst) {
      insights.push(
        `${worst.name} accounts for ₹${round2(worst.total).toLocaleString('en-IN')} across ${worst.notes} notes on ${worst.bills.size} bills — ${claimed > 0 ? Math.round((worst.total / claimed) * 100) : 0}% of everything here.`
      )
    }
    if (goodsFault > 0 && paperFault > 0) {
      insights.push(
        `₹${goodsFault.toLocaleString('en-IN')} is about the goods themselves and ₹${paperFault.toLocaleString('en-IN')} is about what was billed. The first is a supplier problem; the second is usually ours to fix.`
      )
    }
    if (creditTotal > 0 && debitTotal > 0) {
      insights.push(
        `Suppliers granted ₹${creditTotal.toLocaleString('en-IN')} of their own accord against ₹${debitTotal.toLocaleString('en-IN')} the mill had to claim.`
      )
    } else if (debitTotal > 0 && creditTotal === 0) {
      insights.push(
        'Every adjustment here was raised by the mill. No supplier issued a credit note of their own.'
      )
    }
    const chased = tallies.filter((t) => t.debit > 0 && t.credit === 0)
    if (chased.length && tallies.length > 1) {
      insights.push(
        `${chased.length} of ${tallies.length} suppliers have only ever been adjusted by a note the mill raised.`
      )
    }

    return {
      rows,
      totalRows: notes.length >= rowCap ? totalRows : undefined,
      analysis: {
        headline:
          rows.length === 0
            ? 'No adjustments against any supplier in this period.'
            : `₹${claimed.toLocaleString('en-IN')} adjusted across ${tallies.length} ${tallies.length === 1 ? 'supplier' : 'suppliers'} and ${rows.length} notes.`,
        kpis: [
          {
            label: 'Adjusted in all',
            value: rows.length ? claimed : null,
            format: 'money',
            basis: `${rows.length} notes across ${tallies.length} suppliers`,
          },
          {
            label: 'About the goods',
            value: goodsFault || null,
            format: 'money',
            basis:
              claimed > 0
                ? `${Math.round((goodsFault / claimed) * 100)}% of the total`
                : 'nothing adjusted',
            tone: goodsFault > paperFault ? 'warn' : undefined,
          },
          {
            label: 'About the billing',
            value: paperFault || null,
            format: 'money',
            basis:
              claimed > 0
                ? `${Math.round((paperFault / claimed) * 100)}% of the total`
                : 'nothing adjusted',
          },
          {
            label: 'Granted by the supplier',
            value: creditTotal || null,
            format: 'money',
            basis: `against ₹${debitTotal.toLocaleString('en-IN')} the mill claimed`,
            tone: creditTotal > 0 ? 'good' : undefined,
          },
        ],
        matrix,
        panels: (
          [
            {
              title: 'Which suppliers cost most',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                tallies.map((t) => ({ label: t.name, value: round2(t.total) })),
                10
              ),
            },
            {
              /*
               * The same ranking, split by who raised the paper.
               *
               * A supplier whose bar is mostly credit notes is one who fixes
               * things without being chased. Sitting inside one bar with
               * everybody else, that is invisible.
               */
              title: 'Who raised the paper',
              question: 'split',
              format: 'money',
              points: tallies.slice(0, 10).map((t) => ({ label: t.name, value: round2(t.total) })),
              series: [
                {
                  name: 'We claimed it',
                  tone: 'warn',
                  values: tallies.slice(0, 10).map((t) => round2(t.debit)),
                },
                {
                  name: 'They granted it',
                  tone: 'good',
                  values: tallies.slice(0, 10).map((t) => round2(t.credit)),
                },
              ],
              note: 'A bar that is mostly green is a supplier who puts things right without being chased.',
            },
            {
              title: 'Goods, or paperwork',
              question: 'split',
              format: 'money',
              points: tallies.slice(0, 10).map((t) => ({ label: t.name, value: round2(t.total) })),
              series: [
                {
                  name: 'The goods themselves',
                  tone: 'bad',
                  values: tallies.slice(0, 10).map((t) => round2(t.goodsFault)),
                },
                {
                  name: 'What was billed',
                  tone: 'info',
                  values: tallies.slice(0, 10).map((t) => round2(t.paperFault)),
                },
              ],
              note: 'Returns, damage, rejections and short supply are the goods. Rates, over-billing and discounts are the paperwork.',
            },
            {
              title: 'How few suppliers it sits with',
              question: 'pareto',
              format: 'money',
              points: topWithRest(
                tallies.map((t) => ({ label: t.name, value: round2(t.total) })),
                9
              ),
              note: 'The line is the share reached by that supplier and every bigger one, so it ends at 100%.',
            },
          ] as Panel[]
        ).filter((p) => p.points.length > 0),
        insights,
        caveats: [
          'Cancelled and refused notes are left out. Ask for that status explicitly to see them.',
          '"Against payable" is signed — a note that increases what we owe subtracts, so the column totals the net movement rather than the sum of two opposing figures.',
          'The grid shows the twelve suppliers with the most against them. Everyone else is on the Data sheet.',
          'A supplier with nothing here either delivered cleanly or was never checked.',
        ],
      },
    }
  },
}
