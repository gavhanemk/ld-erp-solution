'use client'

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import type { ChargeTaxTreatment } from '@ld-erp/shared'
import { saleChargeRow } from '@/components/print/saleChargeRow'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { lineDetails } from '@/components/sales/OrderLinesView'
import { SecondAddress } from '@/components/print/SecondAddress'
import {
  Banner,
  DocTable,
  DocumentSheet,
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
/** The printed page's margins (mm); the footer with the page number sits in the bottom one. */
const MARGIN = { top: 9, side: 9, bottom: 12 }
const PAGE_MARGIN = `${MARGIN.top}mm ${MARGIN.side}mm ${MARGIN.bottom}mm ${MARGIN.side}mm`

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

  // The item table takes up the page, as on the old invoice: an empty last
  // row, its column rules running on, as tall as the room the invoice leaves
  // on its last page — a short invoice is a full A4 sheet with its totals and
  // signatures at the foot. On a longer one the table also runs to the foot of
  // every page it breaks on, and the page breaks there. Measured on screen,
  // where the sheet is padded exactly as the page is on paper, breaking the
  // rows over pages as the browser does (a row whole, the heading again).
  const wrapRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  const [fill, setFill] = useState(0)
  const [pageFills, setPageFills] = useState<Array<[number, number]>>([])
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!data || !wrap) return
    const measure = () => {
      const table = tableRef.current
      const foot = footRef.current
      if (!table?.tHead || !foot) return
      const top = (el: Element) => el.getBoundingClientRect().top
      const height = (el: Element) => el.getBoundingClientRect().height
      // The page less its margins, less a hair so rounding never spills a page.
      const page = (297 - MARGIN.top - MARGIN.bottom) * (96 / 25.4) - 6
      const head = height(table.tHead)
      const rows = Array.from(table.tBodies[0]?.rows ?? [])
        .filter((r) => !('fill' in r.dataset))
        .map(height)
      const below = wrap.getBoundingClientRect().bottom - top(foot)
      const breaks: Array<[number, number]> = []
      let y = top(table) - top(wrap) + head
      rows.forEach((r, i) => {
        if (i > 0 && y + r > page) {
          breaks.push([i - 1, Math.floor(page - y)])
          y = head
        }
        y += r
      })
      let room = page - y - below
      const last = rows.length - 1
      const lastStartsPage = breaks.some(([after]) => after === last - 1)
      if (room < 0 && last > 0 && !lastStartsPage) {
        // Totals that don't fit under the last line go over, taking it with them.
        breaks.push([last - 1, Math.floor(page - (y - rows[last]))])
        room = page - head - rows[last] - below
      }
      setFill(Math.max(0, Math.floor(room)))
      setPageFills((was) => (JSON.stringify(was) === JSON.stringify(breaks) ? was : breaks))
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(wrap)
    void document.fonts?.ready.then(measure)
    return () => watch.disconnect()
  }, [data])

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
  const fixed = 3.5 + 11 + (showHsn ? 7.5 : 0) + (anyPcs ? 5 : 0) + 10.5 + 8.5 + (anyDisc ? 5 : 0) + 11 + 5 + 11.5
  const columns: DocColumn[] = [
    { key: 'sn', head: 'Sr', width: '3.5%', align: 'center' },
    { key: 'ch', head: 'CH No.', width: '11%' },
    { key: 'item', head: 'Description of goods', width: `${(100 - fixed).toFixed(1)}%` },
    ...(showHsn ? [{ key: 'hsn', head: 'HSN', width: '7.5%', align: 'center' as const }] : []),
    ...(anyPcs ? [{ key: 'pcs', head: 'PCS', width: '5%', align: 'right' as const }] : []),
    { key: 'qty', head: 'Quantity', width: '10.5%', align: 'right' },
    { key: 'rate', head: inv.so?.isJobWork ? 'Job charge' : 'Rate', width: '8.5%', align: 'right' },
    ...(anyDisc ? [{ key: 'disc', head: 'Disc', width: '5%', align: 'right' as const }] : []),
    { key: 'taxable', head: 'Taxable value', width: '11%', align: 'right' },
    { key: 'gst', head: 'GST', width: '5%', align: 'right' },
    { key: 'amount', head: 'Amount (₹)', width: '11.5%', align: 'right' },
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
        ch: <span style={{ fontSize: '9.5px', whiteSpace: 'nowrap', ...NUM }}>{inv.dc?.dcNumber ?? '—'}</span>,
        // Name, code and style on one line where they fit, so a plain line stays one line.
        item: (
          <>
            <div>
              <span style={{ fontWeight: 600 }}>{l.item.name}</span>
              {colour ? ` · ${colour}` : ''}
              <span style={{ fontSize: '10.5px' }}>
                {' · '}
                <span style={{ whiteSpace: 'nowrap', ...CODE }}>{l.item.code}</span>
                {l.soLine?.styleCode && (
                  <>
                    {' · '}
                    <span style={{ whiteSpace: 'nowrap' }}>Style {l.soLine.styleCode}</span>
                  </>
                )}
                {details ? ` · ${details}` : ''}
              </span>
            </div>
            {sizes.length > 0 && (
              <div style={{ fontSize: '10.5px', ...NUM }}>{sizes.map((s) => `${s.size.code} ${qty(s.qty)}`).join(' · ')}</div>
            )}
            {l.description && <div style={{ fontSize: '10.5px' }}>{l.description}</div>}
          </>
        ),
        hsn: <span style={{ fontSize: '10.5px', whiteSpace: 'nowrap', ...NUM }}>{l.hsnCode ?? '—'}</span>,
        pcs: l.pcs != null ? qty(l.pcs) : '—',
        qty: (
          <>
            {isMeasured ? measured(l.qty) : qty(l.qty)}
            {unit && <span style={{ fontSize: '10px' }}> {unit}</span>}
          </>
        ),
        rate: money(l.unitPrice),
        disc: Number(l.discount) > 0 ? `${Number(l.discount)}%` : '—',
        taxable: money(l.taxableValue),
        gst: Number(l.gstRate) > 0 ? `${Number(l.gstRate)}%` : 'Nil',
        amount: <span style={{ fontWeight: 600 }}>{money(l.amount)}</span>,
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

  const discounted = Number(inv.discountAmount) > 0
  const totalRows: Array<[string, string]> = [
    // Before a discount, the value of the goods is the taxable value: one row.
    ...(discounted
      ? ([
          ['Value of goods', money(inv.subtotal)],
          ['Discount', `− ${money(inv.discountAmount)}`],
        ] as Array<[string, string]>)
      : []),
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
    { key: 'hsn', head: 'HSN-wise summary', weight: 23 },
    { key: 'taxable', head: 'Taxable (₹)', weight: 20, align: 'right' },
    { key: 'rate', head: 'Rate', weight: 8, align: 'center' },
    ...(taxMode === 'IGST'
      ? [{ key: 'igst', head: 'IGST (₹)', weight: 19, align: 'right' as const }]
      : [
          { key: 'cgst', head: 'CGST (₹)', weight: 17, align: 'right' as const },
          { key: 'sgst', head: 'SGST (₹)', weight: 17, align: 'right' as const },
        ]),
    { key: 'tax', head: 'Tax (₹)', weight: 18, align: 'right' },
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
      [inv.eWayBillNumber && ['E-way bill', inv.eWayBillNumber, true], inv.eWayBillDate && ['E-way date', shortDate(inv.eWayBillDate), true]],
      [inv.dueDate && ['Due date', shortDate(inv.dueDate), true], ['Reverse charge', 'No', false]],
      [data.brand?.name && ['Brand', data.brand.name, false], null],
    ] as Array<[Fact, Fact]>
  ).filter(([a, b]) => a || b)

  const terms = (termsText ?? '')
    .split(/\r?\n/)
    .map((t) => t.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean)
  // About 46 characters to a printed line in a column: split where the taller
  // column is shortest, so one long term doesn't leave the other side empty.
  const tall = terms.map((t) => Math.max(1, Math.ceil(t.length / 46)))
  let split = terms.length
  for (let i = 1, left = 0, best = Infinity; i < terms.length; i++) {
    left += tall[i - 1]
    const taller = Math.max(left, tall.reduce((n, h) => n + h, 0) - left)
    if (taller < best) {
      best = taller
      split = i
    }
  }
  const termColumns = [terms.slice(0, split), terms.slice(split)].filter((col) => col.length)
  const factoryAddress = [company.address, company.city, company.state, company.pincode].filter(Boolean).join(', ')
  const contact = [company.phone && `Ph: ${company.phone}`, company.email && `Email: ${company.email}`].filter(Boolean).join(' · ')

  // One frame, as the old invoice: the mill | the invoice; bill to | ship to;
  // the item table taking up the page; bank and packing | the totals; the
  // amount in words | the HSN summary; terms | the mill's stamp and signature.
  // Type at 9 pt for what is read; labels and the small print a little smaller.
  const LABEL: React.CSSProperties = { fontSize: '9px', fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' }
  const CELL: React.CSSProperties = { padding: '6px 9px', minWidth: 0 }
  const SIDES: React.CSSProperties = { borderLeft: LINE, borderRight: LINE }
  const party = (
    label: string,
    state: string | null,
    name: string,
    address: string,
    lines: React.ReactNode,
    divider: boolean,
  ) => (
    <div style={{ ...CELL, padding: '5px 9px', ...(divider ? { borderRight: LINE } : {}), fontSize: '11.5px', lineHeight: 1.35 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
        <span style={LABEL}>{label}</span>
        {state && (
          <span style={{ fontSize: '10.5px' }}>
            State <span style={{ fontWeight: 600 }}>{state}</span>
          </span>
        )}
      </div>
      <div style={{ fontSize: '13px', fontWeight: 700, textTransform: 'uppercase', lineHeight: 1.3, marginTop: '1px' }}>{name}</div>
      <div>{address || '—'}</div>
      {lines}
    </div>
  )
  const signLine = (role: string, who?: string | null) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ height: '20px', display: 'flex', alignItems: 'flex-end', fontSize: '10.5px', fontWeight: 600 }}>{who ?? ''}</div>
      <div style={{ borderTop: HAIR, paddingTop: '2px', fontSize: '10.5px', fontWeight: 700 }}>{role}</div>
    </div>
  )

  return (
    <DocumentSheet
      company={company}
      title={template.title}
      number={inv.invoiceNumber}
      date={longDate(inv.invoiceDate) ?? ''}
      backHref="/sales/invoices?tab=invoices"
      backLabel="Invoices"
      bare
      pageMargin={PAGE_MARGIN}
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
    >
      <div ref={wrapRef}>
        {banner && <Banner>{banner}</Banner>}

        {/* The mill on the left; the invoice — its title, copy and details — on the right. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 52fr) minmax(0, 48fr)', border: LINE }}>
          <div style={{ ...CELL, borderRight: LINE, fontSize: '10.5px', lineHeight: 1.45 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {company.logoUrl && (
                // The one thing on the sheet in colour.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={company.logoUrl} alt="" style={{ height: '42px', width: 'auto', maxWidth: '96px', objectFit: 'contain', flexShrink: 0 }} />
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '20px', fontWeight: 800, textTransform: 'uppercase', lineHeight: 1.15 }}>{company.name}</div>
                {company.manufacturerOf && (
                  <div style={{ fontSize: '11px' }}>
                    Manufacturer of <span style={{ fontWeight: 700 }}>{company.manufacturerOf}</span>
                  </div>
                )}
              </div>
            </div>
            <div style={{ marginTop: '4px' }}>
              {factoryAddress && <div>{factoryAddress}</div>}
              {company.address2 && (
                <div>
                  <SecondAddress text={company.address2} />
                </div>
              )}
              {contact && <div>{contact}</div>}
              <div>
                GSTIN <span style={{ fontWeight: 700, ...CODE }}>{company.gstin || '—'}</span>
                {company.pan && (
                  <>
                    {' · '}PAN <span style={{ fontWeight: 700, ...CODE }}>{company.pan}</span>
                  </>
                )}
                {company.stateCode ? (
                  <> · State code {company.stateCode}</>
                ) : (
                  company.state && <> · State {company.state}</>
                )}
              </div>
            </div>
          </div>
          <div style={CELL}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '8px',
                paddingBottom: '5px',
                marginBottom: '5px',
                borderBottom: HAIR,
              }}
            >
              <span style={{ fontSize: '17px', fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase' }}>{template.title}</span>
              <span style={{ border: LINE, padding: '2px 6px', whiteSpace: 'nowrap', ...LABEL, fontSize: '8.5px' }}>{copy}</span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto minmax(0, 1fr) auto auto',
                columnGap: '7px',
                rowGap: 0,
                fontSize: '11px',
                lineHeight: 1.4,
              }}
            >
              {facts.map((pair, row) => (
                <Fragment key={row}>
                  {pair.map((f, i) =>
                    f ? (
                      <Fragment key={f[0]}>
                        <span style={{ whiteSpace: 'nowrap', fontSize: '10.5px' }}>{f[0]}</span>
                        <span style={{ fontWeight: 600, ...(f[2] ? { whiteSpace: 'nowrap', ...CODE } : { overflowWrap: 'break-word' }) }}>
                          : {f[1]}
                        </span>
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
            </div>
          </div>
        </div>

        {/* Bill to and the consignee, side by side and kept apart. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', ...SIDES }}>
          {party(
            'Bill to',
            stateText(c.billingState, c.billingStateCode),
            c.name,
            billing,
            <>
              <div>
                GSTIN <span style={{ fontWeight: 700, ...CODE }}>{c.gstin ?? 'Unregistered'}</span>
                {c.phone && (
                  <>
                    {' · '}Contact <span style={CODE}>{c.phone}</span>
                  </>
                )}
              </div>
              <div>
                Agent <span style={{ fontWeight: 600 }}>{inv.broker?.name ?? 'Self'}</span>
                {inv.placeOfSupplyCode && (
                  <>
                    {' · '}Place of supply{' '}
                    <span style={{ fontWeight: 600 }}>
                      {data.placeOfSupplyState ?? ''} ({inv.placeOfSupplyCode})
                    </span>
                    {taxMode === 'IGST' ? ', inter-state' : ''}
                  </>
                )}
              </div>
            </>,
            true,
          )}
          {party(
            'Ship to (consignee)',
            stateText(shipState, shipCode),
            shipName,
            inv.shippingAddress || billing,
            <>
              <div>
                GSTIN <span style={{ fontWeight: 700, ...CODE }}>{shipGstin || 'Unregistered'}</span>
              </div>
              {(inv.transporter || inv.vehicleNumber) && (
                <div>
                  Transport <span style={{ fontWeight: 600 }}>{inv.transporter || '—'}</span>
                  {inv.vehicleNumber && (
                    <>
                      {' · '}Vehicle <span style={{ fontWeight: 600, ...CODE }}>{inv.vehicleNumber}</span>
                    </>
                  )}
                </div>
              )}
            </>,
            false,
          )}
        </div>

        {/* The item table, taking up the page. */}
        <DocTable
          dense
          fill={fill}
          pageFills={pageFills}
          tableRef={tableRef}
          columns={columns}
          rows={rows}
          fontSize={11.5}
          style={{ marginTop: 0 }}
        />

        {/* Totals, words, tax, terms and signatures stay together, and a page never
            starts with them alone: the last line of goods goes over with them. */}
        <div ref={footRef} style={{ breakInside: 'avoid', pageBreakInside: 'avoid', breakBefore: 'avoid', pageBreakBefore: 'avoid' }}>
          {/* Bank and packing | the totals. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 55fr) minmax(0, 45fr)', ...SIDES, borderBottom: LINE }}>
            <div style={{ ...CELL, borderRight: LINE, display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '11px', lineHeight: 1.4 }}>
              {showBank && (
                <div>
                  <div style={LABEL}>Bank details</div>
                  <div>
                    {bank && (
                      <>
                        Bank <span style={{ fontWeight: 600 }}>{bank}</span>
                      </>
                    )}
                    {company.bankAccount && (
                      <>
                        {bank ? ' · ' : ''}A/c No. <span style={{ fontWeight: 600, ...CODE }}>{company.bankAccount}</span>
                      </>
                    )}
                  </div>
                  {(company.bankIFSC || company.upiId) && (
                    <div>
                      {company.bankIFSC && (
                        <>
                          IFSC <span style={{ fontWeight: 600, ...CODE }}>{company.bankIFSC}</span>
                        </>
                      )}
                      {company.upiId && (
                        <>
                          {company.bankIFSC ? ' · ' : ''}UPI <span style={{ fontWeight: 600, ...CODE }}>{company.upiId}</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
              {packing.length > 0 && (
                <div>
                  <div style={LABEL}>Packing</div>
                  <div style={NUM}>{packing.join(' · ')}</div>
                </div>
              )}
              {inv.notes && (
                <div>
                  <div style={LABEL}>Notes</div>
                  <div>{inv.notes}</div>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {totalRows.map(([label, value]) => (
                <div
                  key={label}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '2px 9px', fontSize: '11.5px', borderBottom: HAIR }}
                >
                  <span>{label}</span>
                  <span style={{ fontWeight: 600, whiteSpace: 'nowrap', ...NUM }}>{value}</span>
                </div>
              ))}
              <div
                style={{
                  marginTop: 'auto',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '5px 9px',
                  borderTop: HEAVY,
                }}
              >
                <span style={{ fontSize: '11.5px', fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase' }}>Net amount</span>
                <span style={{ fontSize: '19px', fontWeight: 800, ...NUM }}>₹ {money(inv.totalAmount)}</span>
              </div>
            </div>
          </div>

          {/* The amount in words | the HSN-wise tax summary. */}
          {(
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: hsnRows.length ? 'minmax(0, 37fr) minmax(0, 63fr)' : '1fr',
                ...SIDES,
                borderBottom: LINE,
              }}
            >
              <div style={{ ...CELL, fontSize: '11px', lineHeight: 1.45 }}>
                {showWords && (
                  <>
                    <div style={LABEL}>Amount in words</div>
                    <div style={{ fontSize: '11.5px', fontWeight: 700 }}>{data.totalInWords}</div>
                    <div style={{ marginTop: '2px' }}>
                      <span style={{ fontWeight: 600 }}>Tax:</span> {data.taxInWords}
                    </div>
                  </>
                )}
              </div>
              {hsnRows.length > 0 && (
                <div style={{ borderLeft: LINE, minWidth: 0 }}>
                  <DocTable dense columns={hsnColumns} rows={hsnRows} fontSize={10} style={{ marginTop: 0, border: 'none' }} />
                </div>
              )}
            </div>
          )}

          {/* Terms on the left; the mill's stamp and signature on the right. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 69fr) minmax(0, 31fr)', ...SIDES, borderBottom: LINE }}>
            <div style={{ ...CELL, borderRight: LINE, display: 'flex', flexDirection: 'column' }}>
              {terms.length > 0 && (
                <>
                  <div style={LABEL}>Terms &amp; conditions</div>
                  <div style={{ display: 'flex', gap: '14px', marginTop: '2px' }}>
                    {termColumns.map((col, c) => (
                      <ol key={c} style={{ flex: 1, minWidth: 0, margin: 0, padding: 0, listStyle: 'none' }}>
                        {col.map((t, i) => (
                          <li key={i} style={{ display: 'flex', gap: '5px', fontSize: '10px', lineHeight: 1.35 }}>
                            <span style={{ width: '13px', flexShrink: 0, textAlign: 'right', fontWeight: 700, ...NUM }}>
                              {(c ? split : 0) + i + 1}.
                            </span>
                            <span style={{ minWidth: 0 }}>{t}</span>
                          </li>
                        ))}
                      </ol>
                    ))}
                  </div>
                </>
              )}
              <div style={{ display: 'flex', gap: '18px', marginTop: 'auto', paddingTop: '4px' }}>
                {signLine('Prepared by', inv.createdBy?.name)}
                {signLine('Checked by')}
                {signLine("Receiver's signature")}
              </div>
            </div>
            <div style={{ ...CELL, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', textAlign: 'right' }}>
              <div style={{ fontSize: '9.5px', lineHeight: 1.4, textAlign: 'left', alignSelf: 'stretch' }}>
                <span style={{ fontWeight: 700 }}>Declaration: </span>
                {template.declaration || DECLARATION}
              </div>
              <div style={{ fontSize: '11.5px', fontWeight: 700, marginTop: '5px' }}>For {company.name}</div>
              {/* Room for the company stamp and the signature. */}
              <div style={{ flex: 1, minHeight: '56px', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', paddingBottom: '4px' }}>
                {company.signatureUrl && (
                  // A data URL, so next/image would add nothing.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={company.signatureUrl} alt="" style={{ height: '34px', width: 'auto', objectFit: 'contain', filter: 'grayscale(1)' }} />
                )}
              </div>
              <div style={{ alignSelf: 'stretch', borderTop: HAIR, paddingTop: '2px', fontSize: '10.5px', fontWeight: 700 }}>Authorised signatory</div>
            </div>
          </div>

          {(template.footerNote ?? 'This is a computer-generated invoice.') && (
            <div style={{ fontSize: '9.5px', textAlign: 'center', marginTop: '3px' }}>
              {template.footerNote ?? 'This is a computer-generated invoice.'}
            </div>
          )}
        </div>
      </div>
    </DocumentSheet>
  )
}
