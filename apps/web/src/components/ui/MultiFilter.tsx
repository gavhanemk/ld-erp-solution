'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FilterOption {
  value: string
  label: string
  /** A second, smaller line: an item's code, a size's run. */
  sub?: string | null
  /** How many rows have it, shown on the right. */
  lines?: number
}

/**
 * A filter as a small button: it opens a list to search and tick several
 * values. Ticked, the button shows how many; the list keeps the ticked ones
 * at the top so they are easy to untick.
 */
export function MultiFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: FilterOption[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [alignRight, setAlignRight] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const shown = useMemo(() => {
    const t = query.trim().toLowerCase()
    const hits = t ? options.filter((o) => o.label.toLowerCase().includes(t) || (o.sub ?? '').toLowerCase().includes(t)) : options
    const picked = hits.filter((o) => selected.includes(o.value))
    return [...picked, ...hits.filter((o) => !selected.includes(o.value))].slice(0, 300)
  }, [options, query, selected])

  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          const r = box.current?.getBoundingClientRect()
          setAlignRight(Boolean(r && r.left + 300 > window.innerWidth))
          setOpen((o) => !o)
          setQuery('')
        }}
        className={cn(
          'flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border px-2 text-xs font-medium transition-colors',
          selected.length ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-secondary text-foreground hover:border-primary/50',
        )}
      >
        {label}
        {selected.length > 0 && <span className="bg-primary text-primary-foreground rounded px-1 text-[10px] tabular-nums">{selected.length}</span>}
        <ChevronDown size={12} className="opacity-70" />
      </button>
      {open && (
        <div className={cn('bg-popover border-border absolute top-9 z-50 w-72 rounded-lg border shadow-lg', alignRight ? 'right-0' : 'left-0')}>
          <div className="border-border flex items-center gap-2 border-b px-2.5 py-2">
            <Search size={13} className="text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="text-foreground placeholder:text-muted-foreground flex-1 bg-transparent text-xs focus:outline-none"
              aria-label={`Search ${label}`}
            />
          </div>
          <ul role="listbox" aria-multiselectable="true" aria-label={label} className="max-h-64 overflow-y-auto p-1">
            {shown.map((o) => {
              const on = selected.includes(o.value)
              return (
                <li key={o.value} role="option" aria-selected={on}>
                  <button type="button" onClick={() => toggle(o.value)} className="hover:bg-secondary flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs">
                    <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                      {on && <Check size={11} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate">{o.label}</span>
                      {o.sub && <span className="text-muted-foreground block truncate text-[10px]">{o.sub}</span>}
                    </span>
                    {o.lines !== undefined && <span className="text-muted-foreground text-[10px] tabular-nums">{o.lines}</span>}
                  </button>
                </li>
              )
            })}
            {shown.length === 0 && <li className="text-muted-foreground px-2 py-3 text-center text-xs">{options.length ? 'Nothing matches' : 'Nothing to pick yet'}</li>}
          </ul>
          {selected.length > 0 && (
            <div className="border-border flex items-center justify-between border-t px-2.5 py-1.5">
              <span className="text-muted-foreground text-[11px]">{selected.length} picked</span>
              <button type="button" className="text-muted-foreground hover:text-foreground text-[11px] font-medium" onClick={() => onChange([])}>
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
