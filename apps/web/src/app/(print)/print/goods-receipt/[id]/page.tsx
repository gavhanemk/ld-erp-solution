'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'

/**
 * The printed goods receipt note.
 *
 * Built to the same sheet as the purchase order — same navy, same letterhead,
 * same rules — because they are two halves of one conversation with a supplier
 * and arriving in different clothes would make them look like they came from
 * different companies.
 *
 * The content follows the mill's old ERP, surveyed on 18 Sep 2026: three header
 * blocks (who it came from, the delivery, the order it answers), the items, the
 * money, and three signatures — Prepared By, Inspected By, Authorized By.
 *
 * Two deliberate departures from the old note, both because our receipt knows
 * more than theirs did:
 *
 * - **Rejected quantity is printed.** The old note showed only what was taken.
 *   A driver standing at the gate is owed a piece of paper saying what is
 *   going back on the lorry, and the store keeper is owed one saying why the
 *   figure is short.
 * - **The store is printed against each line.** One delivery can be split
 *   across godowns, and a note that does not say where the goods went is a
 *   note nobody can use to find them.
 *
 * Every figure is worked out by the API and laid out here. A sheet that does
 * its own arithmetic is a second implementation of the arithmetic, and the two
 * drift.
 */

// ─────────────────────────────────────────────────────────────
// The payload
// ─────────────────────────────────────────────────────────────

interface Company {
  name: string
  address: string | null
  city: string | null
  state: string | null
  pincode: string | null
  gstin: string | null
  pan: string | null
  phone: string | null
  email: string | null
  website: string | null
  logoUrl: string | null
}

interface GrnLine {
  id: string
  orderedQty: string
  receivedQty: string
  rejectedQty: string
  acceptedQty: string
  unitRate: string
  discountPct: number
  gstPct: number
  gross: number
  discountAmount: number
  taxable: number
  item: { code: string; name: string; hsnCode: string | null; uom: { symbol: string } | null }
  warehouse: { name: string } | null
  poLine: { description: string | null; hsnCode: string | null } | null
}

interface Payload {
  company: Company
  template: { title: string; footerNote: string | null; showAmountInWords: boolean }
  grn: {
    grnNumber: string
    grnDate: string
    vehicleNo: string | null
    notes: string | null
    gateEntryNo: string | null
    gateEntryDate: string | null
    challanNo: string | null
    challanDate: string | null
    supplierBillNo: string | null
    supplierInvoiceNo: string | null
    supplierInvoiceDate: string | null
    packageCount: number | null
    driverName: string | null
    formNo: string | null
    clientName: string | null
    orderedBy: string | null
    referenceNo: string | null
    createdBy: { name: string } | null
    po: {
      poNumber: string
      poDate: string
      supplier: {
        name: string
        address: string | null
        city: string | null
        state: string | null
        pincode: string | null
        gstin: string | null
        phone: string | null
      } | null
    }
    lines: GrnLine[]
  }
  totals: {
    subtotal: number
    discount: number
    taxable: number
    cgst: number
    sgst: number
    igst: number
    tax: number
    roundOff: number
    total: number
    rejectedQty: number
  }
  totalInWords: string
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
}

// ─────────────────────────────────────────────────────────────
// The sheet's palette — the purchase order's, exactly
// ─────────────────────────────────────────────────────────────

const NAVY = '#173a6c'
const TINT = '#e9eff8'
const TINT_SOFT = '#f4f7fc'
const INK = '#1f2b3d'
const GREY = '#44536b'
const MUTED = '#5a6880'
const RULE = '#aebfd6'
const RULE_SOFT = '#cdd9ea'
const RED = '#b3261e'

const SANS = 'var(--font-inter), Inter, system-ui, sans-serif'

/** Tabular figures of the body face, so columns line up without a code face. */
const NUM: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' }
const CODE: React.CSSProperties = { fontVariantNumeric: 'tabular-nums', letterSpacing: '.02em' }

const money = (v: number | string) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const qty = (v: number | string) => {
  const n = Number(v)
  return n.toLocaleString('en-IN', { maximumFractionDigits: 3 })
}

const longDate = (v: string | null) =>
  v
    ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : null

const dateTime = (v: string) =>
  new Date(v).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })

function Dash() {
  return <span style={{ color: RULE }}>—</span>
}

