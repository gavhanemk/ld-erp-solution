'use client'

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts'

const data = [
  { name: 'In Production', value: 12, color: '#14b8a6' },
  { name: 'Dispatched', value: 7, color: '#10b981' },
  { name: 'Confirmed', value: 3, color: '#60a5fa' },
  { name: 'Draft', value: 2, color: '#64748b' },
]

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="glass-card px-3 py-2 text-xs">
      <span className="font-semibold text-foreground">{payload[0].name}: {payload[0].value} orders</span>
    </div>
  )
}

export function OrderStatusChart() {
  const total = data.reduce((s, d) => s + d.value, 0)

  return (
    <div className="glass-card p-6">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-foreground">Order Status</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{total} total active orders</p>
      </div>

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

        {/* Center label */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className="text-2xl font-bold text-foreground">{total}</p>
            <p className="text-[10px] text-muted-foreground">Orders</p>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="mt-4 space-y-2">
        {data.map((d) => (
          <div key={d.name} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color }} />
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
    </div>
  )
}
