'use client'

import { useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { can } from '@/lib/api'

/** The reasons a store manager can give for letting a newer package go first. The same list as the server's. */
export const FIFO_REASONS = ['Older package damaged', 'Matching lot or shade', 'Customer asked for this lot', 'Older package cannot be reached'] as const

/** The codes the server refuses with when FIFO is broken. */
export const isFifoStop = (code: string | undefined) => code === 'FIFO_OLDER' || code === 'FIFO_NEEDS_MANAGER'

/**
 * FIFO stopped a package going out: an older one of the same item is still on
 * the rack. Says which and where. Only the store manager (inventory approve)
 * can let this one go first, with a reason, which is kept on the package and
 * shows on the FIFO exceptions report.
 */
export function FifoOverride({
  message,
  busy,
  onAllow,
}: {
  /** The server's words: which package is older, when it came in, its rack. */
  message: string
  busy: boolean
  onAllow: (reason: string) => void
}) {
  const mayAllow = can('inventory', 'approve')
  const [choice, setChoice] = useState<string>('')
  const [other, setOther] = useState('')
  const reason = choice === 'other' ? other.trim() : choice

  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <p className="flex items-start gap-2 text-foreground">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
        <span>
          <span className="font-semibold">First in, first out.</span> {message}
        </span>
      </p>
      {mayAllow ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">
            Let this one go first, because
            <select id="fifo-reason" className="form-input mt-1 h-9 w-60 py-0 text-sm" value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Choose a reason…</option>
              {FIFO_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              <option value="other">Something else…</option>
            </select>
          </label>
          {choice === 'other' && (
            <input
              id="fifo-reason-other"
              className="form-input h-9 w-60 text-sm"
              placeholder="Say why"
              maxLength={200}
              value={other}
              onChange={(e) => setOther(e.target.value)}
              aria-label="Why this one goes first"
            />
          )}
          <button type="button" className="btn-secondary h-9" disabled={busy || reason.length < 3} onClick={() => onAllow(reason)}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null} Let this one go first
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Take the older one, or ask the store manager to let this one go first.</p>
      )}
    </div>
  )
}
