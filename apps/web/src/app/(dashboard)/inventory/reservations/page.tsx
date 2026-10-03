'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Search, RefreshCw, AlertCircle, X, Download, Loader2, Lock, Users, ClipboardList, Hourglass, Unlock,
} from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { FilterMenu, type FilterChoice } from '@/components/masters/FilterMenu'
import { KpiTile, TONE } from '@/components/dashboard/DashKit'
import { Pagination } from '@/components/tables/Pagination'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { formatDate } from '@/lib/utils'

/**
 * Stock held on the racks for requisitions, and who it is held for.
 *
 * A reservation keeps material in the store — it is still in the stock figure —
 * but no other requisition is given it. It is made in a requisition's Fulfil
 * window, used up when that requisition is issued, and let go here or when the
 * requisition is closed. The customer comes from the requisition's sales order.
 */

interface Row {
  id: string
  status: 'ACTIVE' | 'CONSUMED' | 'RELEASED'
  qty: number
  reservedQty: number
  itemId: string
  itemCode: string
  itemName: string
  uom: string
  mainCategoryName: string
  subCategoryName: string | null
  warehouseId: string
  warehouseName: string
  mrId: string
  mrNumber: string
  neededBy: string | null
  departmentId: string
  departmentName: string
  asked: number
  issued: number
  soNumber: string | null
  customerId: string | null
  customerName: string | null
  reservedBy: string | null
  reservedAt: string
  updatedAt: string
  releasedBy: string | null
  releasedAt: string | null
  releaseReason: string | null
}

type FilterKey = 'status' | 'customer' | 'store' | 'department' | 'category'

const STATUS: Record<Row['status'], { label: string; cls: string }> = {
  ACTIVE: { label: 'Held', cls: 'badge-info' },
  CONSUMED: { label: 'Issued', cls: 'badge-success' },
  RELEASED: { label: 'Released', cls: 'badge-neutral' },
}

const dayKey = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000)
const qtyFmt = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })
const PAGE = 50

