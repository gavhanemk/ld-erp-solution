'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  LayoutDashboard,
  Loader2,
} from 'lucide-react'
import type { ExportFormat } from '@/lib/export'

/**
 * Takes a list off the screen and into a spreadsheet.
 *
 * Three things, because they are not the same thing to the people who ask for
 * them. The report is a workbook that opens on a dashboard — charts, a pivot
 * table, and the rows on their own sheet behind it — and is what goes to
 * somebody who has to decide something. Excel is the grid as it appears on
 * screen, for somebody who wants to work on it. CSV is what another system
 * reads. None of the three is a fallback for the others.
 *
 * The work itself belongs to the page: only the page knows which filters are
 * set, and an export that quietly ignored them would be the wrong list.
 */
type Choice = ExportFormat | 'report'

export function ExportButton({
  onExport,
  onReport,
  disabled,
  label = 'Export',
}: {
  onExport: (format: ExportFormat) => Promise<void> | void
  /**
   * Builds the full report for this screen, filters and all.
   *
   * Optional: a screen with no report behind it shows the two plain formats
   * and nothing else, rather than an item that explains why it is greyed out.
   */
  onReport?: () => Promise<void> | void
  disabled?: boolean
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<Choice | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  // Measured at the moment of the press, off the button's own rectangle —
  // the same reasoning as the row actions menu, and the same reason it is
  // drawn into the body: `.glass-card` carries a `backdrop-filter`, which
  // makes it the containing block for anything `fixed` inside it.
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    // The report row is two lines tall, so the menu it has to fit is a
    // different height from the one it does not.
    const needed = (onReport ? 54 + 2 * 38 : 2 * 38) + 16
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

  const run = async (choice: Choice) => {
    setOpen(false)
    setBusy(choice)
    try {
      if (choice === 'report') await onReport?.()
      else await onExport(choice)
    } finally {
      setBusy(null)
    }
  }

  const ITEM =
    'text-foreground hover:bg-secondary flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors'

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled || busy !== null}
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
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
        {busy ? 'Preparing...' : label}
        {!busy && <ChevronDown size={13} />}
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
            <div
              role="menu"
              aria-label={label}
              className="border-border bg-card fixed z-50 min-w-[17rem] overflow-hidden rounded-xl border py-1 shadow-xl"
              style={{ top: pos.top, right: pos.right }}
            >
              {onReport && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className={`${ITEM} items-start`}
                    onClick={() => void run('report')}
                  >
                    <LayoutDashboard size={15} className="text-primary mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="block">Detailed report (.xlsx)</span>
                      <span className="text-muted-foreground block text-xs leading-snug">
                        Dashboard, charts and a pivot table, with the rows behind them
                      </span>
                    </span>
                  </button>
                  <div className="border-border my-1 border-t" role="separator" />
                </>
              )}
              <button
                type="button"
                role="menuitem"
                className={ITEM}
                onClick={() => void run('xlsx')}
              >
                <FileSpreadsheet size={15} className="text-emerald-400" />
                Excel (.xlsx)
              </button>
              <button
                type="button"
                role="menuitem"
                className={ITEM}
                onClick={() => void run('csv')}
              >
                <FileText size={15} className="text-muted-foreground" />
                CSV (.csv)
              </button>
            </div>
          </>,
          document.body
        )}
    </>
  )
}
