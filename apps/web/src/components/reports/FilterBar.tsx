'use client'

import { useMemo } from 'react'
import { CalendarRange, Check, Play, RotateCcw, SlidersHorizontal, X } from 'lucide-react'

/**
 * The filter bar above a report.
 *
 * It replaces a row of 32px boxes with 11px uppercase captions — the same
 * shrunken-control pattern the purchase forms were pulled back from, and it
 * read worse here because a report's filters decide what the numbers below
 * mean. Three things were missing rather than small:
 *
 *   - nothing said which filters were actually applied, so a figure that
 *     looked wrong and a filter left set from twenty minutes ago were
 *     indistinguishable;
 *   - a date range had to be typed twice, for periods people ask for by
 *     name — this month, last month, the financial year;
 *   - changing a filter re-styled nothing, so it was never clear whether
 *     what was on screen was the answer to the question now being asked.
 */

export interface Filter {
  key: string
  label: string
  type: 'date' | 'select' | 'text' | 'boolean'
  required?: boolean
  optionsFrom?: string
  options?: Array<{ value: string; label: string }>
  help?: string
}

type Values = Record<string, string>

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * India's financial year runs April to March, so "this year" in a mill office
 * is not the calendar one. A preset labelled FY that handed back January to
 * December would be wrong in a way nobody would question until filing.
 */
function fyStart(d: Date): Date {
  return new Date(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1)
}

function presets(): Array<{ label: string; from: Date; to: Date }> {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const fy = fyStart(now)
  // Quarters are counted off April too, for the same reason.
  const q = Math.floor(((m - 3 + 12) % 12) / 3)
  const qStart = new Date(fy.getFullYear(), 3 + q * 3, 1)

  return [
    { label: 'This month', from: new Date(y, m, 1), to: now },
    { label: 'Last month', from: new Date(y, m - 1, 1), to: new Date(y, m, 0) },
    { label: 'This quarter', from: qStart, to: now },
    { label: 'This FY', from: fy, to: now },
    {
      label: 'Last FY',
      from: new Date(fy.getFullYear() - 1, 3, 1),
      to: new Date(fy.getFullYear(), 2, 31),
    },
  ]
}

const DAY = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
const pretty = (iso: string) => (iso ? DAY.format(new Date(`${iso}T00:00:00`)) : '')

