'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Ban, Lock, Pencil, Plus, RefreshCw, Search, Unlock } from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { RoutingFormDialog, type Routing } from '@/components/masters/RoutingFormDialog'
import { Pagination } from '@/components/tables/Pagination'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { useAppSettings } from '@/lib/appSettings'

/**
 * Routings: where it is decided which processes a garment goes through, and
 * in what order — for one style, for every style of a category, or for any
 * style. A manufacturing order loads the stages of the routing that fits its
 * style once its materials are issued, and keeps its own copy; editing a
 * routing makes a new version for orders to come and never moves work
 * already running.
 */
export default function RoutingsPage() {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<Routing[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [applies, setApplies] = useState('')
  const [activeOnly, setActiveOnly] = useState(true)
  const [dialog, setDialog] = useState<{ open: boolean; record: Routing | null }>({ open: false, record: null })
  const [busy, setBusy] = useState(false)
  const latest = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => setPage(1), [debounced, applies, activeOnly])

  const load = useCallback(async () => {
    const ticket = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: String(rowsPerPage), page: String(page) })
      if (debounced) qs.set('q', debounced)
      if (activeOnly) qs.set('active', 'true')
      if (applies) qs.set('applies', applies)
      const res = await api.get<Paginated<Routing>>(`/masters/routings?${qs}`)
      if (ticket !== latest.current) return
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      if (ticket !== latest.current) return
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?')
      setRows([])
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [debounced, activeOnly, applies, rowsPerPage, page])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<{ message?: string }>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fn()
      setMessage(res.message ?? fallback)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }
  const mayEdit = can('masters', 'edit')

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title text-xl sm:text-2xl">Routings</h1>
          <p className="page-subtitle hidden sm:block">Decide here which processes a style goes through, and in what order</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {can('masters', 'create') && (
            <button className="btn-primary" onClick={() => setDialog({ open: true, record: null })}>
              <Plus size={15} /> <span className="hidden sm:inline">New routing</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {message && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
          <p className="text-primary text-sm">{message}</p>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="bg-field border-field-edge flex min-w-[200px] max-w-sm flex-1 items-center gap-2 rounded-lg border px-3 py-1.5">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Search routing, style or category…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search routings"
            />
          </div>
          <SmartSelect className="form-input h-8 w-44 py-0 text-xs" value={applies} onChange={(e) => setApplies(e.target.value)} aria-label="For">
            <option value="">All routings</option>
            <option value="STYLE">For one style</option>
            <option value="CATEGORY">For a category</option>
            <option value="ANY">For any style</option>
          </SmartSelect>
          <label className="text-muted-foreground flex cursor-pointer select-none items-center gap-2 text-xs">
            <input type="checkbox" className="accent-primary" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
            In use only
          </label>
          <span className="text-muted-foreground ml-auto text-xs">{total} routings</span>
        </div>

        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">No routings here. Make one: cutting first, then each process in order, to the last check.</p>
        ) : (
          <div className="divide-border/60 divide-y">
            {rows.map((r) => (
              <div key={r.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-foreground text-sm font-semibold">
                      {r.name}
                      {r.isLocked && <span className="text-muted-foreground font-normal"> (locked)</span>}
                      {!r.isActive && <span className="text-muted-foreground font-normal"> (not in use)</span>}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {r.style ? `For style ${r.style.code} — ${r.style.name}` : r.category ? `For every ${r.category} style` : 'For any style'}
                      {' · '}
                      {r.steps?.length ?? 0} processes
                      {r._count?.mos ? ` · used on ${r._count.mos} ${r._count.mos === 1 ? 'order' : 'orders'}` : ''}
                      {' · '}
                      <span className="font-mono">{r.code}</span>, version {r.version}
                    </p>
                  </div>
                  {mayEdit && (
                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      <button className="btn-secondary h-7 px-2.5 text-xs" onClick={() => setDialog({ open: true, record: r })} aria-label={`Edit ${r.name}`}>
                        <Pencil size={13} /> Edit
                      </button>
                      <button
                        className="btn-ghost h-7 px-2.5 text-xs"
                        onClick={() => void act(() => api.patch(`/masters/routings/${r.id}`, { isLocked: !r.isLocked }), r.isLocked ? 'Unlocked.' : 'Locked.')}
                        disabled={busy}
                        title={r.isLocked ? 'Unlock, so its processes can be changed' : 'Lock, so nobody changes its processes'}
                      >
                        {r.isLocked ? <Unlock size={13} /> : <Lock size={13} />} {r.isLocked ? 'Unlock' : 'Lock'}
                      </button>
                      {r.isActive && (
                        <button
                          className="btn-ghost text-muted-foreground hover:text-destructive h-7 px-2.5 text-xs"
                          onClick={() => {
                            if (confirm(`Stop offering "${r.name}" on new orders? Orders that already have its stages keep them.`)) {
                              void act(() => api.delete(`/masters/routings/${r.id}`), 'No longer offered.')
                            }
                          }}
                          disabled={busy}
                        >
                          <Ban size={13} /> Stop using
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {r.steps && r.steps.length > 0 && (
                  <ol className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1.5 text-xs">
                    {[...r.steps]
                      .sort((a, b) => a.sequence - b.sequence)
                      .map((s, i) => (
                        <li key={s.id ?? s.sequence} className="flex items-center gap-1">
                          {i > 0 && <ArrowRight size={12} className="text-muted-foreground shrink-0" aria-hidden />}
                          <span className="border-border text-foreground whitespace-nowrap rounded-md border px-2 py-0.5" title={s.instructions ?? undefined}>
                            <span className="text-muted-foreground tabular-nums">{s.sequence}.</span> {s.operation?.name ?? 'Process'}
                            {s.isQcStep && <span className="text-primary"> (check)</span>}
                            {s.execution === 'OUTSOURCED' && <span className="text-muted-foreground"> (outside unit)</span>}
                            {s.skip === 'OPTIONAL' && <span className="text-muted-foreground"> (optional)</span>}
                          </span>
                        </li>
                      ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
        )}
        <Pagination page={page} pages={Math.ceil(total / rowsPerPage) || 1} onPageChange={setPage} busy={loading} />
      </div>

      <p className="text-muted-foreground text-xs">
        A manufacturing order loads the stages of the routing for its style once its materials are issued, and can change them for itself. Changing a routing here
        makes a new version for orders to come; orders already running keep theirs.
      </p>

      <RoutingFormDialog open={dialog.open} record={dialog.record} onClose={() => setDialog({ open: false, record: null })} onSaved={(m) => {
          setMessage(m)
          void load()
        }}
      />
    </div>
  )
}
