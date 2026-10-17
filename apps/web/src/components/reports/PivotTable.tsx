'use client'

import { useMemo, useState } from 'react'
import { LayoutGrid } from 'lucide-react'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Totals by group, on screen.
 *
 * The report's rows added up by whatever the reader picks — category, store,
 * job worker, month — optionally split into columns by a second field, over
 * every row the report returned rather than only the "biggest twelve" the
 * summary table shows. It reads the same rows as the table below it, so the
 * screen holds one dataset and not two disagreeing about what "the report"
 * contains.
 *
 * Quantities are added only within the same unit: 6,226 pcs and 537.2 mtr
 * are two figures, never "6,763.2". A quantity column without a unit of its
 * own takes each row's `uom`.
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

const NONE = '__none__'

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
  const dimensions = useMemo(() => columns.filter((c) => c.type === 'text' || c.type === 'badge' || c.type === 'date'), [columns])
  const measures = useMemo(() => columns.filter((c) => c.type === 'money' || c.type === 'qty' || c.type === 'integer'), [columns])
  // The biggest group comes first by money where the report has any, since rupees add up across items.
  const rankBy = useMemo(() => measures.find((c) => c.type === 'money'), [measures])

  const [rowKey, setRowKey] = useState(() => defaultRowKey ?? dimensions[0]?.key ?? '')
  const [colKey, setColKey] = useState(() => defaultColumnKey ?? NONE)
  const [valueKey, setValueKey] = useState(() => defaultValueKey ?? rankBy?.key ?? measures[0]?.key ?? '')

  const rowCol = dimensions.find((c) => c.key === rowKey)
  const columnCol = colKey === NONE ? undefined : dimensions.find((c) => c.key === colKey)
  const valueCol = measures.find((c) => c.key === valueKey)

  const pivot = useMemo(() => {
    if (!rowCol || !valueCol) return null
    const unitOf = (r: Record<string, unknown>) => (valueCol.type === 'qty' ? (valueCol.unit ?? String(r.uom ?? r.unit ?? '')) : '')

    const colLabels: string[] = []
    const grid = new Map<string, Map<string, Sums>>()
    const rowTotals = new Map<string, Sums>()
    const colTotals = new Map<string, Sums>()
    const grand: Sums = new Map()
    const counts = new Map<string, number>()
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
      counts.set(rLabel, (counts.get(rLabel) ?? 0) + 1)
      rank.set(rLabel, (rank.get(rLabel) ?? 0) + Number((rankBy ? r[rankBy.key] : v) ?? 0))
    }

    // Biggest first; columns keep the order they were first seen in, so a
    // status or stage reads left to right the way the work does.
    const rowLabels = [...rank.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l)
    const mixed = grand.size > 1
    return { rowLabels, colLabels, grid, rowTotals, colTotals, grand, counts, mixed }
  }, [rows, rowCol, columnCol, valueCol, rankBy])

  const split = !!pivot && pivot.colLabels.length > 1
  const sel = 'form-input h-8 w-auto px-2 py-0 text-xs'

  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="min-w-0">
          <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
            <LayoutGrid size={14} className="text-primary" />
            Totals by group
          </h3>
          <p className="text-muted-foreground text-[11px]">Add up the rows below by any field. Pick what to group by and what to add up.</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
            Group by
            <SmartSelect className={sel} value={rowKey} onChange={(e) => setRowKey(e.target.value)} aria-label="Group by">
              {dimensions.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </SmartSelect>
          </label>
          <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
            Show
            <SmartSelect className={sel} value={valueKey} onChange={(e) => setValueKey(e.target.value)} aria-label="What to add up">
              {measures.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </SmartSelect>
          </label>
          <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
            Columns
            <SmartSelect className={sel} value={colKey} onChange={(e) => setColKey(e.target.value)} aria-label="Split into columns by">
              <option value={NONE}>One total</option>
              {dimensions
                .filter((c) => c.key !== rowKey)
                .map((c) => (
                  <option key={c.key} value={c.key}>
                    One per {c.label.toLowerCase()}
                  </option>
                ))}
            </SmartSelect>
          </label>
        </div>
      </div>

      {!pivot || rows.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm">{rows.length === 0 ? 'No rows to add up for this period.' : 'Pick what to group by and what to add up.'}</p>
      ) : (
        <div className="max-h-[32rem] overflow-auto">
          <table className="subtable bg-card w-full">
            <thead>
              <tr>
                <th className="bg-secondary sticky left-0 top-0 z-20">{rowCol!.label}</th>
                <th className="sticky top-0 z-10 w-20 text-right">Rows</th>
                {pivot.colLabels.map((c) => (
                  <th key={c} className="sticky top-0 z-10 text-right">
                    {split ? c : valueCol!.label}
                  </th>
                ))}
                {split && <th className="sticky top-0 z-10 text-right font-semibold">Total</th>}
              </tr>
            </thead>
            <tbody>
              {pivot.rowLabels.map((r) => (
                <tr key={r}>
                  <td className="bg-card sticky left-0 z-10 whitespace-nowrap font-medium">{r}</td>
                  <td className="text-muted-foreground text-right tabular-nums">{pivot.counts.get(r)}</td>
                  {pivot.colLabels.map((c) => (
                    <td key={c} className="whitespace-nowrap text-right tabular-nums">
                      {formatSums(pivot.grid.get(r)?.get(c), valueCol!)}
                    </td>
                  ))}
                  {split && <td className="whitespace-nowrap text-right font-semibold tabular-nums">{formatSums(pivot.rowTotals.get(r), valueCol!)}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="bg-card sticky left-0 font-semibold">Total</td>
                <td className="text-right font-semibold tabular-nums">{rows.length}</td>
                {pivot.colLabels.map((c) => (
                  <td key={c} className="whitespace-nowrap text-right font-semibold tabular-nums">
                    {formatSums(pivot.colTotals.get(c), valueCol!)}
                  </td>
                ))}
                {split && <td className="whitespace-nowrap text-right font-semibold tabular-nums">{formatSums(pivot.grand, valueCol!)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-muted-foreground border-border border-t px-4 py-2 text-[11px]">
        {pivot?.mixed
          ? `Every row of the report is counted, not only the top few. The ${(valueCol?.label ?? 'quantity').toLowerCase()} figures are in different units, so each unit is added up on its own.`
          : 'Every row of the report is counted, not only the top few.'}
      </p>
    </div>
  )
}
