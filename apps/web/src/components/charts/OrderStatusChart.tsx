'use client'

import { useEffect, useState } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { api } from '@/lib/api'

interface StatusRow {
  status: string
  count: number
  value: number
}

/** Display label and colour per SalesOrderStatus, in workflow order. */
const STATUS_META: Record<string, { name: string; color: string; order: number }> = {
  DRAFT: { name: 'Draft', color: '#64748b', order: 0 },
  CONFIRMED: { name: 'Confirmed', color: '#60a5fa', order: 1 },
  IN_PRODUCTION: { name: 'In Production', color: '#14b8a6', order: 2 },
  PARTIALLY_DISPATCHED: { name: 'Part Dispatched', color: '#f59e0b', order: 3 },
  COMPLETED: { name: 'Completed', color: '#10b981', order: 4 },
  CANCELLED: { name: 'Cancelled', color: '#f87171', order: 5 },
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="glass-card px-3 py-2 text-xs">
      <span className="font-semibold text-foreground">
        {payload[0].name}: {payload[0].value} order{payload[0].value === 1 ? '' : 's'}
      </span>
    </div>
  )
}

export function OrderStatusChart() {
  const [rows, setRows] = useState<StatusRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    api
      .get<{ success: boolean; data: StatusRow[] }>('/dashboard/order-status')
      .then((res) => {
        if (!cancelled) setRows(res.data)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load order status.')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const data = (rows ?? [])
    .filter((r) => r.count > 0)
    .map((r) => ({
      name: STATUS_META[r.status]?.name ?? r.status,
      value: r.count,
      color: STATUS_META[r.status]?.color ?? '#64748b',
      order: STATUS_META[r.status]?.order ?? 99,
    }))
    .sort((a, b) => a.order - b.order)

  const total = data.reduce((s, d) => s + d.value, 0)

  return (
    <div className="glass-card p-6">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-foreground">Order Status</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {rows === null && !error ? 'Loading...' : `${total} sales order${total === 1 ? '' : 's'}`}
        </p>
      </div>

      {error && <p className="text-xs text-red-400 py-16 text-center">{error}</p>}

      {!error && rows === null && <div className="skeleton h-40 w-full rounded-lg" />}

      {!error && rows !== null && total === 0 && (
        <p className="text-xs text-muted-foreground py-16 text-center">
          No sales orders yet.
        </p>
      )}

      {!error && total > 0 && (
        <>
          <div className="relative">
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie
                  data={data}
                  cx="50%"
                  cy="50%"
                  innerRadius={48}
                  outerRadius={72}
                  paddingAngle={3}
                  dataKey="value"
                  strokeWidth={0}
                >
                  {data.map((entry, index) => (
                    <Cell key={index} fill={entry.color} opacity={0.9} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>

            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <p className="text-2xl font-bold text-foreground">{total}</p>
                <p className="text-[10px] text-muted-foreground">Orders</p>
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {data.map((d) => (
              <div key={d.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: d.color }}
                  />
                  <span className="text-xs text-muted-foreground">{d.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-foreground">{d.value}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {Math.round((d.value / total) * 100)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
