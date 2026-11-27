import { fetchEveryPage } from '@/lib/export'

/**
 * Telling same-name fabric and thread apart (27 Nov 2026).
 *
 * Fabric is set up one design and colour per item and thread one colour per
 * item (Masters → Items), so several items can share a name — three "Cotton
 * Twill" items differ only by their Design No. and Colour. Every picker and
 * every list that shows an item uses these, so the same words appear on every
 * screen: "Design No: 120 · Colour: Navy", exactly as typed in the master.
 * A finished good is left alone: its colour is already in its name.
 */

export interface ShadeFields {
  designNo?: string | null
  color?: string | null
  /** Set on a finished good, whose colour is already in its name. */
  styleId?: string | null
}

/** "Design No: 120 · Colour: Navy"; a thread "Colour: White"; '' for anything else. */
export function itemShade(i: ShadeFields | null | undefined): string {
  if (!i || i.styleId) return ''
  return [i.designNo ? `Design No: ${i.designNo}` : null, i.color ? `Colour: ${i.color}` : null]
    .filter(Boolean)
    .join(' · ')
}

/** The two values on their own, for a table with Design No. and Colour columns ('' when none). */
export function itemShadeCols(i: ShadeFields | null | undefined): { designNo: string; colour: string } {
  if (!i || i.styleId) return { designNo: '', colour: '' }
  return { designNo: i.designNo ?? '', colour: i.color ?? '' }
}

/**
 * Every item in Masters → Items that matches `filters`, not just the first
 * page. The list answers at most 200 rows a request, so a picker that asked
 * once for 500 quietly got the first 200 names — and with one item per design
 * and colour that limit is reached sooner.
 */
export async function everyItem<T>(filters: Record<string, string | number | boolean | undefined> = {}): Promise<T[]> {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') q.set(k, String(v))
  const { rows } = await fetchEveryPage<T>((page) => {
    q.set('page', String(page))
    q.set('limit', '200')
    return `/masters/items?${q.toString()}`
  })
  return rows
}
