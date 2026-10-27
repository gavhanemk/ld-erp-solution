'use client'

import { Fragment } from 'react'
import type { SummaryGrid } from './SummaryTable'

/**
 * A report printed as a register — the accounts team's ledger page.
 *
 * One component for the screen and for the paper, so what somebody reads at
 * their desk is what comes out of the printer and what lands in the PDF: the
 * letterhead, the period, one header row repeated on every page, each bill's
 * lines with its figures once on its first line, a total under every month
 * and the grand total at the foot.
 *
 * It adds nothing up itself. Every total is the server's, the same figures
 * the workbook prints, so the PDF and the spreadsheet cannot disagree.
 */

export interface RegisterColumnDef {
  key: string
  label: string
  type: string
  unit?: string
  unitKey?: string
  badges?: Record<string, string>
  total?: 'sum' | 'none'
}

export interface RegisterPrintColumn {
  key: string
  sub?: string[]
  label?: string
  subLabel?: string
  /** A peer figure printed under this one at full size: SGST under CGST. */
  under?: string
  underLabel?: string
  /** A name that may wrap. Everything else stays on one line. */
  wrap?: boolean
  /** A party's or an item's name, given room for a few words before it wraps. */
  wide?: boolean
}

export interface RegisterSpec {
  /** Empty when every row stands alone. */
  documentKey: string
  noun: { one: string; many: string }
  lineKeys: string[]
  print: RegisterPrintColumn[]
  noteKey?: string
  void?: { key: string; value: string; word: string }
  /** Empty when the register has no month totals. */
  monthKey: string
}

export interface RegisterTotal {
  label: string
  documents: number
  voided: number
  count: string
  sums: Record<string, number>
  byUnit: Record<string, Array<{ unit: string; value: number }>>
  lastRow: number
}

export interface RegisterData {
  report: { id: string; title: string; description: string }
  periodLabel: string
  appliedFilters: Array<{ label: string; value: string }>
  rowCount: number
  totalRows: number
  truncated: boolean
  columns: RegisterColumnDef[]
  rows: Array<Record<string, unknown>>
  register: {
    spec: RegisterSpec
    totals: { months: RegisterTotal[]; grand: RegisterTotal }
    /** The Summary tab's tables, worked out on the server. */
    summary: SummaryGrid[]
    letterhead: { name: string; lines: string[] }
    generatedAt: string
    generatedBy: string | null
  }
}

const NUMERIC = new Set(['money', 'qty', 'integer', 'percent'])

/*
 * Dates are read in India's time, as the server subtotals them — a bill
 * saved after midnight is the next day's bill on screen as well as in the
 * month it is totalled under.
 */
const DAY = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
})

const STAMP = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
})

export const stampOf = (iso: string) => STAMP.format(new Date(iso))

const money = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const qty = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 3 })

/**
 * One value as the register prints it.
 *
 * A nought in a money column prints as a dash, the way the old register did:
 * a bill from another state has no CGST, and a column of "0.00" down the page
 * is figures for the eye to read that say nothing.
 */
function text(
  c: RegisterColumnDef | undefined,
  row: Record<string, unknown>,
  v: unknown,
  printed?: Set<string>
): string {
  if (!c || v == null || v === '') return ''
  switch (c.type) {
    case 'date': {
      const d = new Date(String(v))
      return Number.isNaN(d.getTime()) ? '' : DAY.format(d)
    }
    case 'money': {
      const n = Number(v)
      if (!Number.isFinite(n)) return ''
      if (n === 0) return '–'
      return n < 0 ? `−${money(-n)}` : money(n)
    }
    case 'qty': {
      const n = Number(v)
      // In the figure, unless the register prints a Unit column beside it.
      const unit = c.unitKey
        ? printed?.has(c.unitKey)
          ? ''
          : String(row[c.unitKey] ?? '')
        : (c.unit ?? '')
      return `${qty(n)}${unit ? ` ${unit}` : ''}`
    }
    case 'percent':
      return `${Number((Number(v) * 100).toFixed(2))}%`
    case 'integer':
      return Number(v).toLocaleString('en-IN')
    case 'badge':
      return c.badges?.[String(v)] ?? String(v)
    default:
      return String(v)
  }
}

