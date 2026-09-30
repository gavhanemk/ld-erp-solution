'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { PALETTE, TONE, inr, qtyFmt } from '@/components/dashboard/DashKit'

/**
 * The purchase dashboard's lists — what to chase, who to buy from, what it
 * costs — in the same card as its charts, so the page ends in tables that
 * read like the rest of it.
 */

type Qty = Array<{ uom: string; qty: number }>

export interface OrderBrief {
  id: string
  poNumber: string
  supplier: string
  poDate: string
  deliveryDate: string | null
  ordered: number
  pending: number
  receivedPct: number | null
}

export interface PurchaseDashboard {
  asOf: string
  period: { from: string | null; to: string | null; bucket: 'day' | 'week' | 'month' }
  options: { suppliers: Array<{ id: string; name: string }>; categories: Array<{ id: string; name: string }> }
  now: {
    kpis: {
      openOrders: number
      openValue: number
      overdueOrders: number
      overdueValue: number
      dueThisWeek: number
      dueThisWeekValue: number
      drafts: number
      draftValue: number
      noDate: number
      unbilledOrders: number
      unbilledValue: number
      indentLines: number
      indentItems: number
    }
    schedule: Array<{ key: string; label: string; hint?: string; tone: string; orders: number; value: number }>
    pipeline: Array<{ status: string; label: string; orders: number; value: number }>
    overdue: Array<OrderBrief & { daysLate: number }>
    dueSoon: Array<OrderBrief & { dueIn: number }>
    drafts: Array<OrderBrief & { ageDays: number }>
    unbilled: Array<OrderBrief & { unbilled: number; sinceReceipt: number }>
  }
  analysis: {
    kpis: {
      orders: number
      ordersChange: number | null
      value: number
      valueChange: number | null
      suppliers: number
      onTime: number
      late: number
      onTimeRate: number | null
      avgLead: number | null
      received: number
      billed: number
      paid: number
      cancelled: number
    }
    trend: Array<{ key: string; label: string; ordered: number; received: number; orders: number }>
    statusMix: Array<{ status: string; label: string; orders: number; value: number }>
    suppliers: Array<{ id: string; name: string; value: number; orders: number }>
    scorecard: Array<{
      id: string
      name: string
      value: number
      orders: number
      share: number | null
      onTime: number
      late: number
      onTimeRate: number | null
      avgLead: number | null
      open: number
      unbilled: number
    }>
    units: Array<{ uom: string; orderedQty: number; receivedQty: number; value: number; items: number; lines: number }>
    breakdown: {
      categories: Array<{ id: string; name: string; value: number; lines: number; items: number; share: number; qty: Qty; children?: Array<{ name: string; value: number; lines: number; items: number; share: number; qty: Qty }> }>
      departments: Array<{ name: string; value: number; lines: number; items: number; share: number; qty: Qty; children?: Array<{ name: string; value: number; lines: number; items: number; share: number; qty: Qty }> }>
    }
    topItems: Array<{ id: string; name: string; uom: string; value: number; qty: number; orders: number }>
    priceWatch: Array<{
      id: string
      name: string
      uom: string
      buys: number
      avgRate: number
      minRate: number
      maxRate: number
      latestRate: number
      latestPo: string
      latestDate: string
      change: number | null
    }>
    leadTime: Array<{ label: string; orders: number }>
  }
}

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const rate = (v: number) => `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const shortDate = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'

/* ---------------- Orders to chase ---------------- */

export type ChaseTab = 'overdue' | 'dueSoon' | 'drafts' | 'unbilled'

/** The tabs for the chase list, as a small segmented switch for the card's header. */
export function ChaseTabs({ now, tab, onTab }: { now: PurchaseDashboard['now']; tab: ChaseTab; onTab: (t: ChaseTab) => void }) {
  const tabs: Array<{ key: ChaseTab; label: string; count: number; hint: string }> = [
    { key: 'overdue', label: 'Late', count: now.kpis.overdueOrders, hint: 'Past the wanted-by date' },
    { key: 'dueSoon', label: 'Due soon', count: now.dueSoon.length, hint: 'Due in the next 14 days' },
    { key: 'drafts', label: 'Not sent', count: now.kpis.drafts, hint: 'Still in draft' },
    { key: 'unbilled', label: 'Not billed', count: now.kpis.unbilledOrders, hint: 'Goods in, no supplier bill yet' },
  ]
  return (
    <div className="flex max-w-full overflow-x-auto rounded-lg border border-border bg-secondary p-0.5 text-xs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={tab === t.key}
          title={t.hint}
          onClick={() => onTab(t.key)}
          className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 font-medium transition-colors ${
            tab === t.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t.label} <span className="tabular-nums opacity-70">{t.count}</span>
        </button>
      ))}
    </div>
  )
}

/** The orders behind the chosen tab, each opening the order list at that order. */
export function ChaseList({ now, tab }: { now: PurchaseDashboard['now']; tab: ChaseTab }) {
  type Row = { o: OrderBrief; badge: string; tone: string; amount: number; amountLabel: string }
  const rows: Row[] =
    tab === 'overdue'
      ? now.overdue.map((o) => ({ o, badge: `${plural(o.daysLate, 'day')} late`, tone: TONE.rose, amount: o.pending, amountLabel: 'still due' }))
      : tab === 'dueSoon'
        ? now.dueSoon.map((o) => ({
            o,
            badge: o.dueIn === 0 ? 'due today' : `due ${shortDate(o.deliveryDate)} · in ${plural(o.dueIn, 'day')}`,
            tone: o.dueIn <= 7 ? TONE.amber : TONE.blue,
            amount: o.pending,
            amountLabel: 'still due',
          }))
        : tab === 'drafts'
          ? now.drafts.map((o) => ({
              o,
              badge: o.ageDays === 0 ? 'drafted today' : `drafted ${plural(o.ageDays, 'day')} ago`,
              tone: '#94a3b8',
              amount: o.ordered,
              amountLabel: 'order value',
            }))
          : now.unbilled.map((o) => ({
              o,
              badge: o.sinceReceipt === 0 ? 'goods in today' : `goods in ${plural(o.sinceReceipt, 'day')} ago`,
              tone: o.sinceReceipt > 15 ? TONE.rose : TONE.amber,
              amount: o.unbilled,
              amountLabel: 'not billed',
            }))

  if (!rows.length) {
    const empty: Record<ChaseTab, string> = {
      overdue:
        now.kpis.noDate > 0
          ? `Nothing is past its wanted-by date. ${plural(now.kpis.noDate, 'open order has', 'open orders have')} no date, though, and can never show here.`
          : 'Nothing is past its wanted-by date.',
      dueSoon: 'No open order is due in the next two weeks.',
      drafts: 'Every order raised has been sent to its supplier.',
      unbilled: 'Every delivery that has come in has its supplier’s bill booked.',
    }
    return <p className="py-10 text-center text-sm text-muted-foreground">{empty[tab]}</p>
  }

  return (
    <div className="divide-y divide-border/60">
      {rows.map(({ o, badge, tone, amount, amountLabel }) => (
        <Link
          key={o.id}
          href={`/purchase/orders?q=${encodeURIComponent(o.poNumber)}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 text-xs transition-colors hover:text-primary"
        >
          <span className="min-w-0 flex-1 basis-40">
            <span className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-primary">{o.poNumber}</span>
              <span className="rounded-full px-2 py-px text-[10px] font-semibold" style={{ color: tone, background: `${tone}1f` }}>
                {badge}
              </span>
            </span>
            <span className="block truncate text-foreground">{o.supplier}</span>
          </span>
          <span className="flex shrink-0 items-center gap-4">
            <span className="w-24" title={`${pct(o.receivedPct)} of the order received`}>
              <span className="flex justify-between text-[10px] text-muted-foreground">
                <span>received</span>
                <span className="tabular-nums">{pct(o.receivedPct)}</span>
              </span>
              <span className="mt-1 block h-1.5 rounded-full bg-secondary">
                <span className="block h-1.5 rounded-full" style={{ width: `${Math.max(2, (o.receivedPct ?? 0) * 100)}%`, background: TONE.emerald }} />
              </span>
            </span>
            <span className="w-20 text-right">
              <span className="block font-semibold tabular-nums text-foreground">{inr(amount)}</span>
              <span className="text-[10px] text-muted-foreground">{amountLabel}</span>
            </span>
          </span>
        </Link>
      ))}
    </div>
  )
}

