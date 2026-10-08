'use client'

import { useEffect, useState } from 'react'
import {
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Area, AreaChart
} from 'recharts'
import { api } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'

interface TrendPoint {
  month: string
  label: string
  revenue: number
  expenses: number
}

const fmt = (v: number) =>
  v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : `₹${(v / 1000).toFixed(0)}K`

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="glass-card px-4 py-3 text-xs space-y-1.5">
      <p className="font-semibold text-foreground">{label}</p>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted-foreground capitalize">{p.name}:</span>
          <span className="font-semibold text-foreground">{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

export function RevenueChart() {
  const [months, setMonths] = useState(6)
  const [data, setData] = useState<TrendPoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)

    api
      .get<{ success: boolean; data: TrendPoint[] }>(`/dashboard/revenue-trend?months=${months}`)
      .then((res) => {
        if (!cancelled) setData(res.data)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the revenue trend.')
      })

    return () => {
      cancelled = true
    }
  }, [months])

  // Zero everywhere means nothing has been invoiced yet. An area chart of a
  // flat zero line reads as a reporting failure, so say so plainly instead.
  const hasValues = data?.some((d) => d.revenue > 0 || d.expenses > 0) ?? false

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Revenue vs Expenses</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Invoiced sales against supplier bills</p>
        </div>
        <SmartSelect
          className="text-xs bg-secondary border border-border rounded-lg px-2 py-1.5 text-foreground"
          value={months}
          onChange={(e) => setMonths(Number(e.target.value))}
        >
          <option value={6}>Last 6 months</option>
          <option value={12}>Last 12 months</option>
          <option value={24}>Last 24 months</option>
        </SmartSelect>
      </div>

      {error && <p className="text-xs text-red-400 py-16 text-center">{error}</p>}

      {!error && !data && <div className="skeleton h-[220px] w-full rounded-lg" />}

      {!error && data && !hasValues && (
        <p className="text-xs text-muted-foreground py-20 text-center">
          No invoices raised in this period yet.
        </p>
      )}

      {!error && data && hasValues && (
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#14b8a6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="expGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: '#64748b', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={fmt}
            tick={{ fill: '#64748b', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={52}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }} />
          <Legend
            wrapperStyle={{ paddingTop: '16px', fontSize: '12px', color: '#64748b' }}
          />

          <Area
            type="monotone"
            dataKey="revenue"
            name="Revenue"
            stroke="#14b8a6"
            strokeWidth={2}
            fill="url(#revGrad)"
            dot={{ fill: '#14b8a6', strokeWidth: 0, r: 3 }}
            activeDot={{ r: 5, fill: '#14b8a6' }}
          />
          <Area
            type="monotone"
            dataKey="expenses"
            name="Expenses"
            stroke="#f59e0b"
            strokeWidth={2}
            fill="url(#expGrad)"
            dot={{ fill: '#f59e0b', strokeWidth: 0, r: 3 }}
            activeDot={{ r: 5, fill: '#f59e0b' }}
          />
        </AreaChart>
      </ResponsiveContainer>
      )}
    </div>
  )
}
