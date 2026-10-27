'use client'

import { useMemo, useState } from 'react'
import type { RegisterColumnDef, RegisterSpec, RegisterTotal } from './RegisterSheet'

/**
 * The summary in one table, under the KPI cards.
 *
 * The report's figures added up by the thing it is about — the supplier, the
 * customer, the item, the category — biggest first, with each one's share and
 * the grand total at the foot. Numbers only: the accounts team asked to see
 * the whole period at a glance without a chart to read it off.
 *
 * The foot is the detailed report's own grand total, not a second sum, so the
 * two tabs cannot disagree.
 */

const SHOWN = 12

const money = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const qty = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 3 })

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
})

/** A group's name as the register prints it: a status in words, a date as a date. */
function groupName(c: RegisterColumnDef | undefined, v: unknown): string {
  if (v == null || v === '') return '—'
  if (c?.type === 'badge') return c.badges?.[String(v)] ?? String(v)
  if (c?.type === 'date') {
    const d = new Date(String(v))
    return Number.isNaN(d.getTime()) ? String(v) : DAY.format(d)
  }
  return String(v)
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** "Supplier" reads "supplier" mid-sentence; "HSN" stays "HSN". */
const inSentence = (s: string) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1))

interface Group {
  name: string
  documents: Set<unknown>
  sums: Map<string, number>
  units: Map<string, Map<string, number>>
}

