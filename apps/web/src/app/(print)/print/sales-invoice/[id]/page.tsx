'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import type { ChargeTaxTreatment } from '@ld-erp/shared'
import { saleChargeRow } from '@/components/print/saleChargeRow'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { lineDetails } from '@/components/sales/OrderLinesView'
import {
  StoreSheet,
  Dash,
  Fact,
  Eyebrow,
  Note,
  PartyLine,
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
  NUM,
  type SheetColumn,
  type TotalLine,
} from '@/components/print/StoreSheet'
import { DocTable, type DocColumn, type DocRow } from '@/components/print/doc'

interface Payload {
  /** The own brand the order is made under, carried from start to end. */
  brand?: { name: string; type: string } | null
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
    charges: Array<{ id: string; amount: string; netAmount?: string | null; taxTreatment?: ChargeTaxTreatment | null; gstRate: string; cgst: string; sgst: string; igst: string; chargeType: { name: string } }>
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
    [inv.charges.length ? 'Taxable value of the goods' : 'Taxable value', money(inv.taxableAmount)],
    // Each charge at its value without GST; its GST is in the CGST/SGST or IGST rows.
    ...inv.charges.map(saleChargeRow),
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

  const bank = [company.bankName, company.bankBranch].filter(Boolean).join(', ')
  const termsText = inv.terms || template.termsText
  const totals: TotalLine[] = [
    { label: `Pieces${inv.dc?.cartons ? ` · ${inv.dc.cartons} cartons` : ''}`, value: qty(pieces) },
    ...totalRows.map(([label, value]) => ({ label, value })),
  ]

  // The HSN-wise summary GST asks for: goods by code and rate, then each
  // charge at a rate of its own. Drawn with the document kit's ruled table,
  // as the purchase bill draws its own.
  const hsnColumns: DocColumn[] = [
    { key: 'hsn', head: 'HSN / charge', weight: 26 },
    { key: 'taxable', head: 'Taxable value (₹)', weight: 18, align: 'right' },
    { key: 'rate', head: 'Rate', weight: 9, align: 'center' },
    ...(taxMode === 'IGST'
      ? [{ key: 'igst', head: 'IGST (₹)', weight: 16, align: 'right' as const }]
      : [
          { key: 'cgst', head: 'CGST (₹)', weight: 14, align: 'right' as const },
          { key: 'sgst', head: 'SGST (₹)', weight: 14, align: 'right' as const },
        ]),
    { key: 'tax', head: 'Total tax (₹)', weight: 16, align: 'right' },
  ]
  const hsnRows: DocRow[] = data.hsnSummary.map((r, i) => ({
    key: `${r.hsn}-${r.rate}-${i}`,
    cells: {
      hsn: <span style={NUM}>{r.hsn}</span>,
      taxable: money(r.taxable),
      rate: `${r.rate}%`,
      igst: money(r.igst),
      cgst: money(r.cgst),
      sgst: money(r.sgst),
      tax: money(r.cgst + r.sgst + r.igst),
    },
  }))

  // Laid out like the purchase order (27 Nov 2026): the buyer in the "Bill to"
  // block with the invoice's facts beside it, then where the goods went.
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
      party={{
        heading: 'Bill to,',
        name: c.name,
        lines: (
          <>
            <PartyLine label="Address-" value={billing || null} />
            <PartyLine label="GST No" value={c.gstin ?? 'Unregistered'} mono={Boolean(c.gstin)} />
            <PartyLine
              label="State"
              value={c.billingState ? `${c.billingState}${c.billingStateCode ? ` (${c.billingStateCode})` : ''}` : null}
            />
            <PartyLine label="Contact No" value={c.phone} mono />
            <PartyLine
              label="Place of supply"
              value={
                inv.placeOfSupplyCode
                  ? `${data.placeOfSupplyState ?? ''} (${inv.placeOfSupplyCode})${taxMode === 'IGST' ? ', inter-state' : ''}`
                  : null
              }
            />
          </>
        ),
        meta: [
          ['Invoice No', inv.invoiceNumber, true],
          ['Invoice Date', shortDate(inv.invoiceDate), true],
          !!inv.dueDate && ['Due date', shortDate(inv.dueDate), true],
          !!inv.so && ['Our order', `${inv.so.soNumber}, ${shortDate(inv.so.orderDate)}`, true],
          !!inv.so?.customerPORef && [
            'Your PO',
            `${inv.so.customerPORef}${inv.so.customerPODate ? `, ${shortDate(inv.so.customerPODate)}` : ''}`,
          ],
          !!inv.dc && ['Challan', `${inv.dc.dcNumber}, ${shortDate(inv.dc.dcDate)}`, true],
          !!inv.eWayBillNumber && [
            'E-way bill',
            `${inv.eWayBillNumber}${inv.eWayBillDate ? `, ${shortDate(inv.eWayBillDate)}` : ''}`,
            true,
          ],
          !!inv.transporter && ['Transporter', inv.transporter],
          !!inv.vehicleNumber && ['Vehicle', inv.vehicleNumber, true],
          !!inv.lrNumber && ['LR No', inv.lrNumber, true],
          !!data.brand?.name && ['Brand', data.brand.name],
          ['Reverse charge', 'No'],
        ],
      }}
      bands={[
        {
          icon: 'truck',
          label: 'Ship to',
          body: (
            <>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{c.name}</div>
              <div style={{ marginTop: '1px' }}>{inv.shippingAddress || billing || '—'}</div>
            </>
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      after={
        <>
          <WordsAndTotals
            words={template.showAmountInWords !== false ? data.totalInWords : null}
            left={
              <>
                {template.showAmountInWords !== false && <Note title="Tax in words">{data.taxInWords}</Note>}
                {template.showBankDetails !== false && (company.bankAccount || company.upiId) && (
                  <Note title="Pay to">
                    <Fact label="Bank" value={bank || null} labelWidth={52} />
                    <Fact label="Account" value={company.bankAccount} mono labelWidth={52} />
                    <Fact label="IFSC" value={company.bankIFSC} mono labelWidth={52} />
                    <Fact label="UPI" value={company.upiId} mono labelWidth={52} />
                  </Note>
                )}
                <Note title="Special notes">{inv.notes || <Dash />}</Note>
              </>
            }
            totals={<TotalsBox rows={totals} totalLabel="Invoice total" total={`₹ ${money(inv.totalAmount)}`} />}
          />
          {hsnRows.length > 0 && (
            <div style={{ breakInside: 'avoid', marginTop: '9px' }}>
              <Eyebrow>HSN-wise tax summary</Eyebrow>
              <DocTable columns={hsnColumns} rows={hsnRows} style={{ marginTop: '3px' }} />
            </div>
          )}
          <Terms text={termsText} />
          <div style={{ fontSize: '9.5px', marginTop: '7px' }}>{template.declaration || DECLARATION}</div>
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
