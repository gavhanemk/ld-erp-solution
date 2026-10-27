import type { Prisma } from '@prisma/client'
import type { ReportDefinition, Tone } from '../types'
import { dateRangeFilters, dayRange, round2, supplierFilter, searchFilter, itemFilter } from './shared'

/** Settled is green, part paid is the ordinary case, unpaid is waiting. */
const STATUS_TONE: Record<string, Tone> = {
  UNPAID: 'warn',
  PARTIAL: 'info',
  PAID: 'good',
  CANCELLED: 'neutral',
}

const STATUS_WORDS: Record<string, string> = {
  UNPAID: 'Unpaid',
  PARTIAL: 'Part paid',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
}

const money = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** "+500.00" or "−1,200.00": an add or a less, signed the way a register prints it. */
const signed = (n: number) => `${n < 0 ? '−' : '+'}${money(Math.abs(n))}`

/**
 * Every supplier bill booked in a period, line by line — the mill's Purchase
 * Detail Register.
 *
 * Laid out as the old ERP printed it. A bill's lines each carry their item,
 * quantity, rate and gross; the bill's own figures — what was added or taken
 * off, the taxable value, the tax split, the total, what has been paid and
 * what is still owed — print once, on its first line. So a bill of four
 * qualities is counted once in every total, and the gross of its lines plus
 * its add/less comes to its taxable value.
 *
 * The tax split is kept on the bill rather than rolled into one figure: input
 * credit is claimed CGST/SGST or IGST, never "GST", and this is the report the
 * accounts team reconciles GSTR-2B against.
 */
