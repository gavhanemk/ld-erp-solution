'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { lineDetails } from '@/components/sales/OrderLinesView'
import {
  StoreSheet,
  Fact,
  Eyebrow,
  qty,
  money,
  longDate,
  CODE,
  GREY,
  INK,
  MUTED,
  NAVY,
  NUM,
  RULE,
  RULE_SOFT,
  type SheetColumn,
} from '@/components/print/StoreSheet'

interface Payload {
  company: Record<string, string | null>
  template: {
    title: string
    termsText: string | null
    declaration: string | null
    footerNote: string | null
    showHsn: boolean
    showAmountInWords: boolean
    showBankDetails: boolean
  }
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
  placeOfSupplyState: string | null
  totalInWords: string
  taxInWords: string
  hsnSummary: Array<{ hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number }>
  invoice: {
    invoiceNumber: string
    invoiceDate: string
    dueDate: string | null
    status: string
    placeOfSupplyCode: string | null
    billingAddress: string | null
    shippingAddress: string | null
    transporter: string | null
    vehicleNumber: string | null
    lrNumber: string | null
    eWayBillNumber: string | null
    eWayBillDate: string | null
    subtotal: string
    discountAmount: string
    taxableAmount: string
    cgst: string
    sgst: string
    igst: string
    otherCharges: string
    roundOff: string
    totalAmount: string
    notes: string | null
    terms: string | null
    cancelledAt: string | null
    cancelReason: string | null
    customer: {
      name: string
      gstin: string | null
      phone: string | null
      billingAddress: string | null
      billingCity: string | null
      billingState: string | null
      billingStateCode: string | null
      billingPincode: string | null
    }
    so: { soNumber: string; orderDate: string; customerPORef: string | null; customerPODate: string | null; isJobWork: boolean } | null
    dc: {
      dcNumber: string
      dcDate: string
      cartons: number | null
      lines: Array<{ soLineId: string | null; sizes: Array<{ qty: string; size: { code: string; sequence: number } }> }>
    } | null
    lines: Array<{
      id: string
      soLineId: string | null
      description: string | null
      hsnCode: string | null
      qty: string
      unitPrice: string
      discount: string
      taxableValue: string
      gstRate: string
      cgst: string
      sgst: string
      igst: string
      amount: string
      item: { code: string; name: string; color: string | null; uom: { symbol: string } | null }
      soLine: { styleCode: string | null; color: string | null; gender: string | null; fabric: string | null; printName: string | null } | null
    }>
    charges: Array<{ id: string; amount: string; gstRate: string; cgst: string; sgst: string; igst: string; chargeType: { name: string } }>
    createdBy: { name: string } | null
    cancelledBy: { name: string } | null
  }
}

const COPIES = ['Original for recipient', 'Duplicate for transporter', 'Triplicate for supplier']
const DECLARATION =
  'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.'

/**
 * The tax invoice, as GST asks for it: our GSTIN and the buyer's, the place of
 * supply, each line with its HSN code, rate and taxable value, the tax split
 * CGST + SGST or IGST, an HSN-wise summary, and the total in words. Three
 * copies, picked above the sheet. No IRN: LD is below the e-invoice limit.
 */
