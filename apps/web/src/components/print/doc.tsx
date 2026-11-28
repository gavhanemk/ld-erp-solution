'use client'

import { PrintToolbar } from '@/components/print/PrintSheet'
import { SecondAddress } from '@/components/print/SecondAddress'

/**
 * The one look every printed document shares (27 Nov 2026).
 *
 * Laid out after the mill's purchase order — letterhead with the contact
 * list beside it, "DOCUMENT / TITLE", a To block with the order's facts in a
 * column beside it, the lines, the amount in words beside the totals, the GST
 * by rate, the terms, two signatures and a footer on every page — and set
 * strictly in black on white. Only the company logo keeps its colours: no
 * tints, no fills, no navy. Hierarchy comes from weight, size and rules, which
 * is also what survives a tired laser printer and a photocopy.
 *
 * Pages are the browser's own. A document is one flowing sheet: the table's
 * heading repeats at the top of every page, a row never splits across two,
 * and the footer — "LD COTTON MILLS — PURCHASE ORDER PO-2627-0004" and
 * "Page 2 of 3" — is printed in the page margin by the browser, so it is right
 * however long the document runs. Nothing is counted by hand, so nothing is
 * clipped or squeezed into the next column.
 */

/* ── Tokens ────────────────────────────────────────────────────────────────── */

export const INK = '#000'
export const PAPER = '#fff'
/** Rules inside a box: between rows, between columns. */
export const HAIR = '0.5pt solid #000'
/** The edge of a box. */
export const LINE = '0.75pt solid #000'
/** Under the letterhead, above the total. */
export const HEAVY = '1.5pt solid #000'

export const SANS = 'var(--font-inter), Inter, "Helvetica Neue", Arial, sans-serif'

/** Tabular figures, so columns of figures line up. */
export const NUM: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' }
/** An identifier read a character at a time: a number, a GSTIN, a code. */
export const CODE: React.CSSProperties = { fontVariantNumeric: 'tabular-nums', letterSpacing: '.02em' }

export const money = (v: number | string | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const qty = (v: number | string | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })

/** 27/11/2026, as the mill writes a date on paper. */
export const shortDate = (v: string | Date | null | undefined) =>
  v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : null

export const longDate = (v: string | Date | null | undefined) =>
  v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null

/** A percentage: at most two decimals, trailing zeros dropped. */
export const pct = (v: string | number | null | undefined) => {
  const n = Number(v)
  return `${Number.isFinite(n) ? Number(n.toFixed(2)) : 0}%`
}

export type CompanyInfo = Record<string, string | null | undefined>

/* ── Small pieces ──────────────────────────────────────────────────────────── */

/** A blank field. */
export function Dash() {
  return <span>—</span>
}

/** A small capitalised label over a block. */
export function Eyebrow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        fontSize: '8.5px',
        fontWeight: 700,
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: INK,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export type GlyphName = 'mail' | 'phone' | 'gst' | 'pan' | 'web' | 'truck'

/** The letterhead's marks, drawn in black outline. */
export function Glyph({ name, size = 10 }: { name: GlyphName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: INK,
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style: { flexShrink: 0, display: 'block' },
  }
  switch (name) {
    case 'mail':
      return (
        <svg {...common} aria-hidden>
          <rect x="2" y="4.5" width="20" height="15" rx="2" />
          <path d="m2.8 6 9.2 6.2L21.2 6" />
        </svg>
      )
    case 'phone':
      return (
        <svg {...common} aria-hidden>
          <path d="M21.5 16.9v2.6a2 2 0 0 1-2.2 2 19.6 19.6 0 0 1-8.5-3 19.3 19.3 0 0 1-6-6 19.6 19.6 0 0 1-3-8.6 2 2 0 0 1 2-2.2h2.6a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1l-1.1 1.1a15.8 15.8 0 0 0 6 6l1.1-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" />
        </svg>
      )
    case 'gst':
      return (
        <svg {...common} aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 8h5M9.5 11h5M13 15.5 9.5 11h1.8c2.6 0 2.6-3 0-3" />
        </svg>
      )
    case 'pan':
      return (
        <svg {...common} aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="10" r="2.4" />
          <path d="M7.8 17.3a4.6 4.6 0 0 1 8.4 0" />
        </svg>
      )
    case 'web':
      return (
        <svg {...common} aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" />
        </svg>
      )
    case 'truck':
      return (
        <svg {...common} aria-hidden>
          <path d="M2 7.5h10v9H2zM12 10.5h4.6l2.9 3v3H12z" />
          <circle cx="6" cy="18" r="1.8" />
          <circle cx="16.5" cy="18" r="1.8" />
        </svg>
      )
  }
}

