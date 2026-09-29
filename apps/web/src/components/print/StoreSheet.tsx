'use client'

import { PrintToolbar } from '@/components/print/PrintSheet'

/**
 * The store's printed papers: issue slip, transfer note, count sheet.
 *
 * The same look as the goods receipt note, which is the sheet the store and a
 * supplier's driver already handle: the letterhead, a navy title, titled
 * panels of facts, a navy-headed item table, ruled signature boxes and a
 * footer band. None of these carry money totals or a tax declaration; they
 * are the store's own records, signed by the people who handled the goods.
 */

export const NAVY = '#173a6c'
export const TINT = '#e9eff8'
export const TINT_SOFT = '#f4f7fc'
export const INK = '#1f2b3d'
export const GREY = '#44536b'
export const MUTED = '#5a6880'
export const RULE = '#aebfd6'
export const RULE_SOFT = '#cdd9ea'
export const RED = '#b3261e'
const SANS = 'var(--font-inter), Inter, system-ui, sans-serif'

/** Tabular figures, so columns of quantities line up. */
export const NUM: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' }
export const CODE: React.CSSProperties = { fontVariantNumeric: 'tabular-nums', letterSpacing: '.02em' }

export const qty = (v: number | string) =>
  Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 })

export const money = (v: number | string) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const longDate = (v: string | Date | null | undefined) =>
  v
    ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : null

export function Dash() {
  return <span style={{ color: RULE }}>—</span>
}

