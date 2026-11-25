import { Factory, Package, Shirt, Wrench, type LucideIcon } from 'lucide-react'

/*
 * The three kinds opening stock is entered as, each with its own screen and
 * template, and what the entry screens are given to choose from — joined up,
 * so a style leads only to its own colours, sizes and route, and a material
 * category only to its own items.
 */

export type Kind = 'FG' | 'SFG' | 'RM' | 'FA'

export const KINDS: Array<{
  key: Kind
  label: string
  short: string
  icon: LucideIcon
  text: string
  /** What is entered, in the order it is chosen. */
  steps: string[]
}> = [
  {
    key: 'FG',
    label: 'Finished Goods',
    short: 'FG',
    icon: Shirt,
    text: 'Garments made, checked and in a finished goods store.',
    steps: ['Style', 'Colour', 'Size', 'Store'],
  },
  {
    key: 'SFG',
    label: 'Semi Finished Goods',
    short: 'SFG',
    icon: Factory,
    text: 'Garments part-made, lying at a process — cut, at stitching, at finishing.',
    steps: ['Style', 'Process on its route', 'Colour', 'Size'],
  },
  {
    key: 'RM',
    label: 'Raw Materials',
    short: 'RM',
    icon: Package,
    text: 'Fabric, thread, buttons, labels, trims and packing in a store.',
    steps: ['Material category', 'Item', 'Lot or roll', 'Quantity'],
  },
  {
    key: 'FA',
    label: 'Fixed Assets',
    short: 'FA',
    icon: Wrench,
    text: 'Machines, computers, furniture — in a store or at a department. Each one gets its own asset tag.',
    steps: ['Asset category', 'Item', 'Serial numbers', 'Location'],
  },
]
export const kindOf = (k: string | null | undefined) => KINDS.find((x) => x.key === k)

/** A finished item linked to a style: picked by its code, name or description. */
export interface StyleItem {
  id: string
  code: string
  name: string
  description: string | null
  colour: string | null
}
export interface StyleOption {
  id: string
  code: string
  name: string
  /** Every finished item linked to the style. */
  items: StyleItem[]
  colours: Array<{ colour: string; item: { id: string; code: string; name?: string } | null }>
  sizes: Array<{ id: string; code: string }>
  /** The processes on its route, in order; null when it has none. */
  route: Array<{ id: string; name: string }> | null
  routeFrom: { applies: 'STYLE' | 'CATEGORY' | 'ANY'; code: string } | null
}
export interface MaterialOption {
  id: string
  code: string
  name: string
  type: string
  categoryId: string
  unit: string | null
  decimals: number
  /** Labelled by package: its stickers are made as it comes in. */
  tracked?: boolean
  /** Its usual package, and what one holds, when the item says. */
  packType?: string | null
  perPack?: number | null
}
export interface FormOptions {
  processes: Array<{ id: string; name: string; floor: string | null }>
  stores: Array<{ id: string; name: string; code: string }>
  sizeRuns: Array<{ id: string; name: string; sizes: string[] }>
  styles: StyleOption[]
  categories: Array<{ id: string; name: string; items: number }>
  items: MaterialOption[]
  /** Fixed assets by their subcategory (Machines, Computers…). */
  assetCategories?: Array<{ id: string; name: string; items: number }>
  /** Every department: where a fixed asset may be installed. */
  departments?: Array<{ id: string; name: string }>
}

/** One row of a style's grid: a colour of the style with its item (or none yet), or another item linked to the style. */
export interface StyleRow {
  key: string
  colour: string
  item: StyleItem | null
}

/**
 * The rows a style's grid shows: each of its colours, with the item made for
 * it (or none yet, to make), then every other item linked to the style — one
 * in a colour the style does not list, or a second item in one colour — so
 * every item under the style can be entered.
 */
export function styleRows(st: StyleOption): StyleRow[] {
  const items = st.items ?? []
  const used = new Set<string>()
  const rows: StyleRow[] = st.colours.map((c) => {
    const item = c.item ? (items.find((i) => i.id === c.item!.id) ?? { id: c.item.id, code: c.item.code, name: c.item.name ?? '', description: null, colour: c.colour }) : null
    if (item) used.add(item.id)
    return { key: c.colour, colour: c.colour, item }
  })
  for (const i of items) if (!used.has(i.id)) rows.push({ key: `#${i.id}`, colour: i.colour ?? '', item: i })
  return rows
}

export const STATUSES = [
  { value: 'OK', label: 'OK — ready to use' },
  { value: 'Hold', label: 'Hold — kept aside' },
  { value: 'Rejected', label: 'Rejected' },
  { value: 'B-Grade', label: 'B-Grade (second quality)' },
]

export const todayInIndia = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10)
export const money = (v: number) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const num = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
export const cellKey = (colour: string, sizeId: string) => `${colour}|${sizeId}`
