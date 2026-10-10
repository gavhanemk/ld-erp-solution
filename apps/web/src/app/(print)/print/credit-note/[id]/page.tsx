'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { StoreSheet, Fact, Eyebrow, qty, money, longDate, CODE, GREY, INK, MUTED, NAVY, NUM, RULE, type SheetColumn } from '@/components/print/StoreSheet'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; declaration: string | null; footerNote: string | null; showAmountInWords: boolean }
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
  placeOfSupplyState: string | null
  totalInWords: string
  note: {
    noteNumber: string
    noteDate: string
    type: string
    status: string
    reason: string | null
    notes: string | null
    placeOfSupplyCode: string | null
    taxableAmount: string
    cgst: string
    sgst: string
    igst: string
    roundOff: string
    totalAmount: string
    cancelledAt: string | null
    cancelReason: string | null
    customer: { name: string; gstin: string | null; billingAddress: string | null; billingCity: string | null; billingState: string | null; billingStateCode: string | null; billingPincode: string | null }
    invoice: { invoiceNumber: string; invoiceDate: string } | null
    warehouse: { name: string } | null
    createdBy: { name: string } | null
    lines: Array<{
      id: string
      description: string | null
      hsnCode: string | null
      qty: string
      unitPrice: string
      taxableValue: string
      gstRate: string
      cgst: string
      sgst: string
      igst: string
      amount: string
      item: { code: string; name: string; color: string | null }
      sizes: Array<{ qty: string; size: { code: string } }>
    }>
  }
}

/**
 * The credit note, as GST asks for it: against the original invoice by number
 * and date, both GSTINs, each line with its HSN, taxable value and the GST
 * reversed, and why.
 */
export default function PrintCreditNote() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api
      .get<{ data: Payload }>(`/sales/credit-notes/${id}/print`)
      .then((r) => setData(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that credit note.'))
  }, [id])
  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the credit note…</p>

  const { company, template, note: n, taxMode } = data
  const c = n.customer
  const address = [c.billingAddress, c.billingCity, c.billingState, c.billingPincode].filter(Boolean).join(', ')
  const isReturn = n.type === 'RETURN'
  const columns: SheetColumn[] = [
    { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
    { key: 'item', head: isReturn ? 'Goods returned' : 'Credited on', width: '37%' },
    { key: 'hsn', head: 'HSN', width: '8%', align: 'center' },
    { key: 'qty', head: 'Qty', width: '8%', align: 'right' },
    { key: 'taxable', head: 'Taxable value', width: '14%', align: 'right' },
    { key: 'gst', head: 'GST', width: '7%', align: 'right' },
    { key: 'tax', head: 'Tax', width: '9%', align: 'right' },
    { key: 'amount', head: 'Amount (₹)', width: '12%', align: 'right' },
  ]
  const rows = n.lines.map((l, i) => ({
    key: l.id,
    cells: {
      sn: i + 1,
      item: (
        <>
          <div style={{ fontWeight: 600 }}>
            {l.item.name}
            {l.item.color ? ` · ${l.item.color}` : ''}
          </div>
          <div style={{ fontSize: '8.5px', color: GREY, marginTop: '1px' }}>
            <span style={CODE}>{l.item.code}</span>
            {l.sizes.length > 0 && ` · ${l.sizes.map((s) => `${s.size.code} ${qty(s.qty)}`).join(' · ')}`}
          </div>
        </>
      ),
      hsn: <span style={{ fontSize: '9px', color: GREY }}>{l.hsnCode ?? '—'}</span>,
      qty: Number(l.qty) > 0 ? <strong>{qty(l.qty)}</strong> : '—',
      taxable: money(l.taxableValue),
      gst: `${Number(l.gstRate)}%`,
      tax: money(Number(l.cgst) + Number(l.sgst) + Number(l.igst)),
      amount: money(l.amount),
    },
  }))
  const totals: Array<[string, string]> = [
    ['Taxable value', money(n.taxableAmount)],
    ...(taxMode === 'CGST_SGST' ? ([['CGST', money(n.cgst)], ['SGST', money(n.sgst)]] as Array<[string, string]>) : taxMode === 'IGST' ? ([['IGST', money(n.igst)]] as Array<[string, string]>) : []),
    ...(Math.abs(Number(n.roundOff)) >= 0.005 ? ([['Rounding', money(n.roundOff)]] as Array<[string, string]>) : []),
  ]
  const banner = n.status === 'CANCELLED' ? `CANCELLED on ${longDate(n.cancelledAt)}${n.cancelReason ? ` — ${n.cancelReason}` : ''}.` : null

  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={n.noteNumber}
      dateLabel="Date"
      date={longDate(n.noteDate) ?? ''}
      backHref="/sales/returns"
      backLabel="Returns & credit notes"
      banner={banner}
      panels={[
        {
          title: 'Customer',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY }}>{c.name}</div>
              {address && <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>{address}</div>}
              <div style={{ marginTop: '4px' }}>
                <Fact label="GSTIN" value={c.gstin ?? 'Unregistered'} mono />
                <Fact label="State" value={c.billingState ? `${c.billingState}${c.billingStateCode ? ` (${c.billingStateCode})` : ''}` : null} />
              </div>
            </>
          ),
        },
        {
          title: 'Against',
          body: (
            <>
              <Fact label="Invoice" value={n.invoice ? `${n.invoice.invoiceNumber}, ${longDate(n.invoice.invoiceDate)}` : null} mono />
              <Fact label="Kind" value={isReturn ? 'Sales return' : 'Price adjustment'} />
              <Fact label="Reason" value={n.reason} />
              <Fact label="Place of supply" value={n.placeOfSupplyCode ? `${data.placeOfSupplyState ?? ''} (${n.placeOfSupplyCode})` : null} />
              <Fact label="Goods into" value={n.warehouse?.name} />
            </>
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      minRows={4}
      after={
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 250px', gap: '7px', marginTop: '8px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
            {template.showAmountInWords !== false && (
              <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                <Eyebrow style={{ color: GREY }}>Amount in words</Eyebrow>
                <div style={{ fontSize: '10px', color: INK, marginTop: '3px' }}>{data.totalInWords}</div>
              </div>
            )}
            {n.notes && (
              <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
                <div style={{ fontSize: '10px', color: GREY, marginTop: '3px' }}>{n.notes}</div>
              </div>
            )}
          </div>
          <div style={{ border: `1px solid ${RULE}`, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '6px 11px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {totals.map(([label, value]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: INK }}>
                  <span>{label}</span>
                  <span style={NUM}>{value}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 11px', background: NAVY, color: '#fff', marginTop: 'auto' }}>
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>Credit total</span>
              <span style={{ fontSize: '13px', fontWeight: 700, ...NUM }}>₹{money(n.totalAmount)}</span>
            </div>
          </div>
        </div>
      }
      signatures={[
        { role: "Customer's acknowledgement", who: null },
        { role: `For ${company.name} — Authorised signatory`, who: n.createdBy?.name },
      ]}
      footerNote={template.footerNote ?? 'Credit note issued under section 34 of the CGST Act against the invoice above.'}
    />
  )
}
