'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import type { ChargeTaxTreatment } from '@ld-erp/shared'
import { saleChargeRow } from '@/components/print/saleChargeRow'
import {
  StoreSheet,
  Dash,
  Note,
  PartyLine,
  TaxByRate,
  Terms,
  TotalsBox,
  WordsAndTotals,
  qty,
  money,
  longDate,
  shortDate,
  CODE,
  GREY,
  INK,
  MUTED,
  type SheetColumn,
  type TotalLine,
} from '@/components/print/StoreSheet'

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
    /** Transport, packing: the order made from this quotation carries them as they are. */
    charges?: Array<{
      id: string
      amount: string
      netAmount?: string | null
      taxTreatment?: ChargeTaxTreatment | null
      gstRate: string
      cgst?: string | null
      sgst?: string | null
      igst?: string | null
      chargeType: { name: string }
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
    [q.charges?.length ? 'Taxable value of the goods' : 'Taxable value', money(q.taxableAmount)],
    // Each charge at its value without GST; its GST is in the CGST/SGST or IGST rows.
    ...(q.charges ?? []).map(saleChargeRow),
    ...(taxMode === 'CGST_SGST' ? ([['CGST', money(q.cgst)], ['SGST', money(q.sgst)]] as Array<[string, string]>) : taxMode === 'IGST' ? ([['IGST', money(q.igst)]] as Array<[string, string]>) : []),
    ...(Math.abs(Number(q.roundOff)) >= 0.005 ? ([['Rounding', money(q.roundOff)]] as Array<[string, string]>) : []),
  ]
  const terms = q.terms || template.termsText
  const banner = q.status === 'LOST' ? 'NOT ACCEPTED — this quotation was declined.' : q.status === 'DRAFT' ? 'DRAFT — not yet sent to the buyer.' : null

  // GST at each rate, one line per rate as the purchase order prints it: the
  // goods (after the quotation discount, spread across the lines as it was
  // when priced) and the charges at their value without GST.
  const subtotal = Number(q.subtotal)
  const factor = subtotal > 0 ? Number(q.taxableAmount) / subtotal : 1
  const byRate = new Map<number, { taxable: number; tax: number }>()
  const addRate = (rate: number, base: number, tax: number) => {
    const r = byRate.get(rate) ?? { taxable: 0, tax: 0 }
    r.taxable += base
    r.tax += tax
    byRate.set(rate, r)
  }
  for (const l of q.lines) {
    const rate = Number(l.gstRate)
    const base = Number(l.amount) * factor
    addRate(rate, base, (base * rate) / 100)
  }
  for (const ch of q.charges ?? []) {
    if (ch.taxTreatment === 'NON_TAXABLE') continue
    const rate = Number(ch.gstRate)
    const base = Number(ch.netAmount ?? ch.amount)
    const saved = ch.cgst != null || ch.sgst != null || ch.igst != null
    addRate(rate, base, saved ? Number(ch.cgst ?? 0) + Number(ch.sgst ?? 0) + Number(ch.igst ?? 0) : (base * rate) / 100)
  }
  const taxRows = [...byRate.entries()]
    .filter(([, r]) => r.taxable > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([rate, r]) => ({ gstRate: rate, taxable: r.taxable, cgst: r.tax / 2, sgst: r.tax / 2, igst: r.tax }))

  const totalLines: TotalLine[] = totals.map(([label, value]) => ({ label, value }))

  // Laid out like the purchase order (27 Nov 2026): the buyer in the "To,"
  // block with the quotation's facts beside it.
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
      party={{
        name: c.name,
        lines: (
          <>
            <PartyLine label="Address-" value={address || null} />
            <PartyLine label="GST No" value={c.gstin ?? 'Unregistered'} mono={Boolean(c.gstin)} />
            <PartyLine label="Contact No" value={c.phone} mono />
            <PartyLine
              label="Place of supply"
              value={
                q.placeOfSupplyCode
                  ? `${data.placeOfSupplyState ?? ''} (${q.placeOfSupplyCode})${taxMode === 'IGST' ? ', inter-state' : ''}`
                  : null
              }
            />
          </>
        ),
        meta: [
          ['Quotation No', q.quoteNumber, true],
          ['Quotation Date', shortDate(q.quoteDate), true],
          !!q.validUntil && ['Valid until', shortDate(q.validUntil), true],
          !!q.customerRef && ['Your reference', q.customerRef],
          ['Brand', q.brand.name],
          q.isJobWork && ['Type', 'Job work (your fabric)'],
          !!q.salesperson && ['Contact', q.salesperson],
        ],
      }}
      columns={columns}
      rows={rows}
      after={
        <>
          <WordsAndTotals
            words={template.showAmountInWords !== false ? data.totalInWords : null}
            left={<Note title="Special notes">{q.notes || <Dash />}</Note>}
            totals={<TotalsBox rows={totalLines} totalLabel="Quoted total" total={`₹ ${money(q.totalAmount)}`} />}
          />
          <TaxByRate rows={taxRows} split={taxMode} />
          <Terms text={terms} />
        </>
      }
      signatures={[{ role: `For ${company.name}`, who: q.createdBy?.name }]}
      footerNote={template.footerNote ?? 'Quotation only: not an order and not an invoice. Prices hold until the date above.'}
    />
  )
}
