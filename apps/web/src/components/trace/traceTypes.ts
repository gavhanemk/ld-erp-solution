import {
  ClipboardList,
  Factory,
  Package,
  Scissors,
  ShieldCheck,
  Tag,
  Truck,
  Undo2,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'

/*
 * Track & trace: what the screen is handed, and the words and colours it
 * uses for them.
 */

export type Phase = 'order' | 'material' | 'cutting' | 'production' | 'qc' | 'store' | 'tag' | 'despatch' | 'return'

export interface Step {
  at: string
  phase: Phase
  title: string
  detail?: string | null
  ref?: string | null
  by?: string | null
  undone?: boolean
}

/** What is open on the screen, and the link that opens it again. */
export type Target = { kind: 'g' | 'so' | 'mo' | 'c' | 's'; id: string }

export interface Hit {
  kind: 'GARMENT' | 'SO' | 'MO' | 'CUSTOMER' | 'STYLE'
  id: string
  title: string
  sub: string
}

export const hitTarget = (h: Hit): Target =>
  h.kind === 'GARMENT' ? { kind: 'g', id: h.id } : h.kind === 'SO' ? { kind: 'so', id: h.id } : h.kind === 'MO' ? { kind: 'mo', id: h.id } : h.kind === 'CUSTOMER' ? { kind: 'c', id: h.id } : { kind: 's', id: h.id }

export const PHASE: Record<Phase, { label: string; icon: LucideIcon; dot: string; chip: string }> = {
  order: { label: 'Order', icon: ClipboardList, dot: 'bg-sky-500', chip: 'text-sky-600 bg-sky-500/10 border-sky-500/30' },
  material: { label: 'Materials', icon: Package, dot: 'bg-amber-500', chip: 'text-amber-600 bg-amber-500/10 border-amber-500/30' },
  cutting: { label: 'Cutting', icon: Scissors, dot: 'bg-orange-500', chip: 'text-orange-600 bg-orange-500/10 border-orange-500/30' },
  production: { label: 'Production', icon: Factory, dot: 'bg-indigo-500', chip: 'text-indigo-600 bg-indigo-500/10 border-indigo-500/30' },
  qc: { label: 'Quality check', icon: ShieldCheck, dot: 'bg-emerald-500', chip: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/30' },
  store: { label: 'Store', icon: Warehouse, dot: 'bg-teal-500', chip: 'text-teal-600 bg-teal-500/10 border-teal-500/30' },
  tag: { label: 'Tag', icon: Tag, dot: 'bg-slate-500', chip: 'text-slate-600 bg-slate-500/10 border-slate-500/30' },
  despatch: { label: 'Despatch', icon: Truck, dot: 'bg-violet-500', chip: 'text-violet-600 bg-violet-500/10 border-violet-500/30' },
  return: { label: 'Returns', icon: Undo2, dot: 'bg-rose-500', chip: 'text-rose-600 bg-rose-500/10 border-rose-500/30' },
}

export const GARMENT_STATUS: Record<string, { label: string; cls: string }> = {
  IN_STOCK: { label: 'In store', cls: 'badge-success' },
  PACKED: { label: 'Packed', cls: 'badge-info' },
  DISPATCHED: { label: 'Despatched', cls: 'badge-purple' },
  SCRAPPED: { label: 'Written off', cls: 'badge-danger' },
  VOID: { label: 'Tag withdrawn', cls: 'badge-neutral' },
}

export const SO_STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral' },
  CONFIRMED: { label: 'Confirmed', cls: 'badge-info' },
  IN_PRODUCTION: { label: 'In production', cls: 'badge-warning' },
  PARTIALLY_DISPATCHED: { label: 'Part despatched', cls: 'badge-purple' },
  COMPLETED: { label: 'Completed', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-danger' },
}

export const MO_STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral' },
  RELEASED: { label: 'Released', cls: 'badge-info' },
  CUTTING: { label: 'Cutting', cls: 'badge-warning' },
  STITCHING: { label: 'Stitching', cls: 'badge-warning' },
  FINISHING: { label: 'Finishing', cls: 'badge-warning' },
  QC: { label: 'In QC', cls: 'badge-warning' },
  PACKING: { label: 'Packing', cls: 'badge-warning' },
  COMPLETED: { label: 'Completed', cls: 'badge-success' },
  CLOSED: { label: 'Closed', cls: 'badge-neutral' },
}

export const badge = (map: Record<string, { label: string; cls: string }>, v: string) => map[v] ?? { label: v, cls: 'badge-neutral' }

const IST = { timeZone: 'Asia/Kolkata' } as const
export const fmtDay = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', ...IST }) : '—')
export const fmtDayLong = (d: string) => new Date(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', ...IST })
export const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', ...IST })
export const fmtWhen = (d: string) => `${fmtDay(d)}, ${fmtTime(d)}`
export const dayKey = (d: string) => new Date(d).toLocaleDateString('en-CA', IST)
export const qty = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })

/** Tagged pieces counted by colour and size, and the pieces themselves. */
export interface Pieces {
  totals: Record<string, number>
  tagged: number
  bySize: Array<{ style: string; color: string; size: string; counts: Record<string, number>; total: number }>
  list: Array<{ code: string; status: string; grade: string; printed: boolean; style: string; color: string; size: string; store: string; dcNumber: string | null; moNumber: string }>
}
