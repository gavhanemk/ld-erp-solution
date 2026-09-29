'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Search, RefreshCw, AlertCircle, AlertTriangle, PackagePlus, ClipboardCheck,
  ArrowLeftRight, Warehouse as WarehouseIcon, Printer, Download, FileSpreadsheet,
  IndianRupee, Layers, X, Loader2,
} from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'
import { StockMoveDialog, type MoveMode } from '@/components/inventory/StockMoveDialog'
import { FilterMenu, type FilterChoice } from '@/components/masters/FilterMenu'
import { ImportItemsDialog } from '@/components/masters/ImportItemsDialog'

/**
 * What is on hand, right now, everywhere.
 *
 * One row per item and store rather than one per item: "we have 2,400 metres"
 * is not an answer a cutting master can act on if 2,000 of them are in a godown
 * two kilometres away.
 *
 * The whole list is read once and narrowed here, so every dropdown, its
 * counts and the four figures at the top answer at once and always agree:
 * the figures are for what the filters leave, and each is also a filter.
 */

interface ItemAbout {
  itemType: string
  mainCategoryId: string
  mainCategoryName: string
  subCategoryId: string | null
  subCategoryName: string | null
  departmentId: string | null
  departmentName: string | null
}

interface StockRow extends ItemAbout {
  itemId: string
  itemCode: string
  itemName: string
  uom: string
  categoryName: string
  reorderLevel: number | null
  warehouseId: string
  warehouseName: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerName: string | null
  qty: number
  value: number
  avgRate: number
  /** The item needs reordering: our own stock, every store together, at or below its level. */
  isLow: boolean
  /** Our own stock of the item in every store together, where it has a reorder level. */
  itemOnHand: number | null
  lastMovedAt: string | null
  /** An item to reorder with nothing in any store: no store row of its own. */
  nowhere?: boolean
}

interface ReorderRow extends ItemAbout {
  itemId: string
  itemCode: string
  itemName: string
  uom: string
  categoryName: string
  reorderLevel: number
  onHand: number
}

interface StockResponse {
  success: boolean
  data: StockRow[]
  reorder: ReorderRow[]
}

const TYPE_LABEL: Record<string, string> = {
  RAW_MATERIAL: 'Raw Material',
  SEMI_FINISHED: 'Semi Finished',
  FINISHED_GOOD: 'Finished Good',
  CONSUMABLE: 'Consumable',
  PACKING_MATERIAL: 'Packing',
  TRIM: 'Trim',
}

type FilterKey = 'store' | 'category' | 'sub' | 'department' | 'type' | 'owner' | 'status'

/** What a row is, for each filter. 'none' stands for "not set". */
const valueOf: Record<FilterKey, (r: StockRow) => string> = {
  store: (r) => r.warehouseId || 'none',
  category: (r) => r.mainCategoryId,
  sub: (r) => r.subCategoryId ?? 'none',
  department: (r) => r.departmentId ?? 'none',
  type: (r) => r.itemType,
  owner: (r) => r.ownership,
  status: (r) => (r.isLow ? 'low' : r.reorderLevel && r.reorderLevel > 0 ? 'ok' : 'unset'),
}

const FILTERS: Array<{ key: FilterKey; label: string; labelOf: (r: StockRow) => string; noneLabel?: string }> = [
  { key: 'store', label: 'Store', labelOf: (r) => r.warehouseName, noneLabel: 'Nothing in any store' },
  { key: 'category', label: 'Category', labelOf: (r) => r.mainCategoryName },
  { key: 'sub', label: 'Sub-category', labelOf: (r) => r.subCategoryName ?? '', noneLabel: 'No sub-category' },
  { key: 'department', label: 'Department', labelOf: (r) => r.departmentName ?? '', noneLabel: 'No department' },
  { key: 'type', label: 'Type', labelOf: (r) => TYPE_LABEL[r.itemType] ?? r.itemType },
  {
    key: 'owner',
    label: 'Whose',
    labelOf: (r) => (r.ownership === 'OWNED' ? 'Our own stock' : "Customers' material"),
  },
  {
    key: 'status',
    label: 'Reorder',
    labelOf: (r) =>
      r.isLow ? 'Needs reordering' : r.reorderLevel && r.reorderLevel > 0 ? 'Above reorder level' : 'No reorder level',
  },
]

