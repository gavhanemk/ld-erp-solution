'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Ban,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Info,
  PackageCheck,
  Pencil,
  Printer,
  RefreshCw,
  Search,
  Truck,
} from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ExportButton } from '@/components/tables/ExportButton'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { asDate, downloadRows, fetchEveryPage, type ExportColumn, type ExportFormat } from '@/lib/export'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { CHALLAN_STATUS, challanStatus, salesOrderStatus } from '@/components/sales/status'
import { DeliveryChallanDialog } from '@/components/sales/DeliveryChallanDialog'

/** An order with pieces still to send, as the waiting list returns it. */
interface WaitingOrder {
  id: string
  soNumber: string
  status: string
  isJobWork: boolean
  orderDate: string
  deliveryDate: string | null
  customerPORef: string | null
  customer: { name: string; shippingCity: string | null; billingCity: string | null }
  lines: Array<{ item: { code: string; name: string } }>
  deliveryChallans: Array<{ id: string; dcNumber: string }>
  ordered: number
  sent: number
  pending: number
}

interface ChallanRow {
  id: string
  dcNumber: string
  dcDate: string
  status: string
  cartons: number | null
  transporter: string | null
  vehicleNumber: string | null
  lrNumber: string | null
  eWayBillNumber: string | null
  dispatchedAt: string | null
  deliveredAt: string | null
  cancelReason: string | null
  so: { id: string; soNumber: string; isJobWork: boolean; customerPORef: string | null }
  customer: { id: string; name: string; billingCity: string | null; shippingCity: string | null }
  warehouse: { id: string; name: string } | null
  pieces: number
}

type Tab = 'waiting' | 'challans'

const pcs = (n: number | string) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const DAY = 86_400_000
const startOfDay = (d: Date) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/** "overdue by 3 days", "due today", "in 4 days". */
function dueNote(date: string | null): { text: string; cls: string } | null {
  if (!date) return null
  const days = Math.round((startOfDay(new Date(date)).getTime() - startOfDay(new Date()).getTime()) / DAY)
  if (days < 0) return { text: `overdue by ${-days} ${days === -1 ? 'day' : 'days'}`, cls: 'text-destructive font-medium' }
  if (days === 0) return { text: 'due today', cls: 'warn-text' }
  return { text: `in ${days} ${days === 1 ? 'day' : 'days'}`, cls: 'text-muted-foreground' }
}

const town = (c: { shippingCity: string | null; billingCity: string | null }) => c.shippingCity || c.billingCity || ''

/** The transport in one line: transporter, vehicle, LR. */
const transport = (c: ChallanRow) => [c.transporter, c.vehicleNumber, c.lrNumber && `LR ${c.lrNumber}`].filter(Boolean).join(' · ')

/**
 * Delivery Challan: goods leaving for the buyer.
 *
 * Two tabs. "Waiting to dispatch" lists the confirmed orders with pieces
 * still to send, soonest due first, each with a Dispatch button — the place a
 * dispatch starts. "Challans" is every challan raised, with print, dispatch
 * a draft, mark delivered and cancel. The orders list links here with
 * ?dispatch=<order id>, which opens the challan form straight away.
 */
