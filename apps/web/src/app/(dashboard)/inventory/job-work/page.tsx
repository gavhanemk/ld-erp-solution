'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  Printer, Plus, Search, RefreshCw, AlertCircle, Ban, X, Download, Loader2, CalendarDays, List,
  LayoutDashboard, PackageCheck, Truck, AlarmClock, ShieldAlert, Recycle, Timer, Send, Factory, Hourglass,
  LineChart, Target, Users, PieChart as PieIcon, Layers, ArrowRight,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { SendJobWorkDialog, ReceiveJobWorkDialog } from '@/components/inventory/JobWorkDialogs'
import { FilterMenu, type FilterChoice } from '@/components/masters/FilterMenu'
import { DashCard, Highlights, KpiTile, TONE, inr, qtyFmt, qtyLine } from '@/components/dashboard/DashKit'
import { Pagination } from '@/components/tables/Pagination'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import {
  DaysOutBars, DueDonut, GstClock, ProcessPie, SentBackTrend, WasteColumns, WorkerBars,
} from '@/components/inventory/JobWorkCharts'
import { formatDate } from '@/lib/utils'

/**
 * Our own material out at an outside unit.
 *
 * It never stops being ours — it has moved to a store standing for their
 * floor, so the stock screen still shows it. This screen answers what the
 * production manager asks: what is out, with whom, since when, is it late,
 * and how close is it to the GST one-year limit.
 *
 * One row per item sent, with the challan's details beside the item's, read
 * once and narrowed here so the dropdowns, their counts, the figures and the
 * dashboard all agree.
 */

type Status = 'SENT' | 'PARTLY_BACK' | 'CLOSED' | 'CANCELLED'

interface LineRow {
  id: string
  challanId: string
  challanNumber: string
  challanDate: string
  process: string
  status: Status
  cancelReason: string | null
  expectedBackOn: string | null
  vehicleNo: string | null
  transporter: string | null
  lrNumber: string | null
  notes: string | null
  sentByName: string | null
  lineCount: number
  jobWorkerId: string
  jobWorkerName: string
  jobWorkerCity: string | null
  fromWarehouseId: string
  fromWarehouseName: string
  toWarehouseId: string
  toWarehouseName: string
  itemId: string
  itemCode: string
  itemName: string
  itemType: string
  uom: string
  hsnCode: string | null
  mainCategoryId: string
  mainCategoryName: string
  subCategoryId: string | null
  subCategoryName: string | null
  departmentId: string | null
  departmentName: string | null
  sentQty: number
  unitRate: number
  settledQty: number
  backSameQty: number
  madeInto: Array<{ itemName: string; uom: string; qty: number }>
  wastedQty: number
  stillOutQty: number
  returnNumbers: string[]
  lastReturnAt: string | null
  settledBy: Array<{ at: string; qty: number }>
}

type FilterKey = 'worker' | 'process' | 'category' | 'subCategory' | 'department' | 'due' | 'gst' | 'status' | 'from'

// Days are India's days.
const dayKey = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const localIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const daysBetween = (from: string, to: string) =>
  Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000)

/**
 * The GST limit. Inputs sent for job work have to come back within a year of
 * the challan (section 143), or they are treated as supplied on the day they
 * left and the tax falls due. Capital goods get three years; nothing sent from
 * this screen is capital goods.
 */
const GST_DAYS = 365

const STATUS_LABEL: Record<Status, string> = { SENT: 'Out', PARTLY_BACK: 'Part back', CLOSED: 'All back', CANCELLED: 'Cancelled' }
const STATUS_CLASS: Record<Status, string> = {
  SENT: 'badge-info',
  PARTLY_BACK: 'badge-warning',
  CLOSED: 'badge-success',
  CANCELLED: 'badge-neutral',
}
const DUE_LABEL: Record<string, string> = {
  overdue: 'Overdue',
  soon: 'Due within 7 days',
  ontime: 'Not yet due',
  nodate: 'No due date',
  back: 'All back',
  cancelled: 'Cancelled',
}
const GST_LABEL: Record<string, string> = {
  past: 'Past the one-year limit',
  near: 'Within 60 days of the limit',
  ok: 'More than 60 days left',
  na: 'Nothing out',
}
const OUT_STATES = ['overdue', 'soon', 'ontime', 'nodate']

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

type View = 'challans' | 'dashboard'

/** Per-unit totals, largest first: quantities in different units are never added. */
function byUnit(rows: Array<{ uom: string; qty: number }>) {
  const m = new Map<string, number>()
  for (const r of rows) if (r.qty) m.set(r.uom, (m.get(r.uom) ?? 0) + r.qty)
  return [...m.entries()].map(([uom, qty]) => ({ uom, qty: Math.round(qty * 1000) / 1000 })).sort((a, b) => b.qty - a.qty)
}

