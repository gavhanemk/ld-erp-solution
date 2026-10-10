'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Ban,
  CalendarDays,
  ClipboardList,
  HandCoins,
  Undo2,
  Info,
  Printer,
  ReceiptText,
  RefreshCw,
  Search,
} from 'lucide-react'
import { api, ApiError, can, masterResource, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ExportButton } from '@/components/tables/ExportButton'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { asDate, asNumber, downloadRows, fetchEveryPage, type ExportColumn, type ExportFormat } from '@/lib/export'
import { useAppSettings } from '@/lib/appSettings'
import { formatCurrency, formatDate } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { INVOICE_STATUS, invoiceStatus } from '@/components/sales/status'
import { SalesInvoiceDialog } from '@/components/sales/SalesInvoiceDialog'

/** A dispatched challan not billed yet, as the waiting list returns it. */
interface WaitingChallan {
  id: string
  dcNumber: string
  dcDate: string
  status: string
  eWayBillNumber: string | null
  so: { id: string; soNumber: string; customerPORef: string | null; isJobWork: boolean }
  customer: { id: string; name: string; billingCity: string | null; shippingCity: string | null } | null
  pieces: number
  value: number
}

interface InvoiceRow {
  id: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string | null
  status: string
  taxableAmount: string | number
  cgst: string | number
  sgst: string | number
  igst: string | number
  totalAmount: string | number
  paidAmount: string | number
  balanceAmount: string | number
  eWayBillNumber: string | null
  cancelReason: string | null
  customer: { id: string; name: string; billingCity: string | null; shippingCity: string | null }
  so: { id: string; soNumber: string; customerPORef: string | null } | null
  dc: { id: string; dcNumber: string } | null
}

interface Summary {
  unpaid: { count: number; amount: number }
  overdue: { count: number; amount: number }
  thisMonth: { count: number; amount: number }
  waiting: number
}

type Tab = 'waiting' | 'invoices'

const pcs = (n: number | string) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const money = (v: string | number) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const town = (c: { shippingCity: string | null; billingCity: string | null } | null) => c?.shippingCity || c?.billingCity || ''
const DAY = 86_400_000
const startOfDay = (d: Date) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/** "overdue by 3 days", "due today", "in 12 days" — only while something is owed. */
function dueNote(inv: InvoiceRow): { text: string; cls: string } | null {
  if (!inv.dueDate || !['UNPAID', 'PARTIAL'].includes(inv.status)) return null
  const days = Math.round((startOfDay(new Date(inv.dueDate)).getTime() - startOfDay(new Date()).getTime()) / DAY)
  if (days < 0) return { text: `overdue by ${-days} ${days === -1 ? 'day' : 'days'}`, cls: 'text-destructive font-medium' }
  if (days === 0) return { text: 'due today', cls: 'warn-text' }
  return { text: `in ${days} ${days === 1 ? 'day' : 'days'}`, cls: 'text-muted-foreground' }
}

/**
 * Sales invoices.
 *
 * Two tabs. "Waiting to invoice" is every challan that has gone and is not
 * billed, oldest first, each with a Create invoice button. "Invoices" is
 * every invoice raised, with what is still owed and when it falls due, and
 * print and cancel. Links in: ?create=<challan id> opens the invoice form for
 * that challan (from the challan list, and from Dispatch & invoice); ?q=
 * searches.
 */
