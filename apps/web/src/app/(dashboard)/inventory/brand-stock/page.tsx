'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Plus, RefreshCw, ShieldAlert } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { ReallocationDialog } from '@/components/inventory/ReallocationDialog'
import { REALLOCATION_STATUS, ReallocationView, type Reallocation } from '@/components/inventory/ReallocationView'

type Filter = 'ALL' | 'PENDING' | 'POSTED' | 'AUTO' | 'CLOSED'
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'PENDING', label: 'Waiting for approval' },
  { key: 'POSTED', label: 'Posted' },
  { key: 'AUTO', label: 'Automatic (MO issues)' },
  { key: 'CLOSED', label: 'Refused, withdrawn, reversed' },
]
const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Inventory → Brand Stock. Stock is the company's; a brand's share of it is
 * earmarked, here: central stock set aside for a brand, handed from one
 * brand to another, or given back — each raised by one person and approved by
 * another. An MO's material issue makes its own, within decision 7's rules.
 */
export default function BrandStockPage() {
  const [filter, setFilter] = useState<Filter>('ALL')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<Reallocation[]>([])
  const [pending, setPending] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [raising, setRaising] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: '100' })
      if (filter === 'PENDING' || filter === 'POSTED') qs.set('status', filter)
      if (filter === 'AUTO') qs.set('kind', 'AUTO')
      if (q.trim()) qs.set('q', q.trim())
      const res = await api.get<{ data: Reallocation[]; pending: number }>(`/inventory/reallocations?${qs}`)
      setRows(filter === 'CLOSED' ? res.data.filter((r) => ['REJECTED', 'CANCELLED', 'REVERSED'].includes(r.status)) : res.data)
      setPending(res.pending)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load brand stock.'))
    } finally {
      setLoading(false)
    }
  }, [filter, q])

  useEffect(() => {
    void load()
    const id = new URLSearchParams(window.location.search).get('open')
    if (id) setOpen(id)
  }, [load])

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Brand Stock</h1>
          <p className="page-subtitle hidden sm:block">Central stock earmarked for brands: earmarks, moves between brands, releases</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {can('inventory.brand-stock', 'create') && (
            <button type="button" className="btn-primary" onClick={() => setRaising(true)}>
              <Plus size={15} /> <span className="hidden sm:inline">Earmark, move or release</span>
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

      <div className="glass-card flex flex-wrap items-center gap-2 p-3">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`btn-ghost h-8 px-2 text-xs ${filter === f.key ? 'bg-primary/10 text-primary' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {f.key === 'PENDING' && pending > 0 ? ` (${pending})` : ''}
          </button>
        ))}
        <input className="form-input ml-auto h-8 w-56 text-xs" placeholder="Number, MO or why…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      </div>

      <div className="glass-card overflow-hidden p-0">
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-3 text-sm">{loading ? 'Loading…' : 'Nothing here yet. Stock stays central until it is earmarked for a brand, or an MO’s issue moves it.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table table-compact w-full min-w-[900px]">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Date</th>
                  <th>What</th>
                  <th>From → to</th>
                  <th>Store</th>
                  <th className="text-right">Items</th>
                  <th className="text-right">Value</th>
                  <th>Status</th>
                  <th>Raised by</th>
                  <th>Approved by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer" onClick={() => setOpen(r.id)}>
                    <td>
                      <button type="button" className="text-primary font-mono text-xs hover:underline" onClick={() => setOpen(r.id)}>
                        {r.number}
                      </button>
                    </td>
                    <td className="whitespace-nowrap text-xs">{when(r.createdAt)}</td>
                    <td className="text-xs">
                      {r.kindWords}
                      {r.mo ? <span className="text-muted-foreground block">{r.mo.moNumber}</span> : null}
                    </td>
                    <td className="text-xs">
                      {r.from} → {r.to}
                    </td>
                    <td className="text-xs">{r.warehouse.name}</td>
                    <td className="text-right tabular-nums">{r.lines.length}</td>
                    <td className="text-right tabular-nums">{r.status === 'PENDING' ? '—' : `₹${r.value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}</td>
                    <td>
                      <span className={REALLOCATION_STATUS[r.status].badge}>{REALLOCATION_STATUS[r.status].label}</span>
                    </td>
                    <td className="text-xs">{r.requestedBy.name}</td>
                    <td className="text-xs">
                      {r.approvedBy?.name ?? (r.kind === 'AUTO' ? 'Automatic' : '')}
                      {r.selfApproved && (
                        <span className="badge-warning ml-1" title={r.overrideReason ?? ''}>
                          <ShieldAlert size={11} /> override
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Earmarking moves no cloth: it says whose share of the store’s stock it is. Each share keeps its own average cost, and the company’s stock and value never change. A brand’s stock is taken only by that brand’s orders; anything else takes central stock.
      </p>

      {raising && (
        <ReallocationDialog
          onClose={() => setRaising(false)}
          onSaved={(m, id) => {
            setRaising(false)
            setMessage(m)
            setOpen(id)
            void load()
          }}
        />
      )}
      {open && (
        <ReallocationView
          id={open}
          onClose={() => setOpen(null)}
          onChanged={(m) => {
            setMessage(m)
            void load()
          }}
        />
      )}
    </div>
  )
}