// ─────────────────────────────────────────────────────────────
// Pieces
// ─────────────────────────────────────────────────────────────

function Eyebrow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        fontSize: '9px',
        fontWeight: 700,
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: NAVY,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** A titled block: a tinted strip with the title, and the body under it. */
function Panel({
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
      style={{ border: `1px solid ${RULE}`, display: 'flex', flexDirection: 'column', ...style }}
    >
      <div style={{ background: TINT, borderBottom: `1px solid ${RULE}`, padding: '5.5px 10px' }}>
        <Eyebrow>{title}</Eyebrow>
      </div>
      <div style={{ padding: '7px 10px', flex: 1 }}>{children}</div>
    </div>
  )
}

/**
 * Label, colon, value — with the colon in a column of its own.
 *
 * The values have to line up under each other: this is where somebody looks to
 * quote a challan number back at a supplier, and a ragged column is one they
 * will read the wrong line of.
 */
function Fact({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', fontSize: '10px', lineHeight: 1.65 }}>
      <span style={{ color: GREY, width: '76px', flexShrink: 0 }}>{label}</span>
      <span style={{ color: MUTED, width: '9px', flexShrink: 0 }}>:</span>
      <span
        style={{
          color: INK,
          fontWeight: 600,
          minWidth: 0,
          wordBreak: 'break-word',
          ...(mono && value ? CODE : {}),
        }}
      >
        {value || <Dash />}
      </span>
    </div>
  )
}

/** One line of the letterhead's contact block. */
function HeadRow({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', lineHeight: 1.5 }}>
      <span style={{ fontSize: '9.5px', color: GREY, width: '52px', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '9.5px', color: MUTED, flexShrink: 0 }}>:</span>
      <span
        style={{ fontSize: '10.5px', fontWeight: 600, color: INK, ...(mono && value ? NUM : {}) }}
      >
        {value || <Dash />}
      </span>
    </div>
  )
}

function TotalRow({
  label,
  value,
  alt,
  strong,
}: {
  label: string
  value: string
  alt: boolean
  strong?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: '14px',
        padding: '3.5px 11px',
        background: alt ? TINT_SOFT : 'transparent',
        fontSize: '10.5px',
      }}
    >
      <span style={{ color: strong ? INK : GREY, fontWeight: strong ? 700 : 400 }}>{label}</span>
      <span style={{ color: INK, fontWeight: strong ? 700 : 600, ...NUM }}>{value}</span>
    </div>
  )
}

/*
 * The item table's columns.
 *
 * Eleven of them, and the four quantity columns are the reason this sheet
 * exists: ordered, arrived, rejected and into stock, side by side, so a short
 * or a refused delivery is a thing you can see rather than a subtraction you
 * have to do.
 */
const COLS = [
  { key: 'sn', head: 'S.N', width: '4%', align: 'center' as const },
  { key: 'code', head: 'Item Code', width: '12%', align: 'left' as const },
  { key: 'desc', head: 'Description', width: '25%', align: 'left' as const },
  { key: 'store', head: 'Store', width: '13%', align: 'left' as const },
  { key: 'uom', head: 'UOM', width: '5%', align: 'center' as const },
  { key: 'ord', head: 'Ordered', width: '7%', align: 'right' as const },
  { key: 'rec', head: 'Arrived', width: '7%', align: 'right' as const },
  { key: 'rej', head: 'Rejected', width: '7%', align: 'right' as const },
  { key: 'acc', head: 'Into stock', width: '7%', align: 'right' as const },
  { key: 'rate', head: 'Rate', width: '6%', align: 'right' as const },
  { key: 'amt', head: 'Amount (₹)', width: '7%', align: 'right' as const },
]

const SHEET_CSS = `
@page { size: A4; margin: 0; }

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

@media print {
  .no-print { display: none !important; }
  html, body { background: #fff !important; }
  /* 296, not 297 — a block exactly the height of the page box does not
     reliably fit inside it, and the rounded-up fraction becomes a blank
     second sheet. A minimum rather than a height, so a long receipt breaks
     visibly rather than being trimmed off where nobody will see it. */
  .grn-sheet { margin: 0 !important; box-shadow: none !important; min-height: 296mm !important; }
  .grn-sheet, .grn-sheet * {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
`

// ─────────────────────────────────────────────────────────────

