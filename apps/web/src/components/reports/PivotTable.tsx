'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, LayoutGrid } from 'lucide-react'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Totals by group, on screen.
 *
 * The report's rows added up by whatever the reader picks — category, store,
 * job worker, month — over every row the report returned rather than only
 * the "biggest twelve" the summary table shows. It reads the same rows as the
 * table below it, so the screen holds one dataset and not two disagreeing
 * about what "the report" contains.
 *
 * Read like the dashboard's ranking panels: each group's name with its figure
 * right beside it and a bar for its share, two columns on a wide screen —
 * never a name on the far left and its figure on the far right. Split by a
 * second field, it is a compact table sized to its figures.
 *
 * Quantities are added only within the same unit: 6,226 pcs and 537.2 mtr
 * are two figures, never "6,763.2". A quantity column without a unit of its
 * own takes each row's `uom`. Only figures the rows actually carry are
 * offered, so a column of blanks is never what opens.
 */

export interface PivotColumn {
  key: string
  label: string
  type: string
  unit?: string
  badges?: Record<string, string>
}

/** One total, unit by unit: a single entry for money and counts, one per unit for quantities. */
type Sums = Map<string, number>

const money = (v: number) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function formatSums(s: Sums | undefined, col: PivotColumn): string {
  const parts = [...(s ?? new Map<string, number>())].filter(([, v]) => Math.abs(v) > 0.0005)
  if (!parts.length) return '—'
  return parts
    .map(([unit, v]) => {
      if (col.type === 'money') return money(v)
      if (col.type === 'integer') return v.toLocaleString('en-IN')
      return `${v.toLocaleString('en-IN', { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`
    })
    .join(' · ')
}

const add = (s: Sums, unit: string, v: number) => s.set(unit, (s.get(unit) ?? 0) + v)

/** What a row reads as under a field — the badge word, the month for a date, or a dash for nothing. */
function labelFor(row: Record<string, unknown>, col: PivotColumn): string {
  const v = row[col.key]
  if (v == null || v === '') return '—'
  if (col.type === 'badge') return col.badges?.[String(v)] ?? String(v)
  if (col.type === 'date') {
    const d = new Date(String(v))
    if (Number.isNaN(d.getTime())) return String(v)
    return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
  }
  return String(v)
}

