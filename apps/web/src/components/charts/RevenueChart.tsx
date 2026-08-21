'use client'

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Area, AreaChart
} from 'recharts'

const data = [
  { month: 'Mar', revenue: 1050000, expenses: 680000 },
  { month: 'Apr', revenue: 1280000, expenses: 790000 },
  { month: 'May', revenue: 1150000, expenses: 710000 },
  { month: 'Jun', revenue: 1480000, expenses: 850000 },
  { month: 'Jul', revenue: 1620000, expenses: 920000 },
  { month: 'Aug', revenue: 1840000, expenses: 1050000 },
]

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
  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Revenue vs Expenses</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Last 6 months trend</p>
        </div>
        <select className="text-xs bg-secondary border border-border rounded-lg px-2 py-1.5 text-foreground">
          <option>Last 6 months</option>
          <option>Last 12 months</option>
          <option>This year</option>
        </select>
      </div>

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
            dataKey="month"
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
    </div>
  )
}
