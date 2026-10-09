'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Ban,
  CalendarDays,
  Eye,
  FilePenLine,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Ruler,
  Scissors,
  Search,
  Send,
} from 'lucide-react'
import { api, ApiError, can, masterResource, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ExportButton } from '@/components/tables/ExportButton'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { RowPanel } from '@/components/tables/RowPanel'
import {
  asDate,
  asNumber,
  downloadRows,
  fetchEveryPage,
  type ExportColumn,
  type ExportFormat,
} from '@/lib/export'
import { useAppSettings } from '@/lib/appSettings'
import { formatCurrency, formatDate } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { OPEN_ORDER_STATUSES, SALES_ORDER_STATUS, salesOrderStatus } from '@/components/sales/status'
import { SalesOrderDialog } from '@/components/sales/SalesOrderDialog'
import { SalesOrderDetailDialog } from '@/components/sales/SalesOrderDetailDialog'
import { OrderLinesView, type OrderLineView } from '@/components/sales/OrderLinesView'
import {
  orderCan,
  postReasonAction,
  REASON_ACTIONS,
  sendForApproval,
  type ReasonAction,
} from '@/components/sales/orderActions'
import { ReasonDialog } from '@/components/ui/ReasonDialog'

interface SalesOrderRow {
  id: string
  soNumber: string
  status: string
  orderDate: string
  deliveryDate: string | null
  customerPORef: string | null
  isJobWork: boolean
  salesperson: string | null
  sentForApprovalAt: string | null
  approvedAt: string | null
  subtotal: string | number
  discountAmount: string | number
  taxableAmount: string | number
  cgst: string | number
  sgst: string | number
  igst: string | number
  totalAmount: string | number
  customer: {
    id: string
    name: string
    type: string
    billingCity: string | null
    shippingCity: string | null
  }
  brand: { id: string; name: string; type: string }
  _count: { lines: number }
  /** Added up from the lines by the API: ordered, sent, still to send. */
  pieces: number
  dispatched: number
  pending: number
}

interface Brief {
  id: string
  soNumber: string
  deliveryDate: string | null
  customer: { name: string }
}

interface Summary {
  open: { count: number; value: number }
  piecesToDispatch: number
  dueThisWeek: { count: number; next: Brief | null }
  overdue: { count: number; oldest: Brief | null }
  awaitingApproval: number
}

/** One order as the detail returns it — only what the expanded row reads. */
interface OrderDetail {
  id: string
  lines: OrderLineView[]
}

/*
 * What each card narrows the list to.
 *
 * A card and the rows it produces have to agree, so each sends a filter the
 * API understands rather than counting one thing and showing another.
 */
type CardKey = 'open' | 'awaiting' | 'week' | 'overdue'
const CARD_FILTERS: Record<CardKey, Record<string, string>> = {
  open: { open: '1' },
  awaiting: { awaiting: '1' },
  week: { due: 'week' },
  overdue: { due: 'overdue' },
}

const DELIVERY_FILTERS: Record<string, string> = {
  overdue: 'Overdue',
  week: 'Next 7 days',
  month: 'This month',
}

const pcs = (n: number | string) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const DAY = 86_400_000
const startOfDay = (d: Date) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/**
 * The delivery date in words: "in 6 days", "due today", "overdue by 1 day".
 * Only an order still to be delivered can be late; a draft past its date is
 * flagged as a date to fix rather than as late.
 */
function deliveryNote(o: SalesOrderRow): { text: string; tone: 'late' | 'warn' | 'quiet' } | null {
  if (!o.deliveryDate) return null
  const isOpen = OPEN_ORDER_STATUSES.includes(o.status)
  if (!isOpen && o.status !== 'DRAFT') return null
  const days = Math.round((startOfDay(new Date(o.deliveryDate)).getTime() - startOfDay(new Date()).getTime()) / DAY)
  if (days < 0) {
    return isOpen
      ? { text: `overdue by ${-days} ${days === -1 ? 'day' : 'days'}`, tone: 'late' }
      : { text: 'date has passed', tone: 'warn' }
  }
  if (days === 0) return { text: 'due today', tone: 'warn' }
  return { text: `in ${days} ${days === 1 ? 'day' : 'days'}`, tone: 'quiet' }
}

