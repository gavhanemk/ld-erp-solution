'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  FileText,
  Mail,
  MessageSquare,
  Phone,
  ReceiptText,
  Rows3,
  Sprout,
  Truck,
  Users,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'

/**
 * The printed return challan — the outward gate pass goods leave the mill on.
 *
 * Read by three people who want different things from it. The security gate
 * checks the vehicle and the count against it and signs it out. The driver
 * carries it with the goods, so it has to say who they are going to and why.
 * The supplier's store receives against it, and the value on it is what an
 * e-way bill is raised on. So: who it is from and to, how it is travelling,
 * what is on the vehicle and what it is worth, why it is going back, and a
 * signature for each hand it passes through.
 *
 * It is not the debit note. The money is settled separately, by accounts, on
 * the note this challan wrote — named at the foot, so the two can always be
 * matched up, and never printed as a claim here.
 *
 * Same palette and constants as the other purchase sheets. They share a look
 * because they share these values, not because they share a component.
 */

const NAVY = '#173a6c'
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

const money = (v: number | string) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const qtyFmt = (v: number | string) =>
  Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 })

const SHEET_CSS = `
  /* The toolbar's own styles, as every printed sheet carries them. Without
     them it shows as a run of unstyled words, and without .no-print it
     comes out on the paper. */
  .print-toolbar {
    display: flex; align-items: center; gap: 14px; max-width: 900px;
    margin: 0 auto 12px; padding: 8px 12px; background: #fff; border-radius: 8px;
    font: 13px Inter, system-ui, sans-serif; color: #1f2b3d;
  }
  .print-toolbar .tb-hint { color: #5a6880; font-size: 12px; margin-right: auto; }
  .print-toolbar .tb-btn {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
    border: 1px solid #aebfd6; border-radius: 6px; background: #fff; color: #173a6c;
    font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer;
  }
  .print-toolbar .tb-primary { background: #173a6c; border-color: #173a6c; color: #fff; }
  .prc-page {
    background: #e9eef6;
    background-image:
      radial-gradient(1100px 420px at -8% 26%, rgba(255, 255, 255, 0.8), transparent 62%),
      radial-gradient(900px 520px at 108% 6%, rgba(255, 255, 255, 0.55), transparent 58%);
    padding: 32px 16px 44px;
  }
  .prc-sheet {
    background: #fff;
    max-width: 900px;
    margin: 0 auto;
    border-radius: 16px;
    box-shadow: 0 18px 50px rgba(23, 58, 108, 0.14);
    padding: 34px 36px 30px;
  }
  @media print {
    .no-print { display: none !important; }
    html, body { background: #fff !important; }
    .prc-page { background: #fff; background-image: none; padding: 0; }
    .prc-sheet { box-shadow: none; border-radius: 0; max-width: none; padding: 0; }
    /* The navy head carries white column names. Without this a browser drops
       the fill when it prints and the headings print white on white. */
    .prc-sheet, .prc-sheet * {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    @page { margin: 14mm; }
  }
`

interface Line {
  id: string
  qty: string | number
  unitPrice: string | number
  gstRate: string | number
  remarks: string | null
  billLine: {
    hsnCode: string | null
    description: string | null
    grnLine: { grn: { grnNumber: string } } | null
  }
  item: { code: string; name: string; uom: { symbol: string } | null }
  warehouse: { name: string }
}

interface Challan {
  id: string
  returnNumber: string
  status: 'DISPATCHED' | 'CANCELLED'
  returnDate: string
  reasonLabel: string
  reasonNote: string | null
  vehicleNo: string | null
  transporterName: string | null
  lrNumber: string | null
  ewayBillNo: string | null
  driverName: string | null
  remarks: string | null
  cancelReason: string | null
  supplier: {
    code: string
    name: string
    gstin: string | null
    address: string | null
    city: string | null
    state: string | null
    pincode: string | null
    phone: string | null
  }
  bill: {
    billNumber: string
    supplierInvoiceNo: string | null
    supplierInvoiceDate: string | null
  }
  createdBy: { name: string }
  lines: Line[]
  debitNotes: Array<{ noteNumber: string; status: string }>
  taxableValue: number
  gstValue: number
  totalValue: number
}

