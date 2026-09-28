'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'

export interface FilterChoice {
  value: string
  label: string
  /** How many records this choice would leave. Absent while counts load. */
  count?: number
}

/**
 * One filter on a list: a button that opens a small panel of tick boxes.
 *
 * Several choices can be ticked and mean "any of these". The panel has its own
 * search once the list is long enough to need one, so "cot" finds Cotton in a
 * list of thirty categories without scrolling. Each choice carries the number
 * of records it would leave, given everything else on screen, and the ones
 * that would leave nothing sink to the bottom, greyed, rather than vanishing —
 * a choice that disappears reads as a bug, one that says 0 reads as an answer.
 */
export function FilterMenu({
  label,
  choices,
  selected,
  onChange,
}: {
  label: string
  choices: FilterChoice[] | undefined
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Closes on a click anywhere else, and on Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      // After the panel is in the page, so the focus lands.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (choices ?? []).filter((c) => !q || c.label.toLowerCase().includes(q))
    // Ticked first, then those that would leave something, then the empty ones.
    const rank = (c: FilterChoice) =>
      selected.includes(c.value) ? 0 : c.count === 0 ? 2 : 1
    return [...list].sort((a, b) => rank(a) - rank(b))
  }, [choices, query, selected])

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])

  const summary =
    selected.length === 0
      ? null
      : selected.length === 1
        ? (choices?.find((c) => c.value === selected[0])?.label ?? '1 selected')
        : `${selected.length} selected`

  const searchable = (choices?.length ?? 0) > 6

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex h-10 items-center gap-1.5 rounded-lg border px-3 text-sm transition-colors ${
          selected.length
            ? 'border-primary/50 bg-primary/10 text-foreground'
            : 'border-border bg-secondary text-muted-foreground hover:text-foreground'
        }`}
      >
        <span className={`flex min-w-0 ${selected.length ? 'font-medium' : ''}`}>
          {label}
          {summary && <span className="text-primary max-w-[9rem] truncate">: {summary}</span>}
        </span>
        <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="bg-card border-border absolute left-0 top-full z-40 mt-1.5 w-72 overflow-hidden rounded-xl border shadow-xl">
          {searchable && (
            <div className="border-border flex items-center gap-2 border-b px-3 py-2">
              <Search size={14} className="text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Enter takes the first match, so "den" ⏎ ticks Denim.
                  if (e.key === 'Enter' && shown[0]) {
                    e.preventDefault()
                    toggle(shown[0].value)
                  }
                }}
                placeholder={`Search ${label.toLowerCase()}...`}
                className="text-foreground placeholder:text-muted-foreground w-full bg-transparent text-sm focus:outline-none"
              />
            </div>
          )}

          <ul className="max-h-72 overflow-y-auto py-1" role="listbox" aria-multiselectable="true">
            {choices === undefined && (
              <li className="text-muted-foreground px-3 py-2 text-sm">Loading...</li>
            )}
            {choices !== undefined && shown.length === 0 && (
              <li className="text-muted-foreground px-3 py-2 text-sm">
                {query ? `Nothing matches "${query}"` : 'Nothing to choose from'}
              </li>
            )}
            {shown.map((c) => {
              const on = selected.includes(c.value)
              return (
                <li key={c.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={() => toggle(c.value)}
                    className={`hover:bg-secondary flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm ${
                      c.count === 0 && !on ? 'text-muted-foreground/60' : 'text-foreground'
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        on ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                      }`}
                    >
                      {on && <Check size={11} strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    {c.count !== undefined && (
                      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {c.count}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>

          {selected.length > 0 && (
            <div className="border-border flex items-center justify-between border-t px-3 py-2">
              <span className="text-muted-foreground text-xs">{selected.length} ticked</span>
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-primary flex items-center gap-1 text-xs font-medium hover:underline"
              >
                <X size={12} />
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
