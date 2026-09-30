'use client'

import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Funnel, FunnelChart, LabelList, Legend,
  Line, Pie, PieChart, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, RadialBar,
  RadialBarChart, ReferenceLine, ResponsiveContainer, Tooltip, Treemap, XAxis, YAxis,
} from 'recharts'

/**
 * The inventory dashboard's charts, each a different kind for a different
 * question. Colours are fixed hues that read on light and dark alike; axis
 * text takes the surrounding colour through currentColor.
 */

export const PALETTE = ['#2dd4bf', '#60a5fa', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#fb7185', '#818cf8', '#fb923c', '#22d3ee']
export const IN = '#10b981'
export const OUT = '#f87171'

/** ₹ short enough for an axis or a label: 12.5 L, 3.2 Cr, 45 K. */
export const inr = (v: number) => {
  const a = Math.abs(v)
  const s = v < 0 ? '−' : ''
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)} L`
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(1)} K`
  return `${s}₹${a.toFixed(0)}`
}
const inrAxis = (v: number) => inr(v).replace('.00', '').replace(/\.(\d)\d /, '.$1 ')

const axis = { fontSize: 11, fill: 'currentColor' }
const lbl = { fontSize: 10, fontWeight: 600 }

/**
 * A value above (or below) a mark, on one line, left bare under `floor` so
 * the small ones do not pile on each other.
 */
function valueLabel(colour: string, format: (v: number) => string, floor = 0, below = false) {
  return function ValueLabel(props: any) {
    const { x, y, width = 0, height = 0, value } = props
    const v = Math.abs(Number(value))
    if (!v || v < floor || x === undefined || y === undefined) return null
    const cx = Number(x) + Number(width) / 2
    const top = Math.min(Number(y), Number(y) + Number(height))
    const bottom = Math.max(Number(y), Number(y) + Number(height))
    return (
      <text x={cx} y={below ? bottom + 12 : top - 6} textAnchor="middle" fill={colour} fontSize={10} fontWeight={700}>
        {format(v)}
      </text>
    )
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function Tip({ active, payload, label, money = true, labelOf }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="glass-card space-y-1 px-3 py-2 text-xs shadow-lg">
      {(label !== undefined || labelOf) && (
        <p className="font-semibold text-foreground">{labelOf ? labelOf(payload[0].payload) : label}</p>
      )}
      {payload.map((p: any) => (
        <div key={p.dataKey ?? p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color ?? p.payload?.fill }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-semibold tabular-nums text-foreground">
            {money && !/moves|movements|count|%/i.test(String(p.name)) ? inr(Math.abs(p.value)) : Number(p.value).toLocaleString('en-IN')}
          </span>
        </div>
      ))}
    </div>
  )
}

export function Empty({ h = 220, text = 'Nothing to show yet.' }: { h?: number; text?: string }) {
  return (
    <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height: h }}>
      {text}
    </div>
  )
}

