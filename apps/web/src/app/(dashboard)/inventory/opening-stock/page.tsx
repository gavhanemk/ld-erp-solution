'use client'

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  Boxes,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Factory,
  FileSpreadsheet,
  LayoutGrid,
  ListChecks,
  Package,
  PackagePlus,
  RefreshCw,
  Search,
  Shirt,
  Upload,
  X,
} from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { cn } from '@/lib/utils'
import { MultiFilter, type FilterOption } from '@/components/ui/MultiFilter'
import { ImportOpeningStockDialog } from '@/components/inventory/ImportOpeningStockDialog'
import { OpeningStockEntryDialog } from '@/components/inventory/OpeningStockEntryDialog'

/*
 * Inventory → Stock → Opening Stock: what the mill had on the day it started
 * on the ERP, entered by hand or imported from the 19-column sheet.
 *
 * Compact, for long lists: the kinds as slim cards (picking one shows only
 * it), then search and a filter for each column worth filtering by — several
 * values each, all working together, shown as chips — and the lines in a
 * table that fills the rest of the screen, its headings and the item kept in
 * view while it scrolls.
 */

interface Line {
  id: string
  rowNo: number
  openingDate: string
  processText: string | null
  department: { name: string } | null
  warehouse: { id: string; name: string }
  orderNo: string | null
  styleText: string | null
  description: string | null
  categoryText: string | null
  fabricText: string | null
  colour: string | null
  size: { code: string } | null
  sizeText: string | null
  lotNo: string | null
  bundleNo: string | null
  uomText: string | null
  qty: string | number
  unitRate: string | number
  value: string | number
  status: string
  remarks: string | null
  openingStock: { id: string; number: string; fileName: string | null }
  item: {
    code: string
    name: string
    type: string
    color: string | null
    uom: { symbol: string } | null
    style: { code: string } | null
    category: { name: string } | null
  }
}
interface LinesData {
  lines: Line[]
  total: number
  value: number
  page: number
  limit: number
  kinds: Partial<Record<Kind, { lines: number; value: number }>>
  /** Each style on the page, with its totals over all its lines. */
  groups: Array<{ style: string | null; name: string | null; lines: number; value: number; qty: number | null; unit: string | null; continued: boolean }>
}
interface Entry {
  id: string
  number: string
  fileName: string | null
  notes: string | null
  createdAt: string
  createdBy: { name: string } | null
  lines: number
  value: number
  openingDate: string | null
}

type Kind = 'RAW' | 'WIP' | 'FINISHED'
type FilterKey = 'item' | 'code' | 'category' | 'style' | 'colour' | 'size' | 'process' | 'place' | 'order' | 'lot'
type Options = Record<FilterKey, FilterOption[]>
interface Dates {
  of: 'opening' | 'entered'
  from: string
  to: string
}

const TILES: Array<{ key: Kind | ''; label: string; icon: typeof Package; note: string }> = [
  { key: '', label: 'All', icon: LayoutGrid, note: 'Every line' },
  { key: 'RAW', label: 'Raw Materials', icon: Package, note: 'In the stores' },
  { key: 'WIP', label: 'Work in Progress', icon: Factory, note: 'At the processes' },
  { key: 'FINISHED', label: 'Finished Goods', icon: Shirt, note: 'Ready, by size' },
]
const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'item', label: 'Item Name' },
  { key: 'code', label: 'Item Code' },
  { key: 'category', label: 'Item Category' },
  { key: 'style', label: 'Style / Article No.' },
  { key: 'colour', label: 'Colour' },
  { key: 'size', label: 'Size' },
  { key: 'process', label: 'Process' },
  { key: 'place', label: 'Department / Location' },
  { key: 'order', label: 'Order No.' },
  { key: 'lot', label: 'Lot / Batch / Roll No.' },
]
const NO_FILTERS: Record<FilterKey, string[]> = { item: [], code: [], category: [], style: [], colour: [], size: [], process: [], place: [], order: [], lot: [] }
const NO_DATES: Dates = { of: 'opening', from: '', to: '' }

const money = (v: number) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const shortDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
const count = (k: number, one: string, many: string) => `${k.toLocaleString('en-IN')} ${k === 1 ? one : many}`
const STATUS: Record<string, { label: string; cls: string }> = {
  OK: { label: 'OK', cls: 'badge-success' },
  HOLD: { label: 'Hold', cls: 'badge-warning' },
  REJECTED: { label: 'Rejected', cls: 'badge-danger' },
  B_GRADE: { label: 'B-Grade', cls: 'badge-purple' },
}
const muted = <span className="text-muted-foreground">—</span>
const how = (fileName: string | null) => (fileName ? `Excel · ${fileName}` : 'Entered by hand')

