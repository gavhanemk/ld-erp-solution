'use client'

import { useState } from 'react'

/**
 * The summary in one table, under the KPI cards.
 *
 * The report's figures added up by the thing it is about — the supplier, the
 * customer, the item, the category — biggest first, with each one's share and
 * the grand total at the foot. Numbers only: the accounts team asked to see
 * the whole period at a glance without a chart to read it off.
 *
 * Worked out on the server, once: the workbook's Summary sheet prints the
 * same tables, and the foot is the detailed report's own grand total, so the
 * screen, the sheet and the Detailed Report tab cannot disagree.
 */

/** Mirrors the server's `SummaryGrid`. */
export interface SummaryGrid {
  key: string
  label: string
  counted: string
  figures: Array<{ key: string; label: string; type: string }>
  rows: Array<{ name: string; documents: number; values: SummaryValue[]; share: number | null }>
  total: { documents: number; values: SummaryValue[] }
  shared: boolean
}

/** A sum, or a quantity unit by unit — never metres and pieces added together. */
export type SummaryValue = number | Array<{ unit: string; value: number }> | null

const SHOWN = 12

const money = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const qty = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 3 })

/** "Job Worker" reads "job worker" mid-sentence; "HSN" stays "HSN". */
const inSentence = (s: string) =>
  s
    .split(' ')
    .map((w) => (/^[A-Z]{2}/.test(w) ? w : w.charAt(0).toLowerCase() + w.slice(1)))
    .join(' ')

function figure(type: string, v: SummaryValue): string {
  if (v == null) return '–'
  if (Array.isArray(v)) {
    return v.length ? v.map((u) => `${qty(u.value)} ${u.unit}`).join(' · ') : '–'
  }
  if (v === 0) return '–'
  if (type === 'money') return money(v)
  if (type === 'qty') return qty(v)
  return v.toLocaleString('en-IN')
}

export function SummaryTable({ grids }: { grids: SummaryGrid[] }) {
  const [chosen, setChosen] = useState(0)
  const [all, setAll] = useState(false)
  const grid = grids[chosen] ?? grids[0]
  if (!grid || grid.rows.length === 0) return null

  const shown = all ? grid.rows : grid.rows.slice(0, SHOWN)

  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <h3 className="text-foreground text-sm font-semibold">Totals by {inSentence(grid.label)}</h3>
        <span className="text-muted-foreground text-xs">
          {grid.rows.length.toLocaleString('en-IN')} in all, biggest first
        </span>
        {grids.length > 1 && (
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Total by">
            {grids.map((g, i) => (
              <button
                key={g.key}
                type="button"
                onClick={() => {
                  setChosen(i)
                  setAll(false)
                }}
                aria-pressed={g === grid}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  g === grid
                    ? 'bg-primary/10 text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                By {inSentence(g.label)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="subtable w-full">
          <thead>
            <tr>
              <th>{grid.label}</th>
              <th className="text-right">{grid.counted}</th>
              {grid.figures.map((f) => (
                <th key={f.key} className="text-right">
                  {f.label}
                </th>
              ))}
              {grid.shared && <th className="text-right">Share</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.name}>
                <td className="text-foreground font-medium">{r.name}</td>
                <td className="text-right tabular-nums">{r.documents.toLocaleString('en-IN')}</td>
                {grid.figures.map((f, i) => (
                  <td key={f.key} className="whitespace-nowrap text-right tabular-nums">
                    {figure(f.type, r.values[i])}
                  </td>
                ))}
                {grid.shared && (
                  <td className="text-muted-foreground whitespace-nowrap text-right tabular-nums">
                    {r.share == null ? '–' : `${(r.share * 100).toFixed(1)}%`}
                  </td>
                )}
              </tr>
            ))}
            <tr className="border-border border-t-2 font-semibold">
              <td className="text-foreground">Total</td>
              <td className="text-right tabular-nums">{grid.total.documents.toLocaleString('en-IN')}</td>
              {grid.figures.map((f, i) => (
                <td key={f.key} className="text-foreground whitespace-nowrap text-right tabular-nums">
                  {figure(f.type, grid.total.values[i])}
                </td>
              ))}
              {grid.shared && <td className="text-right tabular-nums">100%</td>}
            </tr>
          </tbody>
        </table>
      </div>

      {grid.rows.length > SHOWN && (
        <div className="border-border border-t px-4 py-2">
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="text-primary text-xs font-medium hover:underline"
          >
            {all ? `Show the biggest ${SHOWN}` : `Show all ${grid.rows.length.toLocaleString('en-IN')}`}
          </button>
        </div>
      )}
    </div>
  )
}