export const purchaseRegister: ReportDefinition = {
  id: 'purchase-register',
  module: 'purchase',
  title: 'Purchase Register',
  description:
    'Every supplier bill booked in the period, line by line, with its tax split, what has been paid and what is still owed.',
  filters: [
    ...dateRangeFilters,
    supplierFilter,
    itemFilter,
    {
      key: 'status',
      label: 'Payment status',
      emptyLabel: 'All statuses',
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
  /*
   * The workbook's columns, in order: every field the register has, one to a
   * column, so the sheet can be sorted and filtered and added up.
   *
   * A bill's number, dates and supplier repeat on each of its lines, so
   * filtering to one supplier keeps all of their lines. Its money does not:
   * that is on the first line only, so a column's sum is the register's total
   * and never a bill counted once per line.
   */
  columns: [
    { key: 'sr', label: 'Sr. No.', type: 'integer', width: 7 },
    { key: 'billNumber', label: 'Entry No.', type: 'text', width: 15 },
    { key: 'billDate', label: 'Entry Date', type: 'date', width: 11 },
    { key: 'supplierInvoiceNo', label: 'Supplier Bill No.', type: 'text', width: 17 },
    { key: 'supplierInvoiceDate', label: 'Supplier Bill Date', type: 'date', width: 11 },
    { key: 'supplier', label: 'Supplier', type: 'text', width: 30 },
    { key: 'gstin', label: 'GSTIN', type: 'text', width: 17 },
    { key: 'poNumber', label: 'PO No.', type: 'text', width: 15 },
    { key: 'grnNumber', label: 'GRN No.', type: 'text', width: 15 },
    { key: 'itemCode', label: 'Item Code', type: 'text', width: 13 },
    { key: 'item', label: 'Item / Quality', type: 'text', width: 28 },
    { key: 'description', label: 'Description', type: 'text', width: 24 },
    { key: 'hsn', label: 'HSN', type: 'text', width: 9 },
    { key: 'gstRate', label: 'GST %', type: 'percent', width: 7 },
    { key: 'qty', label: 'Qty', type: 'qty', unitKey: 'unit', total: 'sum', width: 11 },
    { key: 'unit', label: 'Unit', type: 'text', width: 6 },
    { key: 'rate', label: 'Rate', type: 'money', total: 'none', width: 10 },
    { key: 'gross', label: 'Gross Amount', type: 'money', total: 'sum', width: 14 },
    { key: 'addLess', label: 'Add / Less', type: 'money', total: 'sum', width: 12 },
    { key: 'taxable', label: 'Taxable Amount', type: 'money', total: 'sum', width: 14 },
    { key: 'cgst', label: 'CGST', type: 'money', total: 'sum', width: 12 },
    { key: 'sgst', label: 'SGST', type: 'money', total: 'sum', width: 12 },
    { key: 'igst', label: 'IGST', type: 'money', total: 'sum', width: 12 },
    { key: 'gst', label: 'Total GST', type: 'money', total: 'sum', width: 12 },
    { key: 'roundOff', label: 'Round Off', type: 'money', total: 'sum', width: 9 },
    { key: 'total', label: 'Bill Total', type: 'money', total: 'sum', width: 14 },
    { key: 'tds', label: 'TDS', type: 'money', total: 'sum', width: 11 },
    { key: 'adjusted', label: 'Adjusted by Notes', type: 'money', total: 'sum', width: 12 },
    { key: 'paid', label: 'Paid', type: 'money', total: 'sum', width: 14 },
    { key: 'balance', label: 'Outstanding', type: 'money', total: 'sum', width: 14 },
    {
      key: 'status',
      label: 'Payment Status',
      type: 'badge',
      badges: STATUS_WORDS,
      badgeTones: STATUS_TONE,
      width: 12,
    },
    { key: 'dueDate', label: 'Due Date', type: 'date', width: 11 },
    { key: 'reverseCharge', label: 'Reverse Charge', type: 'text', width: 9 },
    { key: 'addLessDetails', label: 'Add / Less Details', type: 'text', width: 28 },
    { key: 'narration', label: 'Narration', type: 'text', width: 36 },
  ],

  register: {
    documentKey: 'billNumber',
    noun: { one: 'bill', many: 'bills' },
    lineKeys: [
      'grnNumber',
      'itemCode',
      'item',
      'description',
      'hsn',
      'gstRate',
      'qty',
      'unit',
      'rate',
      'gross',
    ],
    /*
     * Eighteen columns across a landscape A4, which is only possible because
     * the figures that are read together share a column: the date under the
     * entry number, the GSTIN under the supplier, SGST under CGST, the due
     * date under the status. What still does not fit — the add/less broken
     * down, round off, TDS, reverse charge, the narration — prints as a note
     * under the bill. The workbook keeps every one in its own column.
     */
    print: [
      { key: 'sr', label: 'Sr.' },
      { key: 'billNumber', sub: ['billDate', 'poNumber'], label: 'Entry No.', subLabel: 'Date' },
      {
        key: 'supplierInvoiceNo',
        sub: ['supplierInvoiceDate'],
        label: 'Bill No.',
        subLabel: 'Bill Date',
      },
      { key: 'supplier', sub: ['gstin'], subLabel: 'GSTIN', wrap: true },
      { key: 'item', sub: ['itemCode', 'description'], subLabel: 'Code', wrap: true },
      { key: 'hsn', sub: ['gstRate'], subLabel: 'GST %' },
      { key: 'qty' },
      { key: 'rate' },
      { key: 'gross', label: 'Gross' },
      { key: 'addLess' },
      { key: 'taxable', label: 'Taxable' },
      { key: 'cgst', under: 'sgst', underLabel: 'SGST' },
      { key: 'igst' },
      { key: 'gst' },
      { key: 'total' },
      { key: 'paid' },
      { key: 'balance' },
      { key: 'status', sub: ['dueDate'], label: 'Status', subLabel: 'Due' },
    ],
    noteKey: 'note',
    void: { key: 'status', value: 'CANCELLED', word: 'cancelled' },
    monthKey: 'billDate',
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
      // that screen reports on exactly the rows it is showing. A bill with a
      // line for the item is listed whole: its totals are the bill's, and
      // printing only the one line beside them would not add up.
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

    /*
     * Rows are lines, so the cap is counted in lines. Measured before anything
     * is fetched, so a cut can be reported against what was really there: a
     * live bill prints a row per line (one, if it somehow has none) and a
     * cancelled bill prints one row however many lines it had.
     */
    const live: Prisma.PurchaseInvoiceWhereInput = {
      AND: [where, { status: { not: 'CANCELLED' } }],
    }
    const [lineRows, emptyBills, cancelledBills] = await Promise.all([
      tx.purchaseInvoiceLine.count({ where: { bill: live } }),
      tx.purchaseInvoice.count({ where: { AND: [live, { lines: { none: {} } }] } }),
      tx.purchaseInvoice.count({ where: { AND: [where, { status: 'CANCELLED' }] } }),
    ])
    const totalRows = lineRows + emptyBills + cancelledBills

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
        roundOff: true,
        totalAmount: true,
        tdsSection: true,
        tdsAmount: true,
        noteAdjustment: true,
        paidAmount: true,
        balanceAmount: true,
        status: true,
        isReverseCharge: true,
        notes: true,
        supplier: { select: { name: true, gstin: true } },
        po: { select: { poNumber: true } },
        charges: {
          select: { amount: true, chargeType: { select: { name: true } } },
        },
        lines: {
          orderBy: { sortOrder: 'asc' },
          select: {
            description: true,
            hsnCode: true,
            qty: true,
            unitPrice: true,
            gstRate: true,
            item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
            grnLine: { select: { grn: { select: { grnNumber: true } } } },
          },
        },
      },
    })

    const rows: Array<Record<string, unknown>> = []

    for (const [n, b] of bills.entries()) {
      const cancelled = b.status === 'CANCELLED'
      const lines = cancelled ? [] : b.lines
      // A whole bill or none of it: half a bill under the cap would print
      // totals that its own lines do not add up to.
      if (rows.length + Math.max(1, lines.length) > rowCap) break

      const document = {
        sr: n + 1,
        billNumber: b.billNumber,
        billDate: b.billDate,
        supplierInvoiceNo: b.supplierInvoiceNo,
        supplierInvoiceDate: b.supplierInvoiceDate,
        supplier: b.supplier?.name ?? '',
        gstin: b.supplier?.gstin ?? '',
        poNumber: b.po?.poNumber ?? '',
        status: b.status,
        dueDate: b.dueDate,
      }

      // Cancelled: listed, so the numbering has no gap, and carrying no
      // figures, so nothing can count it. Why it went is in its narration.
      if (cancelled) {
        rows.push({ ...document, narration: b.notes ?? '', note: b.notes ?? '' })
        continue
      }

      const gross = lines.map((l) => round2(Number(l.qty) * Number(l.unitPrice)))
      const grossTotal = round2(gross.reduce((s, g) => s + g, 0))
      const taxable = Number(b.taxableAmount)
      const cgst = Number(b.cgst)
      const sgst = Number(b.sgst)
      const igst = Number(b.igst)
      const roundOff = Number(b.roundOff)
      const tds = Number(b.tdsAmount)
      const adjusted = Number(b.noteAdjustment)

      /*
       * Add/less is whatever takes the lines' gross to the bill's taxable
       * value: charges on, discounts off. Worked from the two stored figures
       * rather than re-priced, so it is exactly the gap between them and the
       * row adds up to the paisa.
       */
      const addLess = round2(taxable - grossTotal)
      const chargeTotal = round2(b.charges.reduce((s, c) => s + Number(c.amount), 0))
      const discount = round2(grossTotal + chargeTotal - taxable)
      const addLessParts = [
        ...b.charges.map((c) => `${c.chargeType.name} ${signed(Number(c.amount))}`),
        ...(Math.abs(discount) >= 0.01 ? [`Discount ${signed(-discount)}`] : []),
      ]

      const narration = b.notes?.trim() ?? ''
      // What the printed columns cannot show but a reader checking the row
      // needs: why it does not simply add across.
      const note = [
        ...addLessParts,
        Math.abs(roundOff) >= 0.01 ? `Round off ${signed(roundOff)}` : '',
        tds > 0 ? `TDS${b.tdsSection ? ` ${b.tdsSection}` : ''} ${money(tds)}` : '',
        Math.abs(adjusted) >= 0.01 ? `Adjusted by notes ${money(adjusted)}` : '',
        b.isReverseCharge ? 'Reverse charge: the GST is ours to pay and is not in the bill total' : '',
        narration,
      ]
        .filter(Boolean)
        .join(' · ')

      const totals = {
        addLess,
        taxable,
        cgst,
        sgst,
        igst,
        gst: round2(cgst + sgst + igst),
        roundOff,
        total: Number(b.totalAmount),
        tds,
        adjusted,
        paid: Number(b.paidAmount),
        balance: Number(b.balanceAmount),
        reverseCharge: b.isReverseCharge ? 'Yes' : '',
        addLessDetails: addLessParts.join(', '),
        narration,
        note,
      }

      if (lines.length === 0) {
        rows.push({ ...document, ...totals })
        continue
      }

      lines.forEach((l, i) => {
        const description = l.description?.trim() ?? ''
        rows.push({
          ...document,
          grnNumber: l.grnLine?.grn.grnNumber ?? '',
          itemCode: l.item.code,
          item: l.item.name,
          // Only when it says something the item's own name does not.
          description: description && description !== l.item.name ? description : '',
          hsn: l.hsnCode ?? '',
          gstRate: Number(l.gstRate) / 100,
          qty: Number(l.qty),
          unit: l.item.uom?.symbol ?? '',
          rate: Number(l.unitPrice),
          gross: gross[i],
          ...(i === 0 ? totals : {}),
        })
      })
    }

    return { rows, totalRows }
  },
}
