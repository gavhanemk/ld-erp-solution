'use client'

import { createPortal } from 'react-dom'
import { ClipboardCheck } from 'lucide-react'
import { useEscape } from '@/lib/useEscape'

/**
 * Asked straight after a goods receipt is saved: check the goods now?
 *
 * The quality check is a separate step done after the receipt, and nothing
 * used to say so — the receipt saved, the screen moved on, and the check was
 * forgotten. Rejected pieces then sat in the store as good stock, free to be
 * issued to production. This puts the step in front of the person who has
 * just counted the goods in.
 *
 * "Later" is a real answer: the receipt then shows "QC pending" in the list
 * until somebody checks it.
 */
export function QcNowPrompt({
  grnNumber,
  onCheck,
  onLater,
}: {
  grnNumber: string
  onCheck: () => void
  onLater: () => void
}) {
  useEscape(onLater)

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        className="glass-card w-full max-w-md p-5"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="qc-now-title"
        aria-describedby="qc-now-text"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10">
            <ClipboardCheck size={18} className="text-amber-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="qc-now-title" className="text-foreground text-base font-semibold">
              Quality check {grnNumber} now?
            </h2>
            <p id="qc-now-text" className="text-muted-foreground mt-1 text-sm">
              The goods are in stock. Check them now, so anything rejected is held back and
              cannot be issued to production by mistake.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onLater}>
            Later
          </button>
          <button type="button" className="btn-primary" onClick={onCheck} autoFocus>
            <ClipboardCheck size={15} />
            Do quality check now
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
