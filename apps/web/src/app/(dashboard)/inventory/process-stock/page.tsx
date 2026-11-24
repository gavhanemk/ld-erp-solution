'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowRight, Layers, RefreshCw, Search, X } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { cn } from '@/lib/utils'
import { FormFrame } from '@/components/ui/FormFrame'
import { StepInput } from '@/components/ui/StepInput'
import { SmartSelect } from '@/components/ui/SmartSelect'

/*
 * Inventory → Process Stock: work in progress and finished goods, size by
 * size at each process, for each order and style-colour — Cutting, Stitching,
 * … to the finished-goods store. Moving pieces on takes the sizes off one
 * process and puts them on the next, part of a lot at a time, never more than
 * is there.
 */

interface Column {
  id: string
  name: string
  kind: 'FLOOR' | 'STORE'
  process: string | null
}
interface Block {
  key: string
  item: { id: string; code: string; name: string; type: string; color: string | null; style: string | null; unit: string | null }
  orderNo: string | null
  sizes: Array<{ id: string | null; code: string }>
  cells: Record<string, Record<string, number>>
  totals: Record<string, number>
  total: number
  held: number
  bGrade: number
}
interface Data {
  columns: Column[]
  blocks: Block[]
  processes: Array<{ id: string; name: string; floorId: string | null }>
}

const num = (v: number | undefined) => (v ? v.toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '')

