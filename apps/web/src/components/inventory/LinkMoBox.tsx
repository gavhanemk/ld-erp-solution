'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Link2, Loader2 } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'

interface MoChoice {
  id: string
  moNumber: string
  status: string
  totalPlannedQty: number
  lines: Array<{ color: string; style: { code: string } }>
}

/**
 * For a requisition raised against a sales order with no MO, before
 * requisitions had to come from an MO: nothing is issued against it until it
 * is linked to one of that order's released MOs. Picks the MO and links it;
 * with none, says how to make one.
 */
export function LinkMoBox({
  mrId,
  mrNumber,
  so,
  onLinked,
}: {
  mrId: string
  mrNumber: string
  so: { id: string; soNumber: string }
  onLinked: (mo: { id: string; moNumber: string }, message: string) => void
}) {
  const [choices, setChoices] = useState<MoChoice[] | null>(null)
  const [moId, setMoId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<{ data: MoChoice[] }>(`/inventory/requisitions/${mrId}/mo-choices`)
      .then((r) => {
        if (cancelled) return
        setChoices(r.data)
        if (r.data.length === 1) setMoId(r.data[0].id)
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Could not read the MOs.'))
    return () => {
      cancelled = true
    }
  }, [mrId])

  const link = async () => {
    const mo = choices?.find((c) => c.id === moId)
    if (!mo) return setError('Pick the manufacturing order.')
    setBusy(true)
    setError(null)
    try {
      const res = await api.patch<{ message?: string }>(`/inventory/requisitions/${mrId}/link-mo`, { moId })
      onLinked({ id: mo.id, moNumber: mo.moNumber }, res.message ?? `${mrNumber} is now for ${mo.moNumber}.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not link it. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const styles = (c: MoChoice) => [...new Set(c.lines.map((l) => `${l.style.code}${l.color ? ` ${l.color}` : ''}`))].join(', ')

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <p className="flex items-start gap-2 text-sm text-foreground">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-600" />
        <span>
          <b>Link it to its MO before issuing.</b> {mrNumber} was raised against {so.soNumber} without a manufacturing order. Material for an order goes
          through its MO (Sales order → MO → requisition → issue), so nothing is issued against it until it is linked.
        </span>
      </p>
      {choices === null && !error ? (
        <p className="mt-2 flex items-center gap-2 pl-6 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> Reading {so.soNumber}&apos;s MOs…
        </p>
      ) : choices && choices.length === 0 ? (
        <p className="mt-2 pl-6 text-sm text-foreground">
          {so.soNumber} has no released MO yet.{' '}
          <a href={`/production/orders?make=${so.id}`} className="font-medium text-primary hover:underline">
            Make one from {so.soNumber}
          </a>{' '}
          and release it, then link it here.
        </p>
      ) : choices ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
          <SmartSelect className="form-input h-9 w-auto min-w-[20rem]" value={moId} onChange={(e) => setMoId(e.target.value)} aria-label="Manufacturing order">
            <option value="">Pick {so.soNumber}&apos;s MO…</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.moNumber} · {styles(c)} · {c.totalPlannedQty.toLocaleString('en-IN')} pcs
              </option>
            ))}
          </SmartSelect>
          {can('inventory', 'edit') ? (
            <button type="button" className="btn-primary h-9 px-3 text-sm" onClick={() => void link()} disabled={busy || !moId}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} Link to MO
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">Someone who can edit requisitions links it.</span>
          )}
        </div>
      ) : null}
      {error && <p className="mt-2 pl-6 text-sm text-destructive">{error}</p>}
    </div>
  )
}
