'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { formatCurrency, formatDate } from '@/lib/utils'

interface RecentOrder {
  id: string
  soNumber: string
  customer: string
  brand: string
  brandType: string
  status: string
  totalAmount: number
  isJobWork: boolean
  deliveryDate: string | null
}

const statusMap: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral' },
  CONFIRMED: { label: 'Confirmed', cls: 'badge-info' },
  IN_PRODUCTION: { label: 'In Production', cls: 'badge-warning' },
  PARTIALLY_DISPATCHED: { label: 'Part Dispatched', cls: 'badge-success' },
  COMPLETED: { label: 'Completed', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-danger' },
}

export function RecentOrdersWidget() {
  const [orders, setOrders] = useState<RecentOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    api
      .get<{ success: boolean; data: RecentOrder[] }>('/dashboard/recent-orders?limit=5')
      .then((res) => {
        if (!cancelled) setOrders(res.data)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load recent orders.')
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Recent Sales Orders</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {orders === null && !error
              ? 'Loading...'
              : orders?.length
                ? `Latest ${orders.length} orders`
                : 'No orders yet'}
          </p>
        </div>
        <Link href="/sales/orders" className="btn-ghost text-xs">
          View all <ExternalLink size={12} />
        </Link>
      </div>

      {error && <p className="text-xs text-red-400 py-10 text-center">{error}</p>}

      {!error && !orders && <div className="skeleton h-32 w-full rounded-lg" />}

      {!error && orders && orders.length === 0 && (
        <p className="text-xs text-muted-foreground py-10 text-center">
          No sales orders have been raised yet.
        </p>
      )}

      {!error && orders && orders.length > 0 && (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Order #</th>
                <th>Customer</th>
                <th>Brand</th>
                <th>Type</th>
                <th className="text-right">Amount</th>
                <th>Delivery</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const s = statusMap[o.status] ?? { label: o.status, cls: 'badge-neutral' }
                const overdue =
                  o.deliveryDate &&
                  new Date(o.deliveryDate) < new Date() &&
                  o.status !== 'COMPLETED' &&
                  o.status !== 'CANCELLED'

                return (
                  <tr key={o.id}>
                    <td>
                      <Link
                        // The list, searched to this one order: there is no
                        // page per order, the order list is where it is read.
                        href={`/sales/orders?q=${encodeURIComponent(o.soNumber)}`}
                        className="font-mono text-xs text-teal-400 hover:text-teal-300 transition-colors"
                      >
                        {o.soNumber}
                      </Link>
                    </td>
                    <td className="font-medium text-foreground">{o.customer}</td>
                    <td>
                      <span
                        className={
                          o.brandType === 'VHAGAR'
                            ? 'vhagar-accent text-xs font-bold'
                            : 'text-xs text-muted-foreground'
                        }
                      >
                        {o.brand}
                      </span>
                    </td>
                    <td>
                      {o.isJobWork ? (
                        <span className="badge-purple">Job Work</span>
                      ) : (
                        <span className="badge-neutral">Regular</span>
                      )}
                    </td>
                    <td className="text-right font-semibold text-foreground">
                      {/* Job work is billed on conversion, so a zero total is
                          expected rather than missing data. */}
                      {o.totalAmount > 0 ? formatCurrency(o.totalAmount) : '—'}
                    </td>
                    <td
                      className={
                        overdue ? 'text-red-400 text-xs font-semibold' : 'text-xs text-muted-foreground'
                      }
                    >
                      {o.deliveryDate ? formatDate(o.deliveryDate) : '—'}
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
      )}
    </div>
  )
}
