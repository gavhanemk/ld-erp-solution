'use client'

import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line, Pie, PieChart, PolarAngleAxis,
  PolarGrid, PolarRadiusAxis, Radar, RadarChart, ReferenceLine, ResponsiveContainer, Tooltip, Treemap,
  XAxis, YAxis,
} from 'recharts'

/**
 * The stock ledger dashboard's charts, one kind for each question: bars and a
 * line for the flow over time, a donut for the mix of movements, columns for
 * stores side by side, a treemap for where the value sits by category, a radar
 * for how busy each department is, and a bar list for the documents.
 *
 * Colours are fixed hues that read on light and dark alike; axis text takes
 * the surrounding text colour through currentColor.
 */

export interface LedgerGroup {
  value: string
  label: string
  moves: number
  inValue: number
  outValue: number
}

export const IN_COLOUR = '#10b981'
export const OUT_COLOUR = '#f87171'
const PALETTE = ['#14b8a6', '#38bdf8', '#f59e0b', '#a78bfa', '#34d399', '#fb7185', '#818cf8', '#a3e635', '#fb923c', '#22d3ee']

/** ₹ short enough for an axis: 12.5 L, 3.2 Cr, 45 K. */
export const shortRupees = (v: number) => {
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(1)} Cr`
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(1)} L`
  if (a >= 1e3) return `${sign}₹${(a / 1e3).toFixed(0)} K`
  return `${sign}₹${a.toFixed(0)}`
}

const axis = { fontSize: 11, fill: 'currentColor' }

/** A value label that says nothing for a zero, so empty bars stay unlabelled. */
const count0 = (v: unknown) => (Number(v) ? Number(v).toLocaleString('en-IN') : '')
const labelStyle = { fontSize: 10, fontWeight: 600 }

/**
 * A bar's value above it (or below, for a bar hanging down), on one line.
 * Values under `floor` are left bare: a sliver of a bar with a label on it
 * only collides with its neighbours.
 */
