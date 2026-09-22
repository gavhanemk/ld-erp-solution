'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Download, FileSpreadsheet, FileText, Loader2 } from 'lucide-react'
import type { ExportFormat } from '@/lib/export'

/**
 * Takes a list off the screen and into a spreadsheet.
 *
 * Two formats because they are not the same thing to the people who ask for
 * them. Excel keeps the columns, the widths and the frozen header, and is
 * what goes to an accountant. CSV is what another system reads, and it opens
 * anywhere — so neither one is a fallback for the other.
 *
 * The work itself belongs to the page: only the page knows which filters are
 * set, and an export that quietly ignored them would be the wrong list.
 */
export function ExportButton({
  onExport,
  disabled,
  label = 'Export',
}: {
  onExport: (format: ExportFormat) => Promise<void> | void
  disabled?: boolean
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  // Measured at the moment of the press, off the button's own rectangle —
  // the same reasoning as the row actions menu, and the same reason it is
  // drawn into the body: `.glass-card` carries a `backdrop-filter`, which
  // makes it the containing block for anything `fixed` inside it.
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const needed = 2 * 38 + 16
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

  const run = async (format: ExportFormat) => {
    setOpen(false)
    setBusy(format)
    try {
      await onExport(format)
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
              className="border-border bg-card fixed z-50 min-w-[13rem] overflow-hidden rounded-xl border py-1 shadow-xl"
              style={{ top: pos.top, right: pos.right }}
            >
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
