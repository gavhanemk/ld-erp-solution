'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Ban,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  HandCoins,
  Info,
  Plus,
  Printer,
  ReceiptText,
  RefreshCw,
  Scale,
  Search,
} from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ExportButton } from '@/components/tables/ExportButton'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { asDate, asNumber, downloadRows, fetchEveryPage, type ExportColumn, type ExportFormat } from '@/lib/export'
import { useAppSettings } from '@/lib/appSettings'
import { formatCurrency, formatDate } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { PAYMENT_MODES, modeLabel, receiptStatus } from '@/components/sales/status'
import { RecordReceiptDialog, type ReceiptToApply } from '@/components/sales/RecordReceiptDialog'

type Bucket = 'notDue' | 'd30' | 'd60' | 'd90' | 'over90'
const BUCKETS: Array<[Bucket, string]> = [
  ['notDue', 'Not yet due'],
  ['d30', '1–30 days'],
  ['d60', '31–60 days'],
  ['d90', '61–90 days'],
  ['over90', 'Over 90 days'],
]

interface OutstandingRow {
  customer: { id: string; code: string; name: string; phone: string | null; billingCity: string | null; shippingCity: string | null; creditDays: number }
  invoices: Array<{
    id: string
    invoiceNumber: string
    invoiceDate: string
    dueDate: string | null
    totalAmount: string | number
    balanceAmount: string | number
    daysOverdue: number
    so: { soNumber: string } | null
  }>
  buckets: Record<Bucket, number>
  total: number
  overdue: number
  onAccount: number
  net: number
}

interface OutstandingSummary {
  customers: number
  total: number
  overdue: number
  onAccount: number
  buckets: Record<Bucket, number>
}

interface ReceiptRow {
  id: string
  receiptNumber: string
  receiptDate: string
  amount: string | number
  tdsAmount: string | number
  onAccount: string | number
  mode: string
  referenceNo: string | null
  chequeNo: string | null
  chequeDate: string | null
  isChequeCleared: boolean
  status: string
  reversalReason: string | null
  customer: { id: string; name: string; billingCity: string | null }
  bankAccount: { id: string; accountName: string } | null
  allocations: Array<{ id: string; amount: string | number; tdsAmount: string | number; invoice: { id: string; invoiceNumber: string } }>
}

interface Summary {
  outstanding: { count: number; amount: number }
  overdue: { count: number; amount: number }
  thisMonth: { count: number; amount: number }
  chequesToClear: { count: number; amount: number }
  onAccount: { count: number; amount: number }
}

type Tab = 'outstanding' | 'receipts'

const money = (v: string | number) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const town = (c: { shippingCity?: string | null; billingCity: string | null }) => c.shippingCity || c.billingCity || ''

/**
 * Payments received, and what customers still owe.
 *
 * Two tabs. "Outstanding" is each customer's dues aged — not yet due, 1–30,
 * 31–60, 61–90 and over 90 days late — less anything they paid in advance,
 * biggest first, with their invoices under each row and a button to record
 * money from them. "Receipts" is every receipt, with what it settled, and
 * print, apply advance, mark a cheque cleared and reverse.
 *
 * Links in: ?receive=<customer id>&invoice=<invoice id> opens the receipt
 * form for that invoice (from the invoice list); ?q= searches.
 */
