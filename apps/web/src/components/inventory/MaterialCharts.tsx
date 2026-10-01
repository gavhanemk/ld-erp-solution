'use client'

import { Fragment, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { ChartTip, EmptyChart, PALETTE, TONE, markLabel, qtyFmt } from '@/components/dashboard/DashKit'

/**
 * The customer material dashboard's charts, drawn the way the purchase and
 * inventory dashboards draw theirs: bars with their figures on them, a donut
 * with its legend as a list of figures, numbered step bars, unit tiles and a
 * breakdown table. Customer material carries no value to us, so everything is
 * counted in lines and in each item's own unit — never in rupees.
 */

export { PALETTE }

const axis = { fontSize: 11, fill: 'currentColor' }
const GRID = { strokeDasharray: '3 3', stroke: 'currentColor', strokeOpacity: 0.15 }

export type UnitQty = Array<{ uom: string; qty: number }>
/** "5,000 mtr · 1,800 pcs", the biggest first, at most `max` units. */
export const unitLine = (q: UnitQty, max = 2) => {
  const parts = [...q].filter((x) => x.qty > 0).sort((a, b) => b.qty - a.qty)
  if (!parts.length) return '—'
  const shown = parts.slice(0, max).map((x) => `${qtyFmt(x.qty)} ${x.uom}`).join(' · ')
  return parts.length > max ? `${shown} +${parts.length - max}` : shown
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const Tip = (props: any) => <ChartTip {...props} money={false} />

/**
 * Lines received and lines returned in each day, week or month, as bars side
 * by side with the count on each. A click on a period narrows the page to it.
 */
export function MaterialFlow({
  data,
  onPick,
}: {
  data: Array<{ key: string; label: string; from: string; to: string; received: number; returned: number; receipts: number }>
  onPick: (from: string, to: string) => void
}) {
  if (!data.some((d) => d.received || d.returned)) return <EmptyChart h={270} text="Nothing came in or went back in this period." />
  const busy = data.filter((d) => d.received || d.returned).length
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
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
          <Tooltip content={<Tip />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconSize={8} />
          <Bar dataKey="received" name="Items received" fill={PALETTE[0]} radius={[4, 4, 0, 0]} maxBarSize={28} cursor="pointer">
            {busy <= 24 && <LabelList dataKey="received" content={markLabel('#0f766e', (v) => (Number(v) ? `${v}` : ''))} />}
          </Bar>
          <Bar dataKey="returned" name="Items returned" fill={TONE.violet} radius={[4, 4, 0, 0]} maxBarSize={28} cursor="pointer">
            {busy <= 24 && <LabelList dataKey="returned" content={markLabel('#6d28d9', (v) => (Number(v) ? `${v}` : ''))} />}
          </Bar>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** What of each customer's is with us now: share of lines on each slice, the list below carries the figures. */
export function HeldDonut({
  data,
  picked,
  onPick,
}: {
  data: Array<{ id: string; name: string; lines: number; qty: UnitQty }>
  picked: string[]
  onPick: (id: string) => void
}) {
  const total = data.reduce((t, d) => t + d.lines, 0)
  if (!total) return <EmptyChart h={260} text="No customer material in our stores." />
  return (
    <div>
      <div className="relative">
        <ResponsiveContainer width="100%" height={196}>
          <PieChart>
            <Pie
              data={data}
              dataKey="lines"
              nameKey="name"
              innerRadius="64%"
              outerRadius="94%"
              // One slice is a whole ring: a gap would show as a seam.
              paddingAngle={data.length > 1 ? 2 : 0}
              stroke="none"
              isAnimationActive={false}
              cursor="pointer"
              onClick={(d: any) => onPick(d.id)}
              labelLine={false}
              label={(p: any) => {
                if (p.percent < 0.07 || data.length === 1) return null
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
                <Cell key={d.id} fill={PALETTE[n % PALETTE.length]} fillOpacity={picked.length && !picked.includes(d.id) ? 0.25 : 1} />
              ))}
            </Pie>
            <Tooltip content={<Tip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums text-foreground">{total}</span>
          <span className="text-[11px] text-muted-foreground">
            {total === 1 ? 'item' : 'items'} · {data.length} {data.length === 1 ? 'customer' : 'customers'}
          </span>
        </div>
      </div>
      <div className="mt-3 divide-y divide-border/60">
        {data.map((d, n) => (
          <button
            key={d.id}
            type="button"
            onClick={() => onPick(d.id)}
            className={`flex w-full items-center gap-2 px-1 py-1.5 text-xs transition-colors hover:text-primary ${picked.includes(d.id) ? 'font-semibold' : ''}`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PALETTE[n % PALETTE.length] }} />
            <span className="flex-1 truncate text-left text-foreground">{d.name}</span>
            <span className="text-muted-foreground">
              {d.lines} {d.lines === 1 ? 'item' : 'items'}
            </span>
            <span className="w-10 text-right tabular-nums text-muted-foreground">{Math.round((d.lines / total) * 100)}%</span>
            <span className="w-28 truncate text-right font-semibold tabular-nums text-foreground">{unitLine(d.qty, 1)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * One tile per unit — metres with metres, pieces with pieces: how much of
 * customers' material is here now, and what came in and went back in the period.
 */
export function HeldUnitTiles({
  data,
}: {
  data: Array<{ uom: string; held: number; items: number; received: number; returned: number }>
}) {
  if (!data.length) return <EmptyChart h={160} text="No customer material in our stores." />
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {data.map((u, n) => {
        const moved = u.held + u.returned
        const back = moved ? (u.returned / moved) * 100 : 0
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
            <p className="mt-2 text-lg font-semibold tabular-nums text-foreground">{qtyFmt(u.held)}</p>
            <p className="text-[11px] text-muted-foreground">still with us</p>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1 flex-1 rounded-full bg-secondary">
                <div className="h-1 rounded-full" style={{ width: `${back}%`, background: TONE.violet }} />
              </div>
              <span className="text-[10px] tabular-nums text-muted-foreground">{Math.round(back)}% back</span>
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {qtyFmt(u.received)} received · {qtyFmt(u.returned)} returned
            </p>
          </div>
        )
      })}
    </div>
  )
}

/** Numbered steps with a bar each, the way the purchase dashboard shows its pipeline. A step can filter the page. */
export function CheckSteps({
  steps,
}: {
  steps: Array<{ label: string; value: string; sub?: string; share: number; colour: string; onClick?: () => void; active?: boolean }>
}) {
  return (
    <div className="space-y-3.5">
      {steps.map((s, i) => {
        const body = (
          <>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ background: s.colour }}>
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 text-left">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className={`text-foreground ${s.active ? 'font-semibold' : ''}`}>{s.label}</span>
                <span className="text-sm font-semibold tabular-nums text-foreground">{s.value}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-secondary">
                <div className="h-1.5 rounded-full transition-all" style={{ width: `${Math.max(s.share ? 2 : 0, Math.min(100, s.share))}%`, background: s.colour }} />
              </div>
              {s.sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{s.sub}</p>}
            </div>
          </>
        )
        return s.onClick ? (
          <button key={s.label} type="button" onClick={s.onClick} className="flex w-full items-center gap-3 rounded-lg transition-colors hover:bg-secondary/50">
            {body}
          </button>
        ) : (
          <div key={s.label} className="flex items-center gap-3">
            {body}
          </div>
        )
      })}
    </div>
  )
}

export interface MaterialBreakRow {
  name: string
  items: number
  lines: number
  received: UnitQty
  held: UnitQty
  share: number
  children?: MaterialBreakRow[]
}

/**
 * Category and sub-category, or department and category: items, receipt
 * lines, quantity received and still here, unit by unit, and share of lines.
 * A row opens to show what is in it — the same table the purchase and
 * inventory dashboards use, counted in quantity rather than value.
 */
export function MaterialBreakdown({ categories, departments }: { categories: MaterialBreakRow[]; departments: MaterialBreakRow[] }) {
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
  const qtyCell = (q: UnitQty) =>
    q.length ? (
      <div className="flex flex-wrap justify-end gap-1">
        {q.map((x) => (
          <span key={x.uom} className="whitespace-nowrap rounded-md bg-secondary px-1.5 py-0.5 text-[11px] tabular-nums text-foreground">
            {qtyFmt(x.qty)} <span className="text-muted-foreground">{x.uom}</span>
          </span>
        ))}
      </div>
    ) : (
      <div className="text-right text-muted-foreground">—</div>
    )
  if (!rows.length) return <EmptyChart h={160} text="Nothing received in this period." />
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
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-2 font-medium">{by === 'category' ? 'Category' : 'Department'}</th>
              <th className="px-2 py-2 text-right font-medium">Items</th>
              <th className="px-2 py-2 text-right font-medium">Lines</th>
              <th className="px-2 py-2 text-right font-medium">Quantity received</th>
              <th className="px-2 py-2 text-right font-medium">Still with us</th>
              <th className="w-40 py-2 pl-2 font-medium">Share of lines</th>
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
                    <td className="px-2">{qtyCell(r.received)}</td>
                    <td className="px-2">{qtyCell(r.held)}</td>
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
                        <td className="px-2">{qtyCell(c.received)}</td>
                        <td className="px-2">{qtyCell(c.held)}</td>
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

/** A ranking as horizontal bars, its figure at the end of each. A bar filters the page. */
export function RankBars({
  data,
  picked,
  onPick,
  name,
  empty,
}: {
  data: Array<{ id: string; name: string; value: number; tag: string }>
  picked: string[]
  onPick: (id: string) => void
  /** What the bar counts, for the tooltip. */
  name: string
  empty: string
}) {
  if (!data.length) return <EmptyChart h={200} text={empty} />
  const rows = data.slice(0, 8).map((d) => ({ ...d, short: d.name.length > 18 ? `${d.name.slice(0, 17)}…` : d.name }))
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={Math.max(150, rows.length * 34 + 20)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 110, left: 0, bottom: 0 }}>
          <CartesianGrid {...GRID} horizontal={false} />
          <XAxis type="number" tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="short" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} width={112} interval={0} />
          <Tooltip content={<Tip labelOf={(p: any) => p.name} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Bar dataKey="value" name={name} radius={[0, 4, 4, 0]} barSize={14} cursor="pointer" onClick={(d: any) => d?.id && onPick(d.id)}>
            {rows.map((d) => (
              <Cell key={d.id} fill={PALETTE[0]} fillOpacity={picked.length && !picked.includes(d.id) ? 0.3 : 1} />
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

/** Stores side by side: items received in the period and items there now, every store named. */
export function StoreBars({
  data,
  picked,
  onPick,
}: {
  data: Array<{ id: string; name: string; received: number; held: number }>
  picked: string[]
  onPick: (id: string) => void
}) {
  if (!data.length) return <EmptyChart h={200} text="Nothing in any store." />
  const rows = data.map((d) => ({ ...d, short: d.name.length > 18 ? `${d.name.slice(0, 17)}…` : d.name }))
  const pick = (d: any) => d?.id && onPick(d.id)
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={Math.max(170, rows.length * 52 + 40)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid {...GRID} horizontal={false} />
          <XAxis type="number" tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="short" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} width={112} interval={0} />
          <Tooltip content={<Tip labelOf={(p: any) => p.name} />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} iconSize={8} />
          <Bar dataKey="received" name="Items received" fill={PALETTE[0]} radius={[0, 4, 4, 0]} barSize={12} cursor="pointer" onClick={pick}>
            {rows.map((d) => (
              <Cell key={d.id} fillOpacity={picked.length && !picked.includes(d.id) ? 0.3 : 1} />
            ))}
            <LabelList dataKey="received" position="right" fontSize={10} fontWeight={600} fill="#0f766e" formatter={(v: unknown) => (Number(v) ? String(v) : '')} />
          </Bar>
          <Bar dataKey="held" name="Still here" fill={TONE.violet} radius={[0, 4, 4, 0]} barSize={12} cursor="pointer" onClick={pick}>
            {rows.map((d) => (
              <Cell key={d.id} fillOpacity={picked.length && !picked.includes(d.id) ? 0.3 : 1} />
            ))}
            <LabelList dataKey="held" position="right" fontSize={10} fontWeight={600} fill="#6d28d9" formatter={(v: unknown) => (Number(v) ? String(v) : '')} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Items still here by how long since they last moved: the older, the warmer the colour. */
export function AgeBars({ data }: { data: Array<{ key: string; label: string; lines: number }> }) {
  if (!data.some((d) => d.lines)) return <EmptyChart h={200} text="No customer material in our stores." />
  const colours = [TONE.emerald, TONE.teal, TONE.amber, TONE.orange, TONE.rose]
  return (
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={210}>
        <BarChart data={data} margin={{ top: 20, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" tick={{ ...axis, fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
          <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
          <Tooltip content={<Tip />} cursor={{ fill: 'currentColor', fillOpacity: 0.04 }} />
          <Bar dataKey="lines" name="Items" radius={[4, 4, 0, 0]} maxBarSize={36}>
            {data.map((d, i) => (
              <Cell key={d.key} fill={colours[i % colours.length]} />
            ))}
            <LabelList dataKey="lines" position="top" fontSize={10} fontWeight={600} fill="currentColor" formatter={(v: unknown) => (Number(v) ? String(v) : '')} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