export function Eyebrow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
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
export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${RULE}`, display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: TINT, borderBottom: `1px solid ${RULE}`, padding: '5.5px 10px' }}>
        <Eyebrow>{title}</Eyebrow>
      </div>
      <div style={{ padding: '7px 10px', flex: 1 }}>{children}</div>
    </div>
  )
}

/** Label, colon, value, with the colon in a column of its own so values line up. */
export function Fact({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', fontSize: '10px', lineHeight: 1.65 }}>
      <span style={{ color: GREY, width: '78px', flexShrink: 0 }}>{label}</span>
      <span style={{ color: MUTED, width: '9px', flexShrink: 0 }}>:</span>
      <span
        style={{ color: INK, fontWeight: 600, minWidth: 0, wordBreak: 'break-word', ...(mono ? CODE : {}) }}
      >
        {value || value === 0 ? value : <Dash />}
      </span>
    </div>
  )
}

export interface SheetColumn {
  key: string
  head: string
  width: string
  align?: 'left' | 'right' | 'center'
}

function HeadRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', lineHeight: 1.5 }}>
      <span style={{ fontSize: '9.5px', color: GREY, width: '52px', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '9.5px', color: MUTED, flexShrink: 0 }}>:</span>
      <span style={{ fontSize: '10.5px', fontWeight: 600, color: INK, ...NUM }}>{value || <Dash />}</span>
    </div>
  )
}

const SHEET_CSS = `
@page { size: A4; margin: 0; }
.print-toolbar {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  max-width: 210mm; margin: 0 auto 12px; padding: 8px 12px;
  background: #fff; border-radius: 6px;
  font: 13px Inter, system-ui, sans-serif; color: #1f2b3d;
}
.print-toolbar .tb-hint { color: #5a6880; font-size: 12px; margin-right: auto; }
.print-toolbar .tb-btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
  border: 1px solid #aebfd6; border-radius: 6px; background: #fff; color: #173a6c;
  font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer;
}
.print-toolbar .tb-primary { background: #173a6c; border-color: #173a6c; color: #fff; }
.store-options {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  max-width: 210mm; margin: 0 auto 12px; padding: 8px 12px;
  background: #fff; border-radius: 6px; font: 13px Inter, system-ui, sans-serif; color: #1f2b3d;
}
.store-options select { padding: 5px 8px; border: 1px solid #aebfd6; border-radius: 6px; font: inherit; }
.store-options label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.store-sheet tr { break-inside: avoid; }
.store-sheet thead { display: table-header-group; }
@media print {
  .no-print { display: none !important; }
  html, body { background: #fff !important; }
  .store-sheet { margin: 0 !important; box-shadow: none !important; min-height: 296mm !important; }
  .store-sheet, .store-sheet * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`

export function StoreSheet({
  company,
  title,
  number,
  dateLabel,
  date,
  backHref,
  backLabel,
  banner,
  panels,
  columns,
  rows,
  minRows = 0,
  after,
  signatures,
  footerNote,
  options,
}: {
  company: Record<string, string | null>
  title: string
  /** The document's number, printed beside the title and in the footer. */
  number: string
  dateLabel: string
  date: string
  backHref: string
  backLabel: string
  /** A red band under the title, for a cancelled or closed document. */
  banner?: string | null
  panels: Array<{ title: string; body: React.ReactNode }>
  columns: SheetColumn[]
  rows: Array<{ key: string; cells: Record<string, React.ReactNode>; muted?: boolean }>
  /** Ruled empty rows, for a sheet to be written on. */
  minRows?: number
  /** Anything between the table and the signatures. */
  after?: React.ReactNode
  signatures: Array<{ role: string; who?: string | null }>
  footerNote: string
  /** Screen-only controls above the sheet, never printed. */
  options?: React.ReactNode
}) {
  const address = [company.address, company.city, company.state, company.pincode].filter(Boolean).join(', ')
  const cell = (align: SheetColumn['align'] = 'left'): React.CSSProperties => ({
    padding: '5px',
    fontSize: '9.5px',
    textAlign: align,
    border: `1px solid ${RULE_SOFT}`,
    verticalAlign: 'top',
    color: INK,
  })
  const blanks = Math.max(0, minRows - rows.length)

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: SHEET_CSS }} />
      <PrintToolbar backHref={backHref} backLabel={backLabel} copies={1} />
      {options && <div className="no-print store-options">{options}</div>}

      <div
        className="store-sheet"
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
        {/* ── Letterhead ── */}
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
          {company.logoUrl && (
            // A data URL, so next/image would add nothing.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={company.logoUrl}
              alt=""
              style={{ height: '52px', width: 'auto', maxWidth: '124px', objectFit: 'contain', flexShrink: 0 }}
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
            {address && (
              <div style={{ fontSize: '10.5px', color: GREY, lineHeight: 1.6, marginTop: '4px', maxWidth: '86%' }}>
                {address}
              </div>
            )}
          </div>
          <div style={{ flexShrink: 0 }}>
            <HeadRow label="Email" value={company.email} />
            <HeadRow label="Phone No" value={company.phone} />
            <HeadRow label="GST No" value={company.gstin} />
          </div>
        </div>
        <div style={{ borderTop: `2.5px solid ${NAVY}`, marginTop: '7px' }} />

        {/* ── Title ── */}
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
              {title}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: NAVY, ...CODE }}>{number}</div>
            <Eyebrow style={{ color: GREY, marginTop: '2px' }}>{dateLabel}</Eyebrow>
            <div style={{ fontSize: '11px', fontWeight: 600, ...NUM }}>{date}</div>
          </div>
        </div>

        {banner && (
          <div
            style={{
              border: `1px solid ${RED}`,
              background: '#fdf3f2',
              color: RED,
              padding: '6px 10px',
              fontSize: '10.5px',
              fontWeight: 700,
              marginBottom: '7px',
            }}
          >
            {banner}
          </div>
        )}

        {/* ── Panels ── */}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${panels.length}, 1fr)`, gap: '7px' }}>
          {panels.map((p) => (
            <Panel key={p.title} title={p.title}>
              {p.body}
            </Panel>
          ))}
        </div>

        {/* ── Lines ── */}
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '8px', tableLayout: 'fixed' }}>
          <colgroup>
            {columns.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr style={{ background: NAVY }}>
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{
                    padding: '5px',
                    fontSize: '8px',
                    fontWeight: 600,
                    letterSpacing: '.04em',
                    textTransform: 'uppercase',
                    color: '#fff',
                    textAlign: c.align ?? 'left',
                    border: `1px solid ${NAVY}`,
                  }}
                >
                  {c.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} style={{ background: i % 2 ? TINT_SOFT : '#fff', opacity: r.muted ? 0.55 : 1 }}>
                {columns.map((c) => (
                  <td key={c.key} style={{ ...cell(c.align), ...(c.align === 'right' ? NUM : {}) }}>
                    {r.cells[c.key] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
            {Array.from({ length: blanks }).map((_, i) => (
              <tr key={`blank-${i}`}>
                {columns.map((c) => (
                  <td key={c.key} style={{ ...cell(c.align), height: '20px' }} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {after}

        {/* ── Signatures: a name printed where the system knows who; ruled and
            empty where it is signed by hand. ── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${signatures.length}, 1fr)`,
            gap: '7px',
            marginTop: 'auto',
            paddingTop: '16px',
          }}
        >
          {signatures.map((s) => (
            <div key={s.role} style={{ border: `1px solid ${RULE}`, padding: '8px 10px' }}>
              <div style={{ height: '34px', display: 'flex', alignItems: 'flex-end' }}>
                <span style={{ fontSize: '10.5px', fontWeight: 600, color: INK }}>{s.who ?? ''}</span>
              </div>
              <div style={{ borderTop: `1px solid ${RULE_SOFT}`, paddingTop: '4px' }}>
                <Eyebrow style={{ color: GREY }}>{s.role}</Eyebrow>
              </div>
            </div>
          ))}
        </div>

        {/* ── Footer band ── */}
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
            {company.name} — {title} {number}
          </span>
          <span style={{ fontSize: '9px', color: MUTED, textAlign: 'right' }}>{footerNote}</span>
        </div>
      </div>
    </>
  )
}
