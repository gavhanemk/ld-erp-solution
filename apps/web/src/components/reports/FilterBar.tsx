'use client'

import { useMemo } from 'react'
import { Check, Play, RotateCcw, SlidersHorizontal, X } from 'lucide-react'
import { presetFor, presets, ymd } from '@/lib/period'

/**
 * The filter bar above a report — one row of it.
 *
 * It was a stacked form: presets on their own line, a date range under them,
 * then a grid of labelled fields each with a line of help beneath. Correct,
 * and it took half the screen before a single figure appeared. On a report the
 * filters are the question, not the answer; they belong on one band at the top
 * that can be read across in a second and then ignored.
 *
 * Nothing was dropped to get there. The named periods became a dropdown, the
 * stacked labels went into the controls themselves — a select that says "All
 * suppliers" needs no caption over it — and every line of help became the
 * control's tooltip. What is actually set still prints as chips along the
 * bottom, because a filter you cannot see is the reason a figure looks wrong.
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

/* The presets and the financial-year rule live in `@/lib/period` — the notes
   screens offer the same ones, and two copies would have been two definitions
   of the financial year. */

const DAY = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
const pretty = (iso: string) => (iso ? DAY.format(new Date(`${iso}T00:00:00`)) : '')

/**
 * "All suppliers", "All statuses" — the caption, moved inside the control.
 *
 * A select whose empty option names what it filters does not need a label
 * above it, and that label was costing a whole row of the page.
 */
function plural(label: string): string {
  const l = label.toLowerCase()
  if (l.endsWith('s')) return `${l}es`
  if (l.endsWith('y')) return `${l.slice(0, -1)}ies`
  return `${l}s`
}

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

  /** Which named period the current dates are, if they are one. */
  const activePreset = presetFor(values.from ?? '', values.to ?? '')

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

  const CONTROL = 'form-input h-9 text-sm'

  /** One control, captioned by itself. Help rides as the tooltip. */
  const field = (f: Filter) => {
    if (f.type === 'boolean') {
      const on = values[f.key] === 'true'
      return (
        <button
          key={f.key}
          type="button"
          title={f.help}
          onClick={() => set(f.key, on ? '' : 'true')}
          aria-pressed={on}
          className={`flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm transition-colors ${
            on
              ? 'border-primary/40 bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:border-primary/30'
          }`}
        >
          <span
            className={`flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border ${
              on ? 'border-primary bg-primary' : 'border-border'
            }`}
          >
            {on && <Check size={9} className="text-primary-foreground" />}
          </span>
          {f.label}
        </button>
      )
    }

    if (f.type === 'select') {
      return (
        <select
          key={f.key}
          title={f.help}
          aria-label={f.label}
          className={`${CONTROL} w-[9.5rem]`}
          value={values[f.key] ?? ''}
          onChange={(e) => set(f.key, e.target.value)}
        >
          <option value="">All {plural(f.label)}</option>
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
        key={f.key}
        type={f.type === 'date' ? 'date' : 'text'}
        title={f.help}
        aria-label={f.label}
        className={`${CONTROL} ${f.type === 'text' ? 'w-[11rem]' : 'w-[9rem]'}`}
        placeholder={f.type === 'text' ? (f.help ?? 'Search…') : undefined}
        value={values[f.key] ?? ''}
        onChange={(e) => set(f.key, e.target.value)}
      />
    )
  }

  return (
    <div className="border-border bg-card rounded-xl border">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <span className="bg-primary/10 border-primary/20 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border">
          <SlidersHorizontal size={14} className="text-primary" />
        </span>

        {dated && (
          <>
            <select
              aria-label="Period"
              className={`${CONTROL} w-[8.5rem]`}
              value={activePreset}
              onChange={(e) => {
                const p = presets().find((x) => x.label === e.target.value)
                // "Custom" clears the dates rather than inventing a range —
                // the two boxes beside it are where a custom one is typed.
                onChange(
                  p
                    ? { ...values, from: ymd(p.from), to: ymd(p.to) }
                    : { ...values, from: '', to: '' }
                )
              }}
            >
              <option value="">Custom period</option>
              {presets().map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label}
                </option>
              ))}
            </select>
            <input
              type="date"
              aria-label="From"
              title="From"
              className={`${CONTROL} w-[8.75rem]`}
              value={values.from ?? ''}
              onChange={(e) => set('from', e.target.value)}
            />
            <span className="text-muted-foreground shrink-0 text-xs">to</span>
            <input
              type="date"
              aria-label="To"
              title="To"
              className={`${CONTROL} w-[8.75rem]`}
              value={values.to ?? ''}
              onChange={(e) => set('to', e.target.value)}
            />
          </>
        )}

        {rest.map(field)}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {missing.length > 0 && (
            <span className="text-xs text-red-400">
              {missing.join(' and ')} {missing.length === 1 ? 'is' : 'are'} required
            </span>
          )}
          {chips.length > 0 && (
            <button
              type="button"
              onClick={() => clear(filters.map((f) => f.key))}
              title="Clear every filter"
              className="text-muted-foreground hover:text-foreground flex h-9 items-center gap-1.5 px-1 text-xs transition-colors"
            >
              <RotateCcw size={13} />
            </button>
          )}
          <button
            className={`btn-primary h-9 ${dirty ? '' : 'opacity-90'}`}
            onClick={onRun}
            disabled={loading || missing.length > 0}
          >
            <Play size={13} />
            {dirty ? 'Run' : 'Re-run'}
          </button>
        </div>
      </div>

      {/* Only when something is set. An empty strip under every report is a
        row of nothing that still costs a row. */}
      {chips.length > 0 && (
        <div className="border-border/70 flex flex-wrap items-center gap-1.5 border-t px-3 py-2">
          {dirty && (
            <span className="mr-1 text-[11px] font-medium text-amber-400">Not run yet:</span>
          )}
          {chips.map((c) => (
            <span
              key={c.key}
              className="border-border bg-secondary text-foreground flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px]"
            >
              {c.text}
              <button
                type="button"
                onClick={() => clear(c.clears)}
                aria-label={`Clear ${c.text}`}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
