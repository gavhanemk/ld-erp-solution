'use client'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { FileText, Mail, Pencil, Phone, ReceiptText, Rows3, Sprout, Users } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { money, qty as qtyFmt, type EnquiryRecord } from '@/components/purchase/enquiryTypes'

/**
 * The printed purchase enquiry — a request for quotation.
 *
 * One document, and it goes out. Our letterhead, what we want and how much of
 * it, an empty Rate and GST column for the supplier to fill in, a ruled block
 * for the facts we need back, and both signatures. There is no second version
 * and nothing on it that cannot be handed to anybody: print it once and send
 * the same sheet to four suppliers.
 *
 * `?quote=<id>` only addresses it. With one, the To block carries that
 * supplier's name and, once his proforma is recorded, his own rates — which is
 * the copy filed beside the order. Without one the To block is a ruled line to
 * write a name on, the way an enquiry pad has always worked.
 *
 * What it deliberately does **not** carry is who else was asked or what they
 * said. That comparison is the buyer's, it lives on the Compare panel in the
 * app, and a sheet that goes to a supplier with his competitors' names and
 * totals on it is not a way to get a keen price out of him.
 *
 * The palette is the one the purchase order and the bill already print in —
 * navy masthead, tinted section bars, a filled navy line-grid head. They share
 * a look because they share these constants, not because they share a
 * component: each sheet's middle is too different to abstract, and the three
 * attempts to do so all ended in a component with eleven boolean props.
 */

const NAVY = '#173a6c'
/**
 * The navy stepped back, for the second thing in a cell.
 *
 * An item code beside an item name, an HSN beside a quantity, "lowest" beside
 * a supplier — each is a qualifier on the thing before it, and in grey they
 * read as disabled rather than secondary. A lighter tone of the same blue
 * keeps them part of the same sentence.
 */
const SOFT = '#4f7ba8'
const TINT = '#e9eff8'
const TINT_SOFT = '#f4f7fc'
const INK = '#1f2b3d'
const GREY = '#44536b'
const RULE = '#b9c4d4'
/** The hairline inside a tinted panel, where the full rule is too dark. */
const RULE_SOFT = '#dbe4ef'

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
 * On screen this is a card: rounded, shadowed, floating on a ground that is
 * lit from the left, because that is what tells somebody they are looking at a
 * document rather than a page. On paper all of it is wrong — a shadow prints
 * as grey mud, a rounded corner as a cut corner, a tinted ground as a wash
 * over the whole sheet — so print flattens them and lets the margin box do the
 * framing instead.
 */
