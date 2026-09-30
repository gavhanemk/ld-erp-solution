'use client'

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Pie, PieChart, RadialBar,
  RadialBarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

/**
 * Charts for the customer material dashboard, each a different kind: an area
 * for receipts over time, bars for customers, a donut for categories, a radial
 * gauge for how often the lorry matched the challan, columns for stores. All
 * carry their figures on them, and a click on a part filters by it.
 */

export const PALETTE = ['#14b8a6', '#38bdf8', '#f59e0b', '#a78bfa', '#34d399', '#fb7185', '#818cf8', '#a3e635', '#fb923c', '#22d3ee']

export interface Slice {
  value: string
  label: string
  count: number
}

const axis = { fontSize: 11, fill: 'currentColor' }
const labelStyle = { fontSize: 10, fontWeight: 600 }
const count0 = (v: unknown) => (Number(v) ? Number(v).toLocaleString('en-IN') : '')

/* eslint-disable @typescript-eslint/no-explicit-any */
function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="glass-card space-y-1 px-3 py-2 text-xs shadow-lg">
      {label !== undefined && <p className="font-semibold text-foreground">{label}</p>}
      {payload.map((p: any) => (
        <div key={p.dataKey ?? p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color ?? p.payload?.fill }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-semibold tabular-nums text-foreground">{Number(p.value).toLocaleString('en-IN')}</span>
        </div>
      ))}
    </div>
  )
}

function Empty({ h }: { h: number }) {
  return (
    <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height: h }}>
      Nothing to show.
    </div>
  )
}

