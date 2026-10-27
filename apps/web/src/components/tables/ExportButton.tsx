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
  Printer,
} from 'lucide-react'
import type { ExportFormat } from '@/lib/export'
import { useEscape } from '@/lib/useEscape'

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
 * The report is a workbook of two sheets now — Summary, the figures of the
 * report screen's Summary tab, and Data, the detailed report — and the PDF
 * is the detailed report printed.
 *
 * The work itself belongs to the page: only the page knows which filters are
 * set, and an export that quietly ignored them would be the wrong list.
 */
type Choice = ExportFormat | 'report' | 'pdf'

export function ExportButton({
  onExport,
  onReport,
  reportLabel = 'Report (.xlsx)',
  reportHint = 'Two sheets: the summary, and every row with its totals',
  onPdf,
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
  /** What the report item is called, and the line under it saying what is in it. */
  reportLabel?: string
  reportHint?: string
  /**
   * Opens the print-ready page, from which the browser prints or saves a PDF.
   * Only a register has one.
   */
  onPdf?: () => Promise<void> | void
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
    const needed = (onReport ? 54 : 0) + (onPdf ? 54 : 0) + 2 * 38 + 16
    const below = window.innerHeight - r.bottom - 12
    setPos({
      top: below < needed && r.top > needed ? r.top - needed - 6 : r.bottom + 6,
      right: Math.max(8, window.innerWidth - r.right),
    })
  }

  // Escape shuts the menu only, while it is open.
  useEscape(() => setOpen(false), open)
  useEffect(() => {
    if (!open) return
    const shut = () => setOpen(false)
    window.addEventListener('resize', shut)
    window.addEventListener('scroll', shut, true)
    return () => {
      window.removeEventListener('resize', shut)
      window.removeEventListener('scroll', shut, true)
    }
  }, [open])

  const run = async (choice: Choice) => {
    setOpen(false)
    setBusy(choice)
    try {
      if (choice === 'report') await onReport?.()
      else if (choice === 'pdf') await onPdf?.()
      else await onExport(choice)
    } finally {
      setBusy(null)
    }
  }

  const ITEM =
    'text-foreground hover:bg-secondary flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors'

  // The report item, with a rule between it and the plain formats under it.
  const reportItem = onReport ? (
    <>
      <button
        type="button"
        role="menuitem"
        className={`${ITEM} items-start`}
        onClick={() => void run('report')}
      >
        <LayoutDashboard size={15} className="text-primary mt-0.5 shrink-0" />
        <span className="min-w-0">
          <span className="block">{reportLabel}</span>
          <span className="text-muted-foreground block text-xs leading-snug">{reportHint}</span>
        </span>
      </button>
      <div className="border-border my-1 border-t" role="separator" />
    </>
  ) : null

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
        aria-label={busy ? 'Preparing...' : label}
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
        {/* The word, not just the icon, from `sm` up — a header this sits
          in is rarely fighting a phone for width there. Below it, the
          icon alone is what keeps a title and this button on one row
          instead of the button wrapping under it. */}
        <span className="hidden sm:inline">{busy ? 'Preparing...' : label}</span>
        {!busy && <ChevronDown size={13} className="hidden sm:block" />}
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
              {reportItem}
              {onPdf && (
                <button
                  type="button"
                  role="menuitem"
                  className={`${ITEM} items-start`}
                  onClick={() => void run('pdf')}
                >
                  <Printer size={15} className="text-primary mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block">PDF / Print</span>
                    <span className="text-muted-foreground block text-xs leading-snug">
                      The detailed report on A4; &ldquo;Save as PDF&rdquo; or print
                    </span>
                  </span>
                </button>
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
