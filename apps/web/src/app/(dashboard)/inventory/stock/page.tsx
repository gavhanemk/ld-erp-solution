'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Search, RefreshCw, AlertCircle, AlertTriangle, PackagePlus, ClipboardCheck,
  ArrowLeftRight, Warehouse as WarehouseIcon, Printer,
} from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'
import { StockMoveDialog, type MoveMode } from '@/components/inventory/StockMoveDialog'

/**
 * What is on hand, right now, everywhere.
 *
 * One row per item and store rather than one per item: "we have 2,400 metres"
 * is not an answer a cutting master can act on if 2,000 of them are in a godown
 * two kilometres away.
 */

interface StockRow {
  itemId: string
  itemCode: string
  itemName: string
  uom: string
  categoryName: string
  reorderLevel: number | null
  warehouseId: string
  warehouseName: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerName: string | null
  qty: number
  value: number
  avgRate: number
  /** The item needs reordering: our own stock, every store together, at or below its level. */
  isLow: boolean
  /** Our own stock of the item in every store together, where it has a reorder level. */
  itemOnHand: number | null
  lastMovedAt: string | null
}

interface StockResponse {
  success: boolean
  data: StockRow[]
  summary: { lines: number; totalValue: number; lowCount: number }
}

const money = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const qtyFmt = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

