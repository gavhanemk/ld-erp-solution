'use client'

import { Fragment, useState } from 'react'
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Pie, PieChart,
  PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip,
  Treemap, XAxis, YAxis,
} from 'recharts'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  ChartTip, EmptyChart, IN_COLOUR, PALETTE, TONE, inr, markLabel, qtyFmt,
} from '@/components/dashboard/DashKit'

/**
 * The purchase dashboard's charts, each a different kind for a different
 * question, drawn from the shared dashboard kit so they match the inventory
 * dashboards. Axis text takes the surrounding colour through currentColor,
 * so the charts read on light and dark alike.
 */

const axis = { fontSize: 11, fill: 'currentColor' }
const inrAxis = (v: number) => inr(v).replace('.00', '').replace(/\.(\d)\d /, '.$1 ')
const GRID = { strokeDasharray: '3 3', stroke: 'currentColor', strokeOpacity: 0.15 }

/** Tones the server names, as the kit's colours. Grey for "no date given". */
export const TONE_OF: Record<string, string> = { ...TONE, slate: '#94a3b8' }

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Value ordered and received as soft areas, and the number of orders as bars
 * behind them. The count sits inside its bar; values are labelled only on
 * the real peaks, so labels never sit on one another.
 */
export function BuyingChart({
  data,
}: {
  data: Array<{ key: string; label: string; ordered: number; received: number; orders: number }>
}) {
  if (!data.some((d) => d.ordered || d.received)) return <EmptyChart h={270} text="Nothing was ordered in this period." />
  const peak = Math.max(...data.map((d) => Math.max(d.ordered, d.received)), 1)
  const top = (pick: (d: (typeof data)[number]) => number, n: number) =>
    new Set(
      [...data]
        .sort((a, b) => pick(b) - pick(a))
        .slice(0, n)
        .filter((d) => pick(d) >= peak * 0.1)
        .map((d) => d.key),
    )
  const topOrdered = top((d) => d.ordered, 4)
  const topReceived = top((d) => d.received, 3)
  const only = (set: Set<string>, colour: string) => (props: any) =>
    set.has(data[props.index]?.key) ? markLabel(colour, inr)(props) : null
  const busy = data.filter((d) => d.orders).length
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={270}>
        <ComposedChart data={data} margin={{ top: 24, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="pbOrdered" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={PALETTE[0]} stopOpacity={0.35} />
              <stop offset="100%" stopColor={PALETTE[0]} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="pbReceived" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={PALETTE[1]} stopOpacity={0.25} />
              <stop offset="100%" stopColor={PALETTE[1]} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis yAxisId="v" tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} width={70} />
          <YAxis yAxisId="n" orientation="right" tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
          <Tooltip content={<ChartTip />} />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconSize={8} />
          <Bar yAxisId="n" dataKey="orders" name="Orders count" fill={TONE.violet} fillOpacity={0.22} radius={[4, 4, 0, 0]} maxBarSize={20}>
            {busy <= 20 && <LabelList dataKey="orders" content={markLabel('#6d28d9', (v) => `${v}`, { inside: true, insideColour: '#5b21b6' })} />}
          </Bar>
          <Area yAxisId="v" type="monotone" dataKey="ordered" name="Value ordered" stroke={PALETTE[0]} strokeWidth={2} fill="url(#pbOrdered)">
            <LabelList dataKey="ordered" content={only(topOrdered, '#0f766e')} />
          </Area>
          <Area yAxisId="v" type="monotone" dataKey="received" name="Value received" stroke={PALETTE[1]} strokeWidth={2} fill="url(#pbReceived)">
            <LabelList dataKey="received" content={only(topReceived, '#1d4ed8')} />
          </Area>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Where the money went, supplier by supplier: share on each slice, total in the middle. */
export function SupplierDonut({
  data,
  active,
  onPick,
}: {
  data: Array<{ id: string; name: string; value: number; orders: number }>
  active: string
  onPick: (id: string) => void
}) {
  const total = data.reduce((t, d) => t + d.value, 0)
  if (!total) return <EmptyChart h={260} />
  const orders = data.reduce((t, d) => t + d.orders, 0)
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
            {orders} {orders === 1 ? 'order' : 'orders'}
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
            <span className="text-muted-foreground">
              {d.orders} {d.orders === 1 ? 'order' : 'orders'}
            </span>
            <span className="w-10 text-right tabular-nums text-muted-foreground">{Math.round((d.value / total) * 100)}%</span>
            <span className="w-16 text-right font-semibold tabular-nums text-foreground">{inr(d.value)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Sub-categories as boxes sized by value, coloured by their category. The
 * category's id rides along on each box, because a treemap's click hands
 * back the box, not the row it came from.
 */
export function CategoryTreemap({
  data,
  onPick,
}: {
  data: Array<{ id: string; name: string; value: number; children?: Array<{ name: string; value: number }> }>
  onPick: (categoryId: string) => void
}) {
  const total = data.reduce((t, d) => t + d.value, 0)
  if (!total) return <EmptyChart h={280} />
  const rows = data.map((c, n) => ({
    name: c.name,
    children: (c.children ?? [{ name: c.name, value: c.value }])
      .filter((s) => s.value > 0)
      .map((s) => ({ name: s.name, size: s.value, cat: c.name, catId: c.id, fill: PALETTE[n % PALETTE.length] })),
  }))
  const Box = (props: any) => {
    const { x, y, width, height, depth, name, fill, size, catId } = props
    if (depth !== 2 || width <= 0 || height <= 0) return null
    const fits = width > 70 && height > 34
    return (
      <g style={{ cursor: 'pointer' }} onClick={() => catId && onPick(catId)}>
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
          <button
            key={c.id}
            type="button"
            onClick={() => onPick(c.id)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-primary"
          >
            <span className="h-2 w-2 rounded-sm" style={{ background: PALETTE[n % PALETTE.length] }} />
            {c.name} <span className="font-medium text-foreground">{inr(c.value)}</span>
          </button>
        ))}
      </div>
    </>
  )
}

/**
 * Value still to arrive on open orders, by when it is wanted. The number of
 * orders sits inside each bar; the value above it. A bar opens its list.
 */
export function ScheduleBars({
  data,
  onPick,
}: {
  data: Array<{ key: string; label: string; hint?: string; tone: string; orders: number; value: number }>
  onPick: (key: string) => void
}) {
  if (!data.some((d) => d.value)) return <EmptyChart h={260} text="No open order is waiting on goods." />
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ top: 22, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} interval={0} />
          <YAxis tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} width={64} />
          <Tooltip content={<ChartTip labelOf={(p: any) => `${p.hint ?? p.label} · ${p.orders} ${p.orders === 1 ? 'order' : 'orders'}`} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Bar dataKey="value" name="Still to arrive" radius={[6, 6, 0, 0]} maxBarSize={44} cursor="pointer" onClick={(d: any) => d?.key && onPick(d.key)}>
            {data.map((d) => (
              <Cell key={d.key} fill={TONE_OF[d.tone] ?? PALETTE[0]} />
            ))}
            <LabelList dataKey="value" content={markLabel('currentColor', inr)} />
            <LabelList dataKey="orders" content={markLabel('#fff', (v) => `${v}`, { inside: true })} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** From indent to payment, as numbered steps: each with its figure and what it is out of. */
export function PipelineSteps({
  steps,
}: {
  steps: Array<{ label: string; value: string; sub?: string; share: number; colour: string }>
}) {
  return (
    <div className="space-y-3.5">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ background: s.colour }}>
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-foreground">{s.label}</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">{s.value}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-secondary">
              <div className="h-1.5 rounded-full transition-all" style={{ width: `${Math.max(s.share ? 2 : 0, Math.min(100, s.share))}%`, background: s.colour }} />
            </div>
            {s.sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{s.sub}</p>}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Quantity ordered, one tile per unit — metres with metres, pieces with
 * pieces — with how much of it has come in, and the value behind it.
 */
export function UnitTiles({
  data,
}: {
  data: Array<{ uom: string; orderedQty: number; receivedQty: number; value: number; items: number; lines: number }>
}) {
  if (!data.length) return <EmptyChart h={160} text="Nothing was ordered in this period." />
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {data.map((u, n) => {
        const got = u.orderedQty ? Math.min(100, (u.receivedQty / u.orderedQty) * 100) : 0
        return (
          <div key={u.uom} className="rounded-lg border border-border/70 p-3">
            <div className="flex items-center justify-between">
              <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white" style={{ background: PALETTE[n % PALETTE.length] }}>
                {u.uom}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {u.items} {u.items === 1 ? 'item' : 'items'}
              </span>
            </div>
            <p className="mt-2 text-lg font-semibold tabular-nums text-foreground">{qtyFmt(u.orderedQty)}</p>
            <p className="text-[11px] text-muted-foreground">
              ordered · {inr(u.value)}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1 flex-1 rounded-full bg-secondary">
                <div className="h-1 rounded-full" style={{ width: `${got}%`, background: IN_COLOUR }} />
              </div>
              <span className="text-[10px] tabular-nums text-muted-foreground">{Math.round(got)}% in</span>
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{qtyFmt(u.receivedQty)} received</p>
          </div>
        )
      })}
    </div>
  )
}

/** Orders by stage round a radar; the counts are in the names. Bars when there are too few stages for a shape. */
export function StageRadar({ data }: { data: Array<{ label: string; orders: number }> }) {
  if (!data.length) return <EmptyChart h={240} text="Nothing was ordered in this period." />
  if (data.length < 3)
    return (
      <div className="text-muted-foreground">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data} margin={{ top: 20 }}>
            <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
            <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
            <Tooltip content={<ChartTip money={false} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
            <Bar dataKey="orders" name="Orders count" fill={PALETTE[6]} radius={[6, 6, 0, 0]}>
              <LabelList dataKey="orders" content={markLabel('currentColor', (v) => `${v}`)} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={240}>
        <RadarChart data={data.map((d) => ({ ...d, name: `${d.label} · ${d.orders}` }))} outerRadius="56%">
          <PolarGrid stroke="currentColor" strokeOpacity={0.15} />
          <PolarAngleAxis dataKey="name" tick={{ ...axis, fontSize: 10 }} />
          <PolarRadiusAxis tick={false} axisLine={false} />
          <Radar name="Orders count" dataKey="orders" stroke={PALETTE[6]} fill={PALETTE[6]} fillOpacity={0.3} dot={{ r: 3, fill: PALETTE[6] }} />
          <Tooltip content={<ChartTip money={false} />} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Days from the order to its first delivery; the count sits inside each bar. */
export function LeadTimeBars({ data }: { data: Array<{ label: string; orders: number }> }) {
  if (!data.some((d) => d.orders)) return <EmptyChart h={240} text="No goods have come in on this period's orders yet." />
  const colours = ['#10b981', '#84cc16', '#f59e0b', '#f97316', '#f43f5e']
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 20, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
          <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
          <Tooltip content={<ChartTip money={false} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Bar dataKey="orders" name="Orders count" radius={[6, 6, 0, 0]} maxBarSize={40}>
            {data.map((d, n) => (
              <Cell key={d.label} fill={colours[n]} />
            ))}
            <LabelList dataKey="orders" content={markLabel('currentColor', (v) => `${v}`)} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** The biggest suppliers as a ranking; value and orders at the end of each bar. A bar filters the page. */
export function SupplierBars({
  data,
  active,
  onPick,
}: {
  data: Array<{ id: string; name: string; value: number; orders: number }>
  active: string
  onPick: (id: string) => void
}) {
  if (!data.length) return <EmptyChart h={240} text="Nothing was ordered in this period." />
  const rows = data.slice(0, 8).map((d) => ({
    ...d,
    short: d.name.length > 16 ? `${d.name.slice(0, 15)}…` : d.name,
    tag: `${inr(d.value)} · ${d.orders}×`,
  }))
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 34 + 20)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 92, left: 0, bottom: 0 }}>
          <CartesianGrid {...GRID} horizontal={false} />
          <XAxis type="number" tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} />
          <YAxis type="category" dataKey="short" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} width={104} />
          <Tooltip content={<ChartTip labelOf={(p: any) => `${p.name} · ${p.orders} ${p.orders === 1 ? 'order' : 'orders'}`} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Bar dataKey="value" name="Value ordered" radius={[0, 4, 4, 0]} barSize={14} cursor="pointer" onClick={(d: any) => d?.id && onPick(d.id)}>
            {rows.map((d) => (
              <Cell key={d.id} fill={PALETTE[0]} fillOpacity={active && active !== d.id ? 0.3 : 1} />
            ))}
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

interface BreakRow {
  id?: string
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
  if (!rows.length) return <EmptyChart h={160} text="Nothing was ordered in this period." />
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
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-2 font-medium">{by === 'category' ? 'Category' : 'Department'}</th>
              <th className="px-2 py-2 text-right font-medium">Items</th>
              <th className="px-2 py-2 text-right font-medium">Lines</th>
              <th className="px-2 py-2 text-right font-medium">Quantity ordered</th>
              <th className="px-2 py-2 text-right font-medium">Value</th>
              <th className="w-40 py-2 pl-2 font-medium">Share of value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, n) => {
              const isOpen = open.has(r.name)
              const colour = PALETTE[n % PALETTE.length]
              return (
                <Fragment key={r.name}>
                  <tr className="cursor-pointer border-b border-border/60 hover:bg-secondary/50" onClick={() => toggle(r.name)}>
                    <td className="py-2.5 pr-2">
                      <span className="flex items-center gap-2 font-medium text-foreground">
                        {isOpen ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colour }} />
                        {r.name}
                      </span>
                    </td>
                    <td className="px-2 text-right tabular-nums">{r.items}</td>
                    <td className="px-2 text-right tabular-nums text-muted-foreground">{r.lines}</td>
                    <td className="px-2">{qtyCell(r.qty)}</td>
                    <td className="px-2 text-right font-semibold tabular-nums">{inr(r.value)}</td>
                    <td className="py-2.5 pl-2">
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
                        <td className="py-2 pl-10 pr-2 text-foreground">{c.name}</td>
                        <td className="px-2 text-right tabular-nums">{c.items}</td>
                        <td className="px-2 text-right tabular-nums text-muted-foreground">{c.lines}</td>
                        <td className="px-2">{qtyCell(c.qty)}</td>
                        <td className="px-2 text-right tabular-nums">{inr(c.value)}</td>
                        <td className="py-2 pl-2">
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

/** A small line of the recent trend, for a figure tile. */
export function Sparkline({ data, colour = PALETTE[0] }: { data: number[]; colour?: string }) {
  if (data.length < 2 || !data.some(Boolean)) return <div className="h-8" />
  const id = `psp${colour.slice(1)}`
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
