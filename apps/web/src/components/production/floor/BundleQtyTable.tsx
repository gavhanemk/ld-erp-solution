'use client'

import { StepInput } from '@/components/ui/StepInput'
import { pcs } from './types'

/**
 * Bundles with a quantity box or several — how many of each are going, were
 * counted in, done, damaged. Each row says how many it has to give; a row
 * asking for more is marked as it is typed. One press fills every row with
 * all it has. On a phone the rows are cards.
 */

export interface BundleRow {
  id: string
  code: string
  size: string | null
  line: string | null
  /** What this row can give. */
  available: number
  note?: string | null
}
export interface QtyColumn {
  key: string
  label: string
  /** Shown in the warning tone: damaged, rejected. */
  bad?: boolean
}
export type QtyValues = Record<string, Record<string, string>>
/**
 * A column after the quantities that is not a quantity of its own — the
 * count-in's "Made as size" and its pieces. On a phone it joins the card.
 */
export interface ExtraColumn {
  key: string
  label: string
  cell: (row: BundleRow) => React.ReactNode
  /** The total row's cell, if it has one. */
  total?: React.ReactNode
  width?: string
}
/**
 * Ticking bundles to act on several at once — the count-in's Change sizes. A
 * click on a row's box (or its bundle number) ticks or unticks it; with Shift
 * held it ticks every bundle from the last one clicked, as a list does.
 */
export interface RowSelect {
  on: (rowId: string) => boolean
  /** Rows that can be ticked; the others have no box. */
  can: (row: BundleRow) => boolean
  onTick: (rowId: string, run: boolean) => void
  /** The heading's box: every row that can be ticked, or none. */
  onAll: () => void
}

const n = (v: string | undefined) => Number(v) || 0

export function rowTotal(values: QtyValues, rowId: string, columns: QtyColumn[]) {
  return columns.reduce((s, c) => s + n(values[rowId]?.[c.key]), 0)
}

export function overRows(rows: BundleRow[], values: QtyValues, columns: QtyColumn[]) {
  return rows.filter((r) => rowTotal(values, r.id, columns) > r.available)
}

