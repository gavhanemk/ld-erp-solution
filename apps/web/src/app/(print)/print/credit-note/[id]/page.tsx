'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import {
  StoreSheet,
  Dash,
  Note,
  PartyLine,
  TaxByRate,
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
  /** The own brand the order is made under, carried from start to end. */
  brand?: { name: string; type: string } | null
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
  const totalLines: TotalLine[] = totals.map(([label, value]) => ({ label, value }))
  const banner = n.status === 'CANCELLED' ? `CANCELLED on ${longDate(n.cancelledAt)}${n.cancelReason ? ` — ${n.cancelReason}` : ''}.` : null

  // The GST reversed at each rate, one line per rate as the purchase order prints it.
  const byRate = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number }>()
  for (const l of n.lines) {
    const rate = Number(l.gstRate)
    const r = byRate.get(rate) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 }
    r.taxable += Number(l.taxableValue)
    r.cgst += Number(l.cgst)
    r.sgst += Number(l.sgst)
    r.igst += Number(l.igst)
    byRate.set(rate, r)
  }
  const taxRows = [...byRate.entries()]
    .filter(([, r]) => r.taxable > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([rate, r]) => ({ gstRate: rate, ...r }))

  // Laid out like the purchase order (27 Nov 2026): the customer in the "To,"
  // block with the note's facts and the invoice it is against beside it.
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
      party={{
        name: c.name,
        lines: (
          <>
            <PartyLine label="Address-" value={address || null} />
            <PartyLine label="GST No" value={c.gstin ?? 'Unregistered'} mono={Boolean(c.gstin)} />
            <PartyLine
              label="State"
              value={c.billingState ? `${c.billingState}${c.billingStateCode ? ` (${c.billingStateCode})` : ''}` : null}
            />
            <PartyLine
              label="Place of supply"
              value={n.placeOfSupplyCode ? `${data.placeOfSupplyState ?? ''} (${n.placeOfSupplyCode})` : null}
            />
          </>
        ),
        meta: [
          ['Credit Note No', n.noteNumber, true],
          ['Date', shortDate(n.noteDate), true],
          ['Against invoice', n.invoice ? `${n.invoice.invoiceNumber}, ${shortDate(n.invoice.invoiceDate)}` : null, true],
          ['Kind', isReturn ? 'Sales return' : 'Price adjustment'],
          !!data.brand?.name && ['Brand', data.brand.name],
          !!n.warehouse?.name && ['Goods into', n.warehouse.name],
        ],
      }}
      bands={[n.reason ? { label: 'Reason', body: n.reason } : null]}
      columns={columns}
      rows={rows}
      after={
        <>
          <WordsAndTotals
            words={template.showAmountInWords !== false ? data.totalInWords : null}
            left={<Note title="Special notes">{n.notes || <Dash />}</Note>}
            totals={<TotalsBox rows={totalLines} totalLabel="Credit total" total={`₹ ${money(n.totalAmount)}`} />}
          />
          <TaxByRate rows={taxRows} split={taxMode} />
          {template.declaration && <div style={{ fontSize: '9.5px', marginTop: '7px' }}>{template.declaration}</div>}
        </>
      }
      signatures={[
        { role: "Customer's acknowledgement", who: null },
        { role: `For ${company.name} — Authorised signatory`, who: n.createdBy?.name },
      ]}
      footerNote={template.footerNote ?? 'Credit note issued under section 34 of the CGST Act against the invoice above.'}
    />
  )
}
