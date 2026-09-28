'use client'

import { Fragment, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { Sprout } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { qty as qtyFmt, type EnquiryRecord } from '@/components/purchase/enquiryTypes'

/**
 * The printed purchase requisition — what the mill sends each supplier.
 *
 * Laid out on the sheet the group already sends from its other system, so a
 * supplier who has dealt with Linkd sees a document he recognises: logo at the
 * head, the title, a strip of numbers, the vendor, bill-to and ship-to, the
 * lines, and who prepared it. The one difference is that there are no rates
 * — this asks for a price rather than naming one. The supplier answers with a
 * proforma invoice quoting our requisition number, that PI is recorded in the
 * app against the requisition, and the order is raised against it.
 *
 * One requisition is sent to several suppliers, and each copy is addressed to
 * its own: the Vendor block carries that supplier's name and address. So the
 * sheet prints one page per supplier asked, in the order they were added.
 * `?quote=<id>` prints just the one — the printer icon on his card.
 *
 * What it never carries is who else was asked or what they said. Each page
 * names one supplier, and the comparison lives in the app.
 */

const NAVY = '#173a6c'
/** The panel bands and table head — the navy a shade lifted, as the reference has it. */
const BAND = '#1c4580'
const TINT = '#eef3fa'
const TINT_SOFT = '#f6f9fd'
const INK = '#1f2b3d'
const GREY = '#4a5870'
const MUTED = '#6b7a91'
const RULE = '#c9d4e3'

const SANS = 'var(--font-inter), Inter, system-ui, sans-serif'

const NUM: React.CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  fontFeatureSettings: '"tnum" 1',
}

const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

/*
 * Screen and paper are not the same sheet.
 *
 * On screen each copy is a card on a tinted ground, stacked with a gap, so it
 * is obvious there are three of them. On paper each copy starts a new page,
 * and the card, its shadow and the ground all go. The filled bands are told
 * to print as filled — a browser drops backgrounds by default, and the white
 * headings in them would print white on white.
 */
const SHEET_CSS = `
  .req-page { background: #e9eef6; padding: 32px 16px 44px; }
  .req-sheet {
    background: #fff;
    max-width: 820px;
    margin: 0 auto;
    box-shadow: 0 18px 50px rgba(23, 58, 108, 0.14);
    padding: 0 40px 28px;
    border-top: 5px solid ${NAVY};
  }
  .req-sheet + .req-sheet { margin-top: 32px; }
  .req-sheet, .req-sheet * {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  @media print {
    .req-page { background: #fff; padding: 0; }
    .req-sheet { box-shadow: none; max-width: none; padding: 0 0 12px; }
    .req-sheet + .req-sheet { margin-top: 0; break-before: page; page-break-before: always; }
    @page { margin: 12mm; }
  }
`

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
  forQuoteId: string | null
  recipients: Recipient[]
  shipTo: { name: string; address: string | null } | null
  preparedBy: { name: string; phone: string | null; email: string | null } | null
}

export default function PurchaseRequisitionPrintPage() {
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
  // With nobody asked yet, one unaddressed copy rather than none at all.
  const copies: Array<Recipient | null> = data.recipients.length ? data.recipients : [null]
  const single = data.recipients.length === 1 ? data.recipients[0] : null

  return (
    <>
      <style>{SHEET_CSS}</style>
      <PrintToolbar
        backHref="/purchase/enquiries"
        backLabel="Enquiries"
        copies={copies.length}
        fileName={'Requisition ' + e.enquiryNumber + (single ? ' ' + single.name : '')}
      />
      <div className="req-page">
        {copies.map((r, i) => (
          <Fragment key={r?.quoteId ?? i}>
            <Sheet data={data} to={r} />
          </Fragment>
        ))}
      </div>
    </>
  )
}

