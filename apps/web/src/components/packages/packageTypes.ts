/** What one labelled package physically is, in the words the store uses. */
export const PACK_TYPES = [
  { value: 'BOX', label: 'Box', one: 'box', many: 'boxes' },
  { value: 'ROLL', label: 'Roll', one: 'roll', many: 'rolls' },
  { value: 'CARTON', label: 'Carton', one: 'carton', many: 'cartons' },
  { value: 'BAG', label: 'Bag', one: 'bag', many: 'bags' },
  { value: 'BUNDLE', label: 'Bundle', one: 'bundle', many: 'bundles' },
  { value: 'PACKET', label: 'Packet', one: 'packet', many: 'packets' },
  { value: 'OTHER', label: 'Other', one: 'package', many: 'packages' },
] as const

/** "1 box", "3 boxes". */
export const packCount = (n: number, t: string) => {
  const p = PACK_TYPES.find((x) => x.value === t) ?? PACK_TYPES[6]
  return `${n} ${n === 1 ? p.one : p.many}`
}

export type PackType = (typeof PACK_TYPES)[number]['value']

export const packLabel = (t: string) => PACK_TYPES.find((p) => p.value === t)?.label ?? t

export const STATUS: Record<string, { label: string; cls: string }> = {
  IN_STOCK: { label: 'In stock', cls: 'badge-success' },
  EMPTY: { label: 'Empty', cls: 'badge-neutral' },
  SPLIT: { label: 'Retired (split)', cls: 'badge-info' },
  VOID: { label: 'Withdrawn', cls: 'badge-danger' },
}

export const qtyText = (n: number) => Number(n.toFixed(3)).toLocaleString('en-IN')

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** `total` over `n` stickers, all the same but the last, which takes what does not divide: 100 over 3 is 33.333, 33.333, 33.334. */
export function splitEvenly(total: number, n: number): number[] {
  if (!(n >= 1) || !(total > 0)) return []
  const each = Math.floor((total / n) * 1000) / 1000
  return [...Array<number>(n - 1).fill(each), round3(total - each * (n - 1))]
}

/** Sizes typed one by one — "98, 102 100.5" — as quantities, blanks and noughts left out. */
export const parseSizes = (text: string): number[] =>
  text
    .split(/[\s,;+]+/)
    .map(Number)
    .filter((q) => q > 0)
    .map(round3)

/**
 * A tab opened while the click is still fresh. A browser blocks a tab opened
 * after a save has come back, as though a page had popped it up on its own;
 * one opened on the click and filled in afterwards is allowed.
 */
export const openPrintTab = () => window.open('about:blank', '_blank')

/** Opens the stickers for these packages, ready to print: in the tab given, or a new one. */
export const printLabels = (ids: string[], tab?: Window | null) => {
  if (!ids.length) {
    tab?.close()
    return
  }
  const url = `/print/packages?ids=${ids.join(',')}`
  if (tab && !tab.closed) tab.location.href = url
  else window.open(url, '_blank')
}

/** Stock that went out on a document: an issue, a job-work challan, a return, a transfer. */
export type OutwardType = 'MR' | 'JOB_WORK' | 'PURCHASE_RETURN' | 'CUSTOMER_RETURN' | 'TRANSFER'
export interface OutwardRef {
  type: OutwardType
  id: string
  /** For a requisition issued more than once: what this issue handed over, "line:qty:store,…". */
  q?: string
}

/**
 * Opens the labels for what went out on a document, and the new stickers
 * for parts of packages that moved to another store, in one tab.
 */
export const printOutward = (out: OutwardRef | null, ids: string[], tab?: Window | null) => {
  if (!out) return printLabels(ids, tab)
  const qs = new URLSearchParams({ out: `${out.type}:${out.id}` })
  if (out.q) qs.set('q', out.q)
  if (ids.length) qs.set('ids', ids.join(','))
  const url = `/print/packages?${qs}`
  if (tab && !tab.closed) tab.location.href = url
  else window.open(url, '_blank')
}

export interface PackageMove {
  id: string
  type: string
  qty: number
  balanceAfter: number
  store: string
  toStore: string | null
  referenceType: string | null
  referenceId: string | null
  referenceNumber: string | null
  notes: string | null
  by: string | null
  createdAt: string
}

export interface PackageDetail {
  id: string
  code: string
  status: string
  packType: string
  qty: number
  initialQty: number
  unit: string
  lotNo: string | null
  /** Where in its store it sits: B-3. */
  rack: string | null
  notes: string | null
  sourceType: string
  createdAt: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  item: { id: string; code: string; name: string; category: { name: string } | null; uom: { symbol: string } | null }
  warehouse: { id: string; name: string }
  ownerCustomer: { id: string; name: string } | null
  parent: { id: string; code: string } | null
  children: Array<{ id: string; code: string; qty: string | number; status: string }>
  /** A retired sticker (status SPLIT): the stickers now on what is left of its roll. */
  replacedBy?: Array<{ code: string; qty: number }>
  grn: { grnNumber: string; grnDate: string; po: { supplier: { name: string } | null } | null } | null
  position: { inStore: number; inPackages: number; packages: number; loose: number }
  stores: Array<{ id: string; name: string }>
  /** The racks in use in its store, for the rack box to offer. */
  racks: string[]
  requisitions: Array<{
    lineId: string
    mrId: string
    mrNumber: string
    department: string
    owed: number
    requiredDate: string | null
    styleNo: string | null
    purpose: string | null
    moNumber: string | null
    soNumber: string | null
    customer: string | null
    sameStore: boolean
  }>
  moves: PackageMove[]
  newPackage?: { id: string; code: string } | null
  newPackages?: Array<{ id: string; code: string; qty: number }>
}