/** Value in and out as soft areas, and the number of movements as bars behind them. */
export function FlowChart({ data }: { data: Array<{ day: string; inValue: number; outValue: number; moves: number }> }) {
  if (!data.some((d) => d.moves)) return <Empty h={260} text="No movement in this period." />
  const rows = data.map((d) => ({
    ...d,
    label: new Date(`${d.day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
  }))
  const busy = rows.filter((d) => d.moves).length
  const labelled = busy <= 20
  const peak = Math.max(...rows.map((d) => Math.max(d.inValue, d.outValue)))
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={rows} margin={{ top: 22, right: 6, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="dIn" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={IN} stopOpacity={0.45} />
              <stop offset="100%" stopColor={IN} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="dOut" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={OUT} stopOpacity={0.4} />
              <stop offset="100%" stopColor={OUT} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.12} vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis yAxisId="v" tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} width={70} />
          <YAxis yAxisId="n" orientation="right" tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
          <Tooltip content={<Tip />} />
          <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
          <Bar yAxisId="n" dataKey="moves" name="Movements" fill="#a78bfa" fillOpacity={0.35} radius={[3, 3, 0, 0]} maxBarSize={14}>
            {labelled && <LabelList dataKey="moves" content={valueLabel('#8b5cf6', (v) => `${v}`)} />}
          </Bar>
          <Area yAxisId="v" type="monotone" dataKey="inValue" name="Value in" stroke={IN} strokeWidth={2} fill="url(#dIn)" dot={labelled ? { r: 2.5, fill: IN } : false}>
            {labelled && <LabelList dataKey="inValue" content={valueLabel('#059669', inr, peak * 0.02)} />}
          </Area>
          <Area yAxisId="v" type="monotone" dataKey="outValue" name="Value out" stroke={OUT} strokeWidth={2} fill="url(#dOut)">
            {labelled && <LabelList dataKey="outValue" content={valueLabel('#e11d48', inr, peak * 0.02)} />}
          </Area>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Where the value sits, store by store, with the total in the middle. Click a slice to look at that store. */
export function StoreDonut({
  data,
  active,
  onPick,
}: {
  data: Array<{ id: string; name: string; value: number }>
  active: string
  onPick: (id: string) => void
}) {
  const total = data.reduce((t, d) => t + d.value, 0)
  if (!total) return <Empty h={260} />
  return (
    <div>
      <div className="relative">
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={2}
              stroke="none"
              isAnimationActive={false}
              cursor="pointer"
              onClick={(d: any) => onPick(d.id)}
              labelLine={false}
              label={(p: any) => {
                if (p.percent < 0.06) return null
                const r = p.innerRadius + (p.outerRadius - p.innerRadius) / 2
                const a = (-p.midAngle * Math.PI) / 180
                return (
                  <text x={p.cx + r * Math.cos(a)} y={p.cy + r * Math.sin(a)} fill="#fff" fontSize={10} fontWeight={700} textAnchor="middle" dominantBaseline="central">
                    {Math.round(p.percent * 100)}%
                  </text>
                )
              }}
            >
              {data.map((d, n) => (
                <Cell key={d.id} fill={PALETTE[n % PALETTE.length]} fillOpacity={active && active !== d.id ? 0.3 : 1} />
              ))}
            </Pie>
            <Tooltip content={<Tip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold tabular-nums text-foreground">{inr(total)}</span>
          <span className="text-[11px] text-muted-foreground">{data.length} {data.length === 1 ? 'store' : 'stores'}</span>
        </div>
      </div>
      <div className="mt-2 space-y-1">
        {data.map((d, n) => (
          <button
            key={d.id}
            type="button"
            onClick={() => onPick(d.id)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-primary/5 ${active === d.id ? 'bg-primary/10' : ''}`}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PALETTE[n % PALETTE.length] }} />
            <span className="flex-1 truncate text-left text-foreground">{d.name}</span>
            <span className="tabular-nums text-muted-foreground">{Math.round((d.value / total) * 100)}%</span>
            <span className="w-20 text-right font-semibold tabular-nums text-foreground">{inr(d.value)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Categories as boxes sized by value, each holding its sub-categories. */
export function CategoryTreemap({ data }: { data: Array<{ name: string; value: number; children: Array<{ name: string; value: number }> }> }) {
  const total = data.reduce((t, d) => t + d.value, 0)
  if (!total) return <Empty h={280} />
  const rows = data.map((c, n) => ({
    name: c.name,
    fill: PALETTE[n % PALETTE.length],
    children: c.children.filter((s) => s.value > 0).map((s) => ({ name: s.name, size: s.value, cat: c.name, fill: PALETTE[n % PALETTE.length] })),
  }))
  const Box = (props: any) => {
    const { x, y, width, height, depth, name, fill, size, cat } = props
    if (depth !== 2 || width <= 0 || height <= 0) return null
    return (
      <g>
        <rect x={x} y={y} width={width} height={height} rx={4} fill={fill} fillOpacity={0.88} stroke="hsl(var(--card))" strokeWidth={2} />
        {width > 64 && height > 30 && (
          <>
            <text x={x + 6} y={y + 15} fill="#fff" fontSize={11} fontWeight={700}>
              {String(name).length > width / 7 ? `${String(name).slice(0, Math.max(3, Math.floor(width / 7) - 1))}…` : name}
            </text>
            <text x={x + 6} y={y + 28} fill="#fff" fillOpacity={0.92} fontSize={10}>
              {inr(size)} · {Math.round((size / total) * 100)}%
            </text>
          </>
        )}
        {width > 64 && height > 46 && name !== cat && (
          <text x={x + 6} y={y + 41} fill="#fff" fillOpacity={0.75} fontSize={9}>
            {cat}
          </text>
        )}
      </g>
    )
  }
  return (
    <>
      <ResponsiveContainer width="100%" height={280}>
        <Treemap data={rows} dataKey="size" isAnimationActive={false} content={<Box />}>
          <Tooltip
            content={({ active, payload }: any) =>
              active && payload?.length ? (
                <div className="glass-card px-3 py-2 text-xs shadow-lg">
                  <p className="font-semibold text-foreground">{payload[0].payload.name}</p>
                  <p className="text-muted-foreground">{payload[0].payload.cat}</p>
                  <p className="font-semibold tabular-nums text-foreground">{inr(payload[0].payload.size)}</p>
                </div>
              ) : null
            }
          />
        </Treemap>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {data.map((c, n) => (
          <span key={c.name} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-2 w-2 rounded-sm" style={{ background: PALETTE[n % PALETTE.length] }} />
            {c.name} <span className="font-semibold text-foreground">{inr(c.value)}</span>
          </span>
        ))}
      </div>
    </>
  )
}

const AGE_COLOURS = ['#10b981', '#84cc16', '#f59e0b', '#fb923c', '#ef4444']

/** Value by how long since it last moved: green is fresh, red is standing still. */
export function AgeingBars({ data }: { data: Array<{ key: string; label: string; value: number; lines: number }> }) {
  if (!data.some((d) => d.value)) return <Empty h={260} />
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ top: 22, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.12} vertical={false} />
          <XAxis dataKey="key" tick={axis} tickLine={false} axisLine={false} />
          <YAxis tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} width={64} />
          <Tooltip content={<Tip labelOf={(p: any) => `${p.label} since last moved · ${p.lines} lines`} />} cursor={{ fill: 'currentColor', fillOpacity: 0.05 }} />
          <Bar dataKey="value" name="Value" radius={[5, 5, 0, 0]} maxBarSize={46}>
            {data.map((d, n) => (
              <Cell key={d.key} fill={AGE_COLOURS[n]} />
            ))}
            <LabelList dataKey="value" position="top" formatter={(v: number) => (v ? inr(v) : '')} style={{ ...lbl, fill: 'currentColor' }} />
            <LabelList
              dataKey="lines"
              position="insideBottom"
              offset={8}
              formatter={(v: number) => (v ? `${v} lines` : '')}
              style={{ fontSize: 9, fontWeight: 700, fill: '#fff' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Items by value, largest first, with the running share as a line: the 80% mark is where A ends. */
export function ParetoChart({ data }: { data: Array<{ code: string; name: string; value: number; cumPct: number; cls: string }> }) {
  if (!data.length) return <Empty h={280} />
  const colour = { A: '#2dd4bf', B: '#60a5fa', C: '#a78bfa' } as Record<string, string>
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={data} margin={{ top: 18, right: 6, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.12} vertical={false} />
          <XAxis dataKey="code" tick={{ ...axis, fontSize: 9 }} tickLine={false} axisLine={false} interval={0} angle={-40} textAnchor="end" height={52} />
          <YAxis yAxisId="v" tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} width={64} />
          <YAxis yAxisId="p" orientation="right" domain={[0, 100]} tick={axis} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} width={38} />
          <Tooltip content={<Tip labelOf={(p: any) => `${p.code} · ${p.name} · class ${p.cls}`} />} cursor={{ fill: 'currentColor', fillOpacity: 0.05 }} />
          <ReferenceLine yAxisId="p" y={80} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: '80%', position: 'insideTopRight', fontSize: 10, fill: '#f59e0b' }} />
          <Bar yAxisId="v" dataKey="value" name="Value" radius={[4, 4, 0, 0]} maxBarSize={26}>
            {data.map((d) => (
              <Cell key={d.code} fill={colour[d.cls]} />
            ))}
            <LabelList
              dataKey="value"
              content={(props: any) => {
                // The A items only: the few that carry the value are the ones worth reading.
                if (data[props.index]?.cls !== 'A') return null
                return valueLabel('currentColor', (v) => inr(v).replace('₹', ''))(props)
              }}
            />
          </Bar>
          <Line yAxisId="p" type="monotone" dataKey="cumPct" name="Running share %" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2.5, fill: '#f59e0b' }}>
            <LabelList
              dataKey="cumPct"
              content={(props: any) =>
                props.index % 3 === 0 || props.index === data.length - 1
                  ? valueLabel('#d97706', (v) => `${Math.round(v)}%`)({ ...props, width: 0 })
                  : null
              }
            />
          </Line>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Requisitions by where they stand, as a funnel. */
