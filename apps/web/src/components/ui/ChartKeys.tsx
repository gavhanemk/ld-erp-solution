'use client'

import { useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, CornerDownLeft } from 'lucide-react'

export interface ChartKey {
  /** What the bar or slice is called: "Fabric", "Oct 2026", "Shree Button House". */
  name: string
  /** Its figure, as the chart shows it: "₹1,20,000", "42 pcs". */
  value?: string
  /** What a click on it does. */
  pick: () => void
}

/**
 * A chart that can be read and opened from the keyboard.
 *
 * The chart library draws bars and slices that only a mouse can click. Round
 * the chart goes one focusable box: Tab reaches it, ← → (or ↑ ↓) step through
 * its bars or slices with a label saying which one and its figure, and Enter
 * does exactly what a click on that bar does. The label shows only when the
 * chart was reached with the keyboard; for the mouse nothing changes.
 */
export function ChartKeys({ label, items, children, className }: { label: string; items: ChartKey[]; children: ReactNode; className?: string }) {
  const [at, setAt] = useState(0)
  const [keyboard, setKeyboard] = useState(false)
  const n = items.length
  const here = items[Math.min(at, n - 1)]

  const onKey = (e: React.KeyboardEvent) => {
    if (!n || e.altKey || e.ctrlKey || e.metaKey) return
    const to = (i: number) => {
      e.preventDefault()
      setKeyboard(true)
      setAt(((i % n) + n) % n)
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to(at + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to(at - 1)
    else if (e.key === 'Home') to(0)
    else if (e.key === 'End') to(n - 1)
    else if ((e.key === 'Enter' || e.key === ' ') && here) {
      e.preventDefault()
      here.pick()
    }
  }

  return (
    <div
      tabIndex={n ? 0 : -1}
      role="group"
      aria-label={`${label}. Arrow keys choose, Enter opens.`}
      onKeyDown={onKey}
      onFocus={(e) => setKeyboard(e.currentTarget.matches(':focus-visible'))}
      onBlur={() => setKeyboard(false)}
      className={`relative rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] ${className ?? ''}`}
    >
      {children}
      {keyboard && here && (
        <div
          aria-live="polite"
          className="border-border bg-card text-foreground pointer-events-none absolute left-1/2 top-1 z-10 flex max-w-[90%] -translate-x-1/2 items-center gap-1.5 rounded-md border px-2 py-1 text-xs shadow-lg"
        >
          <ChevronLeft size={12} className="text-muted-foreground shrink-0" aria-hidden />
          <span className="truncate font-medium">{here.name}</span>
          {here.value && <span className="text-muted-foreground shrink-0 tabular-nums">{here.value}</span>}
          <span className="text-muted-foreground shrink-0 tabular-nums">
            · {Math.min(at, n - 1) + 1} of {n}
          </span>
          <ChevronRight size={12} className="text-muted-foreground shrink-0" aria-hidden />
          <CornerDownLeft size={11} className="text-primary shrink-0" aria-label="Enter opens" />
        </div>
      )}
    </div>
  )
}