const pct = (share: number) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`)

const NONE = '__none__'
/** Groups shown before "Show all". */
const FIRST = 12

export function PivotTable({
  columns,
  rows,
  defaultRowKey,
  defaultColumnKey,
  defaultValueKey,
}: {
  columns: PivotColumn[]
  rows: Array<Record<string, unknown>>
  defaultRowKey?: string
  defaultColumnKey?: string
  defaultValueKey?: string
}) {
  // Only fields with something in them to group by, and figures with something to add up.
  const dimensions = useMemo(
    () => columns.filter((c) => (c.type === 'text' || c.type === 'badge' || c.type === 'date') && rows.some((r) => r[c.key] != null && r[c.key] !== '')),
    [columns, rows],
  )
  const measures = useMemo(
    () => columns.filter((c) => (c.type === 'money' || c.type === 'qty' || c.type === 'integer') && rows.some((r) => Math.abs(Number(r[c.key] ?? 0)) > 0.0005)),
    [columns, rows],
  )
  const rankBy = useMemo(() => measures.find((c) => c.type === 'money'), [measures])

  const [rowKey, setRowKey] = useState(defaultRowKey ?? '')
  const [colKey, setColKey] = useState(defaultColumnKey ?? NONE)
  const [valueKey, setValueKey] = useState(defaultValueKey ?? '')
  const [all, setAll] = useState(false)

  // A pick that has nothing in it this run falls back to one that has.
  const rowCol = dimensions.find((c) => c.key === rowKey) ?? dimensions[0]
  const columnCol = colKey === NONE ? undefined : dimensions.find((c) => c.key === colKey && c.key !== rowCol?.key)
  const valueCol = measures.find((c) => c.key === valueKey) ?? rankBy ?? measures[0]

  const pivot = useMemo(() => {
    if (!rowCol || !valueCol) return null
    const unitOf = (r: Record<string, unknown>) => (valueCol.type === 'qty' ? (valueCol.unit ?? String(r.uom ?? r.unit ?? '')) : '')

    const colLabels: string[] = []
    const grid = new Map<string, Map<string, Sums>>()
    const rowTotals = new Map<string, Sums>()
    const colTotals = new Map<string, Sums>()
    const grand: Sums = new Map()
    const rank = new Map<string, number>()

    for (const r of rows) {
      const v = Number(r[valueCol.key] ?? 0)
      if (!Number.isFinite(v)) continue
      const rLabel = labelFor(r, rowCol)
      const cLabel = columnCol ? labelFor(r, columnCol) : 'Total'
      const unit = unitOf(r)
      if (!colLabels.includes(cLabel)) colLabels.push(cLabel)
      if (!grid.has(rLabel)) grid.set(rLabel, new Map())
      const line = grid.get(rLabel)!
      if (!line.has(cLabel)) line.set(cLabel, new Map())
      add(line.get(cLabel)!, unit, v)
      if (!rowTotals.has(rLabel)) rowTotals.set(rLabel, new Map())
      add(rowTotals.get(rLabel)!, unit, v)
      if (!colTotals.has(cLabel)) colTotals.set(cLabel, new Map())
      add(colTotals.get(cLabel)!, unit, v)
      add(grand, unit, v)
      rank.set(rLabel, (rank.get(rLabel) ?? 0) + Number((rankBy ? r[rankBy.key] : v) ?? 0))
    }

    const mixed = grand.size > 1
    /**
     * A group's share of the total, for its bar. Only when every figure is in
     * one unit (or rupees): a share of "all the rolls" beside a share of "all
     * the pieces" reads as a ranking it is not.
     */
    const shareOf = (label: string) => {
      const s = rowTotals.get(label)
      if (mixed || !s || s.size !== 1) return null
      const [unit, v] = [...s][0]
      const whole = grand.get(unit) ?? 0
      return whole > 0 && v > 0 ? v / whole : null
    }
    const first = (s: Sums | undefined) => (s ? ([...s.values()][0] ?? 0) : 0)
    // Biggest first by the figure shown; with several units, by value where there is one.
    const rowLabels = [...rowTotals.keys()].sort((a, b) => (mixed ? (rank.get(b) ?? 0) - (rank.get(a) ?? 0) : first(rowTotals.get(b)) - first(rowTotals.get(a))))
    return { rowLabels, colLabels, grid, rowTotals, colTotals, grand, mixed, shareOf }
  }, [rows, rowCol, columnCol, valueCol, rankBy])

  const split = !!pivot && !!columnCol
  const shown = pivot ? (all ? pivot.rowLabels : pivot.rowLabels.slice(0, FIRST)) : []
  const sel = 'form-input h-8 w-auto px-2 py-0 text-xs'

  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="min-w-0">
          <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
            <LayoutGrid size={14} className="text-primary" />
            Totals by group
          </h3>
          <p className="text-muted-foreground text-[11px]">Pick what to group by and which figure to add up.</p>
        </div>
        {rowCol && valueCol && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
              Group by
              <SmartSelect className={sel} value={rowCol.key} onChange={(e) => setRowKey(e.target.value)} aria-label="Group by">
                {dimensions.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </SmartSelect>
            </label>
            <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
              Show
              <SmartSelect className={sel} value={valueCol.key} onChange={(e) => setValueKey(e.target.value)} aria-label="Figure to add up">
                {measures.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </SmartSelect>
            </label>
            <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
              Split by
              <SmartSelect className={sel} value={columnCol?.key ?? NONE} onChange={(e) => setColKey(e.target.value)} aria-label="Split into columns by">
                <option value={NONE}>Nothing</option>
                {dimensions
                  .filter((c) => c.key !== rowCol.key)
                  .map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
              </SmartSelect>
            </label>
          </div>
        )}
      </div>

      {!pivot || rows.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm">
          {rows.length === 0 ? 'No rows to add up for this period.' : 'There are no figures to add up in this report’s rows.'}
        </p>
      ) : split ? (
        // A second field: a compact table sized to its figures, scrolling sideways when wide.
        <div className="max-h-[32rem] overflow-auto px-4 py-3">
          <table className="subtable w-auto min-w-[20rem]">
            <thead>
              <tr>
                <th className="bg-secondary sticky left-0 top-0 z-20 max-w-[16rem]">{rowCol!.label}</th>
                {pivot.colLabels.map((c) => (
                  <th key={c} className="sticky top-0 z-10 whitespace-nowrap pl-6 text-right">
                    {c}
                  </th>
                ))}
                {pivot.colLabels.length > 1 && <th className="sticky top-0 z-10 pl-6 text-right">Total</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r}>
                  <td className="bg-card sticky left-0 z-10 max-w-[16rem] truncate font-medium" title={r}>
                    {r}
                  </td>
                  {pivot.colLabels.map((c) => (
                    <td key={c} className="whitespace-nowrap pl-6 text-right tabular-nums">
                      {formatSums(pivot.grid.get(r)?.get(c), valueCol!)}
                    </td>
                  ))}
                  {pivot.colLabels.length > 1 && <td className="whitespace-nowrap pl-6 text-right font-semibold tabular-nums">{formatSums(pivot.rowTotals.get(r), valueCol!)}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="bg-card sticky left-0">Total</td>
                {pivot.colLabels.map((c) => (
                  <td key={c} className="whitespace-nowrap pl-6 text-right tabular-nums">
                    {formatSums(pivot.colTotals.get(c), valueCol!)}
                  </td>
                ))}
                {pivot.colLabels.length > 1 && <td className="whitespace-nowrap pl-6 text-right tabular-nums">{formatSums(pivot.grand, valueCol!)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        // One figure per group: name and figure side by side, a bar for its share.
        <div className="px-4 py-2">
          {/* Down the first column, then the second, so the biggest read top to bottom. */}
          <ul className="gap-x-10 md:columns-2">
            {shown.map((r) => {
              const share = pivot.shareOf(r)
              return (
                <li key={r} className="border-border/40 break-inside-avoid border-b py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-foreground min-w-0 truncate text-sm" title={r}>
                      {r}
                    </span>
                    <span className="text-foreground whitespace-nowrap text-sm font-semibold tabular-nums">{formatSums(pivot.rowTotals.get(r), valueCol!)}</span>
                  </div>
                  {share != null && (
                    <div className="mt-1 flex items-center gap-2" aria-hidden>
                      <div className="bg-secondary h-1.5 flex-1 overflow-hidden rounded-full">
                        <div className="bg-primary h-full rounded-full" style={{ width: `${Math.max(1, Math.round(share * 100))}%` }} />
                      </div>
                      <span className="text-muted-foreground w-9 text-right text-[11px] tabular-nums">{pct(share)}</span>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {/* The total sits under the first column, at its width, so it reads like the rows above it. */}
          <div className="flex items-baseline justify-between gap-3 py-2.5 md:w-[calc(50%-1.25rem)]">
            <span className="text-foreground text-sm font-semibold">Total</span>
            <span className="text-foreground text-right text-sm font-semibold tabular-nums">{formatSums(pivot.grand, valueCol!)}</span>
          </div>
        </div>
      )}

      {pivot && pivot.rowLabels.length > FIRST && (
        <div className="border-border border-t px-4 py-2">
          <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => setAll((a) => !a)}>
            {all ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {all ? `Show the top ${FIRST}` : `Show all ${pivot.rowLabels.length}`}
          </button>
        </div>
      )}
      {pivot?.mixed && (
        <p className="text-muted-foreground border-border border-t px-4 py-2 text-[11px]">
          These figures are in different units, so each unit is added up on its own.
        </p>
      )}
    </div>
  )
}
