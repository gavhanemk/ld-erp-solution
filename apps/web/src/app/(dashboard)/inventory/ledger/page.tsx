'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { formatDate } from '@/lib/utils'

/**
 * Every stock movement there has ever been.
 *
 * Read only, permanently. The balance on the stock screen is the sum of these
 * rows, so a ledger anybody could edit would make that figure meaningless —
 * and a stock figure nobody trusts is worse than no stock figure at all.
 */

interface Row {
  id: string
  transactionType: string
  referenceType: string | null
  inQty: string | number
  outQty: string | number
  closingStock: string | number
  unitRate: string | number | null
  transactionDate: string
  notes: string | null
  item: { id: string; code: string; name: string; uom: { symbol: string } }
  warehouse: { id: string; name: string }
  ownerCustomer: { id: string; name: string } | null
}

const MOVEMENT: Record<string, { label: string; cls: string }> = {
  OPENING: { label: 'Opening', cls: 'badge-neutral' },
  PURCHASE: { label: 'Received', cls: 'badge-success' },
  SALE: { label: 'Sold', cls: 'badge-info' },
  ISSUE: { label: 'Issued', cls: 'badge-warning' },
  PRODUCTION: { label: 'Produced', cls: 'badge-success' },
  TRANSFER: { label: 'Transfer', cls: 'badge-info' },
  ADJUSTMENT: { label: 'Count', cls: 'badge-danger' },
  RETURN: { label: 'Returned', cls: 'badge-neutral' },
}

const qtyFmt = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

function LedgerTable() {
  const params = useSearchParams()

  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([])
  const [warehouseId, setWarehouseId] = useState('')
  const [type, setType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  // Arriving from an item page should land already filtered to that item.
  const itemId = params.get('itemId') ?? ''

  useEffect(() => {
    void masterResource<{ id: string; name: string }>('warehouses')
      .list({ limit: 100 })
      .then((r) => setWarehouses(r.data))
      .catch(() => undefined)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: '50' })
      if (itemId) qs.set('itemId', itemId)
      if (warehouseId) qs.set('warehouseId', warehouseId)
      if (type) qs.set('type', type)
      if (from) qs.set('from', from)
      if (to) qs.set('to', to)

      const res = await api.get<Paginated<Row>>(`/inventory/ledger?${qs}`)
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing the stock ledger.'
            : err.message
          : 'Could not reach the server. Is the API running?',
      )
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [page, itemId, warehouseId, type, from, to])

  useEffect(() => {
    void load()
  }, [load])

  // Changing a filter while on page 4 would show an empty page 4 of a shorter
  // list, which reads as "no results" rather than "you moved".
  useEffect(() => {
    setPage(1)
  }, [warehouseId, type, from, to, itemId])

  const pages = Math.ceil(total / 50) || 1

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock Ledger</h1>
          <p className="page-subtitle">
            Every movement, newest first. This is the answer to &ldquo;why does it say that&rdquo;.
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
          <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {itemId && rows.length > 0 && (
        <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-secondary">
          <p className="text-sm text-foreground">
            Showing only <span className="font-medium">{rows[0].item.name}</span>
          </p>
          <Link href="/inventory/ledger" className="text-xs text-teal-400 hover:underline">
            Show everything
          </Link>
        </div>
      )}

      <div className="glass-card p-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
          <select
            className="form-input h-9 w-48"
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
          <select
            className="form-input h-9 w-40"
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label="Filter by movement"
          >
            <option value="">Every movement</option>
            {Object.entries(MOVEMENT).map(([v, m]) => (
              <option key={v} value={v}>
                {m.label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            From
            <input
              type="date"
              className="form-input h-9"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            To
            <input
              type="date"
              className="form-input h-9"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <span className="text-xs text-muted-foreground ml-auto">
            {total.toLocaleString('en-IN')} movements
          </span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Nothing here yet. Movements appear the moment stock is received, issued or counted.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What</th>
                  <th>Item</th>
                  <th>Store</th>
                  <th style={{ textAlign: 'right' }}>In</th>
                  <th style={{ textAlign: 'right' }}>Out</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const m = MOVEMENT[r.transactionType] ?? {
                    label: r.transactionType,
                    cls: 'badge-neutral',
                  }
                  const inQty = Number(r.inQty)
                  const outQty = Number(r.outQty)
                  return (
                    <tr key={r.id}>
                      <td className="text-xs whitespace-nowrap">{formatDate(r.transactionDate)}</td>
                      <td>
                        <span className={m.cls}>{m.label}</span>
                      </td>
                      <td>
                        <Link
                          href={`/inventory/stock/${r.item.id}`}
                          className="text-sm text-foreground hover:text-teal-400"
                        >
                          {r.item.name}
                        </Link>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {r.item.code}
                        </div>
                      </td>
                      <td className="text-xs">
                        {r.warehouse.name}
                        {r.ownerCustomer && (
                          <div className="text-[10px] text-sky-400">{r.ownerCustomer.name}</div>
                        )}
                      </td>
                      <td className="text-right tabular-nums text-emerald-400">
                        {inQty > 0 ? `${qtyFmt(inQty)} ${r.item.uom.symbol}` : ''}
                      </td>
                      <td className="text-right tabular-nums text-red-400">
                        {outQty > 0 ? `${qtyFmt(outQty)} ${r.item.uom.symbol}` : ''}
                      </td>
                      <td className="text-right tabular-nums font-semibold">
                        {qtyFmt(Number(r.closingStock))}
                      </td>
                      <td className="text-xs text-muted-foreground max-w-[220px] truncate">
                        {r.notes ?? ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />
      </div>
    </div>
  )
}

export default function LedgerPage() {
  // useSearchParams needs a Suspense boundary or the whole route opts out of
  // static rendering and Next refuses to build.
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading...</p>}>
      <LedgerTable />
    </Suspense>
  )
}