const SHEET_CSS = `
  .enq-page {
    background: #e9eef6;
    background-image:
      radial-gradient(1100px 420px at -8% 26%, rgba(255, 255, 255, 0.8), transparent 62%),
      radial-gradient(900px 520px at 108% 6%, rgba(255, 255, 255, 0.55), transparent 58%);
    padding: 32px 16px 44px;
  }
  .enq-sheet {
    background: #fff;
    max-width: 900px;
    margin: 0 auto;
    border-radius: 16px;
    box-shadow: 0 18px 50px rgba(23, 58, 108, 0.14);
    padding: 34px 36px 30px;
  }
  @media print {
    .enq-page { background: #fff; background-image: none; padding: 0; }
    .enq-sheet { box-shadow: none; border-radius: 0; max-width: none; padding: 0; }
    /*
     * Keep the filled bands filled.
     *
     * A browser drops every background when it prints unless it is told not
     * to, and this sheet is built out of them: the navy table head carries
     * white column names, and the contact tiles carry white glyphs. Dropped,
     * both print as white on white — the headings simply are not there, and
     * nobody notices until the sheet is in a supplier's hand. It is stated
     * here rather than left to whoever remembers to tick "Background
     * graphics" in the print box.
     */
    .enq-sheet, .enq-sheet * {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
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

  /*
   * The three ways to reach us, gathered before they are drawn so the dots
   * between them can be. A separator rendered inside each item leaves a
   * trailing one on the last, and a company with no GSTIN on file would have
   * opened the line with one.
   */
  const contacts = [
    co.gstin ? { icon: ReceiptText, text: 'GSTIN ' + co.gstin } : null,
    co.phone ? { icon: Phone, text: co.phone } : null,
    co.email ? { icon: Mail, text: co.email } : null,
  ].filter(Boolean) as Array<{ icon: React.ElementType; text: string }>

  const showSignature = data.template?.showSignature !== false
  const hasNotes = Boolean(e.notes || e.terms)

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
            The name at 30px beside the mark, the address under it, and the
            three ways to reach us on one line with an icon each. Icons rather
            than the words "Phone" and "Email": they are read at a glance by
            somebody scanning a sheet for a number, and they cost no width.

            Each icon sits in a filled navy tile rather than standing as a
            hairline glyph. At 13px an outlined phone and an outlined envelope
            are the same smudge on a fax, and this line is the one somebody
            squints at. A filled tile survives the second photocopy. */}
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {co.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={co.logoUrl}
                    alt=""
                    style={{ height: 38, width: 'auto', objectFit: 'contain' }}
                  />
                ) : (
                  <Sprout size={34} style={{ color: '#2f9e7e' }} strokeWidth={1.8} />
                )}
                <h1
                  style={{
                    margin: 0,
                    fontSize: 30,
                    fontWeight: 700,
                    letterSpacing: -0.6,
                    color: NAVY,
                  }}
                >
                  {co.name}
                </h1>
              </div>
              {co.address && (
                <p style={{ margin: '11px 0 0', fontSize: 12.5, color: GREY, lineHeight: 1.55 }}>
                  {[co.address, co.city, co.state, co.pincode].filter(Boolean).join(', ')}
                </p>
              )}
              <div
                style={{
                  margin: '11px 0 0',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '6px 9px',
                  fontSize: 11.5,
                  color: GREY,
                }}
              >
                {contacts.map((c, i) => (
                  <span
                    key={c.text}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 9,
                      // An address or a GSTIN is one thing, and half of it on
                      // the next line is worse than the whole of it there.
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {i > 0 && <span style={{ color: RULE }}>·</span>}
                    <Contact icon={c.icon}>{c.text}</Contact>
                  </span>
                ))}
              </div>
            </div>

            {/* ── The document block ───────────────────────────────────────
              Which paper this is, and its five identifying facts. Alternating
              tints rather than rules between them: at five rows a ruled grid
              reads as a second table competing with the real one below.

              It floats on its own shadow rather than sitting in a box. The
              hairline border put a second frame a few pixels inside the card's
              own, which at the top corner of the sheet read as a misprint. */}
            <div
              style={{
                borderRadius: 9,
                // 272, not 300. The longest thing in it is a date, and the
                // 28px it was holding for nothing is 28px the contact line
                // needed to stay on one row.
                minWidth: 272,
                overflow: 'hidden',
                boxShadow: '0 4px 14px rgba(23, 58, 108, 0.13)',
              }}
            >
              <div
                style={{
                  background: NAVY,
                  color: '#fff',
                  padding: '9px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                }}
              >
                <FileText size={15} />
                Purchase Enquiry
              </div>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <tbody>
                  <MetaRow i={0} label="Enquiry No" value={e.enquiryNumber} mono />
                  <MetaRow i={1} label="Date" value={shortDate(e.enquiryDate)} mono />
                  <MetaRow
                    i={2}
                    label="Required by"
                    value={e.requiredDate ? shortDate(e.requiredDate) : '—'}
                    mono
                  />
                  {/* Which of the mill's stores it is for was here and is
                    not any more. It is ours, not his — he delivers where the
                    purchase order tells him to, and until there is an order
                    there is nothing to tell him. On a sheet that goes out it
                    was a fifth row saying nothing to the man reading it. */}
                  <MetaRow i={3} label="Reference" value={e.reference || '—'} mono />
                </tbody>
              </table>
            </div>
          </div>

          {/* The rule that separates who we are from what we are asking. */}
          <div style={{ height: 2, background: NAVY, margin: '22px 0 0', borderRadius: 2 }} />

          {/* ── Who it is to ───────────────────────────────────────────────
            Named where we are printing one supplier's copy, and a line to
            write a name on where we are not. The enquiry goes to three or
            four of them and is printed once; whoever it is handed to writes
            their own name on it, which is what an enquiry pad has always
            done. */}
          <Panel icon={Users} title="To">
            {forQuote ? (
              <div style={{ padding: '13px 16px' }}>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: NAVY }}>
                  {forQuote.supplier.name}
                </p>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: SOFT }}>
                  {forQuote.supplier.code}
                  {forQuote.supplier.gstin && ' · GSTIN ' + forQuote.supplier.gstin}
                </p>
              </div>
            ) : (
              <div style={{ padding: '14px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
                  <span style={{ fontSize: 13, color: GREY, flexShrink: 0 }}>M/s</span>
                  <span
                    style={{ flex: 1, borderBottom: '1px solid ' + RULE, height: 20 }}
                    aria-hidden
                  />
                </div>
                <p style={{ margin: '11px 0 0', fontSize: 11.5, color: GREY }}>
                  Kindly quote your best rate for the items below, and say how long you will hold
                  it.
                </p>
              </div>
            )}
          </Panel>

          {/* ── The line grid ────────────────────────────────────────────── */}
          <div
            style={{
              marginTop: 18,
              borderRadius: 10,
              overflow: 'hidden',
              border: '1px solid ' + RULE_SOFT,
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: NAVY, color: '#fff' }}>
                  <th style={{ padding: '11px 14px', textAlign: 'left', width: 46 }}>
                    <Rows3 size={15} style={{ display: 'block' }} />
                  </th>
                  <th style={{ padding: '11px 8px', textAlign: 'left', fontWeight: 600 }}>
                    Item &amp; Description
                  </th>
                  <th
                    style={{ padding: '11px 8px', textAlign: 'left', width: 82, fontWeight: 600 }}
                  >
                    HSN
                  </th>
                  <th
                    style={{ padding: '11px 8px', textAlign: 'right', width: 104, fontWeight: 600 }}
                  >
                    Quantity
                  </th>
                  <th
                    style={{ padding: '11px 8px', textAlign: 'right', width: 92, fontWeight: 600 }}
                  >
                    Rate
                  </th>
                  <th
                    style={{ padding: '11px 16px', textAlign: 'right', width: 74, fontWeight: 600 }}
                  >
                    GST %
                  </th>
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
                        borderBottom: '1px solid ' + RULE_SOFT,
                      }}
                    >
                      <td style={{ padding: '10px 14px', color: SOFT, ...NUM }}>{i + 1}</td>
                      <td style={{ padding: '10px 8px' }}>
                        <span style={{ fontWeight: 700, color: NAVY }}>{l.item.name}</span>
                        <span style={{ color: SOFT }}> · {l.item.code}</span>
                        {l.description && (
                          <div style={{ color: GREY, fontSize: 11, marginTop: 2 }}>
                            {l.description}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '10px 8px', color: SOFT, ...NUM }}>
                        {l.hsnCode ?? '—'}
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'right', ...NUM }}>
                        {qtyFmt(l.qty)}{' '}
                        <span style={{ color: GREY }}>{l.item.uom?.symbol ?? ''}</span>
                      </td>
                      {/* Left empty on the copy he has not answered yet — the
                        column is what he is being asked to fill in. Once his PI
                        is recorded the sheet reprints with his own figures, and
                        that is the version filed beside the order. */}
                      <td style={{ padding: '10px 8px', textAlign: 'right', color: GREY, ...NUM }}>
                        {ql?.quotedRate != null ? money(ql.quotedRate) : '—'}
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', color: GREY, ...NUM }}>
                        {ql?.gstRate != null ? Number(ql.gstRate) : '—'}
                      </td>
                    </tr>
                  )
                })}
                {/* Ruled blank rows to a minimum depth.
                  Every copy of this sheet is now a copy somebody is asked to
                  write rates into, and a two-line enquiry printed as a two-line
                  table reads as a torn-off stub. They were briefly held back
                  from the office copy, which was read rather than written on —
                  there is no office copy any more. */}
                {Array.from({ length: Math.max(0, 6 - e.lines.length) }).map((_, i) => (
                  <tr
                    key={'pad' + i}
                    style={{
                      background: (e.lines.length + i) % 2 ? TINT_SOFT : '#fff',
                      borderBottom: '1px solid ' + RULE_SOFT,
                    }}
                  >
                    <td style={{ padding: '10px 14px', color: SOFT, ...NUM }}>
                      {e.lines.length + i + 1}
                    </td>
                    <td colSpan={5} style={{ padding: '10px 8px' }}>
                      &nbsp;
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: TINT_SOFT, fontWeight: 700, color: NAVY }}>
                  <td colSpan={4} style={{ padding: '12px 10px', textAlign: 'right' }}>
                    {forQuote?.answered ? 'Total on PI ' + forQuote.piNumber : 'Your total'}
                  </td>
                  <td colSpan={2} style={{ padding: '12px 16px', textAlign: 'right', ...NUM }}>
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
            comparable. It is the point of the sheet, so it is on every copy
            of it. */}
          <Panel icon={Pencil} title="Your quotation">
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <tbody>
                <ReplyRow i={0} label="Your PI / quotation no." />
                <ReplyRow i={1} label="Price held until" />
                <ReplyRow i={2} label="Delivery in (days)" />
                <ReplyRow i={3} label="Payment terms" />
                <ReplyRow i={4} label="Freight / packing" />
              </tbody>
            </table>
          </Panel>

          {/* Said on the paper, not only on the screen. A supplier holding a
            sheet that looks like an order will treat it as one. */}
          <div
            style={{
              marginTop: 16,
              padding: '11px 16px',
              background: TINT_SOFT,
              border: '1px solid ' + RULE_SOFT,
              borderRadius: 10,
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              fontSize: 11.5,
              color: GREY,
            }}
          >
            <FileText size={15} style={{ marginTop: 1, flexShrink: 0, color: SOFT }} />
            <span>
              This is an enquiry, not a purchase order. It places no order and commits neither
              party. Please quote your rate, your GST and how long you will hold the price.
            </span>
          </div>

          {/* ── The foot ────────────────────────────────────────────────────
            What we said, and who signs it, on one row.
            They were stacked, which put 30px of nothing between a two-line
            note and the signature and left the sheet ending in a column of
            air. Side by side the note fills the width it has and the
            signature takes the corner it is going to be signed in. */}
          {(hasNotes || showSignature) && (
            <div
              style={{
                marginTop: 20,
                display: 'flex',
                gap: 32,
                alignItems: 'flex-start',
              }}
            >
              <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 24 }}>
                {e.notes && <Note icon={Pencil} title="Notes" body={e.notes} />}
                {e.terms && <Note icon={ReceiptText} title="Terms" body={e.terms} />}
              </div>

              {/* Both sides sign a sheet that is going out, because what comes
                back is his quotation and needs his name on it. Named where we
                know who he is, "For (supplier)" where we do not — a blank over
                the line is what he signs above either way. */}
              {showSignature && (
                <div style={{ display: 'flex', gap: 28, flexShrink: 0 }}>
                  <Sign
                    name={'For ' + (forQuote ? forQuote.supplier.name : 'the supplier')}
                    caption={'Signature & seal · Date'}
                  />
                  <Sign name={'For ' + co.name} caption="Authorised signatory" />
                </div>
              )}
            </div>
          )}

          {/* The number on the foot as well as the head. A sheet that comes
            back as a fax or a photograph of one page has to still say which
            enquiry it answers. */}
          <div
            style={{
              marginTop: 22,
              borderTop: '1px solid ' + RULE_SOFT,
              paddingTop: 8,
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
              fontSize: 10,
              color: SOFT,
            }}
          >
            <span>
              {e.enquiryNumber}
              {forQuote ? ' · ' + forQuote.supplier.name : ''}
            </span>
            <span>{data.template?.footerNote || co.name}</span>
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * One of the three ways to reach us, with its icon on a filled tile.
 *
 * Filled, not outlined: this line is the one somebody squints at on a faxed
 * or twice-photocopied sheet, and at 13px an outlined phone and an outlined
 * envelope are the same smudge. A solid tile keeps its shape.
 */
function Contact({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <span
        style={{
          width: 19,
          height: 19,
          borderRadius: 5,
          background: NAVY,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon size={11} color="#fff" strokeWidth={2.3} />
      </span>
      {children}
    </span>
  )
}

/**
 * A titled band, tinted through rather than ruled round.
 *
 * The tinted bar is what makes a section findable on a sheet that has four of
 * them. The icon is not decoration: at a glance it separates the people band
 * from the paperwork band without the reader having to start reading.
 *
 * The body carries the same tint at a quarter of the strength with white rows
 * floating on it, so the band and what it holds read as one panel. A white
 * body under a tinted bar read as a table that happened to have a coloured
 * strip above it.
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
        marginTop: 18,
        borderRadius: 10,
        overflow: 'hidden',
        background: TINT_SOFT,
        border: '1px solid ' + RULE_SOFT,
      }}
    >
      <div
        style={{
          background: TINT,
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: NAVY,
        }}
      >
        <Icon size={16} />
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
      <td style={{ padding: '7px 14px', color: GREY, whiteSpace: 'nowrap' }}>{label}</td>
      <td
        style={{
          padding: '7px 14px',
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
    <tr style={{ background: i % 2 ? 'rgba(255,255,255,0.45)' : '#fff' }}>
      <td
        style={{
          padding: '11px 16px',
          color: GREY,
          whiteSpace: 'nowrap',
          width: '38%',
          fontSize: 12,
        }}
      >
        {label}
      </td>
      <td style={{ padding: '11px 16px', borderBottom: '1px solid ' + RULE }}>&nbsp;</td>
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
    <div style={{ flex: 1, minWidth: 0 }}>
      <p
        style={{
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: NAVY,
        }}
      >
        <Icon size={16} />
        {title}
      </p>
      <p style={{ margin: '7px 0 0 24px', fontSize: 12, color: GREY, whiteSpace: 'pre-line' }}>
        {body}
      </p>
    </div>
  )
}

/** Somebody's name over the line they sign on. */
function Sign({ name, caption }: { name: string; caption: string }) {
  return (
    <div style={{ minWidth: 196, textAlign: 'right', fontSize: 11.5, color: GREY }}>
      <p style={{ margin: 0 }}>{name}</p>
      {/* The room to actually sign in. Any less and a signature runs over the
        line it is meant to sit on. */}
      <div style={{ height: 38 }} />
      <p style={{ margin: 0, borderTop: '1px solid ' + RULE, paddingTop: 6 }}>{caption}</p>
    </div>
  )
}
