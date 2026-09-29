'use client'

import { useEffect, useState } from 'react'
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  type TooltipProps,
} from 'recharts'
import { Empty } from './parts'
import {
  STATUS_TONE,
  TONE,
  pct,
  plural,
  rupees,
  shortRupees,
  type DashboardData,
} from './model'

/*
 * The plotted charts. Recharts for the axes, the hover and the resize; the
 * colours are the ERP's own tokens, so a theme switch repaints them with
 * everything else and nothing here holds a hex.
 *
 * Every chart has a hover that gives the exact figure — the bar shows a
 * rounded one — and every multi-series chart names its series in words, so
 * nothing rests on colour alone. Motion is dropped for anyone who has asked
 * their system for less of it.
 */

const AXIS = { fill: 'hsl(var(--muted-foreground))', fontSize: 11 }
const GRID = 'hsl(var(--border))'
const CARD = 'hsl(var(--card))'

function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(m.matches)
    const on = (e: MediaQueryListEvent) => setReduced(e.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return reduced
}

/** A phone-width screen, where a row of six axis labels has to be shortened to fit. */
function useNarrow() {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const m = window.matchMedia('(max-width: 639px)')
    setNarrow(m.matches)
    const on = (e: MediaQueryListEvent) => setNarrow(e.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}

/** The schedule's buckets as a phone can fit them. The hover keeps the full words. */
const SHORT_BUCKET: Record<string, string> = {
  overdue: 'Late',
  week: '7 d',
  next: '14 d',
  weeks34: '4 wk',
  later: 'Later',
  none: 'No date',
}

/** The hover card every chart shares. */
function Tip({
  title,
  rows,
}: {
  title: string
  rows: Array<{ label: string; value: string; colour?: string }>
}) {
  return (
    <div className="border-border bg-popover text-popover-foreground min-w-[9rem] rounded-lg border px-3 py-2 text-xs shadow-lg">
      <p className="text-foreground mb-1 font-semibold">{title}</p>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 py-0.5">
          {r.colour && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.colour }} />}
          <span className="text-muted-foreground flex-1">{r.label}</span>
          <span className="text-foreground font-medium tabular-nums">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

/** Named series, above the plot, because identity is never colour alone. */
function Legend({ items }: { items: Array<{ label: string; colour: string; dashed?: boolean }> }) {
  return (
    <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ background: i.colour }}
          />
          {i.label}
        </span>
      ))}
    </div>
  )
}

/* ---------------- When the outstanding goods are expected ---------------- */

