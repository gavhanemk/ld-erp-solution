'use client'

import { createPortal } from 'react-dom'
import { Archive, Trash2 } from 'lucide-react'
import { useEscape } from '@/lib/useEscape'

export type DeleteChoice = 'bin' | 'permanent'

/**
 * Delete, two ways (the user's rules, 27 Nov 2026), for a purchase or service
 * order that never went to the supplier — one window instead of deleting
 * twice, here and then again in the recycle bin.
 *
 * To the recycle bin: the order keeps its number, so no new order takes it,
 * and it can be restored exactly as it was. Permanently: gone at once with its
 * lines and files, and its number freed — when it is the latest order, the
 * next one takes that number.
 */
export function DeleteOrderDialog({
  poNumber,
  onChoose,
  onCancel,
}: {
  poNumber: string
  onChoose: (choice: DeleteChoice) => void
  onCancel: () => void
}) {
  // Escape backs out of this window only.
  useEscape(onCancel)
  const option =
    'border-border flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2'

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="glass-card w-full max-w-md p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-order-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="delete-order-title" className="text-foreground text-base font-semibold">
          Delete {poNumber}?
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">Choose what happens to the order and its number.</p>

        <div className="mt-4 space-y-2">
          <button
            type="button"
            autoFocus
            className={`${option} hover:border-primary/50 hover:bg-primary/5 focus-visible:ring-primary/40`}
            onClick={() => onChoose('bin')}
          >
            <Archive size={18} className="text-primary mt-0.5 shrink-0" />
            <span className="min-w-0">
              <span className="text-foreground block text-sm font-medium">Move to recycle bin</span>
              <span className="text-muted-foreground mt-0.5 block text-xs">
                {poNumber} stays reserved — no new order takes it. Restore it any time from Settings → Recycle
                bin.
              </span>
            </span>
          </button>
          <button
            type="button"
            className={`${option} hover:border-red-500/50 hover:bg-red-500/5 focus-visible:ring-red-500/40`}
            onClick={() => onChoose('permanent')}
          >
            <Trash2 size={18} className="mt-0.5 shrink-0 text-red-400" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-red-400">Delete permanently</span>
              <span className="text-muted-foreground mt-0.5 block text-xs">
                Gone for good with its lines and files; this cannot be undone. Its number is freed: if it is the
                latest order, the next purchase or service order takes {poNumber}.
              </span>
            </span>
          </button>
        </div>

        <div className="mt-5 flex justify-end">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Keep it
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