export default function PrintSalesInvoice() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copy, setCopy] = useState(COPIES[0])

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/sales/invoices/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that invoice.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the invoice…</p>

  const { company, template, invoice: inv, taxMode } = data
  const c = inv.customer
  const billing =
    inv.billingAddress || [c.billingAddress, c.billingCity, c.billingState, c.billingPincode].filter(Boolean).join(', ')
  const showHsn = template.showHsn !== false
  const sizesOf = (soLineId: string | null) =>
    [...(inv.dc?.lines.find((l) => l.soLineId === soLineId)?.sizes ?? [])].sort((a, b) => a.size.sequence - b.size.sequence)

  const columns: SheetColumn[] = [
    { key: 'sn', head: 'S.N', width: '4%', align: 'center' },
    { key: 'item', head: 'Description of goods', width: showHsn ? '31%' : '38%' },
    ...(showHsn ? [{ key: 'hsn', head: 'HSN', width: '7%', align: 'center' as const }] : []),
    { key: 'qty', head: 'Qty', width: '7%', align: 'right' },
    { key: 'rate', head: inv.so?.isJobWork ? 'Job charge' : 'Rate', width: '8%', align: 'right' },
    { key: 'disc', head: 'Disc', width: '5%', align: 'right' },
    { key: 'taxable', head: 'Taxable value', width: '11%', align: 'right' },
    { key: 'gst', head: 'GST', width: '6%', align: 'right' },
    { key: 'tax', head: 'Tax', width: '9%', align: 'right' },
    { key: 'amount', head: 'Amount (₹)', width: '12%', align: 'right' },
  ]

  const rows = inv.lines.map((l, i) => {
    const colour = l.soLine?.color || l.item.color
    const sizes = sizesOf(l.soLineId)
    const details = l.soLine ? lineDetails(l.soLine) : ''
    const tax = Number(l.cgst) + Number(l.sgst) + Number(l.igst)
    return {
      key: l.id,
      cells: {
        sn: i + 1,
        item: (
          <>
            <div style={{ fontWeight: 600 }}>
              {l.item.name}
              {colour ? ` · ${colour}` : ''}
            </div>
            <div style={{ fontSize: '8.5px', color: GREY, marginTop: '1px' }}>
              <span style={CODE}>{l.item.code}</span>
              {l.soLine?.styleCode ? ` · Style ${l.soLine.styleCode}` : ''}
              {details ? ` · ${details}` : ''}
            </div>
            {sizes.length > 0 && (
              <div style={{ fontSize: '8.5px', color: GREY, marginTop: '1px', ...NUM }}>
                {sizes.map((s) => `${s.size.code} ${qty(s.qty)}`).join(' · ')}
              </div>
            )}
            {l.description && <div style={{ fontSize: '8.5px', color: INK, marginTop: '1px' }}>{l.description}</div>}
          </>
        ),
        hsn: <span style={{ fontSize: '9px', color: GREY }}>{l.hsnCode ?? '—'}</span>,
        qty: (
          <strong>
            {qty(l.qty)}
            {l.item.uom?.symbol ? <span style={{ fontWeight: 400, color: GREY }}> {l.item.uom.symbol}</span> : null}
          </strong>
        ),
        rate: money(l.unitPrice),
        disc: Number(l.discount) > 0 ? `${Number(l.discount)}%` : '—',
        taxable: money(l.taxableValue),
        gst: Number(l.gstRate) > 0 ? `${Number(l.gstRate)}%` : 'Nil',
        tax: tax > 0 ? money(tax) : '—',
        amount: money(l.amount),
      },
    }
  })

  const pieces = inv.lines.reduce((s, l) => s + Number(l.qty), 0)
  const banner =
    inv.status === 'CANCELLED'
      ? `CANCELLED on ${longDate(inv.cancelledAt)}${inv.cancelledBy ? ` by ${inv.cancelledBy.name}` : ''}${
          inv.cancelReason ? ` — ${inv.cancelReason}` : ''
        }. This invoice is not payable.`
      : null

  const totalRows: Array<[string, string]> = [
    ['Value of goods', money(inv.subtotal)],
    ...(Number(inv.discountAmount) > 0 ? ([['Discount', `− ${money(inv.discountAmount)}`]] as Array<[string, string]>) : []),
    ['Taxable value', money(inv.taxableAmount)],
    ...inv.charges.map((ch) => [`${ch.chargeType.name} @ ${Number(ch.gstRate)}%`, money(ch.amount)] as [string, string]),
    ...(taxMode === 'CGST_SGST'
      ? ([
          ['CGST', money(inv.cgst)],
          ['SGST', money(inv.sgst)],
        ] as Array<[string, string]>)
      : taxMode === 'IGST'
        ? ([['IGST', money(inv.igst)]] as Array<[string, string]>)
        : []),
    ...(Number(inv.otherCharges) > 0 ? ([['Other charges', money(inv.otherCharges)]] as Array<[string, string]>) : []),
    ...(Math.abs(Number(inv.roundOff)) >= 0.005 ? ([['Rounding', money(inv.roundOff)]] as Array<[string, string]>) : []),
  ]

  const th: React.CSSProperties = { border: `1px solid ${RULE_SOFT}`, padding: '3px 5px', fontSize: '8.5px', color: GREY, fontWeight: 600 }
  const td: React.CSSProperties = { border: `1px solid ${RULE_SOFT}`, padding: '3px 5px', fontSize: '9px', color: INK, ...NUM }
  const bank = [company.bankName, company.bankBranch].filter(Boolean).join(', ')
  const termsText = inv.terms || template.termsText

  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={inv.invoiceNumber}
      dateLabel="Invoice date"
      date={longDate(inv.invoiceDate) ?? ''}
      backHref="/sales/invoices?tab=invoices"
      backLabel="Invoices"
      banner={banner}
      copyLabel={copy}
      options={
        <label>
          Copy
          <SmartSelect value={copy} onChange={(e) => setCopy(e.target.value)}>
            {COPIES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </SmartSelect>
        </label>
      }
      panels={[
        {
          title: 'Bill to',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>{c.name}</div>
              {billing && <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>{billing}</div>}
              <div style={{ marginTop: '4px' }}>
                <Fact label="GSTIN" value={c.gstin ?? 'Unregistered'} mono />
                <Fact label="State" value={c.billingState ? `${c.billingState}${c.billingStateCode ? ` (${c.billingStateCode})` : ''}` : null} />
              </div>
            </>
          ),
        },
        {
          title: 'Ship to',
          body: (
            <>
              <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55 }}>{inv.shippingAddress || billing}</div>
              <div style={{ marginTop: '4px' }}>
                <Fact
                  label="Place of supply"
                  value={inv.placeOfSupplyCode ? `${data.placeOfSupplyState ?? ''} (${inv.placeOfSupplyCode})` : null}
                />
                <Fact label="Transporter" value={inv.transporter} />
                <Fact label="Vehicle" value={inv.vehicleNumber} mono />
                <Fact label="LR No" value={inv.lrNumber} mono />
              </div>
            </>
          ),
        },
        {
          title: 'Invoice',
          body: (
            <>
              <Fact label="Due date" value={longDate(inv.dueDate)} />
              <Fact label="Our order" value={inv.so ? `${inv.so.soNumber}, ${longDate(inv.so.orderDate)}` : null} mono />
              <Fact
                label="Your PO"
                value={
                  inv.so?.customerPORef
                    ? `${inv.so.customerPORef}${inv.so.customerPODate ? `, ${longDate(inv.so.customerPODate)}` : ''}`
                    : null
                }
              />
              <Fact label="Challan" value={inv.dc ? `${inv.dc.dcNumber}, ${longDate(inv.dc.dcDate)}` : null} mono />
              <Fact
                label="E-way bill"
                value={inv.eWayBillNumber ? `${inv.eWayBillNumber}${inv.eWayBillDate ? `, ${longDate(inv.eWayBillDate)}` : ''}` : null}
                mono
              />
              <Fact label="Reverse charge" value="No" />
            </>
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      minRows={5}
      after={
        <>
          {/* The HSN-wise summary GST asks for: goods by code and rate, then each charge. */}
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '8px' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>HSN / charge</th>
                <th style={{ ...th, textAlign: 'right' }}>Taxable value</th>
                <th style={{ ...th, textAlign: 'right' }}>Rate</th>
                {taxMode === 'IGST' ? (
                  <th style={{ ...th, textAlign: 'right' }}>IGST</th>
                ) : (
                  <>
                    <th style={{ ...th, textAlign: 'right' }}>CGST</th>
                    <th style={{ ...th, textAlign: 'right' }}>SGST</th>
                  </>
                )}
                <th style={{ ...th, textAlign: 'right' }}>Total tax</th>
              </tr>
            </thead>
            <tbody>
              {data.hsnSummary.map((r, i) => (
                <tr key={i}>
                  <td style={{ ...td, textAlign: 'left' }}>{r.hsn}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{money(r.taxable)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{r.rate}%</td>
                  {taxMode === 'IGST' ? (
                    <td style={{ ...td, textAlign: 'right' }}>{money(r.igst)}</td>
                  ) : (
                    <>
                      <td style={{ ...td, textAlign: 'right' }}>{money(r.cgst)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{money(r.sgst)}</td>
                    </>
                  )}
                  <td style={{ ...td, textAlign: 'right' }}>{money(r.cgst + r.sgst + r.igst)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 250px', gap: '7px', marginTop: '8px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              {template.showAmountInWords !== false && (
                <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                  <Eyebrow style={{ color: GREY }}>Amount in words</Eyebrow>
                  <div style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.55 }}>{data.totalInWords}</div>
                  <div style={{ fontSize: '9px', color: GREY, marginTop: '3px' }}>Tax: {data.taxInWords}</div>
                </div>
              )}
              {template.showBankDetails !== false && (company.bankAccount || company.upiId) && (
                <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                  <Eyebrow style={{ color: GREY }}>Pay to</Eyebrow>
                  <div style={{ marginTop: '3px' }}>
                    <Fact label="Bank" value={bank || null} />
                    <Fact label="Account" value={company.bankAccount} mono />
                    <Fact label="IFSC" value={company.bankIFSC} mono />
                    <Fact label="UPI" value={company.upiId} mono />
                  </div>
                </div>
              )}
              {inv.notes && (
                <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                  <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
                  <div style={{ fontSize: '10px', color: GREY, marginTop: '3px', lineHeight: 1.55 }}>{inv.notes}</div>
                </div>
              )}
            </div>
            <div style={{ border: `1px solid ${RULE}`, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '6px 11px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: GREY }}>
                  <span>Pieces{inv.dc?.cartons ? ` · ${inv.dc.cartons} cartons` : ''}</span>
                  <span style={NUM}>{qty(pieces)}</span>
                </div>
                {totalRows.map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: INK }}>
                    <span>{label}</span>
                    <span style={NUM}>{value}</span>
                  </div>
                ))}
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '7px 11px',
                  background: NAVY,
                  color: '#fff',
                  marginTop: 'auto',
                }}
              >
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>Invoice total</span>
                <span style={{ fontSize: '13px', fontWeight: 700, ...NUM }}>₹{money(inv.totalAmount)}</span>
              </div>
            </div>
          </div>
          {termsText && (
            <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '7px' }}>
              <Eyebrow style={{ color: GREY }}>Terms</Eyebrow>
              <div style={{ fontSize: '9.5px', color: INK, marginTop: '3px', lineHeight: 1.6, whiteSpace: 'pre-line' }}>{termsText}</div>
            </div>
          )}
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '7px' }}>
            <Eyebrow style={{ color: GREY }}>Declaration</Eyebrow>
            <div style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.6 }}>{template.declaration || DECLARATION}</div>
          </div>
        </>
      }
      signatures={[
        { role: "Customer's seal and signature", who: null },
        { role: `For ${company.name} — Authorised signatory`, who: inv.createdBy?.name },
      ]}
      footerNote={template.footerNote ?? 'Subject to local jurisdiction. This is a computer-generated invoice.'}
    />
  )
}