/** Label, colon, value — the colon in its own column so values line up. */
export function Fact({
  label,
  value,
  mono,
  labelWidth = 78,
  strong = true,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
  labelWidth?: number
  strong?: boolean
}) {
  return (
    <div style={{ display: 'flex', fontSize: '9.5px', lineHeight: 1.6, color: INK }}>
      <span style={{ width: `${labelWidth}px`, flexShrink: 0 }}>{label}</span>
      <span style={{ width: '9px', flexShrink: 0 }}>:</span>
      <span style={{ fontWeight: strong ? 600 : 400, minWidth: 0, overflowWrap: 'anywhere', ...(mono ? CODE : {}) }}>
        {value || value === 0 ? value : <Dash />}
      </span>
    </div>
  )
}

/** A ruled box with a capitalised title over a hairline. No fill. */
export function Box({
  title,
  children,
  style,
  bodyStyle,
}: {
  title?: React.ReactNode
  children: React.ReactNode
  style?: React.CSSProperties
  bodyStyle?: React.CSSProperties
}) {
  return (
    <div style={{ border: LINE, display: 'flex', flexDirection: 'column', breakInside: 'avoid', ...style }}>
      {title && (
        <div style={{ borderBottom: HAIR, padding: '4px 9px' }}>
          <Eyebrow>{title}</Eyebrow>
        </div>
      )}
      <div style={{ padding: '6px 9px', flex: 1, fontSize: '9.5px', lineHeight: 1.55 }}>{children}</div>
    </div>
  )
}

/** Side-by-side boxes of equal width. */
export function BoxRow({ children, columns }: { children: React.ReactNode; columns?: string }) {
  const count = Array.isArray(children) ? children.filter(Boolean).length : 1
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: columns ?? `repeat(${count}, minmax(0, 1fr))`,
        gap: '6px',
        marginTop: '7px',
      }}
    >
      {children}
    </div>
  )
}

/** A line of warning across the sheet: a cancelled, closed or draft document. */
export function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        border: '1.25pt solid #000',
        padding: '5px 9px',
        fontSize: '10px',
        fontWeight: 800,
        letterSpacing: '.04em',
        textTransform: 'uppercase',
        marginTop: '6px',
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  )
}

/* ── The party block ───────────────────────────────────────────────────────── */

/** One line of the party: a bold label and its value run on after it. */
export function PartyLine({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ fontSize: '9.5px', lineHeight: 1.55, marginTop: '1.5px' }}>
      <span style={{ fontWeight: 700 }}>{label}</span>
      <span style={{ marginLeft: '6px', ...(mono && value ? CODE : {}) }}>
        {value || value === 0 ? value : <Dash />}
      </span>
    </div>
  )
}

/** One line of the facts beside the party: label, colon, value, all lined up. */
export function MetaLine({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '84px 8px minmax(0, 1fr)', alignItems: 'baseline', marginTop: '1.5px' }}>
      <span style={{ fontSize: '9.5px', fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: '9.5px' }}>:</span>
      <span style={{ fontSize: '10px', fontWeight: 700, overflowWrap: 'anywhere', ...(mono && value ? CODE : {}) }}>
        {value || value === 0 ? value : <Dash />}
      </span>
    </div>
  )
}

/**
 * "To," over the party, with the document's own facts in a column beside it —
 * the block on the mill's purchase order.
 */
