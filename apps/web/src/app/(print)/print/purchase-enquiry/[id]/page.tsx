'use client'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import {
  Building2,
  ClipboardList,
  FileText,
  Mail,
  Pencil,
  Phone,
  ReceiptText,
  Rows3,
  Sprout,
  Truck,
  Users,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { qty as qtyFmt, type EnquiryRecord } from '@/components/purchase/enquiryTypes'

/**
 * The printed purchase requisition — what the mill sends a supplier.
 *
 * In the mill's own sheet style — the letterhead, the navy document block,
 * tinted panels — carrying what the group's purchase order sheet carries: the
 * vendor with his address, bill-to and ship-to, the lines by SKU, who prepared
 * it and who to call. No rates: this asks for a price. The supplier answers
 * with a proforma invoice quoting our requisition number, the PI is recorded
 * in the app against the requisition, and the order is raised against it.
 *
 * One sheet. A requisition goes to several suppliers, and the Vendor block
 * names one of them — which one is picked in a bar above the sheet that never
 * prints. Pick a supplier, print, pick the next, print again: the same
 * template, each copy carrying its own supplier's address. `?quote=<id>`
 * opens with that supplier already picked, which is what the printer icon on
 * a supplier's card does.
 *
 * What it never carries is who else was asked or what they said.
 */

const NAVY = '#173a6c'
/**
 * The navy stepped back, for the second thing in a cell — an item code beside
 * a name, a GSTIN under an address. In grey they read as disabled.
 */
const SOFT = '#4f7ba8'
const TINT = '#e9eff8'
const TINT_SOFT = '#f4f7fc'
const INK = '#1f2b3d'
const GREY = '#44536b'
const RULE = '#b9c4d4'
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
 * On screen the sheet is a card on a tinted ground, with the toolbar and the
 * vendor picker above it. On paper the card, its shadow, the ground, the
 * toolbar and the picker all go, and the filled bands are told to print as
 * filled — a browser drops backgrounds by default, and the white column names
 * on the navy head would print white on white.
 *
 * The toolbar's own styles live here, as they do on every other printed
 * sheet. This page was missing them, which is why its toolbar showed as a
 * run of unstyled words — and, without `.no-print`, would have come out on
 * the paper.
 */
const SHEET_CSS = `
  .print-toolbar {
    display: flex;
    align-items: center;
    gap: 14px;
    max-width: 900px;
    margin: 0 auto 10px;
    padding: 8px 12px;
    background: #fff;
    border-radius: 8px;
    font: 13px Inter, system-ui, sans-serif;
    color: #1f2b3d;
  }
  .print-toolbar .tb-hint { color: #5a6880; font-size: 12px; margin-right: auto; }
  .print-toolbar .tb-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid #aebfd6;
    border-radius: 6px;
    background: #fff;
    color: #173a6c;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
  }
  .print-toolbar .tb-primary { background: #173a6c; border-color: #173a6c; color: #fff; }

  .req-page {
    background: #e9eef6;
    background-image:
      radial-gradient(1100px 420px at -8% 26%, rgba(255, 255, 255, 0.8), transparent 62%),
      radial-gradient(900px 520px at 108% 6%, rgba(255, 255, 255, 0.55), transparent 58%);
    min-height: 100vh;
    padding: 20px 16px 44px;
  }
  .req-picker {
    max-width: 900px;
    margin: 0 auto 14px;
    padding: 10px 14px;
    background: #fff;
    border: 1px solid #c9d6e8;
    border-radius: 8px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    font: 13px Inter, system-ui, sans-serif;
    color: #1f2b3d;
  }
  .req-picker select {
    font: inherit;
    padding: 6px 10px;
    border: 1px solid #aebfd6;
    border-radius: 6px;
    background: #fff;
    color: #173a6c;
    font-weight: 600;
    min-width: 240px;
  }
  .req-picker .hint { color: #5a6880; font-size: 12px; }
  .req-sheet {
    background: #fff;
    max-width: 900px;
    margin: 0 auto;
    border-radius: 16px;
    box-shadow: 0 18px 50px rgba(23, 58, 108, 0.14);
    padding: 34px 36px 30px;
  }
  .req-sheet, .req-sheet * {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  @media print {
    .no-print { display: none !important; }
    html, body { background: #fff !important; }
    .req-page { background: #fff; background-image: none; padding: 0; min-height: 0; }
    .req-sheet { box-shadow: none; border-radius: 0; max-width: none; padding: 0; }
    @page { margin: 12mm; }
  }
`

/**
 * What his proforma invoice should carry. A PI that comes back with a rate
 * and nothing else cannot be compared with the others: one is ex-works, one
 * delivered, one has buried the freight.
 */
const PI_MUST_SHOW = [
  'Rate per unit, for each item',
  'GST %',
  'Freight and packing, if extra',
  'Delivery time',
  'Payment terms',
  'How long the price holds',
]

interface Recipient {
  quoteId: string
  code: string
  name: string
  phone: string | null
  email: string | null
  gstin: string | null
  address: string | null
  city: string | null
  state: string | null
  stateCode: string | null
  pincode: string | null
}

interface PrintData {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; showSignature: boolean } | null
  enquiry: EnquiryRecord
  recipients: Recipient[]
  shipTo: { name: string; address: string | null } | null
  preparedBy: { name: string; phone: string | null; email: string | null } | null
}

