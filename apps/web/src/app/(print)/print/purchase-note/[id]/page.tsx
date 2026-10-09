'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import type { PurchaseNote } from '@/components/purchase/noteTypes'

/**
 * The printed debit or supplier credit note.
 *
 * The same paper as the purchase bill and the purchase order: navy masthead,
 * the document block boxed off to its right, the two parties side by side, the
 * items under a filled navy head, then the HSN-wise tax summary across the
 * foot. It draws its own sheet and borrows only the toolbar, which is the
 * arrangement the other two settled on — they share a look because they share
 * these constants, not because they share a component.
 *
 * **The parties swap with the document.** A debit note is ours: it goes *from*
 * the mill *to* the supplier. A supplier's credit note is theirs, so it comes
 * from them and is addressed to us. Printing both the same way round would put
 * the mill's name on a document it never issued, which is a different tax
 * position and a different thing to hand somebody.
 */

const NAVY = '#173a6c'
const TINT = '#e9eff8'
const TINT_SOFT = '#f4f7fc'
const INK = '#1f2b3d'
const GREY = '#44536b'
const RULE = '#b9c4d4'

const SANS = 'var(--font-inter), Inter, system-ui, sans-serif'

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

interface PrintData {
  company: Record<string, string | null>
  template: {
    title: string
    declaration: string | null
    footerNote: string | null
    showSignature: boolean
  }
  note: PurchaseNote
  reasonLabel: string
  totalInWords: string
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
}

/** An address written down the page, skipping whatever is not on file. */
function addressLines(p: Record<string, string | null> | null | undefined): string[] {
  if (!p) return []
  const cityLine = [p.city, p.state].filter(Boolean).join(', ')
  const pinLine = [cityLine, p.pincode].filter(Boolean).join(' - ')
  return [p.address, pinLine, p.country || 'INDIA'].filter((l): l is string =>
    Boolean(l && l.trim())
  )
}

