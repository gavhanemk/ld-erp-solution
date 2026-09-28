'use client'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import {
  ClipboardList,
  FileText,
  Mail,
  Pencil,
  Phone,
  ReceiptText,
  Rows3,
  Sprout,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { qty as qtyFmt, type EnquiryRecord } from '@/components/purchase/enquiryTypes'

/**
 * The printed purchase requisition — what the mill sends a supplier.
 *
 * The flow it serves: we send this, the supplier answers with a proforma
 * invoice on his own letterhead, and we record that PI in the app against the
 * requisition ("Record PI" on What Came Back). The purchase order is then
 * raised against his PI number.
 *
 * So this is a document to be READ, not filled in. It says who is asking,
 * what is wanted and how much, when it is needed, and exactly what his PI
 * should carry — and it asks him to quote our number on it, which is what
 * lets his reply be matched back to this sheet. It used to carry ruled blanks
 * for his name, his rates and his answers; nobody wrote on them, because the
 * answer always came back as his own PI, and a sheet of empty lines read as
 * a form somebody had forgotten to finish.
 *
 * One sheet for every supplier asked. `?quote=<id>` only adds a "To" line
 * naming the one it is printed for.
 *
 * What it never carries is who else was asked or what they said. That
 * comparison is the buyer's and lives in the app.
 *
 * The palette is the one the purchase order and the bill already print in —
 * navy masthead, tinted section bars, a filled navy line-grid head. They share
 * a look because they share these constants, not because they share a
 * component: each sheet's middle is too different to abstract.
 */

const NAVY = '#173a6c'
/**
 * The navy stepped back, for the second thing in a cell.
 *
 * An item code beside an item name, an HSN beside a quantity — each is a
 * qualifier on the thing before it, and in grey they read as disabled rather
 * than secondary. A lighter tone of the same blue keeps them part of the same
 * sentence.
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

/*
 * What his proforma invoice should carry.
 *
 * Spelled out because a PI that comes back with a rate and nothing else is
 * the commonest reason two suppliers cannot be compared: one is ex-works, one
 * is delivered, one has buried the freight, and the difference only surfaces
 * on the bill. Asking for each of these by name is what makes the replies
 * line up when they are recorded.
 */
const PI_MUST_SHOW = [
  'Rate per unit, for each item',
  'GST %',
  'Freight and packing, if extra',
  'Delivery time',
  'Payment terms',
  'How long the price holds',
]

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
  const neededBy = e.requiredDate ? shortDate(e.requiredDate) : null

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

  return (
    <>
      <style>{SHEET_CSS}</style>
      <PrintToolbar
        backHref="/purchase/enquiries"
        backLabel="Enquiries"
        copies={1}
        fileName={'Requisition ' + e.enquiryNumber + (forQuote ? ' ' + forQuote.supplier.name : '')}
      />

      <div className="enq-page">
        <div className="enq-sheet" style={{ fontFamily: SANS, color: INK }}>
          {/* ── Letterhead ─────────────────────────────────────────────────
            Who is asking. The name beside the mark, the address under it,
            and the three ways to reach us on one line, each on a filled tile
            that survives the second photocopy. */}
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
              Which paper this is, and the facts his PI has to quote back.
              "To" appears only on a copy printed for one supplier; the
              ordinary sheet goes to all of them unaddressed. */}
            <div
              style={{
                borderRadius: 9,
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
                Purchase Requisition
              </div>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <tbody>
                  <MetaRow i={0} label="Requisition No" value={e.enquiryNumber} mono />
                  <MetaRow i={1} label="Date" value={shortDate(e.enquiryDate)} mono />
                  <MetaRow i={2} label="Required by" value={neededBy ?? '—'} mono />
                  {forQuote && <MetaRow i={3} label="To" value={forQuote.supplier.name} />}
                </tbody>
              </table>
            </div>
          </div>

          {/* The rule that separates who we are from what we are asking. */}
          <div style={{ height: 2, background: NAVY, margin: '22px 0 0', borderRadius: 2 }} />

          {/* ── Items required ──────────────────────────────────────────────
            What we want and how much, in the unit we count it in — the unit
            in a column of its own, because a supplier pricing per metre
            against a quantity in rolls quotes the wrong unit. No rate column:
            his rates come back on his PI, not written into ours. */}
          <Panel icon={Rows3} title="Items required" flush>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: NAVY, color: '#fff' }}>
                  <th style={{ ...TH, width: 42, paddingLeft: 16 }}>#</th>
                  <th style={TH}>Item / Description</th>
                  <th style={{ ...TH, width: 90 }}>HSN</th>
                  <th style={{ ...TH, width: 110, textAlign: 'right' }}>Qty</th>
                  <th style={{ ...TH, width: 80, paddingRight: 16 }}>UOM</th>
                </tr>
              </thead>
              <tbody>
                {e.lines.map((l, i) => (
                  <tr
                    key={l.id}
                    style={{
                      background: i % 2 ? TINT_SOFT : '#fff',
                      borderTop: '1px solid ' + RULE_SOFT,
                    }}
                  >
                    <td style={{ ...TD, paddingLeft: 16, color: SOFT, ...NUM }}>{i + 1}</td>
                    <td style={TD}>
                      <span style={{ fontWeight: 700, color: NAVY }}>{l.item.name}</span>
                      <span style={{ color: SOFT }}> · {l.item.code}</span>
                      {l.description && (
                        <div style={{ color: GREY, fontSize: 11, marginTop: 2 }}>
                          {l.description}
                        </div>
                      )}
                    </td>
                    <td style={{ ...TD, color: SOFT, ...NUM }}>{l.hsnCode ?? '—'}</td>
                    <td style={{ ...TD, textAlign: 'right', fontWeight: 600, ...NUM }}>
                      {qtyFmt(l.qty)}
                    </td>
                    <td style={{ ...TD, paddingRight: 16, color: GREY }}>
                      {l.item.uom?.symbol ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          {/* ── What we need back ───────────────────────────────────────────
            The whole reason the sheet exists, said plainly: send a PI, quote
            our number on it, and put these on it. Quoting our number is what
            lets his PI be recorded against this requisition and the order be
            raised against his PI. */}
          <Panel icon={ClipboardList} title="Please send your proforma invoice (PI)">
            <div style={{ padding: '12px 16px 14px', fontSize: 12, color: INK }}>
              <p style={{ margin: 0 }}>
                Please send your proforma invoice for the items above, quoting our requisition no.{' '}
                <strong style={{ color: NAVY, fontFamily: 'monospace' }}>{e.enquiryNumber}</strong>
                {neededBy ? (
                  <>
                    {' '}
                    — the goods are required by <strong style={{ color: NAVY }}>{neededBy}</strong>
                  </>
                ) : null}
                . Your PI should show:
              </p>
              <ul
                style={{
                  margin: '9px 0 0',
                  padding: '0 0 0 18px',
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gap: '5px 20px',
                  color: GREY,
                }}
              >
                {PI_MUST_SHOW.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          </Panel>

          {/* ── Notes, and who signs ────────────────────────────────────────
            Our notes and terms on the left, our signature on the right, on
            one row. One signature: this is our request, and his answer
            comes back signed on his own PI. */}
          <div
            style={{
              marginTop: 18,
              display: 'flex',
              gap: 32,
              alignItems: 'flex-start',
            }}
          >
            <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 12 }}>
              <Note
                icon={Pencil}
                title="Notes"
                body={
                  e.notes ||
                  'Please quote ex-works / delivered basis and mention GST, freight, packing and applicable commercial terms separately.'
                }
              />
              {e.terms && <Note icon={ReceiptText} title="Terms" body={e.terms} />}
            </div>
            {showSignature && (
              <Sign name={'For ' + co.name} caption="Authorised signatory" align="right" />
            )}
          </div>

          {/* The number on the foot as well as the head, and what the paper
            is not. A sheet that comes back as a photograph of one page has to
            still say which enquiry it answers — and a supplier holding a
            sheet that looks like an order will treat it as one. */}
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
              {forQuote ? ' · ' + forQuote.supplier.name : ''} · A purchase requisition, not a
              purchase order
            </span>
            <span>{data.template?.footerNote || co.name}</span>
          </div>
        </div>
      </div>
    </>
  )
}

const TH: React.CSSProperties = {
  padding: '10px 8px',
  textAlign: 'left',
  fontWeight: 600,
}

const TD: React.CSSProperties = {
  padding: '10px 8px',
  verticalAlign: 'top',
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
 * The tinted bar is what makes a section findable on a sheet that has six of
 * them, and the icon separates them at a glance before anybody starts
 * reading. `flush` drops the body's padding, for the item table whose own
 * navy head sits directly under the bar.
 */
function Panel({
  icon: Icon,
  title,
  flush = false,
  children,
}: {
  icon: React.ElementType
  title: string
  flush?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        marginTop: 14,
        borderRadius: 10,
        overflow: 'hidden',
        background: flush ? '#fff' : TINT_SOFT,
        border: '1px solid ' + RULE_SOFT,
      }}
    >
      <div
        style={{
          background: TINT,
          padding: '9px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          fontSize: 11.5,
          fontWeight: 700,
          letterSpacing: 0.6,
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
    <div style={{ minWidth: 0 }}>
      <p
        style={{
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11.5,
          fontWeight: 700,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: NAVY,
        }}
      >
        <Icon size={15} />
        {title}
      </p>
      <p style={{ margin: '6px 0 0 23px', fontSize: 12, color: GREY, whiteSpace: 'pre-line' }}>
        {body}
      </p>
    </div>
  )
}

/** Somebody's name over the line they sign on. */
function Sign({
  name,
  caption,
  align,
}: {
  name: string
  caption: string
  align: 'left' | 'right'
}) {
  return (
    <div style={{ width: 230, textAlign: align, fontSize: 11.5, color: GREY }}>
      <p style={{ margin: 0 }}>{name}</p>
      {/* The room to actually sign in. Any less and a signature runs over the
        line it is meant to sit on. */}
      <div style={{ height: 40 }} />
      <p style={{ margin: 0, borderTop: '1px solid ' + RULE, paddingTop: 6 }}>{caption}</p>
    </div>
  )
}