const toneClass = { late: 'text-destructive font-medium', warn: 'warn-text', quiet: 'text-muted-foreground' }

/** Where the order goes: the ship-to town, else the billing one. */
const town = (o: SalesOrderRow) => o.customer.shippingCity || o.customer.billingCity || ''

/** Sent against ordered, as a bar and in words. */
function Dispatched({ o }: { o: SalesOrderRow }) {
  if (o.status === 'CANCELLED') return <span className="text-muted-foreground text-xs">—</span>
  const share = o.pieces > 0 ? Math.min(100, Math.round((o.dispatched / o.pieces) * 100)) : 0
  return (
    <div className="flex min-w-[7.5rem] flex-col gap-1">
      <div className="bg-secondary h-1.5 rounded-full" aria-hidden>
        <div className="bg-primary h-1.5 rounded-full" style={{ width: `${share}%` }} />
      </div>
      <span className="text-muted-foreground text-[11px] tabular-nums">
        {pcs(o.dispatched)} of {pcs(o.pieces)}
      </span>
    </div>
  )
}

/**
 * The lines of one order, each with its size run.
 *
 * Fetched when the row is opened rather than sent with every row of the list:
 * a page of twenty-five orders has no use for every size of every line until
 * somebody asks for one.
 */
function OrderLines({ state }: { state: OrderDetail | 'loading' | { error: string } | undefined }) {
  if (!state || state === 'loading') {
    return (
      <p className="text-muted-foreground flex items-center gap-2 px-3 py-3 text-xs">
        <Loader2 size={13} className="animate-spin" /> Loading the lines...
      </p>
    )
  }
  if ('error' in state) return <p className="text-destructive px-3 py-3 text-xs">{state.error}</p>
  return <OrderLinesView lines={state.lines} />
}