interface PrintData {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; showSignature: boolean } | null
  challan: Challan
  totalInWords: string
}

export default function PurchaseReturnPrintPage() {
  const params = useParams<{ id: string }>()
  const [data, setData] = useState<PrintData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ data: PrintData }>('/purchase/returns/' + params.id + '/print')
        setData(res.data)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not build the sheet.')
      }
    })()
  }, [params.id])

  if (error) {
    return <p style={{ fontFamily: SANS, padding: 40, color: '#b91c1c' }}>{error}</p>
  }
  if (!data) {
    return <p style={{ fontFamily: SANS, padding: 40, color: GREY }}>Building the sheet…</p>
  }

  const c = data.challan
  const co = data.company
  const cancelled = c.status === 'CANCELLED'

  const contacts = [
    co.gstin ? { icon: ReceiptText, text: 'GSTIN ' + co.gstin } : null,
    co.phone ? { icon: Phone, text: co.phone } : null,
    co.email ? { icon: Mail, text: co.email } : null,
  ].filter(Boolean) as Array<{ icon: React.ElementType; text: string }>

  const supplierAddress = [
    c.supplier.address,
    c.supplier.city,
    c.supplier.state,
    c.supplier.pincode,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <>
      <style>{SHEET_CSS}</style>
      <div className="prc-page">
        <PrintToolbar
          backHref="/purchase/returns"
          backLabel="Returns"
          copies={1}
          fileName={c.returnNumber + ' ' + c.supplier.name}
        />
        <div className="prc-sheet" style={{ fontFamily: SANS, color: INK, position: 'relative' }}>
          {/* A cancelled challan still prints — the gate may need to see why a
            vehicle it signed out has no paper behind it any more — but it says
            so across the whole sheet, not in a corner. */}
          {cancelled && (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
                fontSize: 96,
                fontWeight: 800,
                color: 'rgba(185, 28, 28, 0.12)',
                transform: 'rotate(-24deg)',
                letterSpacing: 6,
              }}
            >
              CANCELLED
            </div>
          )}

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
                {contacts.map((ct, i) => (
                  <span
                    key={ct.text}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 9,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {i > 0 && <span style={{ color: RULE }}>·</span>}
                    <Contact icon={ct.icon}>{ct.text}</Contact>
                  </span>
                ))}
              </div>
            </div>

            <div
              style={{
                borderRadius: 9,
                minWidth: 280,
                overflow: 'hidden',
                boxShadow: '0 4px 14px rgba(23, 58, 108, 0.13)',
              }}
            >
              <div
                style={{
                  background: NAVY,
                  color: '#fff',
                  padding: '9px 14px',
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                  lineHeight: 1.35,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <FileText size={15} />
                  {data.template?.title || 'Purchase Return Challan'}
                </div>
                <div style={{ fontSize: 10.5, opacity: 0.8, marginLeft: 23 }}>
                  Outward gate pass
                </div>
              </div>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <tbody>
                  <MetaRow i={0} label="Challan No" value={c.returnNumber} mono />
                  <MetaRow i={1} label="Date" value={shortDate(c.returnDate)} mono />
                  <MetaRow i={2} label="Against our bill" value={c.bill.billNumber} mono />
                  <MetaRow
                    i={3}
                    label="Their bill no."
                    value={
                      (c.bill.supplierInvoiceNo ?? '—') +
                      (c.bill.supplierInvoiceDate
                        ? ' · ' + shortDate(c.bill.supplierInvoiceDate)
                        : '')
                    }
                    mono
                  />
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ height: 2, background: NAVY, margin: '22px 0 0', borderRadius: 2 }} />

          {/* ── To, and how ─────────────────────────────────────────────────
            Side by side: the address the goods are going to and the vehicle
            taking them are what the gate and the driver look for first, and
            neither should be below the fold of the other. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
              gap: 14,
            }}
          >
            <Panel icon={Users} title="Returned to">
              <div style={{ padding: '12px 16px 14px', fontSize: 12, lineHeight: 1.55 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: NAVY }}>
                  {c.supplier.name}
                </p>
                {supplierAddress && (
                  <p style={{ margin: '3px 0 0', color: GREY }}>{supplierAddress}</p>
                )}
                <p style={{ margin: '3px 0 0', color: SOFT }}>
                  {[
                    c.supplier.code,
                    c.supplier.gstin && 'GSTIN ' + c.supplier.gstin,
                    c.supplier.phone,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            </Panel>
            <Panel icon={Truck} title="Transport">
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <tbody>
                  <KV label="Vehicle no." value={c.vehicleNo} />
                  <KV label="Transporter" value={c.transporterName} />
                  <KV label="LR no." value={c.lrNumber} />
                  <KV label="E-way bill no." value={c.ewayBillNo} />
                  <KV label="Driver" value={c.driverName} last />
                </tbody>
              </table>
            </Panel>
          </div>

          {/* ── What is on the vehicle ──────────────────────────────────────
            With the godown each line left from, so the store keeper who
            loaded it and the gate who counts it are reading the same row, and
            the receipt it originally came in on, so the supplier's store can
            find it at their end. */}
          <Panel icon={Rows3} title="Goods returned" flush>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: NAVY, color: '#fff' }}>
                  <th style={{ ...TH, width: 34, paddingLeft: 16 }}>#</th>
                  <th style={TH}>Item &amp; Description</th>
                  <th style={{ ...TH, width: 64 }}>HSN</th>
                  <th style={{ ...TH, width: 110 }}>From godown</th>
                  <th style={{ ...TH, width: 90, textAlign: 'right' }}>Qty</th>
                  <th style={{ ...TH, width: 80, textAlign: 'right' }}>Rate</th>
                  <th style={{ ...TH, width: 54, textAlign: 'right' }}>GST %</th>
                  <th style={{ ...TH, width: 104, textAlign: 'right', paddingRight: 16 }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {c.lines.map((l, i) => (
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
                      {(l.billLine.description || l.remarks || l.billLine.grnLine) && (
                        <div style={{ color: GREY, fontSize: 10.5, marginTop: 2 }}>
                          {[
                            l.billLine.description,
                            l.remarks,
                            l.billLine.grnLine && 'received on ' + l.billLine.grnLine.grn.grnNumber,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      )}
                    </td>
                    <td style={{ ...TD, color: SOFT, ...NUM }}>{l.billLine.hsnCode ?? '—'}</td>
                    <td style={{ ...TD, color: GREY }}>{l.warehouse.name}</td>
                    <td style={{ ...TD, textAlign: 'right', ...NUM }}>
                      <span style={{ fontWeight: 700 }}>{qtyFmt(l.qty)}</span>{' '}
                      <span style={{ color: GREY }}>{l.item.uom?.symbol ?? ''}</span>
                    </td>
                    <td style={{ ...TD, textAlign: 'right', color: GREY, ...NUM }}>
                      {money(l.unitPrice)}
                    </td>
                    <td style={{ ...TD, textAlign: 'right', color: GREY, ...NUM }}>
                      {Number(l.gstRate)}
                    </td>
                    <td style={{ ...TD, paddingRight: 16, textAlign: 'right', ...NUM }}>
                      {money(Number(l.qty) * Number(l.unitPrice))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <FootRow label="Taxable value" value={c.taxableValue} />
                <FootRow label="GST" value={c.gstValue} />
                <FootRow label="Value of goods returned" value={c.totalValue} strong />
              </tfoot>
            </table>
          </Panel>
          <p style={{ margin: '6px 2px 0', fontSize: 11, color: GREY }}>
            <span style={{ fontWeight: 600, color: NAVY }}>In words:</span> {data.totalInWords}
          </p>

          {/* ── Why ───────────────────────────────────────────────────────── */}
          <Panel icon={MessageSquare} title="Reason for return">
            <div style={{ padding: '11px 16px 13px', fontSize: 12, lineHeight: 1.55 }}>
              <p style={{ margin: 0, fontWeight: 700, color: NAVY }}>{c.reasonLabel}</p>
              {c.reasonNote && <p style={{ margin: '2px 0 0', color: GREY }}>{c.reasonNote}</p>}
              {c.remarks && (
                <p style={{ margin: '6px 0 0', color: GREY, whiteSpace: 'pre-line' }}>
                  {c.remarks}
                </p>
              )}
              {cancelled && c.cancelReason && (
                <p style={{ margin: '6px 0 0', color: '#b91c1c' }}>Cancelled: {c.cancelReason}</p>
              )}
            </div>
          </Panel>

          {/* The declaration a return challan carries: these goods are going
            back, they are not being sold. A driver stopped on the road with
            goods and no invoice is asked exactly that. */}
          <div
            style={{
              marginTop: 14,
              padding: '10px 16px',
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
              Goods returned to the supplier for the reason stated above. Not a sale. The value
              shown is for transport and e-way bill purposes; the amount is settled separately on
              debit note{' '}
              <strong style={{ color: NAVY }}>
                {c.debitNotes.map((n) => n.noteNumber).join(', ') || '—'}
              </strong>
              .
            </span>
          </div>

          {/* ── Four hands ──────────────────────────────────────────────────
            Whoever loaded it, the gate that let it out, the driver or
            supplier who took it, and the mill's authority. A gate pass with
            one signature on it is a gate pass anybody could have written. */}
          {data.template?.showSignature !== false && (
            <div
              style={{
                marginTop: 30,
                display: 'grid',
                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                gap: 22,
              }}
            >
              <Sign name="Prepared by" caption={c.createdBy.name} />
              <Sign name="Checked out by" caption="Security · Time" />
              <Sign name="Received by" caption="Driver / supplier" />
              <Sign name={'For ' + co.name} caption="Authorised signatory" />
            </div>
          )}

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
              {c.returnNumber} · {c.supplier.name} · against {c.bill.billNumber}
            </span>
            <span>{data.template?.footerNote || co.name}</span>
          </div>
        </div>
      </div>
    </>
  )
}

const TH: React.CSSProperties = { padding: '10px 8px', textAlign: 'left', fontWeight: 600 }
const TD: React.CSSProperties = { padding: '10px 8px', verticalAlign: 'top' }

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

/** A transport fact, or a line to write it on where it was not typed. */
function KV({
  label,
  value,
  last = false,
}: {
  label: string
  value: string | null
  last?: boolean
}) {
  return (
    <tr style={{ borderBottom: last ? 'none' : '1px solid ' + RULE_SOFT }}>
      <td style={{ padding: '7px 16px', color: GREY, whiteSpace: 'nowrap', width: '40%' }}>
        {label}
      </td>
      <td style={{ padding: '7px 16px', fontWeight: 600, color: NAVY, fontFamily: 'monospace' }}>
        {value || (
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: '80%',
              borderBottom: '1px solid ' + RULE,
              height: 12,
            }}
          />
        )}
      </td>
    </tr>
  )
}

function FootRow({
  label,
  value,
  strong = false,
}: {
  label: string
  value: number
  strong?: boolean
}) {
  return (
    <tr
      style={{
        background: strong ? TINT : TINT_SOFT,
        borderTop: '1px solid ' + RULE_SOFT,
        color: NAVY,
        fontWeight: strong ? 700 : 500,
      }}
    >
      <td colSpan={7} style={{ padding: '8px 8px', textAlign: 'right' }}>
        {label}
      </td>
      <td style={{ padding: '8px 16px', textAlign: 'right', ...NUM }}>₹{money(value)}</td>
    </tr>
  )
}

function Sign({ name, caption }: { name: string; caption: string }) {
  return (
    <div style={{ fontSize: 11.5, color: GREY }}>
      <p style={{ margin: 0 }}>{name}</p>
      <div style={{ height: 38 }} />
      <p style={{ margin: 0, borderTop: '1px solid ' + RULE, paddingTop: 6 }}>{caption}</p>
    </div>
  )
}
