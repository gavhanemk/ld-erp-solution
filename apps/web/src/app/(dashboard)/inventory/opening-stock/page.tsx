'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  Boxes,
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
import { SmartSelect } from '@/components/ui/SmartSelect'
import { ImportOpeningStockDialog } from '@/components/inventory/ImportOpeningStockDialog'
import { OpeningStockEntryDialog } from '@/components/inventory/OpeningStockEntryDialog'

/*
 * Inventory → Stock → Opening Stock: what the mill had on the day it started
 * on the ERP. Entered by hand (garments style by style and size by size,
 * materials item by item) or imported from the 19-column sheet; either way it
 * is in stock at once, by item, style, size, process and location.
 *
 * The tiles pick a kind — raw materials, work in progress, finished goods —
 * and show only it; All shows every line. Lines are listed with the sheet's
 * columns; Entries lists each save or upload.
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
  places: Array<{ id: string; name: string; process: string | null; lines: number; value: number }>
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
const TILES: Array<{ key: Kind | ''; label: string; icon: typeof Package; note: string }> = [
  { key: '', label: 'All', icon: LayoutGrid, note: 'Every line' },
  { key: 'RAW', label: 'Raw Materials', icon: Package, note: 'In the stores' },
  { key: 'WIP', label: 'Work in Progress', icon: Factory, note: 'At the processes' },
  { key: 'FINISHED', label: 'Finished Goods', icon: Shirt, note: 'Ready, by size' },
]

const money = (v: number) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
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
 * The sheet's 19 columns, in its order and under its names. A column left
 * empty shows what the ERP filed the line under (item name, category,
 * colour, style), so every line reads whole.
 */
const COLUMNS: Array<{ head: string; right?: boolean; cell: (l: Line) => ReactNode }> = [
  { head: 'Opening Date', cell: (l) => day(l.openingDate) },
  { head: 'Process', cell: (l) => l.department?.name ?? l.processText ?? 'Store' },
  { head: 'Department / Location', cell: (l) => l.warehouse.name },
  { head: 'Order No.', cell: (l) => l.orderNo ?? muted },
  { head: 'Style / Article No.', cell: (l) => l.styleText ?? l.item.style?.code ?? muted },
  { head: 'Item Code', cell: (l) => <span className="font-mono text-teal-400">{l.item.code}</span> },
  { head: 'Item Description', cell: (l) => <span className="text-foreground">{l.description ?? l.item.name}</span> },
  { head: 'Item Category', cell: (l) => l.categoryText ?? l.item.category?.name ?? muted },
  { head: 'Fabric / Material', cell: (l) => l.fabricText ?? muted },
  { head: 'Colour', cell: (l) => l.colour ?? l.item.color ?? muted },
  { head: 'Size', cell: (l) => <span className="font-semibold">{l.size?.code ?? l.sizeText ?? muted}</span> },
  { head: 'Lot / Batch / Roll No.', cell: (l) => l.lotNo ?? muted },
  { head: 'Bundle / Barcode No.', cell: (l) => l.bundleNo ?? muted },
  { head: 'UOM', cell: (l) => l.item.uom?.symbol ?? l.uomText ?? muted },
  { head: 'Opening Qty', right: true, cell: (l) => <span className="font-semibold">{num(Number(l.qty))}</span> },
  { head: 'Unit Rate', right: true, cell: (l) => money(Number(l.unitRate)) },
  { head: 'Opening Value', right: true, cell: (l) => <span className="text-foreground font-semibold">{money(Number(l.value))}</span> },
  {
    head: 'Stock Status',
    cell: (l) => {
      const s = STATUS[l.status] ?? { label: l.status, cls: 'badge-neutral' }
      return <span className={s.cls}>{s.label}</span>
    },
  },
  { head: 'Remarks', cell: (l) => <span className="text-muted-foreground">{l.remarks ?? ''}</span> },
]

