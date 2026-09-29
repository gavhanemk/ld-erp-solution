'use client'

import { Fragment, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'

/**
 * The printed purchase bill.
 *
 * Rebuilt on 21 Sep 2026 to the layout Mahesh supplied: a masthead with the
 * BILL block boxed off to its right, Bill From and Bill To side by side, the
 * items under a filled navy head, the words and the totals shoulder to
 * shoulder, then the HSN-wise tax summary across the foot.
 *
 * It draws its own sheet rather than going through `PrintSheet`, the way the
 * purchase order sheet does, and borrows only the toolbar. The two documents
 * now share a look because they share these constants, not because they share
 * a component — which is the arrangement that survived the last rebuild.
 *
 * **One thing deliberately not copied from the mock.** The mock puts LD Cotton
 * Mills under "Bill From" and the supplier under "Bill To". On a purchase bill
 * that is the wrong way round: this is the supplier's demand for money, so it
 * comes *from* them and is addressed *to* us. Printed the other way it would
 * read as a bill we had issued, which is a different document with a different
 * tax position. The mill's own old sheet has it right — its Bill From block
 * holds SABLE TRADING — so the layout here is the mock's and the parties are
 * the old sheet's.
 */

/* ── The palette, shared with the purchase order sheet ─────────────────────
 *
 * Every filled band on the paper is NAVY or TINT; there is no third colour.
 * `#173a6c` is a truer blue than the "navy" in tailwind.config.js, which is
 * really slate — printed paper is not a screen. See the purchase order sheet
 * for the full note.
 */
const NAVY = '#173a6c'
const TINT = '#e9eff8'
const TINT_SOFT = '#f4f7fc'
const INK = '#1f2b3d'
const GREY = '#44536b'
const RULE = '#b9c4d4'

/*
 * `next/font` publishes Inter under a generated family name and hands it over
 * as the custom property `--font-inter`. A stack asking for the literal
 * "Inter" matches nothing and quietly falls back to whatever the system has —
 * which is how this sheet spent a fortnight setting in Times.
 */
const SANS = 'var(--font-inter), Inter, system-ui, sans-serif'

/** Figures line up in a column only if the digits are the same width. */
const NUM: React.CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  fontFeatureSettings: '"tnum" 1',
}

const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const qtyFmt = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })

interface BillLine {
  id: string
  description: string | null
  hsnCode: string | null
  qty: string
  unitPrice: string
  discount: string
  gstRate: string
  taxableValue: string
  cgst: string
  sgst: string
  igst: string
  amount: string
  item: { code: string; name: string; uom?: { symbol: string } | null }
  grnLine?: { grn: { grnNumber: string } } | null
}

interface PrintData {
  company: Record<string, string | null>
  template: {
    title: string
    termsText: string | null
    declaration: string | null
    footerNote: string | null
    showHsn: boolean
    showAmountInWords: boolean
    showSignature: boolean
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
    lines: BillLine[]
    charges: Array<{ id: string; amount: string; gstRate: string; chargeType: { name: string } }>
  }
  totalInWords: string
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
}

/** An address written down the page, skipping whatever is not on file. */
function addressLines(p: Record<string, string | null>): string[] {
  const cityLine = [p.city, p.state].filter(Boolean).join(', ')
  const pinLine = [cityLine, p.pincode].filter(Boolean).join(' - ')
  return [p.address, pinLine, p.country || 'INDIA'].filter((l): l is string => Boolean(l && l.trim()))
}

/** A heading strip over a block — the pale navy band in the mock. */
function BlockHead({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: TINT,
        borderBottom: `1px solid ${RULE}`,
        padding: '7px 11px',
        fontSize: '11px',
        fontWeight: 700,
        color: NAVY,
      }}
    >
      {children}
    </div>
  )
}

