'use client'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { FileText, Mail, Pencil, Phone, ReceiptText, Rows3, Sprout, Users } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { money, qty as qtyFmt, type EnquiryRecord } from '@/components/purchase/enquiryTypes'

/**
 * The printed purchase enquiry.
 *
 * Two documents on one sheet, decided by `?quote=`:
 *
 *   **A supplier's copy** is what goes out. It is addressed to him, carries the
 *   quantities with an empty Rate column for him to fill in, and ends with a
 *   ruled block for the four facts the mill needs back. It shows nothing about
 *   any other supplier: sending a man a sheet with his competitors' names on it
 *   is not a way to get a keen price.
 *
 *   **The mill's working copy** is what the buyer files. Every supplier asked,
 *   what each of them answered, and which was lowest. Never sent to anybody,
 *   and it says so on its face.
 *
 * The palette is the one the purchase order and the bill already print in —
 * navy masthead, tinted section bars, a filled navy line-grid head. They share
 * a look because they share these constants, not because they share a
 * component: each sheet's middle is too different to abstract, and the three
 * attempts to do so all ended in a component with eleven boolean props.
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

/*
 * Screen and paper are not the same sheet.
 *
 * On screen this is a card: rounded, shadowed, floating on the app's ground,
 * because that is what tells somebody they are looking at a document rather
 * than a page. On paper all three of those are wrong — a shadow prints as grey
 * mud, a rounded corner as a cut corner — so print flattens them and lets the
 * margin box do the framing instead.
 */
