'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  Plus, Search, RefreshCw, AlertCircle, Ban, X, Download, Loader2, FileSpreadsheet, CalendarDays,
  List, LayoutDashboard, FileText, Boxes, AlertTriangle, Users, Warehouse as WarehouseIcon, PackageCheck,
  LineChart, Target, PieChart as PieIcon, Undo2, Printer,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { CustomerMaterialDialog } from '@/components/inventory/CustomerMaterialDialog'
import { ImportCustomerMaterialDialog } from '@/components/inventory/ImportCustomerMaterialDialog'
import { CustomerReturnDialog } from '@/components/inventory/CustomerReturnDialog'
import { FilterMenu, type FilterChoice } from '@/components/masters/FilterMenu'
import { DashCard, KpiTile, TONE } from '@/components/dashboard/DashKit'
import { Pagination } from '@/components/tables/Pagination'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { ActionMenu } from '@/components/tables/ActionMenu'
import {
  ArrivalGauge, CategoryDonut, CustomerBars, ReceiptTrend, StoreColumns,
} from '@/components/inventory/MaterialCharts'
import { formatDate } from '@/lib/utils'

/**
 * Material customers have sent in for us to work on.
 *
 * It is in our godown and it is not ours. The stock screen shows it under the
 * customer's name with no value against it, and the stock figure never counts
 * it — this screen is where it comes in and, if a receipt was wrong, goes back
 * off again.
 *
 * One row per item received, with the receipt's details beside the item's,
 * read once and narrowed here so the dropdowns, their counts, the figures and
 * the dashboard all agree. The dashboard also shows what is still with us,
 * from the ledger, since that is what the customer will ask about.
 */

interface LineRow {
  id: string
  receiptId: string
  grnNumber: string
  receiptDate: string
  challanNumber: string | null
  challanDate: string | null
  gateEntryNumber: string | null
  vehicleNo: string | null
  transporter: string | null
  notes: string | null
  cancelledAt: string | null
  cancelReason: string | null
  customerId: string
  customerName: string
  soNumber: string | null
  warehouseId: string
  warehouseName: string
  receivedByName: string | null
  lineCount: number
  itemId: string
  itemCode: string
  itemName: string
  uom: string
  itemType: string
  mainCategoryId: string
  mainCategoryName: string
  subCategoryId: string | null
  subCategoryName: string | null
  departmentId: string | null
  departmentName: string | null
  challanQty: number
  receivedQty: number
  batchNumber: string | null
  markings: string | null
}

interface HeldRow {
  itemId: string
  itemCode: string
  itemName: string
  uom: string
  warehouseId: string
  warehouseName: string
  customerId: string
  customerName: string
  qty: number
  lastMovedAt: string | null
  mainCategoryId: string
  mainCategoryName: string
  subCategoryName: string | null
  departmentId: string | null
  departmentName: string | null
}

/** One item on a return to the customer. */
interface ReturnRow {
  id: string
  returnId: string
  returnNumber: string
  returnDate: string
  reason: string
  reasonLabel: string
  grnNumber: string | null
  vehicleNo: string | null
  transporter: string | null
  lrNumber: string | null
  notes: string | null
  cancelledAt: string | null
  cancelReason: string | null
  customerId: string
  customerName: string
  warehouseId: string
  warehouseName: string
  createdByName: string | null
  lineCount: number
  itemId: string
  itemCode: string
  itemName: string
  uom: string
  hsnCode: string | null
  mainCategoryId: string
  mainCategoryName: string
  subCategoryName: string | null
  departmentId: string | null
  departmentName: string | null
  qty: number
  lineNotes: string | null
}

/** Receipts and returns share the fields the filters read, so one filter row serves both tabs. */
type AnyRow = LineRow | ReturnRow
const isReceipt = (r: AnyRow): r is LineRow => 'receivedQty' in r
const dateOf = (r: AnyRow) => (isReceipt(r) ? r.receiptDate : r.returnDate)

type FilterKey = 'customer' | 'store' | 'category' | 'department' | 'arrival' | 'status'

const arrivalOf = (r: LineRow) =>
  r.receivedQty === r.challanQty ? 'match' : r.receivedQty < r.challanQty ? 'short' : 'excess'

const ARRIVAL_LABEL: Record<string, string> = { match: 'Matched their challan', short: 'Short', excess: 'More than challan' }

const valueOf: Record<FilterKey, (r: AnyRow) => string> = {
  customer: (r) => r.customerId,
  store: (r) => r.warehouseId,
  category: (r) => r.mainCategoryId,
  department: (r) => r.departmentId ?? 'none',
  arrival: (r) => (isReceipt(r) ? arrivalOf(r) : 'n/a'),
  status: (r) => (r.cancelledAt ? 'cancelled' : 'active'),
}

