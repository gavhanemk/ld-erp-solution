'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { StoreSheet, Fact, Eyebrow, qty, money, longDate, CODE, GREY, INK, MUTED, NAVY, NUM, RULE, type SheetColumn } from '@/components/print/StoreSheet'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; termsText: string | null; footerNote: string | null; showHsn: boolean; showAmountInWords: boolean }
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
  placeOfSupplyState: string | null
  totalInWords: string
  quote: {
    quoteNumber: string
    quoteDate: string
    validUntil: string | null
    status: string
    isJobWork: boolean
    customerRef: string | null
    salesperson: string | null
    placeOfSupplyCode: string | null
    subtotal: string
    discountAmount: string
    taxableAmount: string
    cgst: string
    sgst: string
    igst: string
    roundOff: string
    totalAmount: string
    terms: string | null
    notes: string | null
    customer: { name: string; gstin: string | null; phone: string | null; billingAddress: string | null; billingCity: string | null; billingState: string | null; billingPincode: string | null }
    brand: { name: string }
    createdBy: { name: string } | null
    lines: Array<{
      id: string
      styleCode: string | null
      color: string | null
      description: string | null
      qty: string
      unitPrice: string
      discount: string
      gstRate: string
      hsnCode: string | null
      amount: string
      item: { code: string; name: string; color: string | null; hsnCode: string | null }
    }>
  }
}

/**
 * The quotation sent to a buyer: garments, rates, GST and how long the price
 * holds. The BOM cost kept on each line is internal and never printed. Not an
 * order and not an invoice, and it says so.
 */
export default function PrintQuotation() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api
      .get<{ data: Payload }>(`/sales/quotations/${id}/print`)
      .then((r) => setData(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that quotation.'))
  }, [id])
  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the quotation…</p>

  const { company, template, quote: q, taxMode } = data
  const c = q.customer
  const address = [c.billingAddress, c.billingCity, c.billingState, c.billingPincode].filter(Boolean).join(', ')
  const showHsn = template.showHsn !== false
  const columns: SheetColumn[] = [
    { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
    { key: 'item', head: 'Style / Description', width: showHsn ? '37%' : '45%' },
    ...(showHsn ? [{ key: 'hsn', head: 'HSN', width: '8%', align: 'center' as const }] : []),
    { key: 'qty', head: 'Pieces', width: '10%', align: 'right' },
    { key: 'rate', head: q.isJobWork ? 'Job charge' : 'Rate', width: '11%', align: 'right' },
    { key: 'disc', head: 'Disc', width: '7%', align: 'right' },
    { key: 'gst', head: 'GST', width: '7%', align: 'right' },
    { key: 'amount', head: 'Amount (₹)', width: '15%', align: 'right' },
  ]
  const rows = q.lines.map((l, i) => ({
    key: l.id,
    cells: {
      sn: i + 1,
      item: (
        <>
          <div style={{ fontWeight: 600 }}>
            {l.item.name}
            {l.color || l.item.color ? ` · ${l.color || l.item.color}` : ''}
          </div>
          <div style={{ fontSize: '8.5px', color: GREY, marginTop: '1px' }}>
            <span style={CODE}>{l.item.code}</span>
            {l.styleCode ? ` · Style ${l.styleCode}` : ''}
          </div>
          {l.description && <div style={{ fontSize: '8.5px', color: INK, marginTop: '1px' }}>{l.description}</div>}
        </>
      ),
      hsn: <span style={{ fontSize: '9px', color: GREY }}>{l.hsnCode ?? l.item.hsnCode ?? '—'}</span>,
      qty: <strong>{qty(l.qty)}</strong>,
      rate: money(l.unitPrice),
      disc: Number(l.discount) > 0 ? `${Number(l.discount)}%` : '—',
      gst: `${Number(l.gstRate)}%`,
      amount: money(l.amount),
    },
  }))
  const totals: Array<[string, string]> = [
    ['Value', money(q.subtotal)],
    ...(Number(q.discountAmount) > 0 ? ([['Discount', `− ${money(q.discountAmount)}`]] as Array<[string, string]>) : []),
    ['Taxable value', money(q.taxableAmount)],
    ...(taxMode === 'CGST_SGST' ? ([['CGST', money(q.cgst)], ['SGST', money(q.sgst)]] as Array<[string, string]>) : taxMode === 'IGST' ? ([['IGST', money(q.igst)]] as Array<[string, string]>) : []),
    ...(Math.abs(Number(q.roundOff)) >= 0.005 ? ([['Rounding', money(q.roundOff)]] as Array<[string, string]>) : []),
  ]
  const terms = q.terms || template.termsText
  const banner = q.status === 'LOST' ? 'NOT ACCEPTED — this quotation was declined.' : q.status === 'DRAFT' ? 'DRAFT — not yet sent to the buyer.' : null

  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={q.quoteNumber}
      dateLabel="Date"
      date={longDate(q.quoteDate) ?? ''}
      backHref="/sales/quotations"
      backLabel="Quotations"
      banner={banner}
      panels={[
        {
          title: 'To',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY }}>{c.name}</div>
              {address && <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>{address}</div>}
              <div style={{ marginTop: '4px' }}>
                <Fact label="GSTIN" value={c.gstin ?? 'Unregistered'} mono />
                <Fact label="Phone" value={c.phone} />
              </div>
            </>
          ),
        },
        {
          title: 'Quotation',
          body: (
            <>
              <Fact label="Valid until" value={longDate(q.validUntil)} />
              <Fact label="Your reference" value={q.customerRef} />
              <Fact label="Brand" value={q.brand.name} />
              <Fact label="Type" value={q.isJobWork ? 'Job work (your fabric)' : null} />
              <Fact label="Place of supply" value={q.placeOfSupplyCode ? `${data.placeOfSupplyState ?? ''} (${q.placeOfSupplyCode})` : null} />
              <Fact label="Contact" value={q.salesperson} />
            </>
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      minRows={5}
      after={
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 250px', gap: '7px', marginTop: '8px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              {template.showAmountInWords !== false && (
                <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                  <Eyebrow style={{ color: GREY }}>Amount in words</Eyebrow>
                  <div style={{ fontSize: '10px', color: INK, marginTop: '3px' }}>{data.totalInWords}</div>
                </div>
              )}
              {q.notes && (
                <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                  <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
                  <div style={{ fontSize: '10px', color: GREY, marginTop: '3px', whiteSpace: 'pre-line' }}>{q.notes}</div>
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
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>Quoted total</span>
                <span style={{ fontSize: '13px', fontWeight: 700, ...NUM }}>₹{money(q.totalAmount)}</span>
              </div>
            </div>
          </div>
          {terms && (
            <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '7px' }}>
              <Eyebrow style={{ color: GREY }}>Terms</Eyebrow>
              <div style={{ fontSize: '9.5px', color: INK, marginTop: '3px', lineHeight: 1.6, whiteSpace: 'pre-line' }}>{terms}</div>
            </div>
          )}
        </>
      }
      signatures={[{ role: `For ${company.name}`, who: q.createdBy?.name }]}
      footerNote={template.footerNote ?? 'Quotation only: not an order and not an invoice. Prices hold until the date above.'}
    />
  )
}
