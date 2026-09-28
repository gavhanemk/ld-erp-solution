'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2 } from 'lucide-react'

/**
 * Asks why, before an action that needs a reason on record — cancelling,
 * deleting, closing a line short.
 *
 * Replaces the browser's own `prompt()`, which looked like an error the
 * operating system was raising rather than a question this app was asking,
 * and could not be styled to match anything around it. This one is themed,
 * keeps the keyboard inside it, and disables its own button rather than
 * silently accepting one character as a reason.
 */
export function ReasonDialog({
  title,
  description,
  confirmLabel = 'Confirm',
  danger = false,
  minLength = 5,
  placeholder = 'One line is enough',
  busy = false,
  requireReason = true,
  onConfirm,
  onCancel,
}: {
  title: string
  description: React.ReactNode
  confirmLabel?: string
  /** Red rather than teal, for an action that cannot be undone. */
  danger?: boolean
  minLength?: number
  placeholder?: string
  busy?: boolean
  /** False turns this into a plain yes/no confirm — no audit trail needs the reason. */
  requireReason?: boolean
  onConfirm: (reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  const tooShort = requireReason && reason.trim().length < minLength

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="glass-card w-full max-w-md p-5"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="reason-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          {danger && (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10">
              <AlertTriangle size={18} className="text-red-400" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 id="reason-dialog-title" className="text-foreground text-base font-semibold">
              {title}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">{description}</p>
          </div>
        </div>

        {requireReason && (
          <label className="mt-4 block">
            <span className="form-label">Reason</span>
            <input
              className="form-input h-10"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !tooShort && !busy) onConfirm(reason.trim())
                if (e.key === 'Escape') onCancel()
              }}
              placeholder={placeholder}
              autoFocus
            />
          </label>
        )}

        <div
          className="mt-5 flex justify-end gap-2"
          onKeyDown={(e) => {
            if (requireReason) return
            if (e.key === 'Escape') onCancel()
          }}
        >
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'btn-danger' : 'btn-primary'}
            onClick={() => onConfirm(reason.trim())}
            disabled={tooShort || busy}
            autoFocus={!requireReason}
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