export default function PaymentsReceivedPage() {
  const { rowsPerPage } = useAppSettings()
  const [tab, setTab] = useState<Tab>('outstanding')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; receiptId?: string } | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')

  // Outstanding
  const [owed, setOwed] = useState<OutstandingRow[]>([])
  const [owedSummary, setOwedSummary] = useState<OutstandingSummary | null>(null)
  const [owedLoading, setOwedLoading] = useState(true)
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [openRow, setOpenRow] = useState<string | null>(null)

  // Receipts
  const [rows, setRows] = useState<ReceiptRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState('')
  const [status, setStatus] = useState('')
  const [view, setView] = useState<'' | 'onAccount' | 'uncleared'>('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)

  const [form, setForm] = useState<{ open: boolean; customerId: string | null; invoiceId: string | null; apply: ReceiptToApply | null }>({
    open: false,
    customerId: null,
    invoiceId: null,
    apply: null,
  })
  const [reversing, setReversing] = useState<ReceiptRow | null>(null)
  const [acting, setActing] = useState(false)

  const mayRecord = can('sales', 'create') || can('accounts', 'create')
  const mayClear = can('sales', 'edit') || can('accounts', 'edit')
  const mayReverse = can('sales', 'approve') || can('accounts', 'approve')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const receive = params.get('receive')
    const q = params.get('q')
    if (params.get('tab') === 'receipts' || q) setTab('receipts')
    if (q) {
      setSearch(q)
      setDebounced(q)
    }
    if (receive && (can('sales', 'create') || can('accounts', 'create'))) {
      setForm({ open: true, customerId: receive, invoiceId: params.get('invoice'), apply: null })
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const describeError = (err: unknown) =>
    err instanceof ApiError
      ? err.status === 403
        ? 'Your role does not allow viewing receipts.'
        : err.message
      : 'Could not reach the server. Is the API running?'

  const loadSummary = useCallback(async () => {
    try {
      setSummary((await api.get<{ data: Summary }>('/sales/receipts/summary')).data)
    } catch {
      // The lists say what went wrong.
    }
  }, [])

  const loadOwed = useCallback(async () => {
    setOwedLoading(true)
    try {
      const qs = new URLSearchParams()
      if (debounced) qs.set('q', debounced)
      if (overdueOnly) qs.set('overdue', '1')
      const res = await api.get<{ data: OutstandingRow[]; summary: OutstandingSummary }>(`/sales/receipts/outstanding?${qs}`)
      setOwed(res.data)
      setOwedSummary(res.summary)
    } catch (err) {
      setError(describeError(err))
      setOwed([])
    } finally {
      setOwedLoading(false)
    }
  }, [debounced, overdueOnly])

  const query = useCallback(
    (p: number, limit: number) => {
      const qs = new URLSearchParams({ page: String(p), limit: String(limit) })
      if (debounced) qs.set('q', debounced)
      if (mode) qs.set('mode', mode)
      if (status) qs.set('status', status)
      if (view === 'onAccount') qs.set('onAccount', '1')
      if (view === 'uncleared') qs.set('uncleared', '1')
      if (fromDate) qs.set('from', fromDate)
      if (toDate) qs.set('to', toDate)
      return `/sales/receipts?${qs}`
    },
    [debounced, mode, status, view, fromDate, toDate]
  )

  const latestLoad = useRef(0)
  const load = useCallback(async () => {
    const ticket = ++latestLoad.current
    setLoading(true)
    try {
      const res = await api.get<Paginated<ReceiptRow>>(query(page, rowsPerPage))
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
    void loadOwed()
  }, [loadOwed])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    setPage(1)
  }, [debounced, mode, status, view, fromDate, toDate])

  const refresh = () => {
    setError(null)
    void loadSummary()
    void loadOwed()
    void load()
  }

  const markCleared = async (r: ReceiptRow) => {
    if (!window.confirm(`Has the bank credited cheque ${r.chequeNo ?? ''} on ${r.receiptNumber}?`)) return
    setError(null)
    setMessage(null)
    try {
      const res = await api.post<{ message?: string }>(`/sales/receipts/${r.id}/cleared`, {})
      setMessage({ text: res.message ?? `${r.receiptNumber} marked cleared.` })
      refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the receipt.')
    }
  }

  const reverse = async (reason: string) => {
    if (!reversing) return
    setActing(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.post<{ message?: string }>(`/sales/receipts/${reversing.id}/reverse`, { reason })
      setMessage({ text: res.message ?? `${reversing.receiptNumber} reversed.` })
      setReversing(null)
      refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reverse the receipt.')
      setReversing(null)
    } finally {
      setActing(false)
    }
  }

  const rowActions = (r: ReceiptRow): RowAction[] => {
    const items: RowAction[] = [
      { key: 'print', label: 'Print receipt', icon: <Printer size={15} />, href: `/print/payment-receipt/${r.id}`, newTab: true },
    ]
    if (r.status === 'POSTED' && Number(r.onAccount) > 0 && mayRecord) {
      items.push({
        key: 'apply',
        label: 'Apply advance',
        icon: <HandCoins size={15} />,
        onClick: () =>
          setForm({
            open: true,
            customerId: r.customer.id,
            invoiceId: null,
            apply: { id: r.id, receiptNumber: r.receiptNumber, customerId: r.customer.id, customerName: r.customer.name, onAccount: Number(r.onAccount) },
          }),
      })
    }
    if (r.status === 'POSTED' && (r.mode === 'CHEQUE' || r.mode === 'PDC') && !r.isChequeCleared && mayClear) {
      items.push({ key: 'cleared', label: 'Mark cheque cleared', icon: <CheckCircle2 size={15} />, onClick: () => void markCleared(r) })
    }
    if (r.status === 'POSTED' && mayReverse) {
      items.push({ key: 'reverse', label: 'Reverse receipt', icon: <Ban size={15} />, danger: true, onClick: () => setReversing(r) })
    }
    return items
  }

  const settledText = (r: ReceiptRow) => r.allocations.map((a) => a.invoice.invoiceNumber).join(', ')

  const EXPORT_COLUMNS: ExportColumn<ReceiptRow>[] = [
    { header: 'Receipt No.', value: (r) => r.receiptNumber },
    { header: 'Date', value: (r) => asDate(r.receiptDate) },
    { header: 'Status', value: (r) => receiptStatus(r).label },
    { header: 'Customer', value: (r) => r.customer.name },
    { header: 'Mode', value: (r) => modeLabel(r.mode) },
    { header: 'Reference', value: (r) => r.referenceNo ?? '' },
    { header: 'Cheque No.', value: (r) => r.chequeNo ?? '' },
    { header: 'Cheque Date', value: (r) => asDate(r.chequeDate) },
    { header: 'Account', value: (r) => r.bankAccount?.accountName ?? (r.mode === 'CASH' ? 'Cash in hand' : '') },
    { header: 'Amount', value: (r) => asNumber(r.amount) },
    { header: 'TDS', value: (r) => asNumber(r.tdsAmount) },
    { header: 'On account', value: (r) => asNumber(r.onAccount) },
    { header: 'Invoices settled', value: (r) => settledText(r) },
    { header: 'Reversal reason', value: (r) => r.reversalReason ?? '' },
  ]

  const exportList = async (format: ExportFormat) => {
    setError(null)
    try {
      const { rows: all, total: count, truncated } = await fetchEveryPage<ReceiptRow>((p) => query(p, 200))
      if (all.length === 0) {
        setMessage({ text: 'Nothing to export — no receipts match these filters.' })
        return
      }
      await downloadRows({ rows: all, columns: EXPORT_COLUMNS, name: 'payments-received', sheet: 'Payments Received', format })
      setMessage({
        text: truncated
          ? `Exported the first ${all.length} of ${count} receipts. Narrow the filters to get the rest.`
          : `Exported ${all.length} ${all.length === 1 ? 'receipt' : 'receipts'}.`,
      })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the export.')
    }
  }

  const exportOwed = async (format: ExportFormat) => {
    if (owed.length === 0) {
      setMessage({ text: 'Nothing to export — nobody owes anything.' })
      return
    }
    const columns: ExportColumn<OutstandingRow>[] = [
      { header: 'Customer', value: (r) => r.customer.name },
      { header: 'Town', value: (r) => town(r.customer) },
      { header: 'Phone', value: (r) => r.customer.phone ?? '' },
      ...BUCKETS.map(([k, label]) => ({ header: label, value: (r: OutstandingRow) => r.buckets[k] })),
      { header: 'Owed', value: (r) => r.total },
      { header: 'Paid in advance', value: (r) => r.onAccount },
      { header: 'Net', value: (r) => r.net },
    ]
    await downloadRows({ rows: owed, columns, name: 'outstanding', sheet: 'Outstanding', format })
    setMessage({ text: `Exported ${owed.length} ${owed.length === 1 ? 'customer' : 'customers'}.` })
  }

  const anyFilter = Boolean(search || mode || status || view || fromDate || toDate || overdueOnly)
  const pages = Math.ceil(total / rowsPerPage) || 1

  const cards = [
    {
      key: 'owed',
      label: 'Outstanding',
      value: summary ? formatCurrency(summary.outstanding.amount) : '—',
      sub: summary ? `${summary.outstanding.count} ${summary.outstanding.count === 1 ? 'invoice' : 'invoices'} owed` : '',
      tone: 'text-foreground',
      on: tab === 'outstanding' && !overdueOnly,
      press: () => {
        setTab('outstanding')
        setOverdueOnly(false)
      },
    },
    {
      key: 'overdue',
      label: 'Overdue',
      value: summary ? formatCurrency(summary.overdue.amount) : '—',
      sub: summary ? (summary.overdue.count ? `${summary.overdue.count} past the due date` : 'nothing late') : '',
      tone: (summary?.overdue.count ?? 0) > 0 ? 'text-destructive' : 'text-muted-foreground',
      on: tab === 'outstanding' && overdueOnly,
      press: () => {
        setTab('outstanding')
        setOverdueOnly(!overdueOnly)
      },
    },
    {
      key: 'month',
      label: 'Received this month',
      value: summary ? formatCurrency(summary.thisMonth.amount) : '—',
      sub: summary ? `${summary.thisMonth.count} ${summary.thisMonth.count === 1 ? 'receipt' : 'receipts'}` : '',
      tone: 'text-foreground',
      on: false,
      press: () => {
        setTab('receipts')
        setView('')
      },
    },
    {
      key: 'cheques',
      label: 'Cheques to clear',
      value: summary ? formatCurrency(summary.chequesToClear.amount) : '—',
      sub: summary ? `${summary.chequesToClear.count} not yet credited` : '',
      tone: (summary?.chequesToClear.count ?? 0) > 0 ? 'warn-text' : 'text-muted-foreground',
      on: tab === 'receipts' && view === 'uncleared',
      press: () => {
        setTab('receipts')
        setView(view === 'uncleared' ? '' : 'uncleared')
      },
    },
    {
      key: 'advance',
      label: 'Paid in advance',
      value: summary ? formatCurrency(summary.onAccount.amount) : '—',
      sub: summary ? `on ${summary.onAccount.count} ${summary.onAccount.count === 1 ? 'receipt' : 'receipts'}, to apply` : '',
      tone: 'text-foreground',
      on: tab === 'receipts' && view === 'onAccount',
      press: () => {
        setTab('receipts')
        setView(view === 'onAccount' ? '' : 'onAccount')
      },
    },
  ]

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <div className="min-w-0">
            <h1 className="page-title text-xl sm:text-2xl">Payments Received</h1>
            <p className="page-subtitle hidden sm:block">Money in from customers, and what is still owed</p>
          </div>
          <div className="border-border bg-secondary flex rounded-lg border p-1" role="tablist">
            {(
              [
                { key: 'outstanding', label: 'Outstanding', icon: Scale, count: owed.length },
                { key: 'receipts', label: 'Receipts', icon: ReceiptText, count: total },
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
                {t.label}
                <span className="text-muted-foreground text-xs tabular-nums">{t.count}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={refresh} disabled={loading || owedLoading} aria-label="Refresh">
            <RefreshCw size={15} className={loading || owedLoading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={tab === 'receipts' ? exportList : exportOwed} disabled={loading || owedLoading} />
          {mayRecord && (
            <button className="btn-primary" onClick={() => setForm({ open: true, customerId: null, invoiceId: null, apply: null })}>
              <Plus size={15} /> <span className="hidden sm:inline">Record receipt</span>
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
        <div className="border-primary/40 bg-primary/5 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
          <p className="text-primary text-sm">{message.text}</p>
          {message.receiptId && (
            <a href={`/print/payment-receipt/${message.receiptId}`} target="_blank" rel="noreferrer" className="btn-secondary h-8 px-3 text-xs">
              <Printer size={14} /> Print receipt
            </a>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5">
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
              placeholder={tab === 'outstanding' ? 'Customer...' : 'Receipt, customer, UTR, cheque, invoice...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search"
            />
          </div>
          {tab === 'outstanding' ? (
            <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs">
              <input type="checkbox" className="accent-primary" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
              Only customers with something overdue
            </label>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex shrink-0 items-center gap-1">
                <input
                  type="date"
                  className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[10px] sm:w-[7.75rem] sm:flex-none sm:px-3 sm:text-xs"
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  aria-label="Receipt date from"
                />
                <span className="text-muted-foreground hidden text-xs sm:inline">to</span>
                <input
                  type="date"
                  className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[10px] sm:w-[7.75rem] sm:flex-none sm:px-3 sm:text-xs"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(e) => setToDate(e.target.value)}
                  aria-label="Receipt date to"
                />
              </div>
              <SmartSelect className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-36 sm:px-3 sm:text-xs" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Filter by mode">
                <option value="">All modes</option>
                {PAYMENT_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </SmartSelect>
              <SmartSelect className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-32 sm:px-3 sm:text-xs" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
                <option value="">All receipts</option>
                <option value="POSTED">Received</option>
                <option value="REVERSED">Reversed</option>
              </SmartSelect>
            </div>
          )}
          <div className="flex items-center gap-2 sm:contents">
            {anyFilter && (
              <button
                className="btn-ghost h-8 shrink-0 px-2 text-xs"
                onClick={() => {
                  setSearch('')
                  setMode('')
                  setStatus('')
                  setView('')
                  setFromDate('')
                  setToDate('')
                  setOverdueOnly(false)
                }}
              >
                Clear
              </button>
            )}
            <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
              {tab === 'outstanding'
                ? `${owed.length} ${owed.length === 1 ? 'customer' : 'customers'}`
                : `${total} ${total === 1 ? 'receipt' : 'receipts'}`}
            </span>
          </div>
        </div>

        {tab === 'outstanding' ? (
          owedLoading && owed.length === 0 ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="skeleton h-10 w-full rounded-lg" />
              ))}
            </div>
          ) : owed.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-muted-foreground text-sm">{anyFilter ? 'Nobody matches these filters.' : 'Nobody owes anything on invoices raised here.'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table w-full min-w-[980px]">
                <thead>
                  <tr className="bg-secondary">
                    <th style={{ width: 30 }} />
                    <th>Customer</th>
                    {BUCKETS.map(([k, label]) => (
                      <th key={k} style={{ textAlign: 'right' }}>
                        {label}
                      </th>
                    ))}
                    <th style={{ textAlign: 'right' }}>Owed</th>
                    <th style={{ textAlign: 'right' }}>Advance</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {owed.map((r) => {
                    const expanded = openRow === r.customer.id
                    return (
                      <Fragment key={r.customer.id}>
                        <tr>
                          <td>
                            {r.invoices.length > 0 && (
                              <button
                                className="bg-primary/10 text-primary hover:bg-primary/20 flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
                                onClick={() => setOpenRow(expanded ? null : r.customer.id)}
                                aria-expanded={expanded}
                                aria-label={`${expanded ? 'Hide' : 'Show'} invoices of ${r.customer.name}`}
                              >
                                {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                              </button>
                            )}
                          </td>
                          <td>
                            <div className="text-foreground max-w-[15rem] truncate font-medium">{r.customer.name}</div>
                            <div className="text-muted-foreground text-[11px]">
                              {[town(r.customer), r.customer.phone, `${r.invoices.length} ${r.invoices.length === 1 ? 'invoice' : 'invoices'}`]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          </td>
                          {BUCKETS.map(([k]) => (
                            <td
                              key={k}
                              className={`text-right text-xs tabular-nums ${
                                r.buckets[k] > 0 && (k === 'd90' || k === 'over90') ? 'text-destructive font-medium' : r.buckets[k] > 0 && k !== 'notDue' ? 'warn-text' : ''
                              }`}
                            >
                              {r.buckets[k] > 0 ? money(r.buckets[k]) : <span className="text-muted-foreground">—</span>}
                            </td>
                          ))}
                          <td className="text-right font-semibold tabular-nums">₹{money(r.total)}</td>
                          <td className="text-right text-xs tabular-nums">{r.onAccount > 0 ? `− ${money(r.onAccount)}` : <span className="text-muted-foreground">—</span>}</td>
                          <td className="whitespace-nowrap text-right">
                            {mayRecord && (
                              <button className="btn-secondary h-8 px-2.5 text-xs" onClick={() => setForm({ open: true, customerId: r.customer.id, invoiceId: null, apply: null })}>
                                <HandCoins size={13} /> Receive
                              </button>
                            )}
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={10} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              <div className="border-border bg-card overflow-hidden rounded-lg border">
                                <table className="subtable w-full">
                                  <thead>
                                    <tr>
                                      <th className="text-left">Invoice</th>
                                      <th className="text-left">Order</th>
                                      <th className="text-left">Due</th>
                                      <th className="text-right">Total</th>
                                      <th className="text-right">Owed</th>
                                      <th />
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {r.invoices.map((inv) => (
                                      <tr key={inv.id}>
                                        <td className="text-xs">
                                          <a href={`/print/sales-invoice/${inv.id}`} target="_blank" rel="noreferrer" className="text-primary font-mono hover:underline">
                                            {inv.invoiceNumber}
                                          </a>{' '}
                                          <span className="text-muted-foreground">{formatDate(inv.invoiceDate)}</span>
                                        </td>
                                        <td className="font-mono text-xs">{inv.so?.soNumber ?? '—'}</td>
                                        <td className="text-xs">
                                          {inv.dueDate ? formatDate(inv.dueDate) : '—'}
                                          {inv.daysOverdue > 0 && <span className="text-destructive ml-1.5 font-medium">{inv.daysOverdue} days late</span>}
                                        </td>
                                        <td className="text-right text-xs tabular-nums">{money(inv.totalAmount)}</td>
                                        <td className="text-right text-xs font-semibold tabular-nums">{money(inv.balanceAmount)}</td>
                                        <td className="text-right">
                                          {mayRecord && (
                                            <button
                                              className="text-primary text-xs hover:underline"
                                              onClick={() => setForm({ open: true, customerId: r.customer.id, invoiceId: inv.id, apply: null })}
                                            >
                                              Receive
                                            </button>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
                {owedSummary && (
                  <tfoot>
                    <tr className="bg-secondary/60 font-semibold">
                      <td />
                      <td className="text-xs">All customers</td>
                      {BUCKETS.map(([k]) => (
                        <td key={k} className="text-right text-xs tabular-nums">
                          {money(owedSummary.buckets[k])}
                        </td>
                      ))}
                      <td className="text-right tabular-nums">₹{money(owedSummary.total)}</td>
                      <td className="text-right text-xs tabular-nums">{owedSummary.onAccount > 0 ? `− ${money(owedSummary.onAccount)}` : '—'}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
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
            <p className="text-muted-foreground text-sm">{anyFilter ? 'No receipts match these filters.' : 'No receipts yet. Press Record receipt when money comes in.'}</p>
          </div>
        ) : (
          <div className="list-scope">
            <div className="list-cards divide-border divide-y">
              {rows.map((r) => {
                const s = receiptStatus(r)
                return (
                  <div key={r.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-foreground font-mono text-xs font-semibold">{r.receiptNumber}</span>
                          <span className={s.cls}>{s.label}</span>
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">{r.customer.name}</p>
                        <p className="text-muted-foreground text-[11px]">
                          {formatDate(r.receiptDate)} · {modeLabel(r.mode)}
                          {r.referenceNo || r.chequeNo ? ` ${r.chequeNo ?? r.referenceNo}` : ''}
                        </p>
                      </div>
                      <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">₹{money(r.amount)}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground min-w-0 truncate">
                        {settledText(r) || 'Not applied yet'}
                        {Number(r.onAccount) > 0 && r.status === 'POSTED' ? ` · ₹${money(r.onAccount)} on account` : ''}
                      </span>
                      <ActionMenu label={`Actions for ${r.receiptNumber}`} items={rowActions(r)} />
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="list-rows w-full">
              <table className="data-table w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th>Receipt</th>
                    <th>Customer</th>
                    <th>Mode</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th className="col-wide">Settled</th>
                    <th className="col-wide" style={{ textAlign: 'right' }}>
                      On account
                    </th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const s = receiptStatus(r)
                    return (
                      <tr key={r.id} className={r.status === 'REVERSED' ? 'opacity-70' : undefined}>
                        <td className="whitespace-nowrap">
                          <a
                            href={`/print/payment-receipt/${r.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary font-mono text-xs font-semibold hover:underline"
                          >
                            {r.receiptNumber}
                          </a>
                          <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
                            <CalendarDays size={11} className="shrink-0" />
                            {formatDate(r.receiptDate)}
                          </div>
                        </td>
                        <td>
                          <div className="text-foreground max-w-[15rem] truncate font-medium">{r.customer.name}</div>
                          {r.customer.billingCity && <div className="text-muted-foreground text-[11px]">{r.customer.billingCity}</div>}
                        </td>
                        <td className="text-xs">
                          <div className="text-foreground">{modeLabel(r.mode)}</div>
                          <div className="text-muted-foreground max-w-[12rem] truncate font-mono text-[11px]">
                            {r.chequeNo ? `Chq ${r.chequeNo}${r.chequeDate ? `, ${formatDate(r.chequeDate)}` : ''}` : r.referenceNo ?? ''}
                          </div>
                        </td>
                        <td className="text-right font-semibold tabular-nums">
                          ₹{money(r.amount)}
                          {Number(r.tdsAmount) > 0 && <div className="text-muted-foreground text-[11px] font-normal">+ ₹{money(r.tdsAmount)} TDS</div>}
                        </td>
                        <td className="col-wide max-w-[16rem] text-xs">
                          {r.allocations.length ? (
                            r.allocations.map((a) => (
                              <div key={a.id} className="flex justify-between gap-2 tabular-nums">
                                <span className="font-mono">{a.invoice.invoiceNumber}</span>
                                <span className="text-muted-foreground">{money(a.amount)}</span>
                              </div>
                            ))
                          ) : (
                            <span className="text-muted-foreground">Not applied yet</span>
                          )}
                        </td>
                        <td className="col-wide text-right text-xs tabular-nums">
                          {Number(r.onAccount) > 0 && r.status === 'POSTED' ? <span className="warn-text">{money(r.onAccount)}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td>
                          <span className={s.cls} title={r.status === 'REVERSED' ? r.reversalReason ?? undefined : undefined}>
                            {s.label}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-right">
                          <div className="flex justify-end">
                            <ActionMenu label={`Actions for ${r.receiptNumber}`} items={rowActions(r)} />
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

        {tab === 'receipts' && <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />}

        <div className="border-border bg-secondary/40 flex items-start gap-2 border-t px-4 py-2">
          <Info size={14} className="text-primary mt-0.5 shrink-0" />
          <p className="text-muted-foreground text-xs">
            {tab === 'outstanding'
              ? 'Aged from the due date, or the invoice date where there is none. Dues from the old system before this ERP are not here.'
              : 'One receipt can settle several invoices; what is left stays on account. A bounced cheque or a mistake is reversed, never deleted, and its invoices are owed again.'}
          </p>
        </div>
      </div>

      <RecordReceiptDialog
        open={form.open}
        customerId={form.customerId}
        invoiceId={form.invoiceId}
        apply={form.apply}
        onClose={() => setForm({ open: false, customerId: null, invoiceId: null, apply: null })}
        onSaved={(text, receiptId) => {
          setMessage({ text, receiptId })
          setError(null)
          refresh()
        }}
      />

      {reversing && (
        <ReasonDialog
          title={`Reverse ${reversing.receiptNumber}?`}
          description={`It stays on file as reversed, with your reason, and settles nothing.${
            reversing.allocations.length ? ` ${reversing.allocations.map((a) => a.invoice.invoiceNumber).join(', ')} will be owed again.` : ''
          }`}
          confirmLabel="Reverse receipt"
          placeholder="Cheque bounced: insufficient funds"
          danger
          busy={acting}
          onCancel={() => setReversing(null)}
          onConfirm={(reason) => void reverse(reason)}
        />
      )}
    </div>
  )
}