export default function SalesOrdersPage() {
  const { rowsPerPage } = useAppSettings()

  const [rows, setRows] = useState<SalesOrderRow[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [brandId, setBrandId] = useState('')
  const [type, setType] = useState('')
  const [due, setDue] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [card, setCard] = useState<CardKey | ''>('')
  const [page, setPage] = useState(1)

  // Which order has its lines open. One at a time, as on Purchase Orders.
  const [open, setOpen] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, OrderDetail | 'loading' | { error: string }>>({})

  // The order form: a new order (orderId null), or a draft being changed.
  const [dialog, setDialog] = useState<{ open: boolean; orderId: string | null; amend: boolean }>({
    open: false,
    orderId: null,
    amend: false,
  })
  // The order open in the detail, and an action waiting on its reason.
  const [viewId, setViewId] = useState<string | null>(null)
  const [asking, setAsking] = useState<{ action: ReasonAction; order: SalesOrderRow } | null>(null)
  const [acting, setActing] = useState(false)

  const [customers, setCustomers] = useState<Array<{ id: string; name: string }>>([])
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([])

  // Arriving from the dashboard, which links to one order by its number.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q')
    if (q) {
      setSearch(q)
      setDebounced(q)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [c, b] = await Promise.all([
          masterResource<{ id: string; name: string }>('customers').list({ limit: 500 }),
          masterResource<{ id: string; name: string }>('brands').list({ limit: 100 }),
        ])
        if (cancelled) return
        setCustomers([...c.data].sort((x, y) => x.name.localeCompare(y.name)))
        setBrands([...b.data].sort((x, y) => x.name.localeCompare(y.name)))
      } catch {
        // The two filters come up empty; the list itself still works.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  /**
   * The list's query string, built once. The export calls it too, so the file
   * is always the list on screen and never one assembled from its own idea of
   * the filters.
   */
  const query = useCallback(
    (p: number, limit: number) => {
      const qs = new URLSearchParams({ page: String(p), limit: String(limit) })
      if (debounced) qs.set('q', debounced)
      if (status) qs.set('status', status)
      if (customerId) qs.set('customerId', customerId)
      if (brandId) qs.set('brandId', brandId)
      if (type) qs.set('type', type)
      if (due) qs.set('due', due)
      if (fromDate) qs.set('from', fromDate)
      if (toDate) qs.set('to', toDate)
      if (card) for (const [k, v] of Object.entries(CARD_FILTERS[card])) qs.set(k, v)
      return `/sales/orders?${qs}`
    },
    [debounced, status, customerId, brandId, type, due, fromDate, toDate, card]
  )

  const describeError = (err: unknown) =>
    err instanceof ApiError
      ? err.status === 403
        ? 'Your role does not allow viewing sales orders.'
        : err.message
      : 'Could not reach the server. Is the API running?'

  // Only the newest request may fill the list, or a slow first reply can paint
  // the whole list over a search that had already narrowed it.
  const latestLoad = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++latestLoad.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<Paginated<SalesOrderRow>>(query(page, rowsPerPage))
      if (ticket !== latestLoad.current) return
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      if (ticket !== latestLoad.current) return
      setError(describeError(err))
      setRows([])
    } finally {
      if (ticket === latestLoad.current) setLoading(false)
    }
  }, [query, page, rowsPerPage])

  const loadSummary = useCallback(async () => {
    try {
      const res = await api.get<{ data: Summary }>('/sales/orders/summary')
      setSummary(res.data)
    } catch {
      // The list says what went wrong; the cards just stay empty.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  // A narrower filter on page 3 would show an empty page 3 of a shorter list,
  // which reads as "nothing found" rather than "you moved".
  useEffect(() => {
    setPage(1)
  }, [debounced, status, customerId, brandId, type, due, fromDate, toDate, card])

  const refresh = () => {
    setDetails({})
    void load()
    void loadSummary()
  }

  const anyFilter = Boolean(search || status || customerId || brandId || type || due || fromDate || toDate || card)
  const clearFilters = () => {
    setSearch('')
    setStatus('')
    setCustomerId('')
    setBrandId('')
    setType('')
    setDue('')
    setFromDate('')
    setToDate('')
    setCard('')
  }

  const toggle = (o: SalesOrderRow) => {
    if (open === o.id) {
      setOpen(null)
      return
    }
    setOpen(o.id)
    // Fetched once per order; a failed fetch is tried again on the next open.
    const cached = details[o.id]
    if (cached === 'loading' || (cached && !('error' in cached))) return
    setDetails((d) => ({ ...d, [o.id]: 'loading' }))
    api
      .get<{ data: OrderDetail }>(`/sales/orders/${o.id}`)
      .then((res) => setDetails((d) => ({ ...d, [o.id]: res.data })))
      .catch((err) =>
        setDetails((d) => ({
          ...d,
          [o.id]: { error: err instanceof ApiError ? err.message : 'Could not load the lines.' },
        }))
      )
  }

  const send = async (o: SalesOrderRow) => {
    if (!window.confirm(`Send ${o.soNumber} for approval? It can no longer be edited once it is approved.`)) return
    setError(null)
    setMessage(null)
    try {
      const res = await sendForApproval(o.id)
      setMessage(res.message ?? `${o.soNumber} sent for approval.`)
      refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not send ${o.soNumber}.`)
    }
  }

  const runReason = async (reason: string) => {
    if (!asking) return
    setActing(true)
    setError(null)
    setMessage(null)
    try {
      const res = await postReasonAction(asking.order.id, asking.action, reason)
      setMessage(res.message ?? `${asking.order.soNumber} updated.`)
      setAsking(null)
      refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be done.')
      setAsking(null)
    } finally {
      setActing(false)
    }
  }

  /*
   * What can be done to one order, in the order somebody reaches for them.
   * Written once and shared by the table and the phone cards; who may do what
   * is decided in orderActions, which the detail uses too.
   *
   * On the list, cancel is offered only while nothing can have started (a
   * draft, or a confirmed order with nothing sent), and short-close only once
   * the order is in production or part sent. The detail, which can see the
   * production orders, offers both exactly.
   */
  const rowActions = (o: SalesOrderRow): RowAction[] => {
    const items: RowAction[] = [
      { key: 'view', label: 'View order', icon: <Eye size={15} />, onClick: () => setViewId(o.id) },
    ]
    if (orderCan.edit(o)) {
      items.push({
        key: 'edit',
        label: 'Edit draft',
        icon: <Pencil size={15} />,
        onClick: () => setDialog({ open: true, orderId: o.id, amend: false }),
      })
    }
    if (orderCan.send(o)) {
      items.push({ key: 'send', label: 'Send for approval', icon: <Send size={15} />, onClick: () => void send(o) })
    }
    if (orderCan.amend(o)) {
      items.push({
        key: 'amend',
        label: 'Amend order',
        icon: <FilePenLine size={15} />,
        onClick: () => setDialog({ open: true, orderId: o.id, amend: true }),
      })
    }
    if (orderCan.shortClose(o) && (o.status !== 'CONFIRMED' || o.dispatched > 0)) {
      items.push({
        key: 'short-close',
        label: 'Short-close',
        icon: <Scissors size={15} />,
        onClick: () => setAsking({ action: 'short-close', order: o }),
      })
    }
    if (orderCan.cancel(o) && o.dispatched === 0) {
      items.push({
        key: 'cancel',
        label: 'Cancel order',
        icon: <Ban size={15} />,
        danger: true,
        onClick: () => setAsking({ action: 'cancel', order: o }),
      })
    }
    return items
  }

  const EXPORT_COLUMNS: ExportColumn<SalesOrderRow>[] = [
    { header: 'Order No.', value: (o) => o.soNumber },
    { header: 'Order Date', value: (o) => asDate(o.orderDate) },
    { header: 'Status', value: (o) => salesOrderStatus(o).label },
    { header: 'Customer', value: (o) => o.customer.name },
    { header: 'Town', value: (o) => town(o) },
    { header: 'Brand', value: (o) => o.brand.name },
    { header: 'Type', value: (o) => (o.isJobWork ? 'Job work' : 'Own order') },
    { header: 'Buyer PO', value: (o) => o.customerPORef ?? '' },
    { header: 'Salesperson', value: (o) => o.salesperson ?? '' },
    { header: 'Delivery Date', value: (o) => asDate(o.deliveryDate) },
    { header: 'Lines', value: (o) => o._count.lines },
    { header: 'Pieces', value: (o) => o.pieces },
    { header: 'Dispatched', value: (o) => o.dispatched },
    { header: 'Pending', value: (o) => o.pending },
    { header: 'Value before GST', value: (o) => asNumber(o.taxableAmount) },
    { header: 'CGST', value: (o) => asNumber(o.cgst) },
    { header: 'SGST', value: (o) => asNumber(o.sgst) },
    { header: 'IGST', value: (o) => asNumber(o.igst) },
    { header: 'Total', value: (o) => asNumber(o.totalAmount) },
  ]

  // Every order the filters allow, not the page on screen: the API caps a
  // request at 200, so this walks the pages.
  const exportList = async (format: ExportFormat) => {
    setError(null)
    try {
      const { rows: all, total: count, truncated } = await fetchEveryPage<SalesOrderRow>((p) => query(p, 200))
      if (all.length === 0) {
        setMessage('Nothing to export — no orders match these filters.')
        return
      }
      await downloadRows({ rows: all, columns: EXPORT_COLUMNS, name: 'sales-orders', sheet: 'Sales Orders', format })
      setMessage(
        truncated
          ? `Exported the first ${all.length} of ${count} orders. Narrow the filters to get the rest.`
          : `Exported ${all.length} ${all.length === 1 ? 'order' : 'orders'}.`
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the export.')
    }
  }

  const cards: Array<{ key: CardKey; label: string; value: number; sub: string; tone: string }> = [
    {
      key: 'open',
      label: 'Open orders',
      value: summary?.open.count ?? 0,
      sub: summary
        ? `${formatCurrency(summary.open.value)} before GST · ${pcs(summary.piecesToDispatch)} pcs to send`
        : '—',
      tone: 'text-foreground',
    },
    {
      key: 'awaiting',
      label: 'Waiting for approval',
      value: summary?.awaitingApproval ?? 0,
      sub: 'sent, not yet decided',
      tone: (summary?.awaitingApproval ?? 0) > 0 ? 'warn-text' : 'text-muted-foreground',
    },
    {
      key: 'week',
      label: 'Due in the next 7 days',
      value: summary?.dueThisWeek.count ?? 0,
      sub: summary?.dueThisWeek.next
        ? `${summary.dueThisWeek.next.soNumber} · due ${formatDate(summary.dueThisWeek.next.deliveryDate ?? '')}`
        : 'nothing due',
      tone: 'text-foreground',
    },
    {
      key: 'overdue',
      label: 'Overdue for delivery',
      value: summary?.overdue.count ?? 0,
      sub: summary?.overdue.oldest
        ? `${summary.overdue.oldest.soNumber} was due ${formatDate(summary.overdue.oldest.deliveryDate ?? '')}`
        : 'nothing late',
      tone: (summary?.overdue.count ?? 0) > 0 ? 'text-destructive' : 'text-muted-foreground',
    },
  ]

  const pages = Math.ceil(total / rowsPerPage) || 1

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Sales Orders</h1>
          <p className="page-subtitle hidden sm:block">
            {summary
              ? `${summary.open.count} open ${summary.open.count === 1 ? 'order' : 'orders'} · ${formatCurrency(
                  summary.open.value
                )} still to deliver, before GST`
              : 'What customers have ordered from us'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={refresh} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={exportList} disabled={loading} />
          {can('sales', 'create') && (
            <button
              className="btn-primary"
              onClick={() => setDialog({ open: true, orderId: null, amend: false })}
              aria-label="New sales order"
            >
              <Plus size={15} /> <span className="hidden sm:inline">New order</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {message && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
          <p className="text-primary text-sm">{message}</p>
        </div>
      )}

      {/* Pressable, and pressing the pressed one clears it — so a card is the
        way back out as well as the way in. Picking a status or a delivery
        window below clears the card, so two controls never narrow the same
        thing with only one of them showing it. */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {cards.map((c) => {
          const on = card === c.key
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => {
                setCard(on ? '' : c.key)
                setStatus('')
                setDue('')
              }}
              aria-pressed={on}
              title={on ? 'Showing only these — press to clear' : 'Show only these'}
              className={`glass-card cursor-pointer p-3 text-left transition-colors ${
                on ? 'ring-primary bg-primary/5 ring-2' : 'hover:bg-secondary/40'
              }`}
            >
              <p className="text-muted-foreground text-[11px] leading-tight">{c.label}</p>
              <p className={`mt-0.5 text-lg font-semibold tabular-nums leading-tight ${c.tone}`}>{c.value}</p>
              <p className="text-muted-foreground mt-0.5 truncate text-[11px] leading-snug" title={c.sub}>
                {c.sub}
              </p>
            </button>
          )
        })}
      </div>

      <div className="glass-card overflow-hidden p-0">
        {/* Two rows on a phone, one flowing row at a desk: the grouping
          wrappers are `sm:contents`, so above a phone they stop existing and
          their children rejoin one wrapping row. One set of controls, not one
          per layout. */}
        <div className="border-border flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex flex-col gap-2 sm:contents">
            <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 sm:min-w-[170px] sm:max-w-[230px] sm:basis-0 sm:px-2.5">
              <Search size={14} className="text-muted-foreground hidden shrink-0 sm:block" />
              <input
                className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
                placeholder="Order, customer, buyer PO..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search sales orders"
              />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <input
                type="date"
                className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[10px] sm:w-[7.75rem] sm:flex-none sm:px-3 sm:text-xs"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label="Order date from"
              />
              <span className="text-muted-foreground hidden text-xs sm:inline">to</span>
              <input
                type="date"
                className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[10px] sm:w-[7.75rem] sm:flex-none sm:px-3 sm:text-xs"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                aria-label="Order date to"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:contents">
            <SmartSelect
              className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-36 sm:px-3 sm:text-xs"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              aria-label="Filter by customer"
            >
              <option value="">All customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SmartSelect>
            <SmartSelect
              className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-32 sm:px-3 sm:text-xs"
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              aria-label="Filter by brand"
            >
              <option value="">All brands</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SmartSelect>
            <SmartSelect
              className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-32 sm:px-3 sm:text-xs"
              value={type}
              onChange={(e) => setType(e.target.value)}
              aria-label="Filter by order type"
            >
              <option value="">All types</option>
              <option value="own">Own order</option>
              <option value="job-work">Job work</option>
            </SmartSelect>
            <SmartSelect
              className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-36 sm:px-3 sm:text-xs"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setCard('')
              }}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {Object.entries(SALES_ORDER_STATUS).map(([v, s]) => (
                <option key={v} value={v}>
                  {s.label}
                </option>
              ))}
            </SmartSelect>
            <SmartSelect
              className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-36 sm:px-3 sm:text-xs"
              value={due}
              onChange={(e) => {
                setDue(e.target.value)
                setCard('')
              }}
              aria-label="Filter by delivery date"
            >
              <option value="">Any delivery date</option>
              {Object.entries(DELIVERY_FILTERS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </SmartSelect>
          </div>

          <div className="flex items-center gap-2 sm:contents">
            {anyFilter && (
              <button className="btn-ghost h-8 shrink-0 px-2 text-xs" onClick={clearFilters}>
                Clear
              </button>
            )}
            <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
              {total} {total === 1 ? 'order' : 'orders'}
            </span>
          </div>
        </div>

        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              {anyFilter
                ? 'No orders match these filters.'
                : error
                  ? 'The orders could not be loaded.'
                  : "No sales orders yet. Each one starts from a buyer's PO: press New order."}
            </p>
          </div>
        ) : (
          <div className="list-scope">
            {/* On a narrow list each order is a block, not a row: the number
              and status first, the customer under it, the value hard right,
              the rest as label-and-value pairs. Where it switches is set by
              the list's width, not the window's — see `.list-scope`. */}
            <div className="list-cards divide-border divide-y">
              {rows.map((o) => {
                const s = salesOrderStatus(o)
                const note = deliveryNote(o)
                const expanded = open === o.id
                const actions = rowActions(o)
                return (
                  <div key={o.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="text-primary font-mono text-xs font-semibold hover:underline"
                            onClick={() => setViewId(o.id)}
                          >
                            {o.soNumber}
                          </button>
                          <span className={s.cls}>{s.label}</span>
                          {o.isJobWork && <span className="badge-purple">Job work</span>}
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">{o.customer.name}</p>
                        {town(o) && <p className="text-muted-foreground text-[11px]">{town(o)}</p>}
                      </div>
                      <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">
                        ₹{money(o.taxableAmount)}
                      </span>
                    </div>

                    <dl className="mt-2.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Ordered</dt>
                      <dd className="text-foreground">{formatDate(o.orderDate)}</dd>
                      <dt className="text-muted-foreground">Delivery</dt>
                      <dd className="text-foreground">
                        {o.deliveryDate ? formatDate(o.deliveryDate) : '—'}
                        {note && <span className={`ml-1.5 ${toneClass[note.tone]}`}>{note.text}</span>}
                      </dd>
                      <dt className="text-muted-foreground">Brand</dt>
                      <dd className="text-foreground">{o.brand.name}</dd>
                      <dt className="text-muted-foreground">Dispatched</dt>
                      <dd>
                        <Dispatched o={o} />
                      </dd>
                    </dl>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <button
                        onClick={() => toggle(o)}
                        className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                        aria-expanded={expanded}
                      >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {expanded ? 'Hide lines' : `Lines and sizes (${o._count.lines})`}
                      </button>
                      {actions.length > 0 && <ActionMenu label={`Actions for ${o.soNumber}`} items={actions} />}
                    </div>

                    {expanded && (
                      <div className="border-border bg-secondary/40 mt-2.5 max-h-[26rem] overflow-y-auto rounded-lg border">
                        <OrderLines state={details[o.id]} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="list-rows w-full">
              {/* What goes as the list narrows: brand under "full", type and
                pieces under "wide", the dispatched bar under "roomy". Never
                dropped: the number, the customer, the value, the delivery date
                and the status. */}
              <table className="data-table w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th style={{ width: 30 }} />
                    <th>Order</th>
                    <th>Customer</th>
                    <th className="col-full">Brand</th>
                    <th className="col-wide">Type</th>
                    <th className="col-wide" style={{ textAlign: 'right' }}>
                      Pieces
                    </th>
                    <th className="col-roomy">Dispatched</th>
                    <th style={{ textAlign: 'right' }}>Value before GST</th>
                    <th>Delivery</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => {
                    const s = salesOrderStatus(o)
                    const note = deliveryNote(o)
                    const expanded = open === o.id
                    const actions = rowActions(o)
                    return (
                      <Fragment key={o.id}>
                        <tr>
                          <td>
                            <button
                              className="bg-primary/10 text-primary hover:bg-primary/20 flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
                              onClick={() => toggle(o)}
                              title={expanded ? 'Hide lines' : 'Show lines and sizes'}
                              aria-label={`${expanded ? 'Hide' : 'Show'} lines on ${o.soNumber}`}
                              aria-expanded={expanded}
                            >
                              {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>
                          </td>
                          <td className="whitespace-nowrap">
                            <button
                              type="button"
                              className="text-primary font-mono text-xs font-semibold hover:underline"
                              onClick={() => setViewId(o.id)}
                              title={`Open ${o.soNumber}`}
                            >
                              {o.soNumber}
                            </button>
                            <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
                              <CalendarDays size={11} className="shrink-0" />
                              {formatDate(o.orderDate)}
                            </div>
                          </td>
                          <td>
                            <div className="text-foreground max-w-[15rem] truncate font-medium">{o.customer.name}</div>
                            {(town(o) || o.customerPORef) && (
                              <div className="text-muted-foreground max-w-[15rem] truncate text-[11px] leading-tight">
                                {town(o)}
                                {town(o) && o.customerPORef ? ' · ' : ''}
                                {o.customerPORef && <>PO {o.customerPORef}</>}
                              </div>
                            )}
                          </td>
                          <td className="col-full text-xs">
                            <span className={o.brand.type === 'VHAGAR' ? 'vhagar-accent font-bold' : 'text-muted-foreground'}>
                              {o.brand.name}
                            </span>
                          </td>
                          <td className="col-wide">
                            {o.isJobWork ? (
                              <span className="badge-purple">Job work</span>
                            ) : (
                              <span className="text-muted-foreground text-xs">Own order</span>
                            )}
                          </td>
                          <td className="col-wide text-right text-xs tabular-nums">{pcs(o.pieces)}</td>
                          <td className="col-roomy">
                            <Dispatched o={o} />
                          </td>
                          <td className="text-right font-semibold tabular-nums">₹{money(o.taxableAmount)}</td>
                          <td className="whitespace-nowrap text-xs">
                            <div className="text-foreground">{o.deliveryDate ? formatDate(o.deliveryDate) : '—'}</div>
                            {note && <div className={`text-[11px] ${toneClass[note.tone]}`}>{note.text}</div>}
                          </td>
                          <td>
                            <span className={s.cls}>{s.label}</span>
                          </td>
                          <td className="whitespace-nowrap text-right">
                            <div className="flex justify-end">
                              {actions.length > 0 && (
                                <ActionMenu label={`Actions for ${o.soNumber}`} items={actions} />
                              )}
                            </div>
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={11} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              <RowPanel
                                icon={Ruler}
                                title="Lines and sizes"
                                note={`${o._count.lines} ${o._count.lines === 1 ? 'line' : 'lines'} on ${o.soNumber}`}
                              >
                                <OrderLines state={details[o.id]} />
                              </RowPanel>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />

        <div className="border-border bg-secondary/40 flex items-start gap-2 border-t px-4 py-2">
          <Info size={14} className="text-primary mt-0.5 shrink-0" />
          <p className="text-muted-foreground text-xs">
            A draft can be changed until it is sent for approval. Once approved, an order changes only by
            amending it, and the earlier version is kept. Values are before GST.
          </p>
        </div>
      </div>

      <SalesOrderDetailDialog
        orderId={viewId}
        onClose={() => setViewId(null)}
        onEdit={(id) => {
          setViewId(null)
          setDialog({ open: true, orderId: id, amend: false })
        }}
        onAmend={(id) => {
          setViewId(null)
          setDialog({ open: true, orderId: id, amend: true })
        }}
        onChanged={(msg) => {
          setMessage(msg)
          refresh()
        }}
      />

      <SalesOrderDialog
        open={dialog.open}
        orderId={dialog.orderId}
        amend={dialog.amend}
        onClose={() => setDialog({ open: false, orderId: null, amend: false })}
        onSaved={(msg) => {
          setMessage(msg)
          setError(null)
          refresh()
        }}
      />

      {asking && (
        <ReasonDialog
          title={REASON_ACTIONS[asking.action].title(asking.order.soNumber)}
          description={REASON_ACTIONS[asking.action].description}
          confirmLabel={REASON_ACTIONS[asking.action].confirmLabel}
          placeholder={REASON_ACTIONS[asking.action].placeholder}
          danger={asking.action === 'cancel'}
          busy={acting}
          onCancel={() => setAsking(null)}
          onConfirm={(reason) => void runReason(reason)}
        />
      )}
    </div>
  )
}