/* ---------------- Price watch ---------------- */

/**
 * The rate an item was last bought at against the rate it usually costs. A
 * rise is written as a rise — an arrow and the word, not only a colour.
 */
export function PriceWatchList({ rows }: { rows: PurchaseDashboard['analysis']['priceWatch'] }) {
  if (!rows.length)
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No item was bought more than once in this period. Pick a longer period to compare rates.
      </p>
    )
  return (
    <div className="divide-y divide-border/60">
      {rows.map((r) => {
        const c = r.change ?? 0
        const tone = c >= 0.05 ? TONE.rose : c > 0.005 ? TONE.amber : c < -0.005 ? TONE.emerald : '#94a3b8'
        const unit = r.uom ? `/${r.uom}` : ''
        const span = r.maxRate - r.minRate
        const at = span > 0 ? (r.latestRate - r.minRate) / span : 0.5
        return (
          <div key={r.id} className="py-2.5 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-foreground">{r.name}</span>
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-px text-[10px] font-semibold tabular-nums"
                style={{ color: tone, background: `${tone}1f` }}
              >
                {c > 0.005 ? <ArrowUpRight size={11} /> : c < -0.005 ? <ArrowDownRight size={11} /> : null}
                {Math.abs(c) <= 0.005 ? 'same as usual' : `${Math.round(Math.abs(c) * 100)}% ${c > 0 ? 'dearer' : 'cheaper'}`}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
              <span>
                last <span className="font-semibold text-foreground">{rate(r.latestRate)}{unit}</span> · usual {rate(r.avgRate)}
              </span>
              <span className="ml-auto">{rate(r.minRate)}</span>
              <span className="relative h-1.5 w-16 shrink-0 rounded-full bg-secondary" title="Where the last buy sits between the cheapest and dearest of the period">
                <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card" style={{ left: `${at * 100}%`, background: tone }} />
              </span>
              <span>{rate(r.maxRate)}</span>
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {plural(r.buys, 'buy')} · last on {r.latestPo}, {shortDate(r.latestDate)}
            </p>
          </div>
        )
      })}
    </div>
  )
}