function barLabel(colour: string, format: (v: number) => string, floor = 0, below = false) {
  return function BarValue(props: any) {
    const { x, y, width, height, value } = props
    const v = Math.abs(Number(value))
    if (!v || v < floor) return null
    const cx = Number(x) + Number(width) / 2
    const top = Math.min(Number(y), Number(y) + Number(height))
    const bottom = Math.max(Number(y), Number(y) + Number(height))
    return (
      <text x={cx} y={below ? bottom + 11 : top - 5} textAnchor="middle" fill={colour} fontSize={10} fontWeight={600}>
        {format(v)}
      </text>
    )
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function Tip({ active, payload, label, money = true }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="glass-card space-y-1 px-3 py-2 text-xs shadow-lg">
      {label !== undefined && <p className="font-semibold text-foreground">{label}</p>}
      {payload.map((p: any) => (
        <div key={p.dataKey ?? p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color ?? p.payload?.fill }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-semibold tabular-nums text-foreground">
            {money && p.dataKey !== 'moves' ? shortRupees(Math.abs(p.value)) : Number(p.value).toLocaleString('en-IN')}
          </span>
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

/** Value in above the line, out below it, and the number of movements as a line on its own scale. */
export function FlowChart({
  data,
  onPick,
}: {
  data: Array<{ key: string; label: string; from: string; to: string; inValue: number; outValue: number; moves: number }>
  onPick: (from: string, to: string) => void
}) {
  if (!data.length) return <Empty h={240} />
  const rows = data.map((b) => ({ ...b, out: -b.outValue }))
  // Labels read while the bars that have any are few; past that they collide.
  // Empty days carry no label, so a month with five busy days is labelled.
  const labelled = rows.filter((b) => b.inValue || b.outValue || b.moves).length <= 20
  const floor = Math.max(...rows.map((b) => Math.max(b.inValue, b.outValue))) * 0.03
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart
          data={rows}
          margin={{ top: 20, right: 4, left: 4, bottom: 0 }}
          stackOffset="sign"
          onClick={(e: any) => {
            const b = e?.activePayload?.[0]?.payload
            if (b) onPick(b.from, b.to)
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} minTickGap={16} />
          <YAxis yAxisId="v" tick={axis} tickLine={false} axisLine={false} tickFormatter={shortRupees} width={76} />
          <YAxis yAxisId="n" orientation="right" tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
          <ReferenceLine yAxisId="v" y={0} stroke="currentColor" strokeOpacity={0.4} />
          <Tooltip content={<Tip />} cursor={{ fill: 'currentColor', fillOpacity: 0.06 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
          <Bar yAxisId="v" dataKey="inValue" name="Value in" stackId="f" fill={IN_COLOUR} radius={[3, 3, 0, 0]} maxBarSize={28} cursor="pointer">
            {labelled && <LabelList dataKey="inValue" content={barLabel(IN_COLOUR, shortRupees, floor)} />}
          </Bar>
          <Bar yAxisId="v" dataKey="out" name="Value out" stackId="f" fill={OUT_COLOUR} radius={[0, 0, 3, 3]} maxBarSize={28} cursor="pointer">
            {labelled && <LabelList dataKey="out" content={barLabel(OUT_COLOUR, shortRupees, floor, true)} />}
          </Bar>
          <Line yAxisId="n" type="monotone" dataKey="moves" name="Movements" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2 }}>
            {labelled && <LabelList dataKey="moves" position="top" offset={8} formatter={count0} style={{ ...labelStyle, fill: '#d97706' }} />}
          </Line>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** The mix of movement kinds, as a donut; a slice is a filter. */
export function MovementDonut({
  data,
  picked,
  onPick,
}: {
  data: Array<{ value: string; label: string; count: number }>
  picked: string[]
  onPick: (value: string) => void
}) {
  if (!data.length) return <Empty h={240} />
  const total = data.reduce((s, d) => s + d.count, 0)
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={240}>
        <PieChart>
          <Pie
            data={data}
            dataKey="count"
            nameKey="label"
            innerRadius="58%"
            outerRadius="85%"
            paddingAngle={2}
            onClick={(d: any) => onPick(d.value)}
            cursor="pointer"
            stroke="none"
            labelLine={false}
            isAnimationActive={false}
            label={(p: any) => {
              if (p.percent < 0.04) return null
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
              <Cell
                key={d.value}
                fill={PALETTE[n % PALETTE.length]}
                fillOpacity={picked.length && !picked.includes(d.value) ? 0.3 : 1}
              />
            ))}
          </Pie>
          <Tooltip content={<Tip money={false} />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold tabular-nums text-foreground">{total}</span>
        <span className="text-[11px] text-muted-foreground">movements</span>
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
            {d.label}{' '}
            <span className="tabular-nums">
              {d.count} · {total ? Math.round((d.count / total) * 100) : 0}%
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Stores side by side, in and out as a pair of columns each. */
export function StoreColumns({ data, onPick }: { data: LedgerGroup[]; onPick: (value: string) => void }) {
  if (!data.length) return <Empty h={260} />
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart
          data={data}
          margin={{ top: 20, right: 4, left: 4, bottom: 0 }}
          onClick={(e: any) => {
            const g = e?.activePayload?.[0]?.payload
            if (g) onPick(g.value)
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} interval={0} tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)} />
          <YAxis tick={axis} tickLine={false} axisLine={false} tickFormatter={shortRupees} width={64} />
          <Tooltip content={<Tip />} cursor={{ fill: 'currentColor', fillOpacity: 0.06 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
          <Bar dataKey="inValue" name="Value in" fill={IN_COLOUR} radius={[4, 4, 0, 0]} maxBarSize={36} cursor="pointer">
            <LabelList dataKey="inValue" content={barLabel(IN_COLOUR, shortRupees)} />
          </Bar>
          <Bar dataKey="outValue" name="Value out" fill={OUT_COLOUR} radius={[4, 4, 0, 0]} maxBarSize={36} cursor="pointer">
            <LabelList dataKey="outValue" content={barLabel(OUT_COLOUR, shortRupees)} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Where the value moved sits, by category: the bigger the box, the more value. */
export function CategoryTreemap({ data, onPick }: { data: LedgerGroup[]; onPick: (value: string) => void }) {
  const rows = data
    .map((g, n) => ({ ...g, gid: g.value, name: g.label, size: g.inValue + g.outValue, fill: PALETTE[n % PALETTE.length] }))
    .filter((g) => g.size > 0)
  if (!rows.length) return <Empty h={260} />
  const whole = rows.reduce((t, g) => t + g.size, 0)
  const Box = (props: any) => {
    // The treemap writes its own `value` onto each box, so the id travels as gid.
    const { x, y, width, height, name, size, fill, gid } = props
    if (!name || width <= 0 || height <= 0) return null
    return (
      <g style={{ cursor: 'pointer' }} onClick={() => onPick(gid)}>
        <rect x={x} y={y} width={width} height={height} rx={6} fill={fill} fillOpacity={0.85} stroke="hsl(var(--card))" strokeWidth={3} />
        {width > 60 && height > 34 && (
          <>
            <text x={x + 8} y={y + 18} fill="#fff" fontSize={12} fontWeight={600}>
              {name.length > width / 7 ? `${name.slice(0, Math.max(3, Math.floor(width / 7) - 1))}…` : name}
            </text>
            <text x={x + 8} y={y + 33} fill="#fff" fillOpacity={0.95} fontSize={11}>
              {shortRupees(size)} · {Math.round((size / whole) * 100)}%
            </text>
          </>
        )}
      </g>
    )
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <Treemap data={rows} dataKey="size" nameKey="name" isAnimationActive={false} content={<Box />}>
        <Tooltip
          content={({ active, payload }: any) =>
            active && payload?.length ? (
              <div className="glass-card px-3 py-2 text-xs shadow-lg">
                <p className="font-semibold text-foreground">{payload[0].payload.name}</p>
                <p className="text-emerald-500">in {shortRupees(payload[0].payload.inValue)}</p>
                <p className="text-red-400">out {shortRupees(payload[0].payload.outValue)}</p>
                <p className="text-muted-foreground">{payload[0].payload.moves} movements</p>
              </div>
            ) : null
          }
        />
      </Treemap>
    </ResponsiveContainer>
  )
}

/** How busy each department's items were: movements in and out, round the web. */
export function DepartmentRadar({ data }: { data: Array<LedgerGroup & { ins: number; outs: number }> }) {
  if (data.length < 3) return <DepartmentFallback data={data} />
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={280}>
        <RadarChart data={data.map((d) => ({ ...d, name: `${d.label} (${d.ins} in · ${d.outs} out)` }))} outerRadius="68%">
          <PolarGrid stroke="currentColor" strokeOpacity={0.2} />
          <PolarAngleAxis dataKey="name" tick={axis} />
          <PolarRadiusAxis tick={false} axisLine={false} />
          <Radar name="Movements in" dataKey="ins" stroke={IN_COLOUR} fill={IN_COLOUR} fillOpacity={0.35} dot={{ r: 3, fill: IN_COLOUR }} />
          <Radar name="Movements out" dataKey="outs" stroke={OUT_COLOUR} fill={OUT_COLOUR} fillOpacity={0.3} dot={{ r: 3, fill: OUT_COLOUR }} />
          <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
          <Tooltip content={<Tip money={false} />} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** A radar needs three points to be a shape; fewer are plain bars. */
function DepartmentFallback({ data }: { data: Array<LedgerGroup & { ins: number; outs: number }> }) {
  if (!data.length) return <Empty h={280} />
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data}>
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
          <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
          <Tooltip content={<Tip money={false} />} />
          <Bar dataKey="ins" name="Movements in" fill={IN_COLOUR} radius={[4, 4, 0, 0]}>
            <LabelList dataKey="ins" position="top" formatter={count0} style={{ ...labelStyle, fill: IN_COLOUR }} />
          </Bar>
          <Bar dataKey="outs" name="Movements out" fill={OUT_COLOUR} radius={[4, 4, 0, 0]}>
            <LabelList dataKey="outs" position="top" formatter={count0} style={{ ...labelStyle, fill: OUT_COLOUR }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** The documents behind the movements, longest bar first, in and out stacked. */
export function DocumentBars({ data, onPick }: { data: LedgerGroup[]; onPick: (value: string) => void }) {
  if (!data.length) return <Empty h={280} />
  const rows = [...data].sort((a, b) => b.moves - a.moves).slice(0, 10)
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={Math.max(180, rows.length * 28 + 30)}>
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
          <Tooltip content={<Tip money={false} />} cursor={{ fill: 'currentColor', fillOpacity: 0.06 }} />
          <Bar dataKey="moves" name="Movements" radius={[0, 4, 4, 0]} cursor="pointer" barSize={16}>
            {rows.map((r, n) => (
              <Cell key={r.value} fill={PALETTE[n % PALETTE.length]} />
            ))}
            <LabelList dataKey="moves" position="right" formatter={count0} style={{ ...labelStyle, fill: 'currentColor' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
