'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, Ban, RefreshCw, Search, AlertCircle, Lock, Unlock } from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { RoutingFormDialog, type Routing } from '@/components/masters/RoutingFormDialog'
import { useAppSettings } from '@/lib/appSettings'

/**
 * Routings.
 *
 * This is the piece Absolute holds that our ERP never had: 167 of them in their
 * live account, one per style, because a plain shirt and an embroidered one do
 * not take the same path through the floor.
 */
export default function RoutingsPage() {
  const { rowsPerPage } = useAppSettings()

  const [rows, setRows] = useState<Routing[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [activeOnly, setActiveOnly] = useState(true)
  const [dialog, setDialog] = useState<{ open: boolean; record: Routing | null }>({
    open: false,
    record: null,
  })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: String(rowsPerPage) })
      if (debounced) qs.set('q', debounced)
      if (activeOnly) qs.set('active', 'true')
      const res = await api.get<Paginated<Routing>>(`/masters/routings?${qs}`)
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?',
      )
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [debounced, activeOnly, rowsPerPage])

  useEffect(() => {
    void load()
  }, [load])

  const toggleLock = async (r: Routing) => {
    setBusy(true)
    try {
      await api.patch(`/masters/routings/${r.id}`, { isLocked: !r.isLocked })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  const retire = async (r: Routing) => {
    if (!confirm(`Stop offering "${r.name}" on new orders? Orders already using it keep it.`)) return
    setBusy(true)
    try {
      await api.delete(`/masters/routings/${r.id}`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Routings</h1>
          <p className="page-subtitle">
            The order of operations each style passes through on the floor
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-primary" onClick={() => setDialog({ open: true, record: null })}>
            <Plus size={15} /> New Routing
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
          <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <div className="glass-card p-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border flex-1 min-w-[220px] max-w-sm">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="bg-transparent border-0 outline-none text-sm flex-1 text-foreground placeholder:text-muted-foreground"
              placeholder="Search routing or style..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search routings"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-teal-500"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            Active only
          </label>
          <span className="text-xs text-muted-foreground ml-auto">{total} routings</span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No routings yet. Create one per style — cutting through to packing.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {rows.map((r) => (
              <div key={r.id} className="px-4 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-teal-400">{r.code}</span>
                      <span className="font-medium text-foreground">{r.name}</span>
                      {r.isLocked && (
                        <span className="badge-warning">
                          <Lock size={10} /> Locked
                        </span>
                      )}
                      {!r.isActive && <span className="badge-neutral">Retired</span>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {r.style ? `${r.style.code} — ${r.style.name}` : 'No style'}
                      {' · '}
                      {r.steps?.length ?? 0} steps
                    </p>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      className="btn-ghost p-1.5"
                      onClick={() => void toggleLock(r)}
                      disabled={busy}
                      title={r.isLocked ? 'Unlock so the steps can be changed' : 'Lock while orders run against it'}
                      aria-label={r.isLocked ? `Unlock ${r.name}` : `Lock ${r.name}`}
                    >
                      {r.isLocked ? <Unlock size={15} /> : <Lock size={15} />}
                    </button>
                    <button
                      className="btn-ghost p-1.5"
                      onClick={() => setDialog({ open: true, record: r })}
                      title="Edit"
                      aria-label={`Edit ${r.name}`}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="btn-ghost p-1.5 text-muted-foreground hover:text-red-400"
                      onClick={() => void retire(r)}
                      disabled={busy}
                      title="Stop offering this routing"
                      aria-label={`Retire ${r.name}`}
                    >
                      <Ban size={15} />
                    </button>
                  </div>
                </div>

                {r.steps && r.steps.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-3">
                    {r.steps
                      .slice()
                      .sort((a, b) => a.sequence - b.sequence)
                      .map((s) => (
                        <span
                          key={s.id ?? s.sequence}
                          className={`text-[11px] px-2 py-1 rounded border ${
                            s.isQcStep
                              ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                              : 'border-border bg-secondary text-muted-foreground'
                          }`}
                          title={
                            s.workstation
                              ? `${s.operation?.name} at ${s.workstation.name}`
                              : s.operation?.name
                          }
                        >
                          <span className="font-mono opacity-60">{s.sequence}</span>{' '}
                          {s.operation?.name ?? 'Step'}
                          {s.workstation?.type === 'JOB_WORK' && ' ↗'}
                        </span>
                      ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        An arrow marks a step sent to an outside unit. Lock a routing once orders are running
        against it, so the path cannot change underneath work already in progress.
      </p>

      <RoutingFormDialog
        open={dialog.open}
        record={dialog.record}
        onClose={() => setDialog({ open: false, record: null })}
        onSaved={() => void load()}
      />
    </div>
  )
}
