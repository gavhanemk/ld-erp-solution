import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition } from '../types'
import {
  byMonth,
  dateRangeFilters,
  mean,
  ratio,
  round2,
  searchFilter,
  supplierFilter,
  topWithRest,
} from './shared'
import { NOTE_REASON_WORDS, STANDING, reasonFilter } from './note-shared'

/**
 * Purchase invoice → original amount → adjustments → net.
 *
 * The one report here that counts in bills rather than in notes, which is what
 * makes it the one an accounts desk reads before paying anybody. A note
 * register answers "what have we claimed". This answers the question that
 * actually stops a cheque going out: **is this bill still worth what it says
 * on it.**
 *
 * The distinction that matters on this sheet is between an adjustment that has
 * been posted and one that has not. A posted note has already come off the
 * balance and the bill is correct as it stands. An unposted one has not — so a
 * bill showing ₹1,00,000 owed with ₹12,000 agreed and unposted is a bill about
 * to be overpaid by twelve thousand rupees, and nothing else in the ERP says so
 * on one line.
 */

export const purchaseAdjustments: ReportDefinition = {
  id: 'purchase-adjustments',
  module: 'purchase',
  title: 'Purchase Adjustment Report',
  description:
    'Every bill that has been adjusted: what it was billed at, what has come off it, what is still to come off, and what is genuinely owed. Read this before paying — a bill with an agreed adjustment still unposted is a bill about to be overpaid.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    reasonFilter,
    {
      key: 'unpostedOnly',
      label: 'At risk of overpayment',
      type: 'boolean',
      help: 'Only bills carrying an adjustment that has not been posted yet',
    },
    {
      key: 'openOnly',
      label: 'Unpaid only',
      type: 'boolean',
      help: 'Hide bills that have already been settled',
    },
    searchFilter,
  ],

  columns: [
    { key: 'billNumber', label: 'Our Ref', type: 'text', width: 16 },
    { key: 'supplierInvoiceNo', label: 'Their Bill No.', type: 'text', width: 17 },
    { key: 'billDate', label: 'Bill Date', type: 'date', width: 13 },
    { key: 'supplier', label: 'Supplier', type: 'text', width: 28 },
    { key: 'original', label: 'Billed', type: 'money', total: 'sum' },
    { key: 'postedOff', label: 'Taken Off', type: 'money', total: 'sum' },
    { key: 'pending', label: 'Agreed, Not Taken', type: 'money', total: 'sum' },
    { key: 'netPayable', label: 'Really Owed', type: 'money', total: 'sum' },
    { key: 'paid', label: 'Paid', type: 'money', total: 'sum' },
    { key: 'balance', label: 'Balance Shown', type: 'money', total: 'sum' },
    { key: 'overpayRisk', label: 'At Risk', type: 'money', total: 'sum' },
    { key: 'adjustPct', label: 'Adjusted', type: 'percent', total: 'none', width: 11 },
    { key: 'noteCount', label: 'Notes', type: 'integer', width: 8 },
    { key: 'reasons', label: 'What Happened', type: 'text', width: 30 },
  ],

  summary: {
    title: 'Bills with the most taken off them',
    columns: [
      'billDate',
      'billNumber',
      'supplier',
      'original',
      'postedOff',
      'pending',
      'netPayable',
    ],
    by: 'postedOff',
    limit: 12,
  },

  pivot: {
    rows: ['supplier', 'billNumber'],
    values: ['original', 'postedOff', 'pending', 'netPayable'],
    slicers: ['supplier'],
    note: 'What each supplier billed against what is really owed, bill by bill. Collapse a supplier for their total.',
  },

  async run({ tx, params, rowCap }) {
    /*
     * Bills that carry at least one standing note.
     *
     * Every bill would be the purchase register again with three empty columns
     * on the end, and the sheet is about adjustment — a bill nobody has
     * adjusted has nothing to say here.
     */
    const noteWhereClause: Prisma.PurchaseNoteWhereInput = {
      status: { in: STANDING },
      ...(params.reason ? { reason: params.reason as never } : {}),
    }

    const from = params.from ? new Date(`${params.from}T00:00:00`) : undefined
    const to = params.to ? new Date(`${params.to}T23:59:59.999`) : undefined

    const where: Prisma.PurchaseInvoiceWhereInput = {
      adjustments: { some: noteWhereClause },
      ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      ...(params.openOnly === 'true' ? { status: { in: ['UNPAID', 'PARTIAL'] } } : {}),
      ...(from || to
        ? { billDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
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

    const totalRows = await tx.purchaseInvoice.count({ where })
    const bills = await tx.purchaseInvoice.findMany({
      where,
      take: rowCap,
      orderBy: [{ billDate: 'desc' }],
      select: {
        billNumber: true,
        supplierInvoiceNo: true,
        billDate: true,
        totalAmount: true,
        tdsAmount: true,
        paidAmount: true,
        noteAdjustment: true,
        balanceAmount: true,
        status: true,
        supplier: { select: { name: true } },
        adjustments: {
          where: noteWhereClause,
          select: {
            noteNumber: true,
            noteType: true,
            reason: true,
            status: true,
            effect: true,
            totalAmount: true,
          },
        },
      },
    })

    let rows = bills.map((b) => {
      const original = round2(Number(b.totalAmount))

      // Posted is read from the bill's own stored figure rather than re-added
      // from the notes: that column is what the balance was actually computed
      // from, and a sheet that recomputed it could disagree with the payable
      // it is meant to explain.
      const postedOff = round2(Number(b.noteAdjustment))

      const pending = round2(
        b.adjustments
          .filter((n) => n.status !== 'POSTED')
          .reduce(
            (s, n) => s + (n.effect === 'REDUCES_PAYABLE' ? 1 : -1) * Number(n.totalAmount),
            0
          )
      )

      const paid = round2(Number(b.paidAmount))
      const balance = round2(Number(b.balanceAmount))
      const netPayable = round2(Math.max(0, original - Number(b.tdsAmount) - postedOff - pending))

      // What would be overpaid if somebody settled the balance on screen today
      // without posting what has already been agreed.
      const overpayRisk = round2(Math.max(0, Math.min(pending, balance)))

      const reasons = [...new Set(b.adjustments.map((n) => NOTE_REASON_WORDS[n.reason]))].join(', ')

      return {
        billNumber: b.billNumber,
        supplierInvoiceNo: b.supplierInvoiceNo ?? '',
        billDate: b.billDate,
        supplier: b.supplier?.name ?? '',
        original,
        postedOff,
        pending,
        netPayable,
        paid,
        balance,
        overpayRisk,
        adjustPct: ratio(postedOff + pending, original) ?? 0,
        noteCount: b.adjustments.length,
        reasons,
        _status: b.status,
      }
    })

    if (params.unpostedOnly === 'true') rows = rows.filter((r) => r.pending !== 0)

    // ── The position ────────────────────────────────────────────────────────
    const billed = round2(rows.reduce((s, r) => s + r.original, 0))
    const takenOff = round2(rows.reduce((s, r) => s + r.postedOff, 0))
    const stillToCome = round2(rows.reduce((s, r) => s + r.pending, 0))
    const atRisk = round2(rows.reduce((s, r) => s + r.overpayRisk, 0))
    const riskyBills = rows.filter((r) => r.overpayRisk > 0)

    const months = byMonth(
      rows,
      (r) => r.billDate,
      (r) => r.postedOff + r.pending
    )

    const insights: string[] = []
    if (atRisk > 0) {
      insights.push(
        `₹${atRisk.toLocaleString('en-IN')} is at risk of being overpaid across ${riskyBills.length} ${riskyBills.length === 1 ? 'bill' : 'bills'} — the adjustment is agreed but has not been posted, so the balance on screen is still the full figure.`
      )
    }
    if (billed > 0) {
      insights.push(
        `₹${round2(takenOff + stillToCome).toLocaleString('en-IN')} has been adjusted off ₹${billed.toLocaleString('en-IN')} of billing — ${Math.round(((takenOff + stillToCome) / billed) * 100)}% of the value of every bill on this sheet.`
      )
    }
    const worst = [...rows].sort((a, b) => b.adjustPct - a.adjustPct)[0]
    if (worst && worst.adjustPct > 0) {
      insights.push(
        `${worst.billNumber} from ${worst.supplier} is the most adjusted — ${Math.round(worst.adjustPct * 100)}% of it has come off, for ${worst.reasons.toLowerCase()}.`
      )
    }
    if (rows.length === 0) {
      insights.push('No bill in this period carries an adjustment.')
    }

    return {
      rows: rows.map(({ _status, ...r }) => r),
      totalRows: bills.length >= rowCap ? totalRows : undefined,
      analysis: {
        headline:
          rows.length === 0
            ? 'No bill in this period has been adjusted.'
            : `${rows.length} ${rows.length === 1 ? 'bill carries' : 'bills carry'} adjustments worth ₹${round2(takenOff + stillToCome).toLocaleString('en-IN')} against ₹${billed.toLocaleString('en-IN')} billed.`,
        exceptions: [
          {
            label: 'At risk of overpayment',
            value: atRisk || null,
            format: 'money',
            basis: `${riskyBills.length} ${riskyBills.length === 1 ? 'bill is' : 'bills are'} showing a balance that an agreed note has not come off yet`,
            tone: 'bad',
          },
          {
            label: 'Agreed and not posted',
            value: stillToCome || null,
            format: 'money',
            basis: 'one press away from coming off the payable',
            tone: 'warn',
          },
        ],
        kpis: [
          {
            label: 'Billed on these',
            value: rows.length ? billed : null,
            format: 'money',
            basis: `across ${rows.length} adjusted ${rows.length === 1 ? 'bill' : 'bills'}`,
          },
          {
            label: 'Already taken off',
            value: takenOff || null,
            format: 'money',
            basis:
              billed > 0
                ? `${Math.round((takenOff / billed) * 100)}% of what was billed`
                : 'nothing billed',
            tone: 'good',
          },
          {
            label: 'Still to take off',
            value: stillToCome || null,
            format: 'money',
            basis: 'agreed, and the balance does not show it yet',
            tone: stillToCome > 0 ? 'warn' : 'good',
          },
          {
            label: 'Average adjustment',
            value: mean(takenOff + stillToCome, rows.length),
            format: 'money',
            basis: rows.length ? `over ${rows.length} bills` : 'nothing adjusted',
          },
        ],
        trend:
          months.length > 1
            ? {
                title: 'What was adjusted, by the month the bill was raised',
                valueLabel: 'Adjusted',
                format: 'money',
                points: months,
              }
            : undefined,
        panels: (
          [
            {
              /*
               * The whole sheet in one bar, twice over.
               *
               * Posted beside pending, bill by bill, because the gap between
               * the two is the only number on the page anybody has to act on.
               */
              title: 'What has come off each bill, and what has not',
              question: 'split',
              format: 'money',
              points: [...rows]
                .sort((a, b) => b.postedOff + b.pending - (a.postedOff + a.pending))
                .slice(0, 10)
                .map((r) => ({ label: r.billNumber, value: round2(r.postedOff + r.pending) })),
              series: [
                {
                  name: 'Taken off',
                  tone: 'good',
                  values: [...rows]
                    .sort((a, b) => b.postedOff + b.pending - (a.postedOff + a.pending))
                    .slice(0, 10)
                    .map((r) => r.postedOff),
                },
                {
                  name: 'Agreed, not taken',
                  tone: 'bad',
                  values: [...rows]
                    .sort((a, b) => b.postedOff + b.pending - (a.postedOff + a.pending))
                    .slice(0, 10)
                    .map((r) => r.pending),
                },
              ],
              note: 'Red is money the mill has agreed it does not owe and is still being shown as owing.',
            },
            {
              title: 'Billed against really owed',
              question: 'comparison',
              format: 'money',
              points: [
                { label: 'Billed', value: billed, tone: 'info' },
                { label: 'Taken off', value: takenOff, tone: 'good' },
                { label: 'Still to take off', value: stillToCome, tone: 'warn' },
                {
                  label: 'Really owed',
                  value: round2(rows.reduce((s, r) => s + r.netPayable, 0)),
                  tone: 'normal',
                },
              ].filter((p) => p.value > 0),
            },
            {
              title: 'Which suppliers the adjustments are against',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                [
                  ...rows
                    .reduce((m, r) => {
                      m.set(r.supplier, (m.get(r.supplier) ?? 0) + r.postedOff + r.pending)
                      return m
                    }, new Map<string, number>())
                    .entries(),
                ].map(([label, value]) => ({ label, value: round2(value) })),
                8
              ),
            },
          ] as Panel[]
        ).filter((p) => p.points.length > 0),
        insights,
        caveats: [
          'Only bills carrying at least one standing note appear. A bill nobody has adjusted has nothing to say here.',
          '"Taken off" is the bill\'s own stored figure, which is what its balance was computed from — not a total re-added from the notes, which could disagree with the payable it is meant to explain.',
          '"Really owed" subtracts TDS as well, so it is what a cheque should actually be written for.',
          'Cancelled and refused notes are excluded from every column.',
        ],
      },
    }
  },
}