export function ScheduleChart({
  schedule,
  onPick,
}: {
  schedule: DashboardData['now']['schedule']
  onPick: (key: string) => void
}) {
  const reduced = useReducedMotion()
  const narrow = useNarrow()
  if (!schedule.some((s) => s.value > 0)) {
    return <Empty>No open order is waiting on goods.</Empty>
  }
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <BarChart data={schedule} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid stroke={GRID} strokeOpacity={0.6} vertical={false} />
          <XAxis
            dataKey="label"
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            interval={0}
            tickFormatter={(label: string) =>
              narrow ? SHORT_BUCKET[schedule.find((s) => s.label === label)?.key ?? ''] ?? label : label
            }
          />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={52} tickFormatter={shortRupees} />
          <Tooltip
            cursor={{ fill: 'var(--hover-overlay-strong)' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as DashboardData['now']['schedule'][number]
              return (
                <Tip
                  title={p.label}
                  rows={[
                    { label: 'Still to arrive', value: rupees(p.value), colour: TONE[p.tone] },
                    { label: 'Orders', value: String(p.orders) },
                  ]}
                />
              )
            }}
          />
          <Bar
            dataKey="value"
            radius={[4, 4, 0, 0]}
            isAnimationActive={!reduced}
            className="cursor-pointer"
            onClick={(d: { key?: string }) => d?.key && onPick(d.key)}
          >
            {schedule.map((s) => (
              <Cell key={s.key} fill={TONE[s.tone]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ---------------- Ordering, month by month ---------------- */

/**
 * Ordered against received, on one rupee axis — the same unit, so one scale.
 * A single month is two bars, not a line: a line needs two points to be one.
 */
export function TrendChart({ trend }: { trend: DashboardData['analysis']['trend'] }) {
  const reduced = useReducedMotion()
  if (!trend.length || !trend.some((t) => t.ordered > 0 || t.received > 0)) {
    return <Empty>No orders were raised in this period.</Empty>
  }
  const legend = (
    <Legend
      items={[
        { label: 'Ordered (by order month)', colour: 'var(--viz-1)' },
        { label: 'Received (by receipt month)', colour: 'var(--viz-2)' },
      ]}
    />
  )
  const tip = ({ active, payload, label }: TooltipProps<number, string>) => {
    if (!active || !payload?.length) return null
    const p = payload[0].payload as DashboardData['analysis']['trend'][number]
    return (
      <Tip
        title={String(label)}
        rows={[
          { label: 'Ordered', value: rupees(p.ordered), colour: 'var(--viz-1)' },
          { label: 'Received', value: rupees(p.received), colour: 'var(--viz-2)' },
          { label: 'Orders raised', value: String(p.orders) },
        ]}
      />
    )
  }

  return (
    <>
      {legend}
      <div className="h-64 w-full">
        <ResponsiveContainer>
          {trend.length < 2 ? (
            <BarChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={6}>
              <CartesianGrid stroke={GRID} strokeOpacity={0.6} vertical={false} />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={shortRupees} />
              <Tooltip cursor={{ fill: 'var(--hover-overlay-strong)' }} content={tip} />
              <Bar dataKey="ordered" fill="var(--viz-1)" radius={[4, 4, 0, 0]} barSize={44} isAnimationActive={!reduced} />
              <Bar dataKey="received" fill="var(--viz-2)" radius={[4, 4, 0, 0]} barSize={44} isAnimationActive={!reduced} />
            </BarChart>
          ) : (
            <ComposedChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="poOrderedFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--viz-1)" stopOpacity={0.32} />
                  <stop offset="100%" stopColor="var(--viz-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID} strokeOpacity={0.6} vertical={false} />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={shortRupees} />
              <Tooltip cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '3 3' }} content={tip} />
              <Area
                type="monotone"
                dataKey="ordered"
                stroke="var(--viz-1)"
                strokeWidth={2}
                fill="url(#poOrderedFill)"
                dot={{ r: 3, fill: 'var(--viz-1)', stroke: CARD, strokeWidth: 2 }}
                activeDot={{ r: 5, stroke: CARD, strokeWidth: 2 }}
                isAnimationActive={!reduced}
              />
              <Line
                type="monotone"
                dataKey="received"
                stroke="var(--viz-2)"
                strokeWidth={2}
                dot={{ r: 3, fill: 'var(--viz-2)', stroke: CARD, strokeWidth: 2 }}
                activeDot={{ r: 5, stroke: CARD, strokeWidth: 2 }}
                isAnimationActive={!reduced}
              />
            </ComposedChart>
          )}
        </ResponsiveContainer>
      </div>
    </>
  )
}

/* ---------------- Orders by stage ---------------- */

export function StatusDonut({ mix }: { mix: DashboardData['analysis']['statusMix'] }) {
  const reduced = useReducedMotion()
  const total = mix.reduce((s, m) => s + m.orders, 0)
  if (!total) return <Empty>No orders were raised in this period.</Empty>
  // Draft and Cancelled share the neutral tone; Cancelled is drawn fainter so
  // the two can be told apart, and each carries its name in the legend.
  const colour = (s: string) =>
    s === 'CANCELLED'
      ? 'color-mix(in srgb, var(--tone-neutral) 45%, transparent)'
      : TONE[STATUS_TONE[s] ?? 'neutral']

  return (
    <div className="flex flex-1 flex-col items-center gap-4 sm:flex-row">
      <div className="relative h-44 w-44 shrink-0">
        <ResponsiveContainer>
          <PieChart>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const p = payload[0].payload as DashboardData['analysis']['statusMix'][number]
                return (
                  <Tip
                    title={p.label}
                    rows={[
                      { label: 'Orders', value: `${p.orders} (${Math.round((p.orders / total) * 100)}%)`, colour: colour(p.status) },
                      { label: 'Value', value: rupees(p.value) },
                    ]}
                  />
                )
              }}
            />
            <Pie
              data={mix}
              dataKey="orders"
              nameKey="label"
              innerRadius="64%"
              outerRadius="100%"
              stroke={CARD}
              strokeWidth={2}
              isAnimationActive={!reduced}
            >
              {mix.map((m) => (
                <Cell key={m.status} fill={colour(m.status)} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-foreground text-2xl font-semibold leading-none tabular-nums">{total}</span>
          <span className="text-muted-foreground mt-1 text-[10px] uppercase tracking-wide">orders</span>
        </div>
      </div>
      <ul className="w-full min-w-0 flex-1 space-y-1.5">
        {mix.map((m) => (
          <li key={m.status} className="flex items-baseline gap-2 text-xs">
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: colour(m.status) }} />
            <span className="text-foreground min-w-0 flex-1 truncate">{m.label}</span>
            <span className="text-foreground shrink-0 font-medium tabular-nums">{m.orders}</span>
            <span className="text-muted-foreground w-16 shrink-0 text-right tabular-nums">{shortRupees(m.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ---------------- How long goods take to come ---------------- */

export function LeadTimeChart({ lead, avg }: { lead: DashboardData['analysis']['leadTime']; avg: number | null }) {
  const reduced = useReducedMotion()
  const total = lead.reduce((s, l) => s + l.orders, 0)
  if (!total) {
    return <Empty>No order in this period has had goods in yet, so there is no lead time to measure.</Empty>
  }
  return (
    <>
      <p className="text-muted-foreground mb-2 text-[11px]">
        {plural(total, 'order')} with goods in · average{' '}
        <span className="text-foreground font-semibold">{avg == null ? '—' : plural(Math.round(avg), 'day')}</span>
      </p>
      <div className="h-48 w-full">
        <ResponsiveContainer>
          <BarChart data={lead} margin={{ top: 4, right: 4, left: -18, bottom: 12 }} barCategoryGap="12%">
            <CartesianGrid stroke={GRID} strokeOpacity={0.6} vertical={false} />
            <XAxis
              dataKey="label"
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              label={{ value: 'days from order to first delivery', position: 'insideBottom', offset: -8, fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
            />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip
              cursor={{ fill: 'var(--hover-overlay-strong)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const p = payload[0].payload as DashboardData['analysis']['leadTime'][number]
                return <Tip title={`${p.label} days`} rows={[{ label: 'Orders', value: String(p.orders), colour: 'var(--viz-1)' }]} />
              }}
            />
            <Bar dataKey="orders" fill="var(--viz-1)" radius={[4, 4, 0, 0]} isAnimationActive={!reduced} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}

/* ---------------- Delivered on time, supplier by supplier ---------------- */

export function OnTimeChart({ rows }: { rows: DashboardData['analysis']['onTimeBySupplier'] }) {
  const reduced = useReducedMotion()
  if (!rows.length) {
    return (
      <Empty>
        No delivery in this period came in against an order with a wanted-by date, so on-time can&rsquo;t be
        measured. Give each order a date when you raise it.
      </Empty>
    )
  }
  const data = rows.map((r) => ({ ...r, short: r.name.length > 18 ? `${r.name.slice(0, 17)}…` : r.name }))
  return (
    <>
      <Legend
        items={[
          { label: 'On time', colour: 'var(--viz-1)' },
          { label: 'Late', colour: 'var(--tone-bad)' },
        ]}
      />
      <div className="w-full" style={{ height: Math.max(120, data.length * 34 + 16) }}>
        <ResponsiveContainer>
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }} barCategoryGap="28%">
            <CartesianGrid stroke={GRID} strokeOpacity={0.6} horizontal={false} />
            <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <YAxis type="category" dataKey="short" tick={AXIS} tickLine={false} axisLine={false} width={116} />
            <Tooltip
              cursor={{ fill: 'var(--hover-overlay-strong)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const p = payload[0].payload as (typeof data)[number]
                const n = p.onTime + p.late
                return (
                  <Tip
                    title={p.name}
                    rows={[
                      { label: 'On time', value: String(p.onTime), colour: 'var(--viz-1)' },
                      { label: 'Late', value: String(p.late), colour: 'var(--tone-bad)' },
                      { label: 'On-time rate', value: pct(n ? p.onTime / n : null) },
                    ]}
                  />
                )
              }}
            />
            <Bar dataKey="onTime" stackId="d" fill="var(--viz-1)" isAnimationActive={!reduced} />
            <Bar dataKey="late" stackId="d" fill="var(--tone-bad)" radius={[0, 4, 4, 0]} isAnimationActive={!reduced} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}

/* ---------------- Which suppliers are fast, and which are reliable ---------------- */

/**
 * Speed across, reliability up, size by value.
 *
 * The lines are a 90% on-time target and the median lead time, which cut the
 * plot into four corners with a plain-words name each — the chart exists to
 * say which corner a supplier sits in, so it says it.
 */
export function SupplierQuadrant({
  rows,
  onPick,
}: {
  rows: DashboardData['analysis']['supplierQuadrant']
  onPick: (id: string) => void
}) {
  const reduced = useReducedMotion()
  if (!rows.length) {
    return (
      <Empty>
        Needs at least one supplier with a delivery against a dated order. It fills in as orders are
        given wanted-by dates and goods come in.
      </Empty>
    )
  }
  const leads = [...rows.map((r) => r.avgLead)].sort((a, b) => a - b)
  const median = leads[Math.floor(leads.length / 2)]
  const data = rows.map((r) => ({ ...r, rate: Math.round(r.onTimeRate * 1000) / 10 }))
  const maxLead = Math.max(...leads, 7)

  return (
    <div className="relative h-64 w-full">
      <div className="text-muted-foreground pointer-events-none absolute inset-x-14 top-1 z-10 flex justify-between text-[10px] font-medium uppercase tracking-wide opacity-70">
        <span>Fast &amp; reliable</span>
        <span>Slow but reliable</span>
      </div>
      <div className="text-muted-foreground pointer-events-none absolute inset-x-14 bottom-7 z-10 flex justify-between text-[10px] font-medium uppercase tracking-wide opacity-70">
        <span>Fast, often late</span>
        <span>Slow and late</span>
      </div>
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 16, right: 12, left: -8, bottom: 12 }}>
          <CartesianGrid stroke={GRID} strokeOpacity={0.5} />
          <XAxis
            type="number"
            dataKey="avgLead"
            name="Lead time"
            domain={[0, Math.ceil(maxLead * 1.15)]}
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            label={{ value: 'average days to first delivery', position: 'insideBottom', offset: -8, fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
          />
          <YAxis
            type="number"
            dataKey="rate"
            name="On time"
            domain={[0, 100]}
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `${v}%`}
          />
          <ZAxis type="number" dataKey="value" range={[90, 900]} />
          <ReferenceLine y={90} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" strokeOpacity={0.7} />
          <ReferenceLine x={median} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" strokeOpacity={0.7} />
          <Tooltip
            cursor={{ strokeDasharray: '3 3' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as (typeof data)[number]
              return (
                <Tip
                  title={p.name}
                  rows={[
                    { label: 'On time', value: `${p.rate}%`, colour: 'var(--viz-1)' },
                    { label: 'Average lead', value: plural(Math.round(p.avgLead), 'day') },
                    { label: 'Ordered', value: rupees(p.value) },
                    { label: 'Deliveries', value: String(p.receipts) },
                  ]}
                />
              )
            }}
          />
          <Scatter
            data={data}
            fill="var(--viz-1)"
            fillOpacity={0.75}
            stroke={CARD}
            strokeWidth={2}
            isAnimationActive={!reduced}
            className="cursor-pointer"
            onClick={(d: { id?: string }) => d?.id && onPick(d.id)}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  )
}