export default function ReservationsPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<Partial<Record<FilterKey, string[]>>>({ status: ['ACTIVE'] })
  const [page, setPage] = useState(1)
  const [releasing, setReleasing] = useState<Row | null>(null)

  const today = dayKey(new Date())

  const latest = useRef(0)
  const load = useCallback(async () => {
    const id = ++latest.current
    setLoading(true)
    setError(null)
    try {
      // Every reservation, held or not: the status filter narrows on the screen.
      const res = await api.get<{ data: Row[] }>('/inventory/reservations?status=all')
      if (id !== latest.current) return
      setRows(res.data)
    } catch (err) {
      if (id !== latest.current) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing reservations.'
            : err.message
          : 'Could not reach the server. Is the API running?',
      )
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setPage(1)
  }, [search, picked])

  const valueOf: Record<FilterKey, (r: Row) => string> = {
    status: (r) => r.status,
    customer: (r) => r.customerId ?? 'none',
    store: (r) => r.warehouseId,
    department: (r) => r.departmentId,
    category: (r) => r.mainCategoryName || 'none',
  }
  const FILTERS: Array<{ key: FilterKey; label: string; labelOf: (r: Row) => string; order?: string[] }> = [
    { key: 'status', label: 'Status', labelOf: (r) => STATUS[r.status].label, order: ['ACTIVE', 'CONSUMED', 'RELEASED'] },
    { key: 'customer', label: 'Customer', labelOf: (r) => r.customerName ?? 'No sales order' },
    { key: 'store', label: 'Store', labelOf: (r) => r.warehouseName },
    { key: 'department', label: 'Department', labelOf: (r) => r.departmentName },
    { key: 'category', label: 'Category', labelOf: (r) => r.mainCategoryName || 'No category' },
  ]

  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const passes = useCallback(
    (r: Row, skip?: FilterKey) =>
      (!words.length ||
        words.every((w) =>
          `${r.itemCode} ${r.itemName} ${r.mrNumber} ${r.soNumber ?? ''} ${r.customerName ?? ''} ${r.departmentName} ${r.warehouseName}`
            .toLowerCase()
            .includes(w),
        )) &&
      (Object.entries(picked) as Array<[FilterKey, string[]]>).every(
        ([k, values]) => k === skip || !values?.length || values.includes(valueOf[k](r)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [picked, search],
  )
  const shown = useMemo(() => rows.filter((r) => passes(r)), [rows, passes])

  const choicesFor = (key: FilterKey): FilterChoice[] | undefined => {
    if (loading && !rows.length) return undefined
    const def = FILTERS.find((f) => f.key === key)!
    const labels = new Map<string, string>()
    const counts = new Map<string, number>()
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
    (picked[f.key] ?? []).map((v) => ({
      key: f.key,
      value: v,
      text: `${f.label}: ${(choicesFor(f.key) ?? []).find((c) => c.value === v)?.label ?? '…'}`,
    })),
  )

  /* ── the figures, for what is held now within the other filters ── */
  const figures = useMemo(() => {
    const held = rows.filter((r) => r.status === 'ACTIVE' && passes(r, 'status'))
    const byUnit = new Map<string, number>()
    for (const r of held) byUnit.set(r.uom, (byUnit.get(r.uom) ?? 0) + r.qty)
    const qty = [...byUnit.entries()].sort((a, b) => b[1] - a[1]).map(([u, q]) => `${qtyFmt(q)} ${u}`)
    const old = held.filter((r) => daysBetween(dayKey(r.updatedAt), today) > 15)
    return {
      lines: held.length,
      qty: qty.length ? qty.slice(0, 2).join(' · ') + (qty.length > 2 ? ` +${qty.length - 2}` : '') : null,
      customers: new Set(held.map((r) => r.customerId).filter(Boolean)).size,
      noCustomer: held.filter((r) => !r.customerId).length,
      mrs: new Set(held.map((r) => r.mrId)).size,
      old: old.length,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, passes, today])

  const release = async (r: Row, reason: string) => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/inventory/reservations/${r.id}/release`, { reason })
      setReleasing(null)
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setReleasing(null)
      setError(err instanceof ApiError ? err.message : 'Could not release it.')
    } finally {
      setBusy(false)
    }
  }

  const exportRows = async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const sheet = XLSX.utils.json_to_sheet(
        shown.map((r) => ({
          Status: STATUS[r.status].label,
          'Item Code': r.itemCode,
          'Item Name': r.itemName,
          Category: r.mainCategoryName,
          'Sub Category': r.subCategoryName ?? '',
          Store: r.warehouseName,
          Unit: r.uom,
          'Held Qty': r.qty,
          'Reserved Qty': r.reservedQty,
          Customer: r.customerName ?? '',
          'Sales Order': r.soNumber ?? '',
          Requisition: r.mrNumber,
          Department: r.departmentName,
          'Needed By': r.neededBy ? dayKey(r.neededBy) : '',
          'Reserved By': r.reservedBy ?? '',
          'Reserved On': dayKey(r.reservedAt),
          'Released By': r.releasedBy ?? '',
          'Released On': r.releasedAt ? dayKey(r.releasedAt) : '',
          'Release Reason': r.releaseReason ?? '',
        })),
      )
      sheet['!cols'] = [9, 14, 30, 16, 16, 18, 6, 10, 11, 24, 14, 16, 16, 11, 18, 11, 18, 11, 30].map((wch) => ({ wch }))
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, 'Reservations')
      XLSX.writeFile(book, `reservations-${today}.xlsx`)
    } catch {
      setError('Could not build the spreadsheet.')
    } finally {
      setExporting(false)
    }
  }

  const canRelease = can('inventory', 'edit')
  const pages = Math.ceil(shown.length / PAGE) || 1
  const pageRows = shown.slice((page - 1) * PAGE, page * PAGE)
  const dash = <span className="text-muted-foreground">—</span>
  const onlyHeld = picked.status?.length === 1 && picked.status[0] === 'ACTIVE'

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reservations</h1>
          <p className="page-subtitle">Stock held on the racks for requisitions, and the customer it is held for</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} title="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-secondary" onClick={() => void exportRows()} disabled={exporting || shown.length === 0}>
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Export
          </button>
          <Link href="/inventory/requisitions" className="btn-primary">
            <ClipboardList size={15} /> Reserve from a requisition
          </Link>
        </div>
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
          <p className="text-sm text-emerald-500">{message}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiTile
          icon={Lock}
          tone={TONE.violet}
          label="Held now"
          value={String(figures.lines)}
          sub={figures.qty ? `${figures.lines === 1 ? 'item' : 'items'} · ${figures.qty}` : 'nothing is held'}
          onClick={() => setFilter('status', onlyHeld ? [] : ['ACTIVE'])}
          active={onlyHeld}
          title="Show only what is held now"
        />
        <KpiTile
          icon={Users}
          tone={TONE.sky}
          label="Customers"
          value={String(figures.customers)}
          sub={figures.noCustomer ? `${figures.noCustomer} held with no sales order` : 'every reservation names its customer'}
        />
        <KpiTile icon={ClipboardList} tone={TONE.teal} label="Requisitions" value={String(figures.mrs)} sub="with stock held for them" />
        <KpiTile
          icon={Hourglass}
          tone={TONE.amber}
          label="Held over 15 days"
          value={String(figures.old)}
          valueClass={figures.old ? 'text-orange-500' : 'text-foreground'}
          sub={figures.old ? 'not touched for a fortnight — still wanted?' : 'nothing held for long'}
        />
      </div>

      <div className="glass-card relative z-30 space-y-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-10 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              placeholder="Search item, customer, sales order, requisition..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search reservations"
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
            <button
              type="button"
              onClick={() => {
                setPicked({})
                setSearch('')
              }}
              className="text-xs text-primary hover:underline"
            >
              Clear all
            </button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {shown.length} of {rows.length} {rows.length === 1 ? 'reservation' : 'reservations'}
          </span>
        </div>
      </div>

      <div className="glass-card overflow-hidden p-0">
        {loading && !rows.length ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
        ) : shown.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              {rows.length
                ? 'Nothing matches that.'
                : 'Nothing is reserved yet. Open an approved requisition, press Fulfil, and enter a quantity in the Reserve column.'}
            </p>
          </div>
        ) : (
          <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
            <ScrollableTable>
              <table className="data-table table-compact min-w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th className="whitespace-nowrap">Code</th>
                    <th className="whitespace-nowrap">Item</th>
                    <th className="whitespace-nowrap">Category</th>
                    <th className="whitespace-nowrap">Store</th>
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Held</th>
                    <th className="whitespace-nowrap">For customer</th>
                    <th className="whitespace-nowrap">Sales order</th>
                    <th className="whitespace-nowrap">Requisition</th>
                    <th className="whitespace-nowrap">Department</th>
                    <th className="whitespace-nowrap">Needed by</th>
                    <th className="whitespace-nowrap">Reserved</th>
                    <th className="whitespace-nowrap">Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => {
                    const late = r.status === 'ACTIVE' && r.neededBy && dayKey(r.neededBy) < today
                    return (
                      <tr key={r.id} className={r.status === 'ACTIVE' ? undefined : 'opacity-70'}>
                        <td className="whitespace-nowrap font-mono text-xs text-muted-foreground">{r.itemCode}</td>
                        <td className="min-w-[180px] text-sm font-medium text-foreground">{r.itemName}</td>
                        <td className="whitespace-nowrap text-xs">
                          {r.mainCategoryName || dash}
                          {r.subCategoryName && <span className="text-muted-foreground"> › {r.subCategoryName}</span>}
                        </td>
                        <td className="whitespace-nowrap text-xs">{r.warehouseName}</td>
                        <td className="whitespace-nowrap text-right tabular-nums">
                          {r.status === 'ACTIVE' ? (
                            <span className="font-semibold text-violet-500">
                              {qtyFmt(r.qty)} <span className="text-xs font-normal text-muted-foreground">{r.uom}</span>
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {qtyFmt(r.reservedQty)} {r.uom}
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-sm">{r.customerName ?? <span className="text-xs text-muted-foreground">no sales order</span>}</td>
                        <td className="whitespace-nowrap font-mono text-xs">{r.soNumber ?? dash}</td>
                        <td className="whitespace-nowrap font-mono text-xs font-semibold text-primary">{r.mrNumber}</td>
                        <td className="whitespace-nowrap text-xs">{r.departmentName}</td>
                        <td className={`whitespace-nowrap text-xs ${late ? 'font-semibold text-red-500' : ''}`}>
                          {r.neededBy ? formatDate(r.neededBy) : dash}
                          {late && ' · late'}
                        </td>
                        <td className="whitespace-nowrap text-xs">
                          {formatDate(r.reservedAt)}
                          {r.reservedBy && <span className="text-muted-foreground"> · {r.reservedBy}</span>}
                        </td>
                        <td className="whitespace-nowrap">
                          <span className={STATUS[r.status].cls} title={r.releaseReason ?? undefined}>
                            {STATUS[r.status].label}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-right">
                          {r.status === 'ACTIVE' && canRelease && (
                            <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={() => setReleasing(r)} disabled={busy}>
                              <Unlock size={13} /> Release
                            </button>
                          )}
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

      {releasing && (
        <ReasonDialog
          title={`Release ${qtyFmt(releasing.qty)} ${releasing.uom} ${releasing.itemName}?`}
          description={`It was held in ${releasing.warehouseName} for ${releasing.mrNumber}${releasing.customerName ? ` (${releasing.customerName})` : ''}. Released, it is free for any requisition. The requisition itself stays as it is.`}
          confirmLabel="Release it"
          minLength={3}
          placeholder="e.g. Order on hold, or needed elsewhere first"
          busy={busy}
          onConfirm={(reason) => void release(releasing, reason)}
          onCancel={() => setReleasing(null)}
        />
      )}
    </div>
  )
}
