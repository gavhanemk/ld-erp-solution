'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Shuffle, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'

interface Option {
  stepId: string
  name: string
  outside: boolean
  ok: boolean
  why: string | null
}

/**
 * A transfer sent but not yet counted in, sent somewhere else instead: pick
 * the step and say why. The old card is cancelled and a new one made for the
 * same bundles, so the new card is the one to print and send with them.
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
  const [options, setOptions] = useState<Option[] | null>(null)
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .get<{ data: Option[] }>(`/production/transfers/${transfer.id}/redirect-options`)
      .then((r) => {
        if (!live) return
        setOptions(r.data)
        const first = r.data.find((o) => o.ok)
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
              From {transfer.fromStep.name}, now going to {transfer.toStep.name}. Nobody has counted it in yet, so it can still go to another step.
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
          <label className="block">
            <span className="form-label">Why</span>
            <input className="form-input" value={reason} maxLength={500} placeholder="Embroidery to be done before stitching" onChange={(e) => setReason(e.target.value)} />
          </label>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 p-5">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Keep it as it is
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy || !to || !options?.find((o) => o.stepId === to)?.ok}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Shuffle size={15} />} Send there instead
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