export function RequisitionFunnel({ data }: { data: Array<{ name: string; value: number; fill: string }> }) {
  const shown = data.filter((d) => d.value > 0)
  if (!shown.length) return <Empty h={220} text="No requisitions waiting or issued in this period." />
  return (
    <ResponsiveContainer width="100%" height={220}>
      <FunnelChart margin={{ top: 4, right: 110, bottom: 4, left: 8 }}>
        <Tooltip content={<Tip money={false} />} />
        <Funnel dataKey="value" data={shown} isAnimationActive={false}>
          <LabelList position="right" dataKey="name" style={{ fontSize: 11, fill: '#64748b' }} />
          <LabelList position="center" dataKey="value" style={{ fontSize: 13, fontWeight: 700, fill: '#fff' }} />
        </Funnel>
      </FunnelChart>
    </ResponsiveContainer>
  )
}

/** The kinds of movement in the period, round a radar: which way the store is working. */
export function MixRadar({ data }: { data: Array<{ label: string; moves: number }> }) {
  if (data.length < 3) {
    if (!data.length) return <Empty h={240} />
    return (
      <div className="text-muted-foreground">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data}>
            <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
            <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
            <Bar dataKey="moves" name="Movements" fill="#818cf8" radius={[4, 4, 0, 0]}>
              <LabelList dataKey="moves" position="top" style={{ ...lbl, fill: 'currentColor' }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  }
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={240}>
        <RadarChart data={data.map((d) => ({ ...d, name: `${d.label} (${d.moves})` }))} outerRadius="70%">
          <PolarGrid stroke="currentColor" strokeOpacity={0.2} />
          <PolarAngleAxis dataKey="name" tick={{ ...axis, fontSize: 10 }} />
          <PolarRadiusAxis tick={false} axisLine={false} />
          {/* The counts are in each name round the edge; labels at the points crowded the middle. */}
          <Radar name="Movements" dataKey="moves" stroke="#818cf8" fill="#818cf8" fillOpacity={0.4} dot={{ r: 3, fill: '#818cf8' }} />
          <Tooltip content={<Tip money={false} />} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Departments' stock value as concentric rings, the biggest outermost. */
export function DepartmentRings({ data }: { data: Array<{ name: string; value: number }> }) {
  const rows = data.slice(0, 7).map((d, n) => ({ ...d, fill: PALETTE[n % PALETTE.length] })).reverse()
  if (!rows.length) return <Empty h={260} />
  const total = data.reduce((t, d) => t + d.value, 0)
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
      <ResponsiveContainer width="100%" height={240}>
        <RadialBarChart data={rows} innerRadius="18%" outerRadius="100%" startAngle={90} endAngle={-270} barSize={10}>
          <RadialBar dataKey="value" background={{ fill: 'currentColor', fillOpacity: 0.06 }} cornerRadius={5} isAnimationActive={false} />
          <Tooltip content={<Tip labelOf={(p: any) => p.name} />} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="space-y-1.5 pr-1">
        {[...rows].reverse().map((d) => (
          <div key={d.name} className="flex items-center gap-2 text-[11px]">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.fill }} />
            <span className="w-20 truncate text-foreground">{d.name}</span>
            <span className="w-14 text-right font-semibold tabular-nums text-foreground">{inr(d.value)}</span>
            <span className="w-8 text-right tabular-nums text-muted-foreground">{total ? Math.round((d.value / total) * 100) : 0}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The items that moved the most value, in and out side by side. */
export function MoversBars({ data: raw }: { data: Array<{ code: string; name: string; inValue: number; outValue: number; moves: number }> }) {
  if (!raw.length) return <Empty h={260} text="No movement in this period." />
  const data = raw.map((d) => ({ ...d, tag: `${inr(d.inValue + d.outValue)} · ${d.moves}×` }))
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={Math.max(200, data.length * 34 + 30)}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 92, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.12} horizontal={false} />
          <XAxis type="number" tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} />
          <YAxis type="category" dataKey="code" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} width={96} />
          <Tooltip content={<Tip labelOf={(p: any) => `${p.code} · ${p.name} · ${p.moves} movements`} />} cursor={{ fill: 'currentColor', fillOpacity: 0.05 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
          <Bar dataKey="inValue" name="Value in" stackId="m" fill={IN} barSize={14} />
          <Bar dataKey="outValue" name="Value out" stackId="m" fill={OUT} radius={[0, 4, 4, 0]} barSize={14}>
            <LabelList
              dataKey="tag"
              content={(props: any) => (
                // One line at the end of the bar; the default label wraps to the bar's height.
                <text
                  x={Number(props.x) + Number(props.width) + 6}
                  y={Number(props.y) + Number(props.height) / 2}
                  dominantBaseline="central"
                  fontSize={10}
                  fontWeight={700}
                  fill="currentColor"
                >
                  {props.value}
                </text>
              )}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Twelve weeks of movements as a calendar: the darker the day, the busier the store. */
export function ActivityHeatmap({ data }: { data: Array<{ day: string; moves: number }> }) {
  if (!data.length) return <Empty h={160} />
  const max = Math.max(1, ...data.map((d) => d.moves))
  // Columns are weeks starting on Monday; the first column is padded before the first day.
  const first = new Date(`${data[0].day}T00:00:00`)
  const pad = (first.getDay() + 6) % 7
  const cells: Array<{ day: string; moves: number } | null> = [...Array(pad).fill(null), ...data]
  const weeks: Array<typeof cells> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  const shade = (n: number) => {
    if (!n) return 'hsl(var(--secondary))'
    const t = n / max
    return `rgba(20, 184, 166, ${0.45 + t * 0.55})`
  }
  const total = data.reduce((t, d) => t + d.moves, 0)
  const busiest = data.reduce((b, d) => (d.moves > b.moves ? d : b), data[0])
  return (
    <div>
      <div className="flex gap-1.5 pb-1">
        <div className="mr-1 flex flex-col gap-1.5 pt-4 text-[10px] text-muted-foreground">
          {['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].map((d, i) => (
            <span key={i} className="flex h-6 items-center">{d}</span>
          ))}
        </div>
        {weeks.map((w, i) => {
          const firstDay = w.find(Boolean)
          const showMonth = firstDay && (i === 0 || new Date(`${firstDay.day}T00:00:00`).getDate() <= 7)
          return (
            <div key={i} className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="h-3 whitespace-nowrap text-[10px] text-muted-foreground">
                {showMonth ? new Date(`${firstDay!.day}T00:00:00`).toLocaleDateString('en-IN', { month: 'short' }) : ''}
              </span>
              {Array.from({ length: 7 }).map((_, j) => {
                const c = w[j]
                return (
                  <span
                    key={j}
                    className="flex h-6 w-full items-center justify-center rounded-[5px] text-[9px] font-bold text-white transition-transform hover:scale-110"
                    style={{ background: c ? shade(c.moves) : 'transparent' }}
                    title={c ? `${new Date(`${c.day}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}: ${c.moves} movements` : undefined}
                  >
                    {c && c.moves > 0 ? c.moves : ''}
                  </span>
                )
              })}
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          <span className="font-semibold text-foreground">{total}</span> movements in 12 weeks · busiest{' '}
          <span className="font-semibold text-foreground">
            {new Date(`${busiest.day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
          </span>{' '}
          ({busiest.moves})
        </span>
        <span className="flex items-center gap-1">
          Less
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <span key={t} className="h-3 w-3 rounded-[3px]" style={{ background: t ? `rgba(20,184,166,${0.25 + t * 0.75})` : 'hsl(var(--secondary))' }} />
          ))}
          More
        </span>
      </div>
    </div>
  )
}

/** A small line of the recent trend, for a figure card. */
export function Sparkline({ data, colour = '#14b8a6' }: { data: number[]; colour?: string }) {
  if (data.length < 2 || !data.some(Boolean)) return <div className="h-9" />
  const rows = data.map((v, i) => ({ i, v }))
  return (
    <ResponsiveContainer width="100%" height={36}>
      <ComposedChart data={rows} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`sp${colour.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colour} stopOpacity={0.35} />
            <stop offset="100%" stopColor={colour} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={colour} strokeWidth={1.5} fill={`url(#sp${colour.slice(1)})`} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
