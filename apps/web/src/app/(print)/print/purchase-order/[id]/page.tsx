'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar, PrintSheet, DocumentTable, money } from '@/components/print/PrintSheet'

/**
 * The printed purchase order.
 *
 * An ordinary page with a print stylesheet rather than a PDF drawn in code. An
 * Indian commercial document is a grid of bordered boxes, which is what HTML
 * tables are for, and changing the wording later is an edit here rather than a
 * re-plot of coordinates.
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
    showBankDetails: boolean
    showSignature: boolean
    copies: string[]
  }
  order: {
    poNumber: string
    poDate: string
    deliveryDate: string | null
    notes: string | null
    terms: string | null
    subtotal: string
    discountAmount: string
    taxableAmount: string
    cgst: string
    sgst: string
    igst: string
    roundOff: string
    totalAmount: string
    supplier: Record<string, string | null>
    deliveryWarehouse: { name: string; address: string | null } | null
    createdBy: { name: string } | null
    lines: Array<{
      id: string
      description: string | null
      hsnCode: string | null
      qty: string
      unitRate: string
      discount: string
      gstRate: string
      amount: string
      item: { code: string; name: string; uom?: { symbol: string } | null }
    }>
  }
  totalInWords: string
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
}

const shortDate = (v: string) =>
  new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

export default function PrintPurchaseOrder() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<PrintPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: PrintPayload }>(
        `/purchase/orders/${id}/print`,
      )
      setData(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this order.')
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

  const { company, template, order, taxMode } = data
  const showDiscountColumn = order.lines.some((l) => Number(l.discount) > 0)

  const columns = [
    { key: 'sr', label: '#', width: '26px', align: 'right' as const },
    { key: 'desc', label: 'Description' },
    ...(template.showHsn ? [{ key: 'hsn', label: 'HSN', width: '56px' }] : []),
    { key: 'qty', label: 'Qty', width: '62px', align: 'right' as const },
    { key: 'uom', label: 'Unit', width: '36px' },
    { key: 'rate', label: 'Rate', width: '64px', align: 'right' as const },
    ...(showDiscountColumn ? [{ key: 'disc', label: 'Disc %', width: '44px', align: 'right' as const }] : []),
    ...(taxMode !== 'NONE' ? [{ key: 'gst', label: 'GST %', width: '44px', align: 'right' as const }] : []),
    { key: 'amt', label: 'Amount', width: '80px', align: 'right' as const },
  ]

  const rows = order.lines.map((line, i) => ({
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
      qty: money(line.qty),
      uom: line.item.uom?.symbol || '',
      rate: money(line.unitRate),
      disc: Number(line.discount) > 0 ? Number(line.discount) : '',
      gst: Number(line.gstRate),
      amt: money(line.amount),
    },
  }))

  const totals = [
    { label: 'Subtotal', value: money(order.subtotal) },
    ...(Number(order.discountAmount) > 0
      ? [{ label: 'Discount', value: `-${money(order.discountAmount)}` }]
      : []),
    { label: 'Taxable value', value: money(order.taxableAmount) },
    ...(taxMode === 'CGST_SGST'
      ? [
          { label: 'CGST', value: money(order.cgst) },
          { label: 'SGST', value: money(order.sgst) },
        ]
      : []),
    ...(taxMode === 'IGST' ? [{ label: 'IGST', value: money(order.igst) }] : []),
    ...(Number(order.roundOff) !== 0 ? [{ label: 'Rounding', value: money(order.roundOff) }] : []),
  ]

  return (
    <>
      <PrintToolbar backHref="/purchase/orders" backLabel="Back to orders" copies={template.copies.length} />

      {(template.copies.length ? template.copies : ['']).map((copyLabel, i) => (
        <PrintSheet
          key={i}
          company={company}
          title={template.title}
          copyLabel={copyLabel}
          partyHeading="Supplier"
          party={order.supplier}
          meta={[
            { label: 'Order No.', value: order.poNumber, strong: true },
            { label: 'Date', value: shortDate(order.poDate) },
            { label: 'Wanted by', value: order.deliveryDate ? shortDate(order.deliveryDate) : '—' },
            { label: 'Deliver to', value: order.deliveryWarehouse?.name || company.city || '—' },
          ]}
          amountInWords={template.showAmountInWords ? data.totalInWords : null}
          terms={order.terms || template.termsText}
          note={order.notes}
          totals={totals}
          grandTotal={money(order.totalAmount)}
          taxNote={taxMode === 'NONE' ? 'Supplier is not registered under GST.' : null}
          declaration={template.declaration}
          showSignature={template.showSignature}
          preparedBy={order.createdBy?.name ?? null}
          footerNote={template.footerNote}
        >
          <DocumentTable columns={columns} rows={rows} minRows={8} />
        </PrintSheet>
      ))}
    </>
  )
}
