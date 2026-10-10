'use client'

import { useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Pie, PieChart,
  PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, RadialBar, RadialBarChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { ChartTip, EmptyChart, TONE, inr, markLabel } from '@/components/dashboard/DashKit'
import type { Ageing, HomeData, Partner, StageCount, TrendPoint } from './types'

/**
 * The home dashboard's charts, drawn from the shared dashboard kit so they sit
 * with the purchase and inventory dashboards as one family. Each answers a
 * different question with a different form; axis text takes the surrounding
 * colour through currentColor, so they read on light and dark alike.
 *
 * Colours follow the thing, never its rank: a module, an item type or money
 * coming in keeps its colour on every chart. The sets were checked for
 * colour-blind separation and contrast on both themes.
 */

const axis = { fontSize: 11, fill: 'currentColor' }
const GRID = { strokeDasharray: '3 3', stroke: 'currentColor', strokeOpacity: 0.15 }
const inrAxis = (v: number) => inr(v).replace('.00', '').replace(/\.(\d)\d /, '.$1 ')

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A category label on one line, right-aligned to the axis — recharts would wrap it. */
const oneLine = (max: number) =>
  function OneLineTick({ x, y, payload }: any) {
    const t = String(payload?.value ?? '')
    return (
      <text x={x} y={y} dy={4} textAnchor="end" fontSize={10} fill="currentColor">
        {t.length > max ? `${t.slice(0, max - 1)}…` : t}
      </text>
    )
  }

/** Nothing, nobody, or not applicable. */
export const SLATE = '#94a3b8'

/** Money or goods coming in, and going out. */
export const IN = '#0d9488'
export const OUT = '#e11d48'

/** One colour per module, everywhere on the page. */
export const MODULE: Record<string, { label: string; colour: string }> = {
  purchase: { label: 'Purchase', colour: '#3b82f6' },
  sales: { label: 'Sales', colour: '#0d9488' },
  inventory: { label: 'Stores', colour: '#8b5cf6' },
  production: { label: 'Production', colour: '#d97706' },
  accounts: { label: 'Accounts', colour: '#ec4899' },
  masters: { label: 'Masters', colour: '#64748b' },
  admin: { label: 'Settings', colour: SLATE },
  settings: { label: 'Settings', colour: SLATE },
}
export const moduleOf = (m: string) => MODULE[m] ?? { label: m.charAt(0).toUpperCase() + m.slice(1), colour: SLATE }

/** One colour per kind of item. */
export const ITEM_TYPE: Record<string, string> = {
  RAW_MATERIAL: '#0d9488',
  TRIM: '#3b82f6',
  PACKING_MATERIAL: '#8b5cf6',
  CONSUMABLE: '#d97706',
  FINISHED_GOOD: '#ec4899',
  SEMI_FINISHED: '#64748b',
}

/* ───────────────────────────── the business over time ───────────────────────────── */

type Series = { key: keyof TrendPoint; name: string; colour: string }
export interface TrendView {
  key: string
  label: string
  hint: string
  series: Series[]
  money: boolean
  /** What the first series less the second is called, where that means something. */
  net?: string
}

/** The views the trend card can switch between, as far as this role may see. */
export function trendViews(d: HomeData): TrendView[] {
  const v: TrendView[] = []
  if (d.sales || d.purchase)
    v.push({
      key: 'orders',
      label: 'Orders',
      hint: 'Sales orders booked against purchase orders placed, before GST',
      money: true,
      series: [
        ...(d.sales ? [{ key: 'booked' as const, name: 'Sales booked', colour: IN }] : []),
        ...(d.purchase ? [{ key: 'ordered' as const, name: 'Purchases ordered', colour: MODULE.purchase.colour }] : []),
      ],
    })
  if (d.money)
    v.push(
      {
        key: 'billing',
        label: 'Billing',
        hint: 'Invoices raised to customers against bills booked from suppliers',
        money: true,
        net: 'invoiced less bills',
        series: [
          { key: 'invoiced', name: 'Invoiced', colour: IN },
          { key: 'billed', name: 'Bills booked', colour: OUT },
        ],
      },
      {
        key: 'cash',
        label: 'Cash',
        hint: 'Money received from customers against money paid to suppliers',
        money: true,
        net: 'net cash',
        series: [
          { key: 'collected', name: 'Collected', colour: IN },
          { key: 'paid', name: 'Paid out', colour: OUT },
        ],
      },
    )
  if (d.inventory)
    v.push({
      key: 'stores',
      label: 'Stores',
      hint: 'Value of goods coming into the stores against going out',
      money: true,
      net: 'net change in stock',
      series: [
        { key: 'stockIn', name: 'Stock in', colour: IN },
        { key: 'stockOut', name: 'Stock out', colour: OUT },
      ],
    })
  if (d.production)
    v.push({
      key: 'output',
      label: 'Output',
      hint: 'Pieces produced on the floor and at job workers',
      money: false,
      series: [{ key: 'produced', name: 'Pieces count', colour: MODULE.production.colour }],
    })
  return v
}

/** One view at a time: a bar a day, week or month on one scale, with the totals above as the legend. */
export function TrendChart({ data, view }: { data: TrendPoint[]; view: TrendView }) {
  const totals = view.series.map((s) => data.reduce((t, p) => t + Number(p[s.key] ?? 0), 0))
  const empty = !totals.some(Boolean)
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        {view.series.map((s, i) => (
          <div key={s.key} className="flex items-baseline gap-2">
            <span className="h-2.5 w-2.5 translate-y-px rounded-full" style={{ background: s.colour }} />
            <span className="text-xs text-muted-foreground">{s.name.replace(' count', '')}</span>
            <span className="text-lg font-semibold tabular-nums text-foreground">
              {view.money ? inr(totals[i]) : totals[i].toLocaleString('en-IN')}
            </span>
          </div>
        ))}
        {view.net && !empty && (
          <span className="text-xs text-muted-foreground">
            {view.net}{' '}
            <span className={`font-semibold ${totals[0] - totals[1] >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
              {view.money ? inr(totals[0] - totals[1]) : (totals[0] - totals[1]).toLocaleString('en-IN')}
            </span>
          </span>
        )}
      </div>
      {empty ? (
        <EmptyChart h={250} text="Nothing in this period yet." />
      ) : (
        <div className="text-muted-foreground">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barGap={2} barCategoryGap="18%">
              <CartesianGrid {...GRID} vertical={false} />
              <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis
                tick={axis}
                tickLine={false}
                axisLine={false}
                width={view.money ? 70 : 40}
                allowDecimals={false}
                tickFormatter={view.money ? inrAxis : (v: number) => v.toLocaleString('en-IN')}
              />
              <Tooltip content={<ChartTip money={view.money} />} cursor={{ fill: 'currentColor', fillOpacity: 0.05 }} />
              {view.series.map((s) => (
                <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.colour} radius={[4, 4, 0, 0]} maxBarSize={22} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

/* ───────────────────────────── who owes whom ───────────────────────────── */

/**
 * What we owe to the left, what is owed to us to the right, by how late it
 * is — the two sides of the ledger on one scale, so they can be weighed.
 */
const AGE_SHORT: Record<string, string> = { notDue: 'Not yet due', d30: '1–30 days', d60: '31–60 days', d90: '61–90 days', older: '90+ days' }

export function AgeingChart({ receivable, payable }: { receivable: Ageing; payable: Ageing }) {
  const rows = receivable.buckets.map((b, i) => ({
    label: AGE_SHORT[b.key] ?? b.label,
    owedToUs: b.value,
    weOwe: -payable.buckets[i].value,
    inCount: b.count,
    outCount: payable.buckets[i].count,
  }))
  const empty = !receivable.total && !payable.total
  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border/70 p-3">
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: OUT }} /> We owe suppliers
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{inr(payable.total)}</p>
          <p className="text-[11px] text-muted-foreground">
            {payable.overdue ? <span className="text-rose-500">{inr(payable.overdue)} overdue</span> : 'nothing overdue'}
            {payable.dueWeek ? ` · ${inr(payable.dueWeek)} due this week` : ''}
          </p>
        </div>
        <div className="rounded-lg border border-border/70 p-3">
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: IN }} /> Customers owe us
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{inr(receivable.total)}</p>
          <p className="text-[11px] text-muted-foreground">
            {receivable.overdue ? <span className="text-rose-500">{inr(receivable.overdue)} overdue</span> : 'nothing overdue'}
          </p>
        </div>
      </div>
      {empty ? (
        <EmptyChart h={180} text="Nothing is owed either way." />
      ) : (
        <div className="text-muted-foreground">
          <ResponsiveContainer width="100%" height={190}>
            <BarChart data={rows} layout="vertical" stackOffset="sign" margin={{ top: 0, right: 8, left: 0, bottom: 0 }} barCategoryGap={6}>
              <CartesianGrid {...GRID} horizontal={false} />
              <XAxis type="number" tick={axis} tickLine={false} axisLine={false} tickFormatter={(v: number) => inrAxis(Math.abs(v))} />
              <YAxis type="category" dataKey="label" tick={oneLine(14)} tickLine={false} axisLine={false} width={70} />
              <ReferenceLine x={0} stroke="currentColor" strokeOpacity={0.4} />
              <Tooltip content={<ChartTip />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
              <Bar dataKey="weOwe" name="We owe" stackId="a" fill={OUT} radius={[4, 0, 0, 4]} barSize={14} />
              <Bar dataKey="owedToUs" name="Owed to us" stackId="a" fill={IN} radius={[0, 4, 4, 0]} barSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

/* ───────────────────────────── stock by kind ───────────────────────────── */

/** Stock value by kind of item, total in the middle. */
export function StockDonut({ data, total }: { data: Array<{ type: string; label: string; value: number; items: number }>; total: number }) {
  if (!total) return <EmptyChart h={200} text="Nothing in stock." />
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center xl:flex-col xl:items-stretch">
      <div className="relative mx-auto h-44 w-44 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="label" innerRadius="68%" outerRadius="98%" paddingAngle={2} stroke="none" isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.type} fill={ITEM_TYPE[d.type] ?? SLATE} />
              ))}
            </Pie>
            <Tooltip content={<ChartTip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-base font-semibold tabular-nums text-foreground">{inr(total)}</span>
          <span className="text-[11px] text-muted-foreground">in stock</span>
        </div>
      </div>
      <div className="min-w-0 flex-1 divide-y divide-border/60">
        {data.map((d) => (
          <div key={d.type} className="flex items-center gap-2 py-1.5 text-xs">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: ITEM_TYPE[d.type] ?? SLATE }} />
            <span className="flex-1 truncate text-foreground">{d.label}</span>
            <span className="text-muted-foreground">{d.items} items</span>
            <span className="w-9 text-right tabular-nums text-muted-foreground">{Math.round((d.value / total) * 100)}%</span>
            <span className="w-16 text-right font-semibold tabular-nums text-foreground">{inr(d.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ───────────────────────────── biggest partners ───────────────────────────── */

/** The biggest customers or suppliers in the period, as a ranking. */
export function PartnerBars({ data, colour, empty }: { data: Partner[]; colour: string; empty: string }) {
  if (!data.length) return <EmptyChart h={220} text={empty} />
  const rows = data.slice(0, 6).map((d) => ({
    ...d,
    tag: `${inr(d.value)} · ${d.orders}×`,
  }))
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={Math.max(150, rows.length * 34 + 16)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 92, left: 0, bottom: 0 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="name" tick={oneLine(20)} tickLine={false} axisLine={false} width={118} />
          <Tooltip
            content={<ChartTip labelOf={(p: any) => `${p.name} · ${p.orders} ${p.orders === 1 ? 'order' : 'orders'}`} />}
            cursor={{ fill: 'currentColor', fillOpacity: 0.04 }}
          />
          <Bar dataKey="value" name="Value" radius={[0, 4, 4, 0]} barSize={14} fill={colour}>
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

/* ───────────────────────────── order books ───────────────────────────── */

/** Stages from first to last, light to dark; a cancelled order steps aside in grey. */
const STAGE_RAMP = ['#99f6e4', '#5eead4', '#2dd4bf', '#14b8a6', '#0d9488', '#0f766e']

/**
 * An order book as one bar split by stage, light to dark as orders move on,
 * with the count and value of each stage beneath.
 */
export function StageBar({ title, stages, empty }: { title: string; stages: StageCount[]; empty: string }) {
  const total = stages.reduce((t, s) => t + s.count, 0)
  const live = stages.filter((s) => s.status !== 'CANCELLED')
  const colour = (s: StageCount) => (s.status === 'CANCELLED' ? SLATE : STAGE_RAMP[Math.min(STAGE_RAMP.length - 1, live.indexOf(s) + (6 - live.length))])
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{title}</span>
        <span className="text-[11px] text-muted-foreground">
          {total} {total === 1 ? 'order' : 'orders'}
        </span>
      </div>
      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-[11px] text-muted-foreground">{empty}</p>
      ) : (
        <>
          <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
            {stages
              .filter((s) => s.count)
              .map((s) => (
                <div key={s.status} style={{ width: `${(s.count / total) * 100}%`, background: colour(s) }} title={`${s.label}: ${s.count}`} />
              ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
            {stages
              .filter((s) => s.count)
              .map((s) => (
                <div key={s.status} className="flex items-center gap-1.5 text-[11px]">
                  <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: colour(s) }} />
                  <span className="flex-1 truncate text-muted-foreground">{s.label}</span>
                  <span className="font-semibold tabular-nums text-foreground">{s.count}</span>
                  <span className="w-14 text-right tabular-nums text-muted-foreground">{inr(s.value)}</span>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  )
}

/* ───────────────────────────── the health ring ───────────────────────────── */

/** How many of the checks are clear, as a ring. */
export function HealthRing({ clear, total }: { clear: number; total: number }) {
  const share = total ? clear / total : 1
  const colour = share === 1 ? TONE.emerald : share >= 0.6 ? TONE.amber : TONE.rose
  return (
    <div className="relative h-32 w-32 shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart innerRadius="78%" outerRadius="100%" startAngle={90} endAngle={-270} data={[{ v: share * 100 }]} barSize={10}>
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
          <RadialBar dataKey="v" cornerRadius={6} fill={colour} background={{ fill: 'hsl(var(--secondary))' }} isAnimationActive={false} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-bold tabular-nums text-foreground">
          {clear}
          <span className="text-sm font-medium text-muted-foreground">/{total}</span>
        </span>
        <span className="text-[10px] text-muted-foreground">checks clear</span>
      </div>
    </div>
  )
}

/* ───────────────────────────── the production floor ───────────────────────────── */

/** Today's efficiency as a half dial: achieved against target. */
export function EfficiencyGauge({ efficiency, achieved, target }: { efficiency: number | null; achieved: number; target: number }) {
  const v = efficiency ?? 0
  const colour = efficiency == null ? SLATE : v >= 90 ? TONE.emerald : v >= 70 ? TONE.amber : TONE.rose
  return (
    <div className="relative mx-auto h-32 w-52 overflow-hidden">
      <ResponsiveContainer width="100%" height={208}>
        <RadialBarChart cx="50%" cy="50%" innerRadius="74%" outerRadius="100%" startAngle={180} endAngle={0} data={[{ v: Math.min(100, v) }]} barSize={14}>
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
          <RadialBar dataKey="v" cornerRadius={8} fill={colour} background={{ fill: 'hsl(var(--secondary))' }} isAnimationActive={false} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center">
        <span className="text-2xl font-bold tabular-nums text-foreground">{efficiency == null ? '—' : `${efficiency}%`}</span>
        <span className="text-[11px] text-muted-foreground">
          {target ? `${achieved.toLocaleString('en-IN')} of ${target.toLocaleString('en-IN')} pieces` : 'no target set today'}
        </span>
      </div>
    </div>
  )
}

/** The last fortnight's output against its target: the target a ghost behind each day. */
export function FortnightBars({ data }: { data: Array<{ day: string; target: number; achieved: number; rejection: number }> }) {
  if (!data.some((d) => d.target || d.achieved)) return <EmptyChart h={190} text="No output logged in the last two weeks." />
  const rows = data.map((d) => ({
    ...d,
    label: new Date(`${d.day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
  }))
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={190}>
        <BarChart data={rows} margin={{ top: 16, right: 4, left: 0, bottom: 0 }} barGap={-14}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={12} />
          <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={36} />
          <Tooltip content={<ChartTip money={false} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} iconSize={8} />
          <Bar dataKey="target" name="Target qty" fill="currentColor" fillOpacity={0.18} radius={[4, 4, 0, 0]} barSize={14} />
          <Bar dataKey="achieved" name="Made qty" fill={MODULE.production.colour} radius={[4, 4, 0, 0]} barSize={14}>
            <LabelList dataKey="achieved" content={markLabel('currentColor', (v) => v.toLocaleString('en-IN'), { floor: 1 })} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ───────────────────────────── where the work happens ───────────────────────────── */

/** Entries made in each module in the period, round a radar; bars when there are too few modules for a shape. */
export function ModuleRadar({ data }: { data: HomeData['activity']['modules'] }) {
  if (!data.length) return <EmptyChart h={230} text="Nothing was entered in this period." />
  const rows = data.map((m) => ({ ...m, name: `${moduleOf(m.module).label} · ${m.total}` }))
  if (rows.length < 3)
    return (
      <div className="text-muted-foreground">
        <ResponsiveContainer width="100%" height={230}>
          <BarChart data={rows} margin={{ top: 20 }}>
            <XAxis dataKey="name" tick={axis} tickLine={false} axisLine={false} />
            <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
            <Tooltip content={<ChartTip money={false} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
            <Bar dataKey="total" name="Entries count" radius={[4, 4, 0, 0]} maxBarSize={44}>
              {rows.map((m) => (
                <Cell key={m.module} fill={moduleOf(m.module).colour} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={230}>
        <RadarChart data={rows} outerRadius="66%">
          <PolarGrid stroke="currentColor" strokeOpacity={0.15} />
          <PolarAngleAxis dataKey="name" tick={{ ...axis, fontSize: 10 }} />
          <PolarRadiusAxis tick={false} axisLine={false} />
          <Radar name="Entries count" dataKey="total" stroke={TONE.violet} fill={TONE.violet} fillOpacity={0.25} dot={{ r: 4, fill: TONE.violet }} />
          <Tooltip content={<ChartTip money={false} />} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * Twelve weeks of entries across the system, a square a day, darker for a
 * busier day. Pointing at a day spells it out underneath, module by module.
 */
export function ActivityHeatmap({ data }: { data: HomeData['activity']['heat'] }) {
  const [hover, setHover] = useState<(typeof data)[number] | null>(null)
  if (!data.length) return <EmptyChart h={200} />
  const max = Math.max(1, ...data.map((d) => d.total))
  const first = new Date(`${data[0].day}T00:00:00`)
  const pad = (first.getDay() + 6) % 7
  const cells: Array<(typeof data)[number] | null> = [...Array(pad).fill(null), ...data]
  const weeks: Array<typeof cells> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  const shade = (n: number) => (n ? `rgba(13, 148, 136, ${0.3 + (n / max) * 0.7})` : 'hsl(var(--secondary))')
  const total = data.reduce((t, d) => t + d.total, 0)
  const active = data.filter((d) => d.total).length
  const busiest = data.reduce((b, d) => (d.total > b.total ? d : b), data[0])
  const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', o)
  const shown = hover ?? (busiest.total ? busiest : null)
  return (
    <div>
      <div className="flex gap-1">
        <div className="mr-1 flex flex-col gap-1 pt-4 text-[10px] text-muted-foreground">
          {['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].map((d, i) => (
            <span key={i} className="flex h-5 items-center">
              {d}
            </span>
          ))}
        </div>
        {weeks.map((w, i) => {
          const firstDay = w.find(Boolean)
          const showMonth = firstDay && (i === 0 || new Date(`${firstDay.day}T00:00:00`).getDate() <= 7)
          return (
            <div key={i} className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="h-3 whitespace-nowrap text-[10px] text-muted-foreground">{showMonth ? fmt(firstDay!.day, { month: 'short' }) : ''}</span>
              {Array.from({ length: 7 }).map((_, j) => {
                const c = w[j]
                return (
                  <span
                    key={j}
                    onMouseEnter={() => c && setHover(c)}
                    onMouseLeave={() => setHover(null)}
                    className={`h-5 w-full rounded ${c ? 'cursor-default transition-transform hover:scale-110' : ''} ${hover && c && hover.day === c.day ? 'ring-2 ring-primary/60' : ''}`}
                    style={{ background: c ? shade(c.total) : 'transparent' }}
                    aria-label={c ? `${fmt(c.day, { weekday: 'short', day: 'numeric', month: 'short' })}: ${c.total} entries` : undefined}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex min-h-9 flex-wrap items-center justify-between gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-xs">
        {shown ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{fmt(shown.day, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
              {hover ? '' : ' (busiest)'} · {shown.total} {shown.total === 1 ? 'entry' : 'entries'}
            </span>
            {Object.entries(shown.byModule)
              .sort((a, b) => b[1] - a[1])
              .map(([m, n]) => (
                <span key={m} className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full" style={{ background: moduleOf(m).colour }} />
                  {moduleOf(m).label} <span className="font-semibold text-foreground">{n}</span>
                </span>
              ))}
          </span>
        ) : (
          <span className="text-muted-foreground">Nothing entered in the last twelve weeks.</span>
        )}
        <span className="flex items-center gap-1 text-muted-foreground">
          <span className="font-semibold text-foreground">{total}</span> entries on {active} days · Less
          {[0, 0.33, 0.66, 1].map((t) => (
            <span key={t} className="h-3 w-3 rounded" style={{ background: t ? `rgba(13,148,136,${0.3 + t * 0.7})` : 'hsl(var(--secondary))' }} />
          ))}
          More
        </span>
      </div>
    </div>
  )
}