const SHEET_CSS = `
  .enq-page { background: #eef2f7; padding: 28px 16px; }
  .enq-sheet {
    background: #fff;
    max-width: 860px;
    margin: 0 auto;
    border-radius: 14px;
    box-shadow: 0 10px 40px rgba(23, 58, 108, 0.12);
    padding: 30px 32px 26px;
  }
  @media print {
    .enq-page { background: #fff; padding: 0; }
    .enq-sheet { box-shadow: none; border-radius: 0; max-width: none; padding: 0; }
    @page { margin: 14mm; }
  }
`

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
  const forQuote = quoteId ? (e.quotes.find((q) => q.id === quoteId) ?? null) : null
  const co = data.company

  return (
    <>
      <style>{SHEET_CSS}</style>
      <PrintToolbar
        backHref="/purchase/enquiries"
        backLabel="Enquiries"
        copies={1}
        fileName={forQuote ? e.enquiryNumber + ' ' + forQuote.supplier.name : e.enquiryNumber}
      />

      <div className="enq-page">
        <div className="enq-sheet" style={{ fontFamily: SANS, color: INK }}>
          {/* ── Letterhead ─────────────────────────────────────────────────
            The name at 28px beside the mark, the address under it, and the
            three ways to reach us on one line with an icon each. Icons rather
            than the words "Phone" and "Email": they are read at a glance by
            somebody scanning a sheet for a number, and they cost no width. */}
          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {co.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={co.logoUrl}
                    alt=""
                    style={{ height: 34, width: 'auto', objectFit: 'contain' }}
                  />
                ) : (
                  <Sprout size={30} style={{ color: '#2f9e7e' }} strokeWidth={1.8} />
                )}
                <h1
                  style={{
                    margin: 0,
                    fontSize: 26,
                    fontWeight: 700,
                    letterSpacing: -0.4,
                    color: NAVY,
                  }}
                >
                  {co.name}
                </h1>
              </div>
              {co.address && (
                <p style={{ margin: '8px 0 0', fontSize: 11.5, color: GREY, lineHeight: 1.5 }}>
                  {[co.address, co.city, co.state, co.pincode].filter(Boolean).join(', ')}
                </p>
              )}
              <div
                style={{
                  margin: '7px 0 0',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '4px 16px',
                  fontSize: 11.5,
                  color: GREY,
                }}
              >
                {co.gstin && <Contact icon={ReceiptText}>GSTIN {co.gstin}</Contact>}
                {co.phone && <Contact icon={Phone}>{co.phone}</Contact>}
                {co.email && <Contact icon={Mail}>{co.email}</Contact>}
              </div>
            </div>

            {/* ── The document block ───────────────────────────────────────
              Which paper this is, and its five identifying facts. Alternating
              tints rather than rules between them: at five rows a ruled grid
              reads as a second table competing with the real one below. */}
            <div
              style={{
                border: '1px solid ' + RULE,
                borderRadius: 6,
                minWidth: 280,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  background: NAVY,
                  color: '#fff',
                  padding: '7px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 11.5,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                }}
              >
                <FileText size={14} />
                Purchase Enquiry{forQuote ? '' : ' — Office Copy'}
              </div>
              <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
                <tbody>
                  <MetaRow i={0} label="Enquiry No" value={e.enquiryNumber} mono />
                  <MetaRow i={1} label="Date" value={shortDate(e.enquiryDate)} mono />
                  <MetaRow
                    i={2}
                    label="Required by"
                    value={e.requiredDate ? shortDate(e.requiredDate) : '—'}
                    mono
                  />
                  <MetaRow i={3} label="Reference" value={e.reference || '—'} mono />
                  <MetaRow i={4} label="Location" value={e.location?.name ?? 'Head office'} />
                </tbody>
              </table>
            </div>
          </div>

          {/* The rule that separates who we are from what we are asking. */}
          <div style={{ height: 2.5, background: NAVY, margin: '18px 0 0', borderRadius: 2 }} />

          {/* ── Who it is to ─────────────────────────────────────────────── */}
          <Panel icon={Users} title={forQuote ? 'To' : 'Suppliers asked'}>
            {forQuote ? (
              <div style={{ padding: '10px 14px' }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: NAVY }}>
                  {forQuote.supplier.name}
                </p>
                <p style={{ margin: '3px 0 0', fontSize: 11.5, color: GREY }}>
                  {forQuote.supplier.code}
                  {forQuote.supplier.gstin && ' · GSTIN ' + forQuote.supplier.gstin}
                </p>
              </div>
            ) : (
              /* The office copy names everybody and what each of them said.
                 This is the sheet the buyer defends the choice with months
                 later, so the losing quotes belong on it. */
              <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: GREY, borderBottom: '1px solid ' + RULE }}>
                    <th style={{ textAlign: 'left', padding: '6px 14px', fontWeight: 600 }}>
                      Supplier
                    </th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600 }}>PI</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 600 }}>
                      Total
                    </th>
                    <th style={{ textAlign: 'left', padding: '6px 14px', fontWeight: 600 }}>
                      Holds to
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {e.quotes.map((q, i) => {
                    const won = e.best?.quoteId === q.id && !q.declinedAt
                    return (
                      <tr key={q.id} style={{ background: i % 2 ? TINT_SOFT : '#fff' }}>
                        <td style={{ padding: '6px 14px', fontWeight: 600, color: NAVY }}>
                          {q.supplier.name}
                          {won && <span style={{ fontWeight: 400, color: GREY }}> · lowest</span>}
                          {q.declinedAt && (
                            <span style={{ fontWeight: 400, color: GREY }}> · passed over</span>
                          )}
                        </td>
                        <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>
                          {q.piNumber ?? '—'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...NUM }}>
                          {q.answered ? '₹' + money(q.piAmount ?? q.value) : '—'}
                        </td>
                        <td style={{ padding: '6px 14px', ...NUM }}>
                          {q.piValidUntil ? shortDate(q.piValidUntil) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </Panel>

          {/* ── The line grid ────────────────────────────────────────────── */}
          <div
            style={{
              marginTop: 16,
              border: '1px solid ' + RULE,
              borderRadius: 6,
              overflow: 'hidden',
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead>
                <tr style={{ background: NAVY, color: '#fff' }}>
                  <th style={{ padding: '8px 10px', textAlign: 'left', width: 40 }}>
                    <Rows3 size={14} style={{ display: 'block' }} />
                  </th>
                  <th style={{ padding: '8px 8px', textAlign: 'left', fontWeight: 600 }}>
                    Item &amp; Description
                  </th>
                  <th style={{ padding: '8px 8px', textAlign: 'left', width: 78, fontWeight: 600 }}>
                    HSN
                  </th>
                  <th
                    style={{ padding: '8px 8px', textAlign: 'right', width: 100, fontWeight: 600 }}
                  >
                    Quantity
                  </th>
                  <th
                    style={{ padding: '8px 8px', textAlign: 'right', width: 90, fontWeight: 600 }}
                  >
                    Rate
                  </th>
                  <th
                    style={{ padding: '8px 12px', textAlign: 'right', width: 70, fontWeight: 600 }}
                  >
                    GST %
                  </th>
                </tr>
              </thead>
              <tbody>
                {e.lines.map((l, i) => {
                  const ql = forQuote?.lines.find((x) => x.enquiryLineId === l.id) ?? null
                  return (
                    <tr key={l.id} style={{ background: i % 2 ? TINT_SOFT : '#fff' }}>
                      <td style={{ padding: '7px 10px', color: GREY, ...NUM }}>{i + 1}</td>
                      <td style={{ padding: '7px 8px' }}>
                        <span style={{ fontWeight: 600, color: NAVY }}>{l.item.name}</span>
                        <span style={{ color: GREY }}> · {l.item.code}</span>
                        {l.description && (
                          <div style={{ color: GREY, fontSize: 10.5, marginTop: 1 }}>
                            {l.description}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '7px 8px', color: GREY, ...NUM }}>
                        {l.hsnCode ?? '—'}
                      </td>
                      <td style={{ padding: '7px 8px', textAlign: 'right', ...NUM }}>
                        {qtyFmt(l.qty)}{' '}
                        <span style={{ color: GREY }}>{l.item.uom?.symbol ?? ''}</span>
                      </td>
                      {/* Left empty on the copy he has not answered yet — the
                        column is what he is being asked to fill in. Once his PI
                        is recorded the sheet reprints with his own figures, and
                        that is the version filed beside the order. */}
                      <td style={{ padding: '7px 8px', textAlign: 'right', ...NUM }}>
                        {ql?.quotedRate != null ? money(ql.quotedRate) : '—'}
                      </td>
                      <td style={{ padding: '7px 12px', textAlign: 'right', ...NUM }}>
                        {ql?.gstRate != null ? Number(ql.gstRate) : '—'}
                      </td>
                    </tr>
                  )
                })}
                {/* Ruled blank rows to a minimum depth. A two-line enquiry
                  printed as a two-line table reads as a torn-off stub, and a
                  supplier being asked to write rates into it needs the room. */}
                {Array.from({ length: Math.max(0, 6 - e.lines.length) }).map((_, i) => (
                  <tr
                    key={'pad' + i}
                    style={{ background: (e.lines.length + i) % 2 ? TINT_SOFT : '#fff' }}
                  >
                    <td style={{ padding: '7px 10px', color: GREY, ...NUM }}>
                      {e.lines.length + i + 1}
                    </td>
                    <td colSpan={5} style={{ padding: '7px 8px' }}>
                      &nbsp;
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: TINT, fontWeight: 700, color: NAVY }}>
                  <td colSpan={4} style={{ padding: '8px 10px', textAlign: 'right' }}>
                    {forQuote?.answered ? 'Total on PI ' + forQuote.piNumber : 'Your total'}
                  </td>
                  <td colSpan={2} style={{ padding: '8px 12px', textAlign: 'right', ...NUM }}>
                    {forQuote?.answered ? '₹' + money(forQuote.piAmount ?? forQuote.value) : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* ── What we are asking him to send back ──────────────────────
            The point of the supplier's copy. A form that asks a man for five
            facts and leaves him nowhere to write them gets them back on his own
            letterhead in his own order, which is how a comparison stops being
            comparable. Never on the office copy: the mill is not quoting
            itself. */}
          {forQuote && (
            <Panel icon={Pencil} title="Your quotation">
              <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
                <tbody>
                  <ReplyRow i={0} label="Your PI / quotation no." />
                  <ReplyRow i={1} label="Price held until" />
                  <ReplyRow i={2} label="Delivery in (days)" />
                  <ReplyRow i={3} label="Payment terms" />
                  <ReplyRow i={4} label="Freight / packing" />
                </tbody>
              </table>
            </Panel>
          )}

          {/* Said on the paper, not only on the screen. A supplier holding a
            sheet that looks like an order will treat it as one. */}
          <div
            style={{
              marginTop: 14,
              padding: '9px 14px',
              background: TINT_SOFT,
              border: '1px solid ' + RULE,
              borderRadius: 6,
              display: 'flex',
              gap: 9,
              alignItems: 'flex-start',
              fontSize: 11,
              color: GREY,
            }}
          >
            <FileText size={14} style={{ marginTop: 1, flexShrink: 0, color: NAVY }} />
            <span>
              {forQuote
                ? 'This is an enquiry, not a purchase order. It places no order and commits neither party. Please quote your rate, your GST and how long you will hold the price.'
                : 'Office copy. Not to be sent to any supplier.'}
            </span>
          </div>

          {(e.notes || e.terms) && (
            <div style={{ marginTop: 16, display: 'flex', gap: 24 }}>
              {e.notes && <Note icon={Pencil} title="Notes" body={e.notes} />}
              {e.terms && <Note icon={ReceiptText} title="Terms" body={e.terms} />}
            </div>
          )}

          {/* Both sides sign a sheet that is going out, because what comes back
            is his quotation and needs his name on it. The office copy signs
            once — there is nobody else in the room. */}
          {data.template?.showSignature !== false && (
            <div
              style={{
                marginTop: 30,
                display: 'flex',
                justifyContent: 'space-between',
                gap: 28,
                fontSize: 11.5,
                color: GREY,
              }}
            >
              {forQuote && (
                <div style={{ flex: 1 }}>
                  <p style={{ margin: 0 }}>For {forQuote.supplier.name}</p>
                  <div style={{ height: 36 }} />
                  <p style={{ margin: 0, borderTop: '1px solid ' + RULE, paddingTop: 4 }}>
                    Signature &amp; seal · Date
                  </p>
                </div>
              )}
              <div style={{ flex: 1, textAlign: 'right' }}>
                <p style={{ margin: 0 }}>For {co.name}</p>
                <div style={{ height: 36 }} />
                <p style={{ margin: 0, borderTop: '1px solid ' + RULE, paddingTop: 4 }}>
                  Authorised signatory
                </p>
              </div>
            </div>
          )}

          {/* The number on the foot as well as the head. A sheet that comes
            back as a fax or a photograph of one page has to still say which
            enquiry it answers. */}
          <div
            style={{
              marginTop: 20,
              borderTop: '1px solid ' + RULE,
              paddingTop: 7,
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
              fontSize: 10,
              color: GREY,
            }}
          >
            <span>
              {e.enquiryNumber}
              {forQuote ? ' · ' + forQuote.supplier.name : ' · office copy'}
            </span>
            <span>{data.template?.footerNote || co.name}</span>
          </div>
        </div>
      </div>
    </>
  )
}

/** One of the three ways to reach us, with its icon. */
function Contact({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <Icon size={13} style={{ color: NAVY, flexShrink: 0 }} />
      {children}
    </span>
  )
}

/**
 * A titled band with a rule round it.
 *
 * The tinted bar is what makes a section findable on a sheet that has four of
 * them. The icon is not decoration: at a glance it separates the people band
 * from the paperwork band without the reader having to start reading.
 */
function Panel({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        marginTop: 16,
        border: '1px solid ' + RULE,
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          background: TINT,
          padding: '7px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: NAVY,
        }}
      >
        <Icon size={15} />
        {title}
      </div>
      {children}
    </div>
  )
}

/** One label-and-value line in the document block. */
function MetaRow({
  i,
  label,
  value,
  mono = false,
}: {
  /** Row index, for the alternating tint. */
  i: number
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <tr style={{ background: i % 2 ? TINT_SOFT : '#fff' }}>
      <td style={{ padding: '5px 12px', color: GREY, whiteSpace: 'nowrap' }}>{label}</td>
      <td
        style={{
          padding: '5px 12px',
          textAlign: 'right',
          fontWeight: 700,
          color: NAVY,
          whiteSpace: 'nowrap',
          ...(mono ? { fontFamily: 'monospace' } : {}),
          ...NUM,
        }}
      >
        {value}
      </td>
    </tr>
  )
}

/** A ruled line for the supplier to write on. */
function ReplyRow({ i, label }: { i: number; label: string }) {
  return (
    <tr style={{ background: i % 2 ? TINT_SOFT : '#fff' }}>
      <td
        style={{
          padding: '9px 14px',
          color: GREY,
          whiteSpace: 'nowrap',
          width: '38%',
          fontSize: 11.5,
        }}
      >
        {label}
      </td>
      <td style={{ padding: '9px 14px', borderBottom: '1px solid ' + RULE }}>&nbsp;</td>
    </tr>
  )
}

/** A titled paragraph at the foot — notes, terms. */
function Note({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ElementType
  title: string
  body: string
}) {
  return (
    <div style={{ flex: 1 }}>
      <p
        style={{
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: NAVY,
        }}
      >
        <Icon size={14} />
        {title}
      </p>
      <p style={{ margin: '5px 0 0 21px', fontSize: 11.5, color: GREY, whiteSpace: 'pre-line' }}>
        {body}
      </p>
    </div>
  )
}
