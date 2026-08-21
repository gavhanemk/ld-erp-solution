'use client'

import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell } from 'recharts'
import { Factory, TrendingUp, AlertCircle } from 'lucide-react'

const lineData = [
  { line: 'Line 1', target: 500, achieved: 480, efficiency: 96, rejection: 12 },
  { line: 'Line 2', target: 500, achieved: 420, efficiency: 84, rejection: 25 },
  { line: 'Line 3', target: 450, achieved: 460, efficiency: 102, rejection: 8 },
  { line: 'Line 4', target: 400, achieved: 380, efficiency: 95, rejection: 15 },
  { line: 'Line 5', target: 200, achieved: 100, efficiency: 50, rejection: 5 },
]

export function ProductionSummaryWidget() {
  const totalTarget = lineData.reduce((s, l) => s + l.target, 0)
  const totalAchieved = lineData.reduce((s, l) => s + l.achieved, 0)
  const overallEfficiency = Math.round((totalAchieved / totalTarget) * 100)
  const totalRejection = lineData.reduce((s, l) => s + l.rejection, 0)

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
            <p className="text-xs text-muted-foreground">of {totalTarget.toLocaleString()} target</p>
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bar Chart */}
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={lineData} barGap={4} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
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
              {lineData.map((entry, i) => (
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
          {lineData.map((line) => (
            <div key={line.line} className="flex items-center gap-3">
              <span className="text-xs font-medium text-muted-foreground w-14">{line.line}</span>
              <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.min((line.achieved / line.target) * 100, 100)}%`,
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
    </div>
  )
}