/**
 * The sheet's 19 columns, plus the entry each line came from. The item stays
 * at the left while the table scrolls sideways; what is looked at most —
 * style, colour, size, where, how many — comes next, then the rest.
 */
const styleKey = (l: Line) => l.styleText ?? l.item.style?.code ?? ''
const COLUMNS: Array<{ head: string; right?: boolean; pin?: 'style' | 'code' | 'name'; cell: (l: Line) => ReactNode }> = [
  { head: 'Style / Article No.', pin: 'style', cell: (l) => <span className="text-foreground">{styleKey(l) || muted}</span> },
  { head: 'Item Code', pin: 'code', cell: (l) => <span className="font-mono text-teal-400">{l.item.code}</span> },
  {
    head: 'Item Description',
    pin: 'name',
    cell: (l) => (
      <span className="text-foreground block truncate" title={l.description ?? l.item.name}>
        {l.description ?? l.item.name}
      </span>
    ),
  },
  { head: 'Colour', cell: (l) => l.colour ?? l.item.color ?? muted },
  { head: 'Size', cell: (l) => <span className="font-semibold">{l.size?.code ?? l.sizeText ?? muted}</span> },
  { head: 'Process', cell: (l) => l.department?.name ?? l.processText ?? 'Store' },
  { head: 'Department / Location', cell: (l) => l.warehouse.name },
  { head: 'Opening Qty', right: true, cell: (l) => <span className="text-foreground font-semibold">{num(Number(l.qty))}</span> },
  { head: 'UOM', cell: (l) => l.item.uom?.symbol ?? l.uomText ?? muted },
  { head: 'Unit Rate', right: true, cell: (l) => money(Number(l.unitRate)) },
  { head: 'Opening Value', right: true, cell: (l) => <span className="text-foreground font-semibold">{money(Number(l.value))}</span> },
  {
    head: 'Stock Status',
    cell: (l) => {
      const s = STATUS[l.status] ?? { label: l.status, cls: 'badge-neutral' }
      return <span className={s.cls}>{s.label}</span>
    },
  },
  { head: 'Order No.', cell: (l) => l.orderNo ?? muted },
  { head: 'Item Category', cell: (l) => l.categoryText ?? l.item.category?.name ?? muted },
  { head: 'Fabric / Material', cell: (l) => l.fabricText ?? muted },
  { head: 'Lot / Batch / Roll No.', cell: (l) => l.lotNo ?? muted },
  { head: 'Bundle / Barcode No.', cell: (l) => l.bundleNo ?? muted },
  { head: 'Opening Date', cell: (l) => day(l.openingDate) },
  {
    head: 'Entry',
    cell: (l) => (
      <span title={how(l.openingStock.fileName)}>
        <span className="font-mono text-teal-400">{l.openingStock.number}</span>
        <span className="text-muted-foreground"> · {l.openingStock.fileName ? `Excel row ${l.rowNo}` : `by hand, line ${l.rowNo}`}</span>
      </span>
    ),
  },
  { head: 'Remarks', cell: (l) => <span className="text-muted-foreground">{l.remarks ?? ''}</span> },
]
// The three frozen columns: each starts where the widths before it end (9rem, then 9 + 7 = 16rem).
const PIN = {
  style: 'sticky left-0 w-36 min-w-36 max-w-36 pl-3',
  code: 'sticky left-36 w-28 min-w-28 max-w-28',
  name: 'sticky left-64 w-60 min-w-60 max-w-60 shadow-[1px_0_0_hsl(var(--border))]',
}