export default function SalesInvoicesPage() {
  const { rowsPerPage } = useAppSettings()
  const [tab, setTab] = useState<Tab>('waiting')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; invoiceId?: string } | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')

  const [waiting, setWaiting] = useState<WaitingChallan[]>([])
  const [waitingLoading, setWaitingLoading] = useState(true)

  const [rows, setRows] = useState<InvoiceRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)
  const [customers, setCustomers] = useState<Array<{ id: string; name: string }>>([])

  const [billing, setBilling] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<InvoiceRow | null>(null)
  const [acting, setActing] = useState(false)

  const mayCreate = can('sales', 'create')
  const mayCancel = can('sales', 'approve')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const create = params.get('create')
    const q = params.get('q')
    if (params.get('tab') === 'invoices' || q) setTab('invoices')
    if (q) {
      setSearch(q)
      setDebounced(q)
    }
    if (create && can('sales', 'create')) setBilling(create)
  }, [])

  useEffect(() => {
    let alive = true
    masterResource<{ id: string; name: string }>('customers')
      .list({ limit: 500 })
      .then((c) => alive && setCustomers([...c.data].sort((x, y) => x.name.localeCompare(y.name))))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const describeError = (err: unknown) =>
    err instanceof ApiError
      ? err.status === 403
        ? 'Your role does not allow viewing invoices.'
        : err.message
      : 'Could not reach the server. Is the API running?'

  const loadSummary = useCallback(async () => {
    try {
      setSummary((await api.get<{ data: Summary }>('/sales/invoices/summary')).data)
    } catch {
      // The lists say what went wrong; the cards stay empty.
    }
  }, [])

  const loadWaiting = useCallback(async () => {
    setWaitingLoading(true)
    try {
      const qs = new URLSearchParams()
      if (debounced) qs.set('q', debounced)
      setWaiting((await api.get<{ data: WaitingChallan[] }>(`/sales/invoices/waiting?${qs}`)).data)
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
      if (customerId) qs.set('customerId', customerId)
      if (overdueOnly) qs.set('due', 'overdue')
      if (fromDate) qs.set('from', fromDate)
      if (toDate) qs.set('to', toDate)
      return `/sales/invoices?${qs}`
    },
    [debounced, status, customerId, overdueOnly, fromDate, toDate]
  )

  const latestLoad = useRef(0)
  const load = useCallback(async () => {
    const ticket = ++latestLoad.current
    setLoading(true)
    try {
      const res = await api.get<Paginated<InvoiceRow>>(query(page, rowsPerPage))
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
    void loadSummary()
  }, [loadSummary])
  useEffect(() => {
    void loadWaiting()
  }, [loadWaiting])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    setPage(1)
  }, [debounced, status, customerId, overdueOnly, fromDate, toDate])

  const refresh = () => {
    setError(null)
    void loadSummary()
    void loadWaiting()
    void load()
  }

  const cancel = async (reason: string) => {
    if (!cancelling) return
    setActing(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.post<{ message?: string }>(`/sales/invoices/${cancelling.id}/cancel`, { reason })
      setMessage({ text: res.message ?? `${cancelling.invoiceNumber} cancelled.` })
      setCancelling(null)
      refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel the invoice.')
      setCancelling(null)
    } finally {
      setActing(false)
    }
  }

  const rowActions = (inv: InvoiceRow): RowAction[] => {
    const items: RowAction[] = [
      { key: 'print', label: 'Print invoice', icon: <Printer size={15} />, href: `/print/sales-invoice/${inv.id}`, newTab: true },
    ]
    if ((inv.status === 'UNPAID' || inv.status === 'PARTIAL') && (can('sales', 'create') || can('accounts', 'create'))) {
      items.push({
        key: 'receive',
        label: 'Record receipt',
        icon: <HandCoins size={15} />,
        href: `/sales/payments?receive=${inv.customer.id}&invoice=${inv.id}`,
      })
    }
    if (inv.status !== 'CANCELLED' && can('sales', 'create')) {
      items.push({ key: 'credit', label: 'Return / credit note', icon: <Undo2 size={15} />, href: `/sales/returns?invoice=${inv.id}` })
    }
    if (inv.status !== 'CANCELLED' && Number(inv.paidAmount) === 0 && mayCancel) {
      items.push({ key: 'cancel', label: 'Cancel invoice', icon: <Ban size={15} />, danger: true, onClick: () => setCancelling(inv) })
    }
    return items
  }

  const EXPORT_COLUMNS: ExportColumn<InvoiceRow>[] = [
    { header: 'Invoice No.', value: (i) => i.invoiceNumber },
    { header: 'Date', value: (i) => asDate(i.invoiceDate) },
    { header: 'Status', value: (i) => invoiceStatus(i.status).label },
    { header: 'Customer', value: (i) => i.customer.name },
    { header: 'Town', value: (i) => town(i.customer) },
    { header: 'Order', value: (i) => i.so?.soNumber ?? '' },
    { header: 'Buyer PO', value: (i) => i.so?.customerPORef ?? '' },
    { header: 'Challan', value: (i) => i.dc?.dcNumber ?? '' },
    { header: 'Taxable', value: (i) => asNumber(i.taxableAmount) },
    { header: 'CGST', value: (i) => asNumber(i.cgst) },
    { header: 'SGST', value: (i) => asNumber(i.sgst) },
    { header: 'IGST', value: (i) => asNumber(i.igst) },
    { header: 'Total', value: (i) => asNumber(i.totalAmount) },
    { header: 'Received', value: (i) => asNumber(i.paidAmount) },
    { header: 'Balance', value: (i) => asNumber(i.balanceAmount) },
    { header: 'Due Date', value: (i) => asDate(i.dueDate) },
    { header: 'E-way bill', value: (i) => i.eWayBillNumber ?? '' },
  ]

  const exportList = async (format: ExportFormat) => {
    setError(null)
    try {
      const { rows: all, total: count, truncated } = await fetchEveryPage<InvoiceRow>((p) => query(p, 200))
      if (all.length === 0) {
        setMessage({ text: 'Nothing to export — no invoices match these filters.' })
        return
      }
      await downloadRows({ rows: all, columns: EXPORT_COLUMNS, name: 'sales-invoices', sheet: 'Sales Invoices', format })
      setMessage({
        text: truncated
          ? `Exported the first ${all.length} of ${count} invoices. Narrow the filters to get the rest.`
          : `Exported ${all.length} ${all.length === 1 ? 'invoice' : 'invoices'}.`,
      })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the export.')
    }
  }

  const anyFilter = Boolean(search || status || customerId || overdueOnly || fromDate || toDate)
  const pages = Math.ceil(total / rowsPerPage) || 1

  const cards = [
    {
      key: 'unpaid',
      label: 'Unpaid',
      value: summary ? formatCurrency(summary.unpaid.amount) : '—',
      sub: summary ? `${summary.unpaid.count} ${summary.unpaid.count === 1 ? 'invoice' : 'invoices'} still owed` : '',
      tone: 'text-foreground',
      on: tab === 'invoices' && status === 'UNPAID',
      press: () => {
        setTab('invoices')
        setOverdueOnly(false)
        setStatus(status === 'UNPAID' ? '' : 'UNPAID')
      },
    },
    {
      key: 'overdue',
      label: 'Overdue',
      value: summary ? formatCurrency(summary.overdue.amount) : '—',
      sub: summary ? (summary.overdue.count ? `${summary.overdue.count} past the due date` : 'nothing late') : '',
      tone: (summary?.overdue.count ?? 0) > 0 ? 'text-destructive' : 'text-muted-foreground',
      on: tab === 'invoices' && overdueOnly,
      press: () => {
        setTab('invoices')
        setStatus('')
        setOverdueOnly(!overdueOnly)
      },
    },
    {
      key: 'month',
      label: 'Invoiced this month',
      value: summary ? formatCurrency(summary.thisMonth.amount) : '—',
      sub: summary ? `${summary.thisMonth.count} ${summary.thisMonth.count === 1 ? 'invoice' : 'invoices'}, with GST` : '',
      tone: 'text-foreground',
      on: false,
      press: () => setTab('invoices'),
    },
    {
      key: 'waiting',
      label: 'Waiting to invoice',
      value: String(summary?.waiting ?? 0),
      sub: 'challans gone, not billed',
      tone: (summary?.waiting ?? 0) > 0 ? 'warn-text' : 'text-muted-foreground',
      on: tab === 'waiting',
      press: () => setTab('waiting'),
    },
  ]

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <div className="min-w-0">
            <h1 className="page-title text-xl sm:text-2xl">Invoices</h1>
            <p className="page-subtitle hidden sm:block">Tax invoices for goods dispatched on a challan</p>
          </div>
          <div className="border-border bg-secondary flex rounded-lg border p-1" role="tablist">
            {(
              [
                { key: 'waiting', label: 'Waiting to invoice', short: 'Waiting', icon: ClipboardList, count: waiting.length },
                { key: 'invoices', label: 'Invoices', short: 'Invoices', icon: ReceiptText, count: total },
              ] as const
            ).map((t) => (
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
                <span className="sm:hidden">{t.short}</span>
                <span className="text-muted-foreground text-xs tabular-nums">{t.count}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={refresh} disabled={loading || waitingLoading} aria-label="Refresh">
            <RefreshCw size={15} className={loading || waitingLoading ? 'animate-spin' : undefined} />
          </button>
          {tab === 'invoices' && <ExportButton onExport={exportList} disabled={loading} />}
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {message && (
        <div className="border-primary/40 bg-primary/5 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
          <p className="text-primary text-sm">{message.text}</p>
          {message.invoiceId && (
            <a href={`/print/sales-invoice/${message.invoiceId}`} target="_blank" rel="noreferrer" className="btn-secondary h-8 px-3 text-xs">
              <Printer size={14} /> Print invoice
            </a>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {cards.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={c.press}
            aria-pressed={c.on}
            className={`glass-card cursor-pointer p-3 text-left transition-colors ${c.on ? 'ring-primary bg-primary/5 ring-2' : 'hover:bg-secondary/40'}`}
          >
            <p className="text-muted-foreground text-[11px] leading-tight">{c.label}</p>
            <p className={`mt-0.5 text-lg font-semibold tabular-nums leading-tight ${c.tone}`}>{c.value}</p>
            <p className="text-muted-foreground mt-0.5 truncate text-[11px] leading-snug">{c.sub}</p>
          </button>
        ))}
      </div>

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 sm:min-w-[170px] sm:max-w-[260px] sm:basis-0 sm:px-2.5">
            <Search size={14} className="text-muted-foreground hidden shrink-0 sm:block" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder={tab === 'waiting' ? 'Challan, order, customer...' : 'Invoice, customer, order, challan...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search"
            />
          </div>
          {tab === 'invoices' && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex shrink-0 items-center gap-1">
                <input
                  type="date"
                  className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[10px] sm:w-[7.75rem] sm:flex-none sm:px-3 sm:text-xs"
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  aria-label="Invoice date from"
                />
                <span className="text-muted-foreground hidden text-xs sm:inline">to</span>
                <input
                  type="date"
                  className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[10px] sm:w-[7.75rem] sm:flex-none sm:px-3 sm:text-xs"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(e) => setToDate(e.target.value)}
                  aria-label="Invoice date to"
                />
              </div>
              <SmartSelect
                className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-40 sm:px-3 sm:text-xs"
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
                className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-36 sm:px-3 sm:text-xs"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value)
                  setOverdueOnly(false)
                }}
                aria-label="Filter by status"
              >
                <option value="">All statuses</option>
                {Object.entries(INVOICE_STATUS).map(([v, s]) => (
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
                  setCustomerId('')
                  setOverdueOnly(false)
                  setFromDate('')
                  setToDate('')
                }}
              >
                Clear
              </button>
            )}
            <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
              {tab === 'waiting'
                ? `${waiting.length} ${waiting.length === 1 ? 'challan' : 'challans'}`
                : `${total} ${total === 1 ? 'invoice' : 'invoices'}`}
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
                {search ? 'No challans match that search.' : 'Nothing waiting. Every dispatched challan has its invoice.'}
              </p>
            </div>
          ) : (
            <div className="list-scope">
              <div className="list-cards divide-border divide-y">
                {waiting.map((c) => (
                  <div key={c.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <span className="text-foreground font-mono text-xs font-semibold">{c.dcNumber}</span>
                        <p className="text-foreground mt-1 font-medium leading-snug">{c.customer?.name}</p>
                        <p className="text-muted-foreground text-[11px]">
                          {formatDate(c.dcDate)} · {c.so.soNumber}
                        </p>
                      </div>
                      <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">₹{money(c.value)}</span>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className="text-muted-foreground text-xs tabular-nums">{pcs(c.pieces)} pcs</span>
                      {mayCreate && (
                        <button className="btn-primary h-8 px-3 text-xs" onClick={() => setBilling(c.id)}>
                          <ReceiptText size={13} /> Create invoice
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="list-rows w-full">
                <table className="data-table w-full">
                  <thead>
                    <tr className="bg-secondary">
                      <th>Challan</th>
                      <th>Customer</th>
                      <th>Order</th>
                      <th style={{ textAlign: 'right' }}>Pieces</th>
                      <th style={{ textAlign: 'right' }}>Value before GST</th>
                      <th className="col-wide">E-way bill</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {waiting.map((c) => (
                      <tr key={c.id}>
                        <td className="whitespace-nowrap">
                          <a
                            href={`/print/delivery-challan/${c.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary font-mono text-xs font-semibold hover:underline"
                          >
                            {c.dcNumber}
                          </a>
                          <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
                            <CalendarDays size={11} className="shrink-0" />
                            {formatDate(c.dcDate)}
                          </div>
                        </td>
                        <td>
                          <div className="text-foreground max-w-[16rem] truncate font-medium">{c.customer?.name}</div>
                          <div className="text-muted-foreground text-[11px]">
                            {town(c.customer)}
                            {c.so.isJobWork && <span className="badge-purple ml-1.5">Job work</span>}
                          </div>
                        </td>
                        <td className="whitespace-nowrap text-xs">
                          <span className="font-mono">{c.so.soNumber}</span>
                          {c.so.customerPORef && <div className="text-muted-foreground text-[11px]">PO {c.so.customerPORef}</div>}
                        </td>
                        <td className="text-right tabular-nums">{pcs(c.pieces)}</td>
                        <td className="text-right font-semibold tabular-nums">₹{money(c.value)}</td>
                        <td className="col-wide font-mono text-xs">{c.eWayBillNumber ?? '—'}</td>
                        <td className="whitespace-nowrap text-right">
                          {mayCreate && (
                            <button className="btn-primary h-8 px-2.5 text-xs" onClick={() => setBilling(c.id)}>
                              <ReceiptText size={13} /> Create invoice
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
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
              {anyFilter ? 'No invoices match these filters.' : 'No invoices yet. Bill a dispatched challan from "Waiting to invoice".'}
            </p>
          </div>
        ) : (
          <div className="list-scope">
            <div className="list-cards divide-border divide-y">
              {rows.map((inv) => {
                const s = invoiceStatus(inv.status)
                const note = dueNote(inv)
                return (
                  <div key={inv.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-foreground font-mono text-xs font-semibold">{inv.invoiceNumber}</span>
                          <span className={s.cls}>{s.label}</span>
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">{inv.customer.name}</p>
                        <p className="text-muted-foreground text-[11px]">
                          {formatDate(inv.invoiceDate)}
                          {inv.dc ? ` · ${inv.dc.dcNumber}` : ''}
                        </p>
                      </div>
                      <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">₹{money(inv.totalAmount)}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                      <span>
                        {Number(inv.balanceAmount) > 0 ? `₹${money(inv.balanceAmount)} owed` : ''}
                        {note && <span className={`ml-1.5 ${note.cls}`}>{note.text}</span>}
                      </span>
                      <ActionMenu label={`Actions for ${inv.invoiceNumber}`} items={rowActions(inv)} />
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="list-rows w-full">
              <table className="data-table w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th>Invoice</th>
                    <th>Customer</th>
                    <th className="col-wide">Order / challan</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th style={{ textAlign: 'right' }}>Balance</th>
                    <th>Due</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((inv) => {
                    const s = invoiceStatus(inv.status)
                    const note = dueNote(inv)
                    return (
                      <tr key={inv.id}>
                        <td className="whitespace-nowrap">
                          <a
                            href={`/print/sales-invoice/${inv.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary font-mono text-xs font-semibold hover:underline"
                            title={`Print ${inv.invoiceNumber}`}
                          >
                            {inv.invoiceNumber}
                          </a>
                          <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
                            <CalendarDays size={11} className="shrink-0" />
                            {formatDate(inv.invoiceDate)}
                          </div>
                        </td>
                        <td>
                          <div className="text-foreground max-w-[15rem] truncate font-medium">{inv.customer.name}</div>
                          {town(inv.customer) && <div className="text-muted-foreground text-[11px]">{town(inv.customer)}</div>}
                        </td>
                        <td className="col-wide whitespace-nowrap text-xs">
                          {inv.so && (
                            <a href={`/sales/orders?q=${encodeURIComponent(inv.so.soNumber)}`} className="text-primary font-mono hover:underline">
                              {inv.so.soNumber}
                            </a>
                          )}
                          {inv.dc && <div className="text-muted-foreground font-mono text-[11px]">{inv.dc.dcNumber}</div>}
                        </td>
                        <td className="text-right font-semibold tabular-nums">₹{money(inv.totalAmount)}</td>
                        <td className="text-right tabular-nums">
                          {inv.status === 'CANCELLED' ? <span className="text-muted-foreground">—</span> : `₹${money(inv.balanceAmount)}`}
                        </td>
                        <td className="whitespace-nowrap text-xs">
                          <div className="text-foreground">{inv.dueDate ? formatDate(inv.dueDate) : '—'}</div>
                          {note && <div className={`text-[11px] ${note.cls}`}>{note.text}</div>}
                        </td>
                        <td>
                          <span className={s.cls} title={inv.status === 'CANCELLED' ? inv.cancelReason ?? undefined : undefined}>
                            {s.label}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-right">
                          <div className="flex justify-end">
                            <ActionMenu label={`Actions for ${inv.invoiceNumber}`} items={rowActions(inv)} />
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

        {tab === 'invoices' && <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />}

        <div className="border-border bg-secondary/40 flex items-start gap-2 border-t px-4 py-2">
          <Info size={14} className="text-primary mt-0.5 shrink-0" />
          <p className="text-muted-foreground text-xs">
            {tab === 'waiting'
              ? 'Challans that have gone and are not billed, oldest first. One invoice bills one challan, at the rates on the order.'
              : 'An invoice is final once saved. A wrong one is cancelled with a reason while nothing has been received against it, and its challan billed again. Money in is recorded under Payments Received.'}
          </p>
        </div>
      </div>

      <SalesInvoiceDialog
        dcId={billing}
        onClose={() => setBilling(null)}
        onSaved={(text, invoiceId) => {
          setMessage({ text, invoiceId })
          setError(null)
          setTab('invoices')
          refresh()
        }}
      />

      {cancelling && (
        <ReasonDialog
          title={`Cancel ${cancelling.invoiceNumber}?`}
          description={`It stays on file as cancelled, with your reason, and ${cancelling.dc?.dcNumber ?? 'its challan'} can be billed again. Only while nothing has been received against it.`}
          confirmLabel="Cancel invoice"
          placeholder="Wrong rate billed"
          danger
          busy={acting}
          onCancel={() => setCancelling(null)}
          onConfirm={(reason) => void cancel(reason)}
        />
      )}
    </div>
  )
}
