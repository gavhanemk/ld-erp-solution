'use client'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Info, Trash2 } from 'lucide-react'
import type { SampleSpecGap } from '@ld-erp/shared'
import { isTyping } from '@/lib/keys'
import { cn } from '@/lib/utils'
import { ReasonDialog } from '@/components/ui/ReasonDialog'

/*
 * Pieces every tab of the specification editor uses: the table heading, a
 * row's move and remove buttons, the "are you sure" before something typed is
 * thrown away, and the list of what a tab still lacks.
 */

/** A labelled box, with a star when it must be filled before release and a hint under it. */
export function Field({
  label,
  children,
  hint,
  required,
}: {
  label: string
  children: React.ReactNode
  hint?: string
  required?: boolean
}) {
  return (
    <label className="block min-w-0">
      <span className="form-label">
        {label}
        {required && (
          <span className="text-primary ml-1" aria-label="required">
            *
          </span>
        )}
      </span>
      {children}
      {hint && (
        <span className="text-muted-foreground mt-1.5 block text-xs leading-relaxed">{hint}</span>
      )}
    </label>
  )
}

/** A grid's column heading, as the BOM and routing masters set theirs. */
export const TH =
  'px-2 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground'
/** A box inside a grid: the field, at the grid's tighter height. */
export const CELL = 'form-input h-9'
/** A figure worked out, not typed: looks like a box but takes no cursor. */
export const READOUT =
  'flex h-9 items-center justify-end gap-2 rounded-lg border border-border bg-secondary/60 px-3 text-sm tabular-nums'

/**
 * A row's buttons: earlier, later and remove. Remove is the row's own
 * (Alt+Delete presses it, with whatever question it asks).
 */
export function RowTools({
  index,
  count,
  noun,
  onMove,
  onRemove,
}: {
  index: number
  count: number
  /** What a row is: "point", "material line", "step". */
  noun: string
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      <button
        type="button"
        className="btn-ghost p-1"
        disabled={index === 0}
        onClick={() => onMove(-1)}
        aria-label={`Move ${noun} ${index + 1} up`}
        title="Move up"
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        className="btn-ghost p-1"
        disabled={index === count - 1}
        onClick={() => onMove(1)}
        aria-label={`Move ${noun} ${index + 1} down`}
        title="Move down"
      >
        <ArrowDown size={14} />
      </button>
      <button
        type="button"
        className="btn-ghost text-muted-foreground hover:text-destructive p-1"
        data-grid-remove
        onClick={onRemove}
        aria-label={`Remove ${noun} ${index + 1}`}
        title={`Remove this ${noun}`}
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

interface Ask {
  title: string
  description: string
  confirmLabel: string
  run: () => void
}
/**
 * Asks before something typed is thrown away, in the module's own themed box.
 * `ask` shows the question; `dialog` goes wherever the screen draws it.
 */
export function useConfirm() {
  const [pending, setPending] = useState<Ask | null>(null)
  const dialog = pending ? (
    <ReasonDialog
      title={pending.title}
      description={pending.description}
      confirmLabel={pending.confirmLabel}
      cancelLabel="Keep it"
      danger
      requireReason={false}
      onCancel={() => setPending(null)}
      onConfirm={() => {
        const run = pending.run
        setPending(null)
        run()
      }}
    />
  ) : null
  return { ask: setPending, dialog }
}

/**
 * Alt+↑ / Alt+↓ in a number box of a grid: the same box on the line above or
 * below, as in every line grid of the ERP. Caught before the box itself, which
 * would otherwise take the arrow as one more or one less; the plain arrows
 * still step the number.
 */
export function sameBoxOnLine(e: KeyboardEvent<HTMLElement>) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  const el = e.target
  // Only a number box (StepInput) takes the arrows itself; other boxes are
  // left to the keyboard layer, which also makes a new line past the last.
  if (!(el instanceof HTMLInputElement) || !isTyping(el)) return
  if (el.inputMode !== 'decimal' && el.inputMode !== 'numeric') return
  const row = el.closest('tr')
  const td = el.closest('td')
  const body = row?.parentElement
  if (!row || !td || !body) return
  e.preventDefault()
  e.stopPropagation()
  const rows = [...body.children].filter(
    (r): r is HTMLTableRowElement => r instanceof HTMLTableRowElement
  )
  const step = e.key === 'ArrowDown' ? 1 : -1
  for (let i = rows.indexOf(row) + step; i >= 0 && i < rows.length; i += step) {
    const cell = rows[i].cells[td.cellIndex]
    // A line with no box in this column (a quantity worked out, not typed) is passed over.
    const box = cell?.querySelector<HTMLElement>(
      'input:not([disabled]):not([type="checkbox"]), [role="combobox"]:not([disabled])'
    )
    if (box) {
      box.focus()
      if (box instanceof HTMLInputElement) box.select()
      return
    }
  }
}

/** What a tab still lacks before release, in the gaps' own words. */
export function TabGaps({ gaps, children }: { gaps: SampleSpecGap[]; children?: ReactNode }) {
  if (!gaps.length && !children) return null
  return (
    <div className="space-y-1.5">
      {gaps.length > 0 && (
        <div className="border-accent/40 bg-accent/5 rounded-lg border px-3 py-2.5">
          <p className="text-foreground text-xs font-semibold">Still to finish before release</p>
          <ul className="mt-1 space-y-0.5">
            {gaps.map((g, i) => (
              <li key={i} className="warn-text flex items-start gap-1.5 text-xs">
                <Info size={13} className="mt-px shrink-0" />
                {g.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {children}
    </div>
  )
}

/** A short warning that does not stop anything, such as a route with no check. */
export function Warn({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('warn-text flex items-start gap-1.5 text-xs', className)}>
      <Info size={13} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  )
}