export default function DeliveryChallanPage() {
  const { rowsPerPage } = useAppSettings()
  const [tab, setTab] = useState<Tab>('waiting')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')

  // Waiting to dispatch
  const [waiting, setWaiting] = useState<WaitingOrder[]>([])
  const [waitingLoading, setWaitingLoading] = useState(true)

  // Challans
  const [rows, setRows] = useState<ChallanRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)

  const [form, setForm] = useState<{ open: boolean; soId: string | null; challanId: string | null }>({
    open: false,
    soId: null,
    challanId: null,
  })
  const [cancelling, setCancelling] = useState<ChallanRow | null>(null)
  const [acting, setActing] = useState(false)

  const mayCreate = can('sales', 'create')
  const mayEdit = can('sales', 'edit')

  // Arriving from an order: ?dispatch=<order id> opens the form for it;
  // ?q= searches, ?tab=challans opens the second tab.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const dispatch = params.get('dispatch')
    const q = params.get('q')
    if (params.get('tab') === 'challans' || q) setTab('challans')
    if (q) {
      setSearch(q)
      setDebounced(q)
    }
    if (dispatch && can('sales', 'create')) setForm({ open: true, soId: dispatch, challanId: null })
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const describeError = (err: unknown) =>
    err instanceof ApiError
      ? err.status === 403
        ? 'Your role does not allow viewing delivery challans.'
        : err.message
      : 'Could not reach the server. Is the API running?'

  const loadWaiting = useCallback(async () => {
    setWaitingLoading(true)
    try {
      const qs = new URLSearchParams()
      if (debounced) qs.set('q', debounced)
      const res = await api.get<{ data: WaitingOrder[] }>(`/sales/challans/waiting?${qs}`)
      setWaiting(res.data)
    } catch (err) {
      setError(describeError(err))
      setWaiting([])
    } finally {
      setWaitingLoading(false)
    }
  }, [debounced])

  const query = useCallback(
    (p: number, limit: number) => {
      const qs = new URLSearchParams({ page: String(p), limit: String(limit) })
      if (debounced) qs.set('q', debounced)
      if (status) qs.set('status', status)
      if (fromDate) qs.set('from', fromDate)
      if (toDate) qs.set('to', toDate)
      return `/sales/challans?${qs}`
    },
    [debounced, status, fromDate, toDate]
  )

  // Only the newest request may fill the list.
  const latestLoad = useRef(0)
  const load = useCallback(async () => {
    const ticket = ++latestLoad.current
    setLoading(true)
    try {
      const res = await api.get<Paginated<ChallanRow>>(query(page, rowsPerPage))
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

  useEffect(() => {
    void loadWaiting()
  }, [loadWaiting])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    setPage(1)
  }, [debounced, status, fromDate, toDate])

  const refresh = () => {
    setError(null)
    void loadWaiting()
    void load()
  }

  const done = (msg: string) => {
    setMessage(msg)
    setError(null)
    refresh()
  }

  const dispatchDraft = async (c: ChallanRow) => {
    if (!window.confirm(`Dispatch ${c.dcNumber}? Its ${pcs(c.pieces)} pieces come out of ${c.warehouse?.name ?? 'the store'}.`)) return
    setError(null)
    setMessage(null)
    try {
      const res = await api.post<{ message?: string }>(`/sales/challans/${c.id}/dispatch`, {})
      done(res.message ?? `${c.dcNumber} dispatched.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not dispatch ${c.dcNumber}.`)
    }
  }

  const markDelivered = async (c: ChallanRow) => {
    if (!window.confirm(`Mark ${c.dcNumber} as delivered to ${c.customer.name}?`)) return
    setError(null)
    setMessage(null)
    try {
      const res = await api.post<{ message?: string }>(`/sales/challans/${c.id}/delivered`, {})
      done(res.message ?? `${c.dcNumber} marked delivered.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not update ${c.dcNumber}.`)
    }
  }

  const cancel = async (reason: string) => {
    if (!cancelling) return
    setActing(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.post<{ message?: string }>(`/sales/challans/${cancelling.id}/cancel`, { reason })
      setCancelling(null)
      done(res.message ?? `${cancelling.dcNumber} cancelled.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel the challan.')
      setCancelling(null)
    } finally {
      setActing(false)
    }
  }

  const rowActions = (c: ChallanRow): RowAction[] => {
    const items: RowAction[] = [
      { key: 'print', label: 'Print challan', icon: <Printer size={15} />, href: `/print/delivery-challan/${c.id}`, newTab: true },
    ]
    if (c.status === 'DRAFT' && mayEdit) {
      items.push({
        key: 'edit',
        label: 'Edit draft',
        icon: <Pencil size={15} />,
        onClick: () => setForm({ open: true, soId: null, challanId: c.id }),
      })
    }
    if (c.status === 'DRAFT' && mayCreate) {
      items.push({ key: 'dispatch', label: 'Dispatch', icon: <Truck size={15} />, onClick: () => void dispatchDraft(c) })
    }
    if (c.status === 'DISPATCHED' && mayEdit) {
      items.push({ key: 'delivered', label: 'Mark delivered', icon: <PackageCheck size={15} />, onClick: () => void markDelivered(c) })
    }
    if ((c.status === 'DRAFT' || c.status === 'DISPATCHED') && mayEdit) {
      items.push({ key: 'cancel', label: 'Cancel challan', icon: <Ban size={15} />, danger: true, onClick: () => setCancelling(c) })
    }
    return items
  }

  const EXPORT_COLUMNS: ExportColumn<ChallanRow>[] = [
    { header: 'Challan No.', value: (c) => c.dcNumber },
    { header: 'Date', value: (c) => asDate(c.dcDate) },
    { header: 'Status', value: (c) => challanStatus(c.status).label },
    { header: 'Order', value: (c) => c.so.soNumber },
    { header: 'Buyer PO', value: (c) => c.so.customerPORef ?? '' },
    { header: 'Customer', value: (c) => c.customer.name },
    { header: 'Town', value: (c) => town(c.customer) },
    { header: 'From store', value: (c) => c.warehouse?.name ?? '' },
    { header: 'Pieces', value: (c) => c.pieces },
    { header: 'Cartons', value: (c) => c.cartons ?? '' },
    { header: 'Transporter', value: (c) => c.transporter ?? '' },
    { header: 'Vehicle', value: (c) => c.vehicleNumber ?? '' },
    { header: 'LR No.', value: (c) => c.lrNumber ?? '' },
    { header: 'E-way bill', value: (c) => c.eWayBillNumber ?? '' },
    { header: 'Delivered', value: (c) => asDate(c.deliveredAt) },
  ]

  const exportList = async (format: ExportFormat) => {
    setError(null)
    try {
      const { rows: all, total: count, truncated } = await fetchEveryPage<ChallanRow>((p) => query(p, 200))
      if (all.length === 0) {
        setMessage('Nothing to export — no challans match these filters.')
        return
      }
      await downloadRows({ rows: all, columns: EXPORT_COLUMNS, name: 'delivery-challans', sheet: 'Delivery Challans', format })
      setMessage(
        truncated
          ? `Exported the first ${all.length} of ${count} challans. Narrow the filters to get the rest.`
          : `Exported ${all.length} ${all.length === 1 ? 'challan' : 'challans'}.`
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the export.')
    }
  }

  const piecesWaiting = waiting.reduce((s, o) => s + o.pending, 0)
  const lateCount = waiting.filter((o) => o.deliveryDate && startOfDay(new Date(o.deliveryDate)) < startOfDay(new Date())).length
  const anyFilter = Boolean(search || status || fromDate || toDate)
  const pages = Math.ceil(total / rowsPerPage) || 1

  const tabs: Array<{ key: Tab; label: string; icon: React.ElementType; count?: number }> = [
    { key: 'waiting', label: 'Waiting to dispatch', icon: ClipboardList, count: waiting.length },
    { key: 'challans', label: 'Challans', icon: Truck, count: total },
  ]

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <div className="min-w-0">
            <h1 className="page-title text-xl sm:text-2xl">Delivery Challan</h1>
            <p className="page-subtitle hidden sm:block">
              {waitingLoading
                ? 'Goods leaving for the buyer'
                : `${waiting.length} ${waiting.length === 1 ? 'order' : 'orders'} waiting · ${pcs(piecesWaiting)} pcs to send${
                    lateCount ? ` · ${lateCount} overdue` : ''
                  }`}
            </p>
          </div>
          <div className="border-border bg-secondary flex rounded-lg border p-1" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  tab === t.key ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <t.icon size={15} />
                <span className="hidden sm:inline">{t.label}</span>
                <span className="sm:hidden">{t.key === 'waiting' ? 'Waiting' : 'Challans'}</span>
                {t.count !== undefined && <span className="text-muted-foreground text-xs tabular-nums">{t.count}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={refresh} disabled={loading || waitingLoading} aria-label="Refresh">
            <RefreshCw size={15} className={loading || waitingLoading ? 'animate-spin' : undefined} />
          </button>
          {tab === 'challans' && <ExportButton onExport={exportList} disabled={loading} />}
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

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 sm:min-w-[170px] sm:max-w-[260px] sm:basis-0 sm:px-2.5">
            <Search size={14} className="text-muted-foreground hidden shrink-0 sm:block" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder={tab === 'waiting' ? 'Order, customer, buyer PO...' : 'Challan, order, customer, LR...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search"
            />
          </div>
          {tab === 'challans' && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex shrink-0 items-center gap-1">
                <input
                  type="date"
                  className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[10px] sm:w-[7.75rem] sm:flex-none sm:px-3 sm:text-xs"
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  aria-label="Challan date from"
                />
                <span className="text-muted-foreground hidden text-xs sm:inline">to</span>
                <input
                  type="date"
                  className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[10px] sm:w-[7.75rem] sm:flex-none sm:px-3 sm:text-xs"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(e) => setToDate(e.target.value)}
                  aria-label="Challan date to"
                />
              </div>
              <SmartSelect
                className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-36 sm:px-3 sm:text-xs"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                aria-label="Filter by status"
              >
                <option value="">All statuses</option>
                {Object.entries(CHALLAN_STATUS).map(([v, s]) => (
                  <option key={v} value={v}>
                    {s.label}
                  </option>
                ))}
              </SmartSelect>
            </div>
          )}
          <div className="flex items-center gap-2 sm:contents">
            {anyFilter && (
              <button
                className="btn-ghost h-8 shrink-0 px-2 text-xs"
                onClick={() => {
                  setSearch('')
                  setStatus('')
                  setFromDate('')
                  setToDate('')
                }}
              >
                Clear
              </button>
            )}
            <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
              {tab === 'waiting'
                ? `${waiting.length} ${waiting.length === 1 ? 'order' : 'orders'}`
                : `${total} ${total === 1 ? 'challan' : 'challans'}`}
            </span>
          </div>
        </div>

        {tab === 'waiting' ? (
          waitingLoading && waiting.length === 0 ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="skeleton h-10 w-full rounded-lg" />
              ))}
            </div>
          ) : waiting.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-muted-foreground text-sm">
                {search ? 'No waiting orders match that search.' : 'Nothing waiting. Every confirmed order has been sent in full.'}
              </p>
            </div>
          ) : (
            <div className="list-scope">
              <div className="list-cards divide-border divide-y">
                {waiting.map((o) => {
                  const note = dueNote(o.deliveryDate)
                  const draft = o.deliveryChallans[0]
                  return (
                    <div key={o.id} className="p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-foreground font-mono text-xs font-semibold">{o.soNumber}</span>
                            <span className={salesOrderStatus(o).cls}>{salesOrderStatus(o).label}</span>
                            {o.isJobWork && <span className="badge-purple">Job work</span>}
                          </div>
                          <p className="text-foreground mt-1 font-medium leading-snug">{o.customer.name}</p>
                          {town(o.customer) && <p className="text-muted-foreground text-[11px]">{town(o.customer)}</p>}
                        </div>
                        <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">{pcs(o.pending)} pcs</span>
                      </div>
                      <dl className="mt-2.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                        <dt className="text-muted-foreground">Delivery</dt>
                        <dd className="text-foreground">
                          {o.deliveryDate ? formatDate(o.deliveryDate) : '—'}
                          {note && <span className={`ml-1.5 ${note.cls}`}>{note.text}</span>}
                        </dd>
                        <dt className="text-muted-foreground">Sent</dt>
                        <dd className="text-foreground tabular-nums">
                          {pcs(o.sent)} of {pcs(o.ordered)}
                        </dd>
                        {o.customerPORef && (
                          <>
                            <dt className="text-muted-foreground">Buyer PO</dt>
                            <dd className="text-foreground">{o.customerPORef}</dd>
                          </>
                        )}
                      </dl>
                      {mayCreate && (
                        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                          {draft && mayEdit && (
                            <button className="btn-secondary h-8 px-3 text-xs" onClick={() => setForm({ open: true, soId: null, challanId: draft.id })}>
                              <Pencil size={13} /> {draft.dcNumber}
                            </button>
                          )}
                          <button className="btn-primary h-8 px-3 text-xs" onClick={() => setForm({ open: true, soId: o.id, challanId: null })}>
                            <Truck size={13} /> Dispatch
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="list-rows w-full">
                <table className="data-table w-full">
                  <thead>
                    <tr className="bg-secondary">
                      <th>Order</th>
                      <th>Customer</th>
                      <th className="col-wide">Buyer PO</th>
                      <th>Delivery</th>
                      <th className="col-wide" style={{ textAlign: 'right' }}>
                        Sent
                      </th>
                      <th style={{ textAlign: 'right' }}>To send</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {waiting.map((o) => {
                      const note = dueNote(o.deliveryDate)
                      const draft = o.deliveryChallans[0]
                      const s = salesOrderStatus(o)
                      return (
                        <tr key={o.id}>
                          <td className="whitespace-nowrap">
                            <span className="text-foreground font-mono text-xs font-semibold">{o.soNumber}</span>
                            <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
                              <CalendarDays size={11} className="shrink-0" />
                              {formatDate(o.orderDate)}
                            </div>
                          </td>
                          <td>
                            <div className="text-foreground max-w-[16rem] truncate font-medium">{o.customer.name}</div>
                            <div className="text-muted-foreground max-w-[16rem] truncate text-[11px] leading-tight">
                              {town(o.customer)}
                              {o.isJobWork && <span className="badge-purple ml-1.5">Job work</span>}
                            </div>
                          </td>
                          <td className="col-wide text-xs">{o.customerPORef ?? '—'}</td>
                          <td className="whitespace-nowrap text-xs">
                            <div className="text-foreground">{o.deliveryDate ? formatDate(o.deliveryDate) : '—'}</div>
                            {note && <div className={`text-[11px] ${note.cls}`}>{note.text}</div>}
                          </td>
                          <td className="col-wide text-right text-xs tabular-nums">
                            {pcs(o.sent)} <span className="text-muted-foreground">of {pcs(o.ordered)}</span>
                          </td>
                          <td className="text-right font-semibold tabular-nums">{pcs(o.pending)}</td>
                          <td>
                            <span className={s.cls}>{s.label}</span>
                          </td>
                          <td className="whitespace-nowrap text-right">
                            {mayCreate && (
                              <div className="flex justify-end gap-2">
                                {draft && mayEdit && (
                                  <button
                                    className="btn-secondary h-8 px-2.5 text-xs"
                                    onClick={() => setForm({ open: true, soId: null, challanId: draft.id })}
                                    title={`Open the draft ${draft.dcNumber}`}
                                  >
                                    <Pencil size={13} /> {draft.dcNumber}
                                  </button>
                                )}
                                <button
                                  className="btn-primary h-8 px-2.5 text-xs"
                                  onClick={() => setForm({ open: true, soId: o.id, challanId: null })}
                                >
                                  <Truck size={13} /> Dispatch
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ) : loading && rows.length === 0 ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              {anyFilter
                ? 'No challans match these filters.'
                : 'No challans yet. Dispatch an order from the "Waiting to dispatch" tab.'}
            </p>
          </div>
        ) : (
          <div className="list-scope">
            <div className="list-cards divide-border divide-y">
              {rows.map((c) => {
                const s = challanStatus(c.status)
                const actions = rowActions(c)
                return (
                  <div key={c.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-foreground font-mono text-xs font-semibold">{c.dcNumber}</span>
                          <span className={s.cls}>{s.label}</span>
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">{c.customer.name}</p>
                        <p className="text-muted-foreground text-[11px]">
                          {formatDate(c.dcDate)} · {c.so.soNumber}
                        </p>
                      </div>
                      <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">{pcs(c.pieces)} pcs</span>
                    </div>
                    <dl className="mt-2.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">From</dt>
                      <dd className="text-foreground">{c.warehouse?.name ?? '—'}</dd>
                      <dt className="text-muted-foreground">Cartons</dt>
                      <dd className="text-foreground">{c.cartons ?? '—'}</dd>
                      <dt className="text-muted-foreground">Transport</dt>
                      <dd className="text-foreground">{transport(c) || '—'}</dd>
                    </dl>
                    {actions.length > 0 && (
                      <div className="mt-3 flex justify-end">
                        <ActionMenu label={`Actions for ${c.dcNumber}`} items={actions} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="list-rows w-full">
              <table className="data-table w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th>Challan</th>
                    <th>Customer</th>
                    <th>Order</th>
                    <th className="col-wide">From store</th>
                    <th style={{ textAlign: 'right' }}>Pieces</th>
                    <th className="col-wide" style={{ textAlign: 'right' }}>
                      Cartons
                    </th>
                    <th className="col-roomy">Transport</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const s = challanStatus(c.status)
                    const actions = rowActions(c)
                    return (
                      <tr key={c.id}>
                        <td className="whitespace-nowrap">
                          <a
                            href={`/print/delivery-challan/${c.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary font-mono text-xs font-semibold hover:underline"
                            title={`Print ${c.dcNumber}`}
                          >
                            {c.dcNumber}
                          </a>
                          <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
                            <CalendarDays size={11} className="shrink-0" />
                            {formatDate(c.dcDate)}
                          </div>
                        </td>
                        <td>
                          <div className="text-foreground max-w-[15rem] truncate font-medium">{c.customer.name}</div>
                          {town(c.customer) && (
                            <div className="text-muted-foreground max-w-[15rem] truncate text-[11px] leading-tight">{town(c.customer)}</div>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-xs">
                          <a href={`/sales/orders?q=${encodeURIComponent(c.so.soNumber)}`} className="text-primary font-mono hover:underline">
                            {c.so.soNumber}
                          </a>
                          {c.so.customerPORef && <div className="text-muted-foreground text-[11px]">PO {c.so.customerPORef}</div>}
                        </td>
                        <td className="col-wide text-xs">{c.warehouse?.name ?? '—'}</td>
                        <td className="text-right font-semibold tabular-nums">{pcs(c.pieces)}</td>
                        <td className="col-wide text-right text-xs tabular-nums">{c.cartons ?? '—'}</td>
                        <td className="col-roomy max-w-[14rem] truncate text-xs" title={transport(c)}>
                          {transport(c) || <span className="text-muted-foreground">—</span>}
                          {c.eWayBillNumber && <div className="text-muted-foreground text-[11px]">EWB {c.eWayBillNumber}</div>}
                        </td>
                        <td>
                          <span className={s.cls} title={c.status === 'CANCELLED' ? c.cancelReason ?? undefined : undefined}>
                            {s.label}
                          </span>
                          {c.status === 'DELIVERED' && c.deliveredAt && (
                            <div className="text-muted-foreground mt-0.5 flex items-center gap-1 text-[11px]">
                              <CheckCircle2 size={11} /> {formatDate(c.deliveredAt)}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-right">
                          <div className="flex justify-end">
                            {actions.length > 0 && <ActionMenu label={`Actions for ${c.dcNumber}`} items={actions} />}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'challans' && <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />}

        <div className="border-border bg-secondary/40 flex items-start gap-2 border-t px-4 py-2">
          <Info size={14} className="text-primary mt-0.5 shrink-0" />
          <p className="text-muted-foreground text-xs">
            {tab === 'waiting'
              ? 'Confirmed orders with pieces still to send, soonest due first. Dispatch takes the pieces out of the store; a draft takes nothing until it is dispatched.'
              : 'Cancelling a dispatched challan puts its pieces back in the store and back on the order.'}
          </p>
        </div>
      </div>

      <DeliveryChallanDialog
        open={form.open}
        soId={form.soId}
        challanId={form.challanId}
        onClose={() => setForm({ open: false, soId: null, challanId: null })}
        onSaved={(msg) => {
          setTab('challans')
          done(msg)
        }}
      />

      {cancelling && (
        <ReasonDialog
          title={`Cancel ${cancelling.dcNumber}?`}
          description={
            cancelling.status === 'DRAFT'
              ? 'The draft is called off. Nothing has left the store.'
              : `Its ${pcs(cancelling.pieces)} pieces go back into ${cancelling.warehouse?.name ?? 'the store'} and back on ${cancelling.so.soNumber} as still to send.`
          }
          confirmLabel="Cancel challan"
          placeholder="Raised by mistake / goods came back"
          danger
          busy={acting}
          onCancel={() => setCancelling(null)}
          onConfirm={(reason) => void cancel(reason)}
        />
      )}
    </div>
  )
}