/* ---------------- Supplier scorecard ---------------- */

type ScoreKey = 'name' | 'orders' | 'value' | 'onTimeRate' | 'avgLead' | 'open' | 'unbilled'

/**
 * Every supplier on one sheet, sortable by any column: ordering, reliability
 * and what is outstanding, side by side. A row narrows the page to them.
 */
export function SupplierScorecard({
  rows,
  active,
  onPick,
}: {
  rows: PurchaseDashboard['analysis']['scorecard']
  active: string
  onPick: (id: string) => void
}) {
  const [sort, setSort] = useState<{ key: ScoreKey; desc: boolean }>({ key: 'value', desc: true })
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const x = a[sort.key]
        const y = b[sort.key]
        if (x == null) return 1
        if (y == null) return -1
        const c = typeof x === 'string' ? x.localeCompare(String(y)) : Number(x) - Number(y)
        return sort.desc ? -c : c
      }),
    [rows, sort],
  )
  if (!rows.length) return <p className="py-10 text-center text-sm text-muted-foreground">No supplier has an order in this period or anything outstanding.</p>
  const max = Math.max(...rows.map((r) => r.value), 1)
  const Head = ({ k, children, right }: { k: ScoreKey; children: React.ReactNode; right?: boolean }) => (
    <th className={`px-2 py-2 font-medium ${right ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => setSort((s) => ({ key: k, desc: s.key === k ? !s.desc : k !== 'name' }))}
        className={`uppercase tracking-wide hover:text-foreground ${sort.key === k ? 'text-foreground' : ''}`}
      >
        {children} {sort.key === k ? (sort.desc ? '↓' : '↑') : ''}
      </button>
    </th>
  )
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
            <Head k="name">Supplier</Head>
            <Head k="orders" right>
              Orders
            </Head>
            <Head k="value">Ordered in period</Head>
            <Head k="onTimeRate" right>
              On time
            </Head>
            <Head k="avgLead" right>
              Days to deliver
            </Head>
            <Head k="open" right>
              Still to arrive
            </Head>
            <Head k="unbilled" right>
              Not billed
            </Head>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const tone = r.onTimeRate == null ? null : r.onTimeRate >= 0.9 ? TONE.emerald : r.onTimeRate >= 0.7 ? TONE.amber : TONE.rose
            return (
              <tr
                key={r.id}
                onClick={() => onPick(r.id)}
                title={active === r.id ? 'Showing only this supplier — click to show everyone' : 'Show only this supplier'}
                className={`cursor-pointer border-b border-border/60 hover:bg-secondary/50 ${active === r.id ? 'bg-secondary/60' : ''}`}
              >
                <td className="max-w-[14rem] truncate py-2.5 pr-2 font-medium text-foreground">{r.name}</td>
                <td className="px-2 text-right tabular-nums">{r.orders || '—'}</td>
                <td className="px-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-20 shrink-0 rounded-full bg-secondary">
                      <div className="h-1.5 rounded-full" style={{ width: `${r.value ? Math.max(3, (r.value / max) * 100) : 0}%`, background: PALETTE[0] }} />
                    </div>
                    <span className="font-semibold tabular-nums">{r.value ? inr(r.value) : '—'}</span>
                    {r.share != null && r.value > 0 && <span className="text-xs tabular-nums text-muted-foreground">{pct(r.share)}</span>}
                  </div>
                </td>
                <td className="px-2 text-right">
                  {tone ? (
                    <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums" style={{ color: tone, background: `${tone}1f` }} title={`${r.onTime} on time, ${r.late} late`}>
                      {pct(r.onTimeRate)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-2 text-right tabular-nums">{r.avgLead == null ? '—' : Math.round(r.avgLead)}</td>
                <td className="px-2 text-right tabular-nums">{r.open ? inr(r.open) : '—'}</td>
                <td className="px-2 text-right tabular-nums" style={r.unbilled ? { color: TONE.amber } : undefined}>
                  {r.unbilled ? inr(r.unbilled) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ---------------- Most-ordered items ---------------- */

/** The items that took the money: quantity in its own unit, the orders, the value and its share. */
export function TopItemsTable({ rows, total }: { rows: PurchaseDashboard['analysis']['topItems']; total: number }) {
  if (!rows.length) return <p className="py-10 text-center text-sm text-muted-foreground">Nothing was ordered in this period.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-2 font-medium">Item</th>
            <th className="px-2 py-2 text-right font-medium">Quantity</th>
            <th className="px-2 py-2 text-right font-medium">Orders</th>
            <th className="px-2 py-2 text-right font-medium">Value</th>
            <th className="w-36 py-2 pl-2 font-medium">Share of value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const share = total ? Math.round((r.value / total) * 100) : 0
            return (
              <tr key={r.id} className="border-b border-border/60">
                <td className="max-w-[16rem] truncate py-2.5 pr-2 text-foreground">{r.name}</td>
                <td className="px-2 text-right">
                  <span className="whitespace-nowrap rounded-md bg-secondary px-1.5 py-0.5 text-[11px] tabular-nums text-foreground">
                    {qtyFmt(r.qty)} <span className="text-muted-foreground">{r.uom}</span>
                  </span>
                </td>
                <td className="px-2 text-right tabular-nums text-muted-foreground">{r.orders}</td>
                <td className="px-2 text-right font-semibold tabular-nums">{inr(r.value)}</td>
                <td className="py-2.5 pl-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-secondary">
                      <div className="h-1.5 rounded-full" style={{ width: `${share}%`, background: PALETTE[0] }} />
                    </div>
                    <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{share}%</span>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
