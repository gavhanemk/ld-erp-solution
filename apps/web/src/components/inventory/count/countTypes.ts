/*
 * Stock count by scanning stickers: what the screens are handed, and the
 * words and colours they use for it.
 */

export type CountStatus = 'OPEN' | 'SUBMITTED' | 'CLOSED' | 'CANCELLED'
export type ScanResult = 'FOUND' | 'ELSEWHERE' | 'NOT_IN_STOCK' | 'UNKNOWN' | 'GONE'

export interface CountScan {
  id: string
  code: string
  result: ScanResult
  qty: number | null
  unit: string
  item: { code: string; name: string } | null
  owner: string | null
  packType: string | null
  lotNo: string | null
  store: string | null
  /** The rack it was found on, else the one the system has it on. */
  rack: string | null
  at: string
  by: string | null
  note: string
}

export interface CountLine {
  key: string
  itemId: string
  code: string
  name: string
  unit: string
  tracked: boolean
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId: string | null
  owner: string | null
  book: number
  packages: number
  inPackages: number
  scanned: number
  scannedQty: number
  looseBook: number
  looseCounted: number | null
  inCount: boolean
  countedQty: number
  difference: number
}

export interface ToFind {
  id: string
  code: string
  itemId: string
  item: string
  unit: string
  qty: number
  packType: string
  lotNo: string | null
  rack: string | null
}

interface CountHead {
  id: string
  countNumber: string
  status: CountStatus
  warehouse: { id: string; name: string }
  notes: string | null
  startedAt: string
  startedBy: string | null
  submittedAt: string | null
  closedAt: string | null
  cancelReason: string | null
}

export interface Effect {
  toFind: number
  differences: number
  items: number
}

export interface OpenCount extends CountHead {
  review: {
    lines: CountLine[]
    stillToFind: ToFind[]
    scans: CountScan[]
    problems: CountScan[]
    totals: { expected: number; found: number; toFind: number; scans: number; problems: number; differences: number; handCounted: number }
  }
  finish: { STORE: Effect; SCANNED: Effect }
}

export interface DoneCount extends CountHead {
  adjustment: {
    id: string
    adjustmentNumber: string
    status: 'PENDING' | 'APPROVED' | 'REJECTED'
    rejectReason: string | null
    approvedAt: string | null
    approvedBy: { name: string } | null
    lines: Array<{ item: string; code: string; unit: string; owner: string | null; book: number; counted: number; difference: number }>
  } | null
  missing: Array<{ id: string; code: string; item: string; unit: string; qty: number; status: string; packType: string; lotNo: string | null; rack: string | null }>
  scans: CountScan[]
}

export type CountDetail = OpenCount | DoneCount
export const isOpen = (c: CountDetail): c is OpenCount => c.status === 'OPEN'

export interface CountRow {
  id: string
  countNumber: string
  status: CountStatus
  store: string
  warehouseId: string
  startedAt: string
  startedBy: string | null
  submittedAt: string | null
  closedAt: string | null
  scans: number
  found: number
  notFound: number | null
  adjustment: { adjustmentNumber: string; status: string } | null
}

export const COUNT_STATUS: Record<CountStatus, { label: string; cls: string }> = {
  OPEN: { label: 'Counting', cls: 'badge-info' },
  SUBMITTED: { label: 'Waiting for approval', cls: 'badge-warning' },
  CLOSED: { label: 'Closed', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

export const ADJ_STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'Waiting', cls: 'badge-warning' },
  APPROVED: { label: 'Approved', cls: 'badge-success' },
  REJECTED: { label: 'Refused', cls: 'badge-danger' },
}

/** How each kind of scan looks: a green tick for a sticker found, amber for one to check, red for one we do not know. */
export const SCAN_LOOK: Record<ScanResult, { label: string; box: string; text: string }> = {
  FOUND: { label: 'Found', box: 'border-emerald-500/40 bg-emerald-500/10', text: 'text-emerald-600' },
  ELSEWHERE: { label: 'Booked to another store', box: 'border-amber-500/40 bg-amber-500/10', text: 'text-amber-600' },
  NOT_IN_STOCK: { label: 'Shows as not in stock', box: 'border-amber-500/40 bg-amber-500/10', text: 'text-amber-600' },
  UNKNOWN: { label: 'Not our sticker', box: 'border-red-500/40 bg-red-500/10', text: 'text-red-600' },
  GONE: { label: 'Moved since it was scanned', box: 'border-slate-500/40 bg-slate-500/10', text: 'text-slate-500' },
}

export const qty = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const IST = { timeZone: 'Asia/Kolkata' } as const
export const when = (d: string) =>
  `${new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...IST })}, ${new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', ...IST })}`
export const clock = (d: string) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', ...IST })
