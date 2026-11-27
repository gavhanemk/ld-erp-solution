import type { ReportColumn, ReportFilter, ReportParams } from '../types'
import { itemShadeText } from '../../lib/fabric'

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

// ── A fabric's design and colour ────────────────────────────────────────────

/**
 * The Design No. and Colour columns (27 Nov 2026), set right after the item.
 *
 * Fabric is set up one design and colour per item and thread one colour per
 * item, so three "Cotton Twill" items differ only by these. Printed exactly
 * as typed in the Items master; blank for a finished good, whose colour is in
 * its name already.
 */
export const shadeColumns: ReportColumn[] = [
  { key: 'designNo', label: 'Design No.', type: 'text', width: 12 },
  { key: 'colour', label: 'Colour', type: 'text', width: 12 },
]

type Shade = { designNo?: string | null; color?: string | null; styleId?: string | null }

/** The two columns' values for an item selected with ITEM_SHADE ('' when none). */
export function shadeOf(i: Shade | null | undefined): { designNo: string; colour: string } {
  if (!i || i.styleId) return { designNo: '', colour: '' }
  return { designNo: i.designNo ?? '', colour: i.color ?? '' }
}

/** "Cotton Twill · Design No: 1164 · Colour: Navy", or the name alone. */
export function itemLabel(name: string, i: Shade | null | undefined): string {
  const shade = itemShadeText(i)
  return shade ? `${name} · ${shade}` : name
}

/**
 * What a report row says about its item: its code and name, its Design No.
 * and Colour columns — or `itemShade`, the words worked out by a report whose
 * Colour column also carries a finished good's colour, which a label leaves
 * out.
 */
export interface ItemRow {
  itemCode?: unknown
  item?: unknown
  designNo?: unknown
  colour?: unknown
  itemShade?: unknown
}

const text = (v: unknown) => (v == null ? '' : String(v))

/** A row's item as a chart, a summary line or a sentence names it. */
export function rowItemLabel(r: ItemRow): string {
  const shade =
    typeof r.itemShade === 'string' ? r.itemShade : itemShadeText({ designNo: text(r.designNo), color: text(r.colour) })
  return shade ? `${text(r.item)} · ${shade}` : text(r.item)
}

/** Where two items still read the same — one name, no design or colour — each is told apart by its code. */
export function distinctLabels<T extends { code: string; label: string }>(list: T[]): T[] {
  const seen = new Map<string, number>()
  for (const e of list) seen.set(e.label, (seen.get(e.label) ?? 0) + 1)
  return list.map((e) => ((seen.get(e.label) ?? 0) > 1 && e.code ? { ...e, label: `${e.label} (${e.code})` } : e))
}

/**
 * A figure added up item by item, for a chart or a sentence.
 *
 * By item code, not name: the same name in two designs is two items, and
 * added up by name they would merge into one bar. Each is named with its
 * design and colour.
 */
export function sumByItem<R extends ItemRow>(rows: R[], valueOf: (r: R) => number): Array<{ code: string; label: string; value: number }> {
  const m = new Map<string, { label: string; value: number }>()
  for (const r of rows) {
    const code = text(r.itemCode) || text(r.item)
    const e = m.get(code) ?? { label: rowItemLabel(r), value: 0 }
    e.value += valueOf(r)
    m.set(code, e)
  }
  return distinctLabels([...m].map(([code, e]) => ({ code, label: e.label, value: round2(e.value) })))
}
