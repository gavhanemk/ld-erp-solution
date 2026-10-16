'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { postReasonAction } from './orderActions'

interface Gap {
  item: string
  unit: string
  kind: 'MISSING' | 'ON_FLOOR' | 'WITH_US'
  qty: number
  text: string
}

const KIND: Record<Gap['kind'], string> = { MISSING: 'Missing', ON_FLOOR: 'On the floor', WITH_US: 'Still with us' }

/**
 * Closing or cancelling a job-work order refused because the customer's
 * material is not all accounted for. It says what is not, and what puts it
 * right; a manager who approves both orders and stock may close it anyway,
 * with a reason that is kept on the order with what was missing.
 */
export function MaterialExceptionDialog({
  order,
  action,
  reason,
  onCancel,
  onDone,
}: {
  order: { id: string; soNumber: string }
  action: 'short-close' | 'cancel'
  /** The reason already given for closing or cancelling. */
  reason: string
  onCancel: () => void
  onDone: (message: string) => void
}) {
  const [gaps, setGaps] = useState<Gap[] | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [may, setMay] = useState(false)
  const [exception, setException] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: { gaps: Gap[]; notes: string[]; mayException: boolean } }>(`/sales/orders/${order.id}/close-check`)
      .then((res) => {
        setGaps(res.data.gaps)
        setNotes(res.data.notes)
        setMay(res.data.mayException)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not check the material.'))
  }, [order.id])

  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await postReasonAction(order.id, action, reason, exception.trim())
      onDone(res.message ?? `${order.soNumber} updated.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be done.')
    } finally {
      setBusy(false)
    }
  }

  const verb = action === 'cancel' ? 'cancelled' : 'closed'
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div className="glass-card w-full max-w-lg p-5" role="alertdialog" aria-modal="true" aria-labelledby="material-exception-title" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10">
            <AlertTriangle size={18} className="text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="material-exception-title" className="text-foreground text-base font-semibold">
              {order.soNumber} cannot be {verb} yet
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">The customer&apos;s material on it is not all accounted for:</p>
          </div>
        </div>

        {!gaps && !error && <div className="skeleton mt-3 h-16 w-full rounded-lg" />}
        {gaps && (
          <ul className="border-border mt-3 divide-y divide-border rounded-lg border text-sm">
            {gaps.map((g, i) => (
              <li key={i} className="flex items-start gap-2 px-3 py-2">
                <span className="badge-warning shrink-0">{KIND[g.kind]}</span>
                <span className="text-foreground">{g.text}.</span>
              </li>
            ))}
          </ul>
        )}
        {notes.map((n) => (
          <p key={n} className="text-muted-foreground mt-2 text-xs">
            Also: {n}
          </p>
        ))}
        <p className="text-muted-foreground mt-3 text-xs">
          To put it right: send what is still here back to the customer (Inventory → Customer Material → Return), and bring back from the floor what was not cut.
        </p>

        {may ? (
          <label className="mt-4 block">
            <span className="form-label">Or close it anyway, as a manager&apos;s exception — why</span>
            <textarea
              className="form-input min-h-[64px] placeholder:text-muted-foreground/60"
              value={exception}
              onChange={(e) => setException(e.target.value)}
              placeholder="e.g. Customer asked us to keep the leftover for their next order"
              maxLength={1000}
              autoFocus
            />
            <span className="text-muted-foreground mt-1 block text-[11px]">Kept on the order with what was not accounted for, your name and the time.</span>
          </label>
        ) : (
          gaps && (
            <p className="warn-text mt-4 text-sm">
              Only a manager who approves both orders and stock can let it be {verb} like this.
            </p>
          )
        )}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            {may ? 'Cancel' : 'Close'}
          </button>
          {may && (
            <button type="button" className="btn-danger" onClick={() => void go()} disabled={busy || exception.trim().length < 10 || !gaps}>
              {busy && <Loader2 size={15} className="animate-spin" />}
              {action === 'cancel' ? 'Cancel with this exception' : 'Close with this exception'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
