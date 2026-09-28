import type { Prisma } from '@prisma/client'
import type { Panel, ReportDefinition, Tone } from '../types'
import {
  byMonth,
  dateRangeFilters,
  dayRange,
  itemFilter,
  round2,
  searchFilter,
  supplierFilter,
  topWithRest,
} from './shared'

/** The bill's settlement, worded as the Purchase Register words it. */
const STATUS_TONE: Record<string, Tone> = {
  UNPAID: 'warn',
  PARTIAL: 'info',
  PAID: 'good',
}

const STATUS_WORDS: Record<string, string> = {
  UNPAID: 'Unpaid',
  PARTIAL: 'Part paid',
  PAID: 'Paid',
}

/*
 * Which kind of bill the line sits on.
 *
 * An expense bill has no receipt behind any of its lines — electricity,
 * rent, a repair. A goods bill has, and a line on it with no receipt is
 * usually a charge typed as a line, or goods that were billed without ever
 * being booked in at the gate.
 */
const KIND_WORDS: Record<string, string> = {
  EXPENSE: 'Expense bill',
  GOODS: 'On a goods bill',
}

const KIND_TONE: Record<string, Tone> = {
  EXPENSE: 'normal',
  GOODS: 'warn',
}

/**
 * Bills booked without a goods receipt — electricity, rent, repairs,
 * services.
 *
 * One row per bill line with no receipt behind it. What the old system kept
 * as a separate Expenses Booking screen is, here, a supplier bill whose lines
 * were typed in rather than pulled off a receipt; this register is those
 * lines, with the tax split the accounts team needs for input credit.
 */
