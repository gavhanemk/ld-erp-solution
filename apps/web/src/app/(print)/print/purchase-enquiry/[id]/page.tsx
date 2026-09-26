'use client'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { money, qty as qtyFmt, type EnquiryRecord } from '@/components/purchase/enquiryTypes'

/**
 * The printed purchase enquiry.
 *
 * Two documents on one sheet, decided by `?quote=`:
 *
 *   **A supplier's copy** is what goes out. It is addressed to him, carries the
 *   quantities and our terms, and has an empty Rate column for him to fill in —
 *   which is the whole point of the paper. It shows nothing about any other
 *   supplier: sending a man a sheet with his competitors' names on it is not a
 *   way to get a keen price.
 *
 *   **The mill's working copy** is what the buyer files. Every supplier asked,
 *   what each of them answered, and the comparison. Never sent to anybody.
 *
 * Same paper as the purchase order and the bill — navy masthead, the document
 * block boxed off to its right, items under a filled navy head. They share a
 * look because they share these constants, not because they share a component.
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

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })

interface PrintData {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; showSignature: boolean } | null
  enquiry: EnquiryRecord
  forQuoteId: string | null
}

export default function PurchaseEnquiryPrintPage() {
  const params = useParams<{ id: string }>()
  const search = useSearchParams()
  const quoteId = search.get('quote')

  const [data, setData] = useState<PrintData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ data: PrintData }>(
          '/purchase/enquiries/' + params.id + '/print' + (quoteId ? '?quote=' + quoteId : '')
        )
        setData(res.data)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not build the sheet.')
      }
    })()
  }, [params.id, quoteId])

  if (error) {
    return <p style={{ fontFamily: SANS, padding: 40, color: '#b91c1c' }}>{error}</p>
  }
  if (!data) {
    return <p style={{ fontFamily: SANS, padding: 40, color: GREY }}>Building the sheet…</p>
  }

  const e = data.enquiry
  const forQuote = quoteId ? e.quotes.find((q) => q.id === quoteId) : null
  const co = data.company

  return (
    <>
      <PrintToolbar
        backHref="/purchase/enquiries"
        backLabel="Enquiries"
        copies={1}
        fileName={forQuote ? e.enquiryNumber + ' ' + forQuote.supplier.name : e.enquiryNumber}
      />
      <div
        style={{
          fontFamily: SANS,
          color: INK,
          background: '#fff',
          maxWidth: 820,
          margin: '0 auto',
          padding: 28,
        }}
      >
        {/* ── Masthead ───────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: NAVY }}>{co.name}</h1>
            {co.address && (
              <p style={{ margin: '3px 0 0', fontSize: 11, color: GREY, lineHeight: 1.45 }}>
                {[co.address, co.city, co.state, co.pincode].filter(Boolean).join(', ')}
              </p>
            )}
            <p style={{ margin: '3px 0 0', fontSize: 11, color: GREY }}>
              {co.gstin && <>GSTIN {co.gstin}</>}
              {co.phone && <> · {co.phone}</>}
              {co.email && <> · {co.email}</>}
            </p>
          </div>
          <div
            style={{
              border: '1px solid ' + RULE,
              borderRadius: 4,
              minWidth: 250,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                background: NAVY,
                color: '#fff',
                padding: '5px 10px',
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
              }}
            >
              {/* The sheet says which of the two it is, because one may be sent
                and the other must not. */}
              {forQuote ? 'Purchase Enquiry' : 'Purchase Enquiry — office copy'}
            </div>
            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
              <tbody>
                <PrintRow label="Enquiry No" value={e.enquiryNumber} mono />
                <PrintRow label="Date" value={shortDate(e.enquiryDate)} />
                {e.requiredDate && (
                  <PrintRow label="Required by" value={shortDate(e.requiredDate)} />
                )}
                {e.reference && <PrintRow label="Reference" value={e.reference} mono />}
                <PrintRow label="Location" value={e.location?.name ?? 'Head office'} />
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ height: 3, background: NAVY, margin: '12px 0 0' }} />

        {/* ── Who it is to ───────────────────────────────────────────────── */}
        <div style={{ marginTop: 14 }}>
          <div
            style={{
              background: TINT,
              padding: '4px 10px',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              color: NAVY,
            }}
          >
            {forQuote ? 'To' : 'Suppliers asked'}
          </div>
          <div style={{ border: '1px solid ' + RULE, borderTop: 0, padding: 10 }}>
            {forQuote ? (
              <>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{forQuote.supplier.name}</p>
                {forQuote.supplier.gstin && (
                  <p style={{ margin: '2px 0 0', fontSize: 11, color: GREY }}>
                    GSTIN {forQuote.supplier.gstin}
                  </p>
                )}
              </>
            ) : (
              /* The office copy names everybody, with what each of them said.
                 This is the sheet the buyer files and defends the choice with
                 months later, so the losing quotes belong on it. */
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: GREY }}>
                    <th style={{ textAlign: 'left', padding: '2px 4px' }}>Supplier</th>
                    <th style={{ textAlign: 'left', padding: '2px 4px' }}>PI</th>
                    <th style={{ textAlign: 'right', padding: '2px 4px' }}>Total</th>
                    <th style={{ textAlign: 'left', padding: '2px 4px' }}>Holds to</th>
                  </tr>
                </thead>
                <tbody>
                  {e.quotes.map((q) => {
                    const won = e.best?.quoteId === q.id && !q.declinedAt
                    return (
                      <tr key={q.id} style={{ borderTop: '1px solid ' + RULE }}>
                        <td style={{ padding: '3px 4px', fontWeight: won ? 700 : 400 }}>
                          {q.supplier.name}
                          {won && <span style={{ color: NAVY }}> · lowest</span>}
                          {q.declinedAt && <span style={{ color: GREY }}> · passed over</span>}
                        </td>
                        <td style={{ padding: '3px 4px', fontFamily: 'monospace' }}>
                          {q.piNumber ?? '—'}
                        </td>
                        <td style={{ padding: '3px 4px', textAlign: 'right', ...NUM }}>
                          {q.answered ? money(q.piAmount ?? q.value) : '—'}
                        </td>
                        <td style={{ padding: '3px 4px' }}>
                          {q.piValidUntil ? shortDate(q.piValidUntil) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ── The items ──────────────────────────────────────────────────── */}
        <table style={{ width: '100%', marginTop: 14, borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: NAVY, color: '#fff' }}>
              <th style={{ padding: '5px 6px', textAlign: 'left', width: 26 }}>#</th>
              <th style={{ padding: '5px 6px', textAlign: 'left' }}>Item &amp; description</th>
              <th style={{ padding: '5px 6px', textAlign: 'left', width: 70 }}>HSN</th>
              <th style={{ padding: '5px 6px', textAlign: 'right', width: 80 }}>Quantity</th>
              <th style={{ padding: '5px 6px', textAlign: 'right', width: 90 }}>Rate</th>
              <th style={{ padding: '5px 6px', textAlign: 'right', width: 60 }}>GST %</th>
            </tr>
          </thead>
          <tbody>
            {e.lines.map((l, i) => {
              const ql = forQuote?.lines.find((x) => x.enquiryLineId === l.id) ?? null
              return (
                <tr
                  key={l.id}
                  style={{
                    background: i % 2 ? TINT_SOFT : '#fff',
                    borderBottom: '1px solid ' + RULE,
                  }}
                >
                  <td style={{ padding: '5px 6px', color: GREY }}>{i + 1}</td>
                  <td style={{ padding: '5px 6px' }}>
                    <span style={{ fontWeight: 600 }}>{l.item.name}</span>
                    <span style={{ color: GREY }}> · {l.item.code}</span>
                    {l.description && (
                      <div style={{ color: GREY, fontSize: 10 }}>{l.description}</div>
                    )}
                  </td>
                  <td style={{ padding: '5px 6px', color: GREY }}>{l.hsnCode ?? '—'}</td>
                  <td style={{ padding: '5px 6px', textAlign: 'right', ...NUM }}>
                    {qtyFmt(l.qty)} {l.item.uom?.symbol ?? ''}
                  </td>
                  {/* Left blank on the copy he has not answered yet — the
                    column is what he is being asked to fill in. Once his PI is
                    recorded the sheet reprints with his own figures, which is
                    the version that goes in the file beside the order. */}
                  <td style={{ padding: '5px 6px', textAlign: 'right', ...NUM }}>
                    {ql?.quotedRate != null ? money(ql.quotedRate) : ''}
                  </td>
                  <td style={{ padding: '5px 6px', textAlign: 'right', ...NUM }}>
                    {ql?.gstRate != null ? Number(ql.gstRate) : ''}
                  </td>
                </tr>
              )
            })}
            {/* Ruled blank rows to a minimum depth.
              A two-line enquiry printed as a two-line table over half a page of
              nothing reads as a torn-off stub, and a supplier who is being
              asked to write rates into it needs somewhere to write. The shared
              `DocumentTable` pads for the same reason; this sheet draws its own
              grid and has to do it itself. */}
            {Array.from({ length: Math.max(0, 8 - e.lines.length) }).map((_, i) => (
              <tr
                key={'pad' + i}
                style={{
                  background: (e.lines.length + i) % 2 ? TINT_SOFT : '#fff',
                  borderBottom: '1px solid ' + RULE,
                }}
              >
                <td style={{ padding: '5px 6px', color: GREY }}>{e.lines.length + i + 1}</td>
                <td colSpan={5} style={{ padding: '5px 6px' }}>
                  &nbsp;
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {forQuote?.answered ? (
              <tr style={{ background: TINT, fontWeight: 700 }}>
                <td colSpan={4} style={{ padding: '5px 6px', textAlign: 'right' }}>
                  Total on PI {forQuote.piNumber}
                </td>
                <td colSpan={2} style={{ padding: '5px 6px', textAlign: 'right', ...NUM }}>
                  {money(forQuote.piAmount ?? forQuote.value)}
                </td>
              </tr>
            ) : (
              /* An empty total line on the copy he has not answered yet. He is
                 being asked for a figure, and a form that asks for one without
                 leaving a ruled space for it gets the figure written in the
                 margin. */
              <tr style={{ background: TINT, fontWeight: 700 }}>
                <td colSpan={4} style={{ padding: '7px 6px', textAlign: 'right' }}>
                  Your total
                </td>
                <td colSpan={2} style={{ padding: '7px 6px' }}>
                  &nbsp;
                </td>
              </tr>
            )}
          </tfoot>
        </table>

        {/* Said on the paper, not only on the screen. A supplier holding a
          sheet that looks like an order will treat it as one. */}
        <p
          style={{
            marginTop: 12,
            padding: '6px 10px',
            background: TINT_SOFT,
            border: '1px solid ' + RULE,
            fontSize: 10.5,
            color: GREY,
          }}
        >
          {forQuote
            ? 'This is an enquiry, not a purchase order. It places no order and commits neither party. Please quote your rate, your GST and how long you will hold the price.'
            : 'Office copy. Not to be sent to any supplier.'}
        </p>

        {/* ── What we are asking him to send back ──────────────────────────

          The reply block is the point of the supplier's copy, and it was the
          thing the sheet did not have: a form that asks a man for four facts
          and leaves him nowhere to write them gets them back on a letterhead
          in his own order, which is how a comparison stops being comparable.

          Never on the office copy — the mill is not quoting itself. */}
        {forQuote && (
          <div style={{ marginTop: 12, border: '1px solid ' + RULE, borderRadius: 4 }}>
            <div
              style={{
                background: TINT,
                padding: '4px 10px',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: NAVY,
              }}
            >
              Your quotation
            </div>
            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
              <tbody>
                <ReplyRow label="Your PI / quotation no." />
                <ReplyRow label="Price held until" />
                <ReplyRow label="Delivery in (days)" />
                <ReplyRow label="Payment terms" />
                <ReplyRow label="Freight / packing" />
              </tbody>
            </table>
          </div>
        )}

        {(e.notes || e.terms) && (
          <div style={{ marginTop: 12, display: 'flex', gap: 16 }}>
            {e.notes && (
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: NAVY }}>NOTES</p>
                <p style={{ margin: '3px 0 0', fontSize: 11, color: GREY, whiteSpace: 'pre-line' }}>
                  {e.notes}
                </p>
              </div>
            )}
            {e.terms && (
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: NAVY }}>TERMS</p>
                <p style={{ margin: '3px 0 0', fontSize: 11, color: GREY, whiteSpace: 'pre-line' }}>
                  {e.terms}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Both sides sign an enquiry that is going out, because the thing
          coming back is his quotation and it needs his name on it. The office
          copy signs once — there is nobody else in the room. */}
        {data.template?.showSignature !== false && (
          <div
            style={{
              marginTop: 30,
              display: 'flex',
              justifyContent: 'space-between',
              gap: 24,
              fontSize: 11,
              color: GREY,
            }}
          >
            {forQuote && (
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0 }}>For {forQuote.supplier.name}</p>
                <div style={{ height: 34 }} />
                <p style={{ margin: 0, borderTop: '1px solid ' + RULE, paddingTop: 3 }}>
                  Signature &amp; seal · Date
                </p>
              </div>
            )}
            <div style={{ flex: 1, textAlign: 'right' }}>
              <p style={{ margin: 0 }}>For {co.name}</p>
              <div style={{ height: 34 }} />
              <p style={{ margin: 0, borderTop: '1px solid ' + RULE, paddingTop: 3 }}>
                Authorised signatory
              </p>
            </div>
          </div>
        )}

        {/* The number on the foot as well as the head. A sheet that comes back
          by fax or as a photograph of the second page has to still say which
          enquiry it answers. */}
        <div
          style={{
            marginTop: 18,
            borderTop: '1px solid ' + RULE,
            paddingTop: 6,
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 9.5,
            color: GREY,
          }}
        >
          <span>
            {e.enquiryNumber}
            {forQuote ? ' · ' + forQuote.supplier.name : ' · office copy'}
          </span>
          <span>{co.name}</span>
        </div>

        {data.template?.footerNote && (
          <p style={{ marginTop: 14, fontSize: 10, color: GREY, textAlign: 'center' }}>
            {data.template.footerNote}
          </p>
        )}
      </div>
    </>
  )
}

/** A ruled line for the supplier to write on. */
function ReplyRow({ label }: { label: string }) {
  return (
    <tr style={{ borderTop: '1px solid ' + RULE }}>
      <td style={{ padding: '7px 10px', color: GREY, whiteSpace: 'nowrap', width: '38%' }}>
        {label}
      </td>
      <td style={{ padding: '7px 10px' }}>&nbsp;</td>
    </tr>
  )
}

/** One label-and-value line in the document block. */
function PrintRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <tr style={{ borderTop: '1px solid ' + RULE }}>
      <td style={{ padding: '3px 10px', color: GREY, whiteSpace: 'nowrap' }}>{label}</td>
      <td
        style={{
          padding: '3px 10px',
          textAlign: 'right',
          fontWeight: 600,
          fontFamily: mono ? 'monospace' : undefined,
        }}
      >
        {value}
      </td>
    </tr>
  )
}
