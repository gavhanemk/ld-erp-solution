'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, ArrowDownRight, ArrowUpRight, Inbox, Lightbulb } from 'lucide-react'
import {
  RAMP,
  STATUS_TONE,
  TONE,
  pct,
  plural,
  rupees,
  shortDate,
  shortRupees,
  type DashboardData,
  type OrderBrief,
  type Tone,
} from './model'

/*
 * The pieces the dashboard is built from that are not charts: tiles, cards,
 * lists and the heat map. Drawn in the same idiom as the reports' dashboard —
 * a glass card, a coloured rail only where the colour means something, a
 * hairline rule over each band — so the two screens read as one system.
 */

/** A heading with a hairline running off it, over each band of the page. */
export function SectionRule({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <h2 className="text-foreground shrink-0 text-xs font-semibold uppercase tracking-wider">
        {children}
      </h2>
      {note && <span className="text-muted-foreground text-[11px]">{note}</span>}
      <span className="bg-border hidden h-px min-w-8 flex-1 sm:block" aria-hidden />
    </div>
  )
}

/** A chart's frame: the question it answers, then the answer. */
export function ChartCard({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string
  subtitle?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`glass-card flex min-w-0 flex-col p-4 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-foreground text-sm font-semibold">{title}</h3>
          {subtitle && (
            <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      <div className="mt-3 flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  )
}

/**
 * Says why a chart is empty, in words. An empty frame is indistinguishable
 * from a broken one, and "no data" does not tell anybody what to do about it.
 */
export function Empty({ children, compact }: { children: React.ReactNode; compact?: boolean }) {
  return (
    <div
      className={`text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 text-center text-xs leading-snug ${compact ? 'py-5' : 'py-10'}`}
    >
      <Inbox size={18} className="opacity-60" />
      <p className="max-w-xs">{children}</p>
    </div>
  )
}

/**
 * A headline figure.
 *
 * The rail carries the tone, and only a tone: an untoned tile gets the measure
 * colour, so red and amber stand out because nothing else on the row is red
 * or amber. The change against the previous period is written in ink, not
 * green or red — ordering more is not good or bad by itself.
 */
export function KpiTile({
  label,
  value,
  num,
  format,
  basis,
  tone,
  change,
  progress,
  icon,
  spark,
  onClick,
  actionHint,
}: {
  label: string
  /** The figure as text — used as is when there is no `num` to count up to. */
  value?: string
  /** The figure as a number, counted up to when it arrives. */
  num?: number
  format?: (n: number) => string
  basis?: string
  tone?: Tone
  change?: number | null
  progress?: number | null
  icon?: React.ReactNode
  /** A small trend under the figure — the month-by-month values behind it. */
  spark?: number[]
  /** A tile that leads somewhere is a button, and says where on hover. */
  onClick?: () => void
  actionHint?: string
}) {
  const counted = useCountUp(num ?? 0)
  const shown = num != null ? (format ? format(counted) : String(Math.round(counted))) : (value ?? '—')
  const colour = tone ? TONE[tone] : 'var(--viz-1)'
  const Tag = onClick ? 'button' : 'div'

  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={actionHint}
      className={`glass-card group relative min-w-0 overflow-hidden p-3 pl-4 text-left ${
        onClick
          ? 'focus-visible:ring-primary cursor-pointer transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2'
          : ''
      }`}
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: colour }} aria-hidden />
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground truncate text-[11px] font-medium uppercase tracking-wide">
          {label}
        </p>
        {icon && (
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
            style={{ color: colour, background: `color-mix(in srgb, ${colour} 14%, transparent)` }}
          >
            {icon}
          </span>
        )}
      </div>
      <p
        className="mt-1 text-2xl font-semibold leading-none tabular-nums"
        style={tone && tone !== 'neutral' && tone !== 'normal' ? { color: TONE[tone] } : undefined}
      >
        {shown}
      </p>
      {spark && spark.length > 1 && <Sparkline values={spark} className="mt-2 h-7" />}
      {progress != null && (
        <div className="bg-secondary mt-2 h-1.5 w-full overflow-hidden rounded-full">
          <div
            className="h-full rounded-full transition-[width] duration-700"
            style={{ width: `${Math.min(100, Math.max(2, progress * 100))}%`, background: 'var(--viz-1)' }}
          />
        </div>
      )}
      <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-snug">
        {change != null && (
          <span className="text-foreground inline-flex items-center gap-0.5 font-medium tabular-nums">
            {change >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
            {Math.abs(Math.round(change * 100))}%
          </span>
        )}
        {basis && <span>{basis}</span>}
      </div>
      {onClick && (
        <ArrowRight
          size={13}
          className="text-muted-foreground absolute bottom-3 right-3 opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      )}
    </Tag>
  )
}

/**
 * Counts up to a figure when it arrives or changes, so a new period reads as a
 * change rather than a swap. Straight to the figure for anyone who has asked
 * their system for less motion.
 */
function useCountUp(target: number, ms = 650) {
  const [n, setN] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || from.current === target) {
      from.current = target
      setN(target)
      return
    }
    const start = performance.now()
    const a = from.current
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms)
      const eased = 1 - Math.pow(1 - k, 3)
      setN(a + (target - a) * eased)
      if (k < 1) raf = requestAnimationFrame(step)
      else from.current = target
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return n
}

/**
 * A trend line with no axes — the shape of the months behind a figure. The
 * last point is marked, because "where is it now" is what the eye looks for.
 */
export function Sparkline({ values, className = '' }: { values: number[]; className?: string }) {
  const W = 100
  const H = 24
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const x = (i: number) => (i / (values.length - 1)) * W
  const y = (v: number) => H - 2 - ((v - min) / (max - min || 1)) * (H - 4)
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ')
  const id = useId().replace(/:/g, '')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`w-full ${className}`} aria-hidden>
      <defs>
        <linearGradient id={`spark${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--viz-1)" stopOpacity={0.3} />
          <stop offset="100%" stopColor="var(--viz-1)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#spark${id})`} />
      <path d={line} fill="none" stroke="var(--viz-1)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={1.8} fill="var(--viz-1)" />
    </svg>
  )
}

