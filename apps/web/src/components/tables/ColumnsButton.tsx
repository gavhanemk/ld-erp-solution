'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Columns3, RotateCcw } from 'lucide-react'

/**
 * Which of a table's optional columns are on, and a place to change that.
 *
 * A list like Goods Receipts carries more columns than any one screen size
 * can hold without hiding some of them — that is what the `col-full` /
 * `col-wide` / `col-roomy` tiers in globals.css already do, by width. This is
 * the other axis: a column somebody never reads gone for good, on their own
 * screen, at their own choice, rather than reappearing every time the window
 * happens to be wide enough for it.
 */
export function ColumnsButton({
  columns,
  visible,
  onToggle,
  onReset,
  disabled,
}: {
  columns: Array<{ key: string; label: string }>
  visible: Set<string>
  onToggle: (key: string) => void
  onReset: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  // Same reasoning as the export menu: measured off the button at the
  // moment of the press and drawn into the body, because `.glass-card`'s
  // backdrop-filter makes it the containing block for anything `fixed`
  // inside it.
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const needed = columns.length * 32 + 90
    const below = window.innerHeight - r.bottom - 12
    setPos({
      top: below < needed && r.top > needed ? r.top - needed - 6 : r.bottom + 6,
      right: Math.max(8, window.innerWidth - r.right),
    })
  }

  useEffect(() => {
    if (!open) return
    const shut = () => setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('resize', shut)
    window.addEventListener('scroll', shut, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', shut)
      window.removeEventListener('scroll', shut, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          place()
          setOpen(true)
        }}
        className="btn-ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose columns"
        title="Choose which columns this table shows"
      >
        <Columns3 size={15} />
        <span className="hidden sm:inline">Columns</span>
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
            <div
              role="menu"
              aria-label="Choose columns"
              className="border-border bg-card fixed z-50 max-h-[70vh] w-56 overflow-y-auto rounded-xl border py-1 shadow-xl"
              style={{ top: pos.top, right: pos.right }}
            >
              <div className="text-muted-foreground border-border flex items-center justify-between border-b px-3 py-2 text-xs font-semibold uppercase tracking-wider">
                Columns
                <button
                  type="button"
                  className="text-primary hover:text-primary/80 inline-flex items-center gap-1 font-normal normal-case tracking-normal"
                  onClick={onReset}
                >
                  <RotateCcw size={11} /> Reset
                </button>
              </div>
              {columns.map((c) => (
                <label
                  key={c.key}
                  className="hover:bg-secondary flex items-center gap-2.5 px-3 py-1.5 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={visible.has(c.key)}
                    onChange={() => onToggle(c.key)}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </>,
          document.body
        )}
    </>
  )
}