export default function ProcessStockPage() {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [moving, setMoving] = useState<Block | null>(null)
  const mayMove = can('inventory', 'create')

  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<{ data: Data }>(`/inventory/process-stock${term ? `?q=${encodeURIComponent(term)}` : ''}`)
      setData(res.data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load process stock. Is the API running?')
    } finally {
      setLoading(false)
    }
  }, [term])
  useEffect(() => {
    void load()
  }, [load])

  // Only the places holding something, in floor order then the stores.
  const columns = useMemo(
    () => (data?.columns ?? []).filter((c) => (data?.blocks ?? []).some((b) => (b.totals[c.id] ?? 0) !== 0)),
    [data],
  )
  const pieces = (data?.blocks ?? []).reduce((n, b) => n + b.total, 0)

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Process Stock</h1>
          <p className="page-subtitle">
            {loading && !data
              ? 'Loading...'
              : `${data?.blocks.length ?? 0} ${data?.blocks.length === 1 ? 'order line' : 'order lines'} · ${pieces.toLocaleString('en-IN')} pieces, size by size at each process`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => void load()} className="btn-secondary" title="Refresh">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <div className="glass-card flex flex-wrap items-center gap-2 p-4">
        <div className="border-border bg-secondary flex h-10 min-w-60 flex-1 items-center gap-2 rounded-lg border px-3">
          <Search size={15} className="text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order, style, item or colour..."
            className="text-foreground placeholder:text-muted-foreground flex-1 bg-transparent text-sm focus:outline-none"
            data-hotkey="search"
            aria-label="Search process stock"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground" aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <AlertCircle size={15} /> {error}
        </div>
      )}
      {notice && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-500">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {data && data.blocks.length === 0 && (
        <div className="glass-card text-muted-foreground flex flex-col items-center gap-2 p-10 text-center text-sm">
          <Layers size={28} />
          <p>{term ? `Nothing matches “${term}”.` : 'No work in progress or finished goods yet.'}</p>
          <p className="text-xs">Opening stock brought in by process shows here, size by size.</p>
        </div>
      )}

      {(data?.blocks ?? []).map((b) => (
        <section key={b.key} className="glass-card overflow-hidden" aria-label={`${b.orderNo ?? 'No order'} ${b.item.code}`}>
          <div className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-foreground text-sm font-semibold">
                {b.orderNo ?? <span className="text-muted-foreground font-normal">No order</span>}
                <span className="text-muted-foreground font-normal"> · </span>
                <span className="font-mono text-teal-400">{b.item.code}</span> {b.item.name}
              </div>
              <div className="text-muted-foreground text-xs">
                {[b.item.style, b.item.color].filter(Boolean).join(' · ') || (b.item.type === 'SEMI_FINISHED' ? 'Semi-finished' : '')}
              </div>
            </div>
            <span className="text-muted-foreground text-sm">
              <span className="text-foreground font-semibold tabular-nums">{b.total.toLocaleString('en-IN')}</span> {b.item.unit ?? 'pcs'}
            </span>
            {b.held > 0 && <span className="badge-warning">{num(b.held)} held</span>}
            {b.bGrade > 0 && <span className="badge-purple">{num(b.bGrade)} B-grade</span>}
            {mayMove && (
              <button type="button" className="btn-secondary h-8 text-xs" onClick={() => setMoving(b)}>
                <ArrowRight size={14} /> Move pieces
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground bg-secondary/40 text-[11px] font-semibold uppercase tracking-wide">
                  <th className="px-4 py-2 text-left">Size</th>
                  {columns.map((c) => (
                    <th key={c.id} className={cn('px-3 py-2 text-right', c.kind === 'STORE' && 'border-border border-l')}>
                      {c.name}
                    </th>
                  ))}
                  <th className="border-border border-l px-4 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {b.sizes.map((s) => {
                  const row = b.cells[s.id ?? 'none'] ?? {}
                  const total = Object.values(row).reduce((n, q) => n + q, 0)
                  return (
                    <tr key={s.id ?? 'none'} className="border-border border-t">
                      <td className="text-foreground px-4 py-1.5 font-semibold">{s.code}</td>
                      {columns.map((c) => (
                        <td key={c.id} className={cn('px-3 py-1.5 text-right tabular-nums', c.kind === 'STORE' && 'border-border border-l')}>
                          {num(row[c.id]) || <span className="text-muted-foreground">·</span>}
                        </td>
                      ))}
                      <td className="border-border border-l px-4 py-1.5 text-right font-semibold tabular-nums">{num(total)}</td>
                    </tr>
                  )
                })}
                <tr className="border-border bg-secondary/30 border-t font-semibold">
                  <td className="text-foreground px-4 py-1.5">Total</td>
                  {columns.map((c) => (
                    <td key={c.id} className={cn('px-3 py-1.5 text-right tabular-nums', c.kind === 'STORE' && 'border-border border-l')}>
                      {num(b.totals[c.id]) || <span className="text-muted-foreground">·</span>}
                    </td>
                  ))}
                  <td className="border-border border-l px-4 py-1.5 text-right tabular-nums">{num(b.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {moving && data && (
        <MoveDialog
          block={moving}
          data={data}
          onClose={() => setMoving(null)}
          onMoved={(message) => {
            setMoving(null)
            setNotice(message)
            void load()
          }}
        />
      )}
    </div>
  )
}

/**
 * Pieces of one order and style-colour moved on: from a process (or store)
 * to the next, size by size. Never more of a size than is there.
 */
function MoveDialog({ block, data, onClose, onMoved }: { block: Block; data: Data; onClose: () => void; onMoved: (message: string) => void }) {
  // Where this order's pieces are, in floor order then the stores.
  const sources = data.columns.filter((c) => (block.totals[c.id] ?? 0) > 0)
  const [from, setFrom] = useState(sources[0]?.id ?? '')
  // Where they can go: every process (its floor made if it has none yet), then the stores.
  const destinations = useMemo(() => {
    const floors = data.processes.map((p) => ({ value: p.floorId ? `w:${p.floorId}` : `p:${p.id}`, label: p.name, floorId: p.floorId }))
    const stores = data.columns.filter((c) => c.kind === 'STORE').map((c) => ({ value: `w:${c.id}`, label: c.name, floorId: c.id }))
    return [...floors, ...stores].filter((d) => d.floorId !== from)
  }, [data, from])
  // The next process after the one it is at.
  const nextAfter = (fromId: string) => {
    const at = data.processes.findIndex((p) => p.floorId === fromId)
    const next = at >= 0 ? data.processes[at + 1] : undefined
    return next ? (next.floorId ? `w:${next.floorId}` : `p:${next.id}`) : (destinations.find((d) => d.value.startsWith('w:'))?.value ?? '')
  }
  const [to, setTo] = useState(() => nextAfter(sources[0]?.id ?? ''))
  const [qty, setQty] = useState<Record<string, string>>({})
  const [lot, setLot] = useState('')
  const [bundle, setBundle] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const available = (sizeKey: string) => block.cells[sizeKey]?.[from] ?? 0
  const over = block.sizes.filter((s) => Number(qty[s.id ?? 'none'] || 0) > available(s.id ?? 'none'))
  const moving = block.sizes.reduce((n, s) => n + Number(qty[s.id ?? 'none'] || 0), 0)

  const submit = async () => {
    if (!from || !to) return setError('Pick where the pieces are and where they go.')
    if (over.length) return setError(`More than is there for size ${over.map((s) => s.code).join(', ')}.`)
    if (!moving) return setError('Enter how many pieces of at least one size move.')
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string }>('/inventory/process-stock/move', {
        itemId: block.item.id,
        fromWarehouseId: from,
        ...(to.startsWith('w:') ? { toWarehouseId: to.slice(2) } : { toProcessId: to.slice(2) }),
        orderNo: block.orderNo,
        lotNo: lot || null,
        bundleNo: bundle || null,
        notes: notes || null,
        lines: block.sizes.filter((s) => Number(qty[s.id ?? 'none'] || 0) > 0).map((s) => ({ sizeId: s.id, qty: Number(qty[s.id ?? 'none']) })),
      })
      onMoved(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not move the pieces.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormFrame
      icon={ArrowRight}
      title="Move pieces"
      subtitle={`${block.orderNo ?? 'No order'} · ${block.item.code} ${block.item.name}`}
      onClose={onClose}
      busy={busy}
      error={error}
      width="max-w-2xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy}>
          Move {moving ? moving.toLocaleString('en-IN') : ''} pieces
        </button>
      }
    >
      <div className="glass-card space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-foreground font-medium">From</span>
            <SmartSelect
              className="form-input"
              value={from}
              aria-label="From"
              onChange={(e) => {
                setFrom(e.target.value)
                setTo(nextAfter(e.target.value))
                setQty({})
              }}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({(block.totals[s.id] ?? 0).toLocaleString('en-IN')})
                </option>
              ))}
            </SmartSelect>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-foreground font-medium">To</span>
            <SmartSelect className="form-input" value={to} aria-label="To" onChange={(e) => setTo(e.target.value)}>
              {destinations.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </SmartSelect>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-foreground font-medium">Lot</span>
            <input className="form-input" value={lot} onChange={(e) => setLot(e.target.value)} placeholder="Optional" aria-label="Lot" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-foreground font-medium">Bundle</span>
            <input className="form-input" value={bundle} onChange={(e) => setBundle(e.target.value)} placeholder="Optional" aria-label="Bundle" />
          </label>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-left text-[11px] font-semibold uppercase tracking-wide">
              <th className="py-1.5">Size</th>
              <th className="py-1.5 text-right">There</th>
              <th className="w-40 py-1.5 text-right">Move</th>
            </tr>
          </thead>
          <tbody>
            {block.sizes.map((s) => {
              const k = s.id ?? 'none'
              const there = available(k)
              const tooMany = Number(qty[k] || 0) > there
              return (
                <tr key={k} className="border-border border-t">
                  <td className="text-foreground py-1.5 font-semibold">{s.code}</td>
                  <td className="text-muted-foreground py-1.5 text-right tabular-nums">{there.toLocaleString('en-IN')}</td>
                  <td className="py-1.5 pl-6">
                    <StepInput
                      className={cn('form-input text-right', tooMany && 'border-red-500')}
                      value={qty[k] ?? ''}
                      onValueChange={(v) => setQty((q) => ({ ...q, [k]: v }))}
                      max={there}
                      disabled={!there}
                      aria-label={`Pieces of size ${s.code} to move`}
                    />
                    {tooMany && <p className="mt-0.5 text-right text-[11px] text-red-400">Only {there} there</p>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <label className="block space-y-1 text-sm">
          <span className="text-foreground font-medium">Note</span>
          <input className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" aria-label="Note" />
        </label>
      </div>
    </FormFrame>
  )
}
