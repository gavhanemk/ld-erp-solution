'use client'

import { TrendingUp, TrendingDown, ShoppingCart, Factory, IndianRupee, AlertTriangle, CheckCircle2, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'

interface KPI {
  id: string
  label: string
  value: string
  subValue?: string
  trend?: number
  trendLabel?: string
  icon: React.ElementType
  color: 'teal' | 'amber' | 'emerald' | 'red' | 'blue' | 'purple'
  sparkline?: number[]
}

const kpis: KPI[] = [
  {
    id: 'active-orders',
    label: 'Active Orders',
    value: '24',
    subValue: '+3 this week',
    trend: 14,
    trendLabel: 'vs last month',
    icon: ShoppingCart,
    color: 'teal',
    sparkline: [12, 15, 14, 18, 20, 22, 24],
  },
  {
    id: 'todays-production',
    label: "Today's Production",
    value: '1,840',
    subValue: 'pieces',
    trend: 8,
    trendLabel: 'vs yesterday',
    icon: Factory,
    color: 'blue',
    sparkline: [1400, 1600, 1520, 1750, 1840, 1900, 1840],
  },
  {
    id: 'revenue-mtd',
    label: 'Revenue (MTD)',
    value: '₹18.4L',
    subValue: 'Month to date',
    trend: 12,
    trendLabel: 'vs last month',
    icon: IndianRupee,
    color: 'emerald',
    sparkline: [10, 12, 14, 13, 16, 17, 18.4],
  },
  {
    id: 'outstanding',
    label: 'Outstanding',
    value: '₹6.2L',
    subValue: 'Receivables',
    trend: -5,
    trendLabel: 'vs last month',
    icon: Clock,
    color: 'amber',
    sparkline: [8, 7.5, 7, 6.8, 6.5, 6.3, 6.2],
  },
  {
    id: 'pending-approvals',
    label: 'Pending Approvals',
    value: '7',
    subValue: '3 PO, 4 MR',
    icon: CheckCircle2,
    color: 'purple',
    sparkline: [5, 8, 6, 9, 7, 8, 7],
  },
  {
    id: 'low-stock',
    label: 'Low Stock Alerts',
    value: '3',
    subValue: 'Items below reorder',
    icon: AlertTriangle,
    color: 'red',
    sparkline: [2, 1, 3, 2, 4, 3, 3],
  },
]

const colorMap = {
  teal: {
    bg: 'bg-teal-500/10',
    border: 'border-teal-500/20',
    icon: 'text-teal-400',
    text: 'text-teal-400',
    sparkline: '#14b8a6',
  },
  amber: {
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
    icon: 'text-amber-400',
    text: 'text-amber-400',
    sparkline: '#f59e0b',
  },
  emerald: {
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    icon: 'text-emerald-400',
    text: 'text-emerald-400',
    sparkline: '#10b981',
  },
  red: {
    bg: 'bg-red-500/10',
    border: 'border-red-500/20',
    icon: 'text-red-400',
    text: 'text-red-400',
    sparkline: '#f87171',
  },
  blue: {
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/20',
    icon: 'text-blue-400',
    text: 'text-blue-400',
    sparkline: '#60a5fa',
  },
  purple: {
    bg: 'bg-purple-500/10',
    border: 'border-purple-500/20',
    icon: 'text-purple-400',
    text: 'text-purple-400',
    sparkline: '#a78bfa',
  },
}

function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const w = 80
  const h = 28
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w
      const y = h - ((v - min) / range) * h
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg width={w} height={h} className="overflow-visible opacity-60">
      <polyline fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" points={pts} />
      {/* Last point dot */}
      {data.length > 0 && (
        <circle
          cx={(((data.length - 1) / (data.length - 1)) * w)}
          cy={h - ((data[data.length - 1] - min) / range) * h}
          r="2.5"
          fill={color}
        />
      )}
    </svg>
  )
}

export function KPICards() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
      {kpis.map((kpi) => {
        const Icon = kpi.icon
        const colors = colorMap[kpi.color]

        return (
          <div
            key={kpi.id}
            id={`kpi-${kpi.id}`}
            className="kpi-card group"
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
              <div className={cn('p-2 rounded-lg', colors.bg, 'border', colors.border)}>
                <Icon size={16} className={colors.icon} />
              </div>
              {kpi.trend !== undefined && (
                <div className={cn('flex items-center gap-0.5 text-[10px] font-semibold', kpi.trend >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                  {kpi.trend >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                  {Math.abs(kpi.trend)}%
                </div>
              )}
            </div>

            {/* Value */}
            <div className="mb-1">
              <p className="text-2xl font-bold text-foreground leading-none">{kpi.value}</p>
              {kpi.subValue && (
                <p className="text-xs text-muted-foreground mt-1">{kpi.subValue}</p>
              )}
            </div>

            {/* Label */}
            <p className="text-xs font-medium text-muted-foreground mb-3">{kpi.label}</p>

            {/* Sparkline */}
            {kpi.sparkline && (
              <div className="mt-auto">
                <MiniSparkline data={kpi.sparkline} color={colors.sparkline} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
