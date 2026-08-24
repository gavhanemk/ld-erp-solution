'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, XCircle, RefreshCw, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { settingsApi, type ActivityEntry, type SystemStatus } from '@/lib/settingsApi'
import { Field, LoadingRow, Notice, SettingsCard } from '@/components/settings/ui'
import { formatDate } from '@/lib/utils'

export default function SystemSettingsPage() {
  return (
    <div className="space-y-6">
      <Connections />
      <ChangeOwnPassword />
      <ActivityTrail />
    </div>
  )
}

// ── Connections ──────────────────────────────────────────────────────────────

function Connections() {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await settingsApi.system()
      setStatus(res.data)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing system status.'
            : err.message
          : 'Could not reach the API.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <SettingsCard
      title="Connections"
      description="What the ERP is talking to right now. Each one is checked when this page loads, not assumed."
      actions={
        <button className="btn-ghost text-xs" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          Check again
        </button>
      }
    >
      {error && <Notice kind="error">{error}</Notice>}

      {loading && !status ? (
        <LoadingRow label="Checking..." />
      ) : status ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {status.connections.map((c) => (
              <div
                key={c.key}
                className="flex items-start gap-3 p-3 rounded-lg border border-border bg-secondary/30"
              >
                {c.connected ? (
                  <CheckCircle2 size={16} className="text-emerald-400 mt-0.5 shrink-0" />
                ) : (
                  <XCircle size={16} className="text-muted-foreground mt-0.5 shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.detail}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-x-8 gap-y-2 pt-4 border-t border-border text-xs text-muted-foreground">
            <span>
              Company: <span className="text-foreground">{status.company ?? 'Not set'}</span>
            </span>
            <span>
              Financial year:{' '}
              <span className="text-foreground">{status.financialYear ?? 'Not set'}</span>
            </span>
            <span>
              People who can sign in:{' '}
              <span className="text-foreground">{status.counts.activeUsers}</span>
            </span>
            <span>
              Roles: <span className="text-foreground">{status.counts.roles}</span>
            </span>
            <span>
              Recorded changes:{' '}
              <span className="text-foreground">{status.counts.auditEntries.toLocaleString('en-IN')}</span>
            </span>
            <span>
              Server: <span className="text-foreground">{status.server.environment}</span>, up{' '}
              {formatUptime(status.server.uptimeSeconds)}
            </span>
          </div>
        </div>
      ) : null}
    </SettingsCard>
  )
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

// ── Your password ────────────────────────────────────────────────────────────

function ChangeOwnPassword() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const mismatch = confirm.length > 0 && next !== confirm

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (mismatch) return

    setSaving(true)
    setMessage(null)
    try {
      const res = await settingsApi.changeOwnPassword(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      setMessage({ kind: 'success', text: res.message })
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not change the password.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Your password"
      description="Changes only your own sign-in. To reset someone else's, use the People tab."
    >
      <form onSubmit={submit} className="space-y-4 max-w-xl">
        {message && <Notice kind={message.kind}>{message.text}</Notice>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Current password" htmlFor="pw-current" required span={2}>
            <input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              className="form-input"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>

          <Field
            label="New password"
            htmlFor="pw-new"
            required
            help="At least 8 characters with a letter and a number"
          >
            <input
              id="pw-new"
              type="password"
              autoComplete="new-password"
              className="form-input"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>

          <Field
            label="Type it again"
            htmlFor="pw-confirm"
            required
            error={mismatch ? 'The two do not match' : undefined}
          >
            <input
              id="pw-confirm"
              type="password"
              autoComplete="new-password"
              className="form-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            className="btn-primary"
            disabled={saving || mismatch || !current || next.length < 8}
          >
            {saving && <Loader2 size={15} className="animate-spin" />}
            Change password
          </button>
        </div>
      </form>
    </SettingsCard>
  )
}

// ── Activity trail ───────────────────────────────────────────────────────────

const ACTION_STYLE: Record<string, string> = {
  CREATE: 'badge-success',
  UPDATE: 'badge-info',
  DELETE: 'badge-danger',
  APPROVE: 'badge-success',
  REJECT: 'badge-danger',
  EXPORT: 'badge-neutral',
}

function ActivityTrail() {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 })
  const [page, setPage] = useState(1)
  const [moduleFilter, setModuleFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await settingsApi.activity({
        page,
        module: moduleFilter || undefined,
        action: actionFilter || undefined,
      })
      setEntries(res.data)
      setPagination({
        page: res.pagination.page,
        pages: res.pagination.pages,
        total: res.pagination.total,
      })
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing the activity trail.'
            : err.message
          : 'Could not load the activity trail.',
      )
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [page, moduleFilter, actionFilter])

  useEffect(() => {
    void load()
  }, [load])

  // A changed filter invalidates the page number.
  useEffect(() => {
    setPage(1)
  }, [moduleFilter, actionFilter])

  return (
    <SettingsCard
      title="Activity"
      description="Every change anyone has made, with who made it and when."
      actions={
        <button className="btn-ghost text-xs" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          Refresh
        </button>
      }
    >
      {error && <Notice kind="error">{error}</Notice>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          className="form-input h-9 w-44"
          value={moduleFilter}
          onChange={(e) => setModuleFilter(e.target.value)}
          aria-label="Filter by area"
        >
          <option value="">All areas</option>
          <option value="masters">Master data</option>
          <option value="sales">Sales</option>
          <option value="purchase">Purchase</option>
          <option value="inventory">Inventory</option>
          <option value="production">Production</option>
          <option value="settings">Settings</option>
          <option value="admin">Users &amp; roles</option>
        </select>

        <select
          className="form-input h-9 w-40"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          aria-label="Filter by what happened"
        >
          <option value="">Anything</option>
          <option value="CREATE">Created</option>
          <option value="UPDATE">Changed</option>
          <option value="DELETE">Removed</option>
          <option value="APPROVE">Approved</option>
          <option value="REJECT">Rejected</option>
        </select>

        <span className="text-xs text-muted-foreground ml-auto">
          {pagination.total.toLocaleString('en-IN')} recorded
        </span>
      </div>

      {loading && entries.length === 0 ? (
        <LoadingRow />
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          Nothing recorded yet for that filter.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What happened</th>
                  <th>Area</th>
                  <th>Fields changed</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-xs">
                      <div>{formatDate(e.createdAt)}</div>
                      <div className="text-muted-foreground">
                        {new Date(e.createdAt).toLocaleTimeString('en-IN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    </td>
                    <td className="text-xs">
                      <div className="text-foreground">{e.user?.name ?? 'Unknown'}</div>
                      <div className="text-muted-foreground">{e.ipAddress ?? ''}</div>
                    </td>
                    <td>
                      <span className={ACTION_STYLE[e.action] ?? 'badge-neutral'}>{e.action}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{e.entityType}</span>
                    </td>
                    <td className="text-xs text-muted-foreground">{e.moduleLabel}</td>
                    <td className="text-xs text-muted-foreground">
                      {e.changed.length > 0 ? e.changed.slice(0, 6).join(', ') : '—'}
                      {e.changed.length > 6 && ` +${e.changed.length - 6} more`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pagination.pages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
              <span className="text-xs text-muted-foreground">
                Page {pagination.page} of {pagination.pages}
              </span>
              <div className="flex gap-2">
                <button
                  className="btn-ghost p-1.5"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={pagination.page <= 1 || loading}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  className="btn-ghost p-1.5"
                  onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
                  disabled={pagination.page >= pagination.pages || loading}
                  aria-label="Next page"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </SettingsCard>
  )
}