function JobWorkScreen() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const view: View = params.get('view') === 'dashboard' ? 'dashboard' : 'challans'
  const setView = (v: View) => {
    const next = new URLSearchParams(params.toString())
    if (v === 'dashboard') next.set('view', 'dashboard')
    else next.delete('view')
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const [rows, setRows] = useState<LineRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [sending, setSending] = useState(false)
  const [receiving, setReceiving] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<Partial<Record<FilterKey, string[]>>>({})
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [preset, setPreset] = useState('all')
  const [page, setPage] = useState(1)

  const today = dayKey(new Date())

  const latest = useRef(0)
  const load = useCallback(async () => {
    const id = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: LineRow[] }>('/inventory/job-work/lines')
      if (id !== latest.current) return
      setRows(res.data)
    } catch (err) {
      if (id !== latest.current) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing job work.'
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

  /* ── what each row is, worked out once ── */
  const facts = useMemo(() => {
    const m = new Map<string, { due: string; gst: string; daysOut: number; daysLate: number; gstLeft: number; valueOut: number }>()
    for (const r of rows) {
      const sentDay = dayKey(r.challanDate)
      const out = r.stillOutQty > 0
      const daysOut = daysBetween(sentDay, out || !r.lastReturnAt ? today : dayKey(r.lastReturnAt))
      const dueDay = r.expectedBackOn ? dayKey(r.expectedBackOn) : null
      const daysLate = dueDay ? daysBetween(dueDay, today) : 0
      const due =
        r.status === 'CANCELLED'
          ? 'cancelled'
          : !out
            ? 'back'
            : !dueDay
              ? 'nodate'
              : daysLate > 0
                ? 'overdue'
                : daysLate >= -7
                  ? 'soon'
                  : 'ontime'
      const gstLeft = GST_DAYS - daysBetween(sentDay, today)
      const gst = !out ? 'na' : gstLeft < 0 ? 'past' : gstLeft <= 60 ? 'near' : 'ok'
      m.set(r.id, { due, gst, daysOut, daysLate, gstLeft, valueOut: r.stillOutQty * r.unitRate })
    }
    return m
  }, [rows, today])
  const fact = (r: LineRow) => facts.get(r.id)!

  const valueOf: Record<FilterKey, (r: LineRow) => string> = useMemo(
    () => ({
      worker: (r) => r.jobWorkerId,
      process: (r) => r.process.trim().toLowerCase(),
      category: (r) => r.mainCategoryId,
      subCategory: (r) => r.subCategoryId ?? 'none',
      department: (r) => r.departmentId ?? 'none',
      due: (r) => facts.get(r.id)?.due ?? 'back',
      gst: (r) => facts.get(r.id)?.gst ?? 'na',
      status: (r) => r.status,
      from: (r) => r.fromWarehouseId,
    }),
    [facts],
  )

  const FILTERS: Array<{ key: FilterKey; label: string; menu: boolean; labelOf: (r: LineRow) => string; noneLabel?: string }> = [
    { key: 'worker', label: 'Job worker', menu: true, labelOf: (r) => r.jobWorkerName },
    { key: 'process', label: 'Work', menu: true, labelOf: (r) => r.process.trim() },
    { key: 'category', label: 'Category', menu: true, labelOf: (r) => r.mainCategoryName },
    { key: 'due', label: 'Due back', menu: true, labelOf: (r) => DUE_LABEL[valueOf.due(r)] },
    { key: 'status', label: 'Status', menu: true, labelOf: (r) => STATUS_LABEL[r.status] },
    { key: 'from', label: 'Sent from', menu: false, labelOf: (r) => r.fromWarehouseName },
    { key: 'subCategory', label: 'Sub-category', menu: false, labelOf: (r) => r.subCategoryName ?? '', noneLabel: 'No sub-category' },
    { key: 'department', label: 'Department', menu: false, labelOf: (r) => r.departmentName ?? '', noneLabel: 'No department' },
    { key: 'gst', label: 'GST limit', menu: false, labelOf: (r) => GST_LABEL[valueOf.gst(r)] },
  ]

  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const inPeriod = useCallback(
    (r: LineRow) => {
      const d = dayKey(r.challanDate)
      return (!from || d >= from) && (!to || d <= to)
    },
    [from, to],
  )
  const matchesSearch = useCallback(
    (r: LineRow) => {
      if (!words.length) return true
      const hay = `${r.challanNumber} ${r.jobWorkerName} ${r.process} ${r.itemCode} ${r.itemName} ${r.hsnCode ?? ''} ${r.vehicleNo ?? ''} ${r.lrNumber ?? ''} ${r.returnNumbers.join(' ')}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search],
  )

  /** Whether a row passes every filter except `skip` (a filter never narrows its own counts). */
  const passes = useCallback(
    (r: LineRow, skip?: FilterKey) =>
      inPeriod(r) &&
      matchesSearch(r) &&
      (Object.entries(picked) as Array<[FilterKey, string[]]>).every(
        ([k, values]) => k === skip || !values?.length || values.includes(valueOf[k](r)),
      ),
    [picked, matchesSearch, inPeriod, valueOf],
  )

  const shown = useMemo(() => rows.filter((r) => passes(r)), [rows, passes])

  const choicesFor = (key: FilterKey): FilterChoice[] | undefined => {
    if (loading && !rows.length) return undefined
    const def = FILTERS.find((f) => f.key === key)!
    const labels = new Map<string, string>()
    const counts = new Map<string, number>()
    for (const r of rows) {
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
    return values.map((v) => ({
      key: f.key,
      value: v,
      text: `${f.label}: ${choices.find((c) => c.value === v)?.label ?? DUE_LABEL[v] ?? GST_LABEL[v] ?? '…'}`,
    }))
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

  /* ── the figures ── */
  const live = useMemo(() => shown.filter((r) => r.status !== 'CANCELLED'), [shown])
  const outRows = useMemo(() => live.filter((r) => r.stillOutQty > 0), [live])
  const figures = useMemo(() => {
    const challansOf = (rs: LineRow[]) => new Set(rs.map((r) => r.challanId)).size
    const noDue = rows.filter((r) => passes(r, 'due') && r.status !== 'CANCELLED')
    const noGst = rows.filter((r) => passes(r, 'gst') && r.status !== 'CANCELLED')
    const overdue = noDue.filter((r) => fact(r).due === 'overdue')
    const gstNear = noGst.filter((r) => ['near', 'past'].includes(fact(r).gst))
    const settledValue = live.reduce((t, r) => t + r.settledQty * r.unitRate, 0)
    const wasteValue = live.reduce((t, r) => t + r.wastedQty * r.unitRate, 0)
    const settledQty = live.reduce((t, r) => t + r.settledQty, 0)
    const wastedQty = live.reduce((t, r) => t + r.wastedQty, 0)
    return {
      valueOut: outRows.reduce((t, r) => t + fact(r).valueOut, 0),
      qtyOut: byUnit(outRows.map((r) => ({ uom: r.uom, qty: r.stillOutQty }))),
      challansOut: challansOf(outRows),
      workersOut: new Set(outRows.map((r) => r.jobWorkerId)).size,
      overdueChallans: challansOf(overdue),
      overdueValue: overdue.reduce((t, r) => t + fact(r).valueOut, 0),
      gstChallans: challansOf(gstNear),
      gstPast: challansOf(gstNear.filter((r) => fact(r).gst === 'past')),
      wasteValue,
      wasteQty: byUnit(live.map((r) => ({ uom: r.uom, qty: r.wastedQty }))),
      wastePct: settledQty ? (wastedQty / settledQty) * 100 : 0,
      settledValue,
      sentValue: live.reduce((t, r) => t + r.sentQty * r.unitRate, 0),
      sentQty: byUnit(live.map((r) => ({ uom: r.uom, qty: r.sentQty }))),
      challans: challansOf(live),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, live, outRows, passes, facts])

  /** Every line of a challan, whatever the filters, for the take-back dialog and the cancel rule. */
  const challanLines = useCallback((challanId: string) => rows.filter((r) => r.challanId === challanId), [rows])

  const cancel = async (r: LineRow) => {
    const reason = prompt(
      `Why is ${r.challanNumber} being cancelled?\n\nAll ${r.lineCount} ${r.lineCount === 1 ? 'item' : 'items'} on it will be brought back to ${r.fromWarehouseName}.`,
    )
    if (!reason || reason.trim().length < 5) return
    setBusy(r.challanId)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/inventory/job-work/${r.challanId}/cancel`, { reason: reason.trim() })
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel it.')
    } finally {
      setBusy(null)
    }
  }

  /** What the filters leave, as a spreadsheet: every item row with its challan, and what is still out. */
  const exportRows = async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const sheet = XLSX.utils.json_to_sheet(
        shown.map((r) => {
          const f = fact(r)
          return {
            Challan: r.challanNumber,
            'Sent On': dayKey(r.challanDate),
            'Job Worker': r.jobWorkerName,
            City: r.jobWorkerCity ?? '',
            Work: r.process,
            'Sent From': r.fromWarehouseName,
            'Their Store': r.toWarehouseName,
            'Item Code': r.itemCode,
            'Item Name': r.itemName,
            Category: r.mainCategoryName,
            'Sub Category': r.subCategoryName ?? '',
            Department: r.departmentName ?? '',
            HSN: r.hsnCode ?? '',
            Unit: r.uom,
            'Sent Qty': r.sentQty,
            Rate: r.unitRate,
            'Value Sent': Math.round(r.sentQty * r.unitRate * 100) / 100,
            'Settled Qty': r.settledQty,
            'Came Back As Itself': r.backSameQty,
            'Made Into': r.madeInto.map((m) => `${qtyFmt(m.qty)} ${m.uom} ${m.itemName}`).join('; '),
            'Wasted Qty': r.wastedQty,
            'Still Out Qty': r.stillOutQty,
            'Value Still Out': Math.round(f.valueOut * 100) / 100,
            'Due Back': r.expectedBackOn ? dayKey(r.expectedBackOn) : '',
            'Due State': DUE_LABEL[f.due],
            'Days Out': r.status === 'CANCELLED' ? '' : f.daysOut,
            'GST Days Left': r.stillOutQty > 0 ? f.gstLeft : '',
            Status: STATUS_LABEL[r.status],
            Returns: r.returnNumbers.join(', '),
            'Vehicle No': r.vehicleNo ?? '',
            'LR No': r.lrNumber ?? '',
            'Sent By': r.sentByName ?? '',
            'Cancel Reason': r.cancelReason ?? '',
            Note: r.notes ?? '',
          }
        }),
      )
      sheet['!cols'] = [14, 11, 24, 12, 18, 18, 18, 14, 30, 16, 16, 14, 10, 6, 10, 9, 12, 10, 10, 26, 9, 10, 12, 11, 16, 8, 10, 10, 18, 12, 12, 16, 22, 26].map((wch) => ({ wch }))
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, 'Job Work')

      // What each job worker still holds, item by item.
      const held = new Map<string, { worker: string; code: string; item: string; uom: string; qty: number; value: number; oldest: number }>()
      for (const r of outRows) {
        const k = `${r.jobWorkerId}|${r.itemId}`
        const cur = held.get(k) ?? { worker: r.jobWorkerName, code: r.itemCode, item: r.itemName, uom: r.uom, qty: 0, value: 0, oldest: 0 }
        cur.qty += r.stillOutQty
        cur.value += fact(r).valueOut
        cur.oldest = Math.max(cur.oldest, fact(r).daysOut)
        held.set(k, cur)
      }
      if (held.size) {
        XLSX.utils.book_append_sheet(
          book,
          XLSX.utils.json_to_sheet(
            [...held.values()]
              .sort((a, b) => a.worker.localeCompare(b.worker) || b.value - a.value)
              .map((h) => ({
                'Job Worker': h.worker,
                'Item Code': h.code,
                'Item Name': h.item,
                'Still Out': Math.round(h.qty * 1000) / 1000,
                Unit: h.uom,
                Value: Math.round(h.value * 100) / 100,
                'Oldest (days)': h.oldest,
              })),
          ),
          'Still Out',
        )
      }
      XLSX.writeFile(book, `job-work-${today}.xlsx`)
    } catch {
      setError('The export could not be made.')
    } finally {
      setExporting(false)
    }
  }

  /* ── dashboard figures ── */
  const trend = useMemo(() => {
    if (!live.length) return []
    const days = live.map((r) => dayKey(r.challanDate)).sort()
    const start = new Date(`${from || days[0]}T00:00:00`)
    const end = new Date(`${to || today}T00:00:00`)
    const span = Math.round((end.getTime() - start.getTime()) / 86400000) + 1
    const unit = span <= 45 ? 'day' : span <= 200 ? 'week' : 'month'
    const keyOf = (d: Date) => {
      if (unit === 'day') return localIso(d)
      if (unit === 'month') return localIso(d).slice(0, 7)
      const m = new Date(d)
      m.setDate(m.getDate() - ((m.getDay() + 6) % 7))
      return localIso(m)
    }
    const map = new Map<string, { key: string; label: string; from: string; to: string; sent: number; back: number; challans: number; ids: Set<string> }>()
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const k = keyOf(d)
      const cur = map.get(k)
      if (cur) cur.to = localIso(d)
      else {
        const label =
          unit === 'month'
            ? d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
            : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
        map.set(k, { key: k, label, from: localIso(d), to: localIso(d), sent: 0, back: 0, challans: 0, ids: new Set() })
      }
    }
    const bucket = (day: string) => map.get(keyOf(new Date(`${day}T00:00:00`)))
    for (const r of live) {
      const b = bucket(dayKey(r.challanDate))
      if (b) {
        b.sent += r.sentQty * r.unitRate
        b.ids.add(r.challanId)
        b.challans = b.ids.size
      }
      for (const s of r.settledBy) {
        const c = bucket(dayKey(s.at))
        if (c) c.back += s.qty * r.unitRate
      }
    }
    return [...map.values()].map((b) => ({ ...b, sent: Math.round(b.sent), back: Math.round(b.back) }))
  }, [live, from, to, today])

  const dueSlices = useMemo(
    () =>
      OUT_STATES.map((k) => {
        const rs = outRows.filter((r) => fact(r).due === k)
        return { key: k, label: DUE_LABEL[k], value: Math.round(rs.reduce((t, r) => t + fact(r).valueOut, 0)), lines: rs.length }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outRows, facts],
  )

  const workers = useMemo(() => {
    const m = new Map<string, { id: string; name: string; onTime: number; late: number; lines: number }>()
    for (const r of outRows) {
      const cur = m.get(r.jobWorkerId) ?? { id: r.jobWorkerId, name: r.jobWorkerName, onTime: 0, late: 0, lines: 0 }
      if (fact(r).due === 'overdue') cur.late += fact(r).valueOut
      else cur.onTime += fact(r).valueOut
      cur.lines += 1
      m.set(r.jobWorkerId, cur)
    }
    return [...m.values()]
      .map((w) => ({ ...w, onTime: Math.round(w.onTime), late: Math.round(w.late) }))
      .sort((a, b) => b.onTime + b.late - (a.onTime + a.late))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outRows, facts])

  const ageing = useMemo(() => {
    const buckets = [
      { key: '0–15', label: '0 to 15 days', max: 15 },
      { key: '16–30', label: '16 to 30 days', max: 30 },
      { key: '31–60', label: '31 to 60 days', max: 60 },
      { key: '61–90', label: '61 to 90 days', max: 90 },
      { key: '90+', label: 'Over 90 days', max: Infinity },
    ].map((b) => ({ ...b, value: 0, lines: 0 }))
    for (const r of outRows) {
      const b = buckets.find((x) => fact(r).daysOut <= x.max)!
      b.value += fact(r).valueOut
      b.lines += 1
    }
    return buckets.map((b) => ({ key: b.key, label: b.label, value: Math.round(b.value), lines: b.lines }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outRows, facts])

  const processes = useMemo(() => {
    const m = new Map<string, { value: string; label: string; amount: number; challans: number; ids: Set<string> }>()
    for (const r of live) {
      const v = valueOf.process(r)
      const cur = m.get(v) ?? { value: v, label: r.process.trim(), amount: 0, challans: 0, ids: new Set<string>() }
      cur.amount += r.sentQty * r.unitRate
      cur.ids.add(r.challanId)
      cur.challans = cur.ids.size
      m.set(v, cur)
    }
    return [...m.values()].map((p) => ({ ...p, amount: Math.round(p.amount) })).sort((a, b) => b.amount - a.amount)
  }, [live, valueOf])

  const gstClock = useMemo(() => {
    const m = new Map<string, { challanId: string; challanNumber: string; jobWorkerName: string; daysGone: number; daysLeft: number; value: number }>()
    for (const r of outRows) {
      const cur = m.get(r.challanId) ?? {
        challanId: r.challanId,
        challanNumber: r.challanNumber,
        jobWorkerName: r.jobWorkerName,
        daysGone: GST_DAYS - fact(r).gstLeft,
        daysLeft: fact(r).gstLeft,
        value: 0,
      }
      cur.value += fact(r).valueOut
      m.set(r.challanId, cur)
    }
    return [...m.values()].sort((a, b) => a.daysLeft - b.daysLeft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outRows, facts])

  const waste = useMemo(() => {
    const m = new Map<string, { id: string; name: string; settled: number; wasted: number; wasteValue: number }>()
    for (const r of live) {
      if (!r.settledQty) continue
      const cur = m.get(r.jobWorkerId) ?? { id: r.jobWorkerId, name: r.jobWorkerName, settled: 0, wasted: 0, wasteValue: 0 }
      // Share of the value settled, so metres and pieces can sit in one figure.
      cur.settled += r.settledQty * (r.unitRate || 1)
      cur.wasted += r.wastedQty * (r.unitRate || 1)
      cur.wasteValue += r.wastedQty * r.unitRate
      m.set(r.jobWorkerId, cur)
    }
    return [...m.values()]
      .map((w) => ({ id: w.id, name: w.name, pct: w.settled ? Math.round((w.wasted / w.settled) * 1000) / 10 : 0, wasteValue: Math.round(w.wasteValue) }))
      .sort((a, b) => b.pct - a.pct)
  }, [live])

  const byCategory = useMemo(() => {
    const m = new Map<string, { id: string; name: string; value: number; lines: number; qty: Array<{ uom: string; qty: number }> }>()
    for (const r of outRows) {
      const cur = m.get(r.mainCategoryId) ?? { id: r.mainCategoryId, name: r.mainCategoryName, value: 0, lines: 0, qty: [] }
      cur.value += fact(r).valueOut
      cur.lines += 1
      cur.qty.push({ uom: r.uom, qty: r.stillOutQty })
      m.set(r.mainCategoryId, cur)
    }
    return [...m.values()].map((c) => ({ ...c, qty: byUnit(c.qty) })).sort((a, b) => b.value - a.value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outRows, facts])

  /** The challans somebody should ring about today: late, or near the GST limit. */
  const chase = useMemo(() => {
    const m = new Map<string, { r: LineRow; value: number; qty: Array<{ uom: string; qty: number }>; daysLate: number; gstLeft: number; daysOut: number; due: string }>()
    for (const r of outRows) {
      const f = fact(r)
      if (f.due !== 'overdue' && f.due !== 'soon' && f.gst === 'ok') continue
      const cur = m.get(r.challanId) ?? { r, value: 0, qty: [], daysLate: f.daysLate, gstLeft: f.gstLeft, daysOut: f.daysOut, due: f.due }
      cur.value += f.valueOut
      cur.qty.push({ uom: r.uom, qty: r.stillOutQty })
      m.set(r.challanId, cur)
    }
    return [...m.values()]
      .map((c) => ({ ...c, qty: byUnit(c.qty) }))
      // Most urgent first: past the GST limit, near it, late, then due this week.
      .sort((a, b) => {
        const tier = (c: { gstLeft: number; due: string }) => (c.gstLeft < 0 ? 0 : c.gstLeft <= 60 ? 1 : c.due === 'overdue' ? 2 : 3)
        const key = (c: { gstLeft: number; daysLate: number; due: string }) => (tier(c) < 2 ? c.gstLeft : -c.daysLate)
        return tier(a) - tier(b) || key(a) - key(b)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outRows, facts])

  const highlights = useMemo(() => {
    const items: Array<{ icon: React.ElementType; text: React.ReactNode; tone?: string }> = []
    const total = workers.reduce((t, w) => t + w.onTime + w.late, 0)
    if (workers.length && total) {
      const w = workers[0]
      items.push({
        icon: Factory,
        text: (
          <>
            <b className="font-semibold">{w.name}</b> holds {Math.round(((w.onTime + w.late) / total) * 100)}% of what is out
          </>
        ),
      })
    }
    if (figures.overdueChallans)
      items.push({ icon: AlarmClock, tone: TONE.rose, text: `${figures.overdueChallans} ${figures.overdueChallans === 1 ? 'challan is' : 'challans are'} past the due-back date (${inr(figures.overdueValue)})` })
    const oldest = [...outRows].sort((a, b) => fact(b).daysOut - fact(a).daysOut)[0]
    if (oldest) items.push({ icon: Hourglass, tone: TONE.amber, text: `Oldest out: ${oldest.challanNumber} at ${oldest.jobWorkerName}, ${fact(oldest).daysOut} days` })
    if (figures.gstChallans)
      items.push({ icon: ShieldAlert, tone: TONE.amber, text: `${figures.gstChallans} ${figures.gstChallans === 1 ? 'challan is' : 'challans are'} within 60 days of the GST one-year limit` })
    if (figures.wastePct) items.push({ icon: Recycle, tone: TONE.violet, text: `Waste runs at ${figures.wastePct.toFixed(1)}% of what came back` })
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workers, figures, outRows, facts])

  const avgDaysOut = useMemo(() => {
    const byChallan = new Map<string, number>()
    for (const r of outRows) byChallan.set(r.challanId, Math.max(byChallan.get(r.challanId) ?? 0, fact(r).daysOut))
    const all = [...byChallan.values()]
    return all.length ? Math.round(all.reduce((t, d) => t + d, 0) / all.length) : 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outRows, facts])

  const pages = Math.ceil(shown.length / PAGE) || 1
  const pageRows = shown.slice((page - 1) * PAGE, page * PAGE)
  const receivingLines = receiving ? challanLines(receiving) : []

  const filterBar = (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-10 min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3">
          <Search size={14} className="text-muted-foreground" />
          <input
            className="flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            placeholder="Search challan, job worker, item..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search job work"
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
            title="Sent from"
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
            title="Sent up to"
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
        {FILTERS.filter((f) => f.menu).map((f) => (
          <FilterMenu key={f.key} label={f.label} choices={choicesFor(f.key)} selected={picked[f.key] ?? []} onChange={(next) => setFilter(f.key, next)} />
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
            {shown.length} of {rows.length} items
          </span>
        </div>
      )}
    </div>
  )

  const outTile = (
    <KpiTile
      icon={Truck}
      tone={TONE.teal}
      label="Still out at job workers"
      value={inr(figures.valueOut)}
      sub={
        figures.challansOut
          ? `${qtyLine(figures.qtyOut, 2)} · ${figures.challansOut} ${figures.challansOut === 1 ? 'challan' : 'challans'}`
          : 'nothing out at the moment'
      }
      onClick={() => toggleTo('due', OUT_STATES)}
      active={isSet('due', OUT_STATES)}
      title="Show only what is still out"
    />
  )

  return (
    <div className="space-y-4">
      {/* The title, the two tabs beside it, and the buttons on the right: one line. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="page-title">Job Work</h1>
          <div className="flex rounded-lg border border-border bg-secondary p-1" role="tablist">
            {([
              { key: 'challans', label: 'Challans', icon: List },
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
          <button
            className="btn-secondary"
            onClick={() => void exportRows()}
            disabled={exporting || shown.length === 0}
            title={narrowed ? 'Export the rows the filters leave' : 'Export every row'}
          >
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Export
          </button>
          <button className="btn-primary" onClick={() => setSending(true)}>
            <Plus size={15} /> Send out
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

      {view === 'challans' && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {outTile}
            <KpiTile
              icon={AlarmClock}
              tone={TONE.rose}
              label="Overdue"
              value={String(figures.overdueChallans)}
              valueClass={figures.overdueChallans ? 'text-rose-500' : 'text-foreground'}
              sub={
                isSet('due', ['overdue'])
                  ? 'showing only these · click to show all'
                  : figures.overdueChallans
                    ? `${inr(figures.overdueValue)} past the due-back date`
                    : 'nothing past its due-back date'
              }
              onClick={() => toggleTo('due', ['overdue'])}
              active={isSet('due', ['overdue'])}
            />
            <KpiTile
              icon={ShieldAlert}
              tone={TONE.amber}
              label="Near the GST limit"
              value={String(figures.gstChallans)}
              valueClass={figures.gstPast ? 'text-rose-500' : figures.gstChallans ? 'text-amber-500' : 'text-foreground'}
              sub={
                isSet('gst', ['near', 'past'])
                  ? 'showing only these · click to show all'
                  : figures.gstPast
                    ? `${figures.gstPast} already past one year`
                    : 'challans within 60 days of one year out'
              }
              onClick={() => toggleTo('gst', ['near', 'past'])}
              active={isSet('gst', ['near', 'past'])}
            />
            <KpiTile
              icon={Recycle}
              tone={TONE.violet}
              label="Wasted at job workers"
              value={inr(figures.wasteValue)}
              sub={figures.wastePct ? `${figures.wastePct.toFixed(1)}% of what came back · ${qtyLine(figures.wasteQty, 2)}` : 'no waste recorded'}
            />
          </div>

          <div className="glass-card overflow-hidden p-0">
            {loading && !rows.length ? (
              <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
            ) : shown.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  {narrowed
                    ? 'Nothing matches that.'
                    : 'Nothing sent out yet. When material goes to an outside unit for cutting, dyeing or stitching, send it out from here. It stays on the stock screen, at their store.'}
                </p>
              </div>
            ) : (
              <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
                <ScrollableTable>
                <table className="data-table table-compact min-w-full">
                  <thead>
                    <tr className="bg-secondary">
                      <th className="whitespace-nowrap">Challan</th>
                      <th className="whitespace-nowrap">Job worker</th>
                      <th className="whitespace-nowrap">Work</th>
                      <th className="whitespace-nowrap">Code</th>
                      <th className="whitespace-nowrap">Item</th>
                      <th className="whitespace-nowrap">Category</th>
                      <th className="whitespace-nowrap">Sub-cat.</th>
                      <th className="whitespace-nowrap">HSN</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Sent</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Back</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Wasted</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Still out</th>
                      <th className="whitespace-nowrap">Due back</th>
                      <th className="whitespace-nowrap">GST limit</th>
                      <th className="whitespace-nowrap">Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => {
                      const f = fact(r)
                      const out = r.stillOutQty > 0
                      const open = r.status === 'SENT' || r.status === 'PARTLY_BACK'
                      const untouched = r.status === 'SENT' && challanLines(r.challanId).every((l) => l.settledQty === 0)
                      // Print is always there; cancel only while nothing has come back.
                      const actions: RowAction[] = [
                        { key: 'print', label: 'View / print', icon: <Printer size={14} />, href: `/print/job-work/${r.challanId}`, newTab: true },
                      ]
                      if (untouched)
                        actions.push({
                          key: 'cancel',
                          label: 'Cancel challan',
                          icon: busy === r.challanId ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />,
                          onClick: () => void cancel(r),
                          danger: true,
                          disabled: busy === r.challanId,
                        })
                      return (
                        <tr key={r.id} className={r.status === 'CANCELLED' ? 'opacity-60' : undefined}>
                          <td className="whitespace-nowrap">
                            <a
                              href={`/print/job-work/${r.challanId}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono text-xs font-semibold text-teal-400 hover:underline"
                              title="Open the printed challan"
                            >
                              {r.challanNumber}
                            </a>
                            <div className="text-[10px] text-muted-foreground" title={r.sentByName ? `Sent by ${r.sentByName}` : undefined}>
                              {formatDate(r.challanDate)}
                            </div>
                          </td>
                          <td className="whitespace-nowrap text-sm" title={`${r.fromWarehouseName} → ${r.toWarehouseName}`}>
                            {r.jobWorkerName}
                            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              {r.fromWarehouseName} <ArrowRight size={9} /> {r.jobWorkerCity ?? r.toWarehouseName}
                            </div>
                          </td>
                          <td className="whitespace-nowrap text-xs capitalize">{r.process}</td>
                          <td className="whitespace-nowrap font-mono text-xs text-teal-500">{r.itemCode}</td>
                          <td className="min-w-[190px]">
                            <Link href={`/inventory/stock/${r.itemId}`} className="text-sm font-medium text-foreground hover:text-teal-400">
                              {r.itemName}
                            </Link>
                          </td>
                          <td className="text-xs">{r.mainCategoryName}</td>
                          <td className="text-xs">{r.subCategoryName ?? <span className="text-muted-foreground">—</span>}</td>
                          <td className="font-mono text-xs text-muted-foreground">{r.hsnCode ?? '—'}</td>
                          <td className="whitespace-nowrap text-right tabular-nums">
                            {qtyFmt(r.sentQty)} <span className="text-xs text-muted-foreground">{r.uom}</span>
                            {r.unitRate > 0 && <div className="text-[10px] text-muted-foreground">{inr(r.sentQty * r.unitRate)}</div>}
                          </td>
                          <td className="whitespace-nowrap text-right text-sm tabular-nums" title={r.returnNumbers.join(', ') || undefined}>
                            {r.settledQty ? (
                              <>
                                {qtyFmt(r.settledQty)} <span className="text-xs text-muted-foreground">{r.uom}</span>
                                {r.madeInto.map((m) => (
                                  <div key={m.itemName} className="text-[10px] text-sky-500">
                                    as {qtyFmt(m.qty)} {m.uom} {m.itemName}
                                  </div>
                                ))}
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap text-right text-sm tabular-nums">
                            {r.wastedQty ? (
                              <span className="text-rose-500">
                                {qtyFmt(r.wastedQty)}
                                {r.settledQty > 0 && <div className="text-[10px]">{((r.wastedQty / r.settledQty) * 100).toFixed(1)}%</div>}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap text-right tabular-nums">
                            {out ? (
                              <>
                                <span className="font-semibold">{qtyFmt(r.stillOutQty)}</span> <span className="text-xs text-muted-foreground">{r.uom}</span>
                                {f.valueOut > 0 && <div className="text-[10px] text-muted-foreground">{inr(f.valueOut)}</div>}
                              </>
                            ) : r.status === 'CANCELLED' ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span className="badge-success">all back</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap text-xs">
                            {r.expectedBackOn ? formatDate(r.expectedBackOn) : <span className="text-muted-foreground">No date</span>}
                            {out && (
                              <div
                                className={`text-[10px] ${f.due === 'overdue' ? 'font-semibold text-rose-500' : f.due === 'soon' ? 'text-amber-500' : 'text-muted-foreground'}`}
                              >
                                {f.due === 'overdue'
                                  ? `${f.daysLate} ${f.daysLate === 1 ? 'day' : 'days'} late`
                                  : f.due === 'soon'
                                    ? f.daysLate === 0
                                      ? 'due today'
                                      : `due in ${-f.daysLate} ${f.daysLate === -1 ? 'day' : 'days'}`
                                    : `out ${f.daysOut} ${f.daysOut === 1 ? 'day' : 'days'}`}
                              </div>
                            )}
                            {!out && r.status !== 'CANCELLED' && <div className="text-[10px] text-muted-foreground">back in {f.daysOut} days</div>}
                          </td>
                          <td className="whitespace-nowrap text-xs tabular-nums">
                            {out ? (
                              <span className={f.gst === 'past' ? 'font-semibold text-rose-500' : f.gst === 'near' ? 'font-semibold text-amber-500' : 'text-muted-foreground'}>
                                {f.gstLeft < 0 ? `${-f.gstLeft} days past` : `${f.gstLeft} days left`}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap">
                            <span className={STATUS_CLASS[r.status]}>{STATUS_LABEL[r.status]}</span>
                            {r.cancelReason && (
                              <div className="max-w-[160px] truncate text-[10px] text-muted-foreground" title={r.cancelReason}>
                                {r.cancelReason}
                              </div>
                            )}
                          </td>
                          <td className="whitespace-nowrap text-right">
                            <div className="flex justify-end gap-1.5">
                              {open && (
                                <button
                                  type="button"
                                  className="btn-primary h-7 px-2.5 text-xs"
                                  onClick={() => setReceiving(r.challanId)}
                                  title="Record what has come back"
                                  aria-label={`Take back ${r.challanNumber}`}
                                >
                                  <PackageCheck size={13} /> Take back
                                </button>
                              )}
                              <ActionMenu label={`Actions for ${r.challanNumber}`} items={actions} />
                            </div>
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

      {view === 'dashboard' && (
        <>
          <Highlights items={highlights} />

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {outTile}
            <KpiTile
              icon={Timer}
              tone={TONE.amber}
              label="Average days out"
              value={figures.challansOut ? `${avgDaysOut} days` : '—'}
              sub={figures.challansOut ? `across ${figures.challansOut} open ${figures.challansOut === 1 ? 'challan' : 'challans'}` : 'nothing out at the moment'}
            />
            <KpiTile
              icon={Send}
              tone={TONE.blue}
              label="Sent out"
              value={inr(figures.sentValue)}
              sub={figures.challans ? `${qtyLine(figures.sentQty, 2)} · ${figures.challans} ${figures.challans === 1 ? 'challan' : 'challans'}` : 'nothing sent in this period'}
            />
            <KpiTile
              icon={Recycle}
              tone={TONE.violet}
              label="Waste rate"
              value={figures.wastePct ? `${figures.wastePct.toFixed(1)}%` : '0%'}
              valueClass={figures.wastePct > 5 ? 'text-rose-500' : 'text-foreground'}
              sub={`${inr(figures.wasteValue)} of ${inr(figures.settledValue)} settled back`}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <DashCard className="lg:col-span-2" icon={LineChart} title="Sent and back over time" hint="Value sent out, and value settled by returns. Click a bar to see that period.">
              <SentBackTrend
                data={trend}
                onPick={(f, t) => {
                  setFrom(f)
                  setTo(t)
                  setPreset('custom')
                }}
              />
            </DashCard>
            <DashCard icon={Target} title="Against the due-back date" hint="What is still out, by value. Click to filter.">
              <DueDonut data={dueSlices} picked={picked.due ?? []} onPick={(k) => toggleOne('due', k)} />
            </DashCard>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <DashCard icon={Users} title="Out by job worker" hint="Value still with each unit, late part in red. Click to filter.">
              <WorkerBars data={workers} picked={picked.worker ?? []} onPick={(id) => toggleOne('worker', id)} />
            </DashCard>
            <DashCard icon={Hourglass} title="How long it has been out" hint="Value still out, by days since the challan">
              <DaysOutBars data={ageing} />
            </DashCard>
            <DashCard icon={PieIcon} title="By kind of work" hint="Value sent for each process. Click to filter.">
              <ProcessPie data={processes} picked={picked.process ?? []} onPick={(v) => toggleOne('process', v)} />
            </DashCard>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <DashCard icon={ShieldAlert} title="GST one-year clock" hint="Inputs must be back within a year of the challan, or tax falls due">
              <GstClock data={gstClock} />
            </DashCard>
            <DashCard icon={Recycle} title="Waste by job worker" hint="Share of what came back that was lost. Over 5% in red.">
              <WasteColumns data={waste} />
            </DashCard>
            <DashCard icon={Layers} title="Still out, by category" hint="Quantity for each unit, and value. Click to filter.">
              {byCategory.length === 0 ? (
                <p className="py-16 text-center text-xs text-muted-foreground">Nothing is out at the moment.</p>
              ) : (
                <div className="space-y-3">
                  {byCategory.map((c) => {
                    const top = byCategory[0].value || 1
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleOne('category', c.id)}
                        className={`block w-full text-left transition-colors hover:text-primary ${picked.category?.includes(c.id) ? 'font-semibold' : ''}`}
                      >
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="truncate text-foreground">{c.name}</span>
                          <span className="shrink-0 font-semibold tabular-nums text-foreground">{inr(c.value)}</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(3, (c.value / top) * 100)}%` }} />
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {c.qty.map((q) => (
                            <span key={q.uom} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                              {qtyFmt(q.qty)} {q.uom}
                            </span>
                          ))}
                          <span className="px-1 py-0.5 text-[10px] text-muted-foreground">{c.lines} lines</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </DashCard>
          </div>

          {/* Who to ring today. */}
          <div className="glass-card overflow-hidden rounded-xl p-0">
            <div className="flex items-start gap-3 px-5 pt-5">
              <span className="bg-primary/10 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                <AlarmClock size={16} />
              </span>
              <div>
                <h3 className="text-[15px] font-semibold leading-tight text-foreground">Needs chasing</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">Challans late, due within a week, or within 60 days of the GST limit</p>
              </div>
            </div>
            {chase.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-muted-foreground">Nothing to chase. Everything out is on time.</p>
            ) : (
              <ScrollableTable className="mt-2">
                <table className="data-table table-compact min-w-full">
                  <thead>
                    <tr className="bg-secondary">
                      <th className="whitespace-nowrap">Challan</th>
                      <th className="whitespace-nowrap">Job worker</th>
                      <th className="whitespace-nowrap">Work</th>
                      <th className="whitespace-nowrap">Still out</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Value</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Days out</th>
                      <th className="whitespace-nowrap">Due back</th>
                      <th className="whitespace-nowrap">GST limit</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {chase.map((c) => (
                      <tr key={c.r.challanId}>
                        <td className="whitespace-nowrap">
                          <a
                            href={`/print/job-work/${c.r.challanId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-xs font-semibold text-teal-400 hover:underline"
                            title="Open the printed challan"
                          >
                            {c.r.challanNumber}
                          </a>
                        </td>
                        <td className="text-sm">{c.r.jobWorkerName}</td>
                        <td className="text-xs capitalize">{c.r.process}</td>
                        <td className="text-xs tabular-nums">{qtyLine(c.qty)}</td>
                        <td className="text-right text-sm font-semibold tabular-nums">{inr(c.value)}</td>
                        <td className="text-right text-sm tabular-nums">{c.daysOut}</td>
                        <td className="whitespace-nowrap text-xs">
                          {c.r.expectedBackOn ? formatDate(c.r.expectedBackOn) : '—'}
                          {c.due === 'overdue' && <div className="text-[10px] font-semibold text-rose-500">{c.daysLate} days late</div>}
                          {c.due === 'soon' && <div className="text-[10px] text-amber-500">{c.daysLate === 0 ? 'due today' : `due in ${-c.daysLate} days`}</div>}
                        </td>
                        <td className={`whitespace-nowrap text-xs tabular-nums ${c.gstLeft < 0 ? 'font-semibold text-rose-500' : c.gstLeft <= 60 ? 'font-semibold text-amber-500' : 'text-muted-foreground'}`}>
                          {c.gstLeft < 0 ? `${-c.gstLeft} days past` : `${c.gstLeft} days left`}
                        </td>
                        <td className="whitespace-nowrap text-right">
                          <div className="flex justify-end gap-1.5">
                            <button
                              type="button"
                              className="btn-primary h-7 px-2.5 text-xs"
                              onClick={() => setReceiving(c.r.challanId)}
                              title="Record what has come back"
                              aria-label={`Take back ${c.r.challanNumber}`}
                            >
                              <PackageCheck size={13} /> Take back
                            </button>
                            <ActionMenu
                              label={`Actions for ${c.r.challanNumber}`}
                              items={[
                                { key: 'print', label: 'View / print', icon: <Printer size={14} />, href: `/print/job-work/${c.r.challanId}`, newTab: true },
                              ]}
                            />
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

      {sending && (
        <SendJobWorkDialog
          onClose={() => setSending(false)}
          onSaved={(msg) => {
            setSending(false)
            setMessage(msg)
            void load()
          }}
        />
      )}

      {receiving && receivingLines.length > 0 && (
        <ReceiveJobWorkDialog
          challan={{
            id: receiving,
            challanNumber: receivingLines[0].challanNumber,
            process: receivingLines[0].process,
            jobWorker: { name: receivingLines[0].jobWorkerName },
            fromWarehouse: { id: receivingLines[0].fromWarehouseId, name: receivingLines[0].fromWarehouseName },
            lines: receivingLines.map((l) => ({
              id: l.id,
              qty: l.sentQty,
              outstanding: l.stillOutQty,
              item: { id: l.itemId, name: l.itemName, uom: { symbol: l.uom } },
            })),
          }}
          onClose={() => setReceiving(null)}
          onSaved={(msg) => {
            setReceiving(null)
            setMessage(msg)
            void load()
          }}
        />
      )}
    </div>
  )
}

// useSearchParams needs a Suspense boundary or the route opts out of static rendering.
export default function JobWorkPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading...</p>}>
      <JobWorkScreen />
    </Suspense>
  )
}