export default function OpeningStockPage() {
  const [view, setView] = useState<'lines' | 'entries'>('lines')
  const [kind, setKind] = useState<Kind | ''>('')
  const [entry, setEntry] = useState<Entry | null>(null)
  const [filters, setFilters] = useState(NO_FILTERS)
  const [dates, setDates] = useState(NO_DATES)
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<LinesData | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [options, setOptions] = useState<Options | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const mayAdd = can('inventory', 'create')
  const toggleGroup = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => setPage(1), [kind, entry, filters, dates, term])

  const query = useMemo(() => {
    const qs = new URLSearchParams({ page: String(page), limit: '100' })
    if (kind) qs.set('group', kind)
    if (entry) qs.set('entry', entry.id)
    if (term) qs.set('q', term)
    for (const f of FILTERS) for (const v of filters[f.key]) qs.append(f.key, v)
    if (dates.from || dates.to) {
      qs.set('dateOf', dates.of)
      if (dates.from) qs.set('from', dates.from)
      if (dates.to) qs.set('to', dates.to)
    }
    return qs.toString()
  }, [page, kind, entry, term, filters, dates])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const l = await api.get<{ data: LinesData }>(`/inventory/opening-stock/lines?${query}`)
      setData(l.data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the opening stock. Is the API running?')
    } finally {
      setLoading(false)
    }
  }, [query])
  const loadLists = useCallback(async () => {
    try {
      const [e, o] = await Promise.all([api.get<{ data: Entry[] }>('/inventory/opening-stock'), api.get<{ data: Options }>('/inventory/opening-stock/filters')])
      setEntries(e.data)
      setOptions(o.data)
    } catch {
      // The lines say what went wrong.
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void loadLists()
  }, [loadLists])
  const refresh = () => {
    void load()
    void loadLists()
  }

  // The table fills the screen below the filters; the page itself does not scroll.
  const tableBox = useRef<HTMLDivElement>(null)
  const [tableHeight, setTableHeight] = useState<number>()
  const chipCount = FILTERS.reduce((n, f) => n + filters[f.key].length, 0) + (dates.from || dates.to ? 1 : 0) + (term ? 1 : 0) + (entry ? 1 : 0)
  useLayoutEffect(() => {
    const fit = () => {
      const el = tableBox.current
      if (!el) return
      const top = el.getBoundingClientRect().top + window.scrollY
      setTableHeight(Math.max(320, window.innerHeight - top - 60))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [view, chipCount, notice, error, data === null])

  const kinds = data?.kinds ?? {}
  const sums = Object.values(kinds) as Array<{ lines: number; value: number }>
  const all = { lines: sums.reduce((n, k) => n + k.lines, 0), value: sums.reduce((n, k) => n + k.value, 0) }
  const tileFigures = (k: Kind | '') => (k ? (kinds[k] ?? { lines: 0, value: 0 }) : all)
  const nothingYet = !!data && all.lines === 0 && !entries?.length
  const from = data && data.total ? (data.page - 1) * data.limit + 1 : 0
  const to = data ? Math.min(data.page * data.limit, data.total) : 0

  const labelOf = (key: FilterKey, value: string) => options?.[key].find((o) => o.value === value)?.label ?? value
  const setFilter = (key: FilterKey, values: string[]) => setFilters((f) => ({ ...f, [key]: values }))
  const clearAll = () => {
    setFilters(NO_FILTERS)
    setDates(NO_DATES)
    setSearch('')
    setEntry(null)
    setKind('')
  }
  const openEntry = (e: Entry) => {
    clearAll()
    setEntry(e)
    setView('lines')
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title">Opening Stock</h1>
          <p className="text-muted-foreground text-sm">Manage and import opening inventory across items, styles, sizes and processes.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={refresh} className="btn-secondary" title="Refresh" aria-label="Refresh">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          {mayAdd && (
            <>
              <button type="button" className="btn-secondary" onClick={() => setImporting(true)}>
                <Upload size={16} /> Import from Excel
              </button>
              <button type="button" className="btn-primary" onClick={() => setAdding(true)} data-hotkey="new" aria-keyshortcuts="Alt+N">
                <PackagePlus size={16} /> Add Opening Stock
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <AlertCircle size={15} /> {error}
        </div>
      )}
      {notice && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-500" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {nothingYet ? (
        // Nothing yet: the two ways in, side by side.
        <div className="grid gap-4 md:grid-cols-2">
          <WayIn
            icon={PackagePlus}
            title="Add by hand"
            text="Pick where it is (a store, or a process such as Cutting), then a style: enter the pieces of each colour and size, with a rate. Or add fabric, trims and packing item by item, with their lot and roll."
            action="Add Opening Stock"
            onClick={mayAdd ? () => setAdding(true) : undefined}
          />
          <WayIn
            icon={FileSpreadsheet}
            title="Import from Excel"
            text="Download the template — your 19 columns, Opening Date to Remarks — fill it in, upload it. Every row is checked first; nothing goes in until every row is right."
            action="Import from Excel"
            onClick={mayAdd ? () => setImporting(true) : undefined}
          />
        </div>
      ) : (
        <>
          {/* The kinds as slim cards: picking one shows only it; All shows everything. */}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" role="tablist" aria-label="Kinds of stock">
            {TILES.map((t) => {
              const f = tileFigures(t.key)
              const on = kind === t.key
              return (
                <button
                  key={t.label}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => {
                    setKind(t.key)
                    setView('lines')
                  }}
                  className={cn('flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors', on ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-secondary')}
                >
                  <span className={cn('rounded-lg p-1.5', on ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground')}>
                    <t.icon size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={cn('truncate text-xs font-semibold', on ? 'text-primary' : 'text-muted-foreground')}>{t.label}</span>
                      <span className="text-muted-foreground shrink-0 text-[11px]">{count(f.lines, 'line', 'lines')}</span>
                    </span>
                    <span className="text-foreground block text-base font-semibold tabular-nums">{money(f.value)}</span>
                  </span>
                </button>
              )
            })}
          </div>

          {/* Lines or entries; search; what is showing. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="border-border bg-secondary flex rounded-lg border p-0.5" role="tablist" aria-label="Show">
              {(
                [
                  { key: 'lines', label: 'Stock lines', icon: ListChecks },
                  { key: 'entries', label: `Entries${entries ? ` (${entries.length})` : ''}`, icon: ClipboardList },
                ] as const
              ).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={view === t.key}
                  onClick={() => setView(t.key)}
                  className={cn(
                    'flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition-colors',
                    view === t.key ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <t.icon size={14} /> {t.label}
                </button>
              ))}
            </div>
            {view === 'lines' && (
              <>
                <div className="border-border bg-card flex h-9 min-w-60 flex-1 items-center gap-2 rounded-lg border px-3">
                  <Search size={15} className="text-muted-foreground" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search item, style, colour, order, lot or bundle..."
                    className="text-foreground placeholder:text-muted-foreground flex-1 bg-transparent text-sm focus:outline-none"
                    data-hotkey="search"
                    aria-label="Search opening stock"
                  />
                  {search && (
                    <button type="button" onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground" aria-label="Clear search">
                      <X size={14} />
                    </button>
                  )}
                </div>
                {data && data.groups.length > 1 && (
                  <button
                    type="button"
                    className="text-primary whitespace-nowrap text-xs font-medium hover:underline"
                    onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(data.groups.map((g) => g.style ?? '')))}
                  >
                    {collapsed.size ? 'Expand all styles' : 'Collapse all styles'}
                  </button>
                )}
                {data && (
                  <p className="text-muted-foreground whitespace-nowrap text-sm">
                    <span className="text-foreground font-semibold">{count(data.total, 'line', 'lines')}</span> ·{' '}
                    <span className="text-foreground font-semibold">{money(data.value)}</span>
                  </p>
                )}
              </>
            )}
          </div>

          {view === 'lines' ? (
            <>
              {/* A filter for each column worth filtering by; they all work together. */}
              <div className="relative z-30 flex flex-wrap items-center gap-1" aria-label="Filters">
                {FILTERS.map((f) => (
                  <MultiFilter key={f.key} label={f.label} options={options?.[f.key] ?? []} selected={filters[f.key]} onChange={(v) => setFilter(f.key, v)} />
                ))}
                <DateFilter dates={dates} onChange={setDates} />
                {chipCount > 0 && (
                  <button type="button" className="text-primary ml-1 h-8 px-1 text-xs font-medium hover:underline" onClick={clearAll}>
                    Clear filters
                  </button>
                )}
              </div>

              {/* What is filtered, each removable. */}
              {chipCount > 0 && (
                <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
                  {entry && <Chip label={`Entry: ${entry.number} · ${how(entry.fileName)}`} onRemove={() => setEntry(null)} />}
                  {term && <Chip label={`Search: ${term}`} onRemove={() => setSearch('')} />}
                  {FILTERS.flatMap((f) =>
                    filters[f.key].map((v) => (
                      <Chip key={`${f.key}:${v}`} label={`${f.label}: ${labelOf(f.key, v)}`} onRemove={() => setFilter(f.key, filters[f.key].filter((x) => x !== v))} />
                    )),
                  )}
                  {(dates.from || dates.to) && (
                    <Chip
                      label={`${dates.of === 'entered' ? 'Entered' : 'Opening date'}: ${dates.from ? shortDay(dates.from) : '…'} – ${dates.to ? shortDay(dates.to) : '…'}`}
                      onRemove={() => setDates(NO_DATES)}
                    />
                  )}
                </div>
              )}

              <div className="glass-card overflow-hidden p-0">
                {data && data.lines.length === 0 ? (
                  <div className="text-muted-foreground flex flex-col items-center gap-2 p-10 text-center text-sm">
                    <Boxes size={28} />
                    <p>No opening stock matches.</p>
                    {chipCount > 0 && (
                      <button type="button" className="text-primary text-sm hover:underline" onClick={clearAll}>
                        Clear filters
                      </button>
                    )}
                  </div>
                ) : (
                  <div ref={tableBox} className="overflow-auto" style={{ maxHeight: tableHeight }}>
                    <table className="w-full border-separate border-spacing-0 text-xs">
                      {/* The header row is held at the top by the app's table rule (z 5);
                          above the frozen cells (z 10) it must sit higher still. */}
                      <thead style={{ zIndex: 30 }}>
                        <tr className="text-muted-foreground text-left text-[10px] font-semibold uppercase tracking-wide">
                          {COLUMNS.map((c) => (
                            <th
                              key={c.head}
                              className={cn('bg-secondary border-border whitespace-nowrap border-b px-2 py-2', c.right && 'text-right', c.pin && cn(PIN[c.pin], 'z-10'))}
                            >
                              {c.head}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(data?.lines ?? []).map((l, i, all) => {
                          const key = styleKey(l)
                          const startsGroup = i === 0 || styleKey(all[i - 1]) !== key
                          const g = startsGroup ? data?.groups.find((x) => (x.style ?? '') === key) : undefined
                          const shut = collapsed.has(key)
                          return (
                            <Fragment key={l.id}>
                              {startsGroup && g && (
                                <tr data-group={key || 'none'}>
                                  <td colSpan={COLUMNS.length} className="bg-secondary/70 border-border border-b p-0">
                                    {/* The label stays at the left while the table scrolls sideways. */}
                                    <button
                                      type="button"
                                      onClick={() => toggleGroup(key)}
                                      aria-expanded={!shut}
                                      className="sticky left-0 flex items-center gap-2 px-3 py-1.5 text-left"
                                    >
                                      {shut ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                                      {g.style ? (
                                        <>
                                          <span className="font-mono text-xs font-semibold text-teal-400">{g.style}</span>
                                          {g.name && <span className="text-foreground text-xs font-medium">{g.name}</span>}
                                        </>
                                      ) : (
                                        <span className="text-foreground text-xs font-medium">No style — fabric, trims, packing</span>
                                      )}
                                      <span className="text-muted-foreground text-[11px]">
                                        {count(g.lines, 'line', 'lines')}
                                        {g.qty !== null && g.unit ? ` · ${num(g.qty)} ${g.unit}` : ''} · {money(g.value)}
                                        {g.continued ? ' · continued from the page before' : ''}
                                      </span>
                                    </button>
                                  </td>
                                </tr>
                              )}
                              {!shut && (
                                <tr className="group" data-line={l.id}>
                                  {COLUMNS.map((c) => (
                                    <td
                                      key={c.head}
                                      className={cn(
                                        'border-border group-hover:bg-secondary whitespace-nowrap border-b px-2 py-1.5',
                                        c.right && 'text-right tabular-nums',
                                        c.pin && cn(PIN[c.pin], 'bg-card z-10'),
                                      )}
                                    >
                                      {c.cell(l)}
                                    </td>
                                  ))}
                                </tr>
                              )}
                            </Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {data && data.total > data.limit && (
                  <div className="border-border flex items-center justify-end gap-2 border-t px-3 py-1.5 text-sm">
                    <span className="text-muted-foreground">
                      {from.toLocaleString('en-IN')}–{to.toLocaleString('en-IN')} of {data.total.toLocaleString('en-IN')}
                    </span>
                    <button type="button" className="btn-ghost p-1" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                      <ChevronLeft size={16} />
                    </button>
                    <button type="button" className="btn-ghost p-1" disabled={to >= data.total} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                      <ChevronRight size={16} />
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="glass-card overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground bg-secondary text-left text-[11px] font-semibold uppercase tracking-wide">
                    <th className="px-4 py-2">Number</th>
                    <th className="px-2 py-2">Opening date</th>
                    <th className="px-2 py-2">How</th>
                    <th className="px-2 py-2 text-right">Lines</th>
                    <th className="px-2 py-2 text-right">Value</th>
                    <th className="px-2 py-2">Remarks</th>
                    <th className="px-4 py-2">Saved</th>
                  </tr>
                </thead>
                <tbody>
                  {(entries ?? []).map((e) => (
                    <tr key={e.id} className="border-border hover:bg-secondary/40 cursor-pointer border-t" onClick={() => openEntry(e)} title="Show its lines">
                      <td className="px-4 py-2 font-mono text-xs font-semibold text-teal-400">{e.number}</td>
                      <td className="px-2 py-2">{day(e.openingDate)}</td>
                      <td className="px-2 py-2">
                        <span className={e.fileName ? 'badge-info' : 'badge-neutral'}>{e.fileName ? 'Excel' : 'By hand'}</span>
                        {e.fileName && <span className="text-muted-foreground ml-2 text-xs">{e.fileName}</span>}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{e.lines}</td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">{money(e.value)}</td>
                      <td className="text-muted-foreground px-2 py-2 text-xs">{e.notes ?? ''}</td>
                      <td className="text-muted-foreground px-4 py-2 text-xs">
                        {day(e.createdAt)}
                        {e.createdBy && ` · ${e.createdBy.name}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {adding && (
        <OpeningStockEntryDialog
          onClose={() => setAdding(false)}
          onSaved={(message) => {
            setAdding(false)
            setNotice(message)
            setEntry(null)
            refresh()
          }}
        />
      )}
      {importing && (
        <ImportOpeningStockDialog
          onClose={() => setImporting(false)}
          onImported={() => {
            setEntry(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

/** An active filter, removable. */
function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="border-primary/40 bg-primary/10 text-primary flex h-7 items-center gap-1 rounded-full border pl-2.5 pr-1 text-xs">
      <span className="max-w-72 truncate">{label}</span>
      <button type="button" onClick={onRemove} className="hover:bg-primary/20 rounded-full p-0.5" aria-label={`Remove ${label}`}>
        <X size={12} />
      </button>
    </span>
  )
}

/**
 * Entry Date: a from–to range, on the opening date (the day the stock was
 * counted) or the day the entry was saved in the ERP.
 */
function DateFilter({ dates, onChange }: { dates: Dates; onChange: (d: Dates) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  const on = Boolean(dates.from || dates.to)
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border px-2 text-xs font-medium transition-colors',
          on ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-secondary text-foreground hover:border-primary/50',
        )}
      >
        Entry Date <ChevronDown size={12} className="opacity-70" />
      </button>
      {open && (
        <div className="bg-popover border-border absolute right-0 top-9 z-50 w-72 space-y-3 rounded-lg border p-3 shadow-lg" role="dialog" aria-label="Entry Date">
          <div className="border-border bg-secondary flex rounded-lg border p-0.5 text-xs">
            {(
              [
                { key: 'opening', label: 'Opening date' },
                { key: 'entered', label: 'Day entered' },
              ] as const
            ).map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => onChange({ ...dates, of: o.key })}
                className={cn('flex-1 rounded-md px-2 py-1', dates.of === o.key ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground')}
                aria-pressed={dates.of === o.key}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">From</span>
              <input type="date" className="form-input h-8 text-xs" value={dates.from} onChange={(e) => onChange({ ...dates, from: e.target.value })} aria-label="From date" />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">To</span>
              <input type="date" className="form-input h-8 text-xs" value={dates.to} onChange={(e) => onChange({ ...dates, to: e.target.value })} aria-label="To date" />
            </label>
          </div>
          {on && (
            <button type="button" className="text-muted-foreground hover:text-foreground text-xs font-medium" onClick={() => onChange({ ...dates, from: '', to: '' })}>
              Clear dates
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** One way to bring opening stock in, as a card with its button. */
function WayIn({ icon: Icon, title, text, action, onClick }: { icon: typeof Package; title: string; text: string; action: string; onClick?: () => void }) {
  return (
    <div className="glass-card flex flex-col gap-3 p-6">
      <span className="bg-primary/10 text-primary w-fit rounded-xl p-3">
        <Icon size={22} />
      </span>
      <h2 className="text-foreground text-lg font-semibold">{title}</h2>
      <p className="text-muted-foreground flex-1 text-sm">{text}</p>
      {onClick && (
        <button type="button" className="btn-primary w-fit" onClick={onClick}>
          {action}
        </button>
      )}
    </div>
  )
}
