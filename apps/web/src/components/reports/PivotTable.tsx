'use client'

import { useMemo, useState } from 'react'
import { LayoutGrid } from 'lucide-react'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * A pivot table, on screen.
 *
 * The Excel export has had a real PivotTable since the workbook was built —
 * something to drag fields on and regroup without going back to whoever ran
 * the report. This is the same idea without downloading anything: pick a
 * row field, an optional column field to cross it with, and a figure to
 * total, and the grid recomputes over every row the report returned rather
 * than only the "biggest twelve" the static summary table shows.
 *
 * It reads the same rows the preview table below it reads, so there is one
 * dataset on the screen and not two disagreeing about what "the report"
 * contains.
 */

export interface PivotColumn {
  key: string
  label: string
  type: string
  unit?: string
  badges?: Record<string, string>
}

const money = (v: number) =>
  `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function formatValue(v: number, col: PivotColumn): string {
  if (col.type === 'money') return money(v)
  if (col.type === 'integer') return v.toLocaleString('en-IN')
  return `${v.toLocaleString('en-IN', { maximumFractionDigits: 3 })}${col.unit ? ` ${col.unit}` : ''}`
}

/** What a row reads as under a dimension — the badge word, or a dash for nothing. */
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
  const dimensions = useMemo(
    () => columns.filter((c) => c.type === 'text' || c.type === 'badge' || c.type === 'date'),
    [columns]
  )
  const measures = useMemo(
    () => columns.filter((c) => c.type === 'money' || c.type === 'qty' || c.type === 'integer'),
    [columns]
  )

  const [rowKey, setRowKey] = useState(() => defaultRowKey ?? dimensions[0]?.key ?? '')
  const [colKey, setColKey] = useState(() => defaultColumnKey ?? NONE)
  const [valueKey, setValueKey] = useState(() => defaultValueKey ?? measures[0]?.key ?? '')

  const rowCol = dimensions.find((c) => c.key === rowKey)
  const columnCol = colKey === NONE ? undefined : dimensions.find((c) => c.key === colKey)
  const valueCol = measures.find((c) => c.key === valueKey)

  const pivot = useMemo(() => {
    if (!rowCol || !valueCol) return null

    const colLabels: string[] = []
    const seenCols = new Set<string>()
    const grid = new Map<string, Map<string, number>>()
    const rowTotals = new Map<string, number>()
    const colTotals = new Map<string, number>()
    let grandTotal = 0

    for (const r of rows) {
      const rLabel = labelFor(r, rowCol)
      const cLabel = columnCol ? labelFor(r, columnCol) : 'Total'
      const v = Number(r[valueCol.key] ?? 0)
      if (!Number.isFinite(v)) continue

      if (!seenCols.has(cLabel)) {
        seenCols.add(cLabel)
        colLabels.push(cLabel)
      }
      if (!grid.has(rLabel)) grid.set(rLabel, new Map())
      const line = grid.get(rLabel)!
      line.set(cLabel, (line.get(cLabel) ?? 0) + v)

      rowTotals.set(rLabel, (rowTotals.get(rLabel) ?? 0) + v)
      colTotals.set(cLabel, (colTotals.get(cLabel) ?? 0) + v)
      grandTotal += v
    }

    // Biggest row first — the same rule every ranking panel in this report follows.
    const rowLabels = [...rowTotals.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l)
    // Columns keep the order they were first seen in rather than being
    // re-sorted, so a status or stage column reads left to right the way the
    // workflow does instead of shuffling by whichever total happens biggest.
    return { rowLabels, colLabels, grid, rowTotals, colTotals, grandTotal }
  }, [rows, rowCol, columnCol, valueCol])

  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
        <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
          <LayoutGrid size={14} className="text-primary" />
          Pivot table
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <SmartSelect
            className="form-input h-8 w-auto px-2 py-0 text-xs"
            value={rowKey}
            onChange={(e) => setRowKey(e.target.value)}
            aria-label="Group rows by"
          >
            {dimensions.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </SmartSelect>
          <span className="text-muted-foreground text-xs">by</span>
          <SmartSelect
            className="form-input h-8 w-auto px-2 py-0 text-xs"
            value={colKey}
            onChange={(e) => setColKey(e.target.value)}
            aria-label="Cross with"
          >
            <option value={NONE}>Nothing (one column)</option>
            {dimensions
              .filter((c) => c.key !== rowKey)
              .map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
          </SmartSelect>
          <span className="text-muted-foreground text-xs">totalling</span>
          <SmartSelect
            className="form-input h-8 w-auto px-2 py-0 text-xs"
            value={valueKey}
            onChange={(e) => setValueKey(e.target.value)}
            aria-label="Value to total"
          >
            {measures.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </SmartSelect>
        </div>
      </div>

      {!pivot || rows.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm">
          {rows.length === 0
            ? 'Nothing to pivot for this period.'
            : 'Pick a field and a figure above to build the table.'}
        </p>
      ) : (
        <div className="max-h-[32rem] overflow-auto">
          <table className="subtable w-full">
            <thead>
              <tr>
                <th className="bg-card sticky left-0 top-0 z-20">{rowCol!.label}</th>
                {pivot.colLabels.map((c) => (
                  <th key={c} className="sticky top-0 z-10 text-right">
                    {c}
                  </th>
                ))}
                {pivot.colLabels.length > 1 && (
                  <th className="sticky top-0 z-10 text-right font-semibold">Total</th>
                )}
              </tr>
            </thead>
            <tbody>
              {pivot.rowLabels.map((r) => (
                <tr key={r}>
                  <td className="bg-card sticky left-0 z-10 whitespace-nowrap font-medium">{r}</td>
                  {pivot.colLabels.map((c) => {
                    const v = pivot.grid.get(r)?.get(c)
                    return (
                      <td key={c} className="whitespace-nowrap text-right tabular-nums">
                        {v ? formatValue(v, valueCol!) : '—'}
                      </td>
                    )
                  })}
                  {pivot.colLabels.length > 1 && (
                    <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                      {formatValue(pivot.rowTotals.get(r) ?? 0, valueCol!)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="bg-card sticky left-0 font-semibold">Total</td>
                {pivot.colLabels.map((c) => (
                  <td key={c} className="whitespace-nowrap text-right font-semibold tabular-nums">
                    {formatValue(pivot.colTotals.get(c) ?? 0, valueCol!)}
                  </td>
                ))}
                {pivot.colLabels.length > 1 && (
                  <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                    {formatValue(pivot.grandTotal, valueCol!)}
                  </td>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-muted-foreground border-border border-t px-4 py-2 text-[11px]">
        Every row the report returned, regrouped in the browser — not only the biggest few. Change
        the fields above to look at it a different way.
      </p>
    </div>
  )
}
