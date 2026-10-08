'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, Download, Search, RefreshCw, AlertCircle } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatCurrency, formatDate } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'

interface SalesOrder {
  id: string
  soNumber: string
  status: string
  totalAmount: string | number
  deliveryDate: string | null
  isJobWork: boolean
  customer: { id: string; name: string; type: string }
  brand: { id: string; name: string; type: string }
  _count: { lines: number }
}

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral' },
  CONFIRMED: { label: 'Confirmed', cls: 'badge-info' },
  IN_PRODUCTION: { label: 'In Production', cls: 'badge-warning' },
  PARTIALLY_DISPATCHED: { label: 'Part Dispatched', cls: 'badge-success' },
  COMPLETED: { label: 'Completed', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-danger' },
}

const PAGE_SIZE = 25

export default function SalesOrdersPage() {
  const [orders, setOrders] = useState<SalesOrder[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [status, setStatus] = useState('')
  const [jobWork, setJobWork] = useState('')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (status) qs.set('status', status)

      const res = await api.get<{
        success: boolean
        data: SalesOrder[]
        pagination: { total: number }
      }>(`/sales/orders?${qs}`)

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

  // The API filters by status server-side; job-work and free-text narrowing
  // happen here because it has no parameters for them yet.
  const visible = (orders ?? []).filter((o) => {
    if (jobWork === 'true' && !o.isJobWork) return false
    if (jobWork === 'false' && o.isJobWork) return false
    if (search) {
      const q = search.toLowerCase()
      if (
        !o.soNumber.toLowerCase().includes(q) &&
        !o.customer.name.toLowerCase().includes(q) &&
        !o.brand.name.toLowerCase().includes(q)
      ) {
        return false
      }
    }
    return true
  })

  const totalValue = visible.reduce((s, o) => s + Number(o.totalAmount), 0)
  const inProduction = visible.filter((o) => o.status === 'IN_PRODUCTION').length

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Sales Orders</h1>
          <p className="page-subtitle">
            {loading && !orders ? 'Loading...' : `${total} order${total === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => void load()} className="btn-secondary">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button className="btn-secondary" disabled title="Export is not built yet">
            <Download size={16} />
            Export
          </button>
          <Link href="/sales/orders/new" className="btn-primary" id="new-so-btn">
            <Plus size={16} />
            New Order
          </Link>
        </div>
      </div>

      <div className="glass-card p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-60 flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border">
          <Search size={15} className="text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order number, customer, brand..."
            className="bg-transparent text-sm text-foreground placeholder:text-muted-foreground flex-1 focus:outline-none"
          />
        </div>
        <SmartSelect
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
        </SmartSelect>
        <SmartSelect
          className="form-input w-auto"
          value={jobWork}
          onChange={(e) => setJobWork(e.target.value)}
        >
          <option value="">All Types</option>
          <option value="false">Regular</option>
          <option value="true">Job Work</option>
        </SmartSelect>
      </div>

      {error && (
        <div className="glass-card p-4 flex items-start gap-3 border-red-500/40">
          <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-400">Could not load sales orders</p>
            <p className="text-xs text-muted-foreground mt-1">{error}</p>
          </div>
        </div>
      )}

      {!error && orders && orders.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Shown', value: String(visible.length), color: 'text-foreground' },
            { label: 'In Production', value: String(inProduction), color: 'text-amber-400' },
            {
              label: 'Order Lines',
              value: String(visible.reduce((s, o) => s + (o._count?.lines ?? 0), 0)),
              color: 'text-teal-400',
            },
            { label: 'Total Value', value: formatCurrency(totalValue), color: 'text-emerald-400' },
          ].map((stat) => (
            <div key={stat.label} className="glass-card p-4 text-center">
              <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="glass-card p-6">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Order #</th>
                <th>Customer</th>
                <th>Brand</th>
                <th>Type</th>
                <th className="text-right">Lines</th>
                <th className="text-right">Amount</th>
                <th>Delivery</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                !orders &&
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 8 }).map((__, j) => (
                      <td key={j}>
                        <div className="skeleton h-4 w-20" />
                      </td>
                    ))}
                  </tr>
                ))}

              {!loading && orders && visible.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-10 text-muted-foreground">
                    {orders.length === 0
                      ? 'No sales orders have been raised yet.'
                      : 'No orders match these filters.'}
                  </td>
                </tr>
              )}

              {visible.map((order) => {
                const s = STATUS_CONFIG[order.status] ?? {
                  label: order.status,
                  cls: 'badge-neutral',
                }
                const overdue =
                  order.deliveryDate &&
                  new Date(order.deliveryDate) < new Date() &&
                  order.status !== 'COMPLETED' &&
                  order.status !== 'CANCELLED'

                return (
                  <tr key={order.id}>
                    <td>
                      <Link
                        href={`/sales/orders/${order.id}`}
                        className="font-mono text-xs text-teal-400 hover:text-teal-300 transition-colors"
                      >
                        {order.soNumber}
                      </Link>
                    </td>
                    <td className="font-medium">{order.customer.name}</td>
                    <td>
                      <span
                        className={
                          order.brand.type === 'VHAGAR'
                            ? 'vhagar-accent font-bold text-xs'
                            : 'text-muted-foreground text-xs'
                        }
                      >
                        {order.brand.name}
                      </span>
                    </td>
                    <td>
                      {order.isJobWork ? (
                        <span className="badge-purple">Job Work</span>
                      ) : (
                        <span className="badge-neutral">Regular</span>
                      )}
                    </td>
                    <td className="text-right text-muted-foreground text-xs">
                      {order._count?.lines ?? 0}
                    </td>
                    <td className="text-right font-semibold">
                      {/* Job work bills on conversion, so zero is expected. */}
                      {Number(order.totalAmount) > 0
                        ? formatCurrency(Number(order.totalAmount))
                        : '—'}
                    </td>
                    <td
                      className={
                        overdue
                          ? 'text-red-400 text-xs font-semibold'
                          : 'text-muted-foreground text-xs'
                      }
                    >
                      {order.deliveryDate ? formatDate(order.deliveryDate) : '—'}
                      {overdue && ' ⚠'}
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
