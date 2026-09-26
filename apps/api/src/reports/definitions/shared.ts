import type { ReportFilter, ReportParams } from '../types'

/** The date range every register report offers, worded the same way each time. */
export const dateRangeFilters: ReportFilter[] = [
  { key: 'from', label: 'From', type: 'date', help: 'Leave both blank for everything on record' },
  { key: 'to', label: 'To', type: 'date' },
]

export const supplierFilter: ReportFilter = {
  key: 'supplierId',
  label: 'Supplier',
  type: 'select',
  optionsFrom: 'suppliers',
}

/**
 * The two filters the purchase list screens carry that a report used not to.
 *
 * They exist because the Export button on those screens now builds a report
 * rather than a bare grid, and a report that quietly ignored the search box
 * would hand back a different list than the one on screen — filtered to
 * nothing the person could see, with nothing in the file to say so. A filter
 * the report cannot honour has to be a filter it refuses, not one it drops.
 */
export const searchFilter: ReportFilter = {
  key: 'q',
  label: 'Search',
  type: 'text',
  help: 'Document number, reference or supplier name',
}

export const itemFilter: ReportFilter = {
  key: 'itemId',
  label: 'Item',
  type: 'select',
  optionsFrom: 'items',
  help: 'Only documents with a line for this item',
}

/**
 * A day range, inclusive at both ends.
 *
 * `to` is pushed to the last millisecond of its day. Read as midnight it
 * silently drops everything booked that afternoon, and the person who asked
 * for "up to the 22nd" gets the 22nd missing with nothing to say so.
 */
export function dayRange(params: ReportParams): { gte?: Date; lte?: Date } | undefined {
  const from = params.from ? new Date(`${params.from}T00:00:00`) : undefined
  const to = params.to ? new Date(`${params.to}T23:59:59.999`) : undefined
  if (!from && !to) return undefined
  return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) }
}

const DAY = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' })

export function periodLabel(params: ReportParams): string {
  const { from, to } = params
  if (from && to) return `${DAY.format(new Date(from))} to ${DAY.format(new Date(to))}`
  if (from) return `${DAY.format(new Date(from))} onwards`
  if (to) return `Everything up to ${DAY.format(new Date(to))}`
  return 'Everything on record'
}

/** Month buckets in order, keyed yyyy-mm so they sort as text. */
export function byMonth<T>(rows: T[], dateOf: (r: T) => Date, valueOf: (r: T) => number) {
  const buckets = new Map<string, number>()
  for (const r of rows) {
    const d = dateOf(r)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    buckets.set(key, (buckets.get(key) ?? 0) + valueOf(r))
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const [y, m] = key.split('-').map(Number)
      return {
        label: new Date(y, m - 1, 1).toLocaleDateString('en-IN', {
          month: 'short',
          year: '2-digit',
        }),
        value: Math.round(value * 100) / 100,
      }
    })
}

/** The biggest N, with everything else gathered so the shares still add up. */
export function topWithRest(
  entries: Array<{ label: string; value: number }>,
  n: number
): Array<{ label: string; value: number }> {
  const sorted = [...entries].sort((a, b) => b.value - a.value)
  if (sorted.length <= n) return sorted
  const rest = sorted.slice(n).reduce((s, e) => s + e.value, 0)
  // Excel rebases a doughnut's labels over the points it is given, so a
  // top-five share panel without an "everyone else" slice prints percentages
  // that contradict the KPI beside it.
  return [...sorted.slice(0, n), { label: 'Everyone else', value: Math.round(rest * 100) / 100 }]
}

export const round2 = (n: number) => Math.round(n * 100) / 100

/** A ratio, or null when there is nothing to divide by. */
export function ratio(top: number, bottom: number): number | null {
  return bottom === 0 ? null : top / bottom
}

/** An average, or null when there is nothing to average. */
export function mean(total: number, count: number): number | null {
  return count === 0 ? null : round2(total / count)
}