export default function PurchaseBillPrintPage() {
  const params = useParams<{ id: string }>()
  const [data, setData] = useState<PrintData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: PrintData }>(`/purchase/bills/${params.id}/print`)
      .then((r) => setData(r.data))
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : 'Could not load this bill.')
      )
  }, [params.id])

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
  const companyName = company.legalName || company.name || ''

  const receipts = [
    ...new Set(bill.lines.map((l) => l.grnLine?.grn.grnNumber).filter(Boolean)),
  ] as string[]

  /*
   * The HSN-wise summary, grouped by code and rate together.
   *
   * One code can legitimately carry two rates on one bill, and merging them
   * would print a rate that applies to neither half. Amounts are summed from
   * the lines rather than recalculated, so this block and the totals above it
   * cannot disagree.
   */
  const hsnRows = (() => {
    if (taxMode === 'NONE') return []
    const groups = new Map<
      string,
      { hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number }
    >()
    for (const l of bill.lines) {
      const hsn = l.hsnCode || '—'
      const rate = Number(l.gstRate)
      const key = `${hsn}|${rate}`
      const g = groups.get(key) ?? { hsn, rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 }
      g.taxable += Number(l.taxableValue)
      g.cgst += Number(l.cgst)
      g.sgst += Number(l.sgst)
      g.igst += Number(l.igst)
      groups.set(key, g)
    }
    return [...groups.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
  })()

  const hsnTotal = hsnRows.reduce(
    (t, g) => ({
      taxable: t.taxable + g.taxable,
      cgst: t.cgst + g.cgst,
      sgst: t.sgst + g.sgst,
      igst: t.igst + g.igst,
    }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0 }
  )

  const otherCharges = bill.charges.reduce((s, c) => s + Number(c.amount), 0)

  /* The right-hand stack, in the mock's order. */
  const totals: Array<{ label: string; value: string }> = [
    { label: 'Total Discount', value: money(bill.discountAmount) },
    { label: 'Sub Total', value: money(bill.subtotal) },
    ...(taxMode === 'CGST_SGST'
      ? [
          { label: 'SGST', value: money(bill.sgst) },
          { label: 'CGST', value: money(bill.cgst) },
        ]
      : []),
    ...(taxMode === 'IGST' ? [{ label: 'IGST', value: money(bill.igst) }] : []),
    ...(otherCharges > 0 ? [{ label: 'Other Charges', value: money(otherCharges) }] : []),
    ...(Number(bill.roundOff) !== 0 ? [{ label: 'Round Off', value: money(bill.roundOff) }] : []),
  ]

  /* The meta block beside BILL. Labels exactly as the mill writes them. */
  const meta: Array<{ label: string; value: string }> = [
    { label: 'Bill No.', value: bill.supplierInvoiceNo || bill.billNumber },
    {
      label: 'Bill Date',
      value: shortDate(bill.supplierInvoiceDate || bill.billDate),
    },
    { label: 'Due Date', value: bill.dueDate ? shortDate(bill.dueDate) : '—' },
    ...(receipts.length ? [{ label: 'Receipt No.', value: receipts.join(', ') }] : []),
    ...(bill.po ? [{ label: 'Order No.', value: bill.po.poNumber }] : []),
    { label: 'Our Reference', value: bill.billNumber },
  ]

  const th: React.CSSProperties = {
    background: NAVY,
    color: '#fff',
    fontSize: '10.5px',
    fontWeight: 700,
    padding: '10px 9px',
    border: `1px solid ${NAVY}`,
    textAlign: 'left',
  }

  const td: React.CSSProperties = {
    fontSize: '11px',
    padding: '10px 9px',
    border: `1px solid ${RULE}`,
    color: INK,
    verticalAlign: 'top',
  }

  const sumTh: React.CSSProperties = {
    background: TINT,
    color: NAVY,
    fontSize: '10px',
    fontWeight: 700,
    padding: '8px 7px',
    border: `1px solid ${RULE}`,
    textAlign: 'center',
  }

  const sumTd: React.CSSProperties = {
    fontSize: '10.5px',
    padding: '8px 7px',
    border: `1px solid ${RULE}`,
    color: INK,
    textAlign: 'center',
  }

  /*
   * Blank rows under a short bill.
   *
   * A one-line bill on A4 otherwise leaves the grid floating with a hand's
   * width of nothing under it before the totals. Every printed invoice book
   * rules its rows to the foot of the page for the same reason — the ruled
   * space is what says "nothing was added after this was signed".
   */
  const usedRows = bill.lines.length + bill.charges.length
  /*
   * Five, measured rather than chosen.
   *
   * Eight looked better on screen and took a one-line bill onto a second
   * sheet — the type on this rebuild is larger than it was, and the ruled
   * space has to fit in what the larger type left over. Verified by PDF page
   * count at 1, 2 and 5 lines; it is the only test that counts.
   */
  const fillerRows = Math.max(0, 5 - usedRows)

  const taxCols = taxMode === 'IGST' ? ['IGST'] : taxMode === 'NONE' ? [] : ['SGST', 'CGST']

  return (
    <>
      <style>{SHEET_CSS}</style>
      <PrintToolbar
        backHref="/purchase/bills"
        backLabel="Back to bills"
        copies={1}
        fileName={bill.billNumber}
      />

      <div
        className="sheet"
        style={{
          width: '210mm',
          minHeight: '297mm',
          margin: '0 auto',
          background: '#fff',
          color: INK,
          fontFamily: SANS,
          padding: '14mm 12mm',
          boxSizing: 'border-box',
        }}
      >
        {/* ── Masthead: the mill on the left, the BILL block boxed right ── */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'stretch' }}>
          <div style={{ flex: 1, minWidth: 0, paddingBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '13px' }}>
              {company.logoUrl && (
                // The mill's mark, at a size somebody can actually see. It was
                // 34px, which on A4 is a thumbnail — the letterhead of a
                // company that is not sure it wants to be on the paper.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={company.logoUrl}
                  alt=""
                  style={{ height: '58px', width: 'auto', objectFit: 'contain', flexShrink: 0 }}
                />
              )}
              <div
                style={{
                  fontSize: '22px',
                  fontWeight: 800,
                  color: NAVY,
                  letterSpacing: '0.2px',
                  textTransform: 'uppercase',
                  lineHeight: 1.08,
                }}
              >
                {companyName}
              </div>
            </div>

            <div style={{ marginTop: '9px', fontSize: '10.5px', color: GREY, lineHeight: 1.65 }}>
              {addressLines(company).map((l) => (
                <div key={l} style={{ textTransform: 'uppercase' }}>
                  {l}
                </div>
              ))}
            </div>

            <div
              style={{
                marginTop: '8px',
                fontSize: '10.5px',
                color: GREY,
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '4px 12px',
              }}
            >
              {company.phone && <span>{company.phone}</span>}
              {company.phone && company.email && <span style={{ color: RULE }}>|</span>}
              {company.email && <span>{company.email}</span>}
            </div>
            {company.gstin && (
              <div style={{ marginTop: '5px', fontSize: '11px', fontWeight: 700, color: NAVY }}>
                GSTIN: {company.gstin}
              </div>
            )}
          </div>

          <div
            style={{
              width: '73mm',
              flexShrink: 0,
              background: TINT_SOFT,
              border: `1px solid ${RULE}`,
              padding: '13px 15px',
            }}
          >
            <div
              style={{
                fontSize: '27px',
                fontWeight: 800,
                color: NAVY,
                lineHeight: 1,
                marginBottom: '11px',
                textTransform: 'uppercase',
              }}
            >
              {template.title || 'BILL'}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {meta.map((m) => (
                  <tr key={m.label}>
                    <td
                      style={{
                        fontSize: '10.5px',
                        color: GREY,
                        padding: '3px 0',
                        whiteSpace: 'nowrap',
                        verticalAlign: 'top',
                      }}
                    >
                      {m.label}
                    </td>
                    <td
                      style={{
                        fontSize: '10.5px',
                        color: GREY,
                        padding: '3px 6px',
                        verticalAlign: 'top',
                      }}
                    >
                      :
                    </td>
                    <td
                      style={{
                        fontSize: '10.5px',
                        fontWeight: 700,
                        color: INK,
                        padding: '3px 0',
                        wordBreak: 'break-word',
                        ...NUM,
                      }}
                    >
                      {m.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ height: '1.5px', background: NAVY, margin: '4px 0 10px' }} />

        {/* ── Bill From / Bill To ──────────────────────────────────────────
            The supplier issues this bill, so it comes from them and is
            addressed to us. The mock had these the other way round; printed
            that way it reads as a bill we issued, which it is not. */}
        <div style={{ display: 'flex', gap: '8px' }}>
          {[
            { head: 'Bill From', party: bill.supplier, name: bill.supplier.name },
            { head: 'Bill To', party: company, name: companyName },
          ].map((box) => (
            <div
              key={box.head}
              style={{ flex: 1, minWidth: 0, border: `1px solid ${RULE}`, background: '#fff' }}
            >
              <BlockHead>{box.head}</BlockHead>
              <div style={{ padding: '11px 12px', fontSize: '10.5px', lineHeight: 1.65 }}>
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 800,
                    color: NAVY,
                    textTransform: 'uppercase',
                    marginBottom: '4px',
                  }}
                >
                  {box.name}
                </div>
                {addressLines(box.party).map((l) => (
                  <div key={l} style={{ color: GREY, textTransform: 'uppercase' }}>
                    {l}
                  </div>
                ))}
                {box.party.gstin && (
                  <div style={{ marginTop: '5px', color: INK, fontWeight: 700 }}>
                    GSTIN: {box.party.gstin}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* ── Items ───────────────────────────────────────────────────────── */}
        <table
          style={{ width: '100%', borderCollapse: 'collapse', marginTop: '10px', tableLayout: 'fixed' }}
        >
          <colgroup>
            <col style={{ width: '5%' }} />
            <col style={{ width: '31%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '13%' }} />
          </colgroup>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'center' }}>#</th>
              <th style={th}>Item &amp; Description</th>
              <th style={{ ...th, textAlign: 'center' }}>HSN/SAC</th>
              <th style={{ ...th, textAlign: 'center' }}>Qty (Unit)</th>
              <th style={{ ...th, textAlign: 'right' }}>Rate (₹)</th>
              <th style={{ ...th, textAlign: 'right' }}>Discount (₹)</th>
              <th style={{ ...th, textAlign: 'right' }}>Amount (₹)</th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l, i) => (
              <tr key={l.id}>
                <td style={{ ...td, textAlign: 'center', ...NUM }}>{i + 1}</td>
                <td style={td}>
                  <div style={{ fontWeight: 700, color: NAVY }}>{l.item.name}</div>
                  <div style={{ fontSize: '9px', color: GREY }}>
                    {l.item.code}
                    {l.description ? ` — ${l.description}` : ''}
                    {l.grnLine ? ` · ${l.grnLine.grn.grnNumber}` : ''}
                  </div>
                </td>
                <td style={{ ...td, textAlign: 'center', ...NUM }}>{l.hsnCode || '—'}</td>
                <td style={{ ...td, textAlign: 'center', ...NUM }}>
                  {qtyFmt(l.qty)}
                  {l.item.uom?.symbol ? ` (${l.item.uom.symbol})` : ''}
                </td>
                <td style={{ ...td, textAlign: 'right', ...NUM }}>{money(l.unitPrice)}</td>
                <td style={{ ...td, textAlign: 'right', ...NUM }}>{money(l.discount)}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700, ...NUM }}>
                  {money(l.amount)}
                </td>
              </tr>
            ))}

            {/* Freight and the like sit in the same grid, so a clerk checking
              the bill with a calculator adds straight down one column. */}
            {bill.charges.map((c, i) => (
              <tr key={c.id}>
                <td style={{ ...td, textAlign: 'center', ...NUM }}>{bill.lines.length + i + 1}</td>
                <td style={td}>
                  <div style={{ fontWeight: 700, color: NAVY }}>{c.chargeType.name}</div>
                </td>
                <td style={{ ...td, textAlign: 'center' }}>—</td>
                <td style={{ ...td, textAlign: 'center' }} />
                <td style={{ ...td, textAlign: 'right' }} />
                <td style={{ ...td, textAlign: 'right' }} />
                <td style={{ ...td, textAlign: 'right', fontWeight: 700, ...NUM }}>
                  {money(c.amount)}
                </td>
              </tr>
            ))}

            {Array.from({ length: fillerRows }, (_, i) => (
              <tr key={`filler-${i}`}>
                <td style={{ ...td, height: '22px' }} />
                <td style={td} />
                <td style={td} />
                <td style={td} />
                <td style={td} />
                <td style={td} />
                <td style={td} />
              </tr>
            ))}
          </tbody>
        </table>

        {/* ── Words and notes on the left, the money on the right ────────── */}
        <div style={{ display: 'flex', gap: '8px', marginTop: '10px', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {template.showAmountInWords && (
              <div style={{ border: `1px solid ${RULE}`, background: TINT_SOFT }}>
                <div style={{ padding: '7px 9px' }}>
                  <div style={{ fontSize: '10.5px', fontWeight: 700, color: NAVY }}>
                    Amount In Words
                  </div>
                  <div style={{ fontSize: '12px', fontWeight: 700, marginTop: '3px' }}>
                    {data.totalInWords}
                  </div>
                </div>
              </div>
            )}

            <div style={{ border: `1px solid ${RULE}`, marginTop: '8px' }}>
              <div style={{ padding: '7px 9px' }}>
                <div style={{ fontSize: '10.5px', fontWeight: 700, color: NAVY }}>Notes</div>
                <div
                  style={{
                    fontSize: '9.5px',
                    color: GREY,
                    marginTop: '2px',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {bill.notes || '—'}
                </div>
              </div>
            </div>

            <div style={{ border: `1px solid ${RULE}`, marginTop: '8px' }}>
              <div style={{ padding: '7px 9px' }}>
                <div style={{ fontSize: '10.5px', fontWeight: 700, color: NAVY }}>
                  Terms &amp; Conditions
                </div>
                <div
                  style={{
                    fontSize: '9.5px',
                    color: GREY,
                    marginTop: '2px',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {template.termsText || '—'}
                </div>
              </div>
            </div>
          </div>

          <div style={{ width: '78mm', flexShrink: 0 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {totals.map((t, i) => (
                  <tr key={t.label} style={{ background: i % 2 ? TINT_SOFT : '#fff' }}>
                    <td
                      style={{
                        fontSize: '11px',
                        color: GREY,
                        padding: '8px 11px',
                        border: `1px solid ${RULE}`,
                      }}
                    >
                      {t.label}
                    </td>
                    <td
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        textAlign: 'right',
                        padding: '8px 11px',
                        border: `1px solid ${RULE}`,
                        ...NUM,
                      }}
                    >
                      {t.value}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td
                    style={{
                      background: NAVY,
                      color: '#fff',
                      fontSize: '13.5px',
                      fontWeight: 800,
                      padding: '11px',
                      border: `1px solid ${NAVY}`,
                    }}
                  >
                    Total
                  </td>
                  <td
                    style={{
                      background: NAVY,
                      color: '#fff',
                      fontSize: '15px',
                      fontWeight: 800,
                      textAlign: 'right',
                      padding: '11px',
                      border: `1px solid ${NAVY}`,
                      ...NUM,
                    }}
                  >
                    ₹ {money(bill.totalAmount)}
                  </td>
                </tr>

                {/* TDS is withheld from the supplier rather than paid to them,
                  so the bill is settled in full by the smaller payment. It sits
                  below the total because it is not part of it. */}
                {Number(bill.tdsAmount) > 0 && (
                  <>
                    <tr>
                      <td
                        style={{
                          fontSize: '11px',
                          color: GREY,
                          padding: '8px 11px',
                          border: `1px solid ${RULE}`,
                        }}
                      >
                        Less TDS{bill.tdsSection ? ` ${bill.tdsSection}` : ''}
                      </td>
                      <td
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          textAlign: 'right',
                          padding: '8px 11px',
                          border: `1px solid ${RULE}`,
                          ...NUM,
                        }}
                      >
                        {money(bill.tdsAmount)}
                      </td>
                    </tr>
                    <tr style={{ background: TINT }}>
                      <td
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          color: NAVY,
                          padding: '8px 11px',
                          border: `1px solid ${RULE}`,
                        }}
                      >
                        Payable
                      </td>
                      <td
                        style={{
                          fontSize: '11px',
                          fontWeight: 800,
                          color: NAVY,
                          textAlign: 'right',
                          padding: '8px 11px',
                          border: `1px solid ${RULE}`,
                          ...NUM,
                        }}
                      >
                        ₹ {money(bill.balanceAmount)}
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── HSN-wise tax summary ────────────────────────────────────────── */}
        {hsnRows.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '12px' }}>
            <thead>
              <tr>
                <th style={{ ...sumTh, width: '18%' }} rowSpan={2}>
                  HSN/SAC
                </th>
                <th style={{ ...sumTh, width: '18%' }} rowSpan={2}>
                  Taxable Value (₹)
                </th>
                {taxCols.map((c) => (
                  <th key={c} style={sumTh} colSpan={2}>
                    {c}
                  </th>
                ))}
              </tr>
              <tr>
                {taxCols.map((c) => (
                  <Fragment key={c}>
                    <th style={{ ...sumTh, width: '8%' }}>%</th>
                    <th style={sumTh}>Amount (₹)</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {hsnRows.map((g) => (
                <tr key={`${g.hsn}-${g.rate}`}>
                  <td style={{ ...sumTd, ...NUM }}>{g.hsn}</td>
                  <td style={{ ...sumTd, textAlign: 'right', ...NUM }}>{money(g.taxable)}</td>
                  {taxMode === 'IGST' ? (
                    <>
                      <td style={{ ...sumTd, ...NUM }}>{g.rate}</td>
                      <td style={{ ...sumTd, textAlign: 'right', ...NUM }}>{money(g.igst)}</td>
                    </>
                  ) : (
                    <>
                      <td style={{ ...sumTd, ...NUM }}>{g.rate / 2}</td>
                      <td style={{ ...sumTd, textAlign: 'right', ...NUM }}>{money(g.sgst)}</td>
                      <td style={{ ...sumTd, ...NUM }}>{g.rate / 2}</td>
                      <td style={{ ...sumTd, textAlign: 'right', ...NUM }}>{money(g.cgst)}</td>
                    </>
                  )}
                </tr>
              ))}
              <tr style={{ background: TINT_SOFT }}>
                <td style={{ ...sumTd, fontWeight: 800, color: NAVY }}>Total</td>
                <td style={{ ...sumTd, textAlign: 'right', fontWeight: 800, ...NUM }}>
                  {money(hsnTotal.taxable)}
                </td>
                {taxMode === 'IGST' ? (
                  <>
                    <td style={sumTd} />
                    <td style={{ ...sumTd, textAlign: 'right', fontWeight: 800, ...NUM }}>
                      {money(hsnTotal.igst)}
                    </td>
                  </>
                ) : (
                  <>
                    <td style={sumTd} />
                    <td style={{ ...sumTd, textAlign: 'right', fontWeight: 800, ...NUM }}>
                      {money(hsnTotal.sgst)}
                    </td>
                    <td style={sumTd} />
                    <td style={{ ...sumTd, textAlign: 'right', fontWeight: 800, ...NUM }}>
                      {money(hsnTotal.cgst)}
                    </td>
                  </>
                )}
              </tr>
            </tbody>
          </table>
        )}

        {/* A bill where the tax is ours to pay, or where there is none at all,
          has to say so on the paper — a reader cannot infer it from a blank. */}
        {(bill.isReverseCharge || taxMode === 'NONE') && (
          <div style={{ marginTop: '8px', fontSize: '10.5px', fontWeight: 700, color: NAVY }}>
            {bill.isReverseCharge
              ? 'Reverse charge — GST on this bill is payable by the recipient, not by the supplier.'
              : 'Supplier is not registered under GST. No tax charged on this bill.'}
          </div>
        )}

        {template.declaration && (
          <div style={{ marginTop: '8px', fontSize: '9px', color: GREY, lineHeight: 1.5 }}>
            {template.declaration}
          </div>
        )}

        {/* ── Foot ─────────────────────────────────────────────────────────
            Pushed to the bottom of the sheet by the flex column, so a short
            bill signs at the foot of the paper rather than halfway up it. */}
        <div style={{ marginTop: 'auto', paddingTop: '16px' }}>
          <div style={{ height: '1px', background: RULE, marginBottom: '8px' }} />
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px' }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: '10px', color: GREY }}>
              {template.footerNote || 'Thank you for your business'}
              {bill.createdBy?.name && (
                <div style={{ marginTop: '2px', fontSize: '9px' }}>
                  Booked by {bill.createdBy.name}
                </div>
              )}
            </div>
            {template.showSignature && (
              <div style={{ width: '64mm', textAlign: 'right' }}>
                {company.signatureUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={company.signatureUrl}
                    alt=""
                    style={{ height: '26px', objectFit: 'contain', marginBottom: '2px' }}
                  />
                )}
                <div style={{ borderTop: `1px solid ${RULE}`, paddingTop: '5px', fontSize: '10px' }}>
                  Authorised Signatory
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * The three rules this sheet needs from a stylesheet, and the only ones.
 *
 * Everything else is an inline style on purpose: the app has a dark theme, and
 * a stylesheet that reached the printer would take the paper there with it.
 * These three cannot be expressed inline, because none is a property of an
 * element.
 *
 * `@page` — without it Chrome applies its own ~10mm paper margin, so a block
 *   297mm tall inside a 277mm printable area spills onto a second sheet.
 *
 * `print-color-adjust` — Chrome drops background colours when printing unless
 *   told not to. This sheet is built from filled bands: the BILL box, the
 *   heading strips, the table head and the total. Left alone every one would
 *   print white, and the total would be white text on white paper.
 *
 * `.print-toolbar` — it comes from `PrintToolbar`, which marks itself
 *   `.no-print` and `.print-toolbar`, and both classes are defined inside
 *   `PrintSheet`, which this page does not render. Without them the toolbar
 *   had no styling and, worse, nothing hid it from the printer: it was being
 *   printed at the top of the paper and pushing the sheet onto a second page.
 */
const SHEET_CSS = `
@page { size: A4; margin: 0; }

.sheet {
  display: flex;
  flex-direction: column;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.print-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: 210mm;
  margin: 0 auto 12px;
  padding: 8px 12px;
  background: #fff;
  border-radius: 6px;
  font: 13px Inter, system-ui, sans-serif;
  color: #1f2b3d;
}
.print-toolbar .tb-hint { color: #5a6880; font-size: 12px; margin-right: auto; }
.print-toolbar .tb-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #b9c4d4;
  background: #fff;
  color: #173a6c;
  font-weight: 600;
  cursor: pointer;
}
.print-toolbar a { color: #173a6c; text-decoration: none; font-weight: 600; }

@media print {
  .no-print, .print-toolbar { display: none !important; }
  /* 296, not 297. The sheet is 297mm and so is the paper; a block exactly as
     tall as the page rounds up on some printers and takes a blank second
     sheet with it. */
  .sheet { width: 210mm !important; min-height: 296mm !important; margin: 0 !important; }
}
`