export default function PurchaseRequisitionPrintPage() {
  const params = useParams<{ id: string }>()
  const search = useSearchParams()
  const wantedQuote = search.get('quote')

  const [data, setData] = useState<PrintData | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Which supplier the Vendor block names. */
  const [picked, setPicked] = useState<string>('')

  useEffect(() => {
    void (async () => {
      try {
        // Every supplier asked, always — the picker offers all of them, and
        // `?quote=` only decides which one it starts on.
        const res = await api.get<{ data: PrintData }>(
          '/purchase/enquiries/' + params.id + '/print'
        )
        setData(res.data)
        const start =
          res.data.recipients.find((r) => r.quoteId === wantedQuote) ?? res.data.recipients[0]
        setPicked(start?.quoteId ?? '')
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not build the sheet.')
      }
    })()
  }, [params.id, wantedQuote])

  if (error) {
    return <p style={{ fontFamily: SANS, padding: 40, color: '#b91c1c' }}>{error}</p>
  }
  if (!data) {
    return <p style={{ fontFamily: SANS, padding: 40, color: GREY }}>Building the sheet…</p>
  }

  const e = data.enquiry
  const co = data.company
  const to = data.recipients.find((r) => r.quoteId === picked) ?? null
  const prep = data.preparedBy
  const showSignature = data.template?.showSignature !== false

  const contacts = [
    co.gstin ? { icon: ReceiptText, text: 'GSTIN ' + co.gstin } : null,
    co.phone ? { icon: Phone, text: co.phone } : null,
    co.email ? { icon: Mail, text: co.email } : null,
  ].filter(Boolean) as Array<{ icon: React.ElementType; text: string }>

  const companyPlace = [[co.city, co.state].filter(Boolean).join(', '), co.pincode]
    .filter(Boolean)
    .join(' - ')
  const companyTax = co.gstin
    ? 'GSTIN ' + co.gstin + (co.stateCode ? ' · State code ' + co.stateCode : '')
    : null

  return (
    <>
      <style>{SHEET_CSS}</style>
      <div className="req-page">
        <PrintToolbar
          backHref="/purchase/enquiries"
          backLabel="Enquiries"
          copies={1}
          fileName={'Requisition ' + e.enquiryNumber + (to ? ' ' + to.name : '')}
        />

        {/* The only thing that changes between copies, chosen here and never
          printed. One supplier: nothing to choose, so it just says whose
          copy this is. */}
        {data.recipients.length > 0 && (
          <div className="req-picker no-print">
            <span style={{ fontWeight: 600 }}>Vendor on this sheet</span>
            {data.recipients.length > 1 ? (
              <select
                value={picked}
                onChange={(ev) => setPicked(ev.target.value)}
                aria-label="Supplier this copy is addressed to"
              >
                {data.recipients.map((r) => (
                  <option key={r.quoteId} value={r.quoteId}>
                    {r.name}
                  </option>
                ))}
              </select>
            ) : (
              <strong style={{ color: NAVY }}>{to?.name}</strong>
            )}
            <span className="hint">
              {data.recipients.length > 1
                ? `Asked ${data.recipients.length} suppliers — pick one, print, then pick the next. Each copy carries its own supplier's address.`
                : 'The Vendor block carries this supplier’s address.'}
            </span>
          </div>
        )}

        <div className="req-sheet" style={{ fontFamily: SANS, color: INK }}>
          {/* ── Letterhead and document block ─────────────────────────────── */}
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
                  <MetaRow
                    i={2}
                    label="Required by"
                    value={e.requiredDate ? shortDate(e.requiredDate) : '—'}
                    mono
                  />
                  <MetaRow i={3} label="Reference" value={e.reference || '—'} mono />
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ height: 2, background: NAVY, margin: '22px 0 0', borderRadius: 2 }} />

          {/* ── Vendor ─────────────────────────────────────────────────────── */}
          <Panel icon={Users} title="Vendor">
            <div style={{ padding: '12px 16px 14px', fontSize: 12, lineHeight: 1.6 }}>
              {to ? (
                <>
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: NAVY }}>{to.name}</p>
                  {to.address && <p style={{ margin: '3px 0 0', color: GREY }}>{to.address}</p>}
                  {(to.city || to.state || to.pincode) && (
                    <p style={{ margin: 0, color: GREY }}>
                      {[[to.city, to.state].filter(Boolean).join(', '), to.pincode]
                        .filter(Boolean)
                        .join(' - ')}
                    </p>
                  )}
                  <p style={{ margin: '3px 0 0', color: SOFT }}>
                    {[
                      to.phone,
                      to.email,
                      to.gstin &&
                        'GSTIN ' + to.gstin + (to.stateCode ? ' · State code ' + to.stateCode : ''),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </>
              ) : (
                <p style={{ margin: 0, color: GREY }}>
                  No supplier has been added to this requisition yet.
                </p>
              )}
            </div>
          </Panel>

          {/* ── Bill to, ship to ─────────────────────────────────────────────── */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
              gap: 14,
            }}
          >
            <Panel icon={Building2} title="Bill to">
              <div style={{ padding: '12px 16px 14px', fontSize: 12, lineHeight: 1.6 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: NAVY }}>
                  {co.legalName || co.name}
                </p>
                {co.address && <p style={{ margin: '3px 0 0', color: GREY }}>{co.address}</p>}
                {companyPlace && <p style={{ margin: 0, color: GREY }}>{companyPlace}</p>}
                {companyTax && <p style={{ margin: '3px 0 0', color: SOFT }}>{companyTax}</p>}
              </div>
            </Panel>
            <Panel icon={Truck} title="Ship to">
              <div style={{ padding: '12px 16px 14px', fontSize: 12, lineHeight: 1.6 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: NAVY }}>
                  {co.name}
                  {data.shipTo ? ' (' + data.shipTo.name + ')' : ''}
                </p>
                {data.shipTo?.address && (
                  <p style={{ margin: '3px 0 0', color: GREY }}>{data.shipTo.address}</p>
                )}
                {co.address && <p style={{ margin: 0, color: GREY }}>{co.address}</p>}
                {companyPlace && <p style={{ margin: 0, color: GREY }}>{companyPlace}</p>}
                {(prep || co.phone) && (
                  <p style={{ margin: '3px 0 0', color: SOFT }}>
                    {[prep?.name, prep?.phone || co.phone].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
            </Panel>
          </div>

          {/* ── The lines ──────────────────────────────────────────────────────
            By SKU, as the group's sheets list them. No rate or amount — those
            come back on his PI. */}
          <Panel icon={Rows3} title="Items required" flush>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: NAVY, color: '#fff' }}>
                  <th style={{ ...TH, width: 54, paddingLeft: 16 }}>S.No</th>
                  <th style={{ ...TH, width: 130 }}>SKU</th>
                  <th style={TH}>Item Description</th>
                  <th style={{ ...TH, width: 70 }}>HSN</th>
                  <th style={{ ...TH, width: 96, textAlign: 'right' }}>Qty</th>
                  <th style={{ ...TH, width: 66, paddingRight: 16 }}>Unit</th>
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
                    <td style={{ ...TD, color: SOFT, fontFamily: 'monospace' }}>{l.item.code}</td>
                    <td style={TD}>
                      <span style={{ fontWeight: 700, color: NAVY }}>{l.item.name}</span>
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

          {/* ── What we need back ──────────────────────────────────────────── */}
          <Panel icon={ClipboardList} title="Please send your proforma invoice (PI)">
            <div style={{ padding: '12px 16px 14px', fontSize: 12, color: INK }}>
              <p style={{ margin: 0 }}>
                Please send your proforma invoice for the items above, quoting our requisition no.{' '}
                <strong style={{ color: NAVY, fontFamily: 'monospace' }}>{e.enquiryNumber}</strong>.
                Your PI should show:
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

          {(e.notes || e.terms) && (
            <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
              {e.notes && <Note icon={Pencil} title="Notes" body={e.notes} />}
              {e.terms && <Note icon={ReceiptText} title="Terms" body={e.terms} />}
            </div>
          )}

          {/* ── Who prepared it, who signs ─────────────────────────────────── */}
          <div
            style={{
              marginTop: 24,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              gap: 40,
            }}
          >
            <div style={{ fontSize: 11.5, color: GREY }}>
              <p
                style={{
                  margin: 0,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.6,
                  textTransform: 'uppercase',
                  color: NAVY,
                }}
              >
                Prepared by
              </p>
              {prep && (
                <>
                  <p style={{ margin: '8px 0 0', fontSize: 15, fontWeight: 700, color: NAVY }}>
                    {prep.name}
                  </p>
                  <p style={{ margin: '2px 0 0', color: SOFT }}>
                    {[prep.phone, prep.email].filter(Boolean).join(' | ')}
                  </p>
                </>
              )}
            </div>
            {showSignature && (
              <div style={{ width: 230, textAlign: 'right', fontSize: 11.5, color: GREY }}>
                <p style={{ margin: 0 }}>For {co.name}</p>
                <div style={{ height: 38 }} />
                <p style={{ margin: 0, borderTop: '1px solid ' + RULE, paddingTop: 6 }}>
                  Authorised signatory
                </p>
              </div>
            )}
          </div>

          {/* ── The foot ───────────────────────────────────────────────────── */}
          <div
            style={{
              marginTop: 22,
              padding: '10px 14px',
              background: TINT_SOFT,
              border: '1px solid ' + RULE_SOFT,
              borderRadius: 10,
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
              gap: 18,
              fontSize: 10.5,
              color: GREY,
              lineHeight: 1.5,
            }}
          >
            <span>
              This is a computer generated document and does not require a physical signature. It is
              a requisition, not a purchase order.
            </span>
            <span>
              For queries contact: <strong style={{ color: NAVY }}>{prep?.name ?? co.name}</strong>
              {[prep?.phone || co.phone, prep?.email || co.email]
                .filter(Boolean)
                .map((x) => ' | ' + x)
                .join('')}
            </span>
          </div>
        </div>
      </div>
    </>
  )
}

const TH: React.CSSProperties = { padding: '10px 8px', textAlign: 'left', fontWeight: 600 }
const TD: React.CSSProperties = { padding: '10px 8px', verticalAlign: 'top' }

/** One of the three ways to reach us, its icon on a filled tile. */
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
 * A titled band, tinted through. `flush` drops the body's padding and tint,
 * for the item table whose own navy head sits directly under the bar.
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

/** A titled paragraph — notes, terms. */
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