export function BundleQtyTable({
  rows,
  columns,
  values,
  onChange,
  availableLabel,
  fill,
  empty,
  allowOver = false,
  extraColumns = [],
  held,
  onFill,
  onClear,
  select,
}: {
  rows: BundleRow[]
  columns: QtyColumn[]
  values: QtyValues
  onChange: (rowId: string, colKey: string, value: string) => void
  availableLabel: string
  /** A button that puts each row's whole amount in one column. */
  fill?: { label: string; column: string }
  empty: string
  /** A count can come out higher than expected: allowed, and marked rather than refused. */
  allowOver?: boolean
  extraColumns?: ExtraColumn[]
  /**
   * Pieces of a row the extra columns already account for — the count-in's
   * "made as another size": they belong to the row's count, so the boxes give
   * only the rest and a row is over when both together pass what it has.
   */
  held?: (rowId: string) => number
  /** In place of the fill button's and Clear's own work, when the extra columns take part in it. */
  onFill?: () => void
  onClear?: () => void
  select?: RowSelect
}) {
  if (!rows.length) return <p className="text-muted-foreground text-sm">{empty}</p>
  const colTotal = (key: string) => rows.reduce((s, r) => s + n(values[r.id]?.[key]), 0)
  const heldOf = (rowId: string) => held?.(rowId) ?? 0
  const fillAll = () => {
    if (!fill) return
    if (onFill) return onFill()
    for (const r of rows) {
      for (const c of columns) onChange(r.id, c.key, c.key === fill.column ? String(r.available) : '')
    }
  }
  const clearAll = () => {
    if (onClear) return onClear()
    for (const r of rows) for (const c of columns) onChange(r.id, c.key, '')
  }
  const totalAvailable = rows.reduce((s, r) => s + r.available, 0)
  const tickable = select ? rows.filter((r) => select.can(r)) : []
  const allOn = !!select && tickable.length > 0 && tickable.every((r) => select.on(r.id))
  const someOn = !!select && tickable.some((r) => select.on(r.id))
  const tickBox = (r: BundleRow) =>
    select && select.can(r) ? (
      <input
        type="checkbox"
        className="accent-primary h-4 w-4 cursor-pointer"
        checked={select.on(r.id)}
        onChange={() => {}}
        onClick={(e) => select.onTick(r.id, e.shiftKey)}
        aria-label={`Tick ${r.code}`}
      />
    ) : null

  return (
    <div className="space-y-2">
      {fill && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={fillAll}>
            {fill.label}
          </button>
          <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={clearAll}>
            Clear
          </button>
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {rows.length} {rows.length === 1 ? 'bundle' : 'bundles'} · {pcs(totalAvailable)} {availableLabel.toLowerCase()}
          </span>
        </div>
      )}

      {/* Phone: one card per bundle. */}
      <div className="space-y-2 sm:hidden">
        {rows.map((r) => {
          const over = rowTotal(values, r.id, columns) + heldOf(r.id) > r.available
          return (
            <div key={r.id} className={`rounded-lg border p-2.5 ${over ? 'border-destructive/60' : 'border-border'}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex items-center gap-2 font-mono text-xs">
                  {tickBox(r)}
                  {r.code}
                </span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {availableLabel} {pcs(r.available)}
                </span>
              </div>
              <p className="text-muted-foreground text-[11px]">
                {[r.line, r.size ? `size ${r.size}` : null, r.note].filter(Boolean).join(' · ')}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {columns.map((c) => (
                  <label key={c.key} className="block">
                    <span className={`form-label ${c.bad ? 'warn-text' : ''}`}>{c.label}</span>
                    <StepInput
                      className="form-input h-9 w-full text-right tabular-nums"
                      value={values[r.id]?.[c.key] ?? ''}
                      max={Math.max(0, r.available - heldOf(r.id))}
                      placeholder="0"
                      onValueChange={(v) => onChange(r.id, c.key, v)}
                      aria-label={`${r.code} ${c.label}`}
                    />
                  </label>
                ))}
                {extraColumns.map((c) => (
                  <div key={c.key} className="block">
                    <span className="form-label">{c.label}</span>
                    {c.cell(r)}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Wider: a table. */}
      <div className="border-border bg-card hidden overflow-x-auto rounded-lg border sm:block">
        <table className="data-table table-totals w-full">
          <thead>
            <tr className="bg-secondary">
              {select && (
                <th className="w-8">
                  {tickable.length > 0 && (
                    <input
                      type="checkbox"
                      className="accent-primary h-4 w-4 cursor-pointer"
                      checked={allOn}
                      ref={(el) => {
                        if (el) el.indeterminate = someOn && !allOn
                      }}
                      onChange={select.onAll}
                      aria-label="Tick every bundle"
                    />
                  )}
                </th>
              )}
              <th>Bundle</th>
              <th>Line · size</th>
              <th style={{ textAlign: 'right' }}>{availableLabel}</th>
              {columns.map((c) => (
                <th key={c.key} style={{ textAlign: 'right' }} className={`whitespace-nowrap ${c.bad ? 'warn-text' : ''}`}>
                  {c.label}
                </th>
              ))}
              {extraColumns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const over = rowTotal(values, r.id, columns) + heldOf(r.id) > r.available
              return (
                <tr key={r.id} className={select?.on(r.id) ? 'bg-primary/5' : undefined}>
                  {select && <td className="w-8">{tickBox(r)}</td>}
                  <td
                    className={`font-mono text-xs ${select?.can(r) ? 'cursor-pointer select-none' : ''}`}
                    onClick={select?.can(r) ? (e) => select.onTick(r.id, e.shiftKey) : undefined}
                  >
                    {r.code}
                  </td>
                  <td className="text-muted-foreground text-xs">
                    {[r.line, r.size ? `size ${r.size}` : null].filter(Boolean).join(' · ')}
                    {r.note ? <div className="text-[11px]">{r.note}</div> : null}
                  </td>
                  <td className={`text-right text-xs tabular-nums ${over ? 'text-destructive font-semibold' : ''}`}>{pcs(r.available)}</td>
                  {columns.map((c) => (
                    <td key={c.key} className="w-24">
                      <StepInput
                        className={`form-input h-8 text-right text-xs tabular-nums ${over ? 'border-destructive/60' : ''}`}
                        value={values[r.id]?.[c.key] ?? ''}
                        max={Math.max(0, r.available - heldOf(r.id))}
                        placeholder="0"
                        onValueChange={(v) => onChange(r.id, c.key, v)}
                        aria-label={`${r.code} ${c.label}`}
                      />
                    </td>
                  ))}
                  {extraColumns.map((c) => (
                    <td key={c.key} className={c.width}>
                      {c.cell(r)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="bg-secondary">
              <td colSpan={select ? 3 : 2} className="text-xs font-medium">
                Total
              </td>
              <td className="text-right text-xs tabular-nums">{pcs(totalAvailable)}</td>
              {columns.map((c) => (
                <td key={c.key} className="text-right text-xs font-semibold tabular-nums">
                  {pcs(colTotal(c.key))}
                </td>
              ))}
              {extraColumns.map((c) => (
                <td key={c.key} className="text-xs font-semibold">
                  {c.total ?? null}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
