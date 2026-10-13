'use client'

import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  Ban,
  Banknote,
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  IndianRupee,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Undo2,
  Wallet,
} from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { PurchaseBillDialog, type PurchaseBill } from '@/components/purchase/PurchaseBillDialog'
import { BillItems, BillDetailDialog } from '@/components/purchase/BillDetail'
import { RecordPaymentDialog } from '@/components/purchase/RecordPaymentDialog'
import { PurchaseNoteDialog } from '@/components/purchase/PurchaseNoteDialog'
import { Pagination } from '@/components/tables/Pagination'
import { ExportButton } from '@/components/tables/ExportButton'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { RowPanel } from '@/components/tables/RowPanel'
import { asDate, asNumber, downloadRows, fetchEveryPage, type ExportColumn, type ExportFormat } from '@/lib/export'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Purchase → Services & Expenses → Expenses.
 *
 * The old ERP's "Manage Expenses": every bill with nothing received against
 * it — labour contractors, job charges, rent, repairs, electricity — with the
 * TDS kept back and what is still owed. Goods bills stay on Purchase Bills.
 * The same bill form books them, with the expense heads and the TDS box.
 */

const STATUS: Record<string, { label: string; cls: string }> = {
  UNPAID: { label: 'Open', cls: 'badge-warning' },
  PARTIAL: { label: 'Part paid', cls: 'badge-info' },
  PAID: { label: 'Paid', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** The expense heads on a bill, without repeats — the old list's "Account". */
const headsOn = (bill: PurchaseBill) => [
  ...new Set((bill.lines ?? []).map((l) => l.item?.name).filter((n): n is string => Boolean(n))),
]

interface Head {
  id: string
  name: string
  category?: { name: string; parent?: { name: string } | null } | null
}

/** The rule every expense screen uses: filed under a category named for expenses. */
const EXPENSE_NAME = /expense/i
const isHead = (h: Head) =>
  EXPENSE_NAME.test(h.category?.name ?? '') || EXPENSE_NAME.test(h.category?.parent?.name ?? '')

function ExpensesTable() {
  const { rowsPerPage } = useAppSettings()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [rows, setRows] = useState<PurchaseBill[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [headId, setHeadId] = useState('')
  const [location, setLocation] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)

  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [heads, setHeads] = useState<Head[]>([])
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([])

  /** The open form: a new expense, a cash expense, or one being edited. */
  const [dialog, setDialog] = useState<{ open: boolean; record: PurchaseBill | null; cash?: boolean }>({
    open: false,
    record: null,
  })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<PurchaseBill | null>(null)
  const [paying, setPaying] = useState<PurchaseBill | null>(null)
  const [adjusting, setAdjusting] = useState<PurchaseBill | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [s, i, w] = await Promise.allSettled([
        masterResource<{ id: string; name: string }>('suppliers').list({ limit: 500 }),
        masterResource<Head>('items').list({ limit: 500 }),
        masterResource<{ id: string; name: string }>('warehouses').list({ limit: 100, active: true }),
      ])
      if (cancelled) return
      if (s.status === 'fulfilled') setSuppliers([...s.value.data].sort((a, b) => a.name.localeCompare(b.name)))
      if (i.status === 'fulfilled')
        setHeads(i.value.data.filter(isHead).sort((a, b) => a.name.localeCompare(b.name)))
      if (w.status === 'fulfilled') setWarehouses(w.value.data)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // "+ New Cash Expense" from elsewhere arrives as ?new=cash; a plain one as ?new=1.
  useEffect(() => {
    const n = searchParams.get('new')
    if (n) {
      setDialog({ open: true, record: null, cash: n === 'cash' })
      router.replace('/purchase/expenses')
    }
  }, [searchParams, router])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  /** The list's query, built once so the export and the screen agree. */
  const query = (p: number, limit: number) => {
    const qs = new URLSearchParams({ page: String(p), limit: String(limit), kind: 'expense' })
    if (debounced) qs.set('q', debounced)
    if (status) qs.set('status', status)
    if (supplierId) qs.set('supplierId', supplierId)
    if (headId) qs.set('itemId', headId)
    if (location) qs.set('warehouseId', location)
    if (fromDate) qs.set('from', fromDate)
    if (toDate) qs.set('to', toDate)
    return `/purchase/bills?${qs}`
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<Paginated<PurchaseBill>>(query(page, rowsPerPage))
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing expenses.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setRows([])
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, status, supplierId, headId, location, fromDate, toDate, page, rowsPerPage])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setPage(1)
  }, [debounced, status, supplierId, headId, location, fromDate, toDate])

  const EXPORT_COLUMNS: ExportColumn<PurchaseBill>[] = [
    { header: 'Date', value: (b) => asDate(b.supplierInvoiceDate ?? b.billDate) },
    { header: 'Bill No.', value: (b) => b.supplierInvoiceNo ?? '' },
    { header: 'Our Ref', value: (b) => b.billNumber },
    { header: 'Supplier', value: (b) => b.supplier?.name ?? '' },
    { header: 'Account', value: (b) => headsOn(b).join(', ') },
    { header: 'Location', value: (b) => b.warehouse?.name ?? 'Head office' },
    { header: 'Status', value: (b) => STATUS[b.status]?.label ?? b.status },
    { header: 'Taxable', value: (b) => asNumber(b.taxableAmount) },
    { header: 'GST', value: (b) => asNumber(Number(b.cgst) + Number(b.sgst) + Number(b.igst)) },
    { header: 'Amount', value: (b) => asNumber(b.totalAmount) },
    { header: 'TDS Section', value: (b) => b.tdsSection ?? '' },
    { header: 'TDS', value: (b) => asNumber(b.tdsAmount) },
    { header: 'Amount Paid', value: (b) => asNumber(b.paidAmount) },
    { header: 'Balance Due', value: (b) => asNumber(b.balanceAmount) },
    { header: 'Due', value: (b) => asDate(b.dueDate) },
  ]

  const exportList = async (format: ExportFormat) => {
    setError(null)
    try {
      const { rows: all, total, truncated } = await fetchEveryPage<PurchaseBill>((p) => query(p, 100))
      if (all.length === 0) {
        setMessage('Nothing to export — no expenses match these filters.')
        return
      }
      await downloadRows({ rows: all, columns: EXPORT_COLUMNS, name: 'expenses', sheet: 'Expenses', format })
      setMessage(
        truncated
          ? `Exported the first ${all.length} of ${total} expenses. Narrow the filters to get the rest.`
          : `Exported ${all.length} ${all.length === 1 ? 'expense' : 'expenses'}.`
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the export.')
    }
  }

  const cancel = async (bill: PurchaseBill) => {
    const reason = prompt(`Cancel ${bill.billNumber}?\n\nThe bill and its number stay on the record. Say why:`)
    if (reason === null) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/purchase/bills/${bill.id}/cancel`, {
        reason: reason.trim() || undefined,
      })
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel that expense.')
    } finally {
      setBusy(false)
    }
  }

  const actions = (bill: PurchaseBill): RowAction[] => {
    const items: RowAction[] = [
      { key: 'view', label: 'View full detail', icon: <Eye size={14} />, onClick: () => setDetail(bill) },
      {
        key: 'print',
        label: 'Print',
        icon: <Printer size={14} />,
        href: `/print/purchase-bill/${bill.id}`,
        newTab: true,
      },
    ]
    if (bill.status !== 'CANCELLED' && Number(bill.balanceAmount) > 0) {
      items.push({
        key: 'pay',
        label: 'Record payment',
        icon: <IndianRupee size={14} />,
        onClick: () => setPaying(bill),
      })
    }
    if (bill.status !== 'CANCELLED') {
      items.push({
        key: 'adjust',
        label: 'Raise debit note',
        icon: <Undo2 size={14} />,
        onClick: () => setAdjusting(bill),
      })
    }
    if (bill.status !== 'CANCELLED' && Number(bill.paidAmount) === 0) {
      items.push(
        { key: 'edit', label: 'Edit', icon: <Pencil size={14} />, onClick: () => setDialog({ open: true, record: bill }) },
        { key: 'cancel', label: 'Cancel', icon: <Ban size={14} />, onClick: () => void cancel(bill), danger: true }
      )
    }
    return items
  }

  const pages = Math.ceil(total / rowsPerPage) || 1
  const filtered = Boolean(debounced || status || supplierId || headId || location || fromDate || toDate)

  /** Money on this page, for the strip under the list. */
  const pageTotals = useMemo(
    () =>
      rows
        .filter((b) => b.status !== 'CANCELLED')
        .reduce(
          (t, b) => ({
            amount: t.amount + Number(b.totalAmount),
            tds: t.tds + Number(b.tdsAmount),
            paid: t.paid + Number(b.paidAmount),
            due: t.due + Number(b.balanceAmount),
          }),
          { amount: 0, tds: 0, paid: 0, due: 0 }
        ),
    [rows]
  )

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Expenses</h1>
          <p className="page-subtitle hidden sm:block">
            Service and expense bills, the TDS kept back, and what is still owed
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={exportList} disabled={loading} />
          <Link href="/purchase/debit-notes" className="btn-secondary hidden md:inline-flex">
            <Undo2 size={15} /> Debit notes
          </Link>
          <button
            className="btn-secondary"
            onClick={() => setDialog({ open: true, record: null, cash: true })}
            title="Booked and paid in one go"
            aria-label="New cash expense"
          >
            <Banknote size={15} /> <span className="hidden sm:inline">New Cash Expense</span>
          </button>
          <button
            className="btn-primary"
            onClick={() => setDialog({ open: true, record: null })}
            aria-label="New expense"
          >
            <Plus size={15} /> <span className="hidden sm:inline">New Expense</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="text-sm text-emerald-400">{message}</p>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex flex-col gap-2 sm:contents">
            <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 sm:min-w-[150px] sm:max-w-[190px] sm:basis-0 sm:px-2.5">
              <Search size={14} className="text-muted-foreground hidden shrink-0 sm:block" />
              <input
                className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
                placeholder="Search..."
                title="Reaches their bill number, ours, and the supplier"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search expenses"
              />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <input
                type="date"
                className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[10px] sm:w-[7.75rem] sm:flex-none sm:px-3 sm:text-xs"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label="From date"
              />
              <span className="text-muted-foreground hidden text-xs sm:inline">to</span>
              <input
                type="date"
                className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[10px] sm:w-[7.75rem] sm:flex-none sm:px-3 sm:text-xs"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                aria-label="To date"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:contents">
            <SmartSelect
              className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-32 sm:px-3 sm:text-xs"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              aria-label="Filter by supplier"
            >
              <option value="">All suppliers</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SmartSelect>
            <SmartSelect
              className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-36 sm:px-3 sm:text-xs"
              value={headId}
              onChange={(e) => setHeadId(e.target.value)}
              aria-label="Filter by account"
            >
              <option value="">All accounts</option>
              {heads.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </SmartSelect>
            <SmartSelect
              className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-32 sm:px-3 sm:text-xs"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              aria-label="Filter by location"
            >
              <option value="">All locations</option>
              <option value="none">Head office</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </SmartSelect>
            <SmartSelect
              className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-32 sm:px-3 sm:text-xs"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {Object.entries(STATUS).map(([v, s]) => (
                <option key={v} value={v}>
                  {s.label}
                </option>
              ))}
            </SmartSelect>
          </div>

          <div className="flex items-center gap-2 sm:contents">
            {filtered && (
              <button
                className="btn-ghost h-8 shrink-0 px-2 text-xs"
                onClick={() => {
                  setSearch('')
                  setStatus('')
                  setSupplierId('')
                  setHeadId('')
                  setLocation('')
                  setFromDate('')
                  setToDate('')
                }}
              >
                Clear
              </button>
            )}
            <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
              {total} {total === 1 ? 'expense' : 'expenses'}
            </span>
          </div>
        </div>

        {loading && rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              {filtered
                ? 'No expenses match what you are looking for. Clear the filters to see them all.'
                : 'No expenses booked yet. A labour contractor’s bill, job charges, rent or a repair — book it here, with the TDS kept back.'}
            </p>
          </div>
        ) : (
          <div className="list-scope">
            {/* Phone: one card per expense. */}
            <div className="list-cards divide-border divide-y">
              {rows.map((bill) => {
                const s = STATUS[bill.status] ?? { label: bill.status, cls: 'badge-neutral' }
                const open = expanded === bill.id
                return (
                  <div key={bill.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-teal-400">
                            {bill.supplierInvoiceNo || bill.billNumber}
                          </span>
                          <span className={s.cls}>{s.label}</span>
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">{bill.supplier?.name ?? '—'}</p>
                        <p className="text-muted-foreground mt-0.5 text-xs">{headsOn(bill).join(', ') || '—'}</p>
                      </div>
                      <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">
                        ₹{money(bill.totalAmount)}
                      </span>
                    </div>
                    <dl className="mt-2.5 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Date</dt>
                      <dd className="text-foreground">{formatDate(bill.supplierInvoiceDate ?? bill.billDate)}</dd>
                      <dt className="text-muted-foreground">TDS</dt>
                      <dd className="text-foreground tabular-nums">
                        ₹{money(bill.tdsAmount)}
                        {bill.tdsSection && <span className="text-muted-foreground"> · {bill.tdsSection}</span>}
                      </dd>
                      <dt className="text-muted-foreground">Paid</dt>
                      <dd className="text-foreground tabular-nums">₹{money(bill.paidAmount)}</dd>
                      <dt className="text-muted-foreground">Balance due</dt>
                      <dd className="text-foreground tabular-nums">
                        {bill.status === 'CANCELLED' ? '—' : `₹${money(bill.balanceAmount)}`}
                      </dd>
                    </dl>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <button
                        onClick={() => setExpanded(open ? null : bill.id)}
                        className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                        aria-expanded={open}
                      >
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {open ? 'Hide lines' : 'Lines'}
                      </button>
                      <ActionMenu label={`Actions for ${bill.billNumber}`} items={actions(bill)} />
                    </div>
                    {open && (
                      <div className="border-border bg-secondary/40 mt-2.5 max-h-[22rem] overflow-y-auto rounded-lg border p-2">
                        <BillItems bill={bill} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Desk: the old ERP's columns. */}
            <div className="list-rows w-full">
              <table className="data-table w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th style={{ width: 30 }} />
                    <th>Date</th>
                    <th>Bill no.</th>
                    <th>Supplier</th>
                    <th className="col-wide">Account</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th style={{ textAlign: 'right' }}>TDS</th>
                    <th className="col-roomy" style={{ textAlign: 'right' }}>
                      Amount Paid
                    </th>
                    <th style={{ textAlign: 'right' }}>Balance Due</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((bill) => {
                    const s = STATUS[bill.status] ?? { label: bill.status, cls: 'badge-neutral' }
                    const open = expanded === bill.id
                    const lines = bill.lines ?? []
                    return (
                      <Fragment key={bill.id}>
                        <tr>
                          <td>
                            <button
                              className="bg-primary/10 text-primary hover:bg-primary/20 flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
                              onClick={() => setExpanded(open ? null : bill.id)}
                              title={open ? 'Hide lines' : 'Show lines'}
                              aria-label={`${open ? 'Hide' : 'Show'} lines on ${bill.billNumber}`}
                              aria-expanded={open}
                            >
                              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </td>
                          <td className="whitespace-nowrap text-xs">
                            {formatDate(bill.supplierInvoiceDate ?? bill.billDate)}
                          </td>
                          <td className="whitespace-nowrap font-mono text-xs">
                            <Link
                              href={`/print/purchase-bill/${bill.id}`}
                              target="_blank"
                              className="text-teal-400 underline-offset-2 hover:underline"
                              title="Open this bill to print or save"
                            >
                              {bill.supplierInvoiceNo || bill.billNumber}
                            </Link>
                            <div className="text-muted-foreground text-[10px]">{bill.billNumber}</div>
                          </td>
                          <td>
                            <div className="text-foreground max-w-[15rem] truncate font-medium">
                              {bill.supplier?.name}
                            </div>
                            {bill.warehouse && (
                              <div className="text-muted-foreground text-[10px]">{bill.warehouse.name}</div>
                            )}
                          </td>
                          <td className="col-wide text-xs">
                            <div className="max-w-[14rem] truncate" title={headsOn(bill).join(', ')}>
                              {headsOn(bill).join(', ') || <span className="text-muted-foreground">—</span>}
                            </div>
                          </td>
                          <td>
                            <span className={s.cls}>{s.label}</span>
                          </td>
                          <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                            ₹{money(bill.totalAmount)}
                          </td>
                          <td className="whitespace-nowrap text-right tabular-nums">
                            ₹{money(bill.tdsAmount)}
                            {bill.tdsSection && (
                              <div className="text-muted-foreground text-[10px]">{bill.tdsSection}</div>
                            )}
                          </td>
                          <td className="col-roomy whitespace-nowrap text-right tabular-nums">
                            ₹{money(bill.paidAmount)}
                          </td>
                          <td className="whitespace-nowrap text-right tabular-nums">
                            {bill.status === 'CANCELLED' ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <>₹{money(bill.balanceAmount)}</>
                            )}
                          </td>
                          <td className="whitespace-nowrap text-right">
                            <div className="flex justify-end">
                              <ActionMenu label={`Actions for ${bill.billNumber}`} items={actions(bill)} />
                            </div>
                          </td>
                        </tr>
                        {open && lines.length > 0 && (
                          <tr>
                            <td colSpan={11} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              <RowPanel
                                icon={FileText}
                                title="Expense Lines"
                                note={`${lines.length} ${lines.length === 1 ? 'line' : 'lines'} on ${bill.billNumber}`}
                              >
                                <BillItems bill={bill} />
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

        {rows.length > 0 && (
          <div className="border-border text-muted-foreground flex flex-wrap justify-end gap-x-5 gap-y-1 border-t px-4 py-2 text-xs tabular-nums">
            <span>
              This page: amount <span className="text-foreground">₹{money(pageTotals.amount)}</span>
            </span>
            <span>
              TDS <span className="text-foreground">₹{money(pageTotals.tds)}</span>
            </span>
            <span>
              paid <span className="text-foreground">₹{money(pageTotals.paid)}</span>
            </span>
            <span>
              due <span className="text-foreground">₹{money(pageTotals.due)}</span>
            </span>
          </div>
        )}

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading || busy} />
      </div>

      <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
        <Wallet size={13} className="mt-px shrink-0" />
        <span>
          The TDS on a bill is kept back from the supplier and paid to the government, so paying the
          balance due settles the bill in full. Rates and limits are in{' '}
          <Link href="/settings/company?tab=tds" className="text-primary underline-offset-2 hover:underline">
            Settings → Company → TDS Sections
          </Link>
          .
        </span>
      </p>

      <PurchaseBillDialog
        open={dialog.open}
        record={dialog.record}
        expense
        cash={dialog.cash}
        onClose={() => setDialog({ open: false, record: null })}
        onSaved={(msg) => {
          if (msg) setMessage(msg)
          void load()
        }}
      />

      {detail && <BillDetailDialog bill={detail} onClose={() => setDetail(null)} />}

      {paying && (
        <RecordPaymentDialog
          bill={{
            id: paying.id,
            billNumber: paying.billNumber,
            supplierInvoiceNo: paying.supplierInvoiceNo,
            balanceAmount: paying.balanceAmount,
            tdsAmount: paying.tdsAmount,
            supplier: { id: paying.supplierId, name: paying.supplier?.name ?? '' },
          }}
          onClose={() => setPaying(null)}
          onSaved={(msg) => {
            setPaying(null)
            setMessage(msg)
            void load()
          }}
        />
      )}

      <PurchaseNoteDialog
        open={Boolean(adjusting)}
        moduleType="OUR_DEBIT_NOTE"
        initialBillId={adjusting?.id ?? null}
        financialOnly
        onClose={() => setAdjusting(null)}
        onSaved={() => void load()}
      />
    </div>
  )
}

export default function ExpensesPage() {
  // useSearchParams needs a Suspense boundary or the route opts out of static rendering.
  return (
    <Suspense fallback={<p className="text-muted-foreground text-sm">Loading...</p>}>
      <ExpensesTable />
    </Suspense>
  )
}