/* ---------------- The summary band at the top ---------------- */

/**
 * The page's entry point: the one number for the period, how it moved, its
 * shape month by month, and the three sums somebody has to act on — beside
 * the findings in sentences. Everything under it is detail on these.
 */
export function Hero({
  data,
  periodText,
  onJump,
}: {
  data: DashboardData
  periodText: string
  onJump: (target: 'overdue' | 'unbilled' | 'open') => void
}) {
  const a = data.analysis
  const n = data.now.kpis
  const value = useCountUp(a.kpis.value)
  const spark = a.trend.map((t) => t.ordered)

  const stats: Array<{ key: 'open' | 'overdue' | 'unbilled'; label: string; value: number; sub: string; tone: Tone }> = [
    { key: 'open', label: 'To arrive', value: n.openValue, sub: plural(n.openOrders, 'open order'), tone: 'info' },
    {
      key: 'overdue',
      label: 'Late',
      value: n.overdueValue,
      sub: n.overdueOrders ? plural(n.overdueOrders, 'order') : 'nothing late',
      tone: n.overdueOrders ? 'bad' : 'good',
    },
    {
      key: 'unbilled',
      label: 'Not billed',
      value: n.unbilledValue,
      sub: n.unbilledOrders ? plural(n.unbilledOrders, 'order') : 'all billed',
      tone: n.unbilledOrders ? 'warn' : 'good',
    },
  ]

  return (
    <section className="glass-card relative overflow-hidden p-0">
      {/* A wash of the measure colour from the top corner — the only gradient
        on the page, spent on the one band that is meant to be looked at first. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.10]"
        style={{ background: 'radial-gradient(48rem 18rem at 0% 0%, var(--viz-1), transparent 70%)' }}
        aria-hidden
      />
      <div className="relative grid gap-0 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="border-border p-4 sm:p-5 lg:border-r">
          <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
            Ordered · {periodText}
          </p>
          <div className="mt-1.5 flex flex-wrap items-end gap-x-3 gap-y-1">
            <p className="text-foreground text-4xl font-semibold leading-none tracking-tight tabular-nums sm:text-5xl">
              {shortRupees(value)}
            </p>
            {a.kpis.valueChange != null && (
              <span
                className="mb-1 inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums"
                style={{ background: 'var(--hover-overlay-strong)' }}
                title="Against the same length of time just before"
              >
                {a.kpis.valueChange >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                {Math.abs(Math.round(a.kpis.valueChange * 100))}% on the period before
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-1.5 text-xs">
            {plural(a.kpis.orders, 'order')} from {plural(a.kpis.suppliers, 'supplier')} · before GST
          </p>
          {spark.length > 1 && <Sparkline values={spark} className="mt-3 h-12" />}

          <div className="mt-4 grid grid-cols-3 gap-2">
            {stats.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => onJump(s.key)}
                className="border-border bg-card/60 hover:bg-[var(--hover-overlay-strong)] focus-visible:ring-primary min-w-0 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2"
              >
                <p className="text-muted-foreground flex items-center gap-1.5 truncate text-[10px] font-medium uppercase tracking-wide">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TONE[s.tone] }} />
                  {s.label}
                </p>
                <p className="text-foreground mt-1 truncate text-base font-semibold tabular-nums sm:text-lg">
                  {shortRupees(s.value)}
                </p>
                <p className="text-muted-foreground truncate text-[10px]">{s.sub}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="border-border border-t p-4 sm:p-5 lg:border-t-0">
          <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
            <Lightbulb size={15} className="text-primary" />
            What the figures say
          </h3>
          {a.insights.length ? (
            <ul className="mt-3 space-y-2.5">
              {a.insights.map((l) => (
                <li key={l} className="text-foreground flex gap-2.5 text-[13px] leading-snug">
                  <span className="bg-primary mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full" />
                  {l}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground mt-3 text-sm">
              Nothing stands out — no late orders, no unbilled goods, no supplier carrying the book on its own.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

/** The three views, as tabs a thumb can reach. */
export function ViewTabs({
  views,
  view,
  onView,
}: {
  views: Array<{ key: string; label: string; hint: string; count?: number }>
  view: string
  onView: (v: string) => void
}) {
  return (
    <div className="border-border flex gap-1 overflow-x-auto border-b" role="tablist">
      {views.map((v) => (
        <button
          key={v.key}
          role="tab"
          aria-selected={view === v.key}
          title={v.hint}
          onClick={() => onView(v.key)}
          className={`-mb-px shrink-0 border-b-2 px-3.5 pb-2.5 pt-1 text-sm font-medium transition-colors ${
            view === v.key
              ? 'border-primary text-foreground'
              : 'text-muted-foreground hover:text-foreground border-transparent'
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  )
}

/* ---------------- The action centre: what somebody should do today ---------------- */

export type ActionTab = 'overdue' | 'dueSoon' | 'drafts' | 'unbilled'

function OrderRow({
  o,
  badge,
  badgeTone,
  amount,
  amountLabel,
}: {
  o: OrderBrief
  badge: string
  badgeTone: Tone
  /** The figure this list is about, where it is not what is still due. */
  amount?: number
  amountLabel?: string
}) {
  return (
    <li>
      <Link
        href={`/purchase/orders?q=${encodeURIComponent(o.poNumber)}`}
        className="hover:bg-[var(--hover-overlay)] group flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 transition-colors"
      >
        <div className="min-w-0 flex-1 basis-40">
          <p className="text-foreground flex items-center gap-2 text-sm font-medium">
            <span className="font-mono text-[13px]">{o.poNumber}</span>
            <span
              className="rounded-full px-2 py-px text-[10px] font-semibold"
              style={{
                color: TONE[badgeTone],
                background: `color-mix(in srgb, ${TONE[badgeTone]} 14%, transparent)`,
              }}
            >
              {badge}
            </span>
          </p>
          <p className="text-muted-foreground truncate text-xs">{o.supplier}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="w-24" title={`${pct(o.receivedPct)} of the order received`}>
            <div className="text-muted-foreground flex justify-between text-[10px]">
              <span>Received</span>
              <span className="tabular-nums">{pct(o.receivedPct)}</span>
            </div>
            <div className="bg-secondary mt-1 h-1.5 overflow-hidden rounded-full">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(2, (o.receivedPct ?? 0) * 100)}%`, background: 'var(--viz-1)' }}
              />
            </div>
          </div>
          <div className="w-20 text-right">
            <p className="text-foreground text-sm font-semibold tabular-nums">
              {shortRupees(amount ?? (o.pending || o.ordered))}
            </p>
            <p className="text-muted-foreground text-[10px]">
              {amountLabel ?? (o.pending ? 'still due' : 'order value')}
            </p>
          </div>
          <ArrowRight
            size={14}
            className="text-muted-foreground hidden opacity-0 transition-opacity group-hover:opacity-100 sm:block"
          />
        </div>
      </Link>
    </li>
  )
}

export function ActionCentre({
  now,
  tab,
  onTab,
}: {
  now: DashboardData['now']
  tab: ActionTab
  onTab: (t: ActionTab) => void
}) {
  const tabs: Array<{ key: ActionTab; label: string; hint: string; count: number; tone: Tone }> = [
    { key: 'overdue', label: 'Late', hint: 'Past the wanted-by date', count: now.kpis.overdueOrders, tone: 'bad' },
    { key: 'dueSoon', label: 'Due soon', hint: 'Due in the next 14 days', count: now.dueSoon.length, tone: 'warn' },
    { key: 'drafts', label: 'Not sent', hint: 'Still in draft', count: now.kpis.drafts, tone: 'neutral' },
    { key: 'unbilled', label: 'Not billed', hint: 'Goods in, no supplier bill yet', count: now.kpis.unbilledOrders, tone: 'warn' },
  ]

  // On a phone the tabs scroll sideways; keep the chosen one in sight by
  // moving the row, never the page.
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = strip.current
    const el = row?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)
    if (!row || !el) return
    if (el.offsetLeft < row.scrollLeft || el.offsetLeft + el.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = el.offsetLeft - 8
    }
  }, [tab])

  return (
    <section id="orders-to-chase" className="glass-card flex min-w-0 scroll-mt-4 flex-col overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center justify-between gap-x-2 border-b px-4 pt-3">
        <h3 className="text-foreground pb-2 text-sm font-semibold">Orders to chase</h3>
        <div ref={strip} className="relative -mb-px flex max-w-full gap-0.5 overflow-x-auto" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              data-tab={t.key}
              role="tab"
              title={t.hint}
              aria-selected={tab === t.key}
              onClick={() => onTab(t.key)}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2 pb-2 text-xs font-medium transition-colors ${
                tab === t.key
                  ? 'border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground border-transparent'
              }`}
            >
              {t.label}
              <span
                className="rounded-full px-1.5 text-[10px] font-semibold tabular-nums"
                style={
                  t.count > 0 && t.tone !== 'neutral'
                    ? { color: TONE[t.tone], background: `color-mix(in srgb, ${TONE[t.tone]} 14%, transparent)` }
                    : undefined
                }
              >
                {t.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="max-h-[22rem] min-h-[12rem] flex-1 overflow-y-auto">
        {tab === 'overdue' &&
          (now.overdue.length ? (
            <ul className="divide-border divide-y">
              {now.overdue.map((o) => (
                <OrderRow key={o.id} o={o} badge={`${plural(o.daysLate, 'day')} late`} badgeTone="bad" />
              ))}
            </ul>
          ) : (
            <div className="flex h-full p-4">
              <Empty compact>
                Nothing is past its wanted-by date.
                {now.kpis.noDate > 0 &&
                  ` ${plural(now.kpis.noDate, 'open order has', 'open orders have')} no date, though, and can never show here.`}
              </Empty>
            </div>
          ))}
        {tab === 'dueSoon' &&
          (now.dueSoon.length ? (
            <ul className="divide-border divide-y">
              {now.dueSoon.map((o) => (
                <OrderRow
                  key={o.id}
                  o={o}
                  badge={o.dueIn === 0 ? 'due today' : `in ${plural(o.dueIn, 'day')} · ${shortDate(o.deliveryDate)}`}
                  badgeTone={o.dueIn <= 7 ? 'warn' : 'info'}
                />
              ))}
            </ul>
          ) : (
            <div className="flex h-full p-4">
              <Empty compact>No open order is due in the next two weeks.</Empty>
            </div>
          ))}
        {tab === 'drafts' &&
          (now.drafts.length ? (
            <ul className="divide-border divide-y">
              {now.drafts.map((o) => (
                <OrderRow
                  key={o.id}
                  o={o}
                  badge={o.ageDays === 0 ? 'drafted today' : `drafted ${plural(o.ageDays, 'day')} ago`}
                  badgeTone="neutral"
                />
              ))}
            </ul>
          ) : (
            <div className="flex h-full p-4">
              <Empty compact>Every order raised has been sent to its supplier.</Empty>
            </div>
          ))}
        {tab === 'unbilled' &&
          (now.unbilled.length ? (
            <ul className="divide-border divide-y">
              {now.unbilled.map((o) => (
                <OrderRow
                  key={o.id}
                  o={o}
                  badge={
                    o.sinceReceipt === 0 ? 'goods in today' : `goods in ${plural(o.sinceReceipt, 'day')} ago`
                  }
                  badgeTone={o.sinceReceipt > 15 ? 'bad' : 'warn'}
                  amount={o.unbilled}
                  amountLabel="not billed"
                />
              ))}
            </ul>
          ) : (
            <div className="flex h-full p-4">
              <Empty compact>Every delivery that has come in has its supplier&rsquo;s bill booked.</Empty>
            </div>
          ))}
      </div>
    </section>
  )
}

/* ---------------- Where the open orders are in their life ---------------- */

export function Pipeline({ pipeline }: { pipeline: DashboardData['now']['pipeline'] }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-1.5">
      {pipeline.map((p, i) => (
        <div key={p.status} className="contents">
          {i > 0 && (
            <div className="text-muted-foreground flex items-center" aria-hidden>
              <ArrowRight size={14} />
            </div>
          )}
          <div className="border-border bg-secondary/30 min-w-0 rounded-lg border p-2.5">
            <p className="text-muted-foreground flex items-start gap-1.5 text-[11px] leading-tight">
              <span
                className="mt-[3px] h-2 w-2 shrink-0 rounded-full"
                style={{ background: TONE[STATUS_TONE[p.status] ?? 'neutral'] }}
              />
              {p.label}
            </p>
            <p className="text-foreground mt-1 text-xl font-semibold leading-none tabular-nums">{p.orders}</p>
            <p className="text-muted-foreground mt-1 truncate text-[11px] tabular-nums">
              {p.orders ? shortRupees(p.value) : '—'}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * How long the open value has been waiting.
 *
 * One bar divided by age, oldest darkest — the ramp is allowed here because
 * age really is ordered. A 2px gap between segments rather than a border,
 * which would eat the smallest ones.
 */
export function AgeingBar({ ageing }: { ageing: DashboardData['now']['ageing'] }) {
  const total = ageing.reduce((s, a) => s + a.value, 0)
  if (total <= 0) return <Empty compact>No open order is waiting on goods.</Empty>
  const colour = (i: number) => RAMP[Math.min(RAMP.length - 1, i + 1)]

  return (
    <div className="flex flex-1 flex-col justify-center">
      <div className="flex h-4 w-full gap-[2px] overflow-hidden rounded-full">
        {ageing
          .map((a, i) => ({ ...a, i }))
          .filter((a) => a.value > 0)
          .map((a) => (
            <div
              key={a.label}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ flexGrow: a.value, background: colour(a.i) }}
              title={`${a.label} — ${rupees(a.value)} across ${plural(a.orders, 'order')}`}
            />
          ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        {ageing.map((a, i) => (
          <li key={a.label} className="flex items-baseline gap-1.5 text-xs">
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: colour(i) }} />
            <span className="text-muted-foreground min-w-0 flex-1 truncate">{a.label}</span>
            <span className="text-foreground shrink-0 tabular-nums">{a.value ? shortRupees(a.value) : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ---------------- From order to payment ---------------- */

/**
 * Ordered → received → billed → paid, each as a share of what was ordered and
 * of the stage before it. The second figure is the one that says where money
 * is stuck: received but not billed is a supplier's invoice to chase; billed
 * but not paid is our own queue.
 */
export function Funnel({ funnel }: { funnel: DashboardData['analysis']['funnel'] }) {
  const top = funnel[0]?.value ?? 0
  if (top <= 0) return <Empty>No orders were raised in this period.</Empty>

  return (
    <div className="flex flex-1 flex-col justify-center gap-2.5">
      {funnel.map((f, i) => {
        const share = f.value / top
        const fromPrev = i > 0 && funnel[i - 1].value > 0 ? f.value / funnel[i - 1].value : null
        return (
          <div key={f.label} title={`${f.label} — ${rupees(f.value)}`}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-foreground font-medium">{f.label}</span>
              <span className="text-muted-foreground tabular-nums">
                <span className="text-foreground font-semibold">{shortRupees(f.value)}</span>
                <span className="ml-1.5">{pct(share)}</span>
                {fromPrev != null && (
                  <span className="ml-1.5 hidden opacity-70 sm:inline">({pct(fromPrev)} of {funnel[i - 1].label.toLowerCase()})</span>
                )}
              </span>
            </div>
            <div className="bg-secondary mt-1 h-3 w-full overflow-hidden rounded-full">
              <div
                className="h-full rounded-full transition-[width] duration-700"
                style={{ width: `${Math.max(1.5, share * 100)}%`, background: RAMP[RAMP.length - 1 - i] }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * A ranking, as rows of bars with their names on them.
 *
 * One colour: shading a ranking darker-where-bigger says the bar's length a
 * second time and spends the only free channel on nothing. A row that can be
 * picked is a button, and picking it filters the whole page to it.
 */
export function RankBars({
  rows,
  selected,
  onPick,
  detail,
  empty,
}: {
  rows: Array<{ id: string; name: string; value: number }>
  selected?: string
  onPick?: (id: string) => void
  detail?: (row: { id: string; name: string; value: number }) => string | null
  empty: string
}) {
  if (!rows.length) return <Empty>{empty}</Empty>
  const max = Math.max(...rows.map((r) => r.value), 1)
  const total = rows.reduce((s, r) => s + r.value, 0)

  return (
    <ul className="space-y-1">
      {rows.map((r) => {
        const pickable = Boolean(onPick && r.id)
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className={`min-w-0 truncate ${r.id ? 'text-foreground' : 'text-muted-foreground italic'}`}>
                {r.name}
              </span>
              <span className="text-muted-foreground shrink-0 tabular-nums">
                <span className="text-foreground font-medium">{shortRupees(r.value)}</span>
                {total > 0 && <span className="ml-1.5">{Math.round((r.value / total) * 100)}%</span>}
              </span>
            </div>
            <div className="bg-secondary mt-1 h-2 w-full overflow-hidden rounded-full">
              <div
                className="h-full rounded-full transition-[width] duration-700"
                style={{
                  width: `${Math.max(2, (r.value / max) * 100)}%`,
                  background: r.id ? 'var(--viz-1)' : 'var(--tone-neutral)',
                  opacity: selected && selected !== r.id ? 0.35 : 1,
                }}
              />
            </div>
            {detail?.(r) && <p className="text-muted-foreground mt-0.5 text-[10px]">{detail(r)}</p>}
          </>
        )
        return (
          <li key={`${r.id}-${r.name}`}>
            {pickable ? (
              <button
                type="button"
                onClick={() => onPick?.(r.id)}
                title={selected === r.id ? 'Showing only this — click to show everything' : 'Show only this'}
                className={`hover:bg-[var(--hover-overlay)] w-full rounded-md px-1.5 py-1 text-left transition-colors ${
                  selected === r.id ? 'bg-[var(--hover-overlay-strong)]' : ''
                }`}
              >
                {body}
              </button>
            ) : (
              <div className="px-1.5 py-1">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Supplier by month, shaded by value.
 *
 * A block of numbers makes the eye read every one before it finds the big
 * month; shaded, the shape of the year is there first. One hue, and a month
 * with no order stays empty rather than being shaded as nought.
 */
export function Heatmap({ heatmap }: { heatmap: DashboardData['analysis']['heatmap'] }) {
  // Opens on the latest months: on a phone the table scrolls sideways, and the
  // month somebody is asking about is the newest one, at the far end.
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [heatmap])
  const all = heatmap.rows.flatMap((r) => r.values.filter((v): v is number => v != null))
  if (!all.length) return <Empty>No orders were raised in this period.</Empty>
  const max = Math.max(...all, 1)

  return (
    <div ref={scroller} className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[34rem] border-separate border-spacing-[3px] text-xs">
        <thead>
          <tr>
            <th className="text-muted-foreground px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide">
              Supplier
            </th>
            {heatmap.months.map((m) => (
              <th key={m} className="text-muted-foreground px-1 py-1 text-center text-[10px] font-medium">
                {m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {heatmap.rows.map((r) => (
            <tr key={r.id}>
              <td className="text-foreground max-w-[12rem] truncate px-2 py-1.5">{r.name}</td>
              {r.values.map((v, i) => (
                <td
                  key={i}
                  title={`${r.name} · ${heatmap.months[i]} — ${v == null ? 'nothing ordered' : rupees(v)}`}
                  className="text-foreground rounded-md px-1 py-1.5 text-center tabular-nums"
                  style={{
                    background:
                      v == null
                        ? 'color-mix(in srgb, var(--tone-neutral) 7%, transparent)'
                        : `color-mix(in srgb, var(--viz-1) ${Math.round(18 + (v / max) * 62)}%, transparent)`,
                  }}
                >
                  {v == null ? '' : shortRupees(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------------- Supplier scorecard ---------------- */

type ScoreKey = 'name' | 'orders' | 'value' | 'onTimeRate' | 'avgLead' | 'open' | 'unbilled'

/**
 * Every supplier on one sheet, sortable by any column. Ordering, reliability
 * and what is outstanding side by side — the three things a buyer weighs
 * before placing the next order with somebody.
 */
export function Scorecard({
  rows,
  selected,
  onPick,
}: {
  rows: DashboardData['analysis']['scorecard']
  selected?: string
  onPick: (id: string) => void
}) {
  const [sort, setSort] = useState<{ key: ScoreKey; desc: boolean }>({ key: 'value', desc: true })
  const sorted = useMemo(() => {
    const v = (r: (typeof rows)[number]) => r[sort.key]
    return [...rows].sort((a, b) => {
      const x = v(a)
      const y = v(b)
      // A supplier with nothing to measure sorts last whichever way round.
      if (x == null) return 1
      if (y == null) return -1
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : Number(x) - Number(y)
      return sort.desc ? -c : c
    })
  }, [rows, sort])

  if (!rows.length) return <Empty>No supplier has an order in this period or anything outstanding.</Empty>
  const maxValue = Math.max(...rows.map((r) => r.value), 1)

  const Head = ({ k, children, right }: { k: ScoreKey; children: React.ReactNode; right?: boolean }) => (
    <th className={`px-3 py-2 ${right ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={() => setSort((s) => ({ key: k, desc: s.key === k ? !s.desc : k !== 'name' }))}
        className={`hover:text-foreground inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${
          sort.key === k ? 'text-foreground' : 'text-muted-foreground'
        }`}
      >
        {children}
        <span aria-hidden className="w-2">
          {sort.key === k ? (sort.desc ? '↓' : '↑') : ''}
        </span>
      </button>
    </th>
  )

  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[46rem] text-sm">
        <thead className="border-border border-b">
          <tr>
            <Head k="name">Supplier</Head>
            <Head k="orders" right>
              Orders
            </Head>
            <Head k="value">Ordered in period</Head>
            <Head k="onTimeRate" right>
              On time
            </Head>
            <Head k="avgLead" right>
              Lead time
            </Head>
            <Head k="open" right>
              Still to arrive
            </Head>
            <Head k="unbilled" right>
              Not billed
            </Head>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {sorted.map((r) => {
            const rateTone: Tone | null =
              r.onTimeRate == null ? null : r.onTimeRate >= 0.9 ? 'good' : r.onTimeRate >= 0.7 ? 'warn' : 'bad'
            return (
              <tr
                key={r.id}
                onClick={() => onPick(r.id)}
                title={selected === r.id ? 'Showing only this supplier — click to show everyone' : 'Show only this supplier'}
                className={`hover:bg-[var(--hover-overlay)] cursor-pointer transition-colors ${
                  selected === r.id ? 'bg-[var(--hover-overlay-strong)]' : ''
                }`}
              >
                <td className="text-foreground max-w-[14rem] truncate px-3 py-2.5 font-medium">{r.name}</td>
                <td className="text-foreground px-3 py-2.5 text-right tabular-nums">{r.orders || '—'}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="bg-secondary h-1.5 w-20 shrink-0 overflow-hidden rounded-full">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.max(r.value ? 3 : 0, (r.value / maxValue) * 100)}%`, background: 'var(--viz-1)' }}
                      />
                    </div>
                    <span className="text-foreground tabular-nums">{r.value ? shortRupees(r.value) : '—'}</span>
                    {r.share != null && r.value > 0 && (
                      <span className="text-muted-foreground text-[11px] tabular-nums">{pct(r.share)}</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right">
                  {rateTone ? (
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                      style={{ color: TONE[rateTone], background: `color-mix(in srgb, ${TONE[rateTone]} 14%, transparent)` }}
                      title={`${r.onTime} on time, ${r.late} late`}
                    >
                      {pct(r.onTimeRate)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="text-foreground px-3 py-2.5 text-right tabular-nums">
                  {r.avgLead == null ? '—' : plural(Math.round(r.avgLead), 'day')}
                </td>
                <td className="text-foreground px-3 py-2.5 text-right tabular-nums">{r.open ? shortRupees(r.open) : '—'}</td>
                <td className="px-3 py-2.5 text-right tabular-nums" style={r.unbilled ? { color: TONE.warn } : undefined}>
                  {r.unbilled ? shortRupees(r.unbilled) : <span className="text-muted-foreground">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ---------------- Price watch ---------------- */

/**
 * The rate an item was last bought at, against the rate it usually costs.
 *
 * A rise is written as a rise — an arrow and the word, not only a red chip —
 * and the range bar shows where the latest rate sits between the cheapest and
 * dearest buy of the period, which says more than the percentage alone.
 */
export function PriceWatch({ rows }: { rows: DashboardData['analysis']['priceWatch'] }) {
  if (!rows.length) {
    return (
      <Empty>
        No item was bought more than once in this period, so there is no rate to compare against. Pick a
        longer period to see how prices have moved.
      </Empty>
    )
  }
  const money = (v: number) => `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <thead className="border-border border-b">
          <tr className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">
            <th className="px-3 py-2 text-left">Item</th>
            <th className="px-3 py-2 text-right">Buys</th>
            <th className="px-3 py-2 text-right">Usual rate</th>
            <th className="px-3 py-2 text-left">Cheapest · dearest</th>
            <th className="px-3 py-2 text-right">Last bought at</th>
            <th className="px-3 py-2 text-right">Against usual</th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {rows.map((r) => {
            const span = r.maxRate - r.minRate
            const at = span > 0 ? (r.latestRate - r.minRate) / span : 0.5
            const c = r.change ?? 0
            const tone: Tone = c >= 0.05 ? 'bad' : c > 0.005 ? 'warn' : c < -0.005 ? 'good' : 'neutral'
            const unit = r.uom ? `/${r.uom}` : ''
            return (
              <tr key={r.id}>
                <td className="px-3 py-2.5">
                  <p className="text-foreground max-w-[15rem] truncate font-medium">{r.name}</p>
                  {r.history.length > 2 && (
                    <div className="mt-1 w-28" title={r.history.map((h) => `${h.poNumber}: ${money(h.rate)}`).join('\n')}>
                      <Sparkline values={r.history.map((h) => h.rate)} className="h-5" />
                    </div>
                  )}
                </td>
                <td className="text-foreground px-3 py-2.5 text-right tabular-nums">{r.buys}</td>
                <td className="text-foreground px-3 py-2.5 text-right tabular-nums">
                  {money(r.avgRate)}
                  <span className="text-muted-foreground text-[11px]">{unit}</span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2 text-[11px] tabular-nums">
                    <span className="text-muted-foreground">{money(r.minRate)}</span>
                    <div className="bg-secondary relative h-1.5 w-16 shrink-0 rounded-full" title="Where the last buy sits in the period's range">
                      <span
                        className="border-card absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                        style={{ left: `${at * 100}%`, background: TONE[tone === 'neutral' ? 'normal' : tone] }}
                      />
                    </div>
                    <span className="text-muted-foreground">{money(r.maxRate)}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <p className="text-foreground tabular-nums">
                    {money(r.latestRate)}
                    <span className="text-muted-foreground text-[11px]">{unit}</span>
                  </p>
                  <p className="text-muted-foreground text-[10px]">
                    {r.latestPo} · {shortDate(r.latestDate)}
                  </p>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span
                    className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                    style={{ color: TONE[tone], background: `color-mix(in srgb, ${TONE[tone]} 14%, transparent)` }}
                  >
                    {c > 0.005 ? <ArrowUpRight size={12} /> : c < -0.005 ? <ArrowDownRight size={12} /> : null}
                    {Math.abs(c) <= 0.005 ? 'same' : `${Math.abs(Math.round(c * 1000) / 10)}% ${c > 0 ? 'dearer' : 'cheaper'}`}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
