'use client'

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  Plus, Search, RefreshCw, AlertCircle, Check, X, PackageCheck, ChevronDown, ChevronRight, Ban, Printer, FileText,
  Download, Loader2, CalendarDays, Hourglass, ShoppingCart, AlarmClock, List, Lock,
} from 'lucide-react'
import { api, ApiError, can, currentUser, type Paginated } from '@/lib/api'
import { RequisitionDialog } from '@/components/inventory/RequisitionDialog'
import { ProcessDialog } from '@/components/inventory/ProcessDialog'
import { ReservationsView } from '@/components/inventory/ReservationsView'
import { IndentsView } from '@/components/inventory/IndentsView'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { FilterMenu, type FilterChoice } from '@/components/masters/FilterMenu'
import { KpiTile, TONE } from '@/components/dashboard/DashKit'
import { Pagination } from '@/components/tables/Pagination'
import { RowPanel } from '@/components/tables/RowPanel'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { formatDate, itemsPreview } from '@/lib/utils'

/**
 * Material requisitions: asked for, allowed, handed over.
 *
 * Three states rather than two, because "approved" and "issued" are genuinely
 * different days in a mill. A requisition approved on Monday and still sitting
 * unissued on Thursday is a cutting room waiting, and lumping it in with the
 * ones already collected would hide that completely.
 *
 * The list is filtered on the screen, like job work and customer material: the
 * whole set is small, and a filter can then say how many each choice leaves.
 */

interface Line {
  id: string
  requestedQty: string | number
  issuedQty: string | number
  /** Off the rack, or to be bought. Absent on rows written before the choice
      existed, which all meant the rack. */
  fulfilment?: 'FROM_STOCK' | 'PURCHASE'
  /** How much of the line the store decided to buy. Null on lines decided before it could be set. */
  purchaseQty?: string | number | null
  purpose: string | null
  item: {
    id: string
    code: string
    name: string
    uom: { symbol: string }
    category?: { name: string; parent: { name: string } | null } | null
  }
  warehouse: { id: string; name: string }
  ownership?: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomer?: { id: string; name: string } | null
  /** Stock held on the rack for this line. */
  reservations?: Array<{ id: string; warehouseId: string; qty: string | number }>
  /** What this line could take from the stores now: our stock less what others reserved, or the customer's stock. */
  available?: number
}

interface Requisition {
  id: string
  mrNumber: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  requestDate: string
  requiredDate: string | null
  issuedAt: string | null
  rejectionReason: string | null
  notes: string | null
  department: { id: string; name: string }
  raisedBy: { id: string; name: string } | null
  approvedBy: { id: string; name: string } | null
  /** The sales order the material is for, and its customer. */
  so?: { id: string; soNumber: string; customer: { id: string; name: string } } | null
  issuedBy: { id: string; name: string } | null
  /** Cancelled, or closed with part still owed: nothing more is issued. */
  closedAt: string | null
  closeReason: string | null
  closedBy: { id: string; name: string } | null
  lines: Line[]
}

const dayKey = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000)

/** Something from the store is still owed on it, and some has been handed over. */
const partlyIssued = (mr: Requisition) =>
  mr.lines.some((l) => Number(l.issuedQty) > 0) &&
  mr.lines.some((l) => Number(l.issuedQty) < Number(l.requestedQty))

/** How much of a line is to be bought; the whole line where it was marked before a quantity could be set. */
const buyQtyOf = (l: Line) =>
  l.purchaseQty !== null && l.purchaseQty !== undefined
    ? Number(l.purchaseQty)
    : // Only marked "buy": what is still owed, not the whole line again.
      l.fulfilment === 'PURCHASE'
      ? Math.max(0, Number(l.requestedQty) - Number(l.issuedQty))
      : 0

const qtyFmt = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/**
 * Where a requisition stands. One word each, in the order they happen, so the
 * status filter and the figures read the same as the badge on the row.
 */
type StageKey = 'approval' | 'handover' | 'partly' | 'purchase' | 'issued' | 'closed' | 'cancelled' | 'refused'

const STAGE: Record<StageKey, { label: string; cls: string; who: string }> = {
  approval: { label: 'Waiting for approval', cls: 'badge-warning', who: 'Approver' },
  handover: { label: 'To be issued', cls: 'badge-info', who: 'Store' },
  partly: { label: 'Part issued', cls: 'badge-warning', who: 'Store' },
  purchase: { label: 'Waiting for purchase', cls: 'badge-info', who: 'Buyer' },
  issued: { label: 'Issued', cls: 'badge-success', who: '' },
  closed: { label: 'Closed — part issued', cls: 'badge-neutral', who: '' },
  cancelled: { label: 'Cancelled', cls: 'badge-neutral', who: '' },
  refused: { label: 'Refused', cls: 'badge-danger', who: '' },
}
const STAGE_ORDER = Object.keys(STAGE) as StageKey[]
/** Still somebody's to do. */
const OPEN_STAGES: StageKey[] = ['approval', 'handover', 'partly', 'purchase']

function stageKey(mr: Requisition): StageKey {
  if (mr.closedAt) return mr.lines.some((l) => Number(l.issuedQty) > 0) ? 'closed' : 'cancelled'
  if (mr.status === 'REJECTED') return 'refused'
  if (mr.status === 'PENDING') return 'approval'
  if (mr.issuedAt) return 'issued'
  // Everything still owed is on the indent: the next move is the buyer's.
  const owedLines = mr.lines.filter((l) => Number(l.issuedQty) < Number(l.requestedQty))
  if (owedLines.length && owedLines.every((l) => buyQtyOf(l) >= Number(l.requestedQty) - Number(l.issuedQty) - 1e-9))
    return 'purchase'
  return partlyIssued(mr) ? 'partly' : 'handover'
}