/** A total's figure for one column: a sum, or each unit of a quantity on its own line. */
function totalCell(c: RegisterColumnDef | undefined, t: RegisterTotal) {
  if (!c || c.total !== 'sum') return null
  if (c.type === 'qty' && c.unitKey) {
    const units = t.byUnit[c.key] ?? []
    return units.map((u) => (
      <div key={u.unit}>
        {qty(u.value)} {u.unit}
      </div>
    ))
  }
  const v = t.sums[c.key]
  return v == null ? null : text(c, {}, v)
}

/**
 * The paper a register prints on, and the size it is set in, by how many
 * columns it has.
 *
 * Nine columns sit on a portrait page in a size anybody can read; eighteen
 * need a landscape page and small type. One size for every report would set
 * the short ones in the small type the long ones need.
 */
export function paperFor(columns: number): {
  landscape: boolean
  size: string
  sub: string
  pad: string
} {
  if (columns <= 9) return { landscape: false, size: '8.2pt', sub: '7.1pt', pad: '2.2pt 3.2pt' }
  if (columns <= 10) return { landscape: true, size: '8pt', sub: '6.9pt', pad: '2.2pt 3.4pt' }
  if (columns <= 13) return { landscape: true, size: '7.3pt', sub: '6.3pt', pad: '2pt 2.6pt' }
  if (columns <= 16) return { landscape: true, size: '6.7pt', sub: '5.9pt', pad: '1.7pt 2pt' }
  return { landscape: true, size: '6.2pt', sub: '5.5pt', pad: '1.5pt 1.4pt' }
}

