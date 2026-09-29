'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle, RefreshCw, Search, X, Download, Loader2, Activity, ArrowDownToLine,
  ArrowUpFromLine, Users, CalendarDays, LayoutDashboard, List, Scale, Flame, Boxes, Gauge,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { FilterMenu, type FilterChoice } from '@/components/masters/FilterMenu'
import {
  CategoryTreemap, DepartmentRadar, DocumentBars, FlowChart, MovementDonut, StoreColumns,
} from '@/components/inventory/LedgerCharts'

/**
 * Every stock movement there has ever been.
 *
 * Read only, permanently. The balance on the stock screen is the sum of these
 * rows, so a ledger anybody could edit would make that figure meaningless —
 * and a stock figure nobody trusts is worse than no stock figure at all.
 *
 * The filtering is done by the server, since the ledger only grows. With each
 * page it sends what the filters leave in total, the value in and out by day,
 * and for every dropdown how many movements each choice would leave.
 */

interface Row {
  id: string
  transactionType: string
  referenceType: string | null
  inQty: string | number
  outQty: string | number
  closingStock: string | number
  unitRate: string | number | null
  transactionDate: string
  notes: string | null
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  item: { id: string; code: string; name: string; uom: { symbol: string } }
  warehouse: { id: string; name: string }
  ownerCustomer: { id: string; name: string } | null
  itemType: string
  mainCategoryName: string
  subCategoryName: string | null
  departmentName: string | null
  value: number | null
}

interface Summary {
  total: number
  ins: number
  outs: number
  inValue: number
  outValue: number
  items: number
  stores: number
  first: string | null
  last: string | null
}

interface Day {
  day: string
  inValue: number
  outValue: number
  moves: number
}

type FilterKey =
  | 'store' | 'movement' | 'document' | 'direction' | 'owner' | 'category' | 'sub' | 'department' | 'itemType'

interface Group {
  value: string
  label: string | null
  moves: number
  ins: number
  outs: number
  inValue: number
  outValue: number
}

interface Analysis {
  byStore: Group[]
  byCategory: Group[]
  byDepartment: Group[]
  byDocument: Group[]
  topItems: Array<Group & { code: string; uom: string; inQty: number; outQty: number }>
}

interface LedgerResponse {
  data: Row[]
  pagination: { page: number; pages: number; total: number }
  summary: Summary
  series: Day[]
  facets: Record<FilterKey, Array<{ value: string; label: string | null; count: number }>>
  /** Only when the dashboard asks for it. */
  analysis?: Analysis
}

const MOVEMENT: Record<string, { label: string; cls: string }> = {
  OPENING: { label: 'Opening', cls: 'badge-neutral' },
  PURCHASE: { label: 'Received', cls: 'badge-success' },
  CUSTOMER_MATERIAL: { label: "Customer's material", cls: 'badge-info' },
  SALE: { label: 'Sold', cls: 'badge-info' },
  ISSUE: { label: 'Issued', cls: 'badge-warning' },
  PRODUCTION: { label: 'Produced', cls: 'badge-success' },
  TRANSFER: { label: 'Transfer', cls: 'badge-info' },
  ADJUSTMENT: { label: 'Count', cls: 'badge-danger' },
  RETURN: { label: 'Returned', cls: 'badge-neutral' },
}

/** The document behind a movement, in words. */
const DOCUMENT: Record<string, string> = {
  OPENING_STOCK: 'Opening stock',
  GRN: 'Goods receipt',
  GRN_EDITED: 'Goods receipt edited',
  GRN_CANCELLED: 'Goods receipt cancelled',
  GRN_QC: 'Quality check',
  GRN_QC_CANCELLED: 'Quality check undone',
  CUSTOMER_GRN: "Customer's material in",
  CUSTOMER_GRN_CANCELLED: "Customer's receipt cancelled",
  JOB_WORK_CHALLAN: 'Job work challan',
  JOB_WORK_CHALLAN_CANCELLED: 'Job work challan cancelled',
  JOB_WORK_RETURN: 'Back from job work',
  PurchaseReturn: 'Purchase return',
  PurchaseNote: 'Purchase note',
  STOCK_ADJUSTMENT: 'Stock count',
  STOCK_TRANSFER: 'Store transfer',
  STOCK_TRANSFER_CANCELLED: 'Store transfer cancelled',
  MATERIAL_REQUISITION: 'Material requisition',
}