/**
 * What happens next, and who has to do it, in a sentence.
 *
 * The status on its own was not enough. "Waiting for approval" is true, but it
 * leaves the person who raised it looking for a button that is deliberately not
 * there — so this says whose move it is and where they make it.
 */
function nextStep(mr: Requisition, key: StageKey, isMine: boolean, iApproved: boolean, admin: boolean): string | undefined {
  switch (key) {
    case 'closed':
    case 'cancelled':
      return `${mr.closeReason ?? ''}${mr.closedBy ? ` — ${mr.closedBy.name}` : ''}` || undefined
    case 'approval':
      return isMine
        ? admin
          ? 'You raised it. As admin you can approve it yourself, or leave it for someone else.'
          : 'You raised it, so somebody else has to approve it — on this screen or from the dashboard.'
        : 'Yours to approve or refuse.'
    case 'purchase':
      return `${mr.lines.some((l) => Number(l.issuedQty) > 0) ? 'Part issued; the rest' : 'What is owed'} is on the indent for the buyer. When it arrives on a goods receipt, press Process to issue it.`
    case 'partly': {
      const full = mr.lines.filter((l) => Number(l.issuedQty) >= Number(l.requestedQty)).length
      return `${full} of ${mr.lines.length} ${mr.lines.length === 1 ? 'line' : 'lines'} issued in full. Press Process to issue the rest, or close it if it is no longer wanted.`
    }
    case 'handover':
      // Raised, approved and issued by three different people (the Admin may
      // do all three), so the two who have had their say are told whose turn it is.
      return (isMine || iApproved) && !admin
        ? `You ${isMine ? 'raised' : 'approved'} it, so somebody else in the store issues it. You can still press Process to reserve or buy.`
        : 'Press Process to issue it, reserve it, or buy what is short.'
    default:
      return undefined
  }
}

/**
 * Asked, issued and still owed, per unit. Metres and pieces are never added
 * together; a requisition for both shows both. Lines to be bought are owed by
 * the buyer, not the store, so they are counted apart.
 */
function qtyByUnit(lines: Line[]) {
  const m = new Map<string, { uom: string; asked: number; issued: number; owed: number; toBuy: number }>()
  for (const l of lines) {
    const u = l.item.uom.symbol
    const cur = m.get(u) ?? { uom: u, asked: 0, issued: 0, owed: 0, toBuy: 0 }
    const asked = Number(l.requestedQty)
    const issued = Number(l.issuedQty)
    cur.asked += asked
    cur.issued += issued
    cur.owed += Math.max(0, asked - issued)
    cur.toBuy += buyQtyOf(l)
    m.set(u, cur)
  }
  return [...m.values()]
}

type UnitGroup = ReturnType<typeof qtyByUnit>[number]

/** The item panel's columns, as shares of the row, so the table fits the panel it opens in. */
const ITEM_COLS = [
  { label: 'Item', width: '25%' },
  { label: 'Code', width: '10%' },
  { label: 'What for', width: '12%' },
  { label: 'In stock', width: '9%', numeric: true },
  { label: 'Asked', width: '8%', numeric: true },
  { label: 'Issued', width: '9%', numeric: true },
  { label: 'Reserved', width: '9%', numeric: true },
  { label: 'Buying', width: '9%', numeric: true },
  { label: 'Still needed', width: '9%', numeric: true },
]
/** One figure per unit on one line: "1,000 mtr · 250 pcs", or null when all are nil. */
const unitLine = (groups: UnitGroup[], pick: (g: UnitGroup) => number) => {
  const parts = groups
    .map((g) => ({ uom: g.uom, v: pick(g) }))
    .filter((g) => g.v > 0)
    .map((g) => `${qtyFmt(g.v)} ${g.uom}`)
  return parts.length ? parts.join(' · ') : null
}

/** When it is wanted by, against today. Only an open requisition can be late. */
type NeedKey = 'late' | 'soon' | 'later' | 'nodate' | 'done'
const NEED_LABEL: Record<NeedKey, string> = {
  late: 'Past the needed-by date',
  soon: 'Needed within 3 days',
  later: 'Needed later',
  nodate: 'No date given',
  done: 'Finished',
}

function presetRange(p: string): { from: string; to: string } {
  const now = new Date()
  const today = dayKey(now)
  const back = (days: number) => dayKey(new Date(now.getTime() - days * 86400000))
  switch (p) {
    case 'today':
      return { from: today, to: today }
    case '7d':
      return { from: back(6), to: today }
    case '30d':
      return { from: back(29), to: today }
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today }
    case 'fy': {
      const y = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0)
      return { from: `${y}-04-01`, to: today }
    }
    default:
      return { from: '', to: '' }
  }
}

const PRESETS = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'month', label: 'This month' },
  { key: 'fy', label: 'This FY' },
]

const PAGE = 50

type FilterKey = 'stage' | 'department' | 'raisedBy' | 'store' | 'category' | 'need'

export default function RequisitionsPage() {
  return (
    <Suspense>
      <RequisitionsScreen />
    </Suspense>
  )
}

