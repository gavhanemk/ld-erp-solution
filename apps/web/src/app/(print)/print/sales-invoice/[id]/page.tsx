'use client'

import { Fragment, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import type { ChargeTaxTreatment } from '@ld-erp/shared'
import { saleChargeRow } from '@/components/print/saleChargeRow'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { lineDetails } from '@/components/sales/OrderLinesView'
import { SecondAddress } from '@/components/print/SecondAddress'
import {
  DocTable,
  DocumentSheet,
  Eyebrow,
  Signatures,
  Terms,
  CODE,
  HAIR,
  HEAVY,
  INK,
  LINE,
  NUM,
  money,
  qty,
  longDate,
  shortDate,
  type DocColumn,
  type DocRow,
} from '@/components/print/doc'

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
    /** Added 28 Nov 2026, as the old ERP's invoice carried them; null on earlier invoices. */
    lrDate?: string | null
    shipToName?: string | null
    shipToGstin?: string | null
    shipToState?: string | null
    shipToStateCode?: string | null
    bales?: number | null
    rolls?: number | null
    cartons?: number | null
    broker?: { name: string } | null
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
      shippingGstin?: string | null
      shippingState?: string | null
      shippingStateCode?: string | null
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
      /** Pieces (rolls) in a quantity in metres or kilos. */
      pcs?: string | null
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
/** A unit that is itself a count of pieces: its quantity is the pieces. */
const countsPieces = (symbol: string | null | undefined) =>
  /^(pcs?|nos?|pieces?|units?|set|sets|pair|pairs)$/i.test((symbol ?? '').trim())
/** A measured quantity (metres, kilos) to two places: 264.10, not 264.1. */
const measured = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 3 })
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
  if (!data) return <p style={{ padding: 48, color: INK }}>Opening the invoice…</p>

  const { company, template, invoice: inv, taxMode } = data
  const c = inv.customer
  const billing =
    inv.billingAddress || [c.billingAddress, c.billingCity, c.billingState, c.billingPincode].filter(Boolean).join(', ')
  const showHsn = template.showHsn !== false
  const showWords = template.showAmountInWords !== false
  const sizesOf = (soLineId: string | null) =>
    [...(inv.dc?.lines.find((l) => l.soLineId === soLineId)?.sizes ?? [])].sort((a, b) => a.size.sequence - b.size.sequence)

  // ── The lines ──
  // Compact (28 Nov 2026): the old invoice's use of the page. The challan each
  // line went on; PCS beside a quantity in metres or kilos, only when a line
  // has them; Disc only when a line has a discount; the tax itself in the HSN
  // summary and the totals. The description takes what the columns leave.
  const anyPcs = inv.lines.some((l) => l.pcs != null && !countsPieces(l.item.uom?.symbol))
  const anyDisc = inv.lines.some((l) => Number(l.discount) > 0)
  const fixed = 3.5 + 10 + (showHsn ? 7.5 : 0) + (anyPcs ? 5 : 0) + 10 + 8 + (anyDisc ? 5 : 0) + 10.5 + 4.5 + 11
  const columns: DocColumn[] = [
    { key: 'sn', head: 'S.N', width: '3.5%', align: 'center' },
    { key: 'ch', head: 'CH No.', width: '10%' },
    { key: 'item', head: 'Description of goods', width: `${(100 - fixed).toFixed(1)}%` },
    ...(showHsn ? [{ key: 'hsn', head: 'HSN', width: '7.5%', align: 'center' as const }] : []),
    ...(anyPcs ? [{ key: 'pcs', head: 'PCS', width: '5%', align: 'right' as const }] : []),
    { key: 'qty', head: 'Quantity', width: '10%', align: 'right' },
    { key: 'rate', head: inv.so?.isJobWork ? 'Job charge' : 'Rate', width: '8%', align: 'right' },
    ...(anyDisc ? [{ key: 'disc', head: 'Disc', width: '5%', align: 'right' as const }] : []),
    { key: 'taxable', head: 'Taxable value', width: '10.5%', align: 'right' },
    { key: 'gst', head: 'GST', width: '4.5%', align: 'right' },
    { key: 'amount', head: 'Amount (₹)', width: '11%', align: 'right' },
  ]

  const rows: DocRow[] = inv.lines.map((l, i) => {
    const colour = l.soLine?.color || l.item.color
    const sizes = sizesOf(l.soLineId)
    const details = l.soLine ? lineDetails(l.soLine) : ''
    const unit = l.item.uom?.symbol
    const isMeasured = Boolean(unit) && !countsPieces(unit)
    return {
      key: l.id,
      cells: {
        sn: i + 1,
        ch: <span style={{ fontSize: '8.5px', whiteSpace: 'nowrap', ...NUM }}>{inv.dc?.dcNumber ?? '—'}</span>,
        // Name, code and style on one line where they fit, so a plain line stays one line.
        item: (
          <>
            <div>
              <strong>{l.item.name}</strong>
              {colour ? ` · ${colour}` : ''}
              <span style={{ fontSize: '9.5px' }}>
                {' · '}
                <span style={CODE}>{l.item.code}</span>
                {l.soLine?.styleCode ? ` · Style ${l.soLine.styleCode}` : ''}
                {details ? ` · ${details}` : ''}
              </span>
            </div>
            {sizes.length > 0 && (
              <div style={{ fontSize: '9.5px', ...NUM }}>{sizes.map((s) => `${s.size.code} ${qty(s.qty)}`).join(' · ')}</div>
            )}
            {l.description && <div style={{ fontSize: '9.5px' }}>{l.description}</div>}
          </>
        ),
        hsn: <span style={{ fontSize: '9.5px', whiteSpace: 'nowrap', ...NUM }}>{l.hsnCode ?? '—'}</span>,
        pcs: l.pcs != null ? qty(l.pcs) : '—',
        qty: (
          <>
            <strong>{isMeasured ? measured(l.qty) : qty(l.qty)}</strong>
            {unit ? ` ${unit}` : ''}
          </>
        ),
        rate: money(l.unitPrice),
        disc: Number(l.discount) > 0 ? `${Number(l.discount)}%` : '—',
        taxable: money(l.taxableValue),
        gst: Number(l.gstRate) > 0 ? `${Number(l.gstRate)}%` : 'Nil',
        amount: <strong>{money(l.amount)}</strong>,
      },
    }
  })

  // Pieces: a line in pieces counts its quantity; one in metres or kilos its PCS.
  const pieces = inv.lines.reduce(
    (s, l) => s + (l.pcs != null ? Number(l.pcs) : countsPieces(l.item.uom?.symbol) ? Number(l.qty) : 0),
    0,
  )
  // Quantity in each unit that is not pieces — never added across units.
  const byUnit = new Map<string, number>()
  for (const l of inv.lines) {
    const unit = l.item.uom?.symbol ?? ''
    if (!countsPieces(unit) && unit) byUnit.set(unit, (byUnit.get(unit) ?? 0) + Number(l.qty))
  }
  const cartons = inv.cartons ?? inv.dc?.cartons ?? null
  const packages: Array<[string, number]> = (
    [
      ['Bales', inv.bales ?? 0],
      ['Rolls', inv.rolls ?? 0],
      ['Cartons', cartons ?? 0],
    ] as Array<[string, number]>
  ).filter(([, n]) => n > 0)
  const totalPackages = packages.reduce((n, [, v]) => n + v, 0)
  const packing = [
    ...packages.map(([label, n]) => `${label} ${qty(n)}`),
    ...(packages.length > 1 ? [`Total packages ${qty(totalPackages)}`] : []),
    ...(pieces > 0 ? [`Total pieces ${qty(pieces)}`] : []),
    ...[...byUnit.entries()].map(([unit, n]) => `${measured(n)} ${unit}`),
  ]

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
    // Always, with its sign, as the old invoice printed it.
    ['Round off', `${Number(inv.roundOff) > 0 ? '+' : Number(inv.roundOff) < 0 ? '−' : ''}${money(Math.abs(Number(inv.roundOff)))}`],
  ]

  const bank = [company.bankName, company.bankBranch].filter(Boolean).join(', ')
  const showBank = template.showBankDetails !== false && Boolean(company.bankAccount || company.upiId)
  const termsText = inv.terms || template.termsText

  // The HSN-wise summary GST asks for: goods by code and rate, then each
  // charge at a rate of its own, with a total row when there is more than one.
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
  const hsnTotal = data.hsnSummary.reduce(
    (t, r) => ({ taxable: t.taxable + r.taxable, cgst: t.cgst + r.cgst, sgst: t.sgst + r.sgst, igst: t.igst + r.igst }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0 },
  )
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
  if (data.hsnSummary.length > 1) {
    hsnRows.push({
      key: 'total',
      total: true,
      cells: {
        hsn: 'Total',
        taxable: money(hsnTotal.taxable),
        rate: '',
        igst: money(hsnTotal.igst),
        cgst: money(hsnTotal.cgst),
        sgst: money(hsnTotal.sgst),
        tax: money(hsnTotal.cgst + hsnTotal.sgst + hsnTotal.igst),
      },
    })
  }

  // The consignee, kept apart from the buyer: the invoice's own, else (on an
  // invoice from before 28 Nov 2026) the customer's shipping details.
  const shipName = inv.shipToName || c.name
  const shipGstin = inv.shipToGstin || c.shippingGstin || c.gstin
  const shipState = inv.shipToState || c.shippingState || c.billingState
  const shipCode = inv.shipToStateCode || c.shippingStateCode || c.billingStateCode
  const stateText = (state: string | null | undefined, code: string | null | undefined) =>
    state ? `${state}${code ? ` (${code})` : ''}` : code ? `Code ${code}` : null

  // The invoice's own facts, a number beside its date on each row; an empty
  // optional one is left out, and a row with neither is not printed.
  type Fact = [string, string, boolean] | null | undefined | '' | false
  const facts = (
    [
      [['Invoice No', inv.invoiceNumber, true], ['Invoice date', shortDate(inv.invoiceDate), true]],
      [inv.so && ['Order No', inv.so.soNumber, true], inv.so && ['Order date', shortDate(inv.so.orderDate), true]],
      [inv.so?.customerPORef && ['Your PO', inv.so.customerPORef, false], inv.so?.customerPODate && ['PO date', shortDate(inv.so.customerPODate), true]],
      [inv.dc && ['Challan No', inv.dc.dcNumber, true], inv.dc && ['Challan date', shortDate(inv.dc.dcDate), true]],
      [inv.lrNumber && ['LR No', inv.lrNumber, true], inv.lrDate && ['LR date', shortDate(inv.lrDate), true]],
      [
        inv.eWayBillNumber && ['E-way bill', `${inv.eWayBillNumber}${inv.eWayBillDate ? ` · ${shortDate(inv.eWayBillDate)}` : ''}`, true],
        inv.dueDate && ['Due date', shortDate(inv.dueDate), true],
      ],
      [data.brand?.name && ['Brand', data.brand.name, false], ['Reverse charge', 'No', false]],
    ] as Array<[Fact, Fact]>
  ).filter(([a, b]) => a || b)

  const LABEL: React.CSSProperties = { fontSize: '8px', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase' }
  const TEXT: React.CSSProperties = { fontSize: '10px', lineHeight: 1.35 }
  const factoryAddress = [company.address, company.city, company.state, company.pincode].filter(Boolean).join(', ')
  const contact = [company.phone && `Ph: ${company.phone}`, company.email && `Email: ${company.email}`].filter(Boolean).join(' · ')

  return (
    <DocumentSheet
      company={company}
      title={template.title}
      number={inv.invoiceNumber}
      date={longDate(inv.invoiceDate) ?? ''}
      backHref="/sales/invoices?tab=invoices"
      backLabel="Invoices"
      banner={banner}
      bare
      pageMargin="8mm 8mm 11mm 8mm"
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
      footerNote={template.footerNote ?? 'This is a computer-generated invoice.'}
    >
      {/* The heading and the copy on one row. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: '8px' }}>
        <span />
        <span style={{ fontSize: '15px', fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase' }}>{template.title}</span>
        <span style={{ justifySelf: 'end', border: LINE, padding: '1px 6px', ...LABEL }}>{copy}</span>
      </div>

      {/* The mill across the full width, so its address and numbers each take one line. */}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', border: LINE, padding: '5px 8px', marginTop: '3px' }}>
        {company.logoUrl && (
          // The one thing on the sheet in colour.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={company.logoUrl} alt="" style={{ height: '42px', width: 'auto', maxWidth: '90px', objectFit: 'contain', flexShrink: 0 }} />
        )}
        <div style={{ minWidth: 0, flex: 1, fontSize: '9.5px', lineHeight: 1.35 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '17px', fontWeight: 800, textTransform: 'uppercase', lineHeight: 1.1 }}>{company.name}</span>
            {company.manufacturerOf && <span style={{ fontWeight: 700 }}>Manufacturer of: {company.manufacturerOf}</span>}
          </div>
          {factoryAddress && <div>{factoryAddress}</div>}
          {company.address2 && (
            <div>
              <SecondAddress text={company.address2} />
            </div>
          )}
          <div>
            {contact && <>{contact} · </>}
            <strong>GSTIN</strong> <span style={CODE}>{company.gstin || '—'}</span>
            {company.pan && (
              <>
                {' · '}
                <strong>PAN</strong> <span style={CODE}>{company.pan}</span>
              </>
            )}
            {stateText(company.state, company.stateCode) && (
              <>
                {' · '}
                <strong>State</strong> {stateText(company.state, company.stateCode)}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Bill to over the consignee on the left, kept apart; the invoice's facts on the right. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', border: LINE, borderTop: 'none' }}>
        <div style={{ borderRight: LINE, minWidth: 0, ...TEXT }}>
          <div style={{ padding: '4px 8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span style={LABEL}>Bill to</span>
              {stateText(c.billingState, c.billingStateCode) && (
                <span style={{ fontSize: '9px' }}>
                  <strong>State</strong> {stateText(c.billingState, c.billingStateCode)}
                </span>
              )}
            </div>
            <div style={{ fontSize: '11.5px', fontWeight: 800, textTransform: 'uppercase', lineHeight: 1.2 }}>{c.name}</div>
            {billing && <div>{billing}</div>}
            <div>
              <strong>GSTIN</strong> <span style={CODE}>{c.gstin ?? 'Unregistered'}</span>
              {c.phone && (
                <>
                  {' · '}
                  <strong>Contact</strong> <span style={CODE}>{c.phone}</span>
                </>
              )}
            </div>
            <div>
              <strong>Agent</strong> {inv.broker?.name ?? 'Self'}
              {inv.placeOfSupplyCode && (
                <>
                  {' · '}
                  <strong>Place of supply</strong> {data.placeOfSupplyState ?? ''} ({inv.placeOfSupplyCode})
                  {taxMode === 'IGST' ? ', inter-state' : ''}
                </>
              )}
            </div>
          </div>
          <div style={{ padding: '4px 8px', borderTop: HAIR }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span style={LABEL}>Ship to (consignee)</span>
              {stateText(shipState, shipCode) && (
                <span style={{ fontSize: '9px' }}>
                  <strong>State</strong> {stateText(shipState, shipCode)}
                </span>
              )}
            </div>
            <div style={{ fontSize: '11.5px', fontWeight: 800, textTransform: 'uppercase', lineHeight: 1.2 }}>{shipName}</div>
            <div>{inv.shippingAddress || billing || '—'}</div>
            <div>
              <strong>GSTIN</strong> <span style={CODE}>{shipGstin || 'Unregistered'}</span>
            </div>
          </div>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr) auto minmax(0, 1fr)',
            columnGap: '6px',
            rowGap: '2px',
            alignContent: 'start',
            padding: '5px 8px',
            fontSize: '9.5px',
            lineHeight: 1.35,
          }}
        >
          {facts.map((pair, row) => (
            <Fragment key={row}>
              {pair.map((f, i) =>
                f ? (
                  <Fragment key={f[0]}>
                    <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{f[0]}</span>
                    <span style={{ overflowWrap: 'anywhere', ...(f[2] ? CODE : {}) }}>: {f[1]}</span>
                  </Fragment>
                ) : (
                  <Fragment key={`${row}-${i}`}>
                    <span />
                    <span />
                  </Fragment>
                ),
              )}
            </Fragment>
          ))}
          {/* The transporter's name can be long: a row of its own, the full width, with the vehicle. */}
          {(inv.transporter || inv.vehicleNumber) && (
            <>
              <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Transport</span>
              <span style={{ gridColumn: '2 / span 3' }}>
                : {inv.transporter || '—'}
                {inv.vehicleNumber && (
                  <>
                    {' · '}
                    <strong>Vehicle</strong> <span style={CODE}>{inv.vehicleNumber}</span>
                  </>
                )}
              </span>
            </>
          )}
        </div>
      </div>

      <DocTable dense columns={columns} rows={rows} fontSize={10.5} style={{ marginTop: '4px' }} />

      {/* Totals, tax, terms and signatures stay together, and a page never starts with
          them alone: the last line of goods goes over with them, under its heading. */}
      <div style={{ breakInside: 'avoid', pageBreakInside: 'avoid', breakBefore: 'avoid', pageBreakBefore: 'avoid' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 38%', border: LINE, marginTop: '4px' }}>
          <div style={{ padding: '4px 8px', borderRight: LINE, display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0, ...TEXT }}>
            {showWords && (
              <div>
                <div style={LABEL}>Amount in words</div>
                <div style={{ fontSize: '10.5px', fontWeight: 700 }}>{data.totalInWords}</div>
                <div style={{ fontSize: '9.5px' }}>
                  <strong>Tax:</strong> {data.taxInWords}
                </div>
              </div>
            )}
            {showBank && (
              <div style={{ fontSize: '9.5px' }}>
                <span style={LABEL}>Bank</span> {bank}
                {company.bankAccount && (
                  <>
                    {' · '}A/c <span style={CODE}>{company.bankAccount}</span>
                  </>
                )}
                {company.bankIFSC && (
                  <>
                    {' · '}IFSC <span style={CODE}>{company.bankIFSC}</span>
                  </>
                )}
                {company.upiId && (
                  <>
                    {' · '}UPI <span style={CODE}>{company.upiId}</span>
                  </>
                )}
              </div>
            )}
            {packing.length > 0 && (
              <div style={{ fontSize: '9.5px' }}>
                <span style={LABEL}>Packing</span> {packing.join(' · ')}
              </div>
            )}
            {inv.notes && (
              <div style={{ fontSize: '9.5px' }}>
                <span style={LABEL}>Notes</span> {inv.notes}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {totalRows.map(([label, value], i) => (
              <div
                key={label}
                style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '1.5px 8px', fontSize: '10px', borderTop: i ? HAIR : undefined }}
              >
                <span>{label}</span>
                <span style={{ fontWeight: 600, ...NUM }}>{value}</span>
              </div>
            ))}
            <div
              style={{
                marginTop: 'auto',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: '8px',
                padding: '4px 8px',
                borderTop: HEAVY,
              }}
            >
              <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase' }}>Invoice total</span>
              <span style={{ fontSize: '15px', fontWeight: 800, ...NUM }}>₹ {money(inv.totalAmount)}</span>
            </div>
          </div>
        </div>

        {hsnRows.length > 0 && (
          <div style={{ marginTop: '4px' }}>
            <Eyebrow>HSN-wise tax summary</Eyebrow>
            <DocTable dense columns={hsnColumns} rows={hsnRows} fontSize={9.5} style={{ marginTop: '2px' }} />
          </div>
        )}

        <Terms dense text={termsText} />
        <div style={{ fontSize: '9px', marginTop: '3px' }}>{template.declaration || DECLARATION}</div>

        <Signatures
          dense
          roles={[
            // The same room above each line, enough for a stamp.
            { role: 'Prepared by', who: inv.createdBy?.name ?? null, sub: null, space: 36 },
            { role: 'Checked by', who: null, sub: null, space: 36 },
            { role: "Customer's seal and signature", who: null, sub: null, space: 36 },
            { role: 'Authorised signatory', sub: `For ${company.name} · company stamp`, who: null, image: company.signatureUrl, space: 36 },
          ]}
        />
      </div>
    </DocumentSheet>
  )
}