const docLabel = (v: string) =>
  DOCUMENT[v] ??
  v.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())

const TYPE_LABEL: Record<string, string> = {
  RAW_MATERIAL: 'Raw Material',
  SEMI_FINISHED: 'Semi Finished',
  FINISHED_GOOD: 'Finished Good',
  CONSUMABLE: 'Consumable',
  PACKING_MATERIAL: 'Packing',
  TRIM: 'Trim',
}

const FILTERS: Array<{ key: FilterKey; label: string; labelOf?: (v: string) => string; noneLabel?: string }> = [
  { key: 'store', label: 'Store' },
  { key: 'movement', label: 'Movement', labelOf: (v) => MOVEMENT[v]?.label ?? v },
  { key: 'document', label: 'Document', labelOf: docLabel, noneLabel: 'No document' },
  { key: 'direction', label: 'In / Out', labelOf: (v) => (v === 'in' ? 'Came in' : 'Went out') },
  { key: 'owner', label: 'Whose', labelOf: (v) => (v === 'OWNED' ? 'Our own stock' : "Customers' material") },
  { key: 'category', label: 'Category' },
  { key: 'sub', label: 'Sub-category', noneLabel: 'No sub-category' },
  { key: 'department', label: 'Department', noneLabel: 'No department' },
  { key: 'itemType', label: 'Type', labelOf: (v) => TYPE_LABEL[v] ?? v },
]

const qtyFmt = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })
const money = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** ₹ in lakh and crore once it is big enough that the paise are noise. */
const rupees = (v: number) => {
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`
  return `${sign}₹${money(a)}`
}

// Days are India's days, on the screen as on the server.
const TZ = 'Asia/Kolkata'
const dayKey = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ })
const dayTitle = (key: string) =>
  new Date(`${key}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const timeOf = (d: string) => new Date(d).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
const iso = (d: Date) => dayKey(d)
/** A calendar date as the browser holds it, for stepping through days. */
const localIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The quick date ranges. */
function presetRange(p: string): { from: string; to: string } {
  const now = new Date()
  const today = iso(now)
  const back = (days: number) => iso(new Date(now.getTime() - days * 86400000))
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
      // The financial year starts on 1 April.
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

/**
 * The value in and out by day, bunched into weeks or months when the range is
 * too long for a bar a day to be seen.
 */
function buckets(series: Day[], from: string, to: string) {
  if (!series.length) return []
  const start = new Date(`${from || series[0].day}T00:00:00`)
  const end = new Date(`${to || series[series.length - 1].day}T00:00:00`)
  const span = Math.round((end.getTime() - start.getTime()) / 86400000) + 1
  const unit: 'day' | 'week' | 'month' = span <= 45 ? 'day' : span <= 200 ? 'week' : 'month'

  const keyOf = (d: Date) => {
    if (unit === 'day') return localIso(d)
    if (unit === 'month') return localIso(d).slice(0, 7)
    // Weeks start on Monday.
    const m = new Date(d)
    m.setDate(m.getDate() - ((m.getDay() + 6) % 7))
    return localIso(m)
  }
  const map = new Map<string, { key: string; from: string; to: string; inValue: number; outValue: number; moves: number }>()
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const k = keyOf(d)
    const cur = map.get(k)
    if (cur) cur.to = localIso(d)
    else map.set(k, { key: k, from: localIso(d), to: localIso(d), inValue: 0, outValue: 0, moves: 0 })
  }
  for (const s of series) {
    const b = map.get(keyOf(new Date(`${s.day}T00:00:00`)))
    if (!b) continue
    b.inValue += s.inValue
    b.outValue += s.outValue
    b.moves += s.moves
  }
  const label = (b: { from: string; to: string }) => {
    const f = new Date(`${b.from}T00:00:00`)
    if (unit === 'month') return f.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
    return f.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  }
  return [...map.values()].map((b) => ({ ...b, label: label(b), unit }))
}

/** A titled card around one chart, with a line on how to read it. */
function ChartCard({
  title,
  hint,
  className = '',
  children,
}: {
  title: string
  hint: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`glass-card p-4 ${className}`}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mb-2 text-[11px] text-muted-foreground">{hint}</p>
      {children}
    </div>
  )
}

