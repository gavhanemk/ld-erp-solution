'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, RefreshCw, AlertCircle, X, Download, Loader2, PackageCheck } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FilterMenu, type FilterChoice } from '@/components/masters/FilterMenu'
import { Pagination } from '@/components/tables/Pagination'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { formatDate } from '@/lib/utils'

/**
 * Every item on the indent, across all open requisitions — the old system's
 * indent list in one place. What is to be bought, what is ordered and received,
 * and on which POs. Process opens the requisition to change what to buy.
 */

interface Row {
  lineId: string
  mrId: string
  mrNumber: string
  requestDate: string
  requiredDate: string | null
  departmentId: string
  departmentName: string
  soNumber: string | null
  customerId: string | null
  customerName: string | null
  itemId: string
  itemCode: string
  itemName: string
  uom: string
  purpose: string | null
  asked: number
  issued: number
  toBuy: number
  ordered: number
  received: number
  poNumbers: string | null
}

type StateKey = 'notOrdered' | 'part' | 'ordered' | 'received'
const STATE: Record<StateKey, { label: string; cls: string }> = {
  notOrdered: { label: 'Not ordered yet', cls: 'badge-warning' },
  part: { label: 'Part ordered', cls: 'badge-warning' },
  ordered: { label: 'Ordered', cls: 'badge-info' },
  received: { label: 'Received', cls: 'badge-success' },
}
const stateOf = (r: Row): StateKey =>
  r.ordered <= 0 ? 'notOrdered' : r.ordered + 1e-9 < r.toBuy ? 'part' : r.received + 1e-9 >= r.ordered ? 'received' : 'ordered'

type FilterKey = 'state' | 'department' | 'customer'
const dayKey = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const qtyFmt = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })
const PAGE = 50

