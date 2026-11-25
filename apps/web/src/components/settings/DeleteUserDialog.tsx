'use client'

import { useEffect, useState } from 'react'
import { Ban, CheckCircle2, FileStack, Loader2, Trash2, UserX } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { settingsApi, type SettingsUser } from '@/lib/settingsApi'
import { FormFrame } from '@/components/ui/FormFrame'

type Check = { total: number; records: Array<{ what: string; count: number }>; canDelete: boolean; reason: string | null }

/**
 * Deleting a person, answered where you are looking.
 *
 * It used to be a browser prompt, then a refusal written at the top of the
 * page — out of sight when the person was halfway down the list, so a delete
 * that was refused looked like a delete that did nothing. Now the window asks
 * the server first and says plainly which it is: nothing in the ERP, so it
 * can go; or what the ERP holds with their name on, and the way to stop them
 * signing in instead.
 */
export function DeleteUserDialog({
  user,
  onClose,
  onDeleted,
  onMakeInactive,
}: {
  user: SettingsUser | null
  onClose: () => void
  onDeleted: (message: string) => void
  onMakeInactive: (user: SettingsUser) => Promise<void>
}) {
  const [check, setCheck] = useState<Check | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setCheck(null)
    setError(null)
    if (!user) return
    settingsApi.users
      .records(user.id)
      .then((r) => setCheck(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not check this account.'))
  }, [user])

  if (!user) return null

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await settingsApi.users.remove(user.id)
      onDeleted(res.message)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete.')
    } finally {
      setBusy(false)
    }
  }

  const inactivate = async () => {
    setBusy(true)
    try {
      await onMakeInactive(user)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const canGo = Boolean(check?.canDelete)
  const primary = !check ? (
    <button type="button" className="btn-secondary" disabled>
      <Loader2 size={15} className="animate-spin" /> Checking…
    </button>
  ) : canGo ? (
    <button type="button" className="btn-danger" onClick={() => void remove()} disabled={busy}>
      {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
      Delete {user.name}
    </button>
  ) : user.status === 'ACTIVE' && !check.reason ? (
    <button type="button" className="btn-primary" onClick={() => void inactivate()} disabled={busy}>
      {busy ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />}
      Make inactive instead
    </button>
  ) : (
    <button type="button" className="btn-secondary" onClick={onClose}>
      Close
    </button>
  )

  return (
    <FormFrame
      icon={UserX}
      title={`Delete ${user.name}`}
      subtitle={user.email}
      primary={primary}
      footer={
        <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      }
      error={error}
      onClose={onClose}
      busy={busy}
      width="max-w-xl"
      primaryInHeader={false}
    >
      {!check && !error && (
        <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
          <Loader2 size={15} className="animate-spin" /> Looking for anything in the ERP with their name on…
        </div>
      )}

      {check && check.reason && (
        <div className="border-border flex items-start gap-3 rounded-xl border p-4">
          <UserX size={18} className="text-muted-foreground mt-0.5 shrink-0" />
          <p className="text-foreground text-sm">{check.reason}</p>
        </div>
      )}

      {check && !check.reason && canGo && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-500" />
          <div>
            <p className="text-foreground text-sm font-semibold">This account has nothing in the ERP</p>
            <p className="text-muted-foreground mt-1 text-sm">
              No document, entry or change carries their name, so deleting it loses nothing. Their notifications and
              assistant chats go with it. This cannot be undone.
            </p>
          </div>
        </div>
      )}

      {check && !check.reason && !canGo && (
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
            <FileStack size={18} className="mt-0.5 shrink-0 text-amber-500" />
            <div>
              <p className="text-foreground text-sm font-semibold">
                {user.name} cannot be deleted — the ERP has {check.total.toLocaleString('en-IN')}{' '}
                {check.total === 1 ? 'record' : 'records'} with their name on
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                Deleting them would lose who made those records.{' '}
                {user.status === 'ACTIVE'
                  ? 'Make the account inactive instead: they can no longer sign in, and their name stays on what they did.'
                  : 'The account is already inactive, so they cannot sign in — nothing more is needed.'}
              </p>
            </div>
          </div>
          <div className="border-border divide-border/60 divide-y rounded-xl border">
            {check.records.slice(0, 8).map((r) => (
              <div key={r.what} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="text-foreground capitalize">{r.what}</span>
                <span className="text-muted-foreground tabular-nums">{r.count.toLocaleString('en-IN')}</span>
              </div>
            ))}
            {check.records.length > 8 && (
              <p className="text-muted-foreground px-4 py-2 text-xs">and {check.records.length - 8} more kinds of record</p>
            )}
          </div>
        </div>
      )}
    </FormFrame>
  )
}
