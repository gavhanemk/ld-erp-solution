'use client'

import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell } from 'recharts'
import { Factory, TrendingUp, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'

interface ProductionLine {
  line: string
  target: number
  achieved: number
  rejection: number
  rework: number
  efficiency: number
}

export function ProductionSummaryWidget() {
  const [lineData, setLineData] = useState<ProductionLine[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = () =>
      api
        .get<{ success: boolean; data: ProductionLine[] }>('/dashboard/production-today')
        .then((res) => {
          if (!cancelled) setLineData(res.data)
        })
        .catch(() => {
          if (!cancelled) setError('Could not load production figures.')
        })

    void load()
    // Entries are keyed in through the shift, so refresh periodically.
    const timer = setInterval(() => void load(), 60_000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const lines = lineData ?? []
  const totalTarget = lines.reduce((s, l) => s + l.target, 0)
  const totalAchieved = lines.reduce((s, l) => s + l.achieved, 0)
  const overallEfficiency = totalTarget > 0 ? Math.round((totalAchieved / totalTarget) * 100) : 0
  const totalRejection = lines.reduce((s, l) => s + l.rejection, 0)

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <Factory size={16} className="text-blue-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Today&apos;s Production</h3>
            <p className="text-xs text-muted-foreground">Line-wise performance</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-xl font-bold text-foreground">{totalAchieved.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">
              {totalTarget > 0 ? `of ${totalTarget.toLocaleString()} target` : 'No target set'}
            </p>
          </div>
          <div className={`flex items-center gap-1 text-sm font-bold px-2.5 py-1 rounded-lg ${
            overallEfficiency >= 90 ? 'bg-emerald-500/10 text-emerald-400' :
            overallEfficiency >= 75 ? 'bg-amber-500/10 text-amber-400' :
            'bg-red-500/10 text-red-400'
          }`}>
            <TrendingUp size={14} />
            {overallEfficiency}%
          </div>
        </div>
      </div>

      {error && <p className="text-xs text-red-400 py-12 text-center">{error}</p>}

      {!error && !lineData && <div className="skeleton h-[140px] w-full rounded-lg" />}

      {!error && lineData && lines.length === 0 && (
        <p className="text-xs text-muted-foreground py-12 text-center">
          No production has been entered for today yet.
        </p>
      )}

      {!error && lines.length > 0 && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bar Chart */}
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={lines} barGap={4} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <XAxis dataKey="line" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.03)' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                return (
                  <div className="glass-card px-3 py-2 text-xs space-y-1">
                    <p className="font-semibold">{label}</p>
                    <p className="text-teal-400">Achieved: {payload[0]?.value}</p>
                    <p className="text-slate-400">Target: {payload[1]?.value}</p>
                  </div>
                )
              }}
            />
            <Bar dataKey="achieved" radius={[4, 4, 0, 0]} maxBarSize={32}>
              {lines.map((entry, i) => (
                <Cell
                  key={i}
                  fill={
                    entry.efficiency >= 90 ? '#14b8a6' :
                    entry.efficiency >= 75 ? '#f59e0b' : '#f87171'
                  }
                  fillOpacity={0.85}
                />
              ))}
            </Bar>
            <Bar dataKey="target" radius={[4, 4, 0, 0]} fill="rgba(255,255,255,0.05)" maxBarSize={32} />
          </BarChart>
        </ResponsiveContainer>

        {/* Line Details Table */}
        <div className="space-y-2">
          {lines.map((line) => (
            <div key={line.line} className="flex items-center gap-3">
              <span className="text-xs font-medium text-muted-foreground w-14">{line.line}</span>
              <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${line.target > 0 ? Math.min((line.achieved / line.target) * 100, 100) : 0}%`,
                    background: line.efficiency >= 90 ? '#14b8a6' : line.efficiency >= 75 ? '#f59e0b' : '#f87171',
                  }}
                />
              </div>
              <span className="text-xs font-semibold text-foreground w-12 text-right">{line.achieved}</span>
              <span className={`text-xs font-bold w-10 text-right ${
                line.efficiency >= 90 ? 'text-emerald-400' :
                line.efficiency >= 75 ? 'text-amber-400' : 'text-red-400'
              }`}>{line.efficiency}%</span>
            </div>
          ))}
          {totalRejection > 0 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/5 border border-amber-500/15 rounded-lg px-3 py-2">
              <AlertCircle size={13} />
              Total rejection today: <span className="font-bold">{totalRejection} pcs</span>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  )
}