export function SummaryTable({
  columns,
  rows,
  spec,
  grand,
  groupKeys,
  valueKeys,
}: {
  columns: RegisterColumnDef[]
  rows: Array<Record<string, unknown>>
  spec: RegisterSpec
  /** The detailed report's grand total, printed at the foot. */
  grand: RegisterTotal
  /** What the report groups by, in its own order. The first is shown first. */
  groupKeys: string[]
  /** The figures to total. */
  valueKeys: string[]
}) {
  const byKey = new Map(columns.map((c) => [c.key, c]))

  // What the table can group by. A report that names none is grouped by its
  // first column of words.
  const options = useMemo(() => {
    const named = groupKeys.filter((k) => byKey.has(k))
    if (named.length) return named
    const words = columns.find((c) => c.type === 'text' || c.type === 'badge')
    return words ? [words.key] : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKeys, columns])
  const [chosen, setChosen] = useState<string | null>(null)
  const group = chosen && options.includes(chosen) ? chosen : options[0]
  const [all, setAll] = useState(false)

  // The figures that add up. A report that names none totals every one that does.
  const figures = useMemo(() => {
    const named = valueKeys.map((k) => byKey.get(k)).filter((c) => c?.total === 'sum')
    const list = named.length ? named : columns.filter((c) => c.total === 'sum')
    return list as RegisterColumnDef[]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKeys, columns])
  // The share column is of the first money figure — what the period is measured in.
  const money0 = figures.find((c) => c.type === 'money')

  const groups = useMemo(() => {
    if (!group) return []
    const map = new Map<string, Group>()
    const isVoid = (r: Record<string, unknown>) =>
      spec.void != null && r[spec.void.key] === spec.void.value
    rows.forEach((r, i) => {
      const name = groupName(byKey.get(group), r[group])
      let g = map.get(name)
      if (!g) {
        g = { name, documents: new Set(), sums: new Map(), units: new Map() }
        map.set(name, g)
      }
      if (!isVoid(r)) g.documents.add(spec.documentKey ? r[spec.documentKey] : i)
      for (const c of figures) {
        const v = r[c.key]
        if (v == null || v === '') continue
        const n = Number(v)
        if (!Number.isFinite(n)) continue
        if (c.type === 'qty' && c.unitKey) {
          // Metres with metres, pieces with pieces — never one total of both.
          const unit = String(r[c.unitKey] ?? '') || 'units'
          const per = g.units.get(c.key) ?? new Map<string, number>()
          per.set(unit, (per.get(unit) ?? 0) + n)
          g.units.set(c.key, per)
        } else {
          g.sums.set(c.key, (g.sums.get(c.key) ?? 0) + n)
        }
      }
    })
    const size = (g: Group) => (money0 ? (g.sums.get(money0.key) ?? 0) : g.documents.size)
    return [...map.values()].sort((a, b) => size(b) - size(a))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, group, figures, spec, money0])

  // A share only means something of a figure that cannot go below nought: a
  // stock value that rose in one store and fell in another has no share of
  // the difference.
  const measure =
    money0 &&
    (grand.sums[money0.key] ?? 0) > 0 &&
    groups.every((g) => (g.sums.get(money0.key) ?? 0) >= 0)
      ? money0
      : undefined

  if (!group || rows.length === 0) return null

  const shown = all ? groups : groups.slice(0, SHOWN)
  const groupLabel = byKey.get(group)?.label ?? group
  const total = measure ? grand.sums[measure.key] ?? 0 : 0

  const cell = (c: RegisterColumnDef, g: Group) => {
    if (c.type === 'qty' && c.unitKey) {
      const per = g.units.get(c.key)
      if (!per?.size) return '–'
      return [...per.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([unit, n]) => `${qty(n)} ${unit}`)
        .join(' · ')
    }
    const n = g.sums.get(c.key) ?? 0
    if (n === 0) return '–'
    return c.type === 'money' ? money(n) : c.type === 'qty' ? qty(n) : n.toLocaleString('en-IN')
  }

  const grandCell = (c: RegisterColumnDef) => {
    if (c.type === 'qty' && c.unitKey) {
      const units = grand.byUnit[c.key] ?? []
      return units.length ? units.map((u) => `${qty(u.value)} ${u.unit}`).join(' · ') : '–'
    }
    const n = grand.sums[c.key] ?? 0
    if (n === 0) return '–'
    return c.type === 'money' ? money(n) : c.type === 'qty' ? qty(n) : n.toLocaleString('en-IN')
  }

  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <h3 className="text-foreground text-sm font-semibold">Totals by {inSentence(groupLabel)}</h3>
        <span className="text-muted-foreground text-xs">
          {groups.length.toLocaleString('en-IN')} in all, biggest first
        </span>
        {options.length > 1 && (
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Total by">
            {options.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setChosen(k)
                  setAll(false)
                }}
                aria-pressed={k === group}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  k === group
                    ? 'bg-primary/10 text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                By {inSentence(byKey.get(k)?.label ?? k)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="subtable w-full">
          <thead>
            <tr>
              <th>{groupLabel}</th>
              <th className="text-right">{capital(spec.noun.many)}</th>
              {figures.map((c) => (
                <th key={c.key} className="text-right">
                  {c.label}
                </th>
              ))}
              {measure && <th className="text-right">Share</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((g) => (
              <tr key={g.name}>
                <td className="text-foreground font-medium">{g.name}</td>
                <td className="text-right tabular-nums">{g.documents.size.toLocaleString('en-IN')}</td>
                {figures.map((c) => (
                  <td key={c.key} className="whitespace-nowrap text-right tabular-nums">
                    {cell(c, g)}
                  </td>
                ))}
                {measure && (
                  <td className="text-muted-foreground whitespace-nowrap text-right tabular-nums">
                    {total ? `${(((g.sums.get(measure.key) ?? 0) / total) * 100).toFixed(1)}%` : '–'}
                  </td>
                )}
              </tr>
            ))}
            <tr className="border-border border-t-2 font-semibold">
              <td className="text-foreground">Total</td>
              <td className="text-right tabular-nums">{grand.documents.toLocaleString('en-IN')}</td>
              {figures.map((c) => (
                <td key={c.key} className="text-foreground whitespace-nowrap text-right tabular-nums">
                  {grandCell(c)}
                </td>
              ))}
              {measure && <td className="text-right tabular-nums">{total ? '100%' : '–'}</td>}
            </tr>
          </tbody>
        </table>
      </div>

      {groups.length > SHOWN && (
        <div className="border-border border-t px-4 py-2">
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="text-primary text-xs font-medium hover:underline"
          >
            {all ? `Show the biggest ${SHOWN}` : `Show all ${groups.length.toLocaleString('en-IN')}`}
          </button>
        </div>
      )}
    </div>
  )
}