/** One supplier's copy. */
function Sheet({ data, to }: { data: PrintData; to: Recipient | null }) {
  const e = data.enquiry
  const co = data.company
  const prep = data.preparedBy

  const companyCity = [co.city, co.state].filter(Boolean).join(', ')
  const companyTail = [companyCity, co.pincode].filter(Boolean).join(' - ')

  return (
    <div className="req-sheet" style={{ fontFamily: SANS, color: INK }}>
      {/* ── The head ─────────────────────────────────────────────────────────
        The mark centred on a navy arc, the way the group's sheets open. The
        arc is drawn, not an image, so it prints crisp at any size and in the
        mill's own navy. */}
      <div style={{ position: 'relative', height: 118, textAlign: 'center' }}>
        <svg
          viewBox="0 0 400 60"
          preserveAspectRatio="none"
          aria-hidden
          style={{
            position: 'absolute',
            left: '50%',
            top: 0,
            transform: 'translateX(-50%)',
            width: 300,
            height: 58,
          }}
        >
          <path d="M0 0 H400 C340 0 300 58 200 58 C100 58 60 0 0 0 Z" fill={NAVY} />
        </svg>
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 16,
            transform: 'translateX(-50%)',
            width: 76,
            height: 76,
            borderRadius: '50%',
            background: '#fff',
            border: '3px solid ' + NAVY,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          {co.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={co.logoUrl}
              alt={co.name ?? ''}
              style={{ maxWidth: 58, maxHeight: 58, objectFit: 'contain' }}
            />
          ) : (
            <Sprout size={34} style={{ color: '#2f9e7e' }} strokeWidth={1.8} />
          )}
        </div>
        <p
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            margin: 0,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 2,
            textTransform: 'uppercase',
            color: NAVY,
          }}
        >
          {co.name}
        </p>
      </div>

      <div style={{ height: 1.5, background: NAVY, margin: '14px 0 0' }} />

      <h1
        style={{
          margin: '18px 0 16px',
          textAlign: 'center',
          fontSize: 26,
          fontWeight: 800,
          letterSpacing: 3,
          color: NAVY,
        }}
      >
        PURCHASE REQUISITION
      </h1>

      {/* ── The numbers ──────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          background: TINT_SOFT,
          border: '1px solid ' + RULE,
          borderRadius: 4,
        }}
      >
        <Stat label="Requisition No" value={e.enquiryNumber} />
        <Stat label="Reference" value={e.reference || '—'} />
        <Stat label="Date" value={longDate(e.enquiryDate)} />
        <Stat label="Required by" value={e.requiredDate ? longDate(e.requiredDate) : '—'} last />
      </div>

      {/* ── Vendor ─────────────────────────────────────────────────────────
        This copy's supplier, in full — the only part of the sheet that
        differs between copies. */}
      <Box title="Vendor" style={{ marginTop: 14 }}>
        {to ? (
          <>
            <p
              style={{
                margin: 0,
                fontSize: 15,
                fontWeight: 600,
                color: NAVY,
                textTransform: 'uppercase',
                letterSpacing: 0.3,
              }}
            >
              {to.name}
            </p>
            <div style={{ marginTop: 7, fontSize: 11.5, lineHeight: 1.65, color: GREY }}>
              {to.phone && <div>{to.phone}</div>}
              {to.email && <div>{to.email}</div>}
              {to.address && <div style={{ marginTop: 4 }}>{to.address}</div>}
              {(to.city || to.state || to.pincode) && (
                <div>
                  {[to.city, [to.state, to.pincode].filter(Boolean).join(' - ')]
                    .filter(Boolean)
                    .join(', ')}
                </div>
              )}
              {to.gstin && (
                <div style={{ marginTop: 4 }}>
                  GSTIN {to.gstin}
                  {to.stateCode ? ' · State code ' + to.stateCode : ''}
                </div>
              )}
            </div>
          </>
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: MUTED }}>
            No supplier has been added to this requisition yet.
          </p>
        )}
      </Box>

      {/* ── Bill to, ship to ────────────────────────────────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: 12,
          marginTop: 12,
        }}
      >
        <Box title="Bill to">
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: NAVY }}>
            {co.legalName || co.name}
          </p>
          <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.6, color: GREY }}>
            {co.address && <div>{co.address}</div>}
            {companyTail && <div>{companyTail}</div>}
            {co.gstin && (
              <div style={{ marginTop: 4 }}>
                GSTIN {co.gstin}
                {co.stateCode ? ' · State code ' + co.stateCode : ''}
              </div>
            )}
          </div>
        </Box>
        <Box title="Ship to">
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: NAVY }}>
            {co.name}
            {data.shipTo ? ` (${data.shipTo.name})` : ''}
          </p>
          <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.6, color: GREY }}>
            {data.shipTo?.address && <div>{data.shipTo.address}</div>}
            {co.address && <div>{co.address}</div>}
            {companyTail && <div>{companyTail}</div>}
            {co.gstin && (
              <div>
                GSTIN {co.gstin}
                {co.stateCode ? ' · State code ' + co.stateCode : ''}
              </div>
            )}
            {(prep || co.email) && (
              <div style={{ marginTop: 4 }}>
                {[prep?.name, prep?.phone || co.phone, prep?.email || co.email]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
          </div>
        </Box>
      </div>

      {/* ── The lines ──────────────────────────────────────────────────────
        As the reference lays them out, without the rate and amount: those
        come back on his PI. */}
      <div
        style={{
          marginTop: 14,
          border: '1px solid ' + RULE,
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
          <thead>
            <tr style={{ background: BAND, color: '#fff' }}>
              <th style={{ ...TH, width: 52, textAlign: 'center' }}>S.No</th>
              <th style={{ ...TH, width: 120 }}>SKU</th>
              <th style={TH}>Item Description</th>
              <th style={{ ...TH, width: 60 }}>HSN</th>
              <th style={{ ...TH, width: 90, textAlign: 'right' }}>Qty</th>
              <th style={{ ...TH, width: 64, paddingRight: 14 }}>Unit</th>
            </tr>
          </thead>
          <tbody>
            {e.lines.map((l, i) => (
              <tr key={l.id} style={{ borderTop: i ? '1px solid ' + RULE : 'none' }}>
                <td style={{ ...TD, textAlign: 'center', color: GREY, ...NUM }}>{i + 1}</td>
                <td style={{ ...TD, color: GREY }}>{l.item.code}</td>
                <td style={TD}>
                  <span style={{ fontWeight: 700, color: INK }}>{l.item.name}</span>
                  {l.description && (
                    <div style={{ color: MUTED, fontSize: 10.5, marginTop: 2 }}>
                      {l.description}
                    </div>
                  )}
                </td>
                <td style={{ ...TD, color: GREY, ...NUM }}>{l.hsnCode ?? '—'}</td>
                <td style={{ ...TD, textAlign: 'right', fontWeight: 600, ...NUM }}>
                  {qtyFmt(l.qty)}
                </td>
                <td style={{ ...TD, paddingRight: 14, color: GREY }}>
                  {l.item.uom?.symbol ?? '—'}
                </td>
              </tr>
            ))}
            {/* Where the reference says rates include tax, this says what his
              PI has to carry — the one thing without which his reply cannot
              be recorded against this sheet or compared with the others. */}
            <tr style={{ borderTop: '1px solid ' + RULE, background: TINT_SOFT }}>
              <td
                colSpan={6}
                style={{
                  padding: '8px 14px',
                  fontSize: 10.5,
                  fontStyle: 'italic',
                  color: MUTED,
                  lineHeight: 1.5,
                }}
              >
                Please send your proforma invoice quoting our requisition no. showing rate per unit,
                GST %, freight &amp; packing, delivery time, payment terms and how long the price
                holds.
              </td>
            </tr>
          </tbody>
        </table>
        {/* The band the reference gives the grand total. Here it carries the
          number his PI must quote, because that is what matches the two. */}
        <div
          style={{
            background: NAVY,
            color: '#fff',
            padding: '13px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6 }}>
            QUOTE THIS NUMBER ON YOUR PI
          </span>
          <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: 0.5, ...NUM }}>
            {e.enquiryNumber}
          </span>
        </div>
      </div>

      {(e.notes || e.terms) && (
        <div style={{ marginTop: 14, fontSize: 11.5, color: GREY, lineHeight: 1.55 }}>
          {e.notes && (
            <p style={{ margin: 0, whiteSpace: 'pre-line' }}>
              <strong style={{ color: NAVY }}>Notes: </strong>
              {e.notes}
            </p>
          )}
          {e.terms && (
            <p style={{ margin: e.notes ? '4px 0 0' : 0, whiteSpace: 'pre-line' }}>
              <strong style={{ color: NAVY }}>Terms: </strong>
              {e.terms}
            </p>
          )}
        </div>
      )}

      {/* ── Who prepared it, who signs ─────────────────────────────────────── */}
      <div
        style={{
          marginTop: 24,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 40,
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 0.6,
          color: GREY,
          textTransform: 'uppercase',
        }}
      >
        <span>Prepared by</span>
        {data.template?.showSignature !== false && <span>Authorised signatory</span>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 40 }}>
        <div style={{ flex: 1, maxWidth: 300 }}>
          <div style={{ height: 30, borderBottom: '1px solid ' + RULE }} />
          {prep && (
            <>
              <p style={{ margin: '10px 0 0', fontSize: 16, fontWeight: 600, color: NAVY }}>
                {prep.name}
              </p>
              <p style={{ margin: '2px 0 0', fontSize: 10.5, color: MUTED }}>
                {[prep.phone, prep.email].filter(Boolean).join(' | ')}
              </p>
            </>
          )}
        </div>
        {data.template?.showSignature !== false && (
          <div style={{ flex: 1, maxWidth: 220 }}>
            <div style={{ height: 30, borderBottom: '1px solid ' + RULE }} />
            <p style={{ margin: '10px 0 0', fontSize: 10.5, color: MUTED, textAlign: 'right' }}>
              For {co.name}
            </p>
          </div>
        )}
      </div>

      {/* ── The foot ───────────────────────────────────────────────────────── */}
      <div
        style={{
          marginTop: 18,
          background: TINT,
          borderRadius: 4,
          padding: '10px 14px',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: 16,
          fontSize: 10,
          color: GREY,
          lineHeight: 1.5,
        }}
      >
        <span>
          This is a computer generated document and does not require a physical signature. It is a
          requisition, not a purchase order.
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
  )
}

const TH: React.CSSProperties = {
  padding: '9px 8px',
  textAlign: 'left',
  fontWeight: 700,
  fontSize: 10.5,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
}

const TD: React.CSSProperties = { padding: '10px 8px', verticalAlign: 'top' }

/** A cell in the numbers strip. */
function Stat({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <div style={{ padding: '9px 12px', borderRight: last ? 'none' : '1px solid ' + RULE }}>
      <p
        style={{
          margin: 0,
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: MUTED,
        }}
      >
        {label}
      </p>
      <p style={{ margin: '3px 0 0', fontSize: 13, fontWeight: 700, color: NAVY, ...NUM }}>
        {value}
      </p>
    </div>
  )
}

/** A panel with a navy title band, as the reference draws Vendor, Bill To and Ship To. */
function Box({
  title,
  children,
  style,
}: {
  title: string
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div
      style={{
        border: '1px solid ' + RULE,
        borderRadius: 4,
        overflow: 'hidden',
        ...style,
      }}
    >
      <div
        style={{
          background: BAND,
          color: '#fff',
          padding: '7px 14px',
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
        }}
      >
        {title}
      </div>
      <div style={{ padding: '11px 14px 13px' }}>{children}</div>
    </div>
  )
}