function RequisitionsScreen() {
  // Two tabs: the requisitions themselves, and the stock held for them.
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  type View = 'list' | 'indents' | 'reservations'
  const asked = params.get('view')
  const view: View = asked === 'reservations' || asked === 'indents' ? asked : 'list'
  const setView = (v: View) => {
    const next = new URLSearchParams(params.toString())
    if (v !== 'list') next.set('view', v)
    else next.delete('view')
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const me = currentUser()
  // The Admin may approve a requisition they raised themselves; the server says the same.
  const admin = me?.role === 'Admin'

  const [rows, setRows] = useState<Requisition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<Partial<Record<FilterKey, string[]>>>({})
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [preset, setPreset] = useState('all')
  const [page, setPage] = useState(1)

  const [open, setOpen] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)
  // The requisition being handed over, and the one a reason is being asked for.
  const [fulfilling, setFulfilling] = useState<Requisition | null>(null)
  // Bumped after a save, so the Indents and Reservations tabs read again.
  const [saved, setSaved] = useState(0)
  const [asking, setAsking] = useState<{ mr: Requisition; kind: 'reject' | 'close' } | null>(null)

  const today = dayKey(new Date())

  const latest = useRef(0)
  const load = useCallback(async () => {
    const id = ++latest.current
    setLoading(true)
    setError(null)
    try {
      // Every requisition, a page of 200 at a time: the filters and their counts work on the whole set.
      const all: Requisition[] = []
      for (let p = 1; ; p++) {
        const res = await api.get<Paginated<Requisition>>(`/inventory/requisitions?limit=200&page=${p}`)
        all.push(...res.data)
        if (p >= res.pagination.pages) break
      }
      if (id !== latest.current) return
      setRows(all)
    } catch (err) {
      if (id !== latest.current) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing requisitions.'
            : err.message
          : 'Could not reach the server. Is the API running?',
      )
      setRows([])
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setPage(1)
  }, [search, picked, from, to])

  /* ── what each row is, worked out once ── */
  const facts = useMemo(() => {
    const m = new Map<string, { stage: StageKey; need: NeedKey; daysLate: number; groups: UnitGroup[] }>()
    for (const mr of rows) {
      const stage = stageKey(mr)
      const due = mr.requiredDate ? dayKey(mr.requiredDate) : null
      const daysLate = due ? daysBetween(due, today) : 0
      const need: NeedKey = !OPEN_STAGES.includes(stage)
        ? 'done'
        : !due
          ? 'nodate'
          : daysLate > 0
            ? 'late'
            : daysLate >= -3
              ? 'soon'
              : 'later'
      m.set(mr.id, { stage, need, daysLate, groups: qtyByUnit(mr.lines) })
    }
    return m
  }, [rows, today])
  const fact = (mr: Requisition) => facts.get(mr.id)!

  /** The values a row has for each filter; a requisition can draw on several stores and categories. */
  const valuesOf: Record<FilterKey, (mr: Requisition) => string[]> = useMemo(
    () => ({
      stage: (mr) => [facts.get(mr.id)?.stage ?? 'issued'],
      department: (mr) => [mr.department.id],
      raisedBy: (mr) => [mr.raisedBy?.id ?? 'none'],
      store: (mr) => [...new Set(mr.lines.map((l) => l.warehouse.id))],
      category: (mr) => [...new Set(mr.lines.map((l) => l.item.category?.parent?.name ?? l.item.category?.name ?? 'none'))],
      need: (mr) => [facts.get(mr.id)?.need ?? 'done'],
    }),
    [facts],
  )

  const FILTERS: Array<{ key: FilterKey; label: string; labelOf: (mr: Requisition, value: string) => string; order?: string[] }> = [
    { key: 'stage', label: 'Status', labelOf: (_, v) => STAGE[v as StageKey].label, order: STAGE_ORDER },
    { key: 'department', label: 'Department', labelOf: (mr) => mr.department.name },
    { key: 'raisedBy', label: 'Raised by', labelOf: (mr) => mr.raisedBy?.name ?? 'Not recorded' },
    { key: 'store', label: 'Store', labelOf: (mr, v) => mr.lines.find((l) => l.warehouse.id === v)?.warehouse.name ?? v },
    { key: 'category', label: 'Category', labelOf: (_, v) => (v === 'none' ? 'No category' : v) },
    { key: 'need', label: 'Needed by', labelOf: (_, v) => NEED_LABEL[v as NeedKey], order: Object.keys(NEED_LABEL) },
  ]

  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matchesSearch = useCallback(
    (mr: Requisition) => {
      if (!words.length) return true
      const hay = `${mr.mrNumber} ${mr.department.name} ${mr.so?.soNumber ?? ''} ${mr.so?.customer.name ?? ''} ${mr.raisedBy?.name ?? ''} ${mr.approvedBy?.name ?? ''} ${mr.notes ?? ''} ${mr.lines
        .map((l) => `${l.item.code} ${l.item.name} ${l.purpose ?? ''} ${l.ownerCustomer?.name ?? ''}`)
        .join(' ')}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search],
  )
  const inPeriod = useCallback(
    (mr: Requisition) => {
      const d = dayKey(mr.requestDate)
      return (!from || d >= from) && (!to || d <= to)
    },
    [from, to],
  )

  /** Whether a row passes every filter except `skip` (a filter never narrows its own counts). */
  const passes = useCallback(
    (mr: Requisition, skip?: FilterKey) =>
      inPeriod(mr) &&
      matchesSearch(mr) &&
      (Object.entries(picked) as Array<[FilterKey, string[]]>).every(
        ([k, values]) => k === skip || !values?.length || valuesOf[k](mr).some((v) => values.includes(v)),
      ),
    [picked, matchesSearch, inPeriod, valuesOf],
  )

  const shown = useMemo(() => rows.filter((mr) => passes(mr)), [rows, passes])

  const choicesFor = (key: FilterKey): FilterChoice[] | undefined => {
    if (loading && !rows.length) return undefined
    const def = FILTERS.find((f) => f.key === key)!
    const labels = new Map<string, string>()
    const counts = new Map<string, number>()
    for (const mr of rows) {
      const ok = passes(mr, key)
      for (const v of valuesOf[key](mr)) {
        if (!labels.has(v)) labels.set(v, def.labelOf(mr, v))
        if (ok) counts.set(v, (counts.get(v) ?? 0) + 1)
      }
    }
    const rank = (v: string) => (def.order ? def.order.indexOf(v) : 0)
    return [...labels.entries()]
      .map(([value, label]) => ({ value, label, count: counts.get(value) ?? 0 }))
      .sort((a, b) =>
        def.order
          ? rank(a.value) - rank(b.value)
          : a.value === 'none'
            ? 1
            : b.value === 'none'
              ? -1
              : a.label.localeCompare(b.label),
      )
  }

  const setFilter = (key: FilterKey, values: string[]) => setPicked((p) => ({ ...p, [key]: values }))
  const sameAs = (a: string[] | undefined, b: string[]) => (a?.length ?? 0) === b.length && b.every((v) => a?.includes(v))
  const toggleTo = (key: FilterKey, values: string[]) =>
    setPicked((p) => ({ ...p, [key]: sameAs(p[key], values) ? [] : values }))
  const isSet = (key: FilterKey, values: string[]) => sameAs(picked[key], values)

  const chips = FILTERS.flatMap((f) => {
    const values = picked[f.key] ?? []
    if (!values.length) return []
    const choices = choicesFor(f.key) ?? []
    return values.map((v) => ({ key: f.key, value: v, text: `${f.label}: ${choices.find((c) => c.value === v)?.label ?? '…'}` }))
  })
  const narrowed = chips.length > 0 || words.length > 0 || !!from || !!to
  const clearAll = () => {
    setPicked({})
    setSearch('')
    setFrom('')
    setTo('')
    setPreset('all')
  }
  const pickPreset = (key: string) => {
    setPreset(key)
    if (key === 'custom') return
    const r = presetRange(key)
    setFrom(r.from)
    setTo(r.to)
  }

  /* ── the figures: each counts what the other filters leave, so a tile never hides itself ── */
  const figures = useMemo(() => {
    const byStage = rows.filter((mr) => passes(mr, 'stage'))
    const inStage = (keys: StageKey[]) => byStage.filter((mr) => keys.includes(fact(mr).stage))
    const approval = inStage(['approval'])
    const handover = inStage(['handover', 'partly'])
    const purchase = inStage(['purchase'])
    const late = rows.filter((mr) => passes(mr, 'need') && fact(mr).need === 'late')
    // Totals per unit across the requisitions, never adding metres to pieces.
    const sum = (rs: Requisition[], pick: (g: UnitGroup) => number) => {
      const m = new Map<string, number>()
      for (const g of rs.flatMap((mr) => fact(mr).groups)) m.set(g.uom, (m.get(g.uom) ?? 0) + pick(g))
      const parts = [...m.entries()].filter(([, v]) => v > 0).map(([uom, v]) => `${qtyFmt(v)} ${uom}`)
      return parts.length ? parts.join(' · ') : null
    }
    const oldest = approval.length ? Math.max(...approval.map((mr) => daysBetween(dayKey(mr.requestDate), today))) : 0
    return {
      approval: approval.length,
      oldestApproval: oldest,
      handover: handover.length,
      handoverQty: sum(handover, (g) => Math.max(0, g.owed - g.toBuy)),
      purchase: purchase.length,
      purchaseQty: sum(purchase, (g) => g.toBuy),
      late: late.length,
      mostLate: late.length ? Math.max(...late.map((mr) => fact(mr).daysLate)) : 0,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, passes, facts, today])

  const act = async (mr: Requisition, what: 'approve' | 'reject' | 'close', reason?: string) => {
    setBusy(mr.id)
    setError(null)
    setMessage(null)
    try {
      const res =
        what === 'close'
          ? await api.post<{ message?: string }>(`/inventory/requisitions/${mr.id}/close`, { reason })
          : await api.patch<{ message?: string }>(
              `/inventory/requisitions/${mr.id}/${what}`,
              what === 'reject' ? { reason } : {},
            )
      setAsking(null)
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setAsking(null)
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(null)
    }
  }

  /** What the filters leave, as a spreadsheet: one row per item, with its requisition beside it. */
  const exportRows = async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const sheet = XLSX.utils.json_to_sheet(
        shown.flatMap((mr) => {
          const f = fact(mr)
          return mr.lines.map((l) => {
            const asked = Number(l.requestedQty)
            const issued = Number(l.issuedQty)
            const open = OPEN_STAGES.includes(f.stage)
            return {
              Requisition: mr.mrNumber,
              Date: dayKey(mr.requestDate),
              Department: mr.department.name,
              'Raised By': mr.raisedBy?.name ?? '',
              'Approved By': mr.approvedBy?.name ?? '',
              'Sales Order': mr.so?.soNumber ?? '',
              Customer: mr.so?.customer.name ?? '',
              'Needed By': mr.requiredDate ? dayKey(mr.requiredDate) : '',
              Status: STAGE[f.stage].label,
              'Waiting On': STAGE[f.stage].who,
              'Item Code': l.item.code,
              'Item Name': l.item.name,
              Category: l.item.category?.parent?.name ?? l.item.category?.name ?? '',
              'Sub Category': l.item.category?.parent ? l.item.category.name : '',
              Whose: l.ownership === 'CUSTOMER_OWNED' ? (l.ownerCustomer?.name ?? 'Customer') : 'Our own',
              Store: l.warehouse.name,
              Unit: l.item.uom.symbol,
              Asked: asked,
              Issued: issued,
              'Still Owed': open ? Math.max(0, asked - issued) : 0,
              'To Buy': buyQtyOf(l),
              'What For': l.purpose ?? '',
              Note: mr.notes ?? '',
              'Refusal / Close Reason': mr.rejectionReason ?? mr.closeReason ?? '',
            }
          })
        }),
      )
      sheet['!cols'] = [16, 11, 16, 18, 18, 14, 24, 11, 20, 10, 14, 30, 16, 16, 16, 22, 6, 9, 9, 10, 9, 22, 24, 26].map((wch) => ({ wch }))
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, 'Requisitions')
      XLSX.writeFile(book, `material-requisitions-${today}.xlsx`)
    } catch {
      setError('Could not build the spreadsheet.')
    } finally {
      setExporting(false)
    }
  }

  // The person who raised it may withdraw it; the store or an approver may
  // close it. The server holds the same rule.
  const mayClose = (mr: Requisition, isMine: boolean) =>
    !mr.closedAt &&
    mr.status !== 'REJECTED' &&
    !mr.issuedAt &&
    (isMine || can('inventory', 'edit') || can('inventory', 'approve'))

  /** What one row needs to draw itself, worked out once for the card and the table alike. */
  const rowFacts = (mr: Requisition) => {
    // The server refuses these too; hiding a button just avoids offering a door that is certain to be shut.
    const isMine = Boolean(me?.id && mr.raisedBy?.id === me.id)
    const iApproved = Boolean(me?.id && mr.approvedBy?.id === me.id)
    const f = fact(mr)
    const s = { ...STAGE[f.stage], next: nextStep(mr, f.stage, isMine, iApproved, admin), waiting: f.stage === 'purchase' }
    const canDecide = mr.status === 'PENDING' && !mr.closedAt && (!isMine || admin)
    // Approved with something still owed: the store hands it over, buys it, or both.
    const canFulfil =
      mr.status === 'APPROVED' && !mr.closedAt && mr.lines.some((l) => Number(l.issuedQty) < Number(l.requestedQty))
    const actions: RowAction[] = []
    if (canDecide)
      actions.push({ key: 'refuse', label: 'Refuse', icon: <X size={14} />, onClick: () => setAsking({ mr, kind: 'reject' }), danger: true })
    if (mr.status === 'APPROVED')
      actions.push({ key: 'slip', label: 'Print issue slip', icon: <Printer size={14} />, href: `/print/material-issue/${mr.id}`, newTab: true })
    if (mayClose(mr, isMine))
      actions.push({
        key: 'close',
        label: partlyIssued(mr) ? 'Close — the rest is not needed' : 'Cancel requisition',
        icon: <Ban size={14} />,
        onClick: () => setAsking({ mr, kind: 'close' }),
        danger: true,
      })
    return { ...f, isMine, iApproved, s, canDecide, canFulfil, actions }
  }
  type Facts = ReturnType<typeof rowFacts>

  /** The one thing most likely to be done next to this row, as a button. */
  const primaryAction = (mr: Requisition, r: Facts) =>
    r.canDecide ? (
      <button className="btn-primary h-7 px-2.5 text-xs" onClick={() => void act(mr, 'approve')} disabled={busy === mr.id}>
        <Check size={13} /> Approve
      </button>
    ) : r.canFulfil ? (
      <button
        className={`${r.s.waiting ? 'btn-secondary' : 'btn-primary'} h-7 px-2.5 text-xs`}
        onClick={() => setFulfilling(mr)}
        disabled={busy === mr.id}
        title={r.s.waiting ? 'Waiting on the buyer; open it to see what has happened, or change the plan' : 'Issue it, buy what is short, or both'}
      >
        <PackageCheck size={13} /> Process
      </button>
    ) : null

  /** The panel under an opened row: every line as a proper table, as on the purchase lists. */
  const itemPanel = (mr: Requisition, r: Facts) => {
    return (
      <RowPanel icon={FileText} title="Item Details" note={`${mr.lines.length} ${mr.lines.length === 1 ? 'line' : 'lines'} on ${mr.mrNumber}`}>
        <table className="subtable w-full table-fixed">
          <thead className="sticky top-0 z-10">
            <tr>
              {ITEM_COLS.map((c) => (
                <th key={c.label} style={{ width: c.width }} className={c.numeric ? 'text-right' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mr.lines.map((l) => {
              const asked = Number(l.requestedQty)
              const issued = Number(l.issuedQty)
              const owed = Math.max(0, asked - issued)
              const buying = buyQtyOf(l)
              const held = (l.reservations ?? []).reduce((t, r) => t + Number(r.qty), 0)
              return (
                <tr key={l.id}>
                  <td>
                    <div className="text-foreground truncate text-xs font-medium" title={l.item.name}>
                      {l.item.name}
                    </div>
                    {l.ownership === 'CUSTOMER_OWNED' && (
                      <div className="truncate text-[10px] text-sky-500">{l.ownerCustomer?.name ?? 'Customer'}&apos;s material</div>
                    )}
                  </td>
                  <td className="text-muted-foreground whitespace-nowrap font-mono text-xs">{l.item.code}</td>
                  <td className="truncate text-xs" title={l.purpose ?? undefined}>
                    {l.purpose ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="whitespace-nowrap text-right text-xs tabular-nums">
                    <span className={(l.available ?? 0) + 1e-9 >= owed || owed === 0 ? 'font-semibold text-emerald-600' : 'font-semibold text-red-500'}>
                      {qtyFmt(l.available ?? 0)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-right text-xs tabular-nums">
                    {qtyFmt(asked)} {l.item.uom.symbol}
                  </td>
                  <td className="whitespace-nowrap text-right text-xs tabular-nums">
                    {issued > 0 ? <span className="text-emerald-500">{qtyFmt(issued)}</span> : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="whitespace-nowrap text-right text-xs tabular-nums">
                    {held > 0 ? <span className="text-violet-500">{qtyFmt(held)}</span> : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="whitespace-nowrap text-right text-xs tabular-nums">
                    {buying > 0 ? <span className="text-sky-500">{qtyFmt(buying)}</span> : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="whitespace-nowrap text-right text-xs tabular-nums">
                    {mr.closedAt || mr.status === 'REJECTED' || owed === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="text-amber-500">{qtyFmt(owed)}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="border-border text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-[11px]">
          <span>
            {r.s.next && <>{r.s.next} </>}
            {mr.so && <>For {mr.so.customer.name} ({mr.so.soNumber}). </>}
            {mr.approvedBy && <>Approved by {mr.approvedBy.name}. </>}
            {mr.issuedBy && mr.issuedAt && <>Issued by {mr.issuedBy.name} on {formatDate(mr.issuedAt)}. </>}
            {mr.closedAt && (
              <>
                {mr.lines.some((l) => Number(l.issuedQty) > 0) ? 'Closed' : 'Cancelled'}
                {mr.closedBy && <> by {mr.closedBy.name}</>} on {formatDate(mr.closedAt)}
                {mr.closeReason && <>: {mr.closeReason}</>}.{' '}
              </>
            )}
            {mr.status === 'REJECTED' && mr.rejectionReason && <>Refused: {mr.rejectionReason}. </>}
            {mr.notes && <>Note: {mr.notes}</>}
          </span>
          {r.canFulfil && (
            <button className="btn-primary ml-auto h-7 px-2.5 text-xs" onClick={() => setFulfilling(mr)}>
              <PackageCheck size={13} /> Process
            </button>
          )}
        </div>
      </RowPanel>
    )
  }

  /** "Needed by", red once the day has gone while it is still open. */
  const neededBy = (mr: Requisition, r: Facts) =>
    mr.requiredDate ? (
      <span className={r.need === 'late' ? 'font-medium text-red-500' : r.need === 'soon' ? 'text-amber-500' : undefined}>
        {formatDate(mr.requiredDate)}
        {r.need === 'late' && <span className="block text-[10px]">{r.daysLate} {r.daysLate === 1 ? 'day' : 'days'} late</span>}
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    )

  const dash = <span className="text-muted-foreground">—</span>
  /** A figure per unit, one unit to a line, so a column stays narrow when a requisition mixes metres and pieces. */
  const unitStack = (groups: UnitGroup[], pick: (g: UnitGroup) => number, cls?: string) => {
    const parts = groups.filter((g) => pick(g) > 0)
    return parts.length
      ? parts.map((g) => (
          <div key={g.uom} className={cls}>
            {qtyFmt(pick(g))} {g.uom}
          </div>
        ))
      : dash
  }

  const pages = Math.ceil(shown.length / PAGE) || 1
  const pageRows = shown.slice((page - 1) * PAGE, page * PAGE)
  const COLS = 13

  return (
    <div className="space-y-4">
      {/* The title, the two tabs beside it, and the buttons on the right: one line, as on Job Work. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="page-title">Material Requisitions</h1>
          <div className="flex rounded-lg border border-border bg-secondary p-1" role="tablist">
            {([
              { key: 'list', label: 'Requisitions', icon: List },
              { key: 'indents', label: 'Indents', icon: ShoppingCart },
              { key: 'reservations', label: 'Reservations', icon: Lock },
            ] as const).map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={view === t.key}
                onClick={() => setView(t.key)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  view === t.key ? 'bg-card font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <t.icon size={15} /> {t.label}
              </button>
            ))}
          </div>
        </div>
        {view === 'list' && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} title="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button
            className="btn-secondary"
            onClick={() => void exportRows()}
            disabled={exporting || shown.length === 0}
            title={narrowed ? 'Export the requisitions the filters leave' : 'Export every requisition'}
          >
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Export
          </button>
          <button className="btn-primary" onClick={() => setDialog(true)}>
            <Plus size={15} /> New requisition
          </button>
        </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="flex-1 text-sm text-red-400">{error}</p>
          <button type="button" onClick={() => setError(null)} className="text-red-400" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="text-sm text-emerald-400">{message}</p>
        </div>
      )}

      {view === 'reservations' && <ReservationsView key={saved} />}
      {view === 'indents' && (
        <IndentsView
          key={saved}
          onProcess={(id) => {
            const found = rows.find((r) => r.id === id)
            if (found) setFulfilling(found)
          }}
        />
      )}

      {view === 'list' && (
      <>
      {/* Each tile is a filter: click to show only those, click again to show all. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiTile
          icon={Hourglass}
          tone={TONE.amber}
          label="Waiting for approval"
          value={String(figures.approval)}
          valueClass={figures.approval ? 'text-amber-500' : 'text-foreground'}
          sub={
            isSet('stage', ['approval'])
              ? 'showing only these · click to show all'
              : figures.approval
                ? `oldest raised ${figures.oldestApproval === 0 ? 'today' : `${figures.oldestApproval} ${figures.oldestApproval === 1 ? 'day' : 'days'} ago`}`
                : 'nothing to approve'
          }
          onClick={() => toggleTo('stage', ['approval'])}
          active={isSet('stage', ['approval'])}
        />
        <KpiTile
          icon={PackageCheck}
          tone={TONE.teal}
          label="To be issued"
          value={String(figures.handover)}
          sub={
            isSet('stage', ['handover', 'partly'])
              ? 'showing only these · click to show all'
              : figures.handover
                ? `${figures.handoverQty ?? 'nothing'} for the store to give`
                : 'nothing waiting at the store'
          }
          onClick={() => toggleTo('stage', ['handover', 'partly'])}
          active={isSet('stage', ['handover', 'partly'])}
        />
        <KpiTile
          icon={ShoppingCart}
          tone={TONE.sky}
          label="Waiting for purchase"
          value={String(figures.purchase)}
          sub={
            isSet('stage', ['purchase'])
              ? 'showing only these · click to show all'
              : figures.purchase
                ? `${figures.purchaseQty ?? 'nothing'} on the indent`
                : 'nothing waiting on the buyer'
          }
          onClick={() => toggleTo('stage', ['purchase'])}
          active={isSet('stage', ['purchase'])}
        />
        <KpiTile
          icon={AlarmClock}
          tone={TONE.rose}
          label="Past the needed-by date"
          value={String(figures.late)}
          valueClass={figures.late ? 'text-rose-500' : 'text-foreground'}
          sub={
            isSet('need', ['late'])
              ? 'showing only these · click to show all'
              : figures.late
                ? `the latest is ${figures.mostLate} ${figures.mostLate === 1 ? 'day' : 'days'} late`
                : 'nothing late'
          }
          onClick={() => toggleTo('need', ['late'])}
          active={isSet('need', ['late'])}
        />
      </div>

      {/* Raised so an open dropdown lies over the table below. */}
      <div className="glass-card relative z-30 space-y-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-10 min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              placeholder="Search requisition, department, customer, item..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search requisitions"
            />
            {search && (
              <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="text-muted-foreground">
                <X size={14} />
              </button>
            )}
          </div>
          <select
            className="h-10 cursor-pointer rounded-lg border border-border bg-secondary px-2 text-sm text-foreground outline-none"
            value={preset}
            onChange={(e) => pickPreset(e.target.value)}
            aria-label="Period"
          >
            {PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
          {FILTERS.filter((f) => ['stage', 'department', 'need'].includes(f.key)).map((f) => (
            <FilterMenu key={f.key} label={f.label} choices={choicesFor(f.key)} selected={picked[f.key] ?? []} onChange={(next) => setFilter(f.key, next)} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button
              key={`${c.key}-${c.value}`}
              type="button"
              onClick={() => setFilter(c.key, (picked[c.key] ?? []).filter((v) => v !== c.value))}
              className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-foreground"
            >
              {c.text} <X size={11} />
            </button>
          ))}
          {narrowed && (
            <button type="button" onClick={clearAll} className="text-xs text-teal-500 hover:underline">
              Clear all
            </button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {narrowed ? `${shown.length} of ${rows.length}` : rows.length} {rows.length === 1 ? 'requisition' : 'requisitions'}
          </span>
        </div>
      </div>

      <div className="glass-card overflow-hidden p-0">
        {loading && rows.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
        ) : shown.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              {narrowed ? 'Nothing matches that.' : 'Nothing here. A requisition is how the cutting room asks the store for fabric.'}
            </p>
          </div>
        ) : (
          <div className={`list-scope transition-opacity ${loading ? 'opacity-60' : ''}`}>
            {/* On a phone each requisition is a card; the table is for a wider list. */}
            <div className="list-cards divide-border divide-y">
              {pageRows.map((mr) => {
                const r = rowFacts(mr)
                const expanded = open === mr.id
                return (
                  <div key={mr.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-teal-400">{mr.mrNumber}</span>
                          <span className={r.s.cls}>{r.s.label}</span>
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">{mr.department.name}</p>
                      </div>
                      <span className="text-muted-foreground shrink-0 text-right text-xs">
                        {mr.lines.length} {mr.lines.length === 1 ? 'item' : 'items'}
                      </span>
                    </div>
                    <dl className="mt-2.5 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Date</dt>
                      <dd className="text-foreground min-w-0">{formatDate(mr.requestDate)}</dd>
                      <dt className="text-muted-foreground">Raised by</dt>
                      <dd className="text-foreground min-w-0">{mr.raisedBy?.name ?? '—'}</dd>
                      {mr.requiredDate && (
                        <>
                          <dt className="text-muted-foreground">Needed by</dt>
                          <dd className="min-w-0">{neededBy(mr, r)}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">Asked</dt>
                      <dd className="text-foreground min-w-0 tabular-nums">{unitLine(r.groups, (g) => g.asked) ?? '—'}</dd>
                      <dt className="text-muted-foreground">Issued</dt>
                      <dd className="min-w-0 tabular-nums text-emerald-500">{unitLine(r.groups, (g) => g.issued) ?? dash}</dd>
                      <dt className="text-muted-foreground">Still needed</dt>
                      <dd className="min-w-0 tabular-nums text-amber-500">
                        {OPEN_STAGES.includes(r.stage) ? (unitLine(r.groups, (g) => g.owed) ?? dash) : dash}
                      </dd>
                      {OPEN_STAGES.includes(r.stage) && unitLine(r.groups, (g) => g.toBuy) && (
                        <>
                          <dt className="text-muted-foreground">To buy</dt>
                          <dd className="min-w-0 tabular-nums text-sky-500">{unitLine(r.groups, (g) => g.toBuy)}</dd>
                        </>
                      )}
                      {r.s.who && (
                        <>
                          <dt className="text-muted-foreground">Waiting on</dt>
                          <dd className="text-foreground min-w-0">{r.s.who}</dd>
                        </>
                      )}
                    </dl>
                    {r.s.next && <p className="text-muted-foreground mt-2 text-[11px]">{r.s.next}</p>}
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <button
                        onClick={() => setOpen(expanded ? null : mr.id)}
                        className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                        aria-expanded={expanded}
                      >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {expanded ? 'Hide items' : 'Show items'}
                      </button>
                      <div className="flex items-center gap-1.5">
                        {primaryAction(mr, r)}
                        {r.actions.length > 0 && <ActionMenu label={`Actions for ${mr.mrNumber}`} items={r.actions} />}
                      </div>
                    </div>
                    {expanded && <div className="mt-2.5">{itemPanel(mr, r)}</div>}
                  </div>
                )
              })}
            </div>

            <div className="list-rows w-full">
              <ScrollableTable>
                <table className="data-table table-compact min-w-full">
                  <thead>
                    <tr className="bg-secondary">
                      <th style={{ width: 30 }} />
                      <th className="whitespace-nowrap">Req. No.</th>
                      <th className="whitespace-nowrap">Date</th>
                      <th className="whitespace-nowrap">Department</th>
                      <th className="whitespace-nowrap">For</th>
                      <th className="whitespace-nowrap">Items</th>
                      <th className="whitespace-nowrap">Needed by</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Asked</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Issued</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Still needed</th>
                      <th className="whitespace-nowrap">Stock</th>
                      <th className="whitespace-nowrap">Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((mr) => {
                      const r = rowFacts(mr)
                      const expanded = open === mr.id
                      const live = OPEN_STAGES.includes(r.stage)
                      const p = itemsPreview(mr.lines.map((l) => l.item.name))
                      // Lines still needed that the stores cannot cover in full.
                      const openLines = live ? mr.lines.filter((l) => Number(l.requestedQty) - Number(l.issuedQty) > 1e-9) : []
                      const short = openLines.filter((l) => (l.available ?? 0) + 1e-9 < Number(l.requestedQty) - Number(l.issuedQty))
                      return (
                        <Fragment key={mr.id}>
                          <tr>
                            <td>
                              <button
                                className="bg-primary/10 text-primary hover:bg-primary/20 flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
                                onClick={() => setOpen(expanded ? null : mr.id)}
                                title={expanded ? 'Hide items' : 'Show items'}
                                aria-label={`${expanded ? 'Hide' : 'Show'} items on ${mr.mrNumber}`}
                                aria-expanded={expanded}
                              >
                                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                            </td>
                            <td className="whitespace-nowrap">
                              {mr.status === 'APPROVED' ? (
                                <a
                                  href={`/print/material-issue/${mr.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="font-mono text-xs font-semibold text-teal-400 hover:underline"
                                  title="Open the issue slip"
                                >
                                  {mr.mrNumber}
                                </a>
                              ) : (
                                <span className="font-mono text-xs font-semibold text-teal-400">{mr.mrNumber}</span>
                              )}
                            </td>
                            <td className="whitespace-nowrap text-xs">{formatDate(mr.requestDate)}</td>
                            <td className="whitespace-nowrap text-xs">{mr.department.name}</td>
                            <td className="whitespace-nowrap text-xs">{mr.so ? mr.so.customer.name : dash}</td>
                            <td className="text-xs">
                              <div className="text-foreground max-w-[14rem] truncate" title={p.full}>
                                {p.shown}
                                {p.extra && <span className="text-muted-foreground">{p.extra}</span>}
                              </div>
                            </td>
                            <td className="whitespace-nowrap text-xs">{neededBy(mr, r)}</td>
                            <td className="whitespace-nowrap text-right text-xs tabular-nums">{unitStack(r.groups, (g) => g.asked)}</td>
                            <td className="whitespace-nowrap text-right text-xs tabular-nums">{unitStack(r.groups, (g) => g.issued, 'text-emerald-500')}</td>
                            <td className="whitespace-nowrap text-right text-xs tabular-nums">
                              {live ? unitStack(r.groups, (g) => g.owed, 'font-medium text-amber-500') : dash}
                            </td>
                            <td className="whitespace-nowrap text-xs" title={short.map((l) => `${l.item.name}: ${qtyFmt(l.available ?? 0)} ${l.item.uom.symbol} in stock`).join('\n') || undefined}>
                              {!openLines.length ? (
                                dash
                              ) : short.length ? (
                                <span className="font-semibold text-red-500">
                                  Short on {short.length} of {openLines.length}
                                </span>
                              ) : (
                                <span className="font-semibold text-emerald-600">In stock</span>
                              )}
                            </td>
                            <td className="whitespace-nowrap">
                              <span className={r.s.cls} title={r.s.next}>
                                {r.s.label}
                              </span>
                              {mr.status === 'REJECTED' && mr.rejectionReason && (
                                <div className="text-muted-foreground max-w-[200px] truncate text-[10px]" title={mr.rejectionReason}>
                                  {mr.rejectionReason}
                                </div>
                              )}
                            </td>
                            <td className="whitespace-nowrap text-right">
                              <div className="flex justify-end gap-1.5">
                                {primaryAction(mr, r)}
                                {r.actions.length > 0 && <ActionMenu label={`Actions for ${mr.mrNumber}`} items={r.actions} />}
                              </div>
                            </td>
                          </tr>

                          {expanded && (
                            <tr>
                              <td colSpan={COLS} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                                {/* Sized to the visible row, not the scrolling table; see the purchase lists. */}
                                <div className="w-[100cqw]">{itemPanel(mr, r)}</div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </ScrollableTable>
            </div>
            <Pagination page={page} pages={pages} onPageChange={setPage} />
          </div>
        )}
      </div>
      </>
      )}

      {fulfilling && (
        <ProcessDialog
          mr={fulfilling}
          onClose={() => setFulfilling(null)}
          onDone={(msg) => {
            setSaved((n) => n + 1)
            setFulfilling(null)
            setMessage(msg)
            void load()
          }}
        />
      )}

      {asking && (
        <ReasonDialog
          title={
            asking.kind === 'reject'
              ? `Refuse ${asking.mr.mrNumber}?`
              : `${partlyIssued(asking.mr) ? 'Close' : 'Cancel'} ${asking.mr.mrNumber}?`
          }
          description={
            asking.kind === 'reject'
              ? 'Whoever raised it sees the reason, so say what they should do instead.'
              : partlyIssued(asking.mr)
                ? 'What was issued stays issued. The rest is no longer owed, and nothing more can be issued against it.'
                : 'Nothing has been issued. It comes off the list, and nothing can be issued against it.'
          }
          confirmLabel={
            asking.kind === 'reject' ? 'Refuse' : partlyIssued(asking.mr) ? 'Close it' : 'Cancel it'
          }
          danger
          minLength={5}
          placeholder={asking.kind === 'reject' ? 'e.g. Use the offcuts from lot 12 first' : 'e.g. Order for this style was dropped'}
          busy={busy === asking.mr.id}
          onConfirm={(reason) => void act(asking.mr, asking.kind, reason)}
          onCancel={() => setAsking(null)}
        />
      )}

      {dialog && (
        <RequisitionDialog
          onClose={() => setDialog(false)}
          onSaved={(msg) => {
            setDialog(false)
            setMessage(msg)
            void load()
          }}
        />
      )}
    </div>
  )
}
