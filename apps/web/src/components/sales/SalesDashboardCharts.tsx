'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line, Pie, PieChart,
  PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, RadialBar, RadialBarChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { ArrowDown, ArrowUp, ArrowUpRight } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { ChartTip, EmptyChart, PALETTE, TONE, inr, markLabel } from '@/components/dashboard/DashKit'
import { TONE_OF } from '@/components/purchase/PurchaseDashboardCharts'

/**
 * The sales dashboard's charts and lists, each a different kind for a
 * different question, built from the shared dashboard kit so the page reads
 * as one family with the purchase and inventory dashboards. Axis text takes
 * the surrounding colour through currentColor, for light and dark alike.
 */

export interface SalesDashboard {
  period: { from: string; to: string; days: number; bucket: 'day' | 'week' | 'month' }
  options: { brands: Array<{ id: string; name: string; type: string }>; customers: Array<{ id: string; name: string }> }
  kpis: {
    booked: { value: number; orders: number; pieces: number; change: number | null; avgOrder: number }
    dispatched: { pieces: number; value: number; challans: number }
    invoiced: { value: number; withGst: number; invoices: number; credited: number; change: number | null }
    collected: { value: number; receipts: number; change: number | null; rate: number | null }
    onTime: { onTime: number; late: number; rate: number | null }
  }
  analysis: {
    trend: Array<{ key: string; label: string; booked: number; invoiced: number; collected: number; orders: number }>
    customers: Array<{ id: string; name: string; value: number; orders: number }>
    brandMix: Array<{ name: string; value: number; orders: number }>
    salespeople: Array<{ name: string; value: number; orders: number }>
    brokers: Array<{ name: string; value: number; orders: number }>
    styleTree: Array<{ id: string; name: string; value: number; children: Array<{ name: string; value: number }> }>
    topStyles: Array<{ style: string; name: string; color: string; pieces: number; value: number; orders: number; rate: number; share: number }>
    sizes: Array<{ label: string; pieces: number }>
    pipeline: { quoted: number; booked: number; dispatched: number; invoiced: number; collected: number }
    quotes: {
      made: number
      value: number
      drafts: number
      waiting: { count: number; value: number }
      won: { count: number; value: number }
      lost: { count: number; value: number }
      expired: { count: number; value: number }
      winRate: number | null
      reasons: Array<{ reason: string; count: number }>
    }
    scorecard: Array<{
      id: string
      name: string
      orders: number
      booked: number
      invoiced: number
      collected: number
      owed: number
      overdue: number
      creditLimit: number | null
      creditUsed: number | null
      lastOrder: string | null
    }>
  }
  now: {
    book: { orders: number; pieces: number; value: number; byStatus: Array<{ key: string; label: string; orders: number; value: number }> }
    schedule: Array<{ key: string; label: string; hint: string; tone: string; orders: number; pieces: number; value: number }>
    receivables: {
      value: number
      invoices: number
      overdue: { value: number; invoices: number }
      ageing: Array<{ key: string; label: string; tone: string; invoices: number; value: number }>
    }
    lists: {
      late: OpenOrder[]
      dueSoon: OpenOrder[]
      overdue: Array<{ id: string; invoiceNumber: string; customer: string; customerId: string; dueDate: string | null; balance: number; days: number }>
      toBill: Array<{ id: string; dcNumber: string; dcDate: string; soNumber: string; customer: string; pieces: number }>
      quotes: Array<{ id: string; quoteNumber: string; customer: string; validUntil: string | null; value: number; expired: boolean }>
      hold: Array<{ id: string; soNumber: string; customer: string; value: number; since: string | null }>
    }
    counts: Record<ActTab, number>
  }
}

interface OpenOrder {
  id: string
  soNumber: string
  status: string
  customer: string
  deliveryDate: string | null
  pending: number
  value: number
}

