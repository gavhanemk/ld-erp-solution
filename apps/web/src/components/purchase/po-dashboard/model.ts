/**
 * What `/purchase/orders-dashboard` sends, and the few ways a figure is
 * written on the dashboard. The server works everything out; this side only
 * draws it, so the dashboard and the Purchase Order Status report cannot
 * count one order two ways.
 */

export type Tone = 'good' | 'normal' | 'info' | 'warn' | 'bad' | 'neutral'

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

export interface DashboardData {
  asOf: string
  period: { from: string | null; to: string | null }
  options: {
    suppliers: Array<{ id: string; name: string }>
    categories: Array<{ id: string; name: string }>
  }
  now: {
    kpis: {
      unbilledOrders: number
      unbilledValue: number
      openOrders: number
      openValue: number
      overdueOrders: number
      overdueValue: number
      dueThisWeek: number
      dueThisWeekValue: number
      drafts: number
      draftValue: number
      noDate: number
    }
    schedule: Array<{ key: string; label: string; tone: Tone; orders: number; value: number }>
    ageing: Array<{ label: string; orders: number; value: number }>
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
      avgOrder: number | null
      suppliers: number
      onTimeRate: number | null
      receipts: number
      avgLead: number | null
      receivedRate: number | null
      billedRate: number | null
      cancelled: number
    }
    funnel: Array<{ label: string; value: number }>
    trend: Array<{ key: string; label: string; ordered: number; received: number; orders: number }>
    statusMix: Array<{ status: string; label: string; orders: number; value: number }>
    topSuppliers: Array<{
      id: string
      name: string
      value: number
      orders: number
      onTimeRate: number | null
      avgLead: number | null
    }>
    supplierQuadrant: Array<{
      id: string
      name: string
      value: number
      onTimeRate: number
      avgLead: number
      receipts: number
    }>
    onTimeBySupplier: Array<{ id: string; name: string; onTime: number; late: number }>
    categories: Array<{ id: string; name: string; value: number }>
    topItems: Array<{ id: string; name: string; value: number; orders: number }>
    leadTime: Array<{ label: string; orders: number }>
    heatmap: {
      months: string[]
      rows: Array<{ id: string; name: string; values: Array<number | null> }>
    }
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
      history: Array<{ rate: number; poNumber: string; date: string }>
    }>
    insights: string[]
  }
}

/** The dashboard's three views, each answering one kind of question. */
export type View = 'overview' | 'suppliers' | 'items'

export const VIEWS: Array<{ key: View; label: string; hint: string }> = [
  { key: 'overview', label: 'Overview', hint: 'What to chase today, and how ordering has gone' },
  { key: 'suppliers', label: 'Suppliers', hint: 'Who you buy from, and how they deliver' },
  { key: 'items', label: 'Items & prices', hint: 'What the money goes on, and what it costs' },
]

/** Colour by meaning — the same tokens every report in the ERP uses. */
export const TONE: Record<Tone, string> = {
  good: 'var(--tone-good)',
  normal: 'var(--tone-normal)',
  info: 'var(--tone-info)',
  warn: 'var(--tone-warn)',
  bad: 'var(--tone-bad)',
  neutral: 'var(--tone-neutral)',
}

/** An order's stage, in the colours the order list's badges already use. */
export const STATUS_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  SENT: 'info',
  PARTIALLY_RECEIVED: 'warn',
  COMPLETED: 'good',
  CANCELLED: 'neutral',
}

export const RAMP = [1, 2, 3, 4, 5, 6].map((n) => `var(--viz-ramp-${n})`)

/** Rupees, exactly — for a tooltip or a table cell. */
export const rupees = (v: number) =>
  `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

/** Rupees, rounded to lakhs or crores — for a tile, an axis or a bar end. */
export function shortRupees(v: number): string {
  const a = Math.abs(v)
  if (a >= 10_000_000) return `₹${(v / 10_000_000).toFixed(2)} cr`
  if (a >= 100_000) return `₹${(v / 100_000).toFixed(a >= 1_000_000 ? 1 : 2)} L`
  if (a >= 1_000) return `₹${(v / 1_000).toFixed(1)}k`
  return `₹${Math.round(v)}`
}

export const pct = (v: number | null, digits = 0) =>
  v == null ? '—' : `${(v * 100).toFixed(digits)}%`

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "12 Sep" — a date inside this year needs no year. */
export function shortDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: '2-digit' as const } : {}),
  })
}

/* ---------- The period presets, worked out on the reader's own calendar ---------- */

export type Preset = 'month' | '3m' | '6m' | 'fy' | 'lastfy' | 'all' | 'custom'

export const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: 'month', label: 'This month' },
  { key: '3m', label: '3 months' },
  { key: '6m', label: '6 months' },
  { key: 'fy', label: 'This FY' },
  { key: 'lastfy', label: 'Last FY' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom' },
]

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The dates a preset stands for. The financial year runs April to March. */
export function presetRange(p: Preset): { from: string; to: string } {
  const t = new Date()
  const fyStart = t.getMonth() >= 3 ? t.getFullYear() : t.getFullYear() - 1
  switch (p) {
    case 'month':
      return { from: iso(new Date(t.getFullYear(), t.getMonth(), 1)), to: iso(t) }
    case '3m':
      return { from: iso(new Date(t.getFullYear(), t.getMonth() - 2, 1)), to: iso(t) }
    case '6m':
      return { from: iso(new Date(t.getFullYear(), t.getMonth() - 5, 1)), to: iso(t) }
    case 'fy':
      return { from: iso(new Date(fyStart, 3, 1)), to: iso(t) }
    case 'lastfy':
      return { from: iso(new Date(fyStart - 1, 3, 1)), to: iso(new Date(fyStart, 2, 31)) }
    default:
      return { from: '', to: '' }
  }
}

export function periodWords(from: string, to: string): string {
  if (!from && !to) return 'everything on record'
  const f = (s: string) =>
    new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  if (from && to) return `${f(from)} – ${f(to)}`
  return from ? `from ${f(from)}` : `up to ${f(to)}`
}
