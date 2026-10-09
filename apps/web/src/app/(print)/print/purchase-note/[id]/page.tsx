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

  /* Who issued it decides which way round the two boxes read. */
  const parties = ours
    ? [
        { head: 'From', party: company, name: companyName, gstin: company.gstin },
        {
          head: 'To',
          party: note.supplier as unknown as Record<string, string | null>,
          name: note.supplier.name,
          gstin: note.supplier.gstin,
        },
      ]
    : [
        {
          head: 'From',
          party: note.supplier as unknown as Record<string, string | null>,
          name: note.supplier.name,
          gstin: note.supplier.gstin,
        },
        { head: 'To', party: company, name: companyName, gstin: company.gstin },
      ]

  const meta: Array<{ label: string; value: string }> = [
    ...(ours
      ? [{ label: 'Note No.', value: note.noteNumber }]
      : [
          { label: 'Their Note No.', value: note.supplierDocNo || '—' },
          { label: 'Our Reference', value: note.noteNumber },
        ]),
    {
      label: 'Date',
      value: shortDate(ours ? note.noteDate : note.supplierDocDate || note.noteDate),
    },
    ...(note.bill
      ? [
          { label: 'Against Bill', value: note.bill.supplierInvoiceNo || note.bill.billNumber },
          { label: 'Bill Date', value: shortDate(note.bill.billDate) },
        ]
      : []),
    ...(note.po ? [{ label: 'Order No.', value: note.po.poNumber }] : []),
    ...(note.grn ? [{ label: 'Receipt No.', value: note.grn.grnNumber }] : []),
    // The gate pass the goods went back on, for a note a return challan wrote.
    ...(note.purchaseReturn
      ? [{ label: 'Return Challan', value: note.purchaseReturn.returnNumber }]
      : []),
    { label: 'Reason', value: reasonLabel },
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
          { label: 'SGST', value: money(note.sgst) },
          { label: 'CGST', value: money(note.cgst) },
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

  /* Ruled space under a short note, the way an invoice book rules its rows to
     the foot of the page — it is what says nothing was added after signing. */
  const fillerRows = Math.max(0, 5 - note.lines.length)

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
          padding: '14mm 12mm',
          boxSizing: 'border-box',
        }}
      >
        {/* ── Masthead ─────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'stretch' }}>
          <div style={{ flex: 1, minWidth: 0, paddingBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '13px' }}>
              {company.logoUrl && (
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
                fontSize: ours ? '27px' : '21px',
                fontWeight: 800,
                color: NAVY,
                lineHeight: 1,
                marginBottom: '11px',
                textTransform: 'uppercase',
              }}
            >
              {template.title || (ours ? 'DEBIT NOTE' : "SUPPLIER'S CREDIT NOTE")}
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

        {/* ── The two parties ──────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: '8px' }}>
          {parties.map((box) => (
            <div
              key={box.head}
              style={{ flex: 1, minWidth: 0, border: `1px solid ${RULE}`, background: '#fff' }}
            >
              <BlockHead>{box.head}</BlockHead>
              <div style={{ padding: '11px 12px', fontSize: '10.5px', lineHeight: 1.65 }}>
                <div style={{ fontWeight: 700, color: NAVY, fontSize: '12px' }}>{box.name}</div>
                {addressLines(box.party).map((l) => (
                  <div key={l} style={{ color: GREY }}>
                    {l}
                  </div>
                ))}
                {box.gstin && (
                  <div style={{ marginTop: '4px', fontWeight: 700, color: INK }}>
                    GSTIN: {box.gstin}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* ── Why ──────────────────────────────────────────────────────────
            Top of the sheet, not buried in a remark at the foot. Whoever opens
            this envelope wants to know what is being claimed before they read
            a single figure. */}
        <div
          style={{
            marginTop: '8px',
            border: `1px solid ${RULE}`,
            background: TINT_SOFT,
            padding: '9px 12px',
            fontSize: '10.5px',
            color: INK,
          }}
        >
          <span style={{ fontWeight: 700, color: NAVY }}>{reasonLabel}</span>
          {note.reasonNote && <span style={{ color: GREY }}> — {note.reasonNote}</span>}
          {note.warehouse && (
            <span style={{ color: GREY }}>
              {' '}
              · Goods out of {note.warehouse.name}
              {note.lrNumber ? ` · LR ${note.lrNumber}` : ''}
              {note.vehicleNo ? ` · Vehicle ${note.vehicleNo}` : ''}
            </span>
          )}
        </div>

        {/* ── The lines ────────────────────────────────────────────────── */}
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '8px' }}>
          <thead>
            <tr>
              <th style={{ ...th, width: '7%', textAlign: 'center' }}>#</th>
              <th style={th}>Particulars</th>
              <th style={{ ...th, width: '11%', textAlign: 'center' }}>HSN</th>
              <th style={{ ...th, width: '13%', textAlign: 'right' }}>Qty</th>
              <th style={{ ...th, width: '13%', textAlign: 'right' }}>Rate</th>
              <th style={{ ...th, width: '9%', textAlign: 'center' }}>GST%</th>
              <th style={{ ...th, width: '16%', textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {note.lines.map((l, i) => (
              <tr key={l.id}>
                <td style={{ ...td, textAlign: 'center', ...NUM }}>{i + 1}</td>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{l.item.name}</div>
                  <div style={{ fontSize: '9.5px', color: GREY }}>
                    {l.item.code}
                    {l.description ? ` · ${l.description}` : ''}
                  </div>
                  {/* What the bill said, beside what is coming off it. A reader
                      should not have to fetch the invoice to check the claim. */}
                  {l.originalQty != null && (
                    <div style={{ fontSize: '9.5px', color: GREY }}>
                      Billed {qtyFmt(l.originalQty)}
                      {l.item.uom ? ` ${l.item.uom.symbol}` : ''}
                      {l.originalRate != null ? ` @ ₹${money(l.originalRate)}` : ''}
                    </div>
                  )}
                  {l.remarks && (
                    <div style={{ fontSize: '9.5px', color: GREY, fontStyle: 'italic' }}>
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

        {/* ── Words on the left, figures on the right ──────────────────── */}
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'stretch' }}>
          <div style={{ flex: 1, minWidth: 0, border: `1px solid ${RULE}`, background: '#fff' }}>
            <BlockHead>Amount in Words</BlockHead>
            <div style={{ padding: '11px 12px', fontSize: '11px', color: INK, lineHeight: 1.6 }}>
              {data.totalInWords}
            </div>
            {note.notes && (
              <div
                style={{
                  padding: '0 12px 11px',
                  fontSize: '10px',
                  color: GREY,
                  lineHeight: 1.6,
                }}
              >
                {note.notes}
              </div>
            )}
          </div>

          <div style={{ width: '73mm', flexShrink: 0, border: `1px solid ${RULE}` }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {totals.map((t) => (
                  <tr key={t.label}>
                    <td
                      style={{
                        fontSize: '10.5px',
                        color: GREY,
                        padding: '6px 12px',
                        borderBottom: `1px solid ${TINT}`,
                      }}
                    >
                      {t.label}
                    </td>
                    <td
                      style={{
                        fontSize: '10.5px',
                        fontWeight: 600,
                        color: INK,
                        padding: '6px 12px',
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
                      fontSize: '11.5px',
                      fontWeight: 800,
                      color: '#fff',
                      padding: '9px 12px',
                      textTransform: 'uppercase',
                    }}
                  >
                    Total
                  </td>
                  <td
                    style={{
                      fontSize: '13px',
                      fontWeight: 800,
                      color: '#fff',
                      padding: '9px 12px',
                      textAlign: 'right',
                      ...NUM,
                    }}
                  >
                    {money(note.totalAmount)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* ── HSN-wise tax summary ─────────────────────────────────────── */}
        {hsnRows.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '8px' }}>
            <thead>
              <tr>
                <th style={{ ...sumTh, textAlign: 'left' }}>HSN</th>
                <th style={{ ...sumTh, textAlign: 'right' }}>Taxable</th>
                {taxMode === 'IGST' ? (
                  <>
                    <th style={sumTh}>IGST %</th>
                    <th style={{ ...sumTh, textAlign: 'right' }}>IGST</th>
                  </>
                ) : (
                  <>
                    <th style={sumTh}>SGST %</th>
                    <th style={{ ...sumTh, textAlign: 'right' }}>SGST</th>
                    <th style={sumTh}>CGST %</th>
                    <th style={{ ...sumTh, textAlign: 'right' }}>CGST</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {hsnRows.map((g) => (
                <tr key={`${g.hsn}|${g.rate}`}>
                  <td style={{ ...sumTd, textAlign: 'left', ...NUM }}>{g.hsn}</td>
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
                <td style={{ ...sumTd, textAlign: 'left', fontWeight: 800, color: NAVY }}>Total</td>
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

        {taxMode === 'NONE' && (
          <div style={{ marginTop: '8px', fontSize: '10.5px', fontWeight: 700, color: NAVY }}>
            Supplier is not registered under GST. No tax on this note.
          </div>
        )}

        {/* A draft on paper has to say so, or it is read as a claim that has
            been made. Only a posted note has actually adjusted anything. */}
        {note.status !== 'POSTED' && (
          <div
            style={{
              marginTop: '8px',
              fontSize: '10.5px',
              fontWeight: 700,
              color: '#a03030',
              textTransform: 'uppercase',
            }}
          >
            {note.status === 'CANCELLED' || note.status === 'REJECTED'
              ? `${note.status.toLowerCase()} — this note claims nothing`
              : 'Not yet posted — for review only'}
          </div>
        )}

        {template.declaration && (
          <div style={{ marginTop: '8px', fontSize: '9px', color: GREY, lineHeight: 1.5 }}>
            {template.declaration}
          </div>
        )}

        <div style={{ marginTop: 'auto', paddingTop: '16px' }}>
          <div style={{ height: '1px', background: RULE, marginBottom: '8px' }} />
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px' }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: '10px', color: GREY }}>
              {template.footerNote ||
                (ours
                  ? 'Please credit our account with the amount above.'
                  : 'Recorded against the bill named above.')}
              {note.createdBy?.name && (
                <div style={{ marginTop: '2px', fontSize: '9px' }}>
                  Raised by {note.createdBy.name}
                  {note.approvedBy?.name ? ` · Approved by ${note.approvedBy.name}` : ''}
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
                <div
                  style={{ borderTop: `1px solid ${RULE}`, paddingTop: '5px', fontSize: '10px' }}
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