type View = 'movements' | 'dashboard'

function LedgerScreen() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const view: View = params.get('view') === 'dashboard' ? 'dashboard' : 'movements'
  const setView = (v: View) => {
    const next = new URLSearchParams(params.toString())
    if (v === 'dashboard') next.set('view', 'dashboard')
    else next.delete('view')
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }
  // Arriving from an item page lands already filtered to that item.
  const itemId = params.get('itemId') ?? ''

  const [res, setRes] = useState<LedgerResponse | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Partial<Record<FilterKey, string[]>>>({})
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [preset, setPreset] = useState('all')

  // The search waits for a pause in typing rather than asking on every key.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const filterQs = useCallback(() => {
    const qs = new URLSearchParams()
    if (itemId) qs.set('itemId', itemId)
    if (query) qs.set('search', query)
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    for (const [k, v] of Object.entries(picked)) if (v?.length) qs.set(k, v.join(','))
    return qs
  }, [itemId, query, from, to, picked])

  // Replies can arrive out of order; only the newest counts.
  const latest = useRef(0)
  const load = useCallback(async () => {
    const id = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const qs = filterQs()
      qs.set('page', String(page))
      qs.set('limit', '50')
      // The dashboard's breakdowns cost a few more queries; only it asks.
      if (view === 'dashboard') qs.set('analysis', '1')
      const r = await api.get<LedgerResponse>(`/inventory/ledger?${qs}`)
      if (id === latest.current) setRes(r)
    } catch (err) {
      if (id !== latest.current) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing the stock ledger.'
            : err.message
          : 'Could not reach the server. Is the API running?',
      )
      setRes(null)
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [filterQs, page, view])

  useEffect(() => {
    void load()
  }, [load])

  // Changing a filter while on page 4 would show an empty page 4 of a shorter
  // list, which reads as "no results" rather than "you moved".
  useEffect(() => {
    setPage(1)
  }, [itemId, query, from, to, picked])

  // A picked choice can drop out of the counts when other filters leave it
  // nothing; its name is remembered so the dropdown and its chip still say it.
  const seen = useRef(new Map<string, string>())
  const choicesFor = (key: FilterKey): FilterChoice[] | undefined => {
    const rows = res?.facets?.[key]
    if (!rows) return undefined
    const def = FILTERS.find((f) => f.key === key)!
    const nameOf = (value: string, label: string | null) =>
      value === 'none' ? (def.noneLabel ?? 'Not set') : (def.labelOf?.(value) ?? label ?? value)
    const list = rows.map((r) => {
      const label = nameOf(r.value, r.label)
      seen.current.set(`${key}:${r.value}`, label)
      return { value: r.value, label, count: r.count }
    })
    for (const v of picked[key] ?? [])
      if (!list.some((c) => c.value === v)) list.push({ value: v, label: seen.current.get(`${key}:${v}`) ?? nameOf(v, null), count: 0 })
    return list.sort((a, b) => (a.value === 'none' ? 1 : b.value === 'none' ? -1 : a.label.localeCompare(b.label)))
  }

  const setFilter = (key: FilterKey, values: string[]) => setPicked((p) => ({ ...p, [key]: values }))
  const toggleOnly = (key: FilterKey, value: string) =>
    setPicked((p) => ({ ...p, [key]: p[key]?.length === 1 && p[key]![0] === value ? [] : [value] }))
  const isOnly = (key: FilterKey, value: string) => picked[key]?.length === 1 && picked[key]![0] === value
  const toggleOne = (key: FilterKey, value: string) =>
    setPicked((p) => {
      const cur = p[key] ?? []
      return { ...p, [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] }
    })

  const chips = FILTERS.flatMap((f) =>
    (picked[f.key] ?? []).map((v) => ({
      key: f.key,
      value: v,
      text: `${f.label}: ${choicesFor(f.key)?.find((c) => c.value === v)?.label ?? seen.current.get(`${f.key}:${v}`) ?? '…'}`,
    })),
  )
  const narrowed = chips.length > 0 || !!query || !!from || !!to
  const clearAll = () => {
    setPicked({})
    setSearch('')
    setQuery('')
    setFrom('')
    setTo('')
    setPreset('all')
  }

  const pickPreset = (key: string) => {
    const r = presetRange(key)
    setPreset(key)
    setFrom(r.from)
    setTo(r.to)
  }

  const summary = res?.summary
  const rows = res?.data ?? []
  const net = (summary?.inValue ?? 0) - (summary?.outValue ?? 0)
  const customerCount = res?.facets?.owner?.find((f) => f.value === 'CUSTOMER_OWNED')?.count ?? 0

  const bars = useMemo(() => buckets(res?.series ?? [], from, to), [res?.series, from, to])
  const byDay = useMemo(() => new Map((res?.series ?? []).map((d) => [d.day, d])), [res?.series])

  const movementMix = useMemo(() => {
    const list = (res?.facets?.movement ?? []).map((m) => ({ ...m, label: MOVEMENT[m.value]?.label ?? m.value }))
    return list.sort((a, b) => b.count - a.count)
  }, [res?.facets?.movement])

  const analysis = res?.analysis
  /** A breakdown from the server, each with the name to show. */
  const groups = (rows: Group[] | undefined, nameOf?: (g: Group) => string | null) =>
    (rows ?? []).map((g) => ({ ...g, label: nameOf?.(g) ?? g.label ?? g.value }))
  const insight = useMemo(() => {
    const days = res?.series ?? []
    const busiest = days.reduce<Day | null>((b, d) => (!b || d.moves > b.moves ? d : b), null)
    const biggest = days.reduce<Day | null>(
      (b, d) => (!b || d.inValue + d.outValue > b.inValue + b.outValue ? d : b),
      null,
    )
    return {
      busiest,
      biggest,
      activeDays: days.length,
      perDay: days.length ? (summary?.total ?? 0) / days.length : 0,
    }
  }, [res?.series, summary?.total])
  const showDay = (day: string) => {
    setFrom(day)
    setTo(day)
    setPreset('custom')
  }

  /** Every movement the filters leave, as a spreadsheet. */
  const exportRows = async () => {
    setExporting(true)
    try {
      const qs = filterQs()
      qs.set('export', '1')
      const [r, XLSX] = await Promise.all([
        api.get<{ data: Row[]; summary: Summary }>(`/inventory/ledger?${qs}`),
        import('xlsx'),
      ])
      const sheet = XLSX.utils.json_to_sheet(
        r.data.map((m) => {
          const inQty = Number(m.inQty)
          const outQty = Number(m.outQty)
          return {
            Date: dayKey(m.transactionDate),
            Time: timeOf(m.transactionDate),
            Movement: MOVEMENT[m.transactionType]?.label ?? m.transactionType,
            Document: m.referenceType ? docLabel(m.referenceType) : '',
            'Item Code': m.item.code,
            'Item Name': m.item.name,
            Type: TYPE_LABEL[m.itemType] ?? m.itemType,
            Category: m.mainCategoryName,
            'Sub Category': m.subCategoryName ?? '',
            Department: m.departmentName ?? '',
            Store: m.warehouse.name,
            Whose: m.ownerCustomer ? `${m.ownerCustomer.name} (customer)` : 'Our own',
            In: inQty > 0 ? inQty : '',
            Out: outQty > 0 ? outQty : '',
            Unit: m.item.uom.symbol,
            Balance: Number(m.closingStock),
            Rate: m.unitRate === null ? '' : Number(m.unitRate),
            Value: m.value ?? '',
            Note: m.notes ?? '',
          }
        }),
      )
      sheet['!cols'] = [11, 7, 14, 24, 14, 32, 13, 18, 18, 14, 22, 20, 9, 9, 7, 10, 10, 12, 50].map((wch) => ({ wch }))
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, 'Stock Ledger')
      XLSX.writeFile(book, `stock-ledger-${iso(new Date())}.xlsx`)
      if (r.summary.total > r.data.length)
        setError(`The export holds the newest ${r.data.length.toLocaleString('en-IN')} of ${r.summary.total.toLocaleString('en-IN')} movements. Narrow the dates for the rest.`)
    } catch {
      setError('The export could not be made.')
    } finally {
      setExporting(false)
    }
  }

  const card = (active: boolean) =>
    `glass-card p-4 text-left transition-colors hover:border-primary/50 ${active ? 'border-primary ring-2 ring-primary/30' : ''}`

  // The search and dropdowns, the same on both tabs. Raised so an open
  // dropdown lies over whatever is below it.
  const filterBar = (
    <div className="relative z-20 space-y-2 px-4 py-3 border-b border-border">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-10 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3">
          <Search size={14} className="text-muted-foreground" />
          <input
            className="bg-transparent border-0 outline-none text-sm flex-1 text-foreground placeholder:text-muted-foreground"
            placeholder="Search item, code, store, note, customer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search the ledger"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="text-muted-foreground">
              <X size={14} />
            </button>
          )}
        </div>
        {FILTERS.map((f) => (
          <FilterMenu
            key={f.key}
            label={f.label}
            choices={choicesFor(f.key)}
            selected={picked[f.key] ?? []}
            onChange={(next) => setFilter(f.key, next)}
          />
        ))}
      </div>
      {narrowed && (
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
          {(from || to) && (
            <button
              type="button"
              onClick={() => pickPreset('all')}
              className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-foreground"
            >
              {from === to ? dayTitle(from) : `${from ? dayTitle(from) : 'start'} – ${to ? dayTitle(to) : 'today'}`} <X size={11} />
            </button>
          )}
          <button type="button" onClick={clearAll} className="text-xs text-teal-500 hover:underline">
            Clear all
          </button>
          <span className="ml-auto text-xs text-muted-foreground">
            {(summary?.total ?? 0).toLocaleString('en-IN')} movements
          </span>
        </div>
      )}
    </div>
  )

  // The table, with a line at the top of each day saying what that day did.
  let lastDay = ''

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock Ledger</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} title="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <Link href="/inventory/stock" className="btn-ghost">
            Stock on hand
          </Link>
          <button
            className="btn-secondary"
            onClick={() => void exportRows()}
            disabled={exporting || !summary?.total}
            title={narrowed ? 'Export the movements the filters leave' : 'Export every movement'}
          >
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Export
          </button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border" role="tablist">
        {([
          { key: 'movements', label: 'Movements', icon: List },
          { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
        ] as const).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={view === t.key}
            onClick={() => setView(t.key)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm transition-colors ${
              view === t.key
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
          <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-400 flex-1">{error}</p>
          <button type="button" onClick={() => setError(null)} className="text-red-400" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {itemId && rows.length > 0 && (
        <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-secondary">
          <p className="text-sm text-foreground">
            Showing only <span className="font-medium">{rows[0].item.name}</span>{' '}
            <span className="font-mono text-xs text-muted-foreground">{rows[0].item.code}</span>
          </p>
          <Link href="/inventory/ledger" className="text-xs text-teal-400 hover:underline">
            Show everything
          </Link>
        </div>
      )}

      {/* The period. Everything below — figures, chart, dropdowns — is for it. */}
      <div className="flex flex-wrap items-center gap-2">
        <CalendarDays size={15} className="text-muted-foreground" />
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => pickPreset(p.key)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              preset === p.key
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
            }`}
          >
            {p.label}
          </button>
        ))}
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            From
            <input
              type="date"
              className="form-input h-8 text-xs"
              value={from}
              max={to || undefined}
              onChange={(e) => {
                setFrom(e.target.value)
                setPreset('custom')
              }}
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            To
            <input
              type="date"
              className="form-input h-8 text-xs"
              value={to}
              min={from || undefined}
              onChange={(e) => {
                setTo(e.target.value)
                setPreset('custom')
              }}
            />
          </label>
        </div>
      </div>

      {/* Four figures for what the filters leave, each a filter itself. */}
      {view === 'movements' && (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <button type="button" className={card(false)} onClick={clearAll} title="Clear every filter">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Activity size={13} /> Movements
          </p>
          <p className="mt-1 text-lg font-bold text-foreground tabular-nums sm:text-2xl">
            {(summary?.total ?? 0).toLocaleString('en-IN')}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {summary ? `${summary.items} items · ${summary.stores} stores` : '…'}
            {narrowed ? ' · click to show all' : ''}
          </p>
        </button>
        <button type="button" className={card(isOnly('direction', 'in'))} onClick={() => toggleOnly('direction', 'in')}>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ArrowDownToLine size={13} className="text-emerald-400" /> Came in
          </p>
          <p className="mt-1 text-lg font-bold text-emerald-500 tabular-nums sm:text-2xl">{rupees(summary?.inValue ?? 0)}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {isOnly('direction', 'in') ? 'showing only these · click to show all' : `${summary?.ins ?? 0} movements in`}
          </p>
        </button>
        <button type="button" className={card(isOnly('direction', 'out'))} onClick={() => toggleOnly('direction', 'out')}>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ArrowUpFromLine size={13} className="text-red-400" /> Went out
          </p>
          <p className="mt-1 text-lg font-bold text-red-400 tabular-nums sm:text-2xl">{rupees(summary?.outValue ?? 0)}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {isOnly('direction', 'out') ? 'showing only these · click to show all' : `${summary?.outs ?? 0} movements out`}
          </p>
        </button>
        <button
          type="button"
          className={card(isOnly('owner', 'CUSTOMER_OWNED'))}
          onClick={() => toggleOnly('owner', 'CUSTOMER_OWNED')}
        >
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users size={13} /> Customers&apos; material
          </p>
          <p className="mt-1 text-lg font-bold text-sky-400 tabular-nums sm:text-2xl">{customerCount}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {isOnly('owner', 'CUSTOMER_OWNED') ? 'showing only these · click to show all' : 'movements of job-work material'}
          </p>
        </button>
      </div>
      )}

      {view === 'dashboard' && (
        <>
          <div className="glass-card p-0">{filterBar}</div>

          {/* What the period says, in four lines. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="glass-card p-4">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Scale size={13} /> Net change
              </p>
              <p className={`mt-1 text-lg font-bold tabular-nums sm:text-2xl ${net >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                {net >= 0 ? '+' : ''}
                {rupees(net)}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                in {rupees(summary?.inValue ?? 0)} · out {rupees(summary?.outValue ?? 0)}
              </p>
            </div>
            <button
              type="button"
              className={card(false)}
              disabled={!insight.busiest}
              onClick={() => insight.busiest && showDay(insight.busiest.day)}
              title="Click to see that day"
            >
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Flame size={13} className="text-amber-400" /> Busiest day
              </p>
              <p className="mt-1 text-lg font-bold text-foreground sm:text-2xl">
                {insight.busiest ? dayTitle(insight.busiest.day).replace(/,? \d{4}$/, '') : '—'}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {insight.busiest ? `${insight.busiest.moves} movements · click to see them` : 'no movements'}
              </p>
            </button>
            <button type="button" className={card(false)} onClick={() => setView('movements')} title="See the movements">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Boxes size={13} /> Items moved
              </p>
              <p className="mt-1 text-lg font-bold text-foreground tabular-nums sm:text-2xl">{summary?.items ?? 0}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                in {summary?.stores ?? 0} stores · {(summary?.total ?? 0).toLocaleString('en-IN')} movements
              </p>
            </button>
            <div className="glass-card p-4">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Gauge size={13} /> Average a day
              </p>
              <p className="mt-1 text-lg font-bold text-foreground tabular-nums sm:text-2xl">
                {insight.perDay.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                movements, over {insight.activeDays} {insight.activeDays === 1 ? 'day' : 'days'} with any
              </p>
            </div>
          </div>

          {/* The shape of it: value in and out over the period, and what kind of movements they were. */}
          {/* A chart of its own kind for each question. Clicking a part filters by it. */}
          <div className="grid gap-3 lg:grid-cols-3">
            <ChartCard
              className="lg:col-span-2"
              title={`Flow ${bars[0] ? `by ${bars[0].unit}` : ''}`}
              hint="value in above the line, out below it; the line is how many movements · click a bar to see that period"
            >
              <FlowChart data={bars} onPick={(f, t) => { setFrom(f); setTo(t); setPreset('custom') }} />
            </ChartCard>
            <ChartCard title="Mix of movements" hint="click a slice to show only those">
              <MovementDonut data={movementMix} picked={picked.movement ?? []} onPick={(v) => toggleOne('movement', v)} />
            </ChartCard>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <ChartCard title="By store" hint="value in and out of each store · click a store to filter">
              <StoreColumns data={groups(analysis?.byStore)} onPick={(v) => toggleOne('store', v)} />
            </ChartCard>
            <ChartCard title="By category" hint="the bigger the box, the more value moved · click one to filter">
              <CategoryTreemap data={groups(analysis?.byCategory)} onPick={(v) => toggleOne('category', v)} />
            </ChartCard>
            <ChartCard title="By department" hint="how many movements in and out for each department's items">
              <DepartmentRadar
                data={groups(analysis?.byDepartment, (g) => (g.value === 'none' ? 'No department' : null))}
              />
            </ChartCard>
            <ChartCard title="By document" hint="what caused the movements · click one to filter">
              <DocumentBars
                data={groups(analysis?.byDocument, (g) => (g.value === 'none' ? 'No document' : docLabel(g.value)))}
                onPick={(v) => toggleOne('document', v)}
              />
            </ChartCard>
          </div>

          {/* The items that moved the most money, in and out together. */}
          <div className="glass-card p-0 overflow-hidden">
            <div className="flex items-baseline justify-between px-4 pt-4">
              <p className="text-sm font-medium text-foreground">Items that moved the most value</p>
              <p className="text-[11px] text-muted-foreground">top 10 · click one for its movements</p>
            </div>
            {!analysis ? (
              <p className="px-4 py-8 text-center text-xs text-muted-foreground">Loading...</p>
            ) : analysis.topItems.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-muted-foreground">Nothing to show.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="data-table w-full [&>tbody>tr>td]:px-3 [&>thead>tr>th]:px-3">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Code</th>
                      <th>Item</th>
                      <th style={{ textAlign: 'right' }}>Came in</th>
                      <th style={{ textAlign: 'right' }}>Went out</th>
                      <th style={{ textAlign: 'right' }}>Value in</th>
                      <th style={{ textAlign: 'right' }}>Value out</th>
                      <th style={{ textAlign: 'right' }}>Movements</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.topItems.map((t, n) => (
                      <tr
                        key={t.value}
                        className="cursor-pointer"
                        onClick={() => {
                          setSearch(t.code)
                          setView('movements')
                        }}
                        title="Click to see this item's movements"
                      >
                        <td className="text-xs text-muted-foreground tabular-nums">{n + 1}</td>
                        <td className="whitespace-nowrap font-mono text-xs text-teal-500">{t.code}</td>
                        <td className="min-w-[180px] text-sm font-medium text-foreground">{t.label}</td>
                        <td className="whitespace-nowrap text-right tabular-nums text-emerald-500">
                          {t.inQty > 0 ? `+${qtyFmt(t.inQty)} ${t.uom}` : '—'}
                        </td>
                        <td className="whitespace-nowrap text-right tabular-nums text-red-400">
                          {t.outQty > 0 ? `−${qtyFmt(t.outQty)} ${t.uom}` : '—'}
                        </td>
                        <td className="whitespace-nowrap text-right tabular-nums">{rupees(t.inValue)}</td>
                        <td className="whitespace-nowrap text-right tabular-nums">{t.outValue > 0 ? rupees(t.outValue) : '—'}</td>
                        <td className="text-right tabular-nums text-muted-foreground">{t.moves}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {view === 'movements' && (
      <div className="glass-card p-0 overflow-hidden">
        {filterBar}

        {loading && !res ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              {narrowed
                ? 'No movements match that.'
                : 'Nothing here yet. Movements appear the moment stock is received, issued or counted.'}
            </p>
          </div>
        ) : (
          <div className={`overflow-x-auto transition-opacity ${loading ? 'opacity-60' : ''}`}>
            <table className="data-table w-full [&>tbody>tr>td]:px-2.5 [&>thead>tr>th]:px-2.5">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>What</th>
                  <th>Code</th>
                  <th>Item</th>
                  <th>Category</th>
                  <th>Sub-cat.</th>
                  <th>Dept.</th>
                  <th>Store</th>
                  <th style={{ textAlign: 'right' }}>In</th>
                  <th style={{ textAlign: 'right' }}>Out</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>Value</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.flatMap((r) => {
                  const m = MOVEMENT[r.transactionType] ?? { label: r.transactionType, cls: 'badge-neutral' }
                  const inQty = Number(r.inQty)
                  const outQty = Number(r.outQty)
                  const day = dayKey(r.transactionDate)
                  const out: ReactNode[] = []
                  if (day !== lastDay) {
                    lastDay = day
                    const d = byDay.get(day)
                    out.push(
                      <tr key={`day-${day}`} className="bg-secondary/60">
                        <td colSpan={14} className="py-1.5">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs">
                            <span className="font-semibold text-foreground">{dayTitle(day)}</span>
                            {d && (
                              <>
                                <span className="text-muted-foreground">{d.moves} movements</span>
                                {d.inValue > 0 && <span className="text-emerald-500">in {rupees(d.inValue)}</span>}
                                {d.outValue > 0 && <span className="text-red-400">out {rupees(d.outValue)}</span>}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>,
                    )
                  }
                  out.push(
                    <tr key={r.id}>
                      <td className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{timeOf(r.transactionDate)}</td>
                      <td className="whitespace-nowrap">
                        <span className={m.cls}>{m.label}</span>
                        {r.referenceType && (
                          <div className="mt-0.5 text-[10px] text-muted-foreground">{docLabel(r.referenceType)}</div>
                        )}
                      </td>
                      <td className="whitespace-nowrap font-mono text-xs text-teal-500">{r.item.code}</td>
                      <td className="min-w-[170px]">
                        <Link
                          href={`/inventory/stock/${r.item.id}`}
                          className="text-sm font-medium text-foreground hover:text-teal-400"
                        >
                          {r.item.name}
                        </Link>
                      </td>
                      <td className="text-xs">{r.mainCategoryName}</td>
                      <td className="text-xs">{r.subCategoryName ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="text-xs">{r.departmentName ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="min-w-[110px] text-xs">
                        {r.warehouse.name}
                        {r.ownerCustomer && (
                          <div className="text-[10px] text-sky-400">{r.ownerCustomer.name}&apos;s material</div>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums text-emerald-500">
                        {inQty > 0 ? `+${qtyFmt(inQty)} ${r.item.uom.symbol}` : ''}
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums text-red-400">
                        {outQty > 0 ? `−${qtyFmt(outQty)} ${r.item.uom.symbol}` : ''}
                      </td>
                      <td className="text-right tabular-nums font-semibold">{qtyFmt(Number(r.closingStock))}</td>
                      <td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                        {r.unitRate === null ? '—' : `₹${money(Number(r.unitRate))}`}
                      </td>
                      <td
                        className={`whitespace-nowrap text-right tabular-nums font-medium ${inQty > 0 ? 'text-emerald-500' : 'text-red-400'}`}
                      >
                        {r.value === null ? '—' : `₹${money(r.value)}`}
                      </td>
                      <td className="text-xs text-muted-foreground min-w-[140px] max-w-[200px] truncate" title={r.notes ?? undefined}>
                        {r.notes ?? ''}
                      </td>
                    </tr>,
                  )
                  return out
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pagination page={page} pages={res?.pagination.pages ?? 1} onPageChange={setPage} busy={loading} />
      </div>
      )}
    </div>
  )
}

export default function LedgerPage() {
  // useSearchParams needs a Suspense boundary or the whole route opts out of
  // static rendering and Next refuses to build.
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading...</p>}>
      <LedgerScreen />
    </Suspense>
  )
}