const axis = { fontSize: 11, fill: 'currentColor' }
const inrAxis = (v: number) => inr(v).replace(/\.(\d)\d /, '.$1 ')
const GRID = { strokeDasharray: '3 3', stroke: 'currentColor', strokeOpacity: 0.15 }
const pcs = (n: number) => n.toLocaleString('en-IN')

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The change on the period before, as a small arrow and percent. */
export function Change({ value, good = 'up' }: { value: number | null; good?: 'up' | 'down' }) {
  if (value == null) return null
  const up = value >= 0
  const fine = good === 'up' ? up : !up
  const Icon = up ? ArrowUp : ArrowDown
  return (
    <span className="inline-flex items-center gap-0.5 font-medium" style={{ color: fine ? TONE.emerald : TONE.rose }}>
      <Icon size={11} />
      {Math.abs(Math.round(value * 100))}%
    </span>
  )
}

/**
 * Booked and invoiced as soft areas, collected as a line over them, and the
 * number of orders as faint bars behind. Values are labelled only on the
 * biggest few booked buckets, so labels never sit on one another.
 */
export function SalesTrendChart({ data }: { data: SalesDashboard['analysis']['trend'] }) {
  if (!data.some((d) => d.booked || d.invoiced || d.collected)) return <EmptyChart h={280} text="No orders, invoices or receipts in this period." />
  const peak = Math.max(...data.map((d) => d.booked), 1)
  const top = new Set(
    [...data]
      .sort((a, b) => b.booked - a.booked)
      .slice(0, 3)
      .filter((d) => d.booked >= peak * 0.15)
      .map((d) => d.key),
  )
  const onlyTop = (props: any) => (top.has(data[props.index]?.key) ? markLabel('#0f766e', inr)(props) : null)
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={data} margin={{ top: 24, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="sdBooked" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={PALETTE[0]} stopOpacity={0.35} />
              <stop offset="100%" stopColor={PALETTE[0]} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="sdInvoiced" x1="0" y1="0" x2="0" y2="1">
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
          <Bar isAnimationActive={false} yAxisId="n" dataKey="orders" name="Orders count" fill={TONE.violet} fillOpacity={0.2} radius={[4, 4, 0, 0]} maxBarSize={18} />
          <Area isAnimationActive={false} yAxisId="v" type="monotone" dataKey="booked" name="Booked" stroke={PALETTE[0]} strokeWidth={2} fill="url(#sdBooked)">
            <LabelList dataKey="booked" content={onlyTop} />
          </Area>
          <Area isAnimationActive={false} yAxisId="v" type="monotone" dataKey="invoiced" name="Invoiced" stroke={PALETTE[1]} strokeWidth={2} fill="url(#sdInvoiced)" />
          <Line isAnimationActive={false} yAxisId="v" type="monotone" dataKey="collected" name="Collected" stroke={TONE.emerald} strokeWidth={2.5} dot={false} strokeDasharray="5 3" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** What customers owe by how late it is, green to red; the count of invoices sits inside each bar. */
export function AgeingBars({ data, onPick }: { data: SalesDashboard['now']['receivables']['ageing']; onPick?: (key: string) => void }) {
  if (!data.some((d) => d.value)) return <EmptyChart h={240} text="Nothing is owed. Every invoice is paid." />
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 22, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
          <YAxis tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} width={62} />
          <Tooltip content={<ChartTip labelOf={(p: any) => `${p.label} · ${p.invoices} ${p.invoices === 1 ? 'invoice' : 'invoices'}`} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Bar isAnimationActive={false} dataKey="value" name="Owed" radius={[6, 6, 0, 0]} maxBarSize={44} cursor={onPick ? 'pointer' : undefined} onClick={(d: any) => d?.key && onPick?.(d.key)}>
            {data.map((d, i) => (
              <Cell key={d.key} fill={TONE_OF[d.tone] ?? PALETTE[0]} fillOpacity={i === data.length - 1 ? 1 : 0.85} />
            ))}
            <LabelList dataKey="value" content={markLabel('currentColor', inr)} />
            <LabelList dataKey="invoices" content={markLabel('#fff', (v) => `${v}`, { inside: true })} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Pieces ordered in each size, round a radar — the shape of the size curve. Bars when there are too few sizes for a shape. */
export function SizeMix({ data }: { data: SalesDashboard['analysis']['sizes'] }) {
  const total = data.reduce((s, d) => s + d.pieces, 0)
  if (!total) return <EmptyChart h={260} text="No orders by size in this period." />
  const rows = data.map((d) => ({ ...d, share: Math.round((d.pieces / total) * 100) }))
  return (
    <div className="text-muted-foreground">
      {rows.length < 3 ? (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rows} margin={{ top: 20 }}>
            <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
            <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={36} />
            <Tooltip content={<ChartTip money={false} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
            <Bar isAnimationActive={false} dataKey="pieces" name="Pieces qty" fill={PALETTE[4]} radius={[6, 6, 0, 0]} maxBarSize={48}>
              <LabelList dataKey="pieces" content={markLabel('currentColor', (v) => pcs(v))} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <RadarChart data={rows} outerRadius="70%">
            <PolarGrid stroke="currentColor" strokeOpacity={0.15} />
            <PolarAngleAxis dataKey="label" tick={{ ...axis, fontSize: 11, fontWeight: 600 }} />
            <PolarRadiusAxis tick={false} axisLine={false} />
            <Radar isAnimationActive={false} name="Pieces qty" dataKey="pieces" stroke={PALETTE[4]} fill={PALETTE[4]} fillOpacity={0.3} dot={{ r: 3, fill: PALETTE[4] }} />
            <Tooltip content={<ChartTip money={false} />} />
          </RadarChart>
        </ResponsiveContainer>
      )}
      <div className="mt-2 flex flex-wrap justify-center gap-1.5">
        {rows.map((r) => (
          <span key={r.label} className="bg-secondary text-foreground rounded-md px-2 py-0.5 text-[11px] tabular-nums">
            <b className="font-semibold">{r.label}</b> <span className="text-muted-foreground">{r.share}%</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Quotations of the period: the win rate as a gauge, and beside it where
 * every quotation stands — waiting, won, lost, lapsed — with why they were lost.
 */
export function QuoteFunnel({ q }: { q: SalesDashboard['analysis']['quotes'] }) {
  if (!q.made) return <EmptyChart h={240} text="No quotations made in this period." />
  const rate = q.winRate ?? 0
  const rows = [
    { label: 'Waiting for an answer', ...q.waiting, colour: TONE.blue },
    { label: 'Won — became an order', ...q.won, colour: TONE.emerald },
    { label: 'Lost', ...q.lost, colour: TONE.rose },
    { label: 'Lapsed unanswered', ...q.expired, colour: TONE.amber },
  ]
  return (
    <div>
      <div className="flex items-center gap-4">
        <div className="relative h-[120px] w-[120px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <RadialBarChart innerRadius="74%" outerRadius="100%" data={[{ v: rate, fill: rate >= 50 ? TONE.emerald : rate >= 25 ? TONE.amber : TONE.rose }]} startAngle={90} endAngle={-270}>
              <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
              <RadialBar dataKey="v" cornerRadius={8} background={{ fill: 'currentColor', fillOpacity: 0.08 } as any} isAnimationActive={false} />
            </RadialBarChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-foreground text-xl font-semibold tabular-nums">{q.winRate == null ? '—' : `${rate}%`}</span>
            <span className="text-muted-foreground text-[10px]">win rate</span>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-semibold tabular-nums">{inr(q.value)}</p>
          <p className="text-muted-foreground text-[11px]">
            quoted on {q.made} {q.made === 1 ? 'quotation' : 'quotations'}
            {q.drafts ? ` · ${q.drafts} still drafts` : ''}
          </p>
          <p className="text-muted-foreground mt-1.5 text-[11px]">
            Won <b className="text-foreground">{inr(q.won.value)}</b> · lost <b className="text-foreground">{inr(q.lost.value)}</b>
          </p>
        </div>
      </div>
      <div className="mt-4 space-y-2">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="flex justify-between gap-2 text-xs">
              <span className="text-foreground">{r.label}</span>
              <span className="text-muted-foreground tabular-nums">
                <b className="text-foreground">{r.count}</b> · {inr(r.value)}
              </span>
            </div>
            <div className="bg-secondary mt-1 h-1.5 rounded-full">
              <div className="h-1.5 rounded-full" style={{ width: `${q.made ? Math.max(r.count ? 3 : 0, (r.count / q.made) * 100) : 0}%`, background: r.colour }} />
            </div>
          </div>
        ))}
      </div>
      {q.reasons.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="text-muted-foreground text-[11px]">Lost on:</span>
          {q.reasons.map((r) => (
            <span key={r.reason} className="rounded-md px-1.5 py-0.5 text-[11px]" style={{ background: `${TONE.rose}18`, color: TONE.rose }}>
              {r.reason} · {r.count}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Each brand's share of the orders booked, job work apart, as a half ring. */
export function BrandMix({ data }: { data: SalesDashboard['analysis']['brandMix'] }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  if (!total) return <EmptyChart h={240} text="No orders booked in this period." />
  const orders = data.reduce((s, d) => s + d.orders, 0)
  return (
    <div>
      <div className="relative">
        <ResponsiveContainer width="100%" height={150}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="100%" startAngle={180} endAngle={0} innerRadius="120%" outerRadius="190%" paddingAngle={2} stroke="none" isAnimationActive={false}>
              {data.map((d, n) => (
                <Cell key={d.name} fill={d.name === 'Job work' ? TONE.amber : PALETTE[(n * 2) % PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip content={<ChartTip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center">
          <span className="text-foreground text-lg font-semibold tabular-nums">{inr(total)}</span>
          <span className="text-muted-foreground text-[11px]">
            {orders} {orders === 1 ? 'order' : 'orders'}
          </span>
        </div>
      </div>
      <div className="divide-border/60 mt-3 divide-y">
        {data.map((d, n) => (
          <div key={d.name} className="flex items-center gap-2 px-1 py-1.5 text-xs">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.name === 'Job work' ? TONE.amber : PALETTE[(n * 2) % PALETTE.length] }} />
            <span className="text-foreground flex-1 truncate">{d.name}</span>
            <span className="text-muted-foreground">
              {d.orders} {d.orders === 1 ? 'order' : 'orders'}
            </span>
            <span className="text-muted-foreground w-10 text-right tabular-nums">{Math.round((d.value / total) * 100)}%</span>
            <span className="text-foreground w-16 text-right font-semibold tabular-nums">{inr(d.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Orders booked by salesperson, or by broker: a ranking with value and orders at the end of each bar. */
export function PeopleBars({ salespeople, brokers }: { salespeople: SalesDashboard['analysis']['salespeople']; brokers: SalesDashboard['analysis']['brokers'] }) {
  const [by, setBy] = useState<'sales' | 'broker'>('sales')
  const data = (by === 'sales' ? salespeople : brokers).slice(0, 8)
  const rows = data.map((d) => ({ ...d, short: d.name.length > 18 ? `${d.name.slice(0, 17)}…` : d.name, tag: `${inr(d.value)} · ${d.orders}×` }))
  return (
    <div>
      <div className="border-border bg-secondary mb-3 inline-flex rounded-lg border p-0.5 text-xs">
        {(['sales', 'broker'] as const).map((k) => (
          <button key={k} type="button" onClick={() => setBy(k)} className={`rounded-md px-3 py-1 font-medium transition-colors ${by === k ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {k === 'sales' ? 'Salesperson' : 'Broker'}
          </button>
        ))}
      </div>
      {!rows.length ? (
        <EmptyChart h={200} text="No orders booked in this period." />
      ) : (
        <div className="text-muted-foreground">
          <ResponsiveContainer width="100%" height={Math.max(150, rows.length * 34 + 20)}>
            <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 92, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="sdPeople" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor={PALETTE[6]} stopOpacity={0.55} />
                  <stop offset="100%" stopColor={PALETTE[6]} stopOpacity={1} />
                </linearGradient>
              </defs>
              <CartesianGrid {...GRID} horizontal={false} />
              <XAxis type="number" tick={axis} tickLine={false} axisLine={false} tickFormatter={inrAxis} />
              <YAxis type="category" dataKey="short" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} width={110} />
              <Tooltip content={<ChartTip labelOf={(p: any) => `${p.name} · ${p.orders} ${p.orders === 1 ? 'order' : 'orders'}`} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
              <Bar isAnimationActive={false} dataKey="value" name="Booked" fill="url(#sdPeople)" radius={[0, 4, 4, 0]} barSize={14}>
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
      )}
    </div>
  )
}

export type ActTab = 'late' | 'dueSoon' | 'overdue' | 'toBill' | 'quotes' | 'hold'

const ACT_TABS: Array<{ key: ActTab; label: string; tone: string }> = [
  { key: 'late', label: 'Late orders', tone: TONE.rose },
  { key: 'dueSoon', label: 'Due in 2 weeks', tone: TONE.amber },
  { key: 'overdue', label: 'Overdue payments', tone: TONE.rose },
  { key: 'toBill', label: 'Sent, not billed', tone: TONE.violet },
  { key: 'quotes', label: 'Quotes lapsing', tone: TONE.orange },
  { key: 'hold', label: 'Credit hold', tone: TONE.amber },
]

/** The tabs over the to-do list, each with its count. */
export function ActTabs({ counts, tab, onTab }: { counts: Record<ActTab, number>; tab: ActTab; onTab: (t: ActTab) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ACT_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onTab(t.key)}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${tab === t.key ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}
        >
          {t.label}
          <span className="rounded-full px-1.5 text-[10px] font-semibold tabular-nums" style={counts[t.key] ? { background: `${t.tone}20`, color: t.tone } : undefined}>
            {counts[t.key]}
          </span>
        </button>
      ))}
    </div>
  )
}

/** One row of the to-do list: what it is, who for, the figure, and a link to act on it. */
function ActRow({ href, code, who, figure, note, danger }: { href: string; code: string; who: string; figure: string; note: string; danger?: boolean }) {
  return (
    <Link href={href} className="hover:bg-secondary/50 group flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors">
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm">
          <span className="font-mono text-xs">{code}</span> <span className="ml-1">{who}</span>
        </p>
        <p className={`text-[11px] ${danger ? 'text-destructive' : 'text-muted-foreground'}`}>{note}</p>
      </div>
      <span className="text-foreground shrink-0 text-sm font-semibold tabular-nums">{figure}</span>
      <ArrowUpRight size={14} className="text-muted-foreground group-hover:text-primary shrink-0" />
    </Link>
  )
}

const EMPTY: Record<ActTab, string> = {
  late: 'No order is past its delivery date.',
  dueSoon: 'Nothing is due in the next two weeks.',
  overdue: 'No invoice is past its due date.',
  toBill: 'Every challan sent has its invoice.',
  quotes: 'No quotation lapses this week.',
  hold: 'No order is waiting on a credit release.',
}

export function ActList({ lists, counts, tab }: { lists: SalesDashboard['now']['lists']; counts: Record<ActTab, number>; tab: ActTab }) {
  const rows: React.ReactNode[] =
    tab === 'late' || tab === 'dueSoon'
      ? lists[tab].map((o) => (
          <ActRow
            key={o.id}
            href={`/sales/challan?dispatch=${o.id}`}
            code={o.soNumber}
            who={o.customer}
            figure={inr(o.value)}
            note={`${pcs(o.pending)} pcs to send · due ${o.deliveryDate ? formatDate(o.deliveryDate) : '—'}`}
            danger={tab === 'late'}
          />
        ))
      : tab === 'overdue'
        ? lists.overdue.map((i) => (
            <ActRow key={i.id} href={`/sales/payments?receive=${i.customerId}&invoice=${i.id}`} code={i.invoiceNumber} who={i.customer} figure={inr(i.balance)} note={`${i.days} ${i.days === 1 ? 'day' : 'days'} past due · record the payment`} danger />
          ))
        : tab === 'toBill'
          ? lists.toBill.map((c) => <ActRow key={c.id} href={`/sales/invoices?create=${c.id}`} code={c.dcNumber} who={c.customer} figure={`${pcs(c.pieces)} pcs`} note={`Sent ${formatDate(c.dcDate)} on ${c.soNumber} · make the invoice`} />)
          : tab === 'quotes'
            ? lists.quotes.map((x) => (
                <ActRow
                  key={x.id}
                  href={`/sales/quotations?q=${encodeURIComponent(x.quoteNumber)}`}
                  code={x.quoteNumber}
                  who={x.customer}
                  figure={inr(x.value)}
                  note={x.expired ? `Lapsed ${x.validUntil ? formatDate(x.validUntil) : ''} · follow up or mark lost` : `Valid until ${x.validUntil ? formatDate(x.validUntil) : '—'} · follow up`}
                  danger={x.expired}
                />
              ))
            : lists.hold.map((o) => (
                <ActRow key={o.id} href={`/sales/orders?q=${encodeURIComponent(o.soNumber)}`} code={o.soNumber} who={o.customer} figure={inr(o.value)} note={`Over the credit limit${o.since ? ` since ${formatDate(o.since)}` : ''} · a manager can release it`} />
              ))
  if (!rows.length) return <p className="text-muted-foreground flex h-40 items-center justify-center text-sm">{EMPTY[tab]}</p>
  return (
    <div>
      <div className="divide-border/60 -mx-2 divide-y">{rows}</div>
      {counts[tab] > rows.length && <p className="text-muted-foreground mt-2 text-center text-[11px]">Showing the first {rows.length} of {counts[tab]}</p>}
    </div>
  )
}

type ScoreKey = 'name' | 'booked' | 'invoiced' | 'collected' | 'owed' | 'overdue' | 'creditUsed' | 'lastOrder'

/** Each customer's period and position today side by side, sortable by any column. A row narrows the page to that customer. */
export function CustomerScorecard({ rows, active, onPick }: { rows: SalesDashboard['analysis']['scorecard']; active: string; onPick: (id: string) => void }) {
  const [sort, setSort] = useState<{ key: ScoreKey; desc: boolean }>({ key: 'booked', desc: true })
  const sorted = useMemo(() => {
    const val = (r: (typeof rows)[number]) => (sort.key === 'name' ? r.name : sort.key === 'lastOrder' ? (r.lastOrder ?? '') : (r[sort.key] ?? -1))
    return [...rows].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : (x as number) - (y as number)
      return sort.desc ? -c : c
    })
  }, [rows, sort])
  if (!rows.length) return <EmptyChart h={160} text="No customer activity in this period." />
  const head = (key: ScoreKey, label: string, right = true) => (
    <th className={`px-2 py-2 font-medium ${right ? 'text-right' : 'text-left'}`}>
      <button type="button" className="hover:text-foreground uppercase" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}>
        {label}
        {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  )
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-border text-muted-foreground border-b text-[11px] tracking-wide">
            {head('name', 'Customer', false)}
            {head('booked', 'Booked')}
            {head('invoiced', 'Invoiced')}
            {head('collected', 'Collected')}
            {head('owed', 'Owes now')}
            {head('overdue', 'Overdue')}
            {head('creditUsed', 'Credit used')}
            {head('lastOrder', 'Last order')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const used = r.creditUsed ?? 0
            const tone = used >= 100 ? TONE.rose : used >= 80 ? TONE.amber : TONE.emerald
            return (
              <tr key={r.id} onClick={() => onPick(r.id)} className={`border-border/60 hover:bg-secondary/50 cursor-pointer border-b ${active === r.id ? 'bg-primary/5' : ''}`} title="Show the dashboard for this customer alone">
                <td className="text-foreground py-2.5 pr-2 font-medium">
                  {r.name}
                  <span className="text-muted-foreground ml-1.5 text-[11px] font-normal">
                    {r.orders} {r.orders === 1 ? 'order' : 'orders'}
                  </span>
                </td>
                <td className="px-2 text-right font-semibold tabular-nums">{r.booked ? inr(r.booked) : '—'}</td>
                <td className="px-2 text-right tabular-nums">{r.invoiced ? inr(r.invoiced) : '—'}</td>
                <td className="px-2 text-right tabular-nums" style={{ color: r.collected ? TONE.emerald : undefined }}>
                  {r.collected ? inr(r.collected) : '—'}
                </td>
                <td className="px-2 text-right tabular-nums">{r.owed ? inr(r.owed) : '—'}</td>
                <td className={`px-2 text-right tabular-nums ${r.overdue ? 'text-destructive font-semibold' : ''}`}>{r.overdue ? inr(r.overdue) : '—'}</td>
                <td className="px-2">
                  {r.creditUsed == null ? (
                    <span className="text-muted-foreground block text-right text-xs">no limit</span>
                  ) : (
                    <div className="flex items-center justify-end gap-2">
                      <div className="bg-secondary h-1.5 w-16 rounded-full">
                        <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, Math.max(used ? 3 : 0, used))}%`, background: tone }} />
                      </div>
                      <span className="w-9 text-right text-xs tabular-nums" style={{ color: tone }}>
                        {used}%
                      </span>
                    </div>
                  )}
                </td>
                <td className="text-muted-foreground px-2 text-right text-xs">{r.lastOrder ? formatDate(r.lastOrder) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** The best-selling styles in each colour: pieces, value, the average rate, and their share. */
export function TopStylesTable({ rows }: { rows: SalesDashboard['analysis']['topStyles'] }) {
  if (!rows.length) return <EmptyChart h={160} text="No orders booked in this period." />
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-sm">
        <thead>
          <tr className="border-border text-muted-foreground border-b text-left text-[11px] uppercase tracking-wide">
            <th className="py-2 pr-2 font-medium">#</th>
            <th className="px-2 py-2 font-medium">Style</th>
            <th className="px-2 py-2 font-medium">Colour</th>
            <th className="px-2 py-2 text-right font-medium">Pieces</th>
            <th className="px-2 py-2 text-right font-medium">Avg rate</th>
            <th className="px-2 py-2 text-right font-medium">Value</th>
            <th className="w-36 py-2 pl-2 font-medium">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, n) => (
            <tr key={`${r.style}|${r.color}`} className="border-border/60 border-b">
              <td className="py-2.5 pr-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: PALETTE[n % PALETTE.length] }}>
                  {n + 1}
                </span>
              </td>
              <td className="px-2">
                <p className="text-foreground font-mono text-xs">{r.style}</p>
                <p className="text-muted-foreground max-w-[16rem] truncate text-[11px]">{r.name}</p>
              </td>
              <td className="px-2">
                <span className="bg-secondary text-foreground rounded-md px-1.5 py-0.5 text-[11px]">{r.color}</span>
              </td>
              <td className="px-2 text-right tabular-nums">{pcs(r.pieces)}</td>
              <td className="text-muted-foreground px-2 text-right tabular-nums">₹{r.rate.toLocaleString('en-IN')}</td>
              <td className="px-2 text-right font-semibold tabular-nums">{inr(r.value)}</td>
              <td className="py-2.5 pl-2">
                <div className="flex items-center gap-2">
                  <div className="bg-secondary h-1.5 flex-1 rounded-full">
                    <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, r.share)}%`, background: PALETTE[n % PALETTE.length] }} />
                  </div>
                  <span className="text-muted-foreground w-10 text-right text-xs tabular-nums">{r.share}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
