'use client'

import { useEffect, useRef } from 'react'
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
  basis,
  tone,
  change,
  progress,
  icon,
}: {
  label: string
  value: string
  basis?: string
  tone?: Tone
  change?: number | null
  progress?: number | null
  icon?: React.ReactNode
}) {
  return (
    <div className="glass-card relative min-w-0 overflow-hidden p-3 pl-4">
      <span
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: tone ? TONE[tone] : 'var(--viz-1)' }}
        aria-hidden
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground truncate text-[11px] font-medium uppercase tracking-wide">
          {label}
        </p>
        {icon && <span className="text-muted-foreground shrink-0 opacity-70">{icon}</span>}
      </div>
      <p
        className="mt-1.5 text-2xl font-semibold leading-none tabular-nums"
        style={tone && tone !== 'neutral' && tone !== 'normal' ? { color: TONE[tone] } : undefined}
      >
        {value}
      </p>
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
    </div>
  )
}

/* ---------------- The action centre: what somebody should do today ---------------- */

export type ActionTab = 'overdue' | 'dueSoon' | 'drafts'

function OrderRow({
  o,
  badge,
  badgeTone,
}: {
  o: OrderBrief
  badge: string
  badgeTone: Tone
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
            <p className="text-foreground text-sm font-semibold tabular-nums">{shortRupees(o.pending || o.ordered)}</p>
            <p className="text-muted-foreground text-[10px]">{o.pending ? 'still due' : 'order value'}</p>
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
  const tabs: Array<{ key: ActionTab; label: string; count: number; tone: Tone }> = [
    { key: 'overdue', label: 'Overdue', count: now.kpis.overdueOrders, tone: 'bad' },
    { key: 'dueSoon', label: 'Due in 14 days', count: now.dueSoon.length, tone: 'warn' },
    { key: 'drafts', label: 'Not sent', count: now.kpis.drafts, tone: 'neutral' },
  ]

  return (
    <section className="glass-card flex min-w-0 flex-col overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 pt-3">
        <h3 className="text-foreground pb-2 text-sm font-semibold">Orders to chase</h3>
        <div className="-mb-px flex gap-1" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => onTab(t.key)}
              className={`flex items-center gap-1.5 border-b-2 px-2.5 pb-2 text-xs font-medium transition-colors ${
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

export function Insights({ lines }: { lines: string[] }) {
  return (
    <section className="glass-card relative overflow-hidden p-4">
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: 'var(--viz-1)' }} aria-hidden />
      <h3 className="text-foreground flex items-center gap-2 pl-1 text-sm font-semibold">
        <Lightbulb size={15} className="text-primary" />
        What the figures say
      </h3>
      {lines.length ? (
        <ul className="mt-2.5 space-y-2 pl-1">
          {lines.map((l) => (
            <li key={l} className="text-foreground flex gap-2.5 text-sm leading-snug">
              <span className="bg-primary mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" />
              {l}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground mt-2 pl-1 text-sm">
          Nothing stands out — no late orders, no unbilled goods, no supplier carrying the book on its own.
        </p>
      )}
    </section>
  )
}
