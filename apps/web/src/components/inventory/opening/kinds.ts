import { Factory, Package, Shirt, type LucideIcon } from 'lucide-react'

/*
 * The three kinds opening stock is entered as, each with its own screen and
 * template, and what the entry screens are given to choose from — joined up,
 * so a style leads only to its own colours, sizes and route, and a material
 * category only to its own items.
 */

export type Kind = 'FG' | 'SFG' | 'RM'

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
]
export const kindOf = (k: string | null | undefined) => KINDS.find((x) => x.key === k)

export interface StyleOption {
  id: string
  code: string
  name: string
  colours: Array<{ colour: string; item: { id: string; code: string } | null }>
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
}
export interface FormOptions {
  processes: Array<{ id: string; name: string; floor: string | null }>
  stores: Array<{ id: string; name: string; code: string }>
  sizeRuns: Array<{ id: string; name: string; sizes: string[] }>
  styles: StyleOption[]
  categories: Array<{ id: string; name: string; items: number }>
  items: MaterialOption[]
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
