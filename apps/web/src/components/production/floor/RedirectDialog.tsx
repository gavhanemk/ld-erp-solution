'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Loader2, Shuffle, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import type { FlowTransfer } from './types'

interface Option {
  stepId: string
  name: string
  outside: boolean
  ok: boolean
  why: string | null
}
interface Choices {
  /** Why it cannot go anywhere else any more, if it cannot. */
  blocked: string | null
  /** Already counted in where it went (but not yet worked on there). */
  counted: boolean
  options: Option[]
}

/**
 * Whether to offer "Change where it goes" at all: a transfer on our own floor,
 * not cancelled, and not counted in with a difference. Whether the receiving
 * step has started on the pieces is the server's to say, when it is opened.
 */
export const mayChangeWhere = (t: Pick<FlowTransfer, 'status' | 'vendor' | 'lines'>) =>
  !t.vendor && ['DISPATCHED', 'PARTLY_RECEIVED', 'RECEIVED'].includes(t.status) && !t.lines.some((l) => l.shortQty > 0 || l.excessQty > 0)

/**
 * A transfer sent somewhere else instead: pick the step and say why. The old
 * card is cancelled and a new one made for the same bundles, so the new card
 * is the one to print and send with them. One already counted in can still be
 * changed while nobody there has worked on its pieces — the count-in is taken
 * back first; after that it stands, and this says so.
 */
export function RedirectDialog({
  transfer,
  onClose,
  onDone,
}: {
  transfer: { id: string; transferNumber: string; fromStep: { name: string }; toStep: { name: string } }
  onClose: () => void
  onDone: (message: string, newTransferId: string) => void
}) {
  const [choices, setChoices] = useState<Choices | null>(null)
  const options = choices?.options ?? null
  const blocked = choices?.blocked ?? null
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .get<{ data: Choices }>(`/production/transfers/${transfer.id}/redirect-options`)
      .then((r) => {
        if (!live) return
        setChoices(r.data)
        const first = r.data.blocked ? undefined : r.data.options.find((o) => o.ok)
        if (first) setTo(first.stepId)
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : 'Could not work out where they can go.'))
    return () => {
      live = false
    }
  }, [transfer.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const save = async () => {
    setError(null)
    if (!to) return setError('Pick where they go instead.')
    if (reason.trim().length < 3) return setError('Say why they go somewhere else.')
    setBusy(true)
    try {
      const res = await api.post<{ message: string; data: { id: string } }>(`/production/transfers/${transfer.id}/redirect`, { toStepId: to, reason: reason.trim() })
      onDone(res.message, res.data.id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change it.')
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:left-[var(--sidebar-current-width)]">
      <div className="glass-card w-full max-w-lg overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="redirect-title">
        <div className="flex items-start gap-3 p-5 pb-3">
          <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <Shuffle size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="redirect-title" className="text-foreground text-lg font-semibold">
              Send {transfer.transferNumber} somewhere else
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              From {transfer.fromStep.name} to {transfer.toStep.name}.
              {choices && !blocked
                ? choices.counted
                  ? ` ${transfer.toStep.name} has counted it in but not started on the pieces, so they can still go to another step — the count-in is taken back.`
                  : ' Nobody has counted it in yet, so it can still go to another step.'
                : ''}
            </p>
          </div>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3 px-5">
          {!options ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 size={14} className="animate-spin" /> Working out where they can go…
            </p>
          ) : blocked ? (
            <div className="border-border bg-secondary/50 flex items-start gap-2.5 rounded-lg border p-3">
              <AlertCircle size={16} className="text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-foreground text-sm">{blocked}</p>
            </div>
          ) : !options.length ? (
            <p className="text-muted-foreground text-sm">There is no other step on this order&apos;s route they can go to.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {options.map((o) => (
                <button
                  key={o.stepId}
                  type="button"
                  disabled={!o.ok}
                  onClick={() => setTo(o.stepId)}
                  aria-pressed={to === o.stepId}
                  className={`rounded-lg border p-2.5 text-left ${to === o.stepId ? 'border-primary bg-primary/10 ring-primary/30 ring-2' : o.ok ? 'border-border hover:border-primary/50' : 'border-border cursor-not-allowed opacity-50'}`}
                >
                  <span className="text-foreground block text-sm font-semibold">{o.name}</span>
                  <span className="text-muted-foreground block text-xs">{o.ok ? 'On our own floor' : o.why}</span>
                </button>
              ))}
            </div>
          )}
          {!blocked && (
            <label className="block">
              <span className="form-label">Why</span>
              <input className="form-input" value={reason} maxLength={500} placeholder="Embroidery to be done before stitching" onChange={(e) => setReason(e.target.value)} />
            </label>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 p-5">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            {blocked ? 'Close' : 'Keep it as it is'}
          </button>
          {!blocked && (
            <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy || !to || !options?.find((o) => o.stepId === to)?.ok}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Shuffle size={15} />} Send there instead
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