const FILTERS: Array<{ key: FilterKey; label: string; labelOf: (r: AnyRow) => string; noneLabel?: string }> = [
  { key: 'customer', label: 'Customer', labelOf: (r) => r.customerName },
  { key: 'store', label: 'Store', labelOf: (r) => r.warehouseName },
  { key: 'category', label: 'Category', labelOf: (r) => r.mainCategoryName },
  { key: 'department', label: 'Department', labelOf: (r) => r.departmentName ?? '', noneLabel: 'No department' },
  { key: 'arrival', label: 'Arrival', labelOf: (r) => (isReceipt(r) ? ARRIVAL_LABEL[arrivalOf(r)] : '') },
  { key: 'status', label: 'Status', labelOf: (r) => (r.cancelledAt ? 'Cancelled' : 'Active') },
]

const qtyFmt = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

// Days are India's days.
const dayKey = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const localIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

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
  { key: 'custom', label: 'Custom dates' },
]

const PAGE = 50

type View = 'receipts' | 'returns' | 'dashboard'

function CustomerMaterialScreen() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const view: View = params.get('view') === 'dashboard' ? 'dashboard' : params.get('view') === 'returns' ? 'returns' : 'receipts'
  const setView = (v: View) => {
    const next = new URLSearchParams(params.toString())
    if (v === 'receipts') next.delete('view')
    else next.set('view', v)
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const [rows, setRows] = useState<LineRow[]>([])
  const [held, setHeld] = useState<HeldRow[]>([])
  const [returns, setReturns] = useState<ReturnRow[]>([])
  const [returning, setReturning] = useState<null | { customerId: string; warehouseId: string; itemId?: string }>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [importing, setImporting] = useState(false)

  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<Partial<Record<FilterKey, string[]>>>({})
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [preset, setPreset] = useState('all')
  const [page, setPage] = useState(1)

  const latest = useRef(0)
  const load = useCallback(async () => {
    const id = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const [res, back] = await Promise.all([
        api.get<{ data: LineRow[]; held: HeldRow[] }>('/inventory/customer-grn/lines'),
        api.get<{ data: ReturnRow[] }>('/inventory/customer-return/lines'),
      ])
      if (id !== latest.current) return
      setRows(res.data)
      setHeld(res.held ?? [])
      setReturns(back.data)
    } catch (err) {
      if (id !== latest.current) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing customer material.'
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
  }, [search, picked, from, to])

  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const inPeriod = useCallback(
    (r: AnyRow) => {
      const d = dayKey(dateOf(r))
      return (!from || d >= from) && (!to || d <= to)
    },
    [from, to],
  )
  const matchesSearch = useCallback(
    (r: AnyRow) => {
      if (!words.length) return true
      const hay = (
        isReceipt(r)
          ? `${r.grnNumber} ${r.challanNumber ?? ''} ${r.customerName} ${r.itemCode} ${r.itemName} ${r.warehouseName} ${r.markings ?? ''} ${r.vehicleNo ?? ''}`
          : `${r.returnNumber} ${r.grnNumber ?? ''} ${r.customerName} ${r.itemCode} ${r.itemName} ${r.warehouseName} ${r.reasonLabel} ${r.vehicleNo ?? ''} ${r.lrNumber ?? ''}`
      ).toLowerCase()
      return words.every((w) => hay.includes(w))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search],
  )

  /** Whether a row passes every filter except `skip` (a filter never narrows its own counts). */
  const passes = useCallback(
    (r: AnyRow, skip?: FilterKey) =>
      inPeriod(r) &&
      matchesSearch(r) &&
      (Object.entries(picked) as Array<[FilterKey, string[]]>).every(
        // Arrival means nothing for a return, so it never hides one.
        ([k, values]) => k === skip || !values?.length || (k === 'arrival' && !isReceipt(r)) || values.includes(valueOf[k](r)),
      ),
    [picked, matchesSearch, inPeriod],
  )

  const shown = useMemo(() => rows.filter((r) => passes(r)), [rows, passes])
  const shownReturns = useMemo(() => returns.filter((r) => passes(r)), [returns, passes])

  const choicesFor = (key: FilterKey): FilterChoice[] | undefined => {
    if (loading && !rows.length) return undefined
    const def = FILTERS.find((f) => f.key === key)!
    const labels = new Map<string, string>()
    const counts = new Map<string, number>()
    for (const r of (view === 'returns' ? returns : rows) as AnyRow[]) {
      const v = valueOf[key](r)
      if (!labels.has(v)) labels.set(v, v === 'none' ? (def.noneLabel ?? 'Not set') : def.labelOf(r))
      if (passes(r, key)) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    return [...labels.entries()]
      .map(([value, label]) => ({ value, label, count: counts.get(value) ?? 0 }))
      .sort((a, b) => (a.value === 'none' ? 1 : b.value === 'none' ? -1 : a.label.localeCompare(b.label)))
  }

  const setFilter = (key: FilterKey, values: string[]) => setPicked((p) => ({ ...p, [key]: values }))
  const sameAs = (a: string[] | undefined, b: string[]) => (a?.length ?? 0) === b.length && b.every((v) => a?.includes(v))
  const toggleTo = (key: FilterKey, values: string[]) =>
    setPicked((p) => ({ ...p, [key]: sameAs(p[key], values) ? [] : values }))
  const isSet = (key: FilterKey, values: string[]) => sameAs(picked[key], values)
  const toggleOne = (key: FilterKey, value: string) =>
    setPicked((p) => {
      const cur = p[key] ?? []
      return { ...p, [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] }
    })

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

  /*
   * The four figures, each for what the other filters leave and each a filter
   * itself. Receipts are counted once however many items they hold.
   */
  const figures = useMemo(() => {
    const noStatus = rows.filter((r) => passes(r, 'status'))
    const noArrival = rows.filter((r) => passes(r, 'arrival'))
    return {
      receipts: new Set(shown.filter((r) => !r.cancelledAt).map((r) => r.receiptId)).size,
      items: shown.length,
      customers: new Set(shown.map((r) => r.customerId)).size,
      mismatched: noArrival.filter((r) => !r.cancelledAt && arrivalOf(r) !== 'match').length,
      cancelled: new Set(noStatus.filter((r) => r.cancelledAt).map((r) => r.receiptId)).size,
    }
  }, [rows, shown, passes])

  // What is still with us, narrowed by the filters that apply to it.
  const heldShown = useMemo(() => {
    const only = (key: FilterKey, v: string) => !picked[key]?.length || picked[key]!.includes(v)
    return held.filter(
      (h) =>
        only('customer', h.customerId) &&
        only('store', h.warehouseId) &&
        only('category', h.mainCategoryId) &&
        only('department', h.departmentId ?? 'none') &&
        (!words.length ||
          words.every((w) => `${h.customerName} ${h.itemCode} ${h.itemName} ${h.warehouseName}`.toLowerCase().includes(w))),
    )
  }, [held, picked, words])

  const cancel = async (r: LineRow) => {
    const reason = prompt(
      `Why is ${r.grnNumber} being cancelled?\n\nAll ${r.lineCount} ${r.lineCount === 1 ? 'item' : 'items'} on it go back off the books. If any of ${r.customerName}'s material has already been issued to the floor, this will be refused.`,
    )
    if (!reason || reason.trim().length < 5) return
    setBusy(r.receiptId)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/inventory/customer-grn/${r.receiptId}/cancel`, {
        reason: reason.trim(),
      })
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel it.')
    } finally {
      setBusy(null)
    }
  }

  /** What the filters leave, as a spreadsheet: every item row with its receipt. */
  const exportRows = async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      if (view === 'returns') {
        const book = XLSX.utils.book_new()
        const sheet = XLSX.utils.json_to_sheet(
          shownReturns.map((r) => ({
            Return: r.returnNumber,
            'Returned On': dayKey(r.returnDate),
            Customer: r.customerName,
            'Against Receipt': r.grnNumber ?? '',
            Reason: r.reasonLabel,
            'From Store': r.warehouseName,
            'Item Code': r.itemCode,
            'Item Name': r.itemName,
            Category: r.mainCategoryName,
            'Sub Category': r.subCategoryName ?? '',
            HSN: r.hsnCode ?? '',
            Qty: r.qty,
            Unit: r.uom,
            'Vehicle No': r.vehicleNo ?? '',
            Transport: r.transporter ?? '',
            'LR No': r.lrNumber ?? '',
            Status: r.cancelledAt ? 'Cancelled' : 'Returned',
            'Cancel Reason': r.cancelReason ?? '',
            'Returned By': r.createdByName ?? '',
            Note: [r.notes, r.lineNotes].filter(Boolean).join(' · '),
          })),
        )
        sheet['!cols'] = [14, 12, 26, 15, 26, 20, 14, 30, 18, 18, 10, 10, 7, 13, 16, 12, 10, 26, 18, 30].map((wch) => ({ wch }))
        XLSX.utils.book_append_sheet(book, sheet, 'Returned To Customers')
        XLSX.writeFile(book, `customer-returns-${dayKey(new Date())}.xlsx`)
        return
      }
      const sheet = XLSX.utils.json_to_sheet(
        shown.map((r) => ({
          Receipt: r.grnNumber,
          'Received On': dayKey(r.receiptDate),
          Customer: r.customerName,
          'Their Challan No': r.challanNumber ?? '',
          'Their Challan Date': r.challanDate ? dayKey(r.challanDate) : '',
          'Against Order': r.soNumber ?? '',
          Store: r.warehouseName,
          'Gate Entry No': r.gateEntryNumber ?? '',
          'Vehicle No': r.vehicleNo ?? '',
          Transport: r.transporter ?? '',
          'Item Code': r.itemCode,
          'Item Name': r.itemName,
          Category: r.mainCategoryName,
          'Sub Category': r.subCategoryName ?? '',
          Department: r.departmentName ?? '',
          'Their Challan Qty': r.challanQty,
          'Arrived Qty': r.receivedQty,
          'Short / Excess': Number((r.receivedQty - r.challanQty).toFixed(3)),
          Unit: r.uom,
          'Their Markings': r.markings ?? '',
          Status: r.cancelledAt ? 'Cancelled' : 'Active',
          'Cancel Reason': r.cancelReason ?? '',
          'Received By': r.receivedByName ?? '',
          Note: r.notes ?? '',
        })),
      )
      sheet['!cols'] = [15, 12, 26, 16, 14, 14, 20, 13, 13, 16, 14, 30, 18, 18, 14, 12, 12, 12, 7, 18, 10, 26, 18, 30].map((wch) => ({ wch }))
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, 'Customer Material')
      if (heldShown.length) {
        XLSX.utils.book_append_sheet(
          book,
          XLSX.utils.json_to_sheet(
            heldShown.map((h) => ({
              Customer: h.customerName,
              'Item Code': h.itemCode,
              'Item Name': h.itemName,
              Category: h.mainCategoryName,
              Store: h.warehouseName,
              'Still Here': h.qty,
              Unit: h.uom,
              'Last Moved': h.lastMovedAt ? dayKey(h.lastMovedAt) : '',
            })),
          ),
          'Still With Us',
        )
      }
      XLSX.writeFile(book, `customer-material-${dayKey(new Date())}.xlsx`)
    } catch {
      setError('The export could not be made.')
    } finally {
      setExporting(false)
    }
  }

  // ── dashboard figures ──
  const trend = useMemo(() => {
    const live = shown.filter((r) => !r.cancelledAt)
    if (!live.length) return []
    const days = live.map((r) => dayKey(r.receiptDate)).sort()
    const start = new Date(`${from || days[0]}T00:00:00`)
    const end = new Date(`${to || days[days.length - 1]}T00:00:00`)
    const span = Math.round((end.getTime() - start.getTime()) / 86400000) + 1
    const unit = span <= 45 ? 'day' : span <= 200 ? 'week' : 'month'
    const keyOf = (d: Date) => {
      if (unit === 'day') return localIso(d)
      if (unit === 'month') return localIso(d).slice(0, 7)
      const m = new Date(d)
      m.setDate(m.getDate() - ((m.getDay() + 6) % 7))
      return localIso(m)
    }
    const map = new Map<string, { key: string; label: string; from: string; to: string; items: number; receipts: number; ids: Set<string> }>()
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const k = keyOf(d)
      const cur = map.get(k)
      if (cur) cur.to = localIso(d)
      else {
        const label =
          unit === 'month'
            ? d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
            : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
        map.set(k, { key: k, label, from: localIso(d), to: localIso(d), items: 0, receipts: 0, ids: new Set() })
      }
    }
    for (const r of live) {
      const b = map.get(keyOf(new Date(`${dayKey(r.receiptDate)}T00:00:00`)))
      if (!b) continue
      b.items += 1
      b.ids.add(r.receiptId)
      b.receipts = b.ids.size
    }
    return [...map.values()]
  }, [shown, from, to])

  const slices = (key: FilterKey, labelOf: (r: LineRow) => string) => {
    const m = new Map<string, { value: string; label: string; count: number }>()
    for (const r of shown) {
      if (r.cancelledAt) continue
      const v = valueOf[key](r)
      const cur = m.get(v) ?? { value: v, label: labelOf(r), count: 0 }
      cur.count += 1
      m.set(v, cur)
    }
    return [...m.values()].sort((a, b) => b.count - a.count)
  }
  const live = shown.filter((r) => !r.cancelledAt)
  const arrival = {
    match: live.filter((r) => arrivalOf(r) === 'match').length,
    short: live.filter((r) => arrivalOf(r) === 'short').length,
    excess: live.filter((r) => arrivalOf(r) === 'excess').length,
  }
  const storeCols = (() => {
    const m = new Map<string, { value: string; label: string; received: number; held: number }>()
    for (const r of live) {
      const cur = m.get(r.warehouseId) ?? { value: r.warehouseId, label: r.warehouseName, received: 0, held: 0 }
      cur.received += 1
      m.set(r.warehouseId, cur)
    }
    for (const h of heldShown) {
      const cur = m.get(h.warehouseId) ?? { value: h.warehouseId, label: h.warehouseName, received: 0, held: 0 }
      cur.held += 1
      m.set(h.warehouseId, cur)
    }
    return [...m.values()].sort((a, b) => b.received + b.held - (a.received + a.held))
  })()


  const pages = Math.ceil(shown.length / PAGE) || 1
  const pageRows = shown.slice((page - 1) * PAGE, page * PAGE)
  const returnPages = Math.ceil(shownReturns.length / PAGE) || 1
  const returnPageRows = shownReturns.slice((page - 1) * PAGE, page * PAGE)
  const liveReturns = shownReturns.filter((r) => !r.cancelledAt)

  const cancelReturn = async (r: ReturnRow) => {
    const reason = prompt(
      `Why is ${r.returnNumber} being cancelled?\n\nAll ${r.lineCount} ${r.lineCount === 1 ? 'item' : 'items'} on it come back onto our racks under ${r.customerName}'s name.`,
    )
    if (!reason || reason.trim().length < 5) return
    setBusy(r.returnId)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/inventory/customer-return/${r.returnId}/cancel`, { reason: reason.trim() })
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel it.')
    } finally {
      setBusy(null)
    }
  }

  const filterBar = (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-10 min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3">
          <Search size={14} className="text-muted-foreground" />
          <input
            className="flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            placeholder="Search receipt, challan, item..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search customer material"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="text-muted-foreground">
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex h-10 items-center gap-1 rounded-lg border border-border bg-secondary px-2">
          <CalendarDays size={14} className="shrink-0 text-muted-foreground" />
          <input
            type="date"
            className="w-[118px] bg-transparent text-sm text-foreground outline-none"
            value={from}
            max={to || undefined}
            onChange={(e) => {
              setFrom(e.target.value)
              setPreset('custom')
            }}
            aria-label="From"
            title="Received from"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="date"
            className="w-[118px] bg-transparent text-sm text-foreground outline-none"
            value={to}
            min={from || undefined}
            onChange={(e) => {
              setTo(e.target.value)
              setPreset('custom')
            }}
            aria-label="To"
            title="Received up to"
          />
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
        {FILTERS.filter((f) => f.key !== 'department' && !(view === 'returns' && f.key === 'arrival')).map((f) => (
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
          <button type="button" onClick={clearAll} className="text-xs text-teal-500 hover:underline">
            Clear all
          </button>
          <span className="ml-auto text-xs text-muted-foreground">
            {view === 'returns' ? `${shownReturns.length} of ${returns.length}` : `${shown.length} of ${rows.length}`} items
          </span>
        </div>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      {/* The title, the two tabs beside it, and the buttons on the right: one line. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="page-title">Customer Material</h1>
          <div className="flex rounded-lg border border-border bg-secondary p-1" role="tablist">
            {([
              { key: 'receipts', label: 'Receipts', icon: List },
              { key: 'returns', label: 'Returns', icon: Undo2 },
              { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
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
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} title="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-secondary" onClick={() => setImporting(true)} title="Receipts from a spreadsheet">
            <FileSpreadsheet size={15} /> Import
          </button>
          <button
            className="btn-secondary"
            onClick={() => void exportRows()}
            disabled={exporting || (view === 'returns' ? shownReturns.length === 0 : shown.length === 0)}
            title={narrowed ? 'Export the rows the filters leave' : 'Export every row'}
          >
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Export
          </button>
          <button
            className="btn-secondary"
            onClick={() => setReturning({ customerId: '', warehouseId: '' })}
            disabled={!held.length}
            title={held.length ? "Send a customer's material back to them" : 'No customer material with us to return'}
          >
            <Undo2 size={15} /> Return material
          </button>
          <button className="btn-primary" onClick={() => setDialog(true)}>
            <Plus size={15} /> Receive material
          </button>
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
          <p className="text-sm text-emerald-400">{message}</p>
        </div>
      )}

      {/* The search, the period and the dropdowns, the same on both tabs.
          Raised so an open dropdown lies over the cards and charts. */}
      <div className="glass-card relative z-30 p-0">{filterBar}</div>

      {view === 'receipts' && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiTile
              icon={FileText}
              tone={TONE.teal}
              label="Receipts"
              value={String(figures.receipts)}
              sub={`${figures.customers} ${figures.customers === 1 ? 'customer' : 'customers'}${narrowed ? ' · click to show all' : ''}`}
              onClick={clearAll}
              title="Clear every filter"
            />
            <KpiTile icon={Boxes} tone={TONE.blue} label="Items received" value={String(figures.items)} sub="one row each below" />
            <KpiTile
              icon={AlertTriangle}
              tone={TONE.amber}
              label="Not as per challan"
              value={String(figures.mismatched)}
              valueClass={figures.mismatched ? 'text-amber-500' : 'text-foreground'}
              sub={isSet('arrival', ['short', 'excess']) ? 'showing only these · click to show all' : 'items short or more than their challan'}
              onClick={() => toggleTo('arrival', ['short', 'excess'])}
              active={isSet('arrival', ['short', 'excess'])}
            />
            <KpiTile
              icon={Ban}
              tone={TONE.rose}
              label="Cancelled"
              value={String(figures.cancelled)}
              sub={isSet('status', ['cancelled']) ? 'showing only these · click to show all' : 'receipts taken back off the books'}
              onClick={() => toggleTo('status', ['cancelled'])}
              active={isSet('status', ['cancelled'])}
            />
          </div>

          <div className="glass-card overflow-hidden p-0">
            {loading && !rows.length ? (
              <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
            ) : shown.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  {narrowed ? 'Nothing matches that.' : 'Nothing received yet. When a customer sends material in, book it with Receive material.'}
                </p>
              </div>
            ) : (
              <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
                <ScrollableTable>
                <table className="data-table table-compact min-w-full">
                  <thead>
                    <tr className="bg-secondary">
                      <th className="whitespace-nowrap">Receipt</th>
                      <th className="whitespace-nowrap">Customer</th>
                      <th className="whitespace-nowrap">Their challan</th>
                      <th className="whitespace-nowrap">Store</th>
                      <th className="whitespace-nowrap">Code</th>
                      <th className="whitespace-nowrap">Item</th>
                      <th className="whitespace-nowrap">Category</th>
                      <th className="whitespace-nowrap">Sub-cat.</th>
                      <th className="whitespace-nowrap">Dept.</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Challan</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Arrived</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Short / extra</th>
                      <th className="whitespace-nowrap">Status</th>
                      <th className="whitespace-nowrap">Markings</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => {
                      const diff = r.receivedQty - r.challanQty
                      return (
                        <tr key={r.id} className={r.cancelledAt ? 'opacity-60' : undefined}>
                          <td className="whitespace-nowrap">
                            <div className="font-mono text-xs font-semibold text-teal-400">{r.grnNumber}</div>
                            <div className="text-[10px] text-muted-foreground" title={r.receivedByName ? `Received by ${r.receivedByName}` : undefined}>
                              {formatDate(r.receiptDate)}
                            </div>
                          </td>
                          <td className="min-w-[120px] text-sm">
                            {r.customerName}
                            {r.soNumber && <div className="text-[10px] text-sky-400">for {r.soNumber}</div>}
                          </td>
                          <td className="whitespace-nowrap text-xs">
                            {r.challanNumber ?? <span className="text-muted-foreground">—</span>}
                            {r.challanDate && <div className="text-[10px] text-muted-foreground">{formatDate(r.challanDate)}</div>}
                          </td>
                          <td className="min-w-[90px] text-xs">{r.warehouseName}</td>
                          <td className="whitespace-nowrap font-mono text-xs text-teal-500">{r.itemCode}</td>
                          <td className="min-w-[150px]">
                            <Link href={`/inventory/stock/${r.itemId}`} className="text-sm font-medium text-foreground hover:text-teal-400">
                              {r.itemName}
                            </Link>
                          </td>
                          <td className="text-xs">{r.mainCategoryName}</td>
                          <td className="text-xs">{r.subCategoryName ?? <span className="text-muted-foreground">—</span>}</td>
                          <td className="text-xs">{r.departmentName ?? <span className="text-muted-foreground">—</span>}</td>
                          <td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                            {qtyFmt(r.challanQty)} <span className="text-xs">{r.uom}</span>
                          </td>
                          <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                            {qtyFmt(r.receivedQty)} <span className="text-xs font-normal text-muted-foreground">{r.uom}</span>
                          </td>
                          <td className="whitespace-nowrap text-right text-sm tabular-nums">
                            {diff === 0 ? (
                              <span className="badge-success">matches</span>
                            ) : (
                              <span className={diff > 0 ? 'text-amber-400' : 'text-red-400'}>
                                {diff > 0 ? '+' : '−'}
                                {qtyFmt(Math.abs(diff))} {r.uom}
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap">
                            {r.cancelledAt ? (
                              <>
                                <span className="badge-neutral">Cancelled</span>
                                {r.cancelReason && (
                                  <div className="max-w-[160px] truncate text-[10px] text-muted-foreground" title={r.cancelReason}>
                                    {r.cancelReason}
                                  </div>
                                )}
                              </>
                            ) : (
                              <span className="badge-success">Received</span>
                            )}
                          </td>
                          <td className="max-w-[160px] truncate text-xs text-muted-foreground" title={r.markings ?? undefined}>
                            {r.markings ?? '—'}
                          </td>
                          <td className="whitespace-nowrap text-right">
                            {/* A cancelled receipt has nothing left to do. */}
                            {!r.cancelledAt && (
                              <div className="flex justify-end gap-1.5">
                                <ActionMenu
                                  label={`Actions for ${r.grnNumber}`}
                                  items={[
                                    {
                                      key: 'cancel',
                                      label: `Cancel receipt (all ${r.lineCount} ${r.lineCount === 1 ? 'item' : 'items'})`,
                                      icon: busy === r.receiptId ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />,
                                      onClick: () => void cancel(r),
                                      danger: true,
                                      disabled: busy === r.receiptId,
                                    },
                                  ]}
                                />
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </ScrollableTable>
              </div>
            )}
            <Pagination page={page} pages={pages} onPageChange={setPage} />
          </div>
        </>
      )}

      {view === 'returns' && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiTile
              icon={Undo2}
              tone={TONE.teal}
              label="Returns"
              value={String(new Set(liveReturns.map((r) => r.returnId)).size)}
              sub={`${new Set(liveReturns.map((r) => r.customerId)).size} ${new Set(liveReturns.map((r) => r.customerId)).size === 1 ? 'customer' : 'customers'}${narrowed ? ' · click to show all' : ''}`}
              onClick={clearAll}
              title="Clear every filter"
            />
            <KpiTile icon={Boxes} tone={TONE.blue} label="Items returned" value={String(liveReturns.length)} sub="one row each below" />
            <KpiTile
              icon={PackageCheck}
              tone={TONE.sky}
              label="Still with us"
              value={String(held.length)}
              sub="item and store together · see the dashboard"
            />
            <KpiTile
              icon={Ban}
              tone={TONE.rose}
              label="Cancelled"
              value={String(new Set(shownReturns.filter((r) => r.cancelledAt).map((r) => r.returnId)).size)}
              sub={isSet('status', ['cancelled']) ? 'showing only these · click to show all' : 'returns taken back'}
              onClick={() => toggleTo('status', ['cancelled'])}
              active={isSet('status', ['cancelled'])}
            />
          </div>

          <div className="glass-card overflow-hidden p-0">
            {loading && !returns.length ? (
              <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
            ) : shownReturns.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  {narrowed
                    ? 'Nothing matches that.'
                    : "Nothing returned yet. When a customer's material goes back to them unworked, send it with Return material."}
                </p>
              </div>
            ) : (
              <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
                <ScrollableTable>
                <table className="data-table table-compact min-w-full">
                  <thead>
                    <tr className="bg-secondary">
                      <th className="whitespace-nowrap">Return</th>
                      <th className="whitespace-nowrap">Customer</th>
                      <th className="whitespace-nowrap">Why</th>
                      <th className="whitespace-nowrap">From store</th>
                      <th className="whitespace-nowrap">Code</th>
                      <th className="whitespace-nowrap">Item</th>
                      <th className="whitespace-nowrap">Category</th>
                      <th className="whitespace-nowrap">HSN</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Qty</th>
                      <th className="whitespace-nowrap">Vehicle</th>
                      <th className="whitespace-nowrap">Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {returnPageRows.map((r) => (
                      <tr key={r.id} className={r.cancelledAt ? 'opacity-60' : undefined}>
                        <td className="whitespace-nowrap">
                          <a
                            href={`/print/customer-return/${r.returnId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-xs font-semibold text-teal-400 hover:underline"
                            title="Open the printed challan"
                          >
                            {r.returnNumber}
                          </a>
                          <div className="text-[10px] text-muted-foreground" title={r.createdByName ? `By ${r.createdByName}` : undefined}>
                            {formatDate(r.returnDate)}
                          </div>
                        </td>
                        <td className="min-w-[120px] text-sm">
                          {r.customerName}
                          {r.grnNumber && <div className="text-[10px] text-sky-400">against {r.grnNumber}</div>}
                        </td>
                        <td className="max-w-[180px] text-xs" title={r.notes ?? undefined}>
                          {r.reasonLabel}
                          {r.notes && <div className="truncate text-[10px] text-muted-foreground">{r.notes}</div>}
                        </td>
                        <td className="min-w-[90px] text-xs">{r.warehouseName}</td>
                        <td className="whitespace-nowrap font-mono text-xs text-teal-500">{r.itemCode}</td>
                        <td className="min-w-[150px]">
                          <Link href={`/inventory/stock/${r.itemId}`} className="text-sm font-medium text-foreground hover:text-teal-400">
                            {r.itemName}
                          </Link>
                          {r.lineNotes && <div className="text-[10px] text-muted-foreground">{r.lineNotes}</div>}
                        </td>
                        <td className="text-xs">{r.mainCategoryName}</td>
                        <td className="font-mono text-xs text-muted-foreground">{r.hsnCode ?? '—'}</td>
                        <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                          {qtyFmt(r.qty)} <span className="text-xs font-normal text-muted-foreground">{r.uom}</span>
                        </td>
                        <td className="whitespace-nowrap text-xs">
                          {r.vehicleNo ?? <span className="text-muted-foreground">—</span>}
                          {r.lrNumber && <div className="text-[10px] text-muted-foreground">LR {r.lrNumber}</div>}
                        </td>
                        <td className="whitespace-nowrap">
                          {r.cancelledAt ? <span className="badge-neutral">Cancelled</span> : <span className="badge-success">Returned</span>}
                          {r.cancelReason && (
                            <div className="max-w-[160px] truncate text-[10px] text-muted-foreground" title={r.cancelReason}>
                              {r.cancelReason}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-right">
                          <div className="flex justify-end gap-1.5">
                            {/* Print is always there; cancel only while the return stands. */}
                            <ActionMenu
                              label={`Actions for ${r.returnNumber}`}
                              items={[
                                { key: 'print', label: 'View / print', icon: <Printer size={14} />, href: `/print/customer-return/${r.returnId}`, newTab: true },
                                ...(r.cancelledAt
                                  ? []
                                  : [
                                      {
                                        key: 'cancel',
                                        label: `Cancel return (all ${r.lineCount} ${r.lineCount === 1 ? 'item' : 'items'})`,
                                        icon: busy === r.returnId ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />,
                                        onClick: () => void cancelReturn(r),
                                        danger: true,
                                        disabled: busy === r.returnId,
                                      },
                                    ]),
                              ]}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </ScrollableTable>
              </div>
            )}
            <Pagination page={page} pages={returnPages} onPageChange={setPage} />
          </div>
        </>
      )}

      {view === 'dashboard' && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiTile
              icon={Users}
              tone={TONE.sky}
              label="Customers' material here"
              value={String(new Set(heldShown.map((h) => h.customerId)).size)}
              sub="customers with something in our stores now"
            />
            <KpiTile icon={PackageCheck} tone={TONE.teal} label="Items still with us" value={String(heldShown.length)} sub="item and store together, listed below" />
            <KpiTile
              icon={FileText}
              tone={TONE.blue}
              label="Received"
              value={String(live.length)}
              sub={`items on ${new Set(live.map((r) => r.receiptId)).size} receipts · ${liveReturns.length} returned`}
            />
            <KpiTile
              icon={AlertTriangle}
              tone={TONE.rose}
              label="Arrived short"
              value={String(arrival.short)}
              valueClass={arrival.short ? 'text-rose-500' : 'text-foreground'}
              sub={live.length ? `${Math.round((arrival.short / live.length) * 100)}% of items · click to filter` : 'nothing received'}
              onClick={() => toggleTo('arrival', ['short'])}
              active={isSet('arrival', ['short'])}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <DashCard className="lg:col-span-2" icon={LineChart} title="Receipts over time" hint="Items and receipts booked in. Click a point to see that period.">
              <ReceiptTrend
                data={trend}
                onPick={(f, t) => {
                  setFrom(f)
                  setTo(t)
                  setPreset('custom')
                }}
              />
            </DashCard>
            <DashCard icon={Target} title="Against their challan" hint="How often what arrived matched their paperwork">
              <ArrivalGauge matched={arrival.match} short={arrival.short} excess={arrival.excess} onPick={(v) => toggleTo('arrival', [v])} />
            </DashCard>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <DashCard icon={Users} title="By customer" hint="Items received. Click one to filter.">
              <CustomerBars data={slices('customer', (r) => r.customerName)} picked={picked.customer ?? []} onPick={(v) => toggleOne('customer', v)} />
            </DashCard>
            <DashCard icon={PieIcon} title="By category" hint="Share of items received. Click a slice to filter.">
              <CategoryDonut data={slices('category', (r) => r.mainCategoryName)} picked={picked.category ?? []} onPick={(v) => toggleOne('category', v)} />
            </DashCard>
            <DashCard icon={WarehouseIcon} title="By store" hint="Items received, and items still there now">
              <StoreColumns data={storeCols} onPick={(v) => toggleOne('store', v)} />
            </DashCard>
          </div>

          {/* What the customer will ask about: what of theirs is still here. */}
          <div className="glass-card overflow-hidden rounded-xl p-0">
            <div className="flex items-start gap-3 px-5 pt-5">
              <span className="bg-primary/10 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                <WarehouseIcon size={16} />
              </span>
              <div>
                <h3 className="text-[15px] font-semibold leading-tight text-foreground">Still with us</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">What of each customer&apos;s is in our stores today, from the stock ledger</p>
              </div>
            </div>
            {heldShown.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-muted-foreground">No customer material in our stores.</p>
            ) : (
              <ScrollableTable className="mt-2">
                <table className="data-table table-compact min-w-full">
                  <thead>
                    <tr className="bg-secondary">
                      <th className="whitespace-nowrap">Customer</th>
                      <th className="whitespace-nowrap">Code</th>
                      <th className="whitespace-nowrap">Item</th>
                      <th className="whitespace-nowrap">Category</th>
                      <th className="whitespace-nowrap">Store</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Still here</th>
                      <th className="whitespace-nowrap">Last moved</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {[...heldShown]
                      .sort((a, b) => a.customerName.localeCompare(b.customerName) || a.itemName.localeCompare(b.itemName))
                      .map((h) => (
                        <tr key={`${h.customerId}-${h.itemId}-${h.warehouseId}`}>
                          <td className="text-sm text-sky-400">{h.customerName}</td>
                          <td className="whitespace-nowrap font-mono text-xs text-teal-500">{h.itemCode}</td>
                          <td className="min-w-[180px] text-sm font-medium text-foreground">{h.itemName}</td>
                          <td className="text-xs">{h.mainCategoryName}</td>
                          <td className="text-xs">{h.warehouseName}</td>
                          <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                            {qtyFmt(h.qty)} <span className="text-xs font-normal text-muted-foreground">{h.uom}</span>
                          </td>
                          <td className="whitespace-nowrap text-xs text-muted-foreground">
                            {h.lastMovedAt ? formatDate(h.lastMovedAt) : '—'}
                          </td>
                          <td className="whitespace-nowrap text-right">
                            <div className="flex justify-end gap-1.5">
                              <button
                                type="button"
                                className="btn-primary h-7 px-2.5 text-xs"
                                onClick={() => setReturning({ customerId: h.customerId, warehouseId: h.warehouseId, itemId: h.itemId })}
                                title={`Send this back to ${h.customerName}`}
                              >
                                <Undo2 size={13} /> Return
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </ScrollableTable>
            )}
          </div>
        </>
      )}

      {dialog && (
        <CustomerMaterialDialog
          onClose={() => setDialog(false)}
          onSaved={(msg) => {
            setDialog(false)
            setMessage(msg)
            void load()
          }}
        />
      )}
      {returning && (
        <CustomerReturnDialog
          held={held.map((h) => ({ ...h, customerName: h.customerName ?? 'Customer' }))}
          receipts={[...new Map(rows.filter((r) => !r.cancelledAt).map((r) => [r.receiptId, { id: r.receiptId, grnNumber: r.grnNumber, customerId: r.customerId, date: r.receiptDate }])).values()]}
          start={returning.customerId ? returning : undefined}
          onClose={() => setReturning(null)}
          onSaved={(msg) => {
            setReturning(null)
            setMessage(msg)
            setView('returns')
            void load()
          }}
        />
      )}
      {importing && (
        <ImportCustomerMaterialDialog
          onClose={() => setImporting(false)}
          onImported={() => {
            setMessage('Imported. The list shows the new receipts.')
            void load()
          }}
        />
      )}
    </div>
  )
}

// useSearchParams needs a Suspense boundary or the route opts out of static rendering.
export default function CustomerMaterialPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading...</p>}>
      <CustomerMaterialScreen />
    </Suspense>
  )
}
