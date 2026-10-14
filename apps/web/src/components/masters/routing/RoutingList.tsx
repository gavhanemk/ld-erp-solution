'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Ban, Lock, Pencil, Search, Unlock } from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import type { Routing } from '@/components/masters/RoutingFormDialog'
import { Pagination } from '@/components/tables/Pagination'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { useAppSettings } from '@/lib/appSettings'

/**
 * Every routing — for one style, for a category, or for any style — with its
 * steps in a line, to edit, lock or stop using. The second tab of Masters →
 * Routings; the first is the styles. Shared routings (a category's, or one
 * for any style) are only reached here, so the "For" filter picks them out.
 */
export function RoutingList({ reloadKey, onEdit, onMessage, onError }: { reloadKey: number; onEdit: (r: Routing) => void; onMessage: (m: string) => void; onError: (m: string | null) => void }) {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<Routing[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [applies, setApplies] = useState('')
  const [activeOnly, setActiveOnly] = useState(true)
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
    onError(null)
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
      onError(err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?')
      setRows([])
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
    // onError is the page's setter; a new reloadKey is how the page asks for a fresh list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, activeOnly, applies, rowsPerPage, page, reloadKey])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<{ message?: string }>, fallback: string) => {
    setBusy(true)
    onError(null)
    try {
      const res = await fn()
      onMessage(res.message ?? fallback)
      await load()
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }
  const mayEdit = can('masters', 'edit')

  return (
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
        <SmartSelect className="form-input h-8 w-48 py-0 text-xs" value={applies} onChange={(e) => setApplies(e.target.value)} aria-label="For">
          <option value="">All routings</option>
          <option value="STYLE">For one style</option>
          <option value="CATEGORY">Shared: for a category</option>
          <option value="ANY">Shared: for any style</option>
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
        <p className="text-muted-foreground px-4 py-10 text-center text-sm">
          {debounced || applies ? 'No routing matches that. Clear the search or the filter.' : 'No routings yet. Make one: cutting first, then each process in order, to the last check.'}
        </p>
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
                    {r.style ? `For style ${r.style.code} — ${r.style.name}` : r.category ? `Shared: every ${r.category} style` : 'Shared: any style'}
                    {' · '}
                    {r.steps?.length ?? 0} processes
                    {r._count?.mos ? ` · used on ${r._count.mos} ${r._count.mos === 1 ? 'order' : 'orders'}` : ''}
                    {' · '}
                    <span className="font-mono">{r.code}</span>, version {r.version}
                  </p>
                </div>
                {mayEdit && (
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    <button className="btn-secondary h-7 px-2.5 text-xs" onClick={() => onEdit(r)} aria-label={`Edit ${r.name}`}>
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
  )
}
