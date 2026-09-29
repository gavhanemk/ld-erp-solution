'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ArrowRight, Loader2, Trash2, X } from 'lucide-react'
import { api, apiErrorMessage, masterResource } from '@/lib/api'

interface Check {
  /** What has to move to another record, e.g. "1 operation". */
  move: string[]
  /** What will simply be left blank, e.g. "2 items". */
  blank: string[]
}

const sentence = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`

/**
 * Deleting a master for good, said plainly before it happens.
 *
 * The API is asked first what the delete would touch. Links that may be
 * empty (an item's department) are listed as left blank; links that may not
 * (a requisition's department) need somewhere to go, so the box asks where,
 * and Delete stays off until that is chosen. Nothing is done until Delete.
 */
export function DeleteDialog({
  resource,
  id,
  name,
  entityName,
  onClose,
  onDeleted,
}: {
  resource: string
  id: string
  name: string
  /** "Department" */
  entityName: string
  onClose: () => void
  /** Called with the API's sentence saying what was done. */
  onDeleted: (message: string) => void
}) {
  const noun = entityName.toLowerCase()
  const [check, setCheck] = useState<Check | null>(null)
  const [targets, setTargets] = useState<{ id: string; name: string }[] | null>(null)
  const [moveTo, setMoveTo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .get<{ data: Check }>(`/masters/${resource}/${id}/delete-check`)
      .then(async (res) => {
        if (cancelled) return
        setCheck(res.data)
        if (res.data.move.length) {
          const list = await masterResource<{ id: string; name: string }>(resource).list({
            limit: 200,
            active: true,
            sort: 'name',
            order: 'asc',
          })
          if (!cancelled) setTargets(list.data.filter((r) => r.id !== id))
        }
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err, 'Could not check what uses it.'))
      })
    return () => {
      cancelled = true
    }
  }, [resource, id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const needsTarget = Boolean(check?.move.length)
  const ready = check !== null && (!needsTarget || Boolean(moveTo))

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ permanent: 'true' })
      if (moveTo) qs.set('moveTo', moveTo)
      const res = await api.delete<{ message: string }>(`/masters/${resource}/${id}?${qs}`)
      onDeleted(res.message)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not delete.'))
      setBusy(false)
    }
  }

  const targetName = targets?.find((t) => t.id === moveTo)?.name

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:left-[var(--sidebar-current-width)]">
      <div
        className="glass-card po-form w-full max-w-lg overflow-hidden"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
      >
        <div className="border-border flex items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-500/30 bg-red-500/10">
              <Trash2 size={18} className="text-red-500" />
            </div>
            <div className="min-w-0">
              <h2 id="delete-title" className="text-foreground truncate text-lg font-semibold">
                Delete {name}?
              </h2>
              <p className="text-muted-foreground text-[13px]">This cannot be undone.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm">
          {check === null && !error && (
            <p className="text-muted-foreground flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Checking what uses it...
            </p>
          )}

          {check && !check.move.length && !check.blank.length && (
            <p className="text-foreground">Nothing uses this {noun}, so nothing else changes.</p>
          )}

          {check && check.move.length > 0 && (
            <div className="space-y-2">
              <p className="text-foreground">
                <span className="font-medium">{sentence(check.move)}</span>{' '}
                {check.move.length === 1 && check.move[0].startsWith('1 ') ? 'has' : 'have'} to belong
                to a {noun}. Choose where{' '}
                {check.move.length === 1 && check.move[0].startsWith('1 ') ? 'it goes' : 'they go'}:
              </p>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground shrink-0 line-through">{name}</span>
                <ArrowRight size={14} className="text-muted-foreground shrink-0" />
                <select
                  className="form-input"
                  value={moveTo}
                  onChange={(e) => setMoveTo(e.target.value)}
                  disabled={busy || targets === null}
                  autoFocus
                >
                  <option value="">{targets === null ? 'Loading...' : `Choose a ${noun}...`}</option>
                  {targets?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {check && check.blank.length > 0 && (
            <p className="text-foreground">
              <span className="font-medium">{sentence(check.blank)}</span> will be left with no {noun}.
            </p>
          )}

          {check && (check.move.length > 0 || check.blank.length > 0) && (
            <p className="text-muted-foreground flex items-start gap-2 text-xs">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
              Past records change too.
              {check.move.length > 0 &&
                ` What is moved will show ${targetName ?? `the ${noun} you choose`} from now on.`}
              {check.blank.length > 0 && ` What is left blank will show no ${noun}.`} To keep them as
              they are, deactivate it instead.
            </p>
          )}

          {error && (
            <p className="rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-red-500">{error}</p>
          )}
        </div>

        <div className="border-border flex items-center justify-end gap-2 border-t px-5 py-3">
          <button type="button" onClick={onClose} className="btn-secondary" disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!ready || busy}
            className="btn-primary !bg-red-600 hover:!bg-red-700 disabled:opacity-50"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
            Delete {noun}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
