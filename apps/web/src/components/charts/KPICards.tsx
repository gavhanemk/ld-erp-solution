'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  ShoppingCart,
  Factory,
  IndianRupee,
  AlertCircle,
  CheckCircle2,
  Clock,
  Wallet,
} from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import { api, ApiError } from '@/lib/api'

interface DashboardSummary {
  activeOrders: number
  todayProduction: { achieved: number; target: number; efficiency: number; rejection: number }
  pendingApprovals: number
  /**
   * Null when the signed-in role has no accounts access. The server withholds
   * these rather than sending a zero, because a zero is a fact and it would be
   * the wrong one — so these cards are left out entirely instead.
   */
  revenueMTD: number | string | null
  outstandingReceivable: number | string | null
  outstandingPayable: number | string | null
  generatedAt: string
}

type Color = 'teal' | 'amber' | 'emerald' | 'red' | 'blue' | 'purple'

const colorMap: Record<Color, { bg: string; border: string; icon: string }> = {
  teal: { bg: 'bg-teal-500/10', border: 'border-teal-500/20', icon: 'text-teal-400' },
  amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', icon: 'text-amber-400' },
  emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: 'text-emerald-400' },
  red: { bg: 'bg-red-500/10', border: 'border-red-500/20', icon: 'text-red-400' },
  blue: { bg: 'bg-blue-500/10', border: 'border-blue-500/20', icon: 'text-blue-400' },
  purple: { bg: 'bg-purple-500/10', border: 'border-purple-500/20', icon: 'text-purple-400' },
}

interface Card {
  id: string
  label: string
  value: string
  subValue?: string
  icon: React.ElementType
  color: Color
}

function toCards(d: DashboardSummary): Card[] {
  const { achieved, target, efficiency, rejection } = d.todayProduction

  return [
    {
      id: 'active-orders',
      label: 'Active Orders',
      value: String(d.activeOrders),
      subValue: 'Confirmed, in production or part dispatched',
      icon: ShoppingCart,
      color: 'teal',
    },
    {
      id: 'todays-production',
      label: "Today's Production",
      value: achieved.toLocaleString('en-IN'),
      // Efficiency is meaningless until a target has been entered for the day.
      subValue: target > 0 ? `of ${target.toLocaleString('en-IN')} target · ${efficiency}%` : 'No target set',
      icon: Factory,
      color: 'blue',
    },
    {
      id: 'rejections',
      label: 'Rejections Today',
      value: rejection.toLocaleString('en-IN'),
      subValue: achieved > 0 ? `${((rejection / achieved) * 100).toFixed(1)}% of output` : 'No output yet',
      icon: AlertCircle,
      color: 'red',
    },
    ...(d.revenueMTD === null
      ? []
      : ([
          {
            id: 'revenue-mtd',
            label: 'Revenue (MTD)',
            value: formatCurrency(Number(d.revenueMTD)),
            subValue: 'Invoiced this month',
            icon: IndianRupee,
            color: 'emerald',
          },
          {
            id: 'receivable',
            label: 'Receivable',
            value: formatCurrency(Number(d.outstandingReceivable)),
            subValue: 'Owed by customers',
            icon: Clock,
            color: 'amber',
          },
          {
            id: 'payable',
            label: 'Payable',
            value: formatCurrency(Number(d.outstandingPayable)),
            subValue: 'Owed to suppliers',
            icon: Wallet,
            color: 'purple',
          },
        ] as const)),
  ]
}

export function KPICards() {
  const [cards, setCards] = useState<Card[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: DashboardSummary }>('/dashboard/summary')
      setCards(toCards(res.data))
      setError(null)
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?',
      )
      setCards(null)
    }
  }, [])

  useEffect(() => {
    void load()
    // The factory floor keys in production through the day, so the figures go
    // stale quickly on a screen someone leaves open.
    const timer = setInterval(() => void load(), 60_000)
    return () => clearInterval(timer)
  }, [load])

  if (error) {
    return (
      <div className="glass-card p-4 flex items-start gap-3 border-red-500/40">
        <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-red-400">Could not load dashboard figures</p>
          <p className="text-xs text-muted-foreground mt-1">{error}</p>
        </div>
      </div>
    )
  }

  if (!cards) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="kpi-card">
            <div className="skeleton h-8 w-8 rounded-lg mb-3" />
            <div className="skeleton h-7 w-20 mb-2" />
            <div className="skeleton h-3 w-24" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
      {cards.map((kpi) => {
        const Icon = kpi.icon
        const colors = colorMap[kpi.color]

        return (
          <div key={kpi.id} id={`kpi-${kpi.id}`} className="kpi-card group">
            <div className="flex items-center justify-between mb-3">
              <div className={cn('p-2 rounded-lg', colors.bg, 'border', colors.border)}>
                <Icon size={16} className={colors.icon} />
              </div>
            </div>

            <div className="mb-1">
              <p className="text-2xl font-bold text-foreground leading-none">{kpi.value}</p>
              {kpi.subValue && <p className="text-xs text-muted-foreground mt-1">{kpi.subValue}</p>}
            </div>

            <p className="text-xs font-medium text-muted-foreground">{kpi.label}</p>
          </div>
        )
      })}
    </div>
  )
}