export function PartyBlock({
  heading = 'To,',
  name,
  code,
  children,
  meta,
}: {
  heading?: string
  name: React.ReactNode
  code?: string | null
  /** The party's lines: address, GSTIN, contact. */
  children?: React.ReactNode
  /** The column beside it: [label, value, mono?]. */
  meta?: Array<[string, React.ReactNode, boolean?] | null | false>
}) {
  const rows = (meta ?? []).filter(Boolean) as Array<[string, React.ReactNode, boolean?]>
  return (
    <div style={{ border: LINE, display: 'flex', gap: '16px', padding: '7px 9px', marginTop: '7px', breakInside: 'avoid' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '10px', fontWeight: 700 }}>{heading}</div>
        <div style={{ fontSize: '13px', fontWeight: 800, textTransform: 'uppercase', lineHeight: 1.25, marginTop: '1px' }}>
          {name}
          {code && <span style={{ fontSize: '9.5px', fontWeight: 600, marginLeft: '6px', textTransform: 'none', ...CODE }}>{code}</span>}
        </div>
        {children}
      </div>
      {rows.length > 0 && (
        <div style={{ flexShrink: 0, width: '38%' }}>
          {rows.map(([label, value, mono]) => (
            <MetaLine key={label} label={label} value={value} mono={mono} />
          ))}
        </div>
      )}
    </div>
  )
}

/** A full-width ruled band with a mark and a label: "Deliver to". */
export function Band({
  icon,
  label,
  children,
  strong,
}: {
  icon?: GlyphName
  label: string
  children: React.ReactNode
  /** Drawn with a heavier rule — an instruction that differs from the usual. */
  strong?: boolean
}) {
  return (
    <div
      style={{
        marginTop: '6px',
        border: strong ? '1.25pt solid #000' : LINE,
        padding: '6px 9px',
        display: 'flex',
        gap: '10px',
        alignItems: 'flex-start',
        breakInside: 'avoid',
      }}
    >
      {icon && (
        <div style={{ paddingTop: '1px', flexShrink: 0 }}>
          <Glyph name={icon} size={15} />
        </div>
      )}
      <Eyebrow style={{ flexShrink: 0, paddingTop: '2px', width: '88px' }}>{label}</Eyebrow>
      <div style={{ minWidth: 0, flex: 1, fontSize: '9.5px', lineHeight: 1.55 }}>{children}</div>
    </div>
  )
}

/* ── The lines ─────────────────────────────────────────────────────────────── */

export interface DocColumn {
  key: string
  head: React.ReactNode
  /** A share of the row, against the other columns' shares. */
  weight?: number
  /** Or a fixed percentage, as older sheets give it ("12%"). */
  width?: string
  align?: 'left' | 'right' | 'center'
}

export interface DocRow {
  key: string
  cells: Record<string, React.ReactNode>
  /** A line that no longer counts — cancelled, closed — set in italics. */
  muted?: boolean
  /** A sub-total or total row inside the table: bold, ruled above. */
  total?: boolean
}

/**
 * The line table.
 *
 * Fixed layout with every width decided here, so a long name wraps in its own
 * column instead of pushing its neighbours over — which is how HSN and Qty
 * came to print on top of each other. Every cell may wrap, a code included,
 * rather than run into the next one. The heading repeats at the top of each
 * printed page and a row is never split across two.
 */