/** Items and receipts over time, as two soft areas. */
export function ReceiptTrend({
  data,
  onPick,
}: {
  data: Array<{ key: string; label: string; from: string; to: string; items: number; receipts: number }>
  onPick: (from: string, to: string) => void
}) {
  if (!data.length) return <Empty h={240} />
  const labelled = data.filter((d) => d.items).length <= 20
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart
          data={data}
          margin={{ top: 20, right: 8, left: 0, bottom: 0 }}
          onClick={(e: any) => {
            const b = e?.activePayload?.[0]?.payload
            if (b) onPick(b.from, b.to)
          }}
        >
          <defs>
            <linearGradient id="cmItems" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#14b8a6" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#14b8a6" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="cmReceipts" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.4} />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} minTickGap={16} />
          <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
          <Tooltip content={<Tip />} />
          <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
          <Area type="monotone" dataKey="items" name="Items received" stroke="#14b8a6" strokeWidth={2} fill="url(#cmItems)" cursor="pointer">
            {labelled && <LabelList dataKey="items" position="top" formatter={count0} style={{ ...labelStyle, fill: '#0d9488' }} />}
          </Area>
          <Area type="monotone" dataKey="receipts" name="Receipts" stroke="#38bdf8" strokeWidth={2} fill="url(#cmReceipts)" cursor="pointer" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/** One bar per customer, longest first, the count at its end. */
export function CustomerBars({ data, picked, onPick }: { data: Slice[]; picked: string[]; onPick: (v: string) => void }) {
  if (!data.length) return <Empty h={220} />
  const rows = data.slice(0, 10)
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 32 + 20)}>
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 0, right: 40, left: 0, bottom: 0 }}
          onClick={(e: any) => {
            const g = e?.activePayload?.[0]?.payload
            if (g) onPick(g.value)
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} horizontal={false} />
          <XAxis type="number" tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="label" tick={axis} tickLine={false} axisLine={false} width={150} tickFormatter={(v: string) => (v.length > 22 ? `${v.slice(0, 21)}…` : v)} />
          <Tooltip content={<Tip />} cursor={{ fill: 'currentColor', fillOpacity: 0.06 }} />
          <Bar dataKey="count" name="Items received" radius={[0, 4, 4, 0]} barSize={18} cursor="pointer">
            {rows.map((r, n) => (
              <Cell key={r.value} fill={PALETTE[n % PALETTE.length]} fillOpacity={picked.length && !picked.includes(r.value) ? 0.3 : 1} />
            ))}
            <LabelList dataKey="count" position="right" formatter={count0} style={{ ...labelStyle, fill: 'currentColor' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Share of items by category, as a donut with the count on each slice. */
export function CategoryDonut({ data, picked, onPick }: { data: Slice[]; picked: string[]; onPick: (v: string) => void }) {
  if (!data.length) return <Empty h={240} />
  const total = data.reduce((s, d) => s + d.count, 0)
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={data}
            dataKey="count"
            nameKey="label"
            innerRadius="55%"
            outerRadius="85%"
            paddingAngle={2}
            stroke="none"
            isAnimationActive={false}
            onClick={(d: any) => onPick(d.value)}
            cursor="pointer"
            labelLine={false}
            label={(p: any) => {
              if (p.percent < 0.05) return null
              const r = p.innerRadius + (p.outerRadius - p.innerRadius) / 2
              const a = (-p.midAngle * Math.PI) / 180
              return (
                <text x={p.cx + r * Math.cos(a)} y={p.cy + r * Math.sin(a)} fill="#fff" fontSize={11} fontWeight={700} textAnchor="middle" dominantBaseline="central">
                  {p.count}
                </text>
              )
            }}
          >
            {data.map((d, n) => (
              <Cell key={d.value} fill={PALETTE[n % PALETTE.length]} fillOpacity={picked.length && !picked.includes(d.value) ? 0.3 : 1} />
            ))}
          </Pie>
          <Tooltip content={<Tip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[220px] flex-col items-center justify-center">
        <span className="text-2xl font-bold tabular-nums text-foreground">{total}</span>
        <span className="text-[11px] text-muted-foreground">items</span>
      </div>
      <div className="mt-1 flex flex-wrap justify-center gap-x-3 gap-y-1">
        {data.map((d, n) => (
          <button
            key={d.value}
            type="button"
            onClick={() => onPick(d.value)}
            className={`flex items-center gap-1.5 text-[11px] ${picked.includes(d.value) ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: PALETTE[n % PALETTE.length] }} />
            {d.label} {d.count} · {total ? Math.round((d.count / total) * 100) : 0}%
          </button>
        ))}
      </div>
    </div>
  )
}

/** How often what arrived matched their challan: a ring for each outcome. */
export function ArrivalGauge({
  matched,
  short,
  excess,
  onPick,
}: {
  matched: number
  short: number
  excess: number
  onPick: (v: 'match' | 'short' | 'excess') => void
}) {
  const total = matched + short + excess
  if (!total) return <Empty h={240} />
  const data = [
    { key: 'excess' as const, name: 'More than challan', value: excess, fill: '#f59e0b' },
    { key: 'short' as const, name: 'Short', value: short, fill: '#f87171' },
    { key: 'match' as const, name: 'Matched', value: matched, fill: '#10b981' },
  ]
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={220}>
        <RadialBarChart data={data} innerRadius="38%" outerRadius="100%" startAngle={90} endAngle={-270} barSize={14}>
          <RadialBar
            dataKey="value"
            background={{ fill: 'currentColor', fillOpacity: 0.06 }}
            cornerRadius={7}
            cursor="pointer"
            onClick={(d: any) => onPick(d.key)}
            isAnimationActive={false}
          />
          <Tooltip content={<Tip />} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[220px] flex-col items-center justify-center">
        <span className="text-2xl font-bold tabular-nums text-emerald-500">{Math.round((matched / total) * 100)}%</span>
        <span className="text-[11px] text-muted-foreground">matched</span>
      </div>
      <div className="mt-1 flex flex-wrap justify-center gap-x-4 gap-y-1">
        {[...data].reverse().map((d) => (
          <button key={d.key} type="button" onClick={() => onPick(d.key)} className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: d.fill }} />
            {d.name} {d.value} · {Math.round((d.value / total) * 100)}%
          </button>
        ))}
      </div>
    </div>
  )
}

/** Stores side by side: items received and items still here, as a pair of columns. */
export function StoreColumns({
  data,
  onPick,
}: {
  data: Array<{ value: string; label: string; received: number; held: number }>
  onPick: (v: string) => void
}) {
  if (!data.length) return <Empty h={240} />
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={240}>
        <BarChart
          data={data}
          margin={{ top: 20, right: 4, left: 0, bottom: 0 }}
          onClick={(e: any) => {
            const g = e?.activePayload?.[0]?.payload
            if (g) onPick(g.value)
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} interval={0} tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)} />
          <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
          <Tooltip content={<Tip />} cursor={{ fill: 'currentColor', fillOpacity: 0.06 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
          <Bar dataKey="received" name="Items received" fill="#14b8a6" radius={[4, 4, 0, 0]} maxBarSize={36} cursor="pointer">
            <LabelList dataKey="received" position="top" formatter={count0} style={{ ...labelStyle, fill: '#0d9488' }} />
          </Bar>
          <Bar dataKey="held" name="Still here" fill="#a78bfa" radius={[4, 4, 0, 0]} maxBarSize={36} cursor="pointer">
            <LabelList dataKey="held" position="top" formatter={count0} style={{ ...labelStyle, fill: '#8b5cf6' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
