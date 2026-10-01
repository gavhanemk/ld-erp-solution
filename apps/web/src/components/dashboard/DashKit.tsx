'use client'

import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

/**
 * The parts every dashboard in the app is built from — the inventory
 * dashboard, the stock ledger's, the customer material one — so they read as
 * one family: the same card, the same figure tile, the same colours, the same
 * tooltip.
 *
 * Quiet on purpose. White cards on the page's grey, one accent for icons, and
 * colour kept for the data itself, where it carries meaning.
 */

/** The data colours, in the order a chart hands them out. Legible on light and dark. */
export const PALETTE = ['#0d9488', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#10b981', '#6366f1', '#f97316', '#06b6d4', '#84cc16']
export const IN_COLOUR = '#10b981'
export const OUT_COLOUR = '#f43f5e'

/** Tones for figure tiles: a soft tile behind a coloured icon. */
export const TONE = {
  teal: '#0d9488',
  blue: '#3b82f6',
  violet: '#8b5cf6',
  amber: '#f59e0b',
  rose: '#f43f5e',
  orange: '#f97316',
  sky: '#0ea5e9',
  emerald: '#10b981',
} as const

/** ₹ short enough for an axis or a label: 12.5 L, 3.2 Cr, 45.0 K. */
export const inr = (v: number) => {
  const a = Math.abs(v)
  const s = v < 0 ? '−' : ''
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)} L`
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(1)} K`
  return `${s}₹${a.toFixed(0)}`
}

/** A quantity, Indian grouping, up to three decimals. */
export const qtyFmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })

/** Per-unit quantities in one line: "25,800 mtr · 12,776 roll". */
export const qtyLine = (qty: Array<{ uom: string; qty: number }>, max = 3) =>
  qty.length
    ? `${qty.slice(0, max).map((q) => `${qtyFmt(q.qty)} ${q.uom}`).join(' · ')}${qty.length > max ? ` · +${qty.length - max}` : ''}`
    : '—'

/** A titled card holding one chart or list. */
export function DashCard({
  title,
  hint,
  icon: Icon,
  href,
  hrefLabel = 'Open',
  action,
  className = '',
  children,
}: {
  title: string
  hint?: string
  icon?: React.ElementType
  /** A link at the top right to the screen behind the chart. */
  href?: string
  hrefLabel?: string
  /** Anything else for the top right — a toggle, a small select. */
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={`glass-card flex min-w-0 flex-col rounded-xl p-5 ${className}`}>
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {Icon && (
            <span className="bg-primary/10 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
              <Icon size={16} />
            </span>
          )}
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold leading-tight text-foreground">{title}</h3>
            {hint && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{hint}</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          {href && (
            <Link
              href={href}
              className="flex items-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
            >
              {hrefLabel} <ArrowUpRight size={13} />
            </Link>
          )}
        </div>
      </header>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  )
}

/**
 * One figure: a label, the number, a line under it, and room for a small
 * picture. It opens a screen (href), filters the page (onClick), or neither.
 */
export function KpiTile({
  icon: Icon,
  tone = TONE.teal,
  label,
  value,
  valueClass = 'text-foreground',
  sub,
  href,
  onClick,
  active = false,
  title,
  children,
}: {
  icon: React.ElementType
  tone?: string
  label: string
  value: React.ReactNode
  valueClass?: string
  sub?: React.ReactNode
  href?: string
  onClick?: () => void
  active?: boolean
  title?: string
  children?: React.ReactNode
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: `${tone}18`, color: tone }}>
          <Icon size={16} />
        </span>
      </div>
      <p className={`mt-1 truncate text-2xl font-semibold tabular-nums tracking-tight ${valueClass}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      {children && <div className="mt-3">{children}</div>}
    </>
  )
  const cls = `glass-card block min-w-0 rounded-xl p-4 text-left transition-all ${
    href || onClick ? 'hover:border-primary/40 hover:shadow-md' : ''
  } ${active ? 'border-primary ring-2 ring-primary/25' : ''}`
  if (href)
    return (
      <Link href={href} className={cls} title={title}>
        {body}
      </Link>
    )
  // A button centres what is in it when the row stretches it, so a tile that
  // filters sat lower than its neighbours; laid out as a column it starts at the top.
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cls.replace('block', 'flex flex-col justify-start')} title={title}>
        {body}
      </button>
    )
  return <div className={cls}>{body}</div>
}

/** A thin bar split into parts, for a tile: [{ value, colour }]. */
export function SplitBar({ parts }: { parts: Array<{ value: number; colour: string; label?: string }> }) {
  const total = parts.reduce((t, p) => t + p.value, 0)
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
      {total > 0 &&
        parts.map((p, i) => (
          <div key={i} style={{ width: `${(p.value / total) * 100}%`, background: p.colour }} title={p.label} />
        ))}
    </div>
  )
}

/** A few plain sentences about the figures, in one quiet row. */
export function Highlights({ items }: { items: Array<{ icon: React.ElementType; text: React.ReactNode; tone?: string }> }) {
  if (!items.length) return null
  return (
    <div className="glass-card flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl px-5 py-3">
      {items.map((h, i) => (
        <span key={i} className="flex items-center gap-2 text-[13px] text-foreground">
          <h.icon size={15} style={{ color: h.tone ?? TONE.teal }} className="shrink-0" />
          {h.text}
        </span>
      ))}
    </div>
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The chart tooltip every dashboard uses. `money` formats values as ₹ unless
 * the series name says it is a count or a quantity.
 */
export function ChartTip({ active, payload, label, money = true, labelOf }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
      {(label !== undefined || labelOf) && (
        <p className="mb-1 font-semibold text-foreground">{labelOf ? labelOf(payload[0].payload) : label}</p>
      )}
      {payload.map((p: any) => (
        <div key={p.dataKey ?? p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color ?? p.payload?.fill }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-semibold tabular-nums text-foreground">
            {money && !/move|count|qty|quantity|items|lines|%/i.test(String(p.name))
              ? inr(Math.abs(p.value))
              : Number(p.value).toLocaleString('en-IN', { maximumFractionDigits: 3 })}
          </span>
        </div>
      ))}
    </div>
  )
}

export function EmptyChart({ h = 220, text = 'Nothing to show yet.' }: { h?: number; text?: string }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground" style={{ height: h }}>
      {text}
    </div>
  )
}

/**
 * A value on a mark, on one line, centred above it (or below, for a bar hanging
 * down). Values under `floor` stay bare so small ones do not collide.
 */
export function markLabel(
  colour: string,
  format: (v: number) => string,
  opts: { floor?: number; below?: boolean; inside?: boolean; insideColour?: string } = {},
) {
  return function MarkLabel(props: any) {
    const { x, y, width = 0, height = 0, value } = props
    const v = Math.abs(Number(value))
    if (!v || v < (opts.floor ?? 0) || x === undefined || y === undefined) return null
    const cx = Number(x) + Number(width) / 2
    const top = Math.min(Number(y), Number(y) + Number(height))
    const bottom = Math.max(Number(y), Number(y) + Number(height))
    // Inside the top of a bar when it is tall enough, else just above it.
    const inside = opts.inside && bottom - top > 18
    const ty = opts.below ? bottom + 12 : inside ? top + 12 : top - 6
    return (
      <text x={cx} y={ty} textAnchor="middle" fill={inside ? (opts.insideColour ?? '#fff') : colour} fontSize={10} fontWeight={600}>
        {format(v)}
      </text>
    )
  }
}