export default function PrintGoodsReceipt() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: Payload }>(`/purchase/grn/${id}/print`)
      setData(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that goods receipt.')
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  if (error) {
    return (
      <div style={{ padding: '48px', fontFamily: SANS, color: INK }}>
        <p>{error}</p>
      </div>
    )
  }
  if (!data) {
    return (
      <div style={{ padding: '48px', fontFamily: SANS, color: MUTED }}>
        <p>Opening the receipt…</p>
      </div>
    )
  }

  const { company, template, grn, totals, taxMode } = data
  const supplier = grn.po.supplier

  const companyAddress = [company.address, company.city, company.state, company.pincode]
    .filter(Boolean)
    .join(', ')

  const supplierAddress = [supplier?.address, supplier?.city, supplier?.state, supplier?.pincode]
    .filter(Boolean)
    .join(', ')

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: SHEET_CSS }} />

      {/* No wrapper of our own here.

        The (print) layout already puts every sheet on a .print-surface, and
        that class is the one whose padding and grey backing are reset for the
        printer. A second padded wrapper inside it cannot be reset — its
        padding is inline — and those few millimetres are enough to push the
        bottom of the sheet onto a second piece of paper. Measured: it did
        exactly that, 2 pages for a two-line receipt. */}
      <PrintToolbar
        backHref="/purchase/grn"
        backLabel="Goods receipts"
        copies={1}
        fileName={grn.grnNumber}
      />

      <div
        className="grn-sheet"
        style={{
          width: '210mm',
          minHeight: '297mm',
          margin: '0 auto',
          background: '#fff',
          boxShadow: '0 2px 18px rgba(23,58,108,.16)',
          padding: '13mm 12mm 11mm',
          fontFamily: SANS,
          color: INK,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* ── Letterhead ─────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
          {company.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={company.logoUrl}
              alt=""
              style={{
                height: '52px',
                width: 'auto',
                maxWidth: '124px',
                objectFit: 'contain',
                flexShrink: 0,
              }}
            />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: '26px',
                fontWeight: 800,
                letterSpacing: '-.01em',
                textTransform: 'uppercase',
                lineHeight: 1.05,
                color: NAVY,
              }}
            >
              {company.name}
            </div>
            {companyAddress && (
              <div
                style={{
                  fontSize: '10.5px',
                  color: GREY,
                  lineHeight: 1.6,
                  marginTop: '4px',
                  maxWidth: '86%',
                }}
              >
                {companyAddress}
              </div>
            )}
          </div>
          <div style={{ flexShrink: 0 }}>
            <HeadRow label="Email" value={company.email} />
            <HeadRow label="Phone No" value={company.phone} mono />
            <HeadRow label="GST No" value={company.gstin} mono />
            <HeadRow label="PAN No" value={company.pan} mono />
          </div>
        </div>

        <div style={{ borderTop: `2.5px solid ${NAVY}`, marginTop: '7px' }} />

        {/* ── Title ──────────────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: '16px',
            padding: '5px 0 8px',
          }}
        >
          <div>
            <Eyebrow style={{ color: GREY }}>Document</Eyebrow>
            <div
              style={{
                fontSize: '25px',
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '-.015em',
                marginTop: '1px',
                color: NAVY,
                lineHeight: 1.1,
              }}
            >
              {template.title}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Eyebrow style={{ color: GREY }}>Received</Eyebrow>
            <div style={{ fontSize: '11px', fontWeight: 600, marginTop: '2px', ...NUM }}>
              {dateTime(grn.grnDate)}
            </div>
          </div>
        </div>

        {/* ── Three header blocks ────────────────────────────────────

            Who it came from, what the delivery was, and which order it
            answers. The mill's old note sets them out exactly this way, side
            by side, and it is the right way round: the question asked of a
            receipt six months later is almost always "which delivery was
            that" and the middle block answers it. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr 1fr', gap: '7px' }}>
          <Panel title="Received from">
            <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>
              {supplier?.name ?? 'Supplier not named'}
            </div>
            {supplierAddress && (
              <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>
                {supplierAddress}
              </div>
            )}
            <div style={{ marginTop: '5px' }}>
              <Fact label="GST No" value={supplier?.gstin ?? null} mono />
              <Fact label="Phone" value={supplier?.phone ?? null} mono />
            </div>
          </Panel>

          <Panel title="The delivery">
            <Fact label="GRN No" value={grn.grnNumber} mono />
            <Fact label="Gate entry" value={grn.gateEntryNo} mono />
            <Fact label="Gate date" value={longDate(grn.gateEntryDate)} />
            <Fact label="Challan No" value={grn.challanNo} mono />
            <Fact label="Challan date" value={longDate(grn.challanDate)} />
            <Fact
              label="Packages"
              value={grn.packageCount != null ? String(grn.packageCount) : null}
              mono
            />
            <Fact label="Vehicle No" value={grn.vehicleNo} mono />
            <Fact label="Driver" value={grn.driverName} />
          </Panel>

          <Panel title="Against">
            <Fact label="PO No" value={grn.po.poNumber} mono />
            <Fact label="PO date" value={longDate(grn.po.poDate)} />
            <Fact label="Bill No" value={grn.supplierInvoiceNo} mono />
            <Fact label="Bill date" value={longDate(grn.supplierInvoiceDate)} />
            <Fact label="Form No" value={grn.formNo} mono />
            <Fact label="Client" value={grn.clientName} />
            <Fact label="Ordered by" value={grn.orderedBy} />
            <Fact label="Reference" value={grn.referenceNo} mono />
          </Panel>
        </div>

        {/* ── The items ──────────────────────────────────────────── */}
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            marginTop: '8px',
            tableLayout: 'fixed',
          }}
        >
          <colgroup>
            {COLS.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr style={{ background: NAVY }}>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  style={{
                    padding: '5px',
                    fontSize: '8px',
                    fontWeight: 600,
                    letterSpacing: '.04em',
                    textTransform: 'uppercase',
                    color: '#fff',
                    textAlign: c.align,
                    border: `1px solid ${NAVY}`,
                  }}
                >
                  {c.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grn.lines.map((line, i) => {
              const rejected = Number(line.rejectedQty)
              const cell = (align: 'left' | 'right' | 'center'): React.CSSProperties => ({
                padding: '5px',
                fontSize: '9.5px',
                textAlign: align,
                border: `1px solid ${RULE_SOFT}`,
                verticalAlign: 'top',
                color: INK,
              })

              return (
                <tr key={line.id} style={{ background: i % 2 ? TINT_SOFT : '#fff' }}>
                  <td style={{ ...cell('center'), ...NUM }}>{i + 1}</td>
                  <td style={{ ...cell('left'), ...CODE }}>{line.item.code}</td>
                  <td style={cell('left')}>
                    <div style={{ fontWeight: 600 }}>{line.item.name}</div>
                    {line.poLine?.description && (
                      <div style={{ fontSize: '8.5px', color: MUTED, marginTop: '1px' }}>
                        {line.poLine.description}
                      </div>
                    )}
                  </td>
                  <td style={{ ...cell('left'), fontSize: '9px', color: GREY }}>
                    {line.warehouse?.name ?? <Dash />}
                  </td>
                  <td style={{ ...cell('center'), fontSize: '9px', color: GREY }}>
                    {line.item.uom?.symbol ?? '—'}
                  </td>
                  <td style={{ ...cell('right'), ...NUM, color: GREY }}>{qty(line.orderedQty)}</td>
                  <td style={{ ...cell('right'), ...NUM }}>{qty(line.receivedQty)}</td>
                  {/* Rejected goods are printed in red and never in grey.
                      This is the number the driver is going to be asked about
                      at the gate. */}
                  <td
                    style={{
                      ...cell('right'),
                      ...NUM,
                      color: rejected > 0 ? RED : RULE,
                      fontWeight: rejected > 0 ? 700 : 400,
                    }}
                  >
                    {rejected > 0 ? qty(rejected) : '—'}
                  </td>
                  <td style={{ ...cell('right'), ...NUM, fontWeight: 700 }}>
                    {qty(line.acceptedQty)}
                  </td>
                  <td style={{ ...cell('right'), ...NUM }}>{money(line.unitRate)}</td>
                  <td style={{ ...cell('right'), ...NUM, fontWeight: 600 }}>
                    {money(line.taxable)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* ── Words and money ────────────────────────────────────── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 250px',
            gap: '7px',
            marginTop: '8px',
            alignItems: 'start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
            {template.showAmountInWords && (
              <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                <Eyebrow style={{ color: GREY }}>Value of goods taken in</Eyebrow>
                <div
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    color: INK,
                    marginTop: '2px',
                    lineHeight: 1.45,
                  }}
                >
                  {data.totalInWords}
                </div>
              </div>
            )}

            {/* Said in words as well as in the column, because a short
                delivery is the thing somebody has to act on today and a
                figure in a table is easy to read past. */}
            {totals.rejectedQty > 0 && (
              <div
                style={{
                  border: `1px solid ${RED}`,
                  background: '#fdf3f2',
                  padding: '7px 10px',
                }}
              >
                <Eyebrow style={{ color: RED }}>Not taken into stock</Eyebrow>
                <div style={{ fontSize: '10px', color: INK, marginTop: '2px', lineHeight: 1.5 }}>
                  {qty(totals.rejectedQty)} rejected at the gate and going back with the vehicle.
                  Nothing on this note has been valued for it, and the order still owes the
                  quantity.
                </div>
              </div>
            )}

            {grn.notes && (
              <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
                <div style={{ fontSize: '10px', color: GREY, marginTop: '2px', lineHeight: 1.6 }}>
                  {grn.notes}
                </div>
              </div>
            )}
          </div>

          <div style={{ border: `1px solid ${RULE}` }}>
            <TotalRow label="Total discount" value={money(totals.discount)} alt={false} />
            <TotalRow label="Sub total" value={money(totals.taxable)} alt />
            {taxMode === 'CGST_SGST' && (
              <>
                <TotalRow label="SGST" value={money(totals.sgst)} alt={false} />
                <TotalRow label="CGST" value={money(totals.cgst)} alt />
              </>
            )}
            {taxMode === 'IGST' && <TotalRow label="IGST" value={money(totals.igst)} alt={false} />}
            {taxMode === 'NONE' && <TotalRow label="GST" value="Not registered" alt={false} />}
            {Math.abs(totals.roundOff) >= 0.005 && (
              <TotalRow label="Rounding" value={money(totals.roundOff)} alt />
            )}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '14px',
                padding: '7px 11px',
                background: NAVY,
                color: '#fff',
              }}
            >
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                }}
              >
                Total
              </span>
              <span style={{ fontSize: '13px', fontWeight: 700, ...NUM }}>
                ₹{money(totals.total)}
              </span>
            </div>
          </div>
        </div>

        {/* ── Signatures ─────────────────────────────────────────────

            Three, as the old note has them. Prepared By is filled in from who
            recorded the receipt — a signature line anybody can write any name
            on is not a signature line. The other two are ruled and left
            empty, because they are signed by hand at the gate. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '7px',
            marginTop: 'auto',
            paddingTop: '16px',
          }}
        >
          {[
            { role: 'Prepared by', who: grn.createdBy?.name ?? null },
            { role: 'Inspected by', who: null },
            { role: 'Authorized by', who: null },
          ].map((s) => (
            <div key={s.role} style={{ border: `1px solid ${RULE}`, padding: '8px 10px' }}>
              <div style={{ height: '34px', display: 'flex', alignItems: 'flex-end' }}>
                <span style={{ fontSize: '10.5px', fontWeight: 600, color: INK }}>
                  {s.who ?? ''}
                </span>
              </div>
              <div style={{ borderTop: `1px solid ${RULE_SOFT}`, paddingTop: '4px' }}>
                <Eyebrow style={{ color: GREY }}>{s.role}</Eyebrow>
              </div>
            </div>
          ))}
        </div>

        {/* ── Footer band ────────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '14px',
            marginTop: '9px',
            paddingTop: '7px',
            borderTop: `1px solid ${RULE_SOFT}`,
          }}
        >
          <span
            style={{
              fontSize: '9px',
              fontWeight: 600,
              letterSpacing: '.07em',
              textTransform: 'uppercase',
              color: NAVY,
              flexShrink: 0,
            }}
          >
            {company.name} — {template.title} {grn.grnNumber}
          </span>
          <span style={{ fontSize: '9px', color: MUTED, textAlign: 'right' }}>
            {template.footerNote ??
              'Goods received subject to inspection. This note is not a tax invoice.'}
          </span>
        </div>
      </div>
    </>
  )
}