export default function PurchaseNotePrintPage() {
  const params = useParams<{ id: string }>()
  const [data, setData] = useState<PrintData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: PrintData }>(`/purchase/notes/${params.id}/print`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load this note.'))
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

  const { company, template, note, reasonLabel, taxMode } = data
  const companyName = company.legalName || company.name || ''
  /* Who issued it, read off the column that records exactly that. It used
     to be inferred from the document being a debit note, which put the
     mill in the From box on a supplier's debit note — their document,
     printed as though we had written it. */
  const ours = note.issuedBy === 'OUR_COMPANY'

  /* The mill is the letterhead, so only the supplier needs a box: who our
     debit note goes to, or whose credit note this is. A second box naming
     the mill under its own letterhead was a quarter of the page saying
     nothing new. */
  const supplierParty = note.supplier as unknown as Record<string, string | null>

  /* What the note is, in the title block: its number and date. */
  const meta: Array<{ label: string; value: string }> = [
    ...(ours
      ? [{ label: 'Note No.', value: note.noteNumber }]
      : [
          { label: 'Their Note No.', value: note.supplierDocNo || '—' },
          { label: 'Our Ref.', value: note.noteNumber },
        ]),
    {
      label: 'Date',
      value: shortDate(ours ? note.noteDate : note.supplierDocDate || note.noteDate),
    },
  ]

  /* What it is against — the papers the supplier will look it up by. A note
     a return challan wrote names the challan rather than a single receipt,
     since one challan can carry goods from several. */
  const refs: Array<{ label: string; value: string; sub?: string }> = [
    ...(note.bill
      ? [
          {
            label: 'Their invoice',
            value: note.bill.supplierInvoiceNo || note.bill.billNumber,
            sub: shortDate(note.bill.billDate),
          },
        ]
      : []),
    ...(note.po ? [{ label: 'Order', value: note.po.poNumber }] : []),
    ...(note.purchaseReturn
      ? [{ label: 'Return challan', value: note.purchaseReturn.returnNumber }]
      : note.grn
        ? [{ label: 'Receipt', value: note.grn.grnNumber }]
        : []),
  ]

  /* The HSN-wise summary, grouped by code and rate together — one code can
     legitimately carry two rates, and merging them prints a rate that applies
     to neither half. Summed from the lines, so this and the totals above it
     cannot disagree. */
  const hsnRows = (() => {
    if (taxMode === 'NONE') return []
    const groups = new Map<
      string,
      { hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number }
    >()
    for (const l of note.lines) {
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

  const totals: Array<{ label: string; value: string }> = [
    { label: 'Taxable Value', value: money(note.taxableAmount) },
    ...(taxMode === 'CGST_SGST'
      ? [
          { label: 'CGST', value: money(note.cgst) },
          { label: 'SGST', value: money(note.sgst) },
        ]
      : []),
    ...(taxMode === 'IGST' ? [{ label: 'IGST', value: money(note.igst) }] : []),
    ...(Number(note.otherCharges) !== 0
      ? [{ label: 'Other Charges', value: money(note.otherCharges) }]
      : []),
    ...(Number(note.discountAmount) !== 0
      ? [{ label: 'Less Discount', value: money(note.discountAmount) }]
      : []),
    ...(Number(note.roundOff) !== 0 ? [{ label: 'Round Off', value: money(note.roundOff) }] : []),
  ]

  const th: React.CSSProperties = {
    background: NAVY,
    color: '#fff',
    fontSize: '9.5px',
    fontWeight: 700,
    padding: '7px 8px',
    textAlign: 'left',
    letterSpacing: '0.2px',
  }

  const td: React.CSSProperties = {
    fontSize: '10px',
    padding: '7px 8px',
    borderBottom: `1px solid ${RULE}`,
    color: INK,
    verticalAlign: 'top',
  }

  const sumTh: React.CSSProperties = {
    background: TINT,
    color: NAVY,
    fontSize: '9px',
    fontWeight: 700,
    padding: '5px 7px',
    borderBottom: `1px solid ${RULE}`,
    textAlign: 'right',
  }

  const sumTd: React.CSSProperties = {
    fontSize: '9.5px',
    padding: '5px 7px',
    borderBottom: `1px solid ${TINT}`,
    color: INK,
    textAlign: 'right',
  }

  /* A small card: a tinted label strip over its contents. */
  const card: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    border: `1px solid ${RULE}`,
    borderRadius: '4px',
    overflow: 'hidden',
  }
  const cardHead: React.CSSProperties = {
    background: TINT,
    color: NAVY,
    fontSize: '8.5px',
    fontWeight: 700,
    letterSpacing: '0.6px',
    textTransform: 'uppercase',
    padding: '5px 10px',
  }
  const cardBody: React.CSSProperties = {
    padding: '8px 10px',
    fontSize: '10px',
    lineHeight: 1.5,
  }

  /* Ruled space under a short note, the way an invoice book rules its rows —
     it says nothing was added after signing. Kept to a row or two so a short
     note still fits one sheet. */
  const fillerRows = Math.max(0, 3 - note.lines.length)

  return (
    <>
      <style>{SHEET_CSS}</style>
      <PrintToolbar
        backHref={
          note.docType === 'SUPPLIER_CREDIT_NOTE'
            ? '/purchase/credit-notes'
            : '/purchase/debit-notes'
        }
        backLabel={ours ? 'Back to debit notes' : 'Back to credit notes'}
        fileName={note.noteNumber}
        copies={1}
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
          padding: '11mm 12mm 10mm',
          boxSizing: 'border-box',
        }}
      >
        {/* ── Letterhead and title ─────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '11px' }}>
              {company.logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={company.logoUrl}
                  alt=""
                  style={{ height: '44px', width: 'auto', objectFit: 'contain', flexShrink: 0 }}
                />
              )}
              <div
                style={{
                  fontSize: '19px',
                  fontWeight: 800,
                  color: NAVY,
                  letterSpacing: '0.2px',
                  textTransform: 'uppercase',
                  lineHeight: 1.1,
                }}
              >
                {companyName}
              </div>
            </div>
            <div style={{ marginTop: '7px', fontSize: '9.5px', color: GREY, lineHeight: 1.55 }}>
              {addressLines(company).join(', ')}
            </div>
            <div style={{ marginTop: '3px', fontSize: '9.5px', color: GREY }}>
              {[company.phone, company.email].filter(Boolean).join('  |  ')}
            </div>
            {company.gstin && (
              <div style={{ marginTop: '3px', fontSize: '10px', fontWeight: 700, color: NAVY }}>
                GSTIN: {company.gstin}
              </div>
            )}
          </div>

          <div style={{ width: '62mm', flexShrink: 0, textAlign: 'right' }}>
            <div
              style={{
                fontSize: ours ? '24px' : '18px',
                fontWeight: 800,
                color: NAVY,
                lineHeight: 1,
                textTransform: 'uppercase',
                letterSpacing: '0.4px',
              }}
            >
              {template.title || (ours ? 'Debit Note' : "Supplier's Credit Note")}
            </div>
            <table style={{ marginTop: '8px', marginLeft: 'auto', borderCollapse: 'collapse' }}>
              <tbody>
                {meta.map((m) => (
                  <tr key={m.label}>
                    <td style={{ fontSize: '9.5px', color: GREY, padding: '1.5px 10px 1.5px 0' }}>
                      {m.label}
                    </td>
                    <td
                      style={{
                        fontSize: '10.5px',
                        fontWeight: 700,
                        color: INK,
                        padding: '1.5px 0',
                        textAlign: 'right',
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

        <div style={{ height: '2px', background: NAVY, margin: '9px 0 9px' }} />

        {/* ── Supplier, references, reason ─────────────────────────────── */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <div style={{ ...card, flex: 1.25 }}>
            <div style={cardHead}>{ours ? 'To' : 'From'}</div>
            <div style={cardBody}>
              <div style={{ fontWeight: 700, color: NAVY, fontSize: '11px' }}>
                {note.supplier.name}
              </div>
              {addressLines(supplierParty).map((l) => (
                <div key={l} style={{ color: GREY }}>
                  {l}
                </div>
              ))}
              {note.supplier.gstin && (
                <div style={{ marginTop: '2px', fontWeight: 700, color: INK }}>
                  GSTIN: {note.supplier.gstin}
                </div>
              )}
            </div>
          </div>

          {refs.length > 0 && (
            <div style={card}>
              <div style={cardHead}>Against</div>
              <div style={cardBody}>
                {refs.map((r) => (
                  <div
                    key={r.label}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}
                  >
                    <span style={{ color: GREY }}>{r.label}</span>
                    <span style={{ fontWeight: 700, textAlign: 'right', ...NUM }}>
                      {r.value}
                      {r.sub && (
                        <span style={{ fontWeight: 400, color: GREY }}> · {r.sub}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Why — at the top, not buried at the foot: whoever opens this
              wants to know what is being claimed before reading a figure. */}
          <div style={card}>
            <div style={cardHead}>Reason</div>
            <div style={cardBody}>
              <div style={{ fontWeight: 700, color: NAVY }}>{reasonLabel}</div>
              {note.reasonNote && <div style={{ color: GREY }}>{note.reasonNote}</div>}
              {(note.warehouse || note.lrNumber || note.vehicleNo) && (
                <div style={{ color: GREY, fontSize: '9px', marginTop: '2px' }}>
                  {[
                    note.warehouse ? `Goods out of ${note.warehouse.name}` : null,
                    note.lrNumber ? `LR ${note.lrNumber}` : null,
                    note.vehicleNo ? `Vehicle ${note.vehicleNo}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── The lines ────────────────────────────────────────────────── */}
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            marginTop: '10px',
            border: `1px solid ${RULE}`,
          }}
        >
          <thead>
            <tr>
              <th style={{ ...th, width: '5%', textAlign: 'center' }}>#</th>
              <th style={th}>Particulars</th>
              <th style={{ ...th, width: '10%', textAlign: 'center' }}>HSN</th>
              <th style={{ ...th, width: '12%', textAlign: 'right' }}>Qty</th>
              <th style={{ ...th, width: '11%', textAlign: 'right' }}>Rate</th>
              <th style={{ ...th, width: '8%', textAlign: 'center' }}>GST%</th>
              <th style={{ ...th, width: '15%', textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {note.lines.map((l, i) => (
              <tr key={l.id} style={{ background: i % 2 ? TINT_SOFT : '#fff' }}>
                <td style={{ ...td, textAlign: 'center', color: GREY, ...NUM }}>{i + 1}</td>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{l.item.name}</div>
                  {/* The code, and what the bill said beside what is coming
                      off it — a reader should not have to fetch the invoice
                      to check the claim. */}
                  <div style={{ fontSize: '8.5px', color: GREY, marginTop: '1px' }}>
                    {[
                      l.item.code,
                      l.description,
                      l.originalQty != null
                        ? `billed ${qtyFmt(l.originalQty)}${l.item.uom ? ` ${l.item.uom.symbol}` : ''}${
                            l.originalRate != null ? ` @ ₹${money(l.originalRate)}` : ''
                          }`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {l.remarks && (
                    <div style={{ fontSize: '8.5px', color: GREY, fontStyle: 'italic' }}>
                      {l.remarks}
                    </div>
                  )}
                </td>
                <td style={{ ...td, textAlign: 'center', ...NUM }}>{l.hsnCode || '—'}</td>
                <td style={{ ...td, textAlign: 'right', ...NUM }}>
                  {qtyFmt(l.qty)}
                  {l.item.uom ? ` ${l.item.uom.symbol}` : ''}
                </td>
                <td style={{ ...td, textAlign: 'right', ...NUM }}>{money(l.unitPrice)}</td>
                <td style={{ ...td, textAlign: 'center', ...NUM }}>{Number(l.gstRate)}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 600, ...NUM }}>
                  {money(l.taxableValue)}
                </td>
              </tr>
            ))}
            {Array.from({ length: fillerRows }).map((_, i) => (
              <tr key={`filler-${i}`}>
                <td style={{ ...td, height: '16px' }} colSpan={7} />
              </tr>
            ))}
          </tbody>
        </table>

        {/* ── Words and notes on the left, figures on the right ────────── */}
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'stretch' }}>
          <div style={{ ...card, display: 'flex', flexDirection: 'column' }}>
            <div style={cardHead}>Amount in words</div>
            <div style={{ ...cardBody, fontWeight: 600, color: INK }}>{data.totalInWords}</div>
            {note.notes && (
              <div style={{ padding: '0 10px 8px', fontSize: '9px', color: GREY, lineHeight: 1.5 }}>
                {note.notes}
              </div>
            )}
          </div>

          <div style={{ width: '66mm', flexShrink: 0, ...card, flex: 'none' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {totals.map((t) => (
                  <tr key={t.label}>
                    <td
                      style={{
                        fontSize: '9.5px',
                        color: GREY,
                        padding: '4px 10px',
                        borderBottom: `1px solid ${TINT}`,
                      }}
                    >
                      {t.label}
                    </td>
                    <td
                      style={{
                        fontSize: '10px',
                        fontWeight: 600,
                        color: INK,
                        padding: '4px 10px',
                        textAlign: 'right',
                        borderBottom: `1px solid ${TINT}`,
                        ...NUM,
                      }}
                    >
                      {t.value}
                    </td>
                  </tr>
                ))}
                <tr style={{ background: NAVY }}>
                  <td
                    style={{
                      fontSize: '10.5px',
                      fontWeight: 800,
                      color: '#fff',
                      padding: '7px 10px',
                      textTransform: 'uppercase',
                    }}
                  >
                    Total
                  </td>
                  <td
                    style={{
                      fontSize: '12.5px',
                      fontWeight: 800,
                      color: '#fff',
                      padding: '7px 10px',
                      textAlign: 'right',
                      ...NUM,
                    }}
                  >
                    ₹{money(note.totalAmount)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* ── HSN-wise tax summary ─────────────────────────────────────── */}
        {hsnRows.length > 0 && (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              marginTop: '8px',
              border: `1px solid ${RULE}`,
            }}
          >
            <thead>
              <tr>
                <th style={{ ...sumTh, textAlign: 'left' }}>HSN</th>
                <th style={sumTh}>Taxable</th>
                {taxMode === 'IGST' ? (
                  <>
                    <th style={sumTh}>IGST %</th>
                    <th style={sumTh}>IGST</th>
                  </>
                ) : (
                  <>
                    <th style={sumTh}>CGST %</th>
                    <th style={sumTh}>CGST</th>
                    <th style={sumTh}>SGST %</th>
                    <th style={sumTh}>SGST</th>
                  </>
                )}
                <th style={sumTh}>Total Tax</th>
              </tr>
            </thead>
            <tbody>
              {hsnRows.map((g) => (
                <tr key={`${g.hsn}|${g.rate}`}>
                  <td style={{ ...sumTd, textAlign: 'left', ...NUM }}>{g.hsn}</td>
                  <td style={{ ...sumTd, ...NUM }}>{money(g.taxable)}</td>
                  {taxMode === 'IGST' ? (
                    <>
                      <td style={{ ...sumTd, ...NUM }}>{g.rate}</td>
                      <td style={{ ...sumTd, ...NUM }}>{money(g.igst)}</td>
                    </>
                  ) : (
                    <>
                      <td style={{ ...sumTd, ...NUM }}>{g.rate / 2}</td>
                      <td style={{ ...sumTd, ...NUM }}>{money(g.cgst)}</td>
                      <td style={{ ...sumTd, ...NUM }}>{g.rate / 2}</td>
                      <td style={{ ...sumTd, ...NUM }}>{money(g.sgst)}</td>
                    </>
                  )}
                  <td style={{ ...sumTd, fontWeight: 600, ...NUM }}>
                    {money(g.cgst + g.sgst + g.igst)}
                  </td>
                </tr>
              ))}
              {hsnRows.length > 1 && (
                <tr style={{ background: TINT_SOFT }}>
                  <td style={{ ...sumTd, textAlign: 'left', fontWeight: 800, color: NAVY }}>
                    Total
                  </td>
                  <td style={{ ...sumTd, fontWeight: 800, ...NUM }}>{money(hsnTotal.taxable)}</td>
                  {taxMode === 'IGST' ? (
                    <>
                      <td style={sumTd} />
                      <td style={{ ...sumTd, fontWeight: 800, ...NUM }}>{money(hsnTotal.igst)}</td>
                    </>
                  ) : (
                    <>
                      <td style={sumTd} />
                      <td style={{ ...sumTd, fontWeight: 800, ...NUM }}>{money(hsnTotal.cgst)}</td>
                      <td style={sumTd} />
                      <td style={{ ...sumTd, fontWeight: 800, ...NUM }}>{money(hsnTotal.sgst)}</td>
                    </>
                  )}
                  <td style={{ ...sumTd, fontWeight: 800, ...NUM }}>
                    {money(hsnTotal.cgst + hsnTotal.sgst + hsnTotal.igst)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {taxMode === 'NONE' && (
          <div style={{ marginTop: '8px', fontSize: '9.5px', fontWeight: 700, color: NAVY }}>
            Supplier is not registered under GST. No tax on this note.
          </div>
        )}

        {/* A draft on paper has to say so, or it is read as a claim that has
            been made. Only a posted note has actually adjusted anything. */}
        {note.status !== 'POSTED' && (
          <div
            style={{
              marginTop: '8px',
              fontSize: '9.5px',
              fontWeight: 700,
              color: '#a03030',
              textTransform: 'uppercase',
              letterSpacing: '0.3px',
            }}
          >
            {note.status === 'CANCELLED' || note.status === 'REJECTED'
              ? `${note.status.toLowerCase()} — this note claims nothing`
              : 'Draft — not yet posted, for review only'}
          </div>
        )}

        {template.declaration && (
          <div style={{ marginTop: '8px', fontSize: '8.5px', color: GREY, lineHeight: 1.5 }}>
            {template.declaration}
          </div>
        )}

        {/* ── Foot: what we ask, and who signs ─────────────────────────── */}
        <div style={{ marginTop: 'auto', paddingTop: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px' }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: '9.5px', color: GREY }}>
              {template.footerNote ||
                (ours
                  ? 'Please credit our account with the amount above.'
                  : 'Recorded against the bill named above.')}
              {note.createdBy?.name && (
                <div style={{ marginTop: '2px', fontSize: '8.5px' }}>
                  Raised by {note.createdBy.name}
                  {note.approvedBy?.name ? ` · Approved by ${note.approvedBy.name}` : ''}
                </div>
              )}
            </div>
            {template.showSignature && (
              <div style={{ width: '60mm', textAlign: 'center' }}>
                <div style={{ fontSize: '9px', color: GREY, marginBottom: '4px' }}>
                  For {companyName}
                </div>
                {company.signatureUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={company.signatureUrl}
                    alt=""
                    style={{ height: '28px', objectFit: 'contain', display: 'block', margin: '0 auto 2px' }}
                  />
                ) : (
                  <div style={{ height: '28px' }} />
                )}
                <div
                  style={{
                    borderTop: `1px solid ${RULE}`,
                    paddingTop: '4px',
                    fontSize: '9.5px',
                    color: INK,
                  }}
                >
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
 * The same three rules the bill sheet needs, and for the same reasons: `@page`
 * so Chrome does not add its own margin and push a 297mm block onto a second
 * sheet, `print-color-adjust` so the filled navy bands do not print white on
 * white, and the toolbar's own styles, which live in `PrintSheet` — a
 * component this page does not render.
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
  .sheet { width: 210mm !important; min-height: 296mm !important; margin: 0 !important; }
}
`
