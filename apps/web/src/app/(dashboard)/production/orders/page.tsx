'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, Download, Search, RefreshCw, AlertCircle } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'

interface ManufacturingOrder {
  id: string
  moNumber: string
  status: string
  brand: { id: string; name: string; type: string }
  customer: string | null
  soNumber: string | null
  styles: string[]
  plannedStartDate: string | null
  plannedEndDate: string | null
  totalPlannedQty: number
  totalCutQty: number
  totalStitchedQty: number
  totalFinishedQty: number
  totalPackedQty: number
}

/** MOStatus in workflow order, so the filter reads like the shop floor. */
const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral' },
  RELEASED: { label: 'Released', cls: 'badge-info' },
  CUTTING: { label: 'Cutting', cls: 'badge-purple' },
  STITCHING: { label: 'Stitching', cls: 'badge-warning' },
  FINISHING: { label: 'Finishing', cls: 'badge-warning' },
  QC: { label: 'QC', cls: 'badge-info' },
  PACKING: { label: 'Packing', cls: 'badge-info' },
  COMPLETED: { label: 'Completed', cls: 'badge-success' },
  CLOSED: { label: 'Closed', cls: 'badge-neutral' },
}

export default function ProductionOrdersPage() {
  const [orders, setOrders] = useState<ManufacturingOrder[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: '25' })
      if (status) qs.set('status', status)

      const res = await api.get<{
        success: boolean
        data: ManufacturingOrder[]
        pagination: { total: number }
      }>(`/production/orders?${qs}`)

      setOrders(res.data)
      setTotal(res.pagination?.total ?? res.data.length)
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?',
      )
      setOrders(null)
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    void load()
  }, [load])

  const visible = (orders ?? []).filter((o) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      o.moNumber.toLowerCase().includes(q) ||
      o.customer?.toLowerCase().includes(q) ||
      o.soNumber?.toLowerCase().includes(q) ||
      o.styles.some((s) => s.toLowerCase().includes(q))
    )
  })

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Manufacturing Orders</h1>
          <p className="page-subtitle">
            {loading && !orders ? 'Loading...' : `${total} order${total === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => void load()} className="btn-secondary">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button className="btn-secondary" disabled title="Export is not built yet">
            <Download size={15} />
            Export
          </button>
          <Link href="/production/orders/new" className="btn-primary" id="new-mo-btn">
            <Plus size={15} />
            New MO
          </Link>
        </div>
      </div>

      <div className="glass-card p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-60 flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border">
          <Search size={15} className="text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search MO number, style, customer..."
            className="bg-transparent text-sm text-foreground placeholder:text-muted-foreground flex-1 focus:outline-none"
          />
        </div>
        <select
          className="form-input w-auto"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All Status</option>
          {Object.entries(STATUS_CONFIG).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="glass-card p-4 flex items-start gap-3 border-red-500/40">
          <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-400">Could not load manufacturing orders</p>
            <p className="text-xs text-muted-foreground mt-1">{error}</p>
          </div>
        </div>
      )}

      <div className="glass-card p-6">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>MO #</th>
                <th>Sales Order</th>
                <th>Customer</th>
                <th>Brand</th>
                <th>Styles</th>
                <th className="text-right">Planned</th>
                <th>Progress</th>
                <th>Delivery</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                !orders &&
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 9 }).map((__, j) => (
                      <td key={j}>
                        <div className="skeleton h-4 w-20" />
                      </td>
                    ))}
                  </tr>
                ))}

              {!loading && orders && visible.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-10 text-muted-foreground">
                    {orders.length === 0
                      ? 'No manufacturing orders have been raised yet.'
                      : 'No orders match these filters.'}
                  </td>
                </tr>
              )}

              {visible.map((mo) => {
                const s = STATUS_CONFIG[mo.status] ?? { label: mo.status, cls: 'badge-neutral' }
                // Packed is the only stage that means finished goods exist.
                const done = mo.totalPackedQty
                const pct =
                  mo.totalPlannedQty > 0
                    ? Math.min(100, Math.round((done / mo.totalPlannedQty) * 100))
                    : 0
                const late =
                  mo.plannedEndDate &&
                  new Date(mo.plannedEndDate) < new Date() &&
                  mo.status !== 'COMPLETED' &&
                  mo.status !== 'CLOSED'

                return (
                  <tr key={mo.id}>
                    <td>
                      <Link
                        href={`/production/orders/${mo.id}`}
                        className="font-mono text-xs text-teal-400 hover:text-teal-300 transition-colors"
                      >
                        {mo.moNumber}
                      </Link>
                    </td>
                    <td className="font-mono text-xs text-muted-foreground">
                      {mo.soNumber ?? '—'}
                    </td>
                    <td className="font-medium">{mo.customer ?? '—'}</td>
                    <td>
                      <span
                        className={
                          mo.brand.type === 'VHAGAR'
                            ? 'vhagar-accent font-bold text-xs'
                            : 'text-muted-foreground text-xs'
                        }
                      >
                        {mo.brand.name}
                      </span>
                    </td>
                    <td className="font-mono text-xs text-muted-foreground">
                      {mo.styles.length === 0
                        ? '—'
                        : mo.styles.length === 1
                          ? mo.styles[0]
                          : `${mo.styles[0]} +${mo.styles.length - 1}`}
                    </td>
                    <td className="text-right font-semibold">
                      {mo.totalPlannedQty.toLocaleString('en-IN')}
                    </td>
                    <td className="min-w-32">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-teal-500 transition-all duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground w-8 text-right">
                          {pct}%
                        </span>
                      </div>
                    </td>
                    <td
                      className={
                        late ? 'text-red-400 text-xs font-semibold' : 'text-muted-foreground text-xs'
                      }
                    >
                      {mo.plannedEndDate ? formatDate(mo.plannedEndDate) : '—'}
                      {late && ' ⚠'}
                    </td>
                    <td>
                      <span className={s.cls}>{s.label}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