export function IndentsView({ onProcess }: { onProcess: (mrId: string) => void }) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<Partial<Record<FilterKey, string[]>>>({})
  const [page, setPage] = useState(1)

  const latest = useRef(0)
  const load = useCallback(async () => {
    const id = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: Row[] }>('/inventory/indents')
      if (id === latest.current) setRows(res.data)
    } catch (err) {
      if (id === latest.current) setError(err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?')
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => setPage(1), [search, picked])

  const valueOf: Record<FilterKey, (r: Row) => string> = {
    state: (r) => stateOf(r),
    department: (r) => r.departmentId,
    customer: (r) => r.customerId ?? 'none',
  }
  const FILTERS: Array<{ key: FilterKey; label: string; labelOf: (r: Row) => string; order?: string[] }> = [
    { key: 'state', label: 'Status', labelOf: (r) => STATE[stateOf(r)].label, order: Object.keys(STATE) },
    { key: 'department', label: 'Department', labelOf: (r) => r.departmentName },
    { key: 'customer', label: 'Customer', labelOf: (r) => r.customerName ?? 'No customer' },
  ]
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const passes = useCallback(
    (r: Row, skip?: FilterKey) =>
      (!words.length ||
        words.every((w) =>
          `${r.mrNumber} ${r.itemCode} ${r.itemName} ${r.departmentName} ${r.customerName ?? ''} ${r.soNumber ?? ''} ${r.poNumbers ?? ''}`.toLowerCase().includes(w),
        )) &&
      (Object.entries(picked) as Array<[FilterKey, string[]]>).every(([k, v]) => k === skip || !v?.length || v.includes(valueOf[k](r))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [picked, search],
  )
  const shown = useMemo(() => rows.filter((r) => passes(r)), [rows, passes])
  const choicesFor = (key: FilterKey): FilterChoice[] | undefined => {
    if (loading && !rows.length) return undefined
    const def = FILTERS.find((f) => f.key === key)!
    const labels = new Map<string, string>()
    const counts = new Map<string, number>()
    if (key === 'state') for (const k of Object.keys(STATE) as StateKey[]) labels.set(k, STATE[k].label)
    for (const r of rows) {
      const v = valueOf[key](r)
      if (!labels.has(v)) labels.set(v, def.labelOf(r))
      if (passes(r, key)) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    const rank = (v: string) => (def.order ? def.order.indexOf(v) : 0)
    return [...labels.entries()]
      .map(([value, label]) => ({ value, label, count: counts.get(value) ?? 0 }))
      .sort((a, b) => (def.order ? rank(a.value) - rank(b.value) : a.label.localeCompare(b.label)))
  }
  const setFilter = (key: FilterKey, values: string[]) => setPicked((p) => ({ ...p, [key]: values }))
  const chips = FILTERS.flatMap((f) =>
    (picked[f.key] ?? []).map((v) => ({ key: f.key, value: v, text: `${f.label}: ${(choicesFor(f.key) ?? []).find((c) => c.value === v)?.label ?? '…'}` })),
  )

  // One plain line of figures for what the filters leave.
  const notOrdered = shown.filter((r) => stateOf(r) === 'notOrdered' || stateOf(r) === 'part').length
  const onOrder = shown.filter((r) => stateOf(r) === 'ordered').length

  const exportRows = async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const sheet = XLSX.utils.json_to_sheet(
        shown.map((r) => ({
          Requisition: r.mrNumber,
          Date: dayKey(r.requestDate),
          'Needed By': r.requiredDate ? dayKey(r.requiredDate) : '',
          Department: r.departmentName,
          Customer: r.customerName ?? '',
          'Sales Order': r.soNumber ?? '',
          'Item Code': r.itemCode,
          'Item Name': r.itemName,
          Unit: r.uom,
          'Requisition Qty': r.asked,
          'Issued Qty': r.issued,
          'Indent Qty': r.toBuy,
          'Ordered Qty': r.ordered,
          'Received Qty': r.received,
          'Still To Order': Math.max(0, Number((r.toBuy - r.ordered).toFixed(3))),
          'PO Numbers': r.poNumbers ?? '',
          Status: STATE[stateOf(r)].label,
        })),
      )
      sheet['!cols'] = [16, 11, 11, 16, 24, 14, 14, 30, 6, 12, 10, 10, 11, 11, 12, 20, 16].map((wch) => ({ wch }))
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, 'Indents')
      XLSX.writeFile(book, `indents-${dayKey(new Date())}.xlsx`)
    } catch {
      setError('Could not build the spreadsheet.')
    } finally {
      setExporting(false)
    }
  }

  const pages = Math.ceil(shown.length / PAGE) || 1
  const pageRows = shown.slice((page - 1) * PAGE, page * PAGE)
  const dash = <span className="text-muted-foreground">—</span>
  const num = 'whitespace-nowrap text-right tabular-nums'

  return (
    <>
      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="flex-1 text-sm text-red-400">{error}</p>
        </div>
      )}

      <div className="glass-card relative z-30 space-y-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-10 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              placeholder="Search item, requisition, customer, PO..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search indents"
            />
            {search && (
              <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="text-muted-foreground">
                <X size={14} />
              </button>
            )}
          </div>
          {FILTERS.map((f) => (
            <FilterMenu key={f.key} label={f.label} choices={choicesFor(f.key)} selected={picked[f.key] ?? []} onChange={(next) => setFilter(f.key, next)} />
          ))}
          <button className="btn-ghost h-10" onClick={() => void load()} disabled={loading} title="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-secondary h-10" onClick={() => void exportRows()} disabled={exporting || !shown.length}>
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Export
          </button>
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
          {(chips.length > 0 || words.length > 0) && (
            <button type="button" onClick={() => (setPicked({}), setSearch(''))} className="text-xs text-primary hover:underline">
              Clear all
            </button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {shown.length} {shown.length === 1 ? 'item' : 'items'} on the indent · {notOrdered} still to order · {onOrder} on order
          </span>
        </div>
      </div>

      <div className="glass-card overflow-hidden p-0">
        {loading && !rows.length ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
        ) : !shown.length ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {rows.length ? 'Nothing matches that.' : 'Nothing is on the indent. Items go on it from a requisition’s Process window — the Buy box, step 3.'}
          </p>
        ) : (
          <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
            <ScrollableTable>
              <table className="data-table table-compact min-w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th className="whitespace-nowrap">Requisition</th>
                    <th className="whitespace-nowrap">Department</th>
                    <th className="whitespace-nowrap">For</th>
                    <th className="whitespace-nowrap">Item</th>
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Asked</th>
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Issued</th>
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>To buy</th>
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Ordered</th>
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Received</th>
                    <th className="whitespace-nowrap">PO</th>
                    <th className="whitespace-nowrap">Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => {
                    const st = STATE[stateOf(r)]
                    const late = r.requiredDate && dayKey(r.requiredDate) < dayKey(new Date()) && stateOf(r) !== 'received'
                    return (
                      <tr key={r.lineId}>
                        <td className="whitespace-nowrap">
                          <div className="font-mono text-xs font-semibold text-primary">{r.mrNumber}</div>
                          <div className={`text-[11px] ${late ? 'font-semibold text-red-500' : 'text-muted-foreground'}`}>
                            {formatDate(r.requestDate)}
                            {r.requiredDate ? ` · needed ${formatDate(r.requiredDate)}` : ''}
                          </div>
                        </td>
                        <td className="whitespace-nowrap text-sm">{r.departmentName}</td>
                        <td className="whitespace-nowrap text-sm">{r.customerName ?? dash}</td>
                        <td className="min-w-[200px]">
                          <div className="text-sm font-medium text-foreground">{r.itemName}</div>
                          <div className="font-mono text-[11px] text-muted-foreground">{r.itemCode}</div>
                        </td>
                        <td className={num}>
                          {qtyFmt(r.asked)} <span className="text-[11px] text-muted-foreground">{r.uom}</span>
                        </td>
                        <td className={num}>{r.issued > 0 ? <span className="text-emerald-600">{qtyFmt(r.issued)}</span> : dash}</td>
                        <td className={`${num} font-semibold text-sky-600`}>{qtyFmt(r.toBuy)}</td>
                        <td className={num}>{r.ordered > 0 ? qtyFmt(r.ordered) : dash}</td>
                        <td className={num}>{r.received > 0 ? <span className="text-emerald-600">{qtyFmt(r.received)}</span> : dash}</td>
                        <td className="whitespace-nowrap font-mono text-xs">
                          {r.poNumbers
                            ? r.poNumbers.split(', ').map((n) => (
                                <a key={n} href={`/purchase/orders?q=${encodeURIComponent(n)}`} target="_blank" rel="noreferrer" className="mr-1 text-primary hover:underline">
                                  {n}
                                </a>
                              ))
                            : dash}
                        </td>
                        <td className="whitespace-nowrap">
                          <span className={st.cls}>{st.label}</span>
                        </td>
                        <td className="whitespace-nowrap text-right">
                          <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={() => onProcess(r.mrId)} title="Open the requisition to change what to buy">
                            <PackageCheck size={13} /> Process
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </ScrollableTable>
            <Pagination page={page} pages={pages} onPageChange={setPage} />
          </div>
        )}
      </div>
    </>
  )
}