export const expenseRegister: ReportDefinition = {
  id: 'expense-register',
  module: 'purchase',
  title: 'Expenses Booking Register',
  description:
    'Every bill line booked without a goods receipt — electricity, rent, repairs, services — with its GST split and what is still owed.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    { ...itemFilter, label: 'Expense head', help: 'Only lines booked against this item' },
    {
      key: 'kind',
      label: 'Bill type',
      type: 'select',
      options: Object.entries(KIND_WORDS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: Object.entries(STATUS_WORDS).map(([value, label]) => ({ value, label })),
    },
    { ...searchFilter, help: 'Our bill ref, their bill number or supplier name' },
  ],
  columns: [
    { key: 'billDate', label: 'Booked On', type: 'date', width: 14 },
    { key: 'billNumber', label: 'Our Ref', type: 'text', width: 16 },
    { key: 'supplierInvoiceNo', label: 'Their Bill No.', type: 'text', width: 18 },
    { key: 'supplierInvoiceDate', label: 'Their Bill Date', type: 'date', width: 14 },
    { key: 'supplier', label: 'Supplier', type: 'text', width: 28 },
    { key: 'gstin', label: 'GSTIN', type: 'text', width: 18 },
    { key: 'category', label: 'Category', type: 'text', width: 18 },
    { key: 'expense', label: 'Expense Head', type: 'text', width: 28 },
    { key: 'description', label: 'Description', type: 'text', width: 30 },
    { key: 'hsnCode', label: 'HSN/SAC', type: 'text', width: 10 },
    { key: 'qty', label: 'Qty', type: 'qty', total: 'none' },
    { key: 'uom', label: 'UOM', type: 'text', width: 8 },
    { key: 'rate', label: 'Rate', type: 'money', total: 'none' },
    { key: 'taxable', label: 'Taxable', type: 'money', total: 'sum' },
    { key: 'cgst', label: 'CGST', type: 'money', total: 'sum' },
    { key: 'sgst', label: 'SGST', type: 'money', total: 'sum' },
    { key: 'igst', label: 'IGST', type: 'money', total: 'sum' },
    { key: 'amount', label: 'Line Total', type: 'money', total: 'sum' },
    {
      key: 'kind',
      label: 'Bill Type',
      type: 'badge',
      badges: KIND_WORDS,
      badgeTones: KIND_TONE,
      width: 16,
    },
    {
      key: 'status',
      label: 'Status',
      type: 'badge',
      badges: STATUS_WORDS,
      badgeTones: STATUS_TONE,
      width: 12,
    },
    { key: 'dueDate', label: 'Due', type: 'date', width: 13 },
  ],

  summary: {
    title: 'Biggest expenses in this period',
    columns: ['billDate', 'billNumber', 'supplier', 'expense', 'taxable', 'amount', 'status'],
    by: 'amount',
    limit: 12,
  },

  pivot: {
    rows: ['expense', 'supplier'],
    values: ['taxable', 'cgst', 'sgst', 'igst', 'amount'],
    slicers: ['kind', 'status', 'category'],
    note: 'Open an expense head to see who it was paid to.',
  },

  async run({ tx, params, rowCap }) {
    const range = dayRange(params)
    const contains = (v: string) => ({ contains: v, mode: 'insensitive' as const })

    // A cancelled bill owes nothing and claims no credit.
    const billWhere: Prisma.PurchaseInvoiceWhereInput = {
      status:
        params.status && params.status in STATUS_WORDS
          ? (params.status as Prisma.EnumInvoiceStatusFilter['equals'])
          : { not: 'CANCELLED' },
      ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      ...(range ? { billDate: range } : {}),
      ...(params.q
        ? {
            OR: [
              { billNumber: contains(params.q) },
              { supplierInvoiceNo: contains(params.q) },
              { supplier: { name: contains(params.q) } },
            ],
          }
        : {}),
      ...(params.kind === 'EXPENSE' ? { lines: { none: { grnLineId: { not: null } } } } : {}),
      ...(params.kind === 'GOODS' ? { lines: { some: { grnLineId: { not: null } } } } : {}),
    }
    const where: Prisma.PurchaseInvoiceLineWhereInput = {
      grnLineId: null,
      bill: billWhere,
      ...(params.itemId ? { itemId: params.itemId } : {}),
    }

    const totalRows = await tx.purchaseInvoiceLine.count({ where })
    const lines = await tx.purchaseInvoiceLine.findMany({
      where,
      take: rowCap,
      orderBy: [
        { bill: { billDate: 'asc' } },
        { bill: { billNumber: 'asc' } },
        { sortOrder: 'asc' },
      ],
      select: {
        description: true,
        hsnCode: true,
        qty: true,
        unitPrice: true,
        taxableValue: true,
        cgst: true,
        sgst: true,
        igst: true,
        amount: true,
        item: {
          select: {
            name: true,
            hsnCode: true,
            uom: { select: { symbol: true } },
            category: { select: { name: true } },
          },
        },
        bill: {
          select: {
            billNumber: true,
            billDate: true,
            dueDate: true,
            supplierInvoiceNo: true,
            supplierInvoiceDate: true,
            status: true,
            balanceAmount: true,
            supplier: { select: { name: true, gstin: true } },
            _count: { select: { lines: { where: { grnLineId: { not: null } } } } },
          },
        },
      },
    })

    const rows = lines.map((l) => ({
      billDate: l.bill.billDate,
      billNumber: l.bill.billNumber,
      supplierInvoiceNo: l.bill.supplierInvoiceNo ?? '',
      supplierInvoiceDate: l.bill.supplierInvoiceDate,
      supplier: l.bill.supplier?.name ?? '',
      gstin: l.bill.supplier?.gstin ?? '',
      category: l.item.category?.name ?? '',
      expense: l.item.name,
      description: l.description ?? '',
      hsnCode: l.hsnCode ?? l.item.hsnCode ?? '',
      qty: Number(l.qty),
      uom: l.item.uom?.symbol ?? '',
      rate: Number(l.unitPrice),
      taxable: Number(l.taxableValue),
      cgst: Number(l.cgst),
      sgst: Number(l.sgst),
      igst: Number(l.igst),
      amount: Number(l.amount),
      kind: l.bill._count.lines > 0 ? 'GOODS' : 'EXPENSE',
      status: l.bill.status,
      dueDate: l.bill.dueDate,
      // Not a column: the bill's own balance, counted once per bill below.
      balance: Number(l.bill.balanceAmount),
    }))

    const taxable = round2(rows.reduce((s, r) => s + r.taxable, 0))
    const gst = round2(rows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0))
    const total = round2(rows.reduce((s, r) => s + r.amount, 0))
    const bills = new Map<string, { balance: number; kind: string }>()
    for (const r of rows) bills.set(r.billNumber, { balance: r.balance, kind: r.kind })
    const expenseBills = [...bills.values()].filter((b) => b.kind === 'EXPENSE')
    const owed = round2(expenseBills.reduce((s, b) => s + b.balance, 0))
    const onGoods = rows.filter((r) => r.kind === 'GOODS')

    const byHead = new Map<string, number>()
    for (const r of rows) byHead.set(r.expense, (byHead.get(r.expense) ?? 0) + r.taxable)
    const bySupplier = new Map<string, number>()
    for (const r of rows) bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + r.taxable)

    const monthly = byMonth(
      rows,
      (r) => r.billDate,
      (r) => r.taxable
    )

    const insights: string[] = []
    const top = [...byHead].sort((a, b) => b[1] - a[1])[0]
    if (top) {
      insights.push(
        `${top[0]} is the biggest expense — ₹${round2(top[1]).toLocaleString('en-IN')}, ${taxable ? ((top[1] / taxable) * 100).toFixed(1) : '0'}% of the period.`
      )
    }
    if (onGoods.length) {
      insights.push(
        `${onGoods.length} line${onGoods.length === 1 ? '' : 's'} with no receipt ${onGoods.length === 1 ? 'sits' : 'sit'} on bills that also carry received goods. Check ${onGoods.length === 1 ? 'it is' : 'they are'} a charge and not goods that were never booked in.`
      )
    }

    return {
      rows,
      totalRows,
      analysis: {
        headline:
          rows.length === 0
            ? 'No bills were booked without a receipt in this period.'
            : `₹${total.toLocaleString('en-IN')} booked as expenses on ${bills.size} bill${bills.size === 1 ? '' : 's'}.`,
        exceptions: [
          {
            label: 'No-receipt lines on goods bills',
            value: onGoods.length || null,
            format: 'integer',
            basis: 'check each is a charge, not goods that skipped the gate',
            tone: 'warn',
          },
        ],
        kpis: [
          {
            label: 'Expense lines',
            value: rows.length || null,
            format: 'integer',
            basis: `on ${bills.size} bills`,
          },
          {
            label: 'Taxable value',
            value: rows.length ? taxable : null,
            format: 'money',
            basis: 'before GST',
          },
          {
            label: 'GST on expenses',
            value: rows.length ? gst : null,
            format: 'money',
            basis: 'input tax on these lines',
          },
          {
            label: 'Still owed',
            value: expenseBills.length ? owed : null,
            format: 'money',
            basis: `on ${expenseBills.length} expense bill${expenseBills.length === 1 ? '' : 's'}`,
            tone: owed > 0 ? 'warn' : 'good',
          },
        ],
        trend:
          monthly.length > 1
            ? {
                title: 'Expenses booked, by month',
                valueLabel: 'Taxable',
                format: 'money',
                points: monthly,
              }
            : undefined,
        panels: (
          [
            {
              title: 'Biggest expense heads',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                [...byHead].map(([label, value]) => ({ label, value: round2(value) })),
                8
              ),
            },
            {
              title: 'Who the expenses were paid to',
              question: 'ranking',
              format: 'money',
              points: topWithRest(
                [...bySupplier].map(([label, value]) => ({ label, value: round2(value) })),
                8
              ),
            },
          ] as Panel[]
        ).filter((p) => p.points.some((x) => x.value > 0)),
        insights,
        caveats: [
          'Cancelled bills are left out.',
          'An expense is any bill line with no goods receipt behind it. Charges added to a bill in its Charges section (freight, packing) are not lines and are not listed here.',
          '"Still owed" is each expense bill’s balance, counted once per bill.',
        ],
      },
    }
  },
}