export function RegisterSheet({ data, mode }: { data: RegisterData; mode: 'screen' | 'print' }) {
  const { register, columns, rows } = data
  const { spec, totals, letterhead } = register
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const lineKeys = new Set(spec.lineKeys)
  const print = spec.print
  // Every key that prints somewhere, so a figure knows whether its unit has
  // a column of its own.
  const printed = new Set(print.flatMap((p) => [p.key, p.under ?? '', ...(p.sub ?? [])]))
  const paper = paperFor(print.length)

  // The label of a total runs across every column up to the first figure it
  // totals, so the figures sit under their own headings.
  const firstFigure = print.findIndex((p) => byKey.get(p.key)?.total === 'sum')
  const labelSpan = firstFigure > 0 ? firstFigure : 1

  // A bill's lines, kept together so the page never breaks inside one.
  // Without a document key every row stands alone.
  const documents: Array<{ start: number; rows: Array<Record<string, unknown>> }> = []
  rows.forEach((r, i) => {
    const last = documents[documents.length - 1]
    if (spec.documentKey && last && last.rows[0][spec.documentKey] === r[spec.documentKey]) {
      last.rows.push(r)
    } else documents.push({ start: i, rows: [r] })
  })
  const monthEnding = new Map(totals.months.map((m) => [m.lastRow, m]))

  const filters = data.appliedFilters
    .filter((f) => f.label !== 'From' && f.label !== 'To')
    .map((f) => `${f.label}: ${f.value}`)
    .join('   ·   ')

  const totalRow = (t: RegisterTotal, kind: 'month' | 'grand') => (
    <tr className={`reg-total reg-${kind}`}>
      <td colSpan={labelSpan}>
        {kind === 'grand' ? 'Grand total' : `Total for ${t.label}`}
        <span className="reg-count"> · {t.count}</span>
      </td>
      {print.slice(labelSpan).map((p) => (
        <td key={p.key} className={NUMERIC.has(byKey.get(p.key)?.type ?? '') ? 'num' : undefined}>
          {totalCell(byKey.get(p.key), t)}
          {p.under && <div>{totalCell(byKey.get(p.under), t)}</div>}
        </td>
      ))}
    </tr>
  )

  return (
    <div
      className={`reg reg-${mode}`}
      style={
        mode === 'print'
          ? ({
              '--reg-size': paper.size,
              '--reg-sub': paper.sub,
              '--reg-pad': paper.pad,
            } as React.CSSProperties)
          : undefined
      }
    >
      <style>{SHEET_CSS}</style>

      <header className="reg-head">
        {letterhead.name && <div className="reg-company">{letterhead.name}</div>}
        {letterhead.lines.map((l) => (
          <div key={l} className="reg-address">
            {l}
          </div>
        ))}
        <div className="reg-title">{data.report.title}</div>
        <div className="reg-period">Period: {data.periodLabel}</div>
        {filters && <div className="reg-filters">{filters}</div>}
        <div className="reg-meta">
          <span>
            Generated on {stampOf(register.generatedAt)}
            {register.generatedBy ? ` by ${register.generatedBy}` : ''}
          </span>
          <span>Amounts in ₹</span>
        </div>
        {data.truncated && (
          <div className="reg-partial">
            Showing the first {data.rowCount.toLocaleString('en-IN')} of{' '}
            {data.totalRows.toLocaleString('en-IN')} rows. Narrow the period to see every row.
          </div>
        )}
      </header>

      <div className="reg-scroll">
        <table className="reg-table">
          <thead>
            <tr>
              {print.map((p) => {
                const c = byKey.get(p.key)
                return (
                  <th key={p.key} className={NUMERIC.has(c?.type ?? '') ? 'num' : undefined}>
                    {p.label ?? c?.label ?? p.key}
                    {p.underLabel && <span className="reg-under">{p.underLabel}</span>}
                    {p.subLabel && <span className="reg-sub">{p.subLabel}</span>}
                  </th>
                )
              })}
            </tr>
          </thead>

          {documents.length === 0 && (
            <tbody>
              <tr>
                <td colSpan={print.length} className="reg-empty">
                  No {spec.noun.many} match these filters.
                </td>
              </tr>
            </tbody>
          )}

          {documents.map((d) => {
            const first = d.rows[0]
            const isVoid = spec.void != null && first[spec.void.key] === spec.void.value
            const note = spec.noteKey ? String(first[spec.noteKey] ?? '') : ''
            const end = d.start + d.rows.length - 1
            const month = monthEnding.get(end)
            return (
              <Fragment key={`${String(first[spec.documentKey])}-${d.start}`}>
                <tbody className={`reg-doc${isVoid ? ' reg-void' : ''}`}>
                  {d.rows.map((r, i) => (
                    <tr key={i} className={i === 0 ? 'reg-first' : 'reg-more'}>
                      {print.map((p) => {
                        const c = byKey.get(p.key)
                        // What belongs to the bill prints on its first line only.
                        const shown = i === 0 || lineKeys.has(p.key)
                        if (!shown) return <td key={p.key} />
                        const subs = (p.sub ?? [])
                          .map((k) => text(byKey.get(k), r, r[k], printed))
                          .filter(Boolean)
                        const cls = NUMERIC.has(c?.type ?? '')
                          ? 'num'
                          : p.wrap
                            ? `wrap${p.wide ? ' wide' : ''}`
                            : undefined
                        return (
                          <td key={p.key} className={cls}>
                            {text(c, r, r[p.key], printed)}
                            {p.under && (
                              <span className="reg-under">
                                {text(byKey.get(p.under), r, r[p.under], printed)}
                              </span>
                            )}
                            {subs.map((s, j) => (
                              <span key={j} className="reg-sub">
                                {s}
                              </span>
                            ))}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                  {note && (
                    <tr className="reg-note">
                      <td />
                      <td colSpan={print.length - 1}>{note}</td>
                    </tr>
                  )}
                </tbody>
                {month && <tbody className="reg-sum">{totalRow(month, 'month')}</tbody>}
              </Fragment>
            )
          })}

          {documents.length > 0 && <tbody className="reg-sum">{totalRow(totals.grand, 'grand')}</tbody>}
        </table>
      </div>
    </div>
  )
}

/*
 * The sheet's own type, in the sheet's own colours.
 *
 * Paper is white and ink is black whichever theme the screen is in: this is a
 * document, and it has to look the same on a desk as it does on paper. On
 * screen it is set larger and scrolls inside its own frame, with the column
 * headings held at the top; on paper it is set small enough for nineteen
 * columns to cross a landscape A4.
 */
const SHEET_CSS = `
.reg {
  --reg-size: 11.5px;
  --reg-sub: 10px;
  --reg-pad: 4px 6px;
  background: #fff; color: #111;
  font-family: var(--font-inter), Inter, system-ui, sans-serif;
  font-size: var(--reg-size); line-height: 1.3;
}
.reg-screen {
  border-radius: 12px; padding: 20px 20px 14px;
  box-shadow: 0 1px 3px rgba(15, 23, 42, .12), 0 0 0 1px rgba(15, 23, 42, .06);
}
/* Print sizes come from paperFor(), set on the element by column count. */

.reg-head { text-align: center; margin-bottom: 10px; }
.reg-company { font-size: 1.6em; font-weight: 800; letter-spacing: .01em; }
.reg-address { font-size: .92em; color: #333; }
.reg-title {
  margin-top: 6px; padding: 3px 0; font-size: 1.25em; font-weight: 800; letter-spacing: .12em;
  text-transform: uppercase; border-top: 1px solid #111; border-bottom: 1px solid #111;
}
.reg-period { margin-top: 4px; font-weight: 600; }
.reg-filters { font-size: .92em; color: #333; }
.reg-meta {
  display: flex; justify-content: space-between; margin-top: 4px; font-size: .88em; color: #555;
}
.reg-partial { margin-top: 4px; font-weight: 700; color: #a11; }

.reg-screen .reg-scroll { overflow: auto; max-height: calc(100vh - 230px); min-height: 160px; }
@media (max-width: 640px) { .reg-screen { padding: 14px 12px 10px; } }

.reg-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.reg-table th, .reg-table td {
  padding: var(--reg-pad); vertical-align: top; text-align: left; white-space: nowrap;
}
.reg-table .num { text-align: right; }
/* Words may take a second line; numbers, dates and codes never break. A
   name is given room for a few words first, and more of it on a screen,
   which can scroll sideways where paper cannot. */
.reg-table td.wrap { white-space: normal; min-width: 4.5em; }
.reg-table td.wide { min-width: 7.5em; }
.reg-screen .reg-table td.wrap { min-width: 6em; }
.reg-screen .reg-table td.wide { min-width: 10em; }
.reg-table th {
  font-weight: 700; font-size: .9em; text-transform: uppercase; vertical-align: bottom;
  border-top: 1px solid #111; border-bottom: 1px solid #111; background: #f1f3f5;
  /* A heading may take two lines, so a column is as wide as its figures
     rather than as wide as the words over them. */
  white-space: normal;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.reg-screen .reg-table thead th { position: sticky; top: 0; z-index: 1; }
.reg-sub { display: block; font-size: var(--reg-sub); font-weight: 400; color: #555; text-transform: none; letter-spacing: 0; }
.reg-table th .reg-sub { color: #444; white-space: nowrap; }
/* Ruled columns, as on a ledger page. Eighteen columns of figures with
   nothing between them run together, worst of all in the totals, where the
   widest figures sit side by side. */
.reg-table th + th, .reg-table td + td { border-left: .5px solid #dde1e6; }
.reg-note td + td { border-left: 0; }
.reg-under { display: block; }

/* One rule between bills, none between a bill's own lines. */
.reg-doc { break-inside: avoid; page-break-inside: avoid; }
.reg-doc tr.reg-first td { border-top: .6px solid #b8bec6; }
.reg-doc:first-of-type tr.reg-first td { border-top: 0; }
.reg-void td { color: #8a9099; }
.reg-note td { font-size: var(--reg-sub); font-style: italic; color: #444; padding-top: 0; white-space: normal; }

.reg-total td { font-weight: 700; border-top: 1px solid #111; background: #f6f7f9; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.reg-total .reg-count { font-weight: 400; color: #444; }
.reg-grand td { border-top: 1.4px solid #111; border-bottom: 3px double #111; background: #eceff2; }
.reg-sum { break-inside: avoid; page-break-inside: avoid; }
.reg-empty { text-align: center !important; color: #666; padding: 24px !important; }

.reg-total td:first-child { white-space: normal; }
`