export function FilterBar({
  filters,
  values,
  applied,
  options,
  onChange,
  onRun,
  loading,
}: {
  filters: Filter[]
  values: Values
  /** What the result on screen was actually built from. */
  applied: Values
  options: Record<string, Array<{ id: string; name: string }>>
  onChange: (next: Values) => void
  onRun: () => void
  loading: boolean
}) {
  const dated = filters.some((f) => f.key === 'from') && filters.some((f) => f.key === 'to')
  const rest = filters.filter((f) => !(dated && (f.key === 'from' || f.key === 'to')))

  const set = (key: string, value: string) => onChange({ ...values, [key]: value })
  const setRange = (from: Date, to: Date) =>
    onChange({ ...values, from: ymd(from), to: ymd(to) })

  /** What each set filter says, in words, for the chips along the bottom. */
  const chips = useMemo(() => {
    const out: Array<{ key: string; text: string; clears: string[] }> = []

    if (values.from || values.to) {
      const text =
        values.from && values.to
          ? `${pretty(values.from)} – ${pretty(values.to)}`
          : values.from
            ? `From ${pretty(values.from)}`
            : `Up to ${pretty(values.to)}`
      out.push({ key: 'period', text, clears: ['from', 'to'] })
    }

    for (const f of rest) {
      const v = values[f.key]
      if (!v) continue
      let shown = v
      if (f.type === 'boolean') shown = 'Yes'
      else if (f.type === 'select') {
        shown =
          f.options?.find((o) => o.value === v)?.label ??
          options[f.optionsFrom ?? '']?.find((o) => o.id === v)?.name ??
          v
      }
      out.push({ key: f.key, text: `${f.label}: ${shown}`, clears: [f.key] })
    }
    return out
  }, [values, rest, options])

  const clear = (keys: string[]) => {
    const next = { ...values }
    for (const k of keys) delete next[k]
    onChange(next)
  }

  // Whether what is on screen still answers the question the bar is asking.
  const dirty = useMemo(() => {
    const tidy = (v: Values) =>
      JSON.stringify(
        Object.entries(v)
          .filter(([, x]) => x)
          .sort(([a], [b]) => a.localeCompare(b))
      )
    return tidy(values) !== tidy(applied)
  }, [values, applied])

  const missing = filters.filter((f) => f.required && !values[f.key]).map((f) => f.label)

  const field = (f: Filter) => {
    const id = `f-${f.key}`
    if (f.type === 'boolean') {
      const on = values[f.key] === 'true'
      return (
        <button
          id={id}
          type="button"
          onClick={() => set(f.key, on ? '' : 'true')}
          aria-pressed={on}
          className={`flex h-10 w-full items-center gap-2 rounded-lg border px-3 text-sm transition-colors ${
            on
              ? 'border-primary/40 bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:border-primary/30'
          }`}
        >
          <span
            className={`flex h-4 w-4 items-center justify-center rounded border ${
              on ? 'border-primary bg-primary' : 'border-border'
            }`}
          >
            {on && <Check size={11} className="text-primary-foreground" />}
          </span>
          {on ? 'Yes' : 'No'}
        </button>
      )
    }

    if (f.type === 'select') {
      return (
        <select
          id={id}
          className="form-input h-10 w-full text-sm"
          value={values[f.key] ?? ''}
          onChange={(e) => set(f.key, e.target.value)}
        >
          <option value="">All</option>
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {(options[f.optionsFrom ?? ''] ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )
    }

    return (
      <input
        id={id}
        type={f.type === 'date' ? 'date' : 'text'}
        className="form-input h-10 w-full text-sm"
        placeholder={f.type === 'text' ? 'Search…' : undefined}
        value={values[f.key] ?? ''}
        onChange={(e) => set(f.key, e.target.value)}
      />
    )
  }

  return (
    <div className="border-border bg-card rounded-xl border">
      <div className="border-border/70 flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <span className="bg-primary/10 border-primary/20 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border">
          <SlidersHorizontal size={14} className="text-primary" />
        </span>
        <h2 className="text-foreground text-[15px] font-semibold">Filters</h2>
        <span className="text-muted-foreground text-xs">
          {chips.length === 0
            ? 'Nothing set — showing everything on record'
            : `${chips.length} applied`}
        </span>
        {chips.length > 0 && (
          <button
            type="button"
            onClick={() => clear(filters.map((f) => f.key))}
            className="text-muted-foreground hover:text-foreground ml-auto flex items-center gap-1.5 text-xs transition-colors"
          >
            <RotateCcw size={12} /> Clear all
          </button>
        )}
      </div>

      <div className="space-y-4 p-4">
        {dated && (
          <div>
            <span className="form-label mb-1.5 flex items-center gap-1.5">
              <CalendarRange size={13} className="text-muted-foreground" />
              Period
            </span>
            <div className="flex flex-wrap gap-1.5">
              {presets().map((p) => {
                const on = values.from === ymd(p.from) && values.to === ymd(p.to)
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setRange(p.from, p.to)}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      on
                        ? 'border-primary/40 bg-primary/10 text-primary font-medium'
                        : 'border-border text-muted-foreground hover:border-primary/30 hover:text-foreground'
                    }`}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="date"
                aria-label="From"
                className="form-input h-10 w-[10.5rem] text-sm"
                value={values.from ?? ''}
                onChange={(e) => set('from', e.target.value)}
              />
              <span className="text-muted-foreground text-xs">to</span>
              <input
                type="date"
                aria-label="To"
                className="form-input h-10 w-[10.5rem] text-sm"
                value={values.to ?? ''}
                onChange={(e) => set('to', e.target.value)}
              />
            </div>
          </div>
        )}

        {rest.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((f) => (
              <div key={f.key} className="min-w-0">
                <label className="form-label mb-1.5 block" htmlFor={`f-${f.key}`}>
                  {f.label}
                  {f.required && <span className="ml-0.5 text-red-400">*</span>}
                </label>
                {field(f)}
                {f.help && <span className="form-help">{f.help}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-border/70 flex flex-wrap items-center gap-2 border-t px-4 py-3">
        {chips.map((c) => (
          <span
            key={c.key}
            className="border-border bg-secondary text-foreground flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
          >
            {c.text}
            <button
              type="button"
              onClick={() => clear(c.clears)}
              aria-label={`Clear ${c.text}`}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <X size={12} />
            </button>
          </span>
        ))}

        <div className="ml-auto flex items-center gap-2">
          {missing.length > 0 ? (
            <span className="text-xs text-red-400">
              {missing.join(' and ')} {missing.length === 1 ? 'is' : 'are'} required
            </span>
          ) : (
            dirty && <span className="text-xs text-amber-400">Filters changed</span>
          )}
          <button
            className="btn-primary h-10"
            onClick={onRun}
            disabled={loading || missing.length > 0}
          >
            <Play size={14} />
            {dirty ? 'Run report' : 'Re-run'}
          </button>
        </div>
      </div>
    </div>
  )
}
