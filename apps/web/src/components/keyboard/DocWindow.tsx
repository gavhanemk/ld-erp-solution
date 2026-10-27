'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, FileText, X } from 'lucide-react'
import { keyLabel, useDialogFocus } from '@/lib/keys'
import { useEscape } from '@/lib/useEscape'

/**
 * A document's printed copy, shown inside the ERP: what Enter opens on a list
 * whose documents have no window of their own (quotations, challans,
 * invoices, receipts, job-work challans, credit notes). The copy's own Print
 * button prints it; "Open in a new tab" is there for a second screen.
 *
 * Opened from the keyboard only. A click on the number still opens the new
 * tab it always did.
 */
export function DocWindow({ href, title, onClose, onStep }: { href: string; title: string; onClose: () => void; onStep: (dir: 1 | -1) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  useDialogFocus(ref)
  useEscape(onClose)

  // Keys pressed while reading the copy reach this window too: Esc closes it,
  // Alt+PgDn / Alt+PgUp go on to the next line's document.
  const keys = useRef({ onClose, onStep })
  keys.current = { onClose, onStep }
  const listen = () => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        keys.current.onClose()
      } else if (e.altKey && (e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault()
        keys.current.onStep(e.key === 'PageDown' ? 1 : -1)
      }
    })
  }

  // The copy's own Close button (its "back" link, inside this window) asks to shut it.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data === 'ld:close-doc') keys.current.onClose()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // The page behind does not scroll while the copy is up.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="glass-card flex h-full w-full max-w-5xl flex-col overflow-hidden">
        <div className="border-border flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-3">
          <FileText size={18} className="text-primary shrink-0" aria-hidden />
          <h2 className="text-foreground mr-auto min-w-0 truncate text-lg font-semibold">{title}</h2>
          <span className="text-muted-foreground hidden text-xs lg:inline">
            {keyLabel('alt+PgUp')} / {keyLabel('alt+PgDn')}: line before / next line
          </span>
          <a href={href} target="_blank" rel="noreferrer" className="btn-secondary h-9 px-3 text-xs">
            <ExternalLink size={14} /> Open in a new tab
          </a>
          <button type="button" onClick={onClose} className="btn-ghost p-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <iframe ref={frame} key={href} src={href} title={title} onLoad={listen} className="min-h-0 w-full flex-1 bg-white" />
      </div>
    </div>,
    document.body,
  )
}
