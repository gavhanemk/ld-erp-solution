import type { Prisma } from '@prisma/client'
import type { Exception, Panel, ReportDefinition } from '../types'
import { byMonth, dateRangeFilters, dayRange, periodLabel, round2, searchFilter, supplierFilter, topWithRest } from './shared'

/**
 * Every rupee of TDS kept back from a supplier, by section, supplier and
 * month — what accounts files the TDS return from and pays the government.
 *
 * One row per deduction. Most are on a bill (an expense bill's TDS box); a
 * few are taken at payment, when the bill carried none. Both are here, because
 * the return counts both and a register missing either is short.
 *
 * It lists what was deducted. Whether it has been paid to the government is
 * not recorded in the ERP yet, and the caveat says so rather than implying it.
 */

const SOURCE_WORDS: Record<string, string> = { BILL: 'On the bill', PAYMENT: 'At payment' }

const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric' })

export const tdsRegister: ReportDefinition = {
  id: 'tds-register',
  module: 'purchase',
  title: 'TDS Register',
  description:
    'Tax deducted at source from supplier bills and payments — by section, supplier and month, with each supplier’s PAN — the figures for the TDS return and the monthly payment to the government.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    {
      key: 'source',
      label: 'Deducted',
      type: 'select',
      options: Object.entries(SOURCE_WORDS).map(([value, label]) => ({ value, label })),
    },
    searchFilter,
  ],

  columns: [
    { key: 'date', label: 'Date', type: 'date', width: 13 },
    { key: 'month', label: 'Month', type: 'text', width: 10 },
    { key: 'document', label: 'Document', type: 'text', width: 14 },
    { key: 'theirBillNo', label: 'Their Bill No.', type: 'text', width: 16 },
    { key: 'source', label: 'Deducted', type: 'text', width: 12 },
    { key: 'supplier', label: 'Supplier', type: 'text', width: 28 },
    { key: 'pan', label: 'PAN', type: 'text', width: 13 },
    { key: 'section', label: 'Section', type: 'text', width: 9 },
    { key: 'sectionLabel', label: 'Nature of Payment', type: 'text', width: 26 },
    { key: 'amount', label: 'Amount Deducted On', type: 'money', total: 'sum' },
    { key: 'rate', label: 'Rate %', type: 'percent', total: 'none', width: 8 },
    { key: 'tds', label: 'TDS', type: 'money', total: 'sum' },
  ],

  summary: {
    title: 'Biggest deductions in this period',
    columns: ['date', 'document', 'supplier', 'section', 'amount', 'tds'],
    by: 'tds',
    limit: 12,
  },

  pivot: {
    rows: ['section', 'supplier'],
    values: ['tds', 'amount'],
    slicers: ['month'],
    note: 'TDS by section, then supplier. The month slicer gives one month’s figure — what is paid to the government for that month.',
  },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const q = params.q?.trim()
    const contains = (v: string) => ({ contains: v, mode: 'insensitive' as const })

    const billWhere: Prisma.PurchaseInvoiceWhereInput = {
      status: { not: 'CANCELLED' },
      tdsAmount: { gt: 0 },
      ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      ...(range ? { billDate: range } : {}),
      ...(q
        ? {
            OR: [
              { billNumber: contains(q) },
              { supplierInvoiceNo: contains(q) },
              { supplier: { name: contains(q) } },
            ],
          }
        : {}),
    }
    const paymentWhere: Prisma.SupplierPaymentWhereInput = {
      status: 'POSTED',
      tdsAmount: { gt: 0 },
      ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      ...(range ? { paymentDate: range } : {}),
      ...(q
        ? {
            OR: [
              { paymentNumber: contains(q) },
              { invoice: { supplierInvoiceNo: contains(q) } },
              { supplier: { name: contains(q) } },
            ],
          }
        : {}),
    }

    const wantBills = params.source !== 'PAYMENT'
    const wantPayments = params.source !== 'BILL'

    const [bills, payments] = await Promise.all([
      wantBills
        ? tx.purchaseInvoice.findMany({
            where: billWhere,
            take: rowCap,
            orderBy: [{ billDate: 'desc' }, { billNumber: 'desc' }],
            select: {
              billNumber: true,
              billDate: true,
              supplierInvoiceNo: true,
              taxableAmount: true,
              tdsSection: true,
              tdsRate: true,
              tdsAmount: true,
              tdsSectionRef: { select: { section: true, label: true } },
              supplier: { select: { name: true, pan: true } },
            },
          })
        : Promise.resolve([]),
      wantPayments
        ? tx.supplierPayment.findMany({
            where: paymentWhere,
            take: rowCap,
            orderBy: [{ paymentDate: 'desc' }, { paymentNumber: 'desc' }],
            select: {
              paymentNumber: true,
              paymentDate: true,
              amount: true,
              tdsAmount: true,
              invoice: { select: { supplierInvoiceNo: true } },
              supplier: { select: { name: true, pan: true } },
            },
          })
        : Promise.resolve([]),
    ])

    const rows = [
      ...bills.map((b) => ({
        date: b.billDate,
        month: MONTH.format(b.billDate),
        document: b.billNumber,
        theirBillNo: b.supplierInvoiceNo ?? '',
        source: SOURCE_WORDS.BILL,
        supplier: b.supplier.name,
        pan: b.supplier.pan ?? '',
        section: b.tdsSectionRef?.section ?? b.tdsSection ?? '',
        sectionLabel: b.tdsSectionRef?.label ?? '',
        amount: round2(Number(b.taxableAmount)),
        rate: b.tdsRate == null ? null : Number(b.tdsRate) / 100,
        tds: round2(Number(b.tdsAmount)),
      })),
      // Taken at payment: deducted on what the payment settled, cash and tax
      // together. No section was recorded with it, so none is shown.
      ...payments.map((p) => ({
        date: p.paymentDate,
        month: MONTH.format(p.paymentDate),
        document: p.paymentNumber,
        theirBillNo: p.invoice?.supplierInvoiceNo ?? '',
        source: SOURCE_WORDS.PAYMENT,
        supplier: p.supplier.name,
        pan: p.supplier.pan ?? '',
        section: '',
        sectionLabel: '',
        amount: round2(Number(p.amount) + Number(p.tdsAmount)),
        rate: null,
        tds: round2(Number(p.tdsAmount)),
      })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime())

    // ── The position ──────────────────────────────────────────────────────
    const totalTds = round2(rows.reduce((s, r) => s + r.tds, 0))
    const totalOn = round2(rows.reduce((s, r) => s + r.amount, 0))
    const suppliers = new Set(rows.map((r) => r.supplier))
    const noPan = rows.filter((r) => !r.pan.trim())
    const noPanTds = round2(noPan.reduce((s, r) => s + r.tds, 0))
    const noSection = rows.filter((r) => !r.section)

    // ── The cuts ──────────────────────────────────────────────────────────
    const bySection = new Map<string, number>()
    const bySupplier = new Map<string, number>()
    for (const r of rows) {
      const key = r.section || 'No section'
      bySection.set(key, (bySection.get(key) ?? 0) + r.tds)
      bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.tds)
    }

    const panels: Panel[] = [
      {
        title: 'TDS by section',
        question: 'ranking',
        format: 'money',
        points: [...bySection]
          .map(([label, value]) => ({ label, value: round2(value) }))
          .sort((a, b) => b.value - a.value),
      },
      {
        title: 'Suppliers with the most TDS kept back',
        question: 'ranking',
        format: 'money',
        points: topWithRest(
          [...bySupplier].map(([label, value]) => ({ label, value: round2(value) })),
          8
        ),
      },
    ]

    const exceptions: Exception[] = [
      {
        label: 'Deducted with no PAN on file',
        value: noPanTds || null,
        format: 'money',
        basis: `across ${noPan.length} ${noPan.length === 1 ? 'deduction' : 'deductions'} — the return needs a PAN for each`,
        tone: 'bad',
      },
      {
        label: 'No section recorded',
        value: noSection.length || null,
        format: 'integer',
        basis: 'deductions taken at payment or on older bills — give them a section in the return',
        tone: 'warn',
      },
    ]

    const months = byMonth(rows, (r) => r.date, (r) => r.tds)
    const biggestSection = [...bySection].sort((a, b) => b[1] - a[1])[0]

    return {
      rows,
      // Only when the cap bit: then the real count, so the file says it is partial.
      totalRows:
        bills.length >= rowCap || payments.length >= rowCap
          ? (await tx.purchaseInvoice.count({ where: billWhere })) +
            (await tx.supplierPayment.count({ where: paymentWhere }))
          : undefined,
      analysis: {
        headline:
          rows.length === 0
            ? `No TDS was deducted in ${periodLabel(params).toLowerCase()}.`
            : `₹${totalTds.toLocaleString('en-IN')} of TDS kept back from ${suppliers.size} ${
                suppliers.size === 1 ? 'supplier' : 'suppliers'
              } — ${periodLabel(params).toLowerCase()}.`,
        kpis: [
          {
            label: 'TDS deducted',
            value: rows.length ? totalTds : null,
            format: 'money',
            basis: `across ${rows.length} ${rows.length === 1 ? 'deduction' : 'deductions'}`,
          },
          {
            label: 'Deducted on',
            value: rows.length ? totalOn : null,
            format: 'money',
            basis: 'value before GST',
          },
          {
            label: 'Suppliers',
            value: rows.length ? suppliers.size : null,
            format: 'integer',
            basis: 'with TDS kept back',
          },
        ],
        exceptions,
        trend: months.length
          ? { title: 'TDS deducted by month', valueLabel: 'TDS', format: 'money', points: months }
          : undefined,
        panels,
        insights: [
          ...(biggestSection
            ? [`${biggestSection[0]} is the largest section, at ₹${round2(biggestSection[1]).toLocaleString('en-IN')}.`]
            : []),
          ...(noPan.length
            ? [`${noPan.length} ${noPan.length === 1 ? 'deduction is' : 'deductions are'} for a supplier with no PAN on file. Add it in Masters → Suppliers before the return is filed.`]
            : []),
        ],
        caveats: [
          'This lists the TDS deducted. Paying it to the government, and the challan for it, are not recorded in the ERP yet — check them against your challans.',
          'Rates and limits come from Settings → Company → TDS sections, as your accountant set them up.',
        ],
      },
    }
  },
}
