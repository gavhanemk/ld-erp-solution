'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ClipboardCheck, Loader2, Plus, ScanLine, Search, X } from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { Pagination } from '@/components/tables/Pagination'
import { ADJ_STATUS, COUNT_STATUS, type CountRow, type CountStatus, when } from './countTypes'

const FILTERS: Array<{ key: '' | CountStatus; label: string }> = [
  { key: '', label: 'All' },
  { key: 'OPEN', label: 'Counting' },
  { key: 'SUBMITTED', label: 'Waiting for approval' },
  { key: 'CLOSED', label: 'Closed' },
  { key: 'CANCELLED', label: 'Cancelled' },
]

/**
 * Every stock count, newest first: which store, who started it, how many
 * stickers were found and not found, and the adjustment it raised. A row opens
 * the count; "Start a count" begins a new one for a store.
 */
export function StockCountList({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<CountRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<'' | CountStatus>('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => setPage(1), [q, status])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: '25' })
      if (status) qs.set('status', status)
      if (q) qs.set('q', q)
      const res = await api.get<Paginated<CountRow>>(`/stock-counts?${qs}`)
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the counts.')
    } finally {
      setLoading(false)
    }
  }, [page, status, q])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title text-xl sm:text-2xl">Stock Count</h1>
          <p className="page-subtitle">Count a store by scanning every sticker on its racks. What does not match goes to a store manager as an adjustment.</p>
        </div>
        {can('inventory', 'create') && (
          <button type="button" className="btn-primary" onClick={() => setStarting(true)}>
            <Plus size={15} /> Start a count
          </button>
        )}
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="bg-field border-field-edge flex min-w-[180px] max-w-xs flex-1 items-center gap-2 rounded-lg border px-3 py-1.5">
            <Search size={14} className="text-muted-foreground" />
            <input className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none" placeholder="Count number or store…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search counts" />
          </div>
          {FILTERS.map((f) => (
            <button
              key={f.key || 'all'}
              type="button"
              onClick={() => setStatus(f.key)}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${status === f.key ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
            >
              {f.label}
            </button>
          ))}
          <span className="text-muted-foreground ml-auto text-xs">
            {total} {total === 1 ? 'count' : 'counts'}
          </span>
        </div>

        {loading && !rows.length ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : !rows.length ? (
          <div className="px-4 py-12 text-center">
            <ClipboardCheck size={28} className="text-muted-foreground mx-auto" />
            <p className="text-foreground mt-2 text-sm font-medium">{q || status ? 'No count matches that.' : 'No stock count yet.'}</p>
            <p className="text-muted-foreground mt-1 text-sm">Start one for a store, then scan every sticker on its racks — on a phone or with a scanner.</p>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="data-table w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th>Count</th>
                    <th>Store</th>
                    <th>Started</th>
                    <th style={{ textAlign: 'right' }}>Stickers scanned</th>
                    <th style={{ textAlign: 'right' }}>Not found</th>
                    <th>Adjustment</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const st = COUNT_STATUS[r.status]
                    const adj = r.adjustment ? ADJ_STATUS[r.adjustment.status] : null
                    return (
                      <tr key={r.id} className="cursor-pointer" onClick={() => onOpen(r.id)}>
                        <td className="text-primary whitespace-nowrap font-mono text-xs font-semibold">{r.countNumber}</td>
                        <td className="text-foreground font-medium">{r.store}</td>
                        <td className="whitespace-nowrap text-xs">
                          {when(r.startedAt)}
                          {r.startedBy && <span className="text-muted-foreground block text-[11px]">by {r.startedBy}</span>}
                        </td>
                        <td className="text-right tabular-nums">
                          {r.found}
                          {r.scans > r.found && <span className="text-amber-600 text-[11px]"> +{r.scans - r.found} to check</span>}
                        </td>
                        <td className="text-right tabular-nums">{r.notFound == null ? <span className="text-muted-foreground">—</span> : r.notFound}</td>
                        <td className="whitespace-nowrap">
                          {r.adjustment ? (
                            <>
                              <span className="font-mono text-xs">{r.adjustment.adjustmentNumber}</span> <span className={`${adj?.cls ?? 'badge-neutral'} ml-1`}>{adj?.label ?? r.adjustment.status}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td>
                          <span className={st.cls}>{st.label}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="divide-border/60 divide-y md:hidden">
              {rows.map((r) => {
                const st = COUNT_STATUS[r.status]
                return (
                  <button key={r.id} type="button" onClick={() => onOpen(r.id)} className="hover:bg-secondary/60 block w-full space-y-1 px-4 py-3 text-left">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-primary font-mono text-xs font-semibold">{r.countNumber}</span>
                      <span className={st.cls}>{st.label}</span>
                    </span>
                    <span className="text-foreground block text-sm font-medium">{r.store}</span>
                    <span className="text-muted-foreground block text-xs">
                      {when(r.startedAt)} · {r.found} scanned{r.notFound != null ? ` · ${r.notFound} not found` : ''}
                      {r.adjustment ? ` · ${r.adjustment.adjustmentNumber}` : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        )}
        <Pagination page={page} pages={Math.ceil(total / 25) || 1} onPageChange={setPage} busy={loading} />
      </div>

      {starting && <StartCount onClose={() => setStarting(false)} onStarted={onOpen} />}
    </div>
  )
}

/** Pick the store; the count starts empty and opens for scanning. */
function StartCount({ onClose, onStarted }: { onClose: () => void; onStarted: (id: string) => void }) {
  const [stores, setStores] = useState<Array<{ id: string; name: string }> | null>(null)
  const [warehouseId, setWarehouseId] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Array<{ id: string; name: string }> }>('/masters/warehouses?limit=100&active=true')
      .then((r) => setStores(r.data))
      .catch(() => setStores([]))
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const start = async () => {
    if (!warehouseId) return setError('Pick the store being counted.')
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ data: { id: string } }>('/stock-counts', { warehouseId, notes: notes.trim() || null })
      onStarted(res.data.id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the count.')
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:left-[var(--sidebar-current-width)]">
      <div className="glass-card w-full max-w-md p-0" role="dialog" aria-modal="true" aria-labelledby="start-count-title">
        <div className="flex items-start gap-3 p-5 pb-3">
          <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <ScanLine size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="start-count-title" className="text-foreground text-lg font-semibold">
              Start a stock count
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">Then scan every sticker on the store&apos;s racks. Nothing in stock changes until a store manager approves what it finds.</p>
          </div>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3 px-5">
          <label className="block">
            <span className="form-label">Store</span>
            <SmartSelect className="form-input" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label="Store">
              <option value="">{stores ? 'Pick the store…' : 'Loading the stores…'}</option>
              {(stores ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SmartSelect>
          </label>
          <label className="block">
            <span className="form-label">Note (optional)</span>
            <input className="form-input" value={notes} maxLength={500} placeholder="e.g. Month-end count, racks A to D" onChange={(e) => setNotes(e.target.value)} />
          </label>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 p-5">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Not now
          </button>
          <button type="button" className="btn-primary" onClick={() => void start()} disabled={busy || !warehouseId}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <ScanLine size={15} />} Start counting
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
