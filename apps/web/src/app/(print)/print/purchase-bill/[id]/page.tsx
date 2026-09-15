'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar, PrintSheet, DocumentTable, money } from '@/components/print/PrintSheet'

/**
 * The printed purchase bill.
 *
 * Deliberately not titled "Tax Invoice". This is our own booking record of a
 * bill the supplier raised — printing it as a tax invoice would be claiming to
 * have issued it. The supplier's own number is shown alongside ours, because
 * theirs is the one a GST officer matches against.
 */

interface PrintPayload {
  company: Record<string, string | null>
  template: {
    title: string
    termsText: string | null
    declaration: string | null
    footerNote: string | null
    showHsn: boolean
    showAmountInWords: boolean
    showSignature: boolean
    copies: string[]
  }
  bill: {
    billNumber: string
    supplierInvoiceNo: string | null
    supplierInvoiceDate: string | null
    billDate: string
    dueDate: string | null
    notes: string | null
    subtotal: string
    discountAmount: string
    taxableAmount: string
    cgst: string
    sgst: string
    igst: string
    tdsSection: string | null
    tdsAmount: string
    isReverseCharge: boolean
    roundOff: string
    totalAmount: string
    balanceAmount: string
    supplier: Record<string, string | null>
    po: { poNumber: string } | null
    createdBy: { name: string } | null
    lines: Array<{
      id: string
      description: string | null
      hsnCode: string | null
      qty: string
      unitPrice: string
      discount: string
      gstRate: string
      amount: string
      item: { code: string; name: string; uom?: { symbol: string } | null }
      grnLine?: { grn: { grnNumber: string } } | null
    }>
    charges: Array<{
      id: string
      amount: string
      gstRate: string
      chargeType: { name: string }
    }>
  }
  totalInWords: string
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
}

const shortDate = (v: string) =>
  new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

export default function PrintPurchaseBill() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<PrintPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: PrintPayload }>(
        `/purchase/bills/${id}/print`,
      )
      setData(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this bill.')
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  if (error) {
    return (
      <div style={{ maxWidth: '210mm', margin: '40px auto', background: '#fff', padding: '24px' }}>
        <p style={{ color: '#a03030', margin: 0 }}>{error}</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ maxWidth: '210mm', margin: '40px auto', color: '#fff', textAlign: 'center' }}>
        Loading...
      </div>
    )
  }

  const { company, template, bill, taxMode } = data
  const showDiscountColumn = bill.lines.some((l) => Number(l.discount) > 0)
  const showReceiptColumn = bill.lines.some((l) => l.grnLine)

  const columns = [
    { key: 'sr', label: '#', weight: 5, align: 'right' as const },
    { key: 'desc', label: 'Description', weight: 26 },
    ...(template.showHsn ? [{ key: 'hsn', label: 'HSN', weight: 9 }] : []),
    ...(showReceiptColumn ? [{ key: 'grn', label: 'Receipt', weight: 11 }] : []),
    { key: 'qty', label: 'Qty', weight: 9, align: 'right' as const },
    { key: 'uom', label: 'Unit', weight: 6 },
    { key: 'rate', label: 'Rate', weight: 10, align: 'right' as const },
    ...(showDiscountColumn
      ? [{ key: 'disc', label: 'Disc %', weight: 7, align: 'right' as const }]
      : []),
    ...(taxMode !== 'NONE' ? [{ key: 'gst', label: 'GST %', weight: 7, align: 'right' as const }] : []),
    { key: 'amt', label: 'Amount', weight: 13, align: 'right' as const },
  ]

  const rows = [
    ...bill.lines.map((line, i) => ({
      key: line.id,
      cells: {
        sr: i + 1,
        desc: (
          <>
            <div style={{ fontWeight: 600 }}>{line.item.name}</div>
            <div style={{ fontSize: '9px' }}>
              {line.item.code}
              {line.description ? ` — ${line.description}` : ''}
            </div>
          </>
        ),
        hsn: line.hsnCode || '—',
        grn: line.grnLine?.grn.grnNumber || '—',
        qty: money(line.qty),
        uom: line.item.uom?.symbol || '',
        rate: money(line.unitPrice),
        disc: Number(line.discount) > 0 ? Number(line.discount) : '',
        gst: Number(line.gstRate),
        amt: money(line.amount),
      },
    })),
    // Freight and the like sit in the same grid rather than in a separate block:
    // a clerk checking the bill with a calculator adds straight down one column.
    ...bill.charges.map((charge, i) => ({
      key: charge.id,
      cells: {
        sr: bill.lines.length + i + 1,
        desc: <div style={{ fontWeight: 600 }}>{charge.chargeType.name}</div>,
        hsn: '—',
        grn: '—',
        qty: '',
        uom: '',
        rate: '',
        disc: '',
        gst: Number(charge.gstRate),
        amt: money(charge.amount),
      },
    })),
  ]

  const totals = [
    { label: 'Subtotal', value: money(bill.subtotal) },
    ...(Number(bill.discountAmount) > 0
      ? [{ label: 'Discount', value: `-${money(bill.discountAmount)}` }]
      : []),
    { label: 'Taxable value', value: money(bill.taxableAmount) },
    ...(taxMode === 'CGST_SGST'
      ? [
          { label: 'CGST', value: money(bill.cgst) },
          { label: 'SGST', value: money(bill.sgst) },
        ]
      : []),
    ...(taxMode === 'IGST' ? [{ label: 'IGST', value: money(bill.igst) }] : []),
    ...(Number(bill.roundOff) !== 0 ? [{ label: 'Rounding', value: money(bill.roundOff) }] : []),
    ...(Number(bill.tdsAmount) > 0
      ? [
          {
            label: `Less TDS${bill.tdsSection ? ` ${bill.tdsSection}` : ''}`,
            value: `-${money(bill.tdsAmount)}`,
          },
          { label: 'Payable to supplier', value: money(bill.balanceAmount) },
        ]
      : []),
  ]

  const meta = [
    { label: 'Our Ref', value: bill.billNumber, strong: true },
    { label: 'Their Invoice', value: bill.supplierInvoiceNo || '—' },
    {
      label: 'Their Date',
      value: bill.supplierInvoiceDate ? shortDate(bill.supplierInvoiceDate) : '—',
    },
    { label: 'Booked', value: shortDate(bill.billDate) },
    { label: 'Due', value: bill.dueDate ? shortDate(bill.dueDate) : '—' },
    ...(bill.po ? [{ label: 'Against Order', value: bill.po.poNumber }] : []),
  ]

  const taxNote = bill.isReverseCharge
    ? 'Reverse charge — GST on this bill is payable by the recipient, not by the supplier.'
    : taxMode === 'NONE'
      ? 'Supplier is not registered under GST.'
      : null

  return (
    <>
      <PrintToolbar backHref="/purchase/bills" backLabel="Back to bills" copies={1} />

      <PrintSheet
        company={company}
        title={template.title}
        copyLabel=""
        partyHeading="Supplier"
        party={bill.supplier}
        meta={meta}
        amountInWords={template.showAmountInWords ? data.totalInWords : null}
        terms={template.termsText}
        note={bill.notes}
        totals={totals}
        grandTotal={money(bill.totalAmount)}
        taxNote={taxNote}
        declaration={template.declaration}
        showSignature={template.showSignature}
        preparedBy={bill.createdBy?.name ?? null}
        footerNote={template.footerNote}
      >
        <DocumentTable columns={columns} rows={rows} minRows={8} />
      </PrintSheet>
    </>
  )
}
