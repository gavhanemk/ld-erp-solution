'use client'

import { Fragment, useState } from 'react'
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line, Pie, PieChart,
  PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ReferenceLine, ResponsiveContainer,
  Tooltip, Treemap, XAxis, YAxis,
} from 'recharts'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  ChartTip, EmptyChart, IN_COLOUR, OUT_COLOUR, PALETTE, inr, markLabel, qtyFmt,
} from '@/components/dashboard/DashKit'

/**
 * The inventory dashboard's charts, each a different kind for a different
 * question, drawn from the shared dashboard kit so they match the ledger and
 * customer material dashboards. Axis text takes the surrounding colour
 * through currentColor, so the charts read on light and dark alike.
 */

export { inr }

const axis = { fontSize: 11, fill: 'currentColor' }
const inrAxis = (v: number) => inr(v).replace('.00', '').replace(/\.(\d)\d /, '.$1 ')

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Value in and out each day as soft areas, and the number of movements as
 * bars behind them. The count sits inside its bar; the value is labelled only
 * on the few biggest days, so labels never sit on one another.
 */
export function FlowChart({ data }: { data: Array<{ day: string; inValue: number; outValue: number; moves: number }> }) {
  if (!data.some((d) => d.moves)) return <EmptyChart h={260} text="No movement in this period." />
  const rows = data.map((d) => ({
    ...d,
    label: new Date(`${d.day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
  }))
  const busy = rows.filter((d) => d.moves).length
  // Only the peaks carry a value: anything under a tenth of the biggest day
  // sits on the zero line, where labels would only land on one another.
  const peak = Math.max(...rows.map((d) => Math.max(d.inValue, d.outValue)), 1)
  const topIn = new Set(
    [...rows].sort((a, b) => b.inValue - a.inValue).slice(0, 4).filter((d) => d.inValue >= peak * 0.1).map((d) => d.day),
  )
  const topOut = new Set(
    [...rows].sort((a, b) => b.outValue - a.outValue).slice(0, 3).filter((d) => d.outValue >= peak * 0.1).map((d) => d.day),
  )
  const only = (set: Set<string>, colour: string) => (props: any) =>
    set.has(rows[props.index]?.day) ? markLabel(colour, inr)(props) : null
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={270}>
        <ComposedChart data={rows} margin={{ top: 24, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="dfIn" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={IN_COLOUR} stopOpacity={0.35} />
              <stop offset="100%" stopColor={IN_COLOUR} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="dfOut" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={OUT_COLOUR} stopOpacity={0.3} />
              <stop offset="100%" stopColor={OUT_COLOUR} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis yAxisId="v" tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} width={70} />
          <YAxis yAxisId="n" orientation="right" tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
          <Tooltip content={<ChartTip />} />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconSize={8} />
          <Bar yAxisId="n" dataKey="moves" name="Movements" fill="#8b5cf6" fillOpacity={0.22} radius={[4, 4, 0, 0]} maxBarSize={20}>
            {busy <= 20 && <LabelList dataKey="moves" content={markLabel('#6d28d9', (v) => `${v}`, { inside: true, insideColour: '#5b21b6' })} />}
          </Bar>
          <Area yAxisId="v" type="monotone" dataKey="inValue" name="Value in" stroke={IN_COLOUR} strokeWidth={2} fill="url(#dfIn)">
            <LabelList dataKey="inValue" content={only(topIn, '#059669')} />
          </Area>
          <Area yAxisId="v" type="monotone" dataKey="outValue" name="Value out" stroke={OUT_COLOUR} strokeWidth={2} fill="url(#dfOut)">
            <LabelList dataKey="outValue" content={only(topOut, '#e11d48')} />
          </Area>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Where the value sits, store by store, share on each slice, total in the middle. */
export function StoreDonut({
  data,
  active,
  onPick,
}: {
  data: Array<{ id: string; name: string; value: number; lines: number }>
  active: string
  onPick: (id: string) => void
}) {
  const total = data.reduce((t, d) => t + d.value, 0)
  if (!total) return <EmptyChart h={260} />
  return (
    <div>
      <div className="relative">
        <ResponsiveContainer width="100%" height={196}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="64%"
              outerRadius="94%"
              paddingAngle={2}
              stroke="none"
              isAnimationActive={false}
              cursor="pointer"
              onClick={(d: any) => onPick(d.id)}
              labelLine={false}
              label={(p: any) => {
                if (p.percent < 0.07) return null
                const r = p.innerRadius + (p.outerRadius - p.innerRadius) / 2
                const a = (-p.midAngle * Math.PI) / 180
                return (
                  <text x={p.cx + r * Math.cos(a)} y={p.cy + r * Math.sin(a)} fill="#fff" fontSize={10} fontWeight={600} textAnchor="middle" dominantBaseline="central">
                    {Math.round(p.percent * 100)}%
                  </text>
                )
              }}
            >
              {data.map((d, n) => (
                <Cell key={d.id} fill={PALETTE[n % PALETTE.length]} fillOpacity={active && active !== d.id ? 0.25 : 1} />
              ))}
            </Pie>
            <Tooltip content={<ChartTip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums text-foreground">{inr(total)}</span>
          <span className="text-[11px] text-muted-foreground">
            {data.length} {data.length === 1 ? 'store' : 'stores'}
          </span>
        </div>
      </div>
      <div className="mt-3 divide-y divide-border/60">
        {data.map((d, n) => (
          <button
            key={d.id}
            type="button"
            onClick={() => onPick(d.id)}
            className={`flex w-full items-center gap-2 px-1 py-1.5 text-xs transition-colors hover:text-primary ${active === d.id ? 'font-semibold' : ''}`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PALETTE[n % PALETTE.length] }} />
            <span className="flex-1 truncate text-left text-foreground">{d.name}</span>
            <span className="text-muted-foreground">{d.lines} lines</span>
            <span className="w-10 text-right tabular-nums text-muted-foreground">{Math.round((d.value / total) * 100)}%</span>
            <span className="w-16 text-right font-semibold tabular-nums text-foreground">{inr(d.value)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Sub-categories as boxes sized by value, coloured by their category. */
export function CategoryTreemap({ data }: { data: Array<{ name: string; value: number; children: Array<{ name: string; value: number }> }> }) {
  const total = data.reduce((t, d) => t + d.value, 0)
  if (!total) return <EmptyChart h={280} />
  const rows = data.map((c, n) => ({
    name: c.name,
    children: c.children.filter((s) => s.value > 0).map((s) => ({ name: s.name, size: s.value, cat: c.name, fill: PALETTE[n % PALETTE.length] })),
  }))
  const Box = (props: any) => {
    const { x, y, width, height, depth, name, fill, size } = props
    if (depth !== 2 || width <= 0 || height <= 0) return null
    const fits = width > 70 && height > 34
    return (
      <g>
        <rect x={x} y={y} width={width} height={height} rx={6} fill={fill} fillOpacity={0.85} stroke="hsl(var(--card))" strokeWidth={3} />
        {fits && (
          <>
            <text x={x + 8} y={y + 17} fill="#fff" fontSize={11} fontWeight={600}>
              {String(name).length > width / 7 ? `${String(name).slice(0, Math.max(3, Math.floor(width / 7) - 1))}…` : name}
            </text>
            <text x={x + 8} y={y + 31} fill="#fff" fillOpacity={0.9} fontSize={10}>
              {inr(size)} · {Math.round((size / total) * 100)}%
            </text>
          </>
        )}
      </g>
    )
  }
  return (
    <>
      <ResponsiveContainer width="100%" height={272}>
        <Treemap data={rows} dataKey="size" isAnimationActive={false} content={<Box />}>
          <Tooltip
            content={({ active, payload }: any) =>
              active && payload?.length ? (
                <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
                  <p className="font-semibold text-foreground">{payload[0].payload.name}</p>
                  <p className="text-muted-foreground">{payload[0].payload.cat}</p>
                  <p className="font-semibold tabular-nums text-foreground">{inr(payload[0].payload.size)}</p>
                </div>
              ) : null
            }
          />
        </Treemap>
      </ResponsiveContainer>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {data.map((c, n) => (
          <span key={c.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2 w-2 rounded-sm" style={{ background: PALETTE[n % PALETTE.length] }} />
            {c.name} <span className="font-medium text-foreground">{inr(c.value)}</span>
          </span>
        ))}
      </div>
    </>
  )
}

const AGE_COLOURS = ['#10b981', '#84cc16', '#f59e0b', '#f97316', '#f43f5e']

/** Value by days since it last moved; the number of lines sits inside each bar. */
export function AgeingBars({ data }: { data: Array<{ key: string; label: string; value: number; lines: number }> }) {
  if (!data.some((d) => d.value)) return <EmptyChart h={260} />
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ top: 22, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis dataKey="key" tick={axis} tickLine={false} axisLine={false} />
          <YAxis tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} width={64} />
          <Tooltip content={<ChartTip labelOf={(p: any) => `${p.label} since last moved · ${p.lines} lines`} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Bar dataKey="value" name="Value" radius={[6, 6, 0, 0]} maxBarSize={44}>
            {data.map((d, n) => (
              <Cell key={d.key} fill={AGE_COLOURS[n]} />
            ))}
            <LabelList dataKey="value" content={markLabel('currentColor', inr)} />
            <LabelList dataKey="lines" content={markLabel('#fff', (v) => `${v} lines`, { inside: true })} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * Items by value with the running share as a line. The A bars carry their
 * value; the line is labelled where A ends and at the last item only.
 */
export function ParetoChart({ data }: { data: Array<{ code: string; name: string; value: number; cumPct: number; cls: string }> }) {
  if (!data.length) return <EmptyChart h={280} />
  const colour: Record<string, string> = { A: PALETTE[0], B: PALETTE[1], C: PALETTE[2] }
  const lastA = data.map((d) => d.cls).lastIndexOf('A')
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={290}>
        <ComposedChart data={data} margin={{ top: 22, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis dataKey="code" tick={{ ...axis, fontSize: 9 }} tickLine={false} axisLine={false} interval={0} angle={-40} textAnchor="end" height={54} />
          <YAxis yAxisId="v" tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} width={64} />
          <YAxis yAxisId="p" orientation="right" domain={[0, 100]} tick={axis} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} width={38} />
          <Tooltip content={<ChartTip labelOf={(p: any) => `${p.code} · ${p.name} · class ${p.cls}`} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <ReferenceLine yAxisId="p" y={80} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.7} />
          <Bar yAxisId="v" dataKey="value" name="Value" radius={[4, 4, 0, 0]} maxBarSize={24}>
            {data.map((d) => (
              <Cell key={d.code} fill={colour[d.cls]} />
            ))}
            <LabelList
              dataKey="value"
              content={(props: any) =>
                data[props.index]?.cls === 'A' ? markLabel('currentColor', (v) => inr(v).replace('₹', ''))(props) : null
              }
            />
          </Bar>
          <Line yAxisId="p" type="monotone" dataKey="cumPct" name="Running share %" stroke="#f59e0b" strokeWidth={2} dot={false}>
            <LabelList
              dataKey="cumPct"
              content={(props: any) =>
                props.index === lastA || props.index === data.length - 1 ? (
                  <g>
                    <rect x={Number(props.x) - 18} y={Number(props.y) - 24} width={36} height={16} rx={8} fill="#f59e0b" />
                    <text x={Number(props.x)} y={Number(props.y) - 13} textAnchor="middle" fill="#fff" fontSize={10} fontWeight={600}>
                      {Math.round(props.value)}%
                    </text>
                  </g>
                ) : null
              }
            />
          </Line>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Requisitions by where they stand, as steps from asking to handing over. */
export function PipelineSteps({ steps }: { steps: Array<{ label: string; value: number; colour: string }> }) {
  const max = Math.max(1, ...steps.map((s) => s.value))
  return (
    <div className="space-y-3">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center gap-3">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
            style={{ background: s.colour }}
          >
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-foreground">{s.label}</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">{s.value}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-secondary">
              <div className="h-1.5 rounded-full transition-all" style={{ width: `${(s.value / max) * 100}%`, background: s.colour }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** The kinds of movement in the period round a radar; the counts are in the names. */
export function MixRadar({ data }: { data: Array<{ label: string; moves: number }> }) {
  if (!data.length) return <EmptyChart h={240} text="No movement in this period." />
  if (data.length < 3)
    return (
      <div className="text-muted-foreground">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data} margin={{ top: 20 }}>
            <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
            <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
            <Bar dataKey="moves" name="Movements" fill={PALETTE[6]} radius={[6, 6, 0, 0]}>
              <LabelList dataKey="moves" content={markLabel('currentColor', (v) => `${v}`)} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={240}>
        <RadarChart data={data.map((d) => ({ ...d, name: `${d.label} · ${d.moves}` }))} outerRadius="68%">
          <PolarGrid stroke="currentColor" strokeOpacity={0.15} />
          <PolarAngleAxis dataKey="name" tick={{ ...axis, fontSize: 10 }} />
          <PolarRadiusAxis tick={false} axisLine={false} />
          <Radar name="Movements" dataKey="moves" stroke={PALETTE[6]} fill={PALETTE[6]} fillOpacity={0.3} dot={{ r: 3, fill: PALETTE[6] }} />
          <Tooltip content={<ChartTip money={false} />} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** The items that moved the most value, in and out stacked, value and count at the end. */
export function MoversBars({ data: raw }: { data: Array<{ code: string; name: string; inValue: number; outValue: number; moves: number }> }) {
  if (!raw.length) return <EmptyChart h={260} text="No movement in this period." />
  const data = raw.map((d) => ({ ...d, tag: `${inr(d.inValue + d.outValue)} · ${d.moves}×` }))
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={Math.max(200, data.length * 34 + 30)}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 96, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} horizontal={false} />
          <XAxis type="number" tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} />
          <YAxis type="category" dataKey="code" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} width={96} />
          <Tooltip content={<ChartTip labelOf={(p: any) => `${p.code} · ${p.name} · ${p.moves} movements`} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
          <Bar dataKey="inValue" name="Value in" stackId="m" fill={IN_COLOUR} barSize={14} />
          <Bar dataKey="outValue" name="Value out" stackId="m" fill={OUT_COLOUR} radius={[0, 4, 4, 0]} barSize={14}>
            <LabelList
              dataKey="tag"
              content={(props: any) => (
                <text x={Number(props.x) + Number(props.width) + 6} y={Number(props.y) + Number(props.height) / 2} dominantBaseline="central" fontSize={10} fontWeight={600} fill="currentColor">
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

/** Twelve weeks of movements as a calendar; the count sits in each busy day. */
export function ActivityHeatmap({ data }: { data: Array<{ day: string; moves: number }> }) {
  if (!data.length) return <EmptyChart h={160} />
  const max = Math.max(1, ...data.map((d) => d.moves))
  const first = new Date(`${data[0].day}T00:00:00`)
  const pad = (first.getDay() + 6) % 7
  const cells: Array<{ day: string; moves: number } | null> = [...Array(pad).fill(null), ...data]
  const weeks: Array<typeof cells> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  const shade = (n: number) => (n ? `rgba(13, 148, 136, ${0.35 + (n / max) * 0.65})` : 'hsl(var(--secondary))')
  const total = data.reduce((t, d) => t + d.moves, 0)
  const busiest = data.reduce((b, d) => (d.moves > b.moves ? d : b), data[0])
  const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', o)
  return (
    <div>
      <div className="flex gap-1.5">
        <div className="mr-1 flex flex-col gap-1.5 pt-[18px] text-[10px] text-muted-foreground">
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
                {showMonth ? fmt(firstDay!.day, { month: 'short' }) : ''}
              </span>
              {Array.from({ length: 7 }).map((_, j) => {
                const c = w[j]
                return (
                  <span
                    key={j}
                    className="flex h-6 w-full items-center justify-center rounded-md text-[10px] font-semibold text-white"
                    style={{ background: c ? shade(c.moves) : 'transparent' }}
                    title={c ? `${fmt(c.day, { weekday: 'short', day: 'numeric', month: 'short' })}: ${c.moves} movements` : undefined}
                  >
                    {c && c.moves > 0 ? c.moves : ''}
                  </span>
                )
              })}
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          <span className="font-semibold text-foreground">{total}</span> movements in 12 weeks · busiest{' '}
          <span className="font-semibold text-foreground">{fmt(busiest.day, { day: 'numeric', month: 'short' })}</span> ({busiest.moves})
        </span>
        <span className="flex items-center gap-1">
          Less
          {[0, 0.33, 0.66, 1].map((t) => (
            <span key={t} className="h-3 w-3 rounded" style={{ background: t ? `rgba(13,148,136,${0.35 + t * 0.65})` : 'hsl(var(--secondary))' }} />
          ))}
          More
        </span>
      </div>
    </div>
  )
}

/** A small line of the recent trend, for a figure tile. */
export function Sparkline({ data, colour = PALETTE[0] }: { data: number[]; colour?: string }) {
  if (data.length < 2 || !data.some(Boolean)) return <div className="h-8" />
  const id = `sp${colour.slice(1)}`
  return (
    <ResponsiveContainer width="100%" height={32}>
      <ComposedChart data={data.map((v, i) => ({ i, v }))} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colour} stopOpacity={0.3} />
            <stop offset="100%" stopColor={colour} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={colour} strokeWidth={1.5} fill={`url(#${id})`} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

/**
 * Quantity on hand, one tile per unit — metres with metres, pieces with
 * pieces — with the value and the number of items behind each.
 */
export function UnitTiles({ data }: { data: Array<{ uom: string; qty: number; value: number; items: number }> }) {
  if (!data.length) return <EmptyChart h={160} />
  const total = data.reduce((t, u) => t + u.value, 0)
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {data.map((u, n) => (
        <div key={u.uom} className="rounded-lg border border-border/70 p-3">
          <div className="flex items-center justify-between">
            <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white" style={{ background: PALETTE[n % PALETTE.length] }}>
              {u.uom}
            </span>
            <span className="text-[11px] text-muted-foreground">{u.items} items</span>
          </div>
          <p className="mt-2 text-lg font-semibold tabular-nums text-foreground">{qtyFmt(u.qty)}</p>
          <p className="text-[11px] text-muted-foreground">{inr(u.value)} of stock</p>
          <div className="mt-2 h-1 rounded-full bg-secondary">
            <div className="h-1 rounded-full" style={{ width: `${total ? (u.value / total) * 100 : 0}%`, background: PALETTE[n % PALETTE.length] }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Quantity in and out in the period, unit by unit. Each row is scaled to its
 * own unit, since a roll and a piece cannot share one axis: out to the left,
 * in to the right, the figures at the ends.
 */
export function UnitFlow({ data }: { data: Array<{ uom: string; inQty: number; outQty: number; moves: number }> }) {
  if (!data.length) return <EmptyChart h={160} text="No movement in this period." />
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[40px_1fr_1fr] gap-2 text-[10px] font-medium uppercase tracking-wide">
        <span />
        <span className="text-right" style={{ color: OUT_COLOUR }}>went out</span>
        <span style={{ color: IN_COLOUR }}>came in</span>
      </div>
      {data.map((u) => {
        const max = Math.max(u.inQty, u.outQty, 1)
        return (
          <div key={u.uom} className="grid grid-cols-[40px_1fr_1fr] items-center gap-2">
            <span className="text-xs font-semibold text-foreground">{u.uom}</span>
            <div className="flex items-center justify-end gap-2">
              <span className="text-[11px] tabular-nums text-muted-foreground">{u.outQty ? qtyFmt(u.outQty) : '—'}</span>
              <div className="h-4 rounded-l-md" style={{ width: `${(u.outQty / max) * 70}%`, background: OUT_COLOUR, minWidth: u.outQty ? 3 : 0 }} />
            </div>
            <div className="flex items-center gap-2 border-l border-border">
              <div className="h-4 rounded-r-md" style={{ width: `${(u.inQty / max) * 70}%`, background: IN_COLOUR, minWidth: u.inQty ? 3 : 0 }} />
              <span className="text-[11px] tabular-nums text-muted-foreground">{u.inQty ? qtyFmt(u.inQty) : '—'}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface BreakRow {
  name: string
  value: number
  lines: number
  items: number
  share: number
  qty: Array<{ uom: string; qty: number }>
  children?: BreakRow[]
}

/**
 * Category and sub-category, or department and category: items, lines,
 * quantity unit by unit, value and share. A row opens to show what is in it.
 */
export function BreakdownTable({ categories, departments }: { categories: BreakRow[]; departments: BreakRow[] }) {
  const [by, setBy] = useState<'category' | 'department'>('category')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const rows = by === 'category' ? categories : departments
  const toggle = (k: string) =>
    setOpen((o) => {
      const n = new Set(o)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  const qtyCell = (q: BreakRow['qty']) => (
    <div className="flex flex-wrap justify-end gap-1">
      {q.map((x) => (
        <span key={x.uom} className="whitespace-nowrap rounded-md bg-secondary px-1.5 py-0.5 text-[11px] tabular-nums text-foreground">
          {qtyFmt(x.qty)} <span className="text-muted-foreground">{x.uom}</span>
        </span>
      ))}
    </div>
  )
  return (
    <div>
      <div className="mb-3 inline-flex rounded-lg border border-border bg-secondary p-0.5 text-xs">
        {(['category', 'department'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setBy(k)
              setOpen(new Set())
            }}
            className={`rounded-md px-3 py-1 font-medium transition-colors ${by === k ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {k === 'category' ? 'Category › Sub-category' : 'Department › Category'}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            {/* The same header as every list in the app: a grey strip, small capitals. */}
            <tr className="border-b border-border bg-secondary text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="whitespace-nowrap px-3 py-2 font-semibold">{by === 'category' ? 'Category' : 'Department'}</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Items</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Lines</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Quantity on hand</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Value</th>
              <th className="w-40 whitespace-nowrap px-3 py-2 font-semibold">Share of value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, n) => {
              const isOpen = open.has(r.name)
              const colour = PALETTE[n % PALETTE.length]
              return (
                <Fragment key={r.name}>
                  <tr className="cursor-pointer border-b border-border/60 hover:bg-secondary/50" onClick={() => toggle(r.name)}>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2 font-medium text-foreground">
                        {isOpen ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colour }} />
                        {r.name}
                      </span>
                    </td>
                    <td className="px-3 text-right tabular-nums">{r.items}</td>
                    <td className="px-3 text-right tabular-nums text-muted-foreground">{r.lines}</td>
                    <td className="px-3">{qtyCell(r.qty)}</td>
                    <td className="px-3 text-right font-semibold tabular-nums">{inr(r.value)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-secondary">
                          <div className="h-1.5 rounded-full" style={{ width: `${r.share}%`, background: colour }} />
                        </div>
                        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{r.share}%</span>
                      </div>
                    </td>
                  </tr>
                  {isOpen &&
                    (r.children ?? []).map((c) => (
                      <tr key={`${r.name}-${c.name}`} className="border-b border-border/40 bg-secondary/30 text-xs">
                        <td className="py-2 pl-12 pr-3 text-foreground">{c.name}</td>
                        <td className="px-3 text-right tabular-nums">{c.items}</td>
                        <td className="px-3 text-right tabular-nums text-muted-foreground">{c.lines}</td>
                        <td className="px-3">{qtyCell(c.qty)}</td>
                        <td className="px-3 text-right tabular-nums">{inr(c.value)}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <div className="h-1 flex-1 rounded-full bg-secondary">
                              <div className="h-1 rounded-full opacity-70" style={{ width: `${c.share}%`, background: colour }} />
                            </div>
                            <span className="w-10 text-right tabular-nums text-muted-foreground">{c.share}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
