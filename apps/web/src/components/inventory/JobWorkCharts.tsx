'use client'

import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { ChartTip, EmptyChart, IN_COLOUR, PALETTE, inr, markLabel } from '@/components/dashboard/DashKit'

/**
 * The job work dashboard's charts, from the shared dashboard kit so they match
 * the inventory, ledger and customer material dashboards. Each answers one
 * question a production manager asks about work sent out: what went and came
 * back, what is late, who holds it, how long it has been out, how close it is
 * to the GST limit, and who wastes the most.
 */

const axis = { fontSize: 11, fill: 'currentColor' }
const inrAxis = (v: number) => inr(v).replace('.00', '').replace(/\.(\d)\d /, '.$1 ')
const SENT = '#3b82f6'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Value sent out and value settled back, period by period. The peaks carry their value. */
export function SentBackTrend({
  data,
  onPick,
}: {
  data: Array<{ key: string; label: string; from: string; to: string; sent: number; back: number; challans: number }>
  onPick: (from: string, to: string) => void
}) {
  if (!data.some((d) => d.sent || d.back)) return <EmptyChart h={270} text="Nothing sent in this period." />
  const peak = Math.max(...data.map((d) => Math.max(d.sent, d.back)), 1)
  const top = (k: 'sent' | 'back') =>
    new Set([...data].sort((a, b) => b[k] - a[k]).slice(0, 4).filter((d) => d[k] >= peak * 0.1).map((d) => d.key))
  const topSent = top('sent')
  const topBack = top('back')
  const only = (set: Set<string>, colour: string) => (props: any) =>
    set.has(data[props.index]?.key) ? markLabel(colour, inr)(props) : null
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={270}>
        <ComposedChart
          data={data}
          margin={{ top: 24, right: 4, left: 0, bottom: 0 }}
          onClick={(e: any) => {
            const b = e?.activePayload?.[0]?.payload
            if (b) onPick(b.from, b.to)
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} minTickGap={16} />
          <YAxis tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} width={66} />
          <Tooltip
            content={<ChartTip labelOf={(p: any) => `${p.label} · ${p.challans} ${p.challans === 1 ? 'challan' : 'challans'}`} />}
            cursor={{ fill: 'currentColor', fillOpacity: 0.04 }}
          />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconSize={8} />
          <Bar dataKey="sent" name="Value sent" fill={SENT} radius={[4, 4, 0, 0]} maxBarSize={26} cursor="pointer">
            <LabelList dataKey="sent" content={only(topSent, '#1d4ed8')} />
          </Bar>
          <Bar dataKey="back" name="Value settled back" fill={IN_COLOUR} radius={[4, 4, 0, 0]} maxBarSize={26} cursor="pointer">
            <LabelList dataKey="back" content={only(topBack, '#047857')} />
          </Bar>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

export const DUE_COLOUR: Record<string, string> = {
  overdue: '#f43f5e',
  soon: '#f59e0b',
  ontime: '#10b981',
  nodate: '#94a3b8',
}

/** What is still out, split by where it stands against its due-back date. */
export function DueDonut({
  data,
  picked,
  onPick,
}: {
  data: Array<{ key: string; label: string; value: number; lines: number }>
  picked: string[]
  onPick: (key: string) => void
}) {
  const rows = data.filter((d) => d.lines > 0)
  const total = rows.reduce((t, d) => t + d.value, 0)
  const lines = rows.reduce((t, d) => t + d.lines, 0)
  if (!lines) return <EmptyChart h={260} text="Nothing is out at the moment." />
  return (
    <div>
      <div className="relative">
        <ResponsiveContainer width="100%" height={196}>
          <PieChart>
            <Pie
              data={rows}
              dataKey={total ? 'value' : 'lines'}
              nameKey="label"
              innerRadius="64%"
              outerRadius="94%"
              paddingAngle={2}
              stroke="none"
              isAnimationActive={false}
              cursor="pointer"
              onClick={(d: any) => onPick(d.key)}
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
              {rows.map((d) => (
                <Cell key={d.key} fill={DUE_COLOUR[d.key]} fillOpacity={picked.length && !picked.includes(d.key) ? 0.25 : 1} />
              ))}
            </Pie>
            <Tooltip content={<ChartTip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums text-foreground">{inr(total)}</span>
          <span className="text-[11px] text-muted-foreground">still out</span>
        </div>
      </div>
      <div className="mt-3 divide-y divide-border/60">
        {rows.map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => onPick(d.key)}
            className={`flex w-full items-center gap-2 px-1 py-1.5 text-xs transition-colors hover:text-primary ${picked.includes(d.key) ? 'font-semibold' : ''}`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: DUE_COLOUR[d.key] }} />
            <span className="flex-1 truncate text-left text-foreground">{d.label}</span>
            <span className="text-muted-foreground">{d.lines} lines</span>
            <span className="w-16 text-right font-semibold tabular-nums text-foreground">{inr(d.value)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** A name on one line, cut short to fit, never wrapped onto a second. */
function OneLineTick({ x, y, payload }: any) {
  const v = String(payload?.value ?? '')
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fontSize={11} fill="currentColor">
      <title>{v}</title>
      {v.length > 18 ? `${v.slice(0, 17)}…` : v}
    </text>
  )
}

/** Each job worker's share of what is out: on time and late stacked, the total at the end. */
export function WorkerBars({
  data,
  picked,
  onPick,
}: {
  data: Array<{ id: string; name: string; onTime: number; late: number; lines: number }>
  picked: string[]
  onPick: (id: string) => void
}) {
  if (!data.length) return <EmptyChart h={240} text="Nothing is out at the moment." />
  const rows = data.slice(0, 8).map((d) => ({ ...d, tag: `${inr(d.onTime + d.late)} · ${d.lines} ln` }))
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={Math.max(180, rows.length * 38 + 40)}>
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 0, right: 92, left: 0, bottom: 0 }}
          onClick={(e: any) => {
            const g = e?.activePayload?.[0]?.payload
            if (g) onPick(g.id)
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} horizontal={false} />
          <XAxis type="number" tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} />
          <YAxis type="category" dataKey="name" tick={<OneLineTick />} tickLine={false} axisLine={false} width={124} />
          <Tooltip content={<ChartTip />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
          <Bar dataKey="onTime" name="Not yet due" stackId="w" fill="#0d9488" barSize={18} cursor="pointer">
            {rows.map((r) => (
              <Cell key={r.id} fillOpacity={picked.length && !picked.includes(r.id) ? 0.3 : 1} />
            ))}
          </Bar>
          <Bar dataKey="late" name="Overdue" stackId="w" fill="#f43f5e" radius={[0, 4, 4, 0]} barSize={18} cursor="pointer">
            {rows.map((r) => (
              <Cell key={r.id} fillOpacity={picked.length && !picked.includes(r.id) ? 0.3 : 1} />
            ))}
            <LabelList
              dataKey="tag"
              content={(p: any) => (
                <text x={Number(p.x) + Number(p.width) + 6} y={Number(p.y) + Number(p.height) / 2} dominantBaseline="central" fontSize={10} fontWeight={600} fill="currentColor">
                  {p.value}
                </text>
              )}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

const AGE_COLOURS = ['#10b981', '#84cc16', '#f59e0b', '#f97316', '#f43f5e']

/** Value still out by how many days it has been out; the number of lines inside each bar. */
export function DaysOutBars({ data }: { data: Array<{ key: string; label: string; value: number; lines: number }> }) {
  if (!data.some((d) => d.lines)) return <EmptyChart h={250} text="Nothing is out at the moment." />
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={data} margin={{ top: 22, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis dataKey="key" tick={axis} tickLine={false} axisLine={false} />
          <YAxis tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} width={64} />
          <Tooltip content={<ChartTip labelOf={(p: any) => `${p.label} out · ${p.lines} lines`} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Bar dataKey="value" name="Value" radius={[6, 6, 0, 0]} maxBarSize={44}>
            {data.map((d, n) => (
              <Cell key={d.key} fill={AGE_COLOURS[n]} />
            ))}
            <LabelList dataKey="value" content={markLabel('currentColor', inr)} />
            <LabelList dataKey="lines" content={markLabel('#fff', (v) => `${v} ln`, { inside: true })} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** What each kind of work takes, by value sent: a full pie, the share on each slice. */
export function ProcessPie({
  data,
  picked,
  onPick,
}: {
  data: Array<{ value: string; label: string; amount: number; challans: number }>
  picked: string[]
  onPick: (v: string) => void
}) {
  const total = data.reduce((t, d) => t + d.amount, 0)
  if (!data.length) return <EmptyChart h={250} />
  const key = total ? 'amount' : 'challans'
  return (
    <div>
      <ResponsiveContainer width="100%" height={190}>
        <PieChart>
          <Pie
            data={data}
            dataKey={key}
            nameKey="label"
            outerRadius="92%"
            stroke="hsl(var(--card))"
            strokeWidth={2}
            isAnimationActive={false}
            cursor="pointer"
            onClick={(d: any) => onPick(d.value)}
            labelLine={false}
            label={(p: any) => {
              if (p.percent < 0.08) return null
              const r = p.outerRadius * 0.62
              const a = (-p.midAngle * Math.PI) / 180
              return (
                <text x={p.cx + r * Math.cos(a)} y={p.cy + r * Math.sin(a)} fill="#fff" fontSize={10} fontWeight={600} textAnchor="middle" dominantBaseline="central">
                  {Math.round(p.percent * 100)}%
                </text>
              )
            }}
          >
            {data.map((d, n) => (
              <Cell key={d.value} fill={PALETTE[n % PALETTE.length]} fillOpacity={picked.length && !picked.includes(d.value) ? 0.3 : 1} />
            ))}
          </Pie>
          <Tooltip content={<ChartTip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="mt-3 divide-y divide-border/60">
        {data.slice(0, 6).map((d, n) => (
          <button
            key={d.value}
            type="button"
            onClick={() => onPick(d.value)}
            className={`flex w-full items-center gap-2 px-1 py-1.5 text-xs transition-colors hover:text-primary ${picked.includes(d.value) ? 'font-semibold' : ''}`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PALETTE[n % PALETTE.length] }} />
            <span className="flex-1 truncate text-left capitalize text-foreground">{d.label}</span>
            <span className="text-muted-foreground">{d.challans} ch.</span>
            <span className="w-16 text-right font-semibold tabular-nums text-foreground">{inr(d.amount)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The GST clock: inputs sent for job work must come back within a year of the
 * challan, or the goods count as supplied on the day they left. One bar per
 * challan still out, filled by how much of the year has gone.
 */
export function GstClock({
  data,
}: {
  data: Array<{ challanId: string; challanNumber: string; jobWorkerName: string; daysGone: number; daysLeft: number; value: number }>
}) {
  if (!data.length) return <EmptyChart h={230} text="Nothing is out, so no clock is running." />
  return (
    <div className="space-y-3">
      {data.slice(0, 7).map((d) => {
        const pct = Math.min(100, Math.max(2, (d.daysGone / 365) * 100))
        const colour = d.daysLeft < 0 ? '#f43f5e' : d.daysLeft <= 60 ? '#f59e0b' : '#10b981'
        return (
          <div key={d.challanId}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 truncate">
                <span className="font-mono text-foreground">{d.challanNumber}</span>
                <span className="text-muted-foreground"> · {d.jobWorkerName}</span>
              </span>
              <span className="shrink-0 font-semibold tabular-nums" style={{ color: colour }}>
                {d.daysLeft < 0 ? `${-d.daysLeft} days past` : `${d.daysLeft} days left`}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: colour }} />
            </div>
          </div>
        )
      })}
      {data.length > 7 && <p className="text-[11px] text-muted-foreground">and {data.length - 7} more with longer left</p>}
    </div>
  )
}

/** Waste as a share of what each job worker settled, as columns with the % on top. */
export function WasteColumns({ data }: { data: Array<{ id: string; name: string; pct: number; wasteValue: number }> }) {
  if (!data.length) return <EmptyChart h={250} text="Nothing has come back yet." />
  const rows = data.slice(0, 8)
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={rows} margin={{ top: 22, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis dataKey="name" tick={axis} tickLine={false} axisLine={false} interval={0} tickFormatter={(v: string) => v.split(' ')[0]} />
          <YAxis tick={axis} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} width={40} />
          <Tooltip content={<ChartTip money={false} labelOf={(p: any) => `${p.name} · ${inr(p.wasteValue)} wasted`} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Bar dataKey="pct" name="Waste %" radius={[6, 6, 0, 0]} maxBarSize={40}>
            {rows.map((d) => (
              <Cell key={d.id} fill={d.pct > 5 ? '#f43f5e' : d.pct > 2 ? '#f59e0b' : '#10b981'} />
            ))}
            <LabelList dataKey="pct" content={markLabel('currentColor', (v) => `${v.toFixed(1)}%`)} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