export function DocTable({
  columns,
  rows,
  minRows = 0,
  fontSize = 9.5,
  style,
  dense = false,
}: {
  columns: DocColumn[]
  rows: DocRow[]
  /** Ruled empty rows, for a sheet to be written on. */
  minRows?: number
  fontSize?: number
  style?: React.CSSProperties
  /** Tight cells (3 px), for the compact tax invoice. */
  dense?: boolean
}) {
  const totalWeight = columns.reduce((s, c) => s + (c.width ? 0 : (c.weight ?? 10)), 0)
  const fixedPct = columns.reduce((s, c) => s + (c.width ? parseFloat(c.width) : 0), 0)
  const widthOf = (c: DocColumn) =>
    c.width ?? `${(((c.weight ?? 10) / (totalWeight || 1)) * (100 - fixedPct)).toFixed(3)}%`
  const blanks = Math.max(0, minRows - rows.length)
  const last = columns.length - 1

  const th = (c: DocColumn, i: number): React.CSSProperties => ({
    padding: dense ? '2.5px 4px' : '4px 4px',
    fontSize: '7.5px',
    fontWeight: 700,
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    lineHeight: 1.25,
    textAlign: c.align ?? 'left',
    verticalAlign: 'bottom',
    borderBottom: LINE,
    borderRight: i === last ? undefined : HAIR,
    overflowWrap: 'anywhere',
  })
  const td = (c: DocColumn, i: number, r?: DocRow): React.CSSProperties => ({
    padding: dense ? '3px 4px' : '4px 4px',
    fontSize: `${fontSize}px`,
    lineHeight: dense ? 1.3 : 1.4,
    textAlign: c.align ?? 'left',
    verticalAlign: 'top',
    borderTop: r?.total ? LINE : HAIR,
    borderRight: i === last ? undefined : HAIR,
    overflowWrap: 'anywhere',
    fontWeight: r?.total ? 700 : undefined,
    fontStyle: r?.muted ? 'italic' : undefined,
    ...(c.align === 'right' ? NUM : {}),
  })

  return (
    <table className="doc-lines" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', border: LINE, marginTop: '7px', ...style }}>
      <colgroup>
        {columns.map((c) => (
          <col key={c.key} style={{ width: widthOf(c) }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th key={c.key} style={th(c, i)}>
              {c.head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            {columns.map((c, i) => (
              <td key={c.key} style={td(c, i, r)}>
                {r.cells[c.key] ?? ''}
              </td>
            ))}
          </tr>
        ))}
        {Array.from({ length: blanks }).map((_, b) => (
          <tr key={`blank-${b}`}>
            {columns.map((c, i) => (
              <td key={c.key} style={{ ...td(c, i), height: '20px' }} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Under the item name: the filing line, a code, a note — smaller, not greyed. */
export function SubLine({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ fontSize: '8px', lineHeight: 1.35, marginTop: '1px', letterSpacing: '.01em', ...style }}>{children}</div>
}

/* ── The closing block ─────────────────────────────────────────────────────── */

export interface TotalLine {
  label: React.ReactNode
  value: React.ReactNode
  /** A line that matters more than its neighbours: bold. */
  strong?: boolean
}

/**
 * The calculation: label on the left, figure hard right, the total last
 * under a heavy rule. Ruled, never filled.
 */
export function TotalsBox({
  rows,
  totalLabel = 'Total',
  total,
  style,
}: {
  rows: TotalLine[]
  totalLabel?: string
  total: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', ...style }}>
      <div style={{ flex: 1 }}>
        {rows.map((r, i) => (
          <div
            key={i}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) 8px minmax(92px, auto)',
              alignItems: 'baseline',
              gap: '6px',
              padding: '3.5px 9px',
              fontSize: '10px',
              borderTop: i ? HAIR : undefined,
              fontWeight: r.strong ? 700 : 400,
            }}
          >
            <span>{r.label}</span>
            <span>:</span>
            <span style={{ textAlign: 'right', fontWeight: r.strong ? 700 : 600, ...NUM }}>{r.value}</span>
          </div>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: '10px',
          padding: '6px 9px',
          borderTop: HEAVY,
        }}
      >
        <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase' }}>{totalLabel}</span>
        <span style={{ fontSize: '16px', fontWeight: 800, ...NUM }}>{total}</span>
      </div>
    </div>
  )
}

/**
 * The amount in words beside the calculation, in one ruled box split down the
 * middle — two readings of the same number that check each other.
 */
export function WordsAndTotals({
  words,
  left,
  totals,
  totalsWidth = '44%',
}: {
  words?: string | null
  /** Anything else under the words: notes, bank details. */
  left?: React.ReactNode
  totals: React.ReactNode
  totalsWidth?: string
}) {
  return (
    <div style={{ display: 'flex', marginTop: '7px', border: LINE, alignItems: 'stretch', breakInside: 'avoid' }}>
      <div style={{ flex: 1, minWidth: 0, padding: '6px 9px', borderRight: LINE, display: 'flex', flexDirection: 'column', gap: '7px' }}>
        {words && (
          <div>
            <Eyebrow>Amount in words</Eyebrow>
            <div style={{ fontSize: '11px', fontWeight: 700, lineHeight: 1.4, marginTop: '2px' }}>{words}</div>
          </div>
        )}
        {left}
      </div>
      <div style={{ width: totalsWidth, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>{totals}</div>
    </div>
  )
}

/** A titled paragraph inside another block: "Special notes", "Pay to". */
export function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <Eyebrow>{title}</Eyebrow>
      <div style={{ fontSize: '9.5px', lineHeight: 1.55, marginTop: '2px', whiteSpace: 'pre-wrap' }}>{children}</div>
    </div>
  )
}

/** "GST @5% on ₹3,30,000.00 — CGST 8,250.00 + SGST 8,250.00", one line per rate. */
export function TaxByRate({
  rows,
  split,
}: {
  rows: Array<{ gstRate: string | number; taxable: number | string; cgst?: number | string; sgst?: number | string; igst?: number | string }>
  split: 'CGST_SGST' | 'IGST' | 'NONE'
}) {
  if (!rows.length || split === 'NONE') return null
  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', marginTop: '5px', border: LINE, padding: '3px 9px', breakInside: 'avoid' }}>
      <Eyebrow style={{ flexShrink: 0, paddingTop: '1.5px', width: '88px' }}>GST by rate</Eyebrow>
      <div style={{ minWidth: 0, flex: 1 }}>
        {rows.map((r) => (
          <div key={String(r.gstRate)} style={{ fontSize: '9.5px', lineHeight: 1.5, ...NUM }}>
            {Number(r.gstRate) > 0 ? (
              <>
                GST @{pct(r.gstRate)} on <strong>₹{money(r.taxable)}</strong> —{' '}
                {split === 'IGST' ? (
                  <>
                    IGST <strong>{money(r.igst)}</strong>
                  </>
                ) : (
                  <>
                    CGST <strong>{money(r.cgst)}</strong> + SGST <strong>{money(r.sgst)}</strong>
                  </>
                )}
              </>
            ) : (
              <>
                No GST on <strong>₹{money(r.taxable)}</strong>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Numbered terms in two columns that finish at about the same depth. */
export function Terms({
  text,
  title = 'Terms & Conditions',
  dense = false,
}: {
  text: string | null | undefined
  title?: string
  /** Smaller type and tighter lines, for the compact tax invoice. */
  dense?: boolean
}) {
  const lines = (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean)
  if (!lines.length) return null
  const total = lines.reduce((n, t) => n + t.length, 0)
  let run = 0
  let half = lines.length
  for (let i = 0; i < lines.length; i++) {
    run += lines[i].length
    if (run >= total / 2) {
      half = i + 1
      break
    }
  }
  if (dense && lines.length > 1) {
    // About 80 characters to a printed line in half the width: split where the
    // taller column is shortest, so one long term doesn't leave a column empty.
    const tall = lines.map((t) => Math.max(1, Math.ceil(t.length / 80)))
    const all = tall.reduce((n, h) => n + h, 0)
    let best = Infinity
    let left = 0
    for (let i = 1; i < lines.length; i++) {
      left += tall[i - 1]
      if (Math.max(left, all - left) < best) {
        best = Math.max(left, all - left)
        half = i
      }
    }
  }
  const cols = lines.length > 1 ? [lines.slice(0, half), lines.slice(half)] : [lines]
  if (dense) {
    return (
      <div style={{ border: LINE, marginTop: '5px', padding: '3px 8px 2px', breakInside: 'avoid' }}>
        <Eyebrow>{title}</Eyebrow>
        <div style={{ display: 'flex', gap: '16px', marginTop: '2px' }}>
          {cols.map((part, col) =>
            part.length ? (
              <div key={col} style={{ flex: 1, minWidth: 0 }}>
                {part.map((t, i) => (
                  <div key={i} style={{ display: 'flex', gap: '5px', fontSize: '8.5px', lineHeight: 1.35, marginBottom: '1px' }}>
                    <span style={{ width: '11px', flexShrink: 0, textAlign: 'right', fontWeight: 700, ...NUM }}>
                      {(col === 0 ? 0 : half) + i + 1}.
                    </span>
                    <span style={{ minWidth: 0 }}>{t}</span>
                  </div>
                ))}
              </div>
            ) : null,
          )}
        </div>
      </div>
    )
  }
  return (
    <Box title={title} style={{ marginTop: '7px' }} bodyStyle={{ padding: '4px 9px' }}>
      <div style={{ display: 'flex', gap: '18px' }}>
        {cols.map((part, col) =>
          part.length ? (
            <div key={col} style={{ flex: 1, minWidth: 0 }}>
              {part.map((t, i) => (
                <div key={i} style={{ display: 'flex', gap: '6px', fontSize: '9px', lineHeight: 1.55, marginBottom: '2px' }}>
                  <span style={{ width: '14px', flexShrink: 0, textAlign: 'right', fontWeight: 700, ...NUM }}>
                    {(col === 0 ? 0 : half) + i + 1}.
                  </span>
                  <span style={{ minWidth: 0 }}>{t}</span>
                </div>
              ))}
            </div>
          ) : null,
        )}
      </div>
    </Box>
  )
}

/**
 * The signatures at the foot: a rule over each role, "For LD Cotton Mills"
 * under it. On a short document they sit at the bottom of the page.
 */
export function Signatures({
  company,
  roles,
  signatureUrl,
  dense = false,
}: {
  /** Shorter, and straight after what comes before rather than at the foot of the page. */
  dense?: boolean
  company?: string | null
  /** A role, or a role with the name the system knows ("Received by — Ramesh"); `image` prints above that block. */
  roles: Array<string | { role: string; who?: string | null; sub?: string | null; image?: string | null; space?: number }>
  /** Printed above the first role. */
  signatureUrl?: string | null
}) {
  return (
    <div
      className={dense ? undefined : 'doc-push'}
      style={{
        display: 'flex',
        gap: dense ? '16px' : '22px',
        paddingTop: dense ? '6px' : '14px',
        alignItems: dense ? 'flex-start' : 'flex-end',
        breakInside: 'avoid',
      }}
    >
      {roles.map((r, i) => {
        const role = typeof r === 'string' ? r : r.role
        const who = typeof r === 'string' ? null : r.who
        const sub = typeof r === 'string' ? (company ? `For ${company}` : null) : r.sub === undefined ? (company ? `For ${company}` : null) : r.sub
        const image = (i === 0 && signatureUrl) || (typeof r === 'string' ? null : r.image)
        return (
          <div key={`${role}-${i}`} style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                height: `${(typeof r === 'string' ? undefined : r.space) ?? (dense ? 28 : 34)}px`,
                display: 'flex',
                alignItems: 'flex-end',
              }}
            >
              {image ? (
                // A data URL, so next/image would add nothing.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={image} alt="" style={{ height: '30px', width: 'auto', objectFit: 'contain', filter: 'grayscale(1)' }} />
              ) : (
                <span style={{ fontSize: '10px', fontWeight: 600 }}>{who ?? ''}</span>
              )}
            </div>
            <div style={{ borderTop: '1pt solid #000', paddingTop: '3px', marginTop: '3px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700 }}>{role}</div>
              {sub && <div style={{ fontSize: '9px', marginTop: '1px' }}>{sub}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── The sheet ─────────────────────────────────────────────────────────────── */

/** A CSS string literal, safe for `content:`. */
const cssString = (s: string) => JSON.stringify(s.replace(/[\r\n]+/g, ' '))

const sheetCss = (footerLeft: string, pageMargin = '10mm 11mm 14mm 11mm') => `
@page {
  size: A4;
  margin: ${pageMargin};
  @bottom-left {
    content: ${cssString(footerLeft.toUpperCase())};
    font: 600 7pt/1.3 "Helvetica Neue", Arial, sans-serif;
    letter-spacing: .06em;
    color: #000;
    border-top: 0.75pt solid #000;
    vertical-align: top;
    padding-top: 2mm;
  }
  @bottom-right {
    content: "Page " counter(page) " of " counter(pages);
    font: 600 7pt/1.3 "Helvetica Neue", Arial, sans-serif;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: #000;
    border-top: 0.75pt solid #000;
    vertical-align: top;
    text-align: right;
    padding-top: 2mm;
  }
}
.print-toolbar {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  width: 210mm; max-width: calc(100vw - 24px); box-sizing: border-box; margin: 0 auto 12px; padding: 8px 12px;
  background: #fff; border-radius: 6px; font: 13px "Helvetica Neue", Arial, sans-serif; color: #000;
}
.print-toolbar .tb-hint { color: #000; font-size: 12px; margin-right: auto; flex: 1; text-align: left; }
.print-toolbar .tb-btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
  border: 1px solid #000; border-radius: 6px; background: #fff; color: #000;
  font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer;
}
.print-toolbar .tb-primary { background: #000; border-color: #000; color: #fff; }
.doc-options {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  width: 210mm; max-width: calc(100vw - 24px); box-sizing: border-box; margin: 0 auto 12px; padding: 8px 12px;
  background: #fff; border-radius: 6px; font: 13px "Helvetica Neue", Arial, sans-serif; color: #000;
}
.doc-options select { padding: 5px 8px; border: 1px solid #000; border-radius: 6px; font: inherit; background: #fff; color: #000; }
.doc-options label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.doc-sheet {
  width: 210mm; min-height: 297mm; margin: 0 auto 12px; box-sizing: border-box;
  padding: 10mm 11mm 8mm; background: #fff; color: #000;
  font-family: ${SANS}; font-size: 10px; line-height: 1.45;
  box-shadow: 0 2px 18px rgba(0,0,0,.35);
  display: flex; flex-direction: column;
}
/* Black on white, enforced: whatever a page sets inline, nothing inside the
   sheet prints in a colour, on a fill or faded. The logo is an image and
   keeps its own colours. */
.doc-sheet *:not(img) {
  color: #000 !important; border-color: #000 !important;
  background-color: transparent !important; background-image: none !important;
  box-shadow: none !important; text-shadow: none !important; opacity: 1 !important;
}
.doc-sheet svg *:not(img) { stroke: #000 !important; }
.doc-sheet .doc-push { margin-top: auto; }
.doc-sheet table.doc-lines thead { display: table-header-group; }
.doc-sheet table.doc-lines tr { break-inside: avoid; page-break-inside: avoid; }
.doc-screen-foot {
  display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; padding-top: 4px;
  border-top: 0.75pt solid #000; font: 600 7pt/1.3 "Helvetica Neue", Arial, sans-serif;
  letter-spacing: .06em; text-transform: uppercase;
}
@media print {
  .no-print { display: none !important; }
  html, body { background: #fff !important; }
  .doc-sheet {
    width: auto; margin: 0 !important; padding: 0 !important; box-shadow: none !important;
    /* The page less its margins, less a hair, so a short document puts its
       signatures at the foot of the page without spilling a blank one. */
    min-height: 272mm;
  }
  .doc-screen-foot { display: none !important; }
}
`

/**
 * One document: the toolbar, then the sheet — letterhead, "DOCUMENT / TITLE"
 * with the number and date beside it, and whatever the document puts under
 * that. The footer is printed in every page's margin.
 */
export function DocumentSheet({
  company,
  title,
  number,
  dateLabel = 'Date',
  date,
  extraMeta,
  copyLabel,
  banner,
  hideNumber,
  backHref,
  backLabel,
  copies = 1,
  fileName,
  options,
  footerNote,
  tagline,
  extraContact,
  pageMargin,
  bare = false,
  children,
}: {
  company: CompanyInfo
  title: string
  number: string
  dateLabel?: string
  date?: string | null
  /** More facts under the number and date, top right. */
  extraMeta?: Array<[string, React.ReactNode] | null | false>
  /** Which copy this is — "Original for recipient". */
  copyLabel?: string | null
  /** A cancelled or closed document says so across the sheet. */
  banner?: React.ReactNode
  /** The number and date are in the document's own party block instead (the purchase order's "To," block). */
  hideNumber?: boolean
  backHref: string
  backLabel: string
  copies?: number
  /** What the saved PDF is called; the number by default. */
  fileName?: string
  /** Screen-only controls above the sheet. */
  options?: React.ReactNode
  /** A line at the very end — "Subject to Thane jurisdiction". */
  footerNote?: string | null
  /** The printed page's margins, when a document needs tighter ones (the compact tax invoice). */
  pageMargin?: string
  /** No letterhead or title row: the document draws its own header (the compact tax invoice). */
  bare?: boolean
  /** Under the company's name: "Manufacturer of: Fancy Fabrics" (the tax invoice). */
  tagline?: string | null
  /** More rows under the letterhead's contact column: [label, value] — "State", "Maharashtra, code 27". */
  extraContact?: Array<[string, string | null | undefined]>
  children: React.ReactNode
}) {
  const name = company.name ?? ''
  const address = [company.address, company.city, company.state, company.pincode].filter(Boolean).join(', ')
  const footerLeft = `${name} — ${title} ${number}`
  const meta = (extraMeta ?? []).filter(Boolean) as Array<[string, React.ReactNode]>
  // The six lines of the mill's own letterhead. TIN has not been issued since
  // GST and there is no field for it; it prints blank, as on the old paper.
  const contact: Array<[GlyphName, string, string | null | undefined, boolean?]> = [
    ['mail', 'Email', company.email],
    ['phone', 'Phone No', company.phone, true],
    ['gst', 'GST No', company.gstin, true],
    ['pan', 'PAN No', company.pan, true],
    ['gst', 'TIN No', company.tin, true],
    ['web', 'Website', company.website],
  ]

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: sheetCss(footerLeft, pageMargin) }} />
      <PrintToolbar backHref={backHref} backLabel={backLabel} copies={copies} fileName={fileName ?? number} />
      {options && <div className="no-print doc-options">{options}</div>}

      <div className="doc-sheet" style={bare ? { padding: '8mm 8mm 6mm' } : undefined}>
        {!bare && (
        <>
        {/* ── Letterhead ── */}
        <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
          {company.logoUrl && (
            // The one thing on the sheet in colour: the mark as uploaded.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={company.logoUrl}
              alt=""
              style={{ height: '50px', width: 'auto', maxWidth: '120px', objectFit: 'contain', flexShrink: 0 }}
            />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '22px', fontWeight: 800, letterSpacing: '-.01em', textTransform: 'uppercase', lineHeight: 1.05 }}>
              {name}
            </div>
            {tagline && <div style={{ fontSize: '10px', fontWeight: 700, marginTop: '3px' }}>{tagline}</div>}
            {address && <div style={{ fontSize: '9.5px', lineHeight: 1.5, marginTop: '4px', maxWidth: '92%' }}>{address}</div>}
            {company.address2 && (
              <div style={{ fontSize: '9.5px', lineHeight: 1.5, maxWidth: '92%' }}>
                <SecondAddress text={company.address2} />
              </div>
            )}
          </div>
          <div style={{ flexShrink: 0 }}>
            {contact.map(([icon, label, value, mono]) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '6px', lineHeight: 1.5 }}>
                  <Glyph name={icon} />
                  <span style={{ fontSize: '9px', width: '50px', flexShrink: 0 }}>{label}</span>
                  <span style={{ fontSize: '9px', flexShrink: 0 }}>:</span>
                  <span style={{ fontSize: '9.5px', fontWeight: 600, ...(mono && value ? NUM : {}) }}>{value || <Dash />}</span>
                </div>
              ))}
            {(extraContact ?? []).map(([label, value]) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '6px', lineHeight: 1.5 }}>
                <span style={{ width: '10px', flexShrink: 0 }} />
                <span style={{ fontSize: '9px', width: '50px', flexShrink: 0 }}>{label}</span>
                <span style={{ fontSize: '9px', flexShrink: 0 }}>:</span>
                <span style={{ fontSize: '9.5px', fontWeight: 600 }}>{value || <Dash />}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ borderTop: HEAVY, marginTop: '6px' }} />

        {/* ── Title, number, date ── */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', paddingTop: '5px' }}>
          <div style={{ minWidth: 0 }}>
            <Eyebrow>Document</Eyebrow>
            <div style={{ fontSize: '21px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '-.01em', lineHeight: 1.1, marginTop: '1px' }}>
              {title}
            </div>
          </div>
          <div style={{ flexShrink: 0, textAlign: 'right' }}>
            {copyLabel && (
              <div
                style={{
                  display: 'inline-block',
                  border: LINE,
                  fontSize: '8px',
                  fontWeight: 700,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  padding: '2px 6px',
                  marginBottom: '3px',
                }}
              >
                {copyLabel}
              </div>
            )}
            {!hideNumber && <div style={{ fontSize: '14px', fontWeight: 800, ...CODE }}>{number}</div>}
            {!hideNumber && date && (
              <div style={{ fontSize: '9.5px', ...NUM }}>
                {dateLabel} : <strong>{date}</strong>
              </div>
            )}
            {meta.map(([label, value]) => (
              <div key={label} style={{ fontSize: '9.5px', ...NUM }}>
                {label} : <strong>{value || <Dash />}</strong>
              </div>
            ))}
          </div>
        </div>
        </>
        )}

        {banner && <Banner>{banner}</Banner>}

        {children}

        {footerNote && <div style={{ fontSize: '8.5px', textAlign: 'center', marginTop: '8px' }}>{footerNote}</div>}

        {/* On screen only; on paper the browser prints this in every page's margin. */}
        <div className="doc-screen-foot">
          <span>{footerLeft}</span>
          <span>A4 · page numbers print on each page</span>
        </div>
      </div>
    </>
  )
}