export default function OpeningStockPage() {
  const [view, setView] = useState<'lines' | 'entries'>('lines')
  const [kind, setKind] = useState<Kind | ''>('')
  const [place, setPlace] = useState('')
  const [entry, setEntry] = useState<Entry | null>(null)
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<LinesData | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const mayAdd = can('inventory', 'create')

  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => setPage(1), [kind, place, entry, term])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: '100' })
      if (kind) qs.set('group', kind)
      if (place) qs.set('place', place)
      if (entry) qs.set('entry', entry.id)
      if (term) qs.set('q', term)
      const [l, e] = await Promise.all([
        api.get<{ data: LinesData }>(`/inventory/opening-stock/lines?${qs}`),
        api.get<{ data: Entry[] }>('/inventory/opening-stock'),
      ])
      setData(l.data)
      setEntries(e.data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the opening stock. Is the API running?')
    } finally {
      setLoading(false)
    }
  }, [page, kind, place, entry, term])
  useEffect(() => {
    void load()
  }, [load])

  const kinds = data?.kinds ?? {}
  const all = { lines: (Object.values(kinds) as Array<{ lines: number; value: number }>).reduce((n, k) => n + k.lines, 0), value: (Object.values(kinds) as Array<{ lines: number; value: number }>).reduce((n, k) => n + k.value, 0) }
  const tileFigures = (k: Kind | '') => (k ? (kinds[k] ?? { lines: 0, value: 0 }) : all)
  const nothingYet = !!data && all.lines === 0
  const from = data && data.total ? (data.page - 1) * data.limit + 1 : 0
  const to = data ? Math.min(data.page * data.limit, data.total) : 0
  const filtered = Boolean(kind || place || entry || term)

  const openEntry = (e: Entry) => {
    setEntry(e)
    setKind('')
    setPlace('')
    setSearch('')
    setView('lines')
  }

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div className="min-w-0 max-w-2xl flex-1">
          <h1 className="page-title">Opening Stock</h1>
          <p className="page-subtitle">
            The stock you had on the day you started using the ERP. Add it by hand — garments style by style and size by size, materials item by item — or import
            your Excel sheet. It goes straight into stock, by item, style, size, process and location.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button onClick={() => void load()} className="btn-secondary" title="Refresh" aria-label="Refresh">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          {mayAdd && (
            <>
              <button type="button" className="btn-secondary" onClick={() => setImporting(true)}>
                <Upload size={16} /> Import from Excel
              </button>
              <button type="button" className="btn-primary" onClick={() => setAdding(true)} data-hotkey="new" aria-keyshortcuts="Alt+N">
                <PackagePlus size={16} /> Add opening stock
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
        <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-500" role="status">
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
            action="Add opening stock"
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
          {/* The kinds side by side: picking one shows only it; All shows everything. */}
          <div className="glass-card grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-4" role="tablist" aria-label="Kinds of stock">
            {TILES.map((t) => {
              const f = tileFigures(t.key)
              const on = kind === t.key && !entry
              return (
                <button
                  key={t.label}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => {
                    setEntry(null)
                    setKind(t.key)
                    setView('lines')
                  }}
                  className={cn('flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors', on ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary')}
                >
                  <span className={cn('rounded-lg p-2', on ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground')}>
                    <t.icon size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-sm font-semibold', on ? 'text-primary' : 'text-foreground')}>{t.label}</span>
                    <span className="text-foreground block text-base font-semibold tabular-nums">{money(f.value)}</span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {count(f.lines, 'line', 'lines')} · {t.note}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="border-border bg-secondary flex rounded-lg border p-1" role="tablist">
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
                    'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                    view === t.key ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <t.icon size={14} /> {t.label}
                </button>
              ))}
            </div>
            {view === 'lines' && data && (
              <p className="text-muted-foreground text-sm">
                {filtered ? 'Showing ' : ''}
                <span className="text-foreground font-semibold">{count(data.total, 'line', 'lines')}</span> worth{' '}
                <span className="text-foreground font-semibold">{money(data.value)}</span>
              </p>
            )}
          </div>

          {view === 'lines' ? (
            <>
              <div className="glass-card relative z-20 flex flex-wrap items-center gap-2 p-3">
                <div className="border-border bg-secondary flex h-10 min-w-60 flex-1 items-center gap-2 rounded-lg border px-3">
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
                <SmartSelect className="form-input h-10 w-64" value={place} onChange={(e) => setPlace(e.target.value)} aria-label="Where">
                  <option value="">Every location</option>
                  {(data?.places ?? []).map((p) => (
                    <option key={p.id} value={p.id} data-sub={`${count(p.lines, 'line', 'lines')} · ${money(p.value)}`}>
                      {p.process ? `${p.process} · ${p.name}` : p.name}
                    </option>
                  ))}
                </SmartSelect>
                {entry && (
                  <span className="badge-info flex items-center gap-1">
                    {entry.number} · {how(entry.fileName)}
                    <button type="button" onClick={() => setEntry(null)} aria-label="Show every entry">
                      <X size={12} />
                    </button>
                  </span>
                )}
              </div>

              <div className="glass-card overflow-hidden p-0">
                {data && data.lines.length === 0 ? (
                  <div className="text-muted-foreground flex flex-col items-center gap-2 p-10 text-center text-sm">
                    <Boxes size={28} />
                    <p>No opening stock matches.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground bg-secondary/40 text-left text-[10px] font-semibold uppercase tracking-wide">
                          <th className="bg-secondary/90 sticky left-0 z-10 whitespace-nowrap px-3 py-2">Entry</th>
                          {COLUMNS.map((c) => (
                            <th key={c.head} className={cn('whitespace-nowrap px-2 py-2', c.right && 'text-right')}>
                              {c.head}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(data?.lines ?? []).map((l) => (
                          <tr key={l.id} className="border-border hover:bg-secondary/30 border-t">
                            <td className="bg-card sticky left-0 z-10 whitespace-nowrap px-3 py-1.5">
                              <span className="font-mono font-semibold text-teal-400">{l.openingStock.number}</span>
                              <span className="text-muted-foreground block text-[10px]">
                                {l.openingStock.fileName ? `Excel row ${l.rowNo}` : `By hand, line ${l.rowNo}`}
                              </span>
                            </td>
                            {COLUMNS.map((c) => (
                              <td key={c.head} className={cn('whitespace-nowrap px-2 py-1.5', c.right && 'text-right tabular-nums')}>
                                {c.cell(l)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {data && data.total > data.limit && (
                  <div className="border-border flex items-center justify-end gap-2 border-t px-3 py-2 text-sm">
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
                  <tr className="text-muted-foreground bg-secondary/40 text-left text-[11px] font-semibold uppercase tracking-wide">
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
                    <tr key={e.id} className="border-border hover:bg-secondary/30 cursor-pointer border-t" onClick={() => openEntry(e)} title="Show its lines">
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
            void load()
          }}
        />
      )}
      {importing && (
        <ImportOpeningStockDialog
          onClose={() => setImporting(false)}
          onImported={() => {
            setEntry(null)
            void load()
          }}
        />
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