function StockScreen() {
  const [rows, setRows] = useState<StockRow[]>([])
  const [summary, setSummary] = useState({ lines: 0, totalValue: 0, lowCount: 0 })
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [lowOnly, setLowOnly] = useState(false)
  // Arriving from the dashboard's "see all" opens straight on what to reorder.
  const params = useSearchParams()
  useEffect(() => {
    if (params.get('low') === 'true') setLowOnly(true)
  }, [params])
  const [dialog, setDialog] = useState<MoveMode | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    void masterResource<{ id: string; name: string }>('warehouses')
      .list({ limit: 100 })
      .then((r) => setWarehouses(r.data))
      .catch(() => undefined)
  }, [])

  // Replies can arrive out of order: the first, unfiltered load can land after
  // the one asked for a moment later, and overwrite it. Only the newest counts.
  const latest = useRef(0)

  const load = useCallback(async () => {
    const id = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      if (debounced) qs.set('q', debounced)
      if (warehouseId) qs.set('warehouseId', warehouseId)
      if (lowOnly) qs.set('low', 'true')

      const res = await api.get<StockResponse>(`/inventory/stock?${qs}`)
      if (id !== latest.current) return
      setRows(res.data)
      setSummary(res.summary)
    } catch (err) {
      if (id !== latest.current) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing stock.'
            : err.message
          : 'Could not reach the server. Is the API running?',
      )
      setRows([])
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [debounced, warehouseId, lowOnly])

  useEffect(() => {
    void load()
  }, [load])

  const customerOwned = useMemo(
    () => rows.filter((r) => r.ownership === 'CUSTOMER_OWNED'),
    [rows],
  )

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock</h1>
          <p className="page-subtitle">What is on hand, and where it is</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-ghost" onClick={() => setDialog('transfer')}>
            <ArrowLeftRight size={15} /> Move
          </button>
          <Link
            href={`/print/count-sheet${warehouseId ? `?warehouseId=${warehouseId}` : ''}`}
            className="btn-ghost"
            title="A sheet to take to the rack and write the count on"
          >
            <Printer size={15} /> Count sheet
          </Link>
          <button className="btn-ghost" onClick={() => setDialog('count')}>
            <ClipboardCheck size={15} /> Count
          </button>
          <button className="btn-primary" onClick={() => setDialog('opening')}>
            <PackagePlus size={15} /> Opening stock
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
          <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {message && (
        <div className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5">
          <p className="text-sm text-emerald-400">{message}</p>
        </div>
      )}

      {/* Three figures, and only three. The value is ours alone — a customer's
          fabric in our godown is somebody else's asset. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground">Stock value</p>
          <p className="mt-1 text-2xl font-bold text-foreground tabular-nums">
            ₹{money(summary.totalValue)}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            our own stock, at weighted average
          </p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground">Lines in stock</p>
          <p className="mt-1 text-2xl font-bold text-foreground tabular-nums">{summary.lines}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">item and store together</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground">Items to reorder</p>
          <p
            className={`mt-1 text-2xl font-bold tabular-nums ${
              summary.lowCount > 0 ? 'text-amber-400' : 'text-foreground'
            }`}
          >
            {summary.lowCount}
          </p>
          <button
            className="mt-0.5 text-[11px] text-teal-400 hover:underline"
            onClick={() => setLowOnly((v) => !v)}
          >
            {lowOnly ? 'show everything' : 'show only these'}
          </button>
          <p className="text-[10px] text-muted-foreground">
            our own stock, all stores together, at or below the reorder level
          </p>
        </div>
      </div>

      {customerOwned.length > 0 && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-sky-500/40 bg-sky-500/5">
          <WarehouseIcon size={16} className="text-sky-400 mt-0.5 shrink-0" />
          <p className="text-sm text-sky-300">
            {customerOwned.length} {customerOwned.length === 1 ? 'line is' : 'lines are'} customer
            fabric held for job work. It is in our godown but it is not ours, so it is left out of
            the stock value above.
          </p>
        </div>
      )}

      <div className="glass-card p-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border flex-1 min-w-[220px] max-w-sm">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="bg-transparent border-0 outline-none text-sm flex-1 text-foreground placeholder:text-muted-foreground"
              placeholder="Search item name or code..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search stock"
            />
          </div>
          <select
            className="form-input h-9 w-52"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            aria-label="Filter by store"
          >
            <option value="">All stores</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={lowOnly}
              onChange={(e) => setLowOnly(e.target.checked)}
            />
            Only items to reorder
          </label>
          <Link href="/inventory/ledger" className="text-xs text-teal-400 hover:underline ml-auto">
            See every movement →
          </Link>
        </div>

        {loading && rows.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              {debounced || warehouseId || lowOnly
                ? 'Nothing matches that.'
                : 'No stock yet. Start with opening stock — what is already on the racks today.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Store</th>
                  <th style={{ textAlign: 'right' }}>On hand</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.itemId}-${r.warehouseId}-${r.ownerName ?? ''}`}>
                    <td>
                      <Link
                        href={`/inventory/stock/${r.itemId}`}
                        className="font-medium text-foreground hover:text-teal-400"
                      >
                        {r.itemName}
                      </Link>
                      <div className="text-[10px] text-muted-foreground font-mono">
                        {r.itemCode} · {r.categoryName}
                      </div>
                    </td>
                    <td>
                      <div className="text-sm">{r.warehouseName}</div>
                      {r.ownership === 'CUSTOMER_OWNED' && (
                        <div className="text-[10px] text-sky-400">
                          {r.ownerName ?? 'customer'}&apos;s material
                        </div>
                      )}
                    </td>
                    <td className="text-right tabular-nums">
                      <div className="flex items-center justify-end gap-1.5">
                        {r.isLow && (
                          <AlertTriangle
                            size={13}
                            className="text-amber-400"
                            aria-label="Needs reordering"
                          />
                        )}
                        <span className={r.isLow ? 'text-amber-400 font-semibold' : ''}>
                          {qtyFmt(r.qty)}
                        </span>
                        <span className="text-xs text-muted-foreground w-8 text-left">{r.uom}</span>
                      </div>
                      {/* The flag is for the item, not this store: say what it
                        is judged on, so a store holding plenty is not a puzzle. */}
                      {r.isLow && r.reorderLevel !== null && (
                        <div className="text-[10px] text-muted-foreground">
                          {r.itemOnHand !== null && r.itemOnHand !== r.qty
                            ? `${qtyFmt(r.itemOnHand)} in all stores · `
                            : ''}
                          reorder at {qtyFmt(r.reorderLevel)}
                        </div>
                      )}
                    </td>
                    <td className="text-right tabular-nums text-muted-foreground">
                      {r.ownership === 'OWNED' ? `₹${money(r.avgRate)}` : '—'}
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      {r.ownership === 'OWNED' ? `₹${money(r.value)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog && (
        <StockMoveDialog
          mode={dialog}
          onClose={() => setDialog(null)}
          onSaved={(msg) => {
            setDialog(null)
            setMessage(msg)
            void load()
          }}
        />
      )}
    </div>
  )
}

// useSearchParams needs a Suspense boundary, as on the ledger page, or the
// whole route opts out of static rendering and the build refuses it.
export default function StockPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading...</p>}>
      <StockScreen />
    </Suspense>
  )
}