const money = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const qtyFmt = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

function StockScreen() {
  const [allRows, setAllRows] = useState<StockRow[]>([])
  const [reorder, setReorder] = useState<ReorderRow[]>([])
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<Partial<Record<FilterKey, string[]>>>({})
  // Arriving from the dashboard's "see all" opens straight on what to reorder.
  const params = useSearchParams()
  useEffect(() => {
    if (params.get('low') === 'true') setPicked((p) => ({ ...p, status: ['low'] }))
  }, [params])
  const [dialog, setDialog] = useState<MoveMode | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    void masterResource<{ id: string; name: string }>('warehouses')
      .list({ limit: 100, active: true })
      .then((r) => setWarehouses(r.data))
      .catch(() => undefined)
  }, [])

  // Replies can arrive out of order; only the newest counts.
  const latest = useRef(0)

  const load = useCallback(async () => {
    const id = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<StockResponse>('/inventory/stock')
      if (id !== latest.current) return
      setAllRows(res.data)
      setReorder(res.reorder ?? [])
    } catch (err) {
      if (id !== latest.current) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing stock.'
            : err.message
          : 'Could not reach the server. Is the API running?',
      )
      setAllRows([])
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * Every row the screen can show: each item in each store, and a row for an
   * item that needs reordering and has nothing anywhere, since that is the
   * most urgent of all. Those show only while "Needs reordering" is picked,
   * and are counted in the reorder figure always.
   */
  const universe = useMemo<StockRow[]>(() => {
    const held = new Set(allRows.map((r) => r.itemId))
    const nowhere: StockRow[] = reorder
      .filter((r) => !held.has(r.itemId))
      .map((r) => ({
        ...r,
        warehouseId: '',
        warehouseName: 'Nothing in any store',
        ownership: 'OWNED',
        ownerName: null,
        qty: 0,
        value: 0,
        avgRate: 0,
        isLow: true,
        itemOnHand: r.onHand,
        lastMovedAt: null,
        nowhere: true,
      }))
    return [...allRows, ...nowhere]
  }, [allRows, reorder])

  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matchesSearch = useCallback(
    (r: StockRow) => {
      if (!words.length) return true
      const hay = `${r.itemName} ${r.itemCode} ${r.categoryName} ${r.warehouseName} ${r.departmentName ?? ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search],
  )

  /** Whether a row passes every filter except `skip` (a filter never narrows its own counts). */
  const passes = useCallback(
    (r: StockRow, skip?: FilterKey) =>
      matchesSearch(r) &&
      (Object.entries(picked) as Array<[FilterKey, string[]]>).every(
        ([key, values]) => key === skip || !values?.length || values.includes(valueOf[key](r)),
      ),
    [picked, matchesSearch],
  )

  const lowPicked = picked.status?.includes('low') ?? false
  const shown = useMemo(
    () => universe.filter((r) => passes(r) && (!r.nowhere || lowPicked)),
    [universe, passes, lowPicked],
  )

  // The dropdowns: every value in use, with how many rows it would leave.
  const choicesFor = (key: FilterKey): FilterChoice[] => {
    const def = FILTERS.find((f) => f.key === key)!
    const labels = new Map<string, string>()
    const counts = new Map<string, number>()
    for (const r of universe) {
      if (r.nowhere && key !== 'status' && !lowPicked) continue
      const v = valueOf[key](r)
      if (!labels.has(v)) labels.set(v, v === 'none' ? (def.noneLabel ?? 'Not set') : def.labelOf(r))
      if (passes(r, key) && (!r.nowhere || lowPicked || key === 'status')) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    // A store with nothing in it is still a store to pick.
    if (key === 'store') for (const w of warehouses) if (!labels.has(w.id)) labels.set(w.id, w.name)
    return [...labels.entries()]
      .map(([value, label]) => ({ value, label, count: counts.get(value) ?? 0 }))
      .sort((a, b) => (a.value === 'none' ? 1 : b.value === 'none' ? -1 : a.label.localeCompare(b.label)))
  }

  /*
   * The four figures, for what the other filters leave. Each leaves out the
   * one filter it stands for, so it still says something when that filter is
   * on: the value stays our own stock's while customers' material is picked,
   * and the reorder count stays the count while only those are shown.
   */
  const figures = useMemo(() => {
    const anyOwner = universe.filter((r) => !r.nowhere && passes(r, 'owner'))
    return {
      value: anyOwner.filter((r) => r.ownership === 'OWNED').reduce((s, r) => s + r.value, 0),
      lines: shown.filter((r) => !r.nowhere).length,
      // Items, not rows: an item in two stores is one thing to reorder.
      toReorder: new Set(universe.filter((r) => r.isLow && passes(r, 'status')).map((r) => r.itemId)).size,
      customer: anyOwner.filter((r) => r.ownership === 'CUSTOMER_OWNED').length,
    }
  }, [universe, passes, shown])

  const setFilter = (key: FilterKey, values: string[]) => setPicked((p) => ({ ...p, [key]: values }))
  const toggleOnly = (key: FilterKey, value: string) =>
    setPicked((p) => ({ ...p, [key]: p[key]?.length === 1 && p[key]![0] === value ? [] : [value] }))
  const isOnly = (key: FilterKey, value: string) => picked[key]?.length === 1 && picked[key]![0] === value

  const chips = FILTERS.flatMap((f) => {
    const values = picked[f.key] ?? []
    if (!values.length) return []
    const choices = choicesFor(f.key)
    return values.map((v) => ({ key: f.key, value: v, text: `${f.label}: ${choices.find((c) => c.value === v)?.label ?? '…'}` }))
  })
  const narrowed = chips.length > 0 || words.length > 0
  const clearAll = () => {
    setPicked({})
    setSearch('')
  }

  const oneStore = picked.store?.length === 1 && picked.store[0] !== 'none' ? picked.store[0] : ''

  /** What is on screen, as a spreadsheet. */
  const exportRows = async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const sheet = XLSX.utils.json_to_sheet(
        shown.map((r) => ({
          'Item Code': r.itemCode,
          'Item Name': r.itemName,
          Type: TYPE_LABEL[r.itemType] ?? r.itemType,
          Category: r.mainCategoryName,
          'Sub Category': r.subCategoryName ?? '',
          Department: r.departmentName ?? '',
          Store: r.nowhere ? '' : r.warehouseName,
          Whose: r.ownership === 'OWNED' ? 'Our own' : `${r.ownerName ?? 'Customer'} (customer)`,
          'On Hand': r.qty,
          Unit: r.uom,
          Rate: r.ownership === 'OWNED' && !r.nowhere ? Number(r.avgRate.toFixed(2)) : '',
          Value: r.ownership === 'OWNED' && !r.nowhere ? Number(r.value.toFixed(2)) : '',
          'Reorder Level': r.reorderLevel ?? '',
          'Needs Reorder': r.isLow ? 'Yes' : 'No',
          'Last Moved': r.lastMovedAt ? r.lastMovedAt.slice(0, 10) : '',
        })),
      )
      sheet['!cols'] = [12, 34, 14, 18, 18, 16, 24, 20, 10, 8, 10, 14, 12, 12, 12].map((wch) => ({ wch }))
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, 'Stock')
      XLSX.writeFile(book, `stock-${new Date().toISOString().slice(0, 10)}.xlsx`)
    } catch {
      setError('The export could not be made.')
    } finally {
      setExporting(false)
    }
  }

  const card = (active: boolean) =>
    `glass-card p-4 text-left transition-colors hover:border-primary/50 ${active ? 'border-primary ring-2 ring-primary/30' : ''}`

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock</h1>
          <p className="page-subtitle">What is on hand, and where it is</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} title="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-ghost" onClick={() => setDialog('transfer')}>
            <ArrowLeftRight size={15} /> Move
          </button>
          <Link
            href={`/print/count-sheet${oneStore ? `?warehouseId=${oneStore}` : ''}`}
            className="btn-ghost"
            title="A sheet to take to the rack and write the count on"
          >
            <Printer size={15} /> Count sheet
          </Link>
          <button className="btn-ghost" onClick={() => setDialog('count')}>
            <ClipboardCheck size={15} /> Count
          </button>
          <button className="btn-secondary" onClick={() => setImporting(true)} title="Items and their opening stock from a spreadsheet">
            <FileSpreadsheet size={15} /> Import
          </button>
          <button
            className="btn-secondary"
            onClick={() => void exportRows()}
            disabled={exporting || shown.length === 0}
            title={narrowed ? 'Export the rows the filters leave' : 'Export every row'}
          >
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Export
          </button>
          <button className="btn-primary" onClick={() => setDialog('opening')}>
            <PackagePlus size={15} /> Opening stock
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
          <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {message && (
        <div className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5">
          <p className="text-sm text-emerald-400">{message}</p>
        </div>
      )}

      {/* Four figures for what the filters leave, each a filter itself. The
          value is ours alone: a customer's fabric in our godown is somebody
          else's asset. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <button type="button" className={card(isOnly('owner', 'OWNED'))} onClick={() => toggleOnly('owner', 'OWNED')}>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <IndianRupee size={13} /> Stock value
          </p>
          <p className="mt-1 text-lg font-bold text-foreground tabular-nums sm:text-2xl">₹{money(figures.value)}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {isOnly('owner', 'OWNED') ? 'showing our own stock only' : 'our own stock, at weighted average'}
          </p>
        </button>
        <button type="button" className={card(false)} onClick={clearAll} title="Clear every filter">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Layers size={13} /> Lines in stock
          </p>
          <p className="mt-1 text-lg font-bold text-foreground tabular-nums sm:text-2xl">{figures.lines}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {narrowed ? `of ${allRows.length} · click to show all` : 'item and store together'}
          </p>
        </button>
        <button type="button" className={card(isOnly('status', 'low'))} onClick={() => toggleOnly('status', 'low')}>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle size={13} /> Items to reorder
          </p>
          <p
            className={`mt-1 text-lg font-bold tabular-nums sm:text-2xl ${
              figures.toReorder > 0 ? 'text-amber-400' : 'text-foreground'
            }`}
          >
            {figures.toReorder}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {isOnly('status', 'low') ? 'showing only these · click to show all' : 'all stores together, at or below the level'}
          </p>
        </button>
        <button
          type="button"
          className={card(isOnly('owner', 'CUSTOMER_OWNED'))}
          onClick={() => toggleOnly('owner', 'CUSTOMER_OWNED')}
        >
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <WarehouseIcon size={13} /> Customers&apos; material
          </p>
          <p className={`mt-1 text-lg font-bold tabular-nums sm:text-2xl ${figures.customer > 0 ? 'text-sky-400' : 'text-foreground'}`}>
            {figures.customer}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {figures.customer === 1 ? 'line' : 'lines'} held for job work, not ours, left out of the value
          </p>
        </button>
      </div>

      <div className="glass-card p-0 overflow-hidden">
        {/* Raised so an open dropdown lies over the table below. */}
        <div className="relative z-20 space-y-2 px-4 py-3 border-b border-border">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-10 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3">
              <Search size={14} className="text-muted-foreground" />
              <input
                className="bg-transparent border-0 outline-none text-sm flex-1 text-foreground placeholder:text-muted-foreground"
                placeholder="Search item, code, category, store..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search stock"
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
                choices={loading && !allRows.length ? undefined : choicesFor(f.key)}
                selected={picked[f.key] ?? []}
                onChange={(next) => setFilter(f.key, next)}
              />
            ))}
          </div>
          {chips.length > 0 && (
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
              <button type="button" onClick={clearAll} className="text-xs text-teal-500 hover:underline">
                Clear all
              </button>
              <Link href="/inventory/ledger" className="ml-auto text-xs text-teal-400 hover:underline">
                See every movement →
              </Link>
            </div>
          )}
          {chips.length === 0 && (
            <div className="flex justify-end">
              <Link href="/inventory/ledger" className="text-xs text-teal-400 hover:underline">
                See every movement →
              </Link>
            </div>
          )}
        </div>

        {loading && allRows.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
        ) : shown.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              {narrowed
                ? 'Nothing matches that.'
                : 'No stock yet. Start with opening stock — what is already on the racks today.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Item</th>
                  <th>Store</th>
                  <th style={{ textAlign: 'right' }}>On hand</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={`${r.itemId}-${r.warehouseId}-${r.ownerName ?? ''}`}>
                    <td className="whitespace-nowrap font-mono text-xs text-teal-500">{r.itemCode}</td>
                    <td>
                      <Link
                        href={`/inventory/stock/${r.itemId}`}
                        className="font-medium text-foreground hover:text-teal-400"
                      >
                        {r.itemName}
                      </Link>
                      <div className="text-[11px] text-muted-foreground">
                        {r.categoryName}
                        {r.departmentName ? ` · ${r.departmentName}` : ''}
                      </div>
                    </td>
                    <td>
                      <div className={`text-sm ${r.nowhere ? 'text-amber-400' : ''}`}>{r.warehouseName}</div>
                      {r.ownership === 'CUSTOMER_OWNED' && (
                        <div className="text-[10px] text-sky-400">
                          {r.ownerName ?? 'customer'}&apos;s material
                        </div>
                      )}
                    </td>
                    <td className="text-right tabular-nums">
                      <div className="flex items-center justify-end gap-1.5">
                        {r.isLow && (
                          <AlertTriangle size={13} className="text-amber-400" aria-label="Needs reordering" />
                        )}
                        <span className={r.isLow ? 'text-amber-400 font-semibold' : ''}>{qtyFmt(r.qty)}</span>
                        <span className="text-xs text-muted-foreground w-8 text-left">{r.uom}</span>
                      </div>
                      {/* The flag is for the item, not this store: say what it
                        is judged on, so a store holding plenty is not a puzzle. */}
                      {r.isLow && r.reorderLevel !== null && (
                        <div className="text-[10px] text-muted-foreground">
                          {r.itemOnHand !== null && r.itemOnHand !== r.qty
                            ? `${qtyFmt(r.itemOnHand)} in all stores · `
                            : ''}
                          reorder at {qtyFmt(r.reorderLevel)}
                        </div>
                      )}
                    </td>
                    <td className="text-right tabular-nums text-muted-foreground">
                      {r.ownership === 'OWNED' && !r.nowhere ? `₹${money(r.avgRate)}` : '—'}
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      {r.ownership === 'OWNED' && !r.nowhere ? `₹${money(r.value)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog && (
        <StockMoveDialog
          mode={dialog}
          onClose={() => setDialog(null)}
          onSaved={(msg) => {
            setDialog(null)
            setMessage(msg)
            void load()
          }}
        />
      )}
      {importing && (
        <ImportItemsDialog
          onClose={() => setImporting(false)}
          onImported={() => {
            setMessage('Imported. The list shows the new stock.')
            void load()
          }}
        />
      )}
    </div>
  )
}

// useSearchParams needs a Suspense boundary, as on the ledger page, or the
// whole route opts out of static rendering and the build refuses it.
export default function StockPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading...</p>}>
      <StockScreen />
    </Suspense>
  )
}
