'use client'

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, X, type LucideIcon } from 'lucide-react'

/**
 * The frame every data-entry form sits in, the one the purchase order drew.
 *
 * Portalled to <body>. A dialog drawn inside the page sits in whatever box the
 * page transition made, so `fixed` measured from that box and a strip of page
 * showed above the dimmed cover. The cover stops where the sidebar ends, so
 * the menu stays usable with a form open; on a phone the sidebar is a drawer
 * and the cover takes the full width.
 *
 * A title bar with the form's icon and its main button, a body that is the
 * only thing to scroll, and a footer that stays in reach however long the
 * form. The card is as tall as what it holds, up to the screen.
 */
export function FormFrame({
  icon: Icon,
  title,
  subtitle,
  primary,
  footer,
  footerNote,
  error,
  onClose,
  busy = false,
  width = 'max-w-5xl',
  children,
}: {
  icon: LucideIcon
  title: string
  subtitle?: React.ReactNode
  /** The form's main button, repeated in the title bar on a wide screen. */
  primary: React.ReactNode
  /** Buttons for the footer, before the main one: usually Cancel. */
  footer?: React.ReactNode
  /** A short line at the left of the footer: what saving will do. */
  footerNote?: React.ReactNode
  error?: string | null
  onClose: () => void
  /** While saving, Escape and the close button do nothing. */
  busy?: boolean
  width?: string
  children: React.ReactNode
}) {
  // Escape closes, and the page behind must not scroll while the form is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose, busy])

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div
        className={`glass-card po-form flex max-h-full w-full ${width} flex-col self-center overflow-hidden`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="form-frame-title"
      >
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <Icon size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2
                id="form-frame-title"
                className="text-foreground truncate text-xl font-semibold tracking-tight"
              >
                {title}
              </h2>
              {subtitle && (
                <p className="text-muted-foreground mt-0.5 line-clamp-2 text-[13px]">{subtitle}</p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden md:block">{primary}</div>
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost p-2"
              aria-label="Close"
              disabled={busy}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}
          {children}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-5 py-3">
          {footerNote && (
            <p className="text-muted-foreground mr-auto min-w-0 text-xs">{footerNote}</p>
          )}
          {footer}
          {primary}
        </div>
      </div>
    </div>,
    document.body,
  )
}
