'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, ArrowRight, Plus, RefreshCw, ShieldAlert } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { itemShade } from '@/lib/items'
import { loadInHouseBrands, type OwnBrand } from '@/components/sales/brand'
import { ReallocationDialog } from '@/components/inventory/ReallocationDialog'
import { REALLOCATION_STATUS, ReallocationView, type Reallocation } from '@/components/inventory/ReallocationView'

type View = 'MANUAL' | 'PENDING' | 'AUTO' | 'CLOSED' | 'ALL'
const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'MANUAL', label: 'Raised by people' },
  { key: 'PENDING', label: 'Waiting for approval' },
  { key: 'AUTO', label: 'Automatic (MOs and challans)' },
  { key: 'CLOSED', label: 'Refused, withdrawn, reversed' },
  { key: 'ALL', label: 'All' },
]
const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const qtyOf = (n: string | number) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 })

/** A brand's name as a chip; central stock, which is the company's, in grey. */
function Share({ name }: { name: string | null }) {
  return name ? <span className="badge-info whitespace-nowrap">{name}</span> : <span className="badge-neutral whitespace-nowrap">Central stock</span>
}

/** Which brand a line is about: the one that got the stock, gave it back, or both for a move. */
function BrandCell({ r }: { r: Reallocation }) {
  if (r.kind === 'MOVE')
    return (
      <span className="flex flex-wrap items-center gap-1">
        <Share name={r.fromBrand?.name ?? null} />
        <ArrowRight size={12} className="text-muted-foreground" />
        <Share name={r.toBrand?.name ?? null} />
      </span>
    )
  return <Share name={(r.kind === 'RELEASE' ? r.fromBrand?.name : r.toBrand?.name) ?? null} />
}

/** What happened, in a few words a store keeper would say; the Brand column already names the brand. */
function what(r: Reallocation): string {
  if (r.kind === 'EARMARK') return 'Set aside out of central stock'
  if (r.kind === 'MOVE') return 'Handed from one brand to the other'
  if (r.kind === 'RELEASE') return 'Given back to central stock'
  if (r.dc) return `From central stock, for challan ${r.dc.dcNumber}`
  if (r.mo) return `From central stock, for ${r.mo.moNumber}`
  return 'From central stock'
}

/**
 * Inventory → Brand Stock. All stock is the company's. Central stock is kept
 * for no brand; a brand's share is set aside for it, on the same rack. This
 * lists every change of whose stock it is: what people raised (an earmark, a
 * move between brands, a release back to central), each approved by someone
 * else, and what MOs and challans took from central stock by themselves.
 */
export default function BrandStockPage() {
  const [view, setView] = useState<View>('MANUAL')
  const [brandId, setBrandId] = useState('')
  const [brands, setBrands] = useState<OwnBrand[]>([])
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<Reallocation[]>([])
  const [total, setTotal] = useState(0)
  const [pending, setPending] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [raising, setRaising] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    loadInHouseBrands()
      .then(setBrands)
      .catch(() => setBrands([]))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: '100' })
      if (view === 'PENDING' || view === 'CLOSED') qs.set('status', view)
      if (view === 'MANUAL' || view === 'AUTO') qs.set('kind', view)
      if (brandId) qs.set('brandId', brandId)
      if (q.trim()) qs.set('q', q.trim())
      const res = await api.get<{ data: Reallocation[]; pending: number; pagination: { total: number } }>(`/inventory/reallocations?${qs}`)
      setRows(res.data)
      setTotal(res.pagination?.total ?? res.data.length)
      setPending(res.pending)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load brand stock.'))
    } finally {
      setLoading(false)
    }
  }, [view, brandId, q])

  useEffect(() => {
    void load()
    const id = new URLSearchParams(window.location.search).get('open')
    if (id) setOpen(id)
  }, [load])

  const chip = (active: boolean) => `btn-ghost h-8 px-2 text-xs ${active ? 'bg-primary/10 text-primary font-semibold' : ''}`

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Brand Stock</h1>
          <p className="page-subtitle hidden sm:block">Whose stock it is: central stock, kept for no brand, or a brand’s share. Nothing moves on the rack.</p>
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

      <div className="glass-card space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Brand">
          <span className="text-muted-foreground mr-1 text-xs font-medium">Brand</span>
          <button type="button" role="radio" aria-checked={brandId === ''} className={chip(brandId === '')} onClick={() => setBrandId('')}>
            Every brand
          </button>
          {brands.map((b) => (
            <button key={b.id} type="button" role="radio" aria-checked={brandId === b.id} className={chip(brandId === b.id)} onClick={() => setBrandId(b.id)}>
              {b.name}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Show">
          <span className="text-muted-foreground mr-1 text-xs font-medium">Show</span>
          {VIEWS.map((f) => (
            <button key={f.key} type="button" role="radio" aria-checked={view === f.key} className={chip(view === f.key)} onClick={() => setView(f.key)}>
              {f.label}
              {f.key === 'PENDING' && pending > 0 ? ` (${pending})` : ''}
            </button>
          ))}
          <input id="brand-stock-search" className="form-input ml-auto h-8 w-60 text-xs" placeholder="Number, item, MO or challan…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        </div>
      </div>

      <div className="glass-card overflow-hidden p-0">
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-3 text-sm">
            {loading
              ? 'Loading…'
              : view === 'MANUAL' && !brandId && !q
                ? 'Nothing raised yet. Stock stays central until someone earmarks it for a brand; MOs and challans take what they need from central stock by themselves (see “Automatic”).'
                : 'Nothing matches.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table table-compact w-full min-w-[1000px]">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Date</th>
                  <th>Brand</th>
                  <th>What happened</th>
                  <th>Item</th>
                  <th>Store</th>
                  <th className="text-right">Value ₹</th>
                  <th>Status</th>
                  <th>Raised by</th>
                  <th>Approved by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const first = r.lines[0]
                  const shade = first ? itemShade(first.item) : ''
                  return (
                    <tr key={r.id} className="cursor-pointer" onClick={() => setOpen(r.id)}>
                      <td>
                        <button type="button" className="text-primary font-mono text-xs hover:underline" onClick={() => setOpen(r.id)}>
                          {r.number}
                        </button>
                      </td>
                      <td className="whitespace-nowrap text-xs">{when(r.createdAt)}</td>
                      <td className="text-xs">
                        <BrandCell r={r} />
                      </td>
                      <td className="text-xs">{what(r)}</td>
                      <td className="text-xs">
                        {first ? (
                          <>
                            <span className="text-foreground">{first.item.name}</span>
                            {shade && <span className="text-muted-foreground"> · {shade}</span>}
                            {first.size && <span className="text-muted-foreground"> · {first.size.code}</span>}
                            <span className="text-muted-foreground block tabular-nums">
                              {qtyOf(first.qty)} {first.item.uom?.symbol ?? ''}
                              {r.lines.length > 1 ? ` · and ${r.lines.length - 1} more item${r.lines.length > 2 ? 's' : ''}` : ''}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="text-xs">{r.warehouse.name}</td>
                      <td className="text-right tabular-nums">{r.status === 'PENDING' ? '—' : r.value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
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
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {total > rows.length && <p className="text-muted-foreground border-border border-t px-4 py-2 text-xs">Showing the latest {rows.length} of {total}. Pick a brand or search to narrow it.</p>}
      </div>
      <p className="text-muted-foreground text-xs">
        Grey is central stock, the company’s, kept for no brand; blue is a brand’s share. An earmark, a move or a release changes whose stock it is, never where it is, and each share keeps its own average cost. MOs and challans take what their brand is short of from central stock by themselves: those are under “Automatic”.
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
