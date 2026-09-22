'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FileText,
  IndianRupee,
  Paperclip,
  RefreshCw,
  Search,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { RecordPaymentDialog, type PayableBill } from '@/components/purchase/RecordPaymentDialog'
import { BillFilesDialog, billFiles } from '@/components/purchase/BillDetail'
import { FilesCell } from '@/components/tables/FilesCell'
import { RowPanel } from '@/components/tables/RowPanel'
import { formatDate } from '@/lib/utils'

/** A file hanging off an order or a receipt — a bill and a payment hold none of their own. */
interface BillFile {
  id: string
  fileName: string
  mimeType: string | null
  sizeBytes: number
  createdAt: string
}

/**
 * The paper trail behind a bill: the order it was raised from, and the
 * receipts it was matched against — each carrying whatever was scanned onto
 * it. Shared by the outstanding list and the payment history, since both are
 * one hop from the same bill.
 */
interface BillTrail {
  payment?: { paymentNumber: string; attachments?: BillFile[] } | null
  po?: { id: string; poNumber: string; attachments?: BillFile[] } | null
  lines?: Array<{
    id: string
    grnLine?: {
      id: string
      grn: { id: string; grnNumber: string; grnDate: string; attachments?: BillFile[] }
    } | null
  }>
}

interface OutstandingBill extends PayableBill, BillTrail {
  billDate: string
  dueDate?: string | null
  totalAmount: string | number
  paidAmount: string | number
  status: string
  daysOverdue: number
  bucket: string
}

interface Payment {
  id: string
  paymentNumber: string
  paymentDate: string
  amount: string | number
  /** Tax withheld here rather than paid to the supplier. Usually zero. */
  tdsAmount?: string | number | null
  mode: string
  referenceNo?: string | null
  chequeNo?: string | null
  chequeDate?: string | null
  supplier: { id: string; name: string }
  /** Where it was booked. Absent means head office. */
  warehouse?: { id: string; name: string } | null
  /** The account the money left. Absent on a cash payment. */
  bankAccount?: { id: string; accountName: string; bankName: string } | null
  /** The advice, the counterfoil — attached when the payment was recorded. */
  attachments?: BillFile[]
  invoice?: ({ id: string; billNumber: string } & BillTrail) | null
  createdBy?: { id: string; name: string } | null
}

/**
 * Everything behind one payment: the bill's own trail, plus the files that
 * hang off the payment itself. Gathered here so the row's file button opens
 * both instead of pretending the payment's own papers do not exist.
 */
const paymentTrail = (p: Payment): BillTrail => ({
  ...(p.invoice ?? {}),
  payment: { paymentNumber: p.paymentNumber, attachments: p.attachments },
})

interface Summary {
  billCount: number
  totalOutstanding: number
  overdueCount: number
  overdueAmount: number
}

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const MODE_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CHEQUE: 'Cheque',
  NEFT: 'NEFT',
  RTGS: 'RTGS',
  UPI: 'UPI',
  PDC: 'Post-dated cheque',
}

/**
 * The ageing buckets, in the order money comes due.
 *
 * Listed here rather than gathered from the rows on screen: an empty bucket
 * is worth offering — picking "Over 90 days" and getting nothing is an answer,
 * and a dropdown whose options change as the data does cannot be learnt.
 */
const BUCKETS = ['Not yet due', '1-30 days', '31-60 days', '61-90 days', 'Over 90 days'] as const

/** Anything past its date reads red; the rest stays quiet. */
function bucketClass(bucket: string) {
  if (bucket === 'Not yet due') return 'badge-neutral'
  if (bucket === '1-30 days') return 'badge-warning'
  return 'badge-danger'
}

/**
 * The receipts a bill was raised from, without repeats — one bill routinely
 * settles several, and a bill with none behind it was typed by hand.
 */
function grnsOn(trail: BillTrail) {
  const seen = new Map<
    string,
    { id: string; grnNumber: string; grnDate: string; files: BillFile[] }
  >()
  for (const l of trail.lines ?? []) {
    const grn = l.grnLine?.grn
    if (!grn || seen.has(grn.id)) continue
    seen.set(grn.id, {
      id: grn.id,
      grnNumber: grn.grnNumber,
      grnDate: grn.grnDate,
      files: grn.attachments ?? [],
    })
  }
  return [...seen.values()]
}

/** The link is signed and short-lived, so it is fetched at the moment it is wanted. */
async function openFile(id: string, kind: 'order' | 'receipt') {
  try {
    const path = kind === 'order' ? 'attachments' : 'grn-attachments'
    const res = await api.get<{ data: { url: string } }>(`/purchase/${path}/${id}/link`)
    window.open(res.data.url, '_blank', 'noopener')
  } catch {
    // A failed link is not worth a page-level error banner — the file is
    // still there, this click just did not open it.
  }
}

/**
 * What opens under a bill row, on both the outstanding list and the payment
 * history — the receipts it was matched against, and whatever was scanned
 * onto the order or any of them.
 */
function BillTrailPanel({ billNumber, po, lines }: { billNumber: string } & BillTrail) {
  const grns = grnsOn({ lines })
  const orderFiles = po?.attachments ?? []

  return (
    <RowPanel
      icon={FileText}
      title="Receipts & Files"
      note={`${grns.length} ${grns.length === 1 ? 'receipt' : 'receipts'} on ${billNumber}`}
    >
      <>
        {orderFiles.length > 0 && (
          <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs">
            <span className="text-muted-foreground shrink-0">Order {po?.poNumber}:</span>
            {orderFiles.map((f) => (
              <button
                key={f.id}
                type="button"
                className="text-primary inline-flex items-center gap-1 truncate underline"
                onClick={() => void openFile(f.id, 'order')}
                title={`Open ${f.fileName}`}
              >
                <Paperclip size={11} className="shrink-0" />
                {f.fileName}
              </button>
            ))}
          </div>
        )}

        {grns.length === 0 ? (
          <p className="text-muted-foreground px-3 py-3 text-xs">
            Entered by hand — no goods receipt behind this bill.
          </p>
        ) : (
          <table className="subtable w-full table-fixed">
            <thead className="sticky top-0 z-10">
              <tr>
                <th style={{ width: '18%' }}>GRN No.</th>
                <th style={{ width: '18%' }}>Date</th>
                <th>Files</th>
              </tr>
            </thead>
            <tbody>
              {grns.map((g) => (
                <tr key={g.id}>
                  <td className="whitespace-nowrap">
                    <a
                      href={`/print/goods-receipt/${g.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-teal-400 hover:underline"
                      title="Open this receipt's PDF"
                    >
                      {g.grnNumber}
                    </a>
                  </td>
                  <td className="whitespace-nowrap">{formatDate(g.grnDate)}</td>
                  <td>
                    {g.files.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {g.files.map((f) => (
                          <button
                            key={f.id}
                            type="button"
                            className="text-primary inline-flex items-center gap-1 truncate underline"
                            onClick={() => void openFile(f.id, 'receipt')}
                            title={`Open ${f.fileName}`}
                          >
                            <Paperclip size={11} className="shrink-0" />
                            {f.fileName}
                          </button>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    </RowPanel>
  )
}

export default function SupplierPaymentsPage() {
  const [tab, setTab] = useState<'outstanding' | 'history'>('outstanding')
  /** The trail whose files are open, and the number to show them under. */
  const [filesFor, setFilesFor] = useState<{ trail: BillTrail; label: string } | null>(null)

  const [bills, setBills] = useState<OutstandingBill[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [supplierId, setSupplierId] = useState('')
  /** Outstanding tab only — which ageing bucket. */
  const [bucket, setBucket] = useState('')
  /** History tab only — how the money left. */
  const [payMode, setPayMode] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [paying, setPaying] = useState<OutstandingBill | null>(null)
  /** Which row's receipts and files are showing. One at a time, on whichever tab is open. */
  const [expanded, setExpanded] = useState<string | null>(null)

  /**
   * Both lists, every time. The tab badges count what is on each, so a payment
   * nobody has opened the history tab to see still has to be counted — a badge
   * reading nought beside two real payments is a lie about the books.
   */
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [owed, paid] = await Promise.all([
        api.get<{ data: OutstandingBill[]; summary: Summary }>('/purchase/payments/outstanding'),
        api.get<{ data: Payment[] }>('/purchase/payments'),
      ])
      setBills(owed.data)
      setSummary(owed.summary)
      setPayments(paid.data)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing supplier payments.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const term = search.trim().toLowerCase()

  /**
   * Every supplier on either list, not only the tab in front of you.
   *
   * A dropdown that emptied and refilled on each tab would leave the chosen
   * supplier selected but absent from its own options, which renders as blank
   * — the control would look broken at the moment it was working.
   */
  const supplierOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const b of bills) seen.set(b.supplier.id, b.supplier.name)
    for (const p of payments) seen.set(p.supplier.id, p.supplier.name)
    return [...seen]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [bills, payments])

  /**
   * Whether a timestamp falls inside the chosen range.
   *
   * Compared as `yyyy-mm-dd` text rather than as Date objects: that is exactly
   * what a date input holds, the format sorts correctly as a string, and it
   * sidesteps the midnight-boundary bugs that come of building a Date in the
   * browser's timezone from a UTC stamp.
   */
  const inRange = (iso?: string | null) => {
    if (!from && !to) return true
    if (!iso) return false
    const day = iso.slice(0, 10)
    if (from && day < from) return false
    if (to && day > to) return false
    return true
  }

  const filtersOn = Boolean(search || supplierId || bucket || payMode || from || to)
  const clearFilters = () => {
    setSearch('')
    setSupplierId('')
    setBucket('')
    setPayMode('')
    setFrom('')
    setTo('')
  }

  const visibleBills = bills.filter(
    (b) =>
      (!term ||
        b.supplier.name.toLowerCase().includes(term) ||
        b.billNumber.toLowerCase().includes(term) ||
        (b.supplierInvoiceNo ?? '').toLowerCase().includes(term)) &&
      (!supplierId || b.supplier.id === supplierId) &&
      (!bucket || b.bucket === bucket) &&
      inRange(b.billDate)
  )

  const visiblePayments = payments.filter(
    (p) =>
      (!term ||
        p.supplier.name.toLowerCase().includes(term) ||
        p.paymentNumber.toLowerCase().includes(term) ||
        (p.invoice?.billNumber ?? '').toLowerCase().includes(term) ||
        (p.referenceNo ?? '').toLowerCase().includes(term) ||
        (p.chequeNo ?? '').toLowerCase().includes(term)) &&
      (!supplierId || p.supplier.id === supplierId) &&
      (!payMode || p.mode === payMode) &&
      inRange(p.paymentDate)
  )

  return (
    <div className="space-y-5">
      <div className="page-header flex-wrap gap-3">
        <div>
          <h1 className="page-title">Supplier Payments</h1>
          <p className="page-subtitle">What is owed, and what has been paid against it</p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
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

      {tab === 'outstanding' && summary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="glass-card p-3">
            <p className="text-muted-foreground text-xs">Bills outstanding</p>
            <p className="text-foreground mt-1 text-lg font-semibold">{summary.billCount}</p>
          </div>
          <div className="glass-card p-3">
            <p className="text-muted-foreground text-xs">Total outstanding</p>
            <p className="text-foreground mt-1 text-lg font-semibold">
              ₹{money(summary.totalOutstanding)}
            </p>
          </div>
          <div className="glass-card p-3">
            <p className="text-muted-foreground text-xs">Overdue bills</p>
            <p className="mt-1 text-lg font-semibold text-amber-400">{summary.overdueCount}</p>
          </div>
          <div className="glass-card p-3">
            <p className="text-muted-foreground text-xs">Overdue amount</p>
            <p className="mt-1 text-lg font-semibold text-amber-400">
              ₹{money(summary.overdueAmount)}
            </p>
          </div>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-3 py-2">
          <div className="bg-secondary/60 flex shrink-0 gap-1 rounded-lg p-0.5" role="tablist">
            {(
              [
                ['outstanding', 'Outstanding', bills.length],
                ['history', 'Payments made', payments.length],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  tab === key
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
                <span
                  className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${
                    tab === key ? 'bg-primary/20' : 'bg-secondary'
                  }`}
                >
                  {count}
                </span>
              </button>
            ))}
          </div>

          <span className="bg-border hidden h-6 w-px shrink-0 lg:block" />

          {/* A whole line to itself on a phone. Sharing the row with the two
            tab buttons left it 20px wide — narrower than its own magnifying
            glass and padding, so the icon spilled out of its border. The row
            already wraps; it just needed telling to. */}
          <div className="border-border bg-secondary flex min-w-0 shrink grow basis-full items-center gap-2 rounded-lg border px-2.5 py-1.5 sm:min-w-[150px] sm:max-w-[260px] sm:basis-0">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder={
                tab === 'outstanding'
                  ? 'Supplier, our bill number, or theirs...'
                  : 'Supplier, payment number, bill, or reference...'
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search"
            />
          </div>

          <select
            className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-44"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            aria-label="Filter by supplier"
          >
            <option value="">All suppliers</option>
            {supplierOptions.map((sup) => (
              <option key={sup.id} value={sup.id}>
                {sup.name}
              </option>
            ))}
          </select>

          {/* One dropdown, two meanings — an ageing bucket is nothing on the
            history tab, and how the money left is nothing on a bill nobody
            has paid. Rendering both at once would put a permanently useless
            control in front of somebody on every tab. */}
          {tab === 'outstanding' ? (
            <select
              className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-36"
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              aria-label="Filter by ageing"
            >
              <option value="">Any ageing</option>
              {BUCKETS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          ) : (
            <select
              className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-36"
              value={payMode}
              onChange={(e) => setPayMode(e.target.value)}
              aria-label="Filter by how it was paid"
            >
              <option value="">Any way paid</option>
              {Object.entries(MODE_LABEL).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          )}

          {/* A line of its own on a phone: two date boxes and the words either
            side of them do not share a row with a search box at 360px. */}
          <div className="flex w-full min-w-0 shrink-0 items-center gap-1.5 sm:w-auto">
            <span className="text-muted-foreground shrink-0 text-xs">
              {tab === 'outstanding' ? 'Billed' : 'Paid'}
            </span>
            <input
              type="date"
              className="form-input h-8 min-w-0 flex-1 py-0 text-xs sm:w-[8.5rem] sm:flex-none"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              aria-label={tab === 'outstanding' ? 'Billed on or after' : 'Paid on or after'}
            />
            <span className="text-muted-foreground shrink-0 text-xs">to</span>
            <input
              type="date"
              className="form-input h-8 min-w-0 flex-1 py-0 text-xs sm:w-[8.5rem] sm:flex-none"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              aria-label={tab === 'outstanding' ? 'Billed on or before' : 'Paid on or before'}
            />
          </div>

          {filtersOn && (
            <button className="btn-ghost h-8 shrink-0 px-2 text-xs" onClick={clearFilters}>
              Clear
            </button>
          )}

          <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
            {tab === 'outstanding'
              ? `${visibleBills.length} ${visibleBills.length === 1 ? 'bill' : 'bills'}`
              : `${visiblePayments.length} ${visiblePayments.length === 1 ? 'payment' : 'payments'}`}
          </span>
        </div>

        {loading ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : tab === 'outstanding' ? (
          visibleBills.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <IndianRupee size={22} className="text-muted-foreground mx-auto" />
              <p className="text-foreground mt-2 text-sm font-medium">
                {bills.length === 0 ? 'Nothing is outstanding' : 'Nothing matches that'}
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                {bills.length === 0
                  ? 'Every purchase bill on the system is paid in full.'
                  : 'Clear the filters to see every bill that is still owed.'}
              </p>
            </div>
          ) : (
            <div className="list-scope">
              <div className="list-cards divide-border divide-y">
                {visibleBills.map((b) => {
                  const grns = grnsOn(b)
                  const bOpen = expanded === b.id
                  return (
                    <div key={b.id} className="p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-foreground font-medium leading-snug">
                            {b.supplier.name}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <a
                              href={`/print/purchase-bill/${b.id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono text-xs text-teal-400 underline-offset-2 hover:underline"
                              title="Open this bill to print or save"
                            >
                              {b.billNumber}
                            </a>
                            <span className={bucketClass(b.bucket)}>
                              {b.bucket}
                              {b.daysOverdue > 0 ? ` · ${b.daysOverdue}d` : ''}
                            </span>
                          </div>
                          {b.supplierInvoiceNo && (
                            <p className="text-muted-foreground mt-0.5 text-[10px]">
                              Theirs: {b.supplierInvoiceNo}
                            </p>
                          )}
                        </div>
                        <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">
                          ₹{money(b.balanceAmount)}
                        </span>
                      </div>

                      <dl className="mt-2.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                        <dt className="text-muted-foreground">PO</dt>
                        <dd className="text-foreground min-w-0">
                          {b.po ? (
                            <a
                              href={`/print/purchase-order/${b.po.id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono text-teal-400 underline-offset-2 hover:underline"
                              title="Open this order to print or save"
                            >
                              {b.po.poNumber}
                            </a>
                          ) : (
                            <span
                              className="text-muted-foreground"
                              title="Typed by hand, or it gathers receipts from more than one order"
                            >
                              Not one order
                            </span>
                          )}
                        </dd>
                        <dt className="text-muted-foreground">Due</dt>
                        <dd className="text-foreground min-w-0">
                          {b.dueDate ? (
                            formatDate(b.dueDate)
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </dd>
                        <dt className="text-muted-foreground">Bill total</dt>
                        <dd className="text-foreground min-w-0 tabular-nums">
                          ₹{money(b.totalAmount)}
                        </dd>
                        <dt className="text-muted-foreground">Paid</dt>
                        <dd className="text-foreground min-w-0 tabular-nums">
                          ₹{money(b.paidAmount)}
                        </dd>
                      </dl>

                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <button
                          onClick={() => setExpanded(bOpen ? null : b.id)}
                          disabled={grns.length === 0 && !b.po?.attachments?.length}
                          className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                            grns.length === 0 && !b.po?.attachments?.length
                              ? 'text-muted-foreground cursor-not-allowed opacity-50'
                              : 'bg-primary/10 text-primary hover:bg-primary/20'
                          }`}
                          aria-expanded={bOpen}
                        >
                          {bOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {bOpen ? 'Hide receipts' : 'Receipts & files'}
                        </button>
                        <button
                          type="button"
                          className="btn-primary h-7 px-2.5 text-xs"
                          onClick={() => setPaying(b)}
                        >
                          Pay
                        </button>
                      </div>

                      {bOpen && (
                        <div className="mt-2.5">
                          <BillTrailPanel billNumber={b.billNumber} po={b.po} lines={b.lines} />
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
                      <th style={{ width: 30 }} />
                      <th>Supplier</th>
                      <th>Bill</th>
                      <th className="col-full">PO</th>
                      <th className="col-roomy">Due</th>
                      <th className="col-wide" style={{ textAlign: 'right' }}>
                        Bill total
                      </th>
                      <th className="col-wide" style={{ textAlign: 'right' }}>
                        Paid
                      </th>
                      <th style={{ textAlign: 'right' }}>Outstanding</th>
                      <th>Ageing</th>
                      <th className="col-roomy">Files</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleBills.map((b) => {
                      const grns = grnsOn(b)
                      const bOpen = expanded === b.id
                      const canExpand = grns.length > 0 || Boolean(b.po?.attachments?.length)
                      return (
                        <Fragment key={b.id}>
                          <tr>
                            <td>
                              <button
                                className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                                  !canExpand
                                    ? 'text-muted-foreground cursor-not-allowed opacity-50'
                                    : 'bg-primary/10 text-primary hover:bg-primary/20'
                                }`}
                                onClick={() => setExpanded(bOpen ? null : b.id)}
                                disabled={!canExpand}
                                title={bOpen ? 'Hide receipts' : 'Show receipts and files'}
                                aria-label={`${bOpen ? 'Hide' : 'Show'} receipts on ${b.billNumber}`}
                                aria-expanded={bOpen}
                              >
                                {bOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                            </td>
                            <td>
                              <div className="text-foreground max-w-[14rem] truncate">
                                {b.supplier.name}
                              </div>
                            </td>
                            <td className="whitespace-nowrap">
                              <a
                                href={`/print/purchase-bill/${b.id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono text-xs text-teal-400 hover:underline"
                                title="Open this bill to print or save"
                              >
                                {b.billNumber}
                              </a>
                              {b.supplierInvoiceNo && (
                                <div className="text-muted-foreground text-[10px]">
                                  Theirs: {b.supplierInvoiceNo}
                                </div>
                              )}
                            </td>
                            <td className="col-full whitespace-nowrap text-xs">
                              {b.po ? (
                                <a
                                  href={`/print/purchase-order/${b.po.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="font-mono text-teal-400 hover:underline"
                                  title="Open this order to print or save"
                                >
                                  {b.po.poNumber}
                                </a>
                              ) : (
                                <span
                                  className="text-muted-foreground"
                                  title="Typed by hand, or it gathers receipts from more than one order"
                                >
                                  Not one order
                                </span>
                              )}
                            </td>
                            <td className="col-roomy text-xs">
                              {b.dueDate ? (
                                formatDate(b.dueDate)
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="col-wide text-right tabular-nums">
                              ₹{money(b.totalAmount)}
                            </td>
                            <td className="col-wide text-right tabular-nums">
                              ₹{money(b.paidAmount)}
                            </td>
                            <td className="text-foreground text-right font-medium tabular-nums">
                              ₹{money(b.balanceAmount)}
                            </td>
                            <td>
                              <span className={bucketClass(b.bucket)}>
                                {b.bucket}
                                {b.daysOverdue > 0 ? ` · ${b.daysOverdue}d` : ''}
                              </span>
                            </td>
                            <td className="col-roomy whitespace-nowrap">
                              <FilesCell
                                count={billFiles(b).length}
                                onOpen={() => setFilesFor({ trail: b, label: b.billNumber })}
                                what="on this bill's order and receipts"
                              />
                            </td>
                            <td className="whitespace-nowrap text-right">
                              <button
                                type="button"
                                className="btn-primary h-7 px-2.5 text-xs"
                                onClick={() => setPaying(b)}
                              >
                                Pay
                              </button>
                            </td>
                          </tr>
                          {bOpen && canExpand && (
                            <tr>
                              <td colSpan={11} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                                <BillTrailPanel
                                  billNumber={b.billNumber}
                                  po={b.po}
                                  lines={b.lines}
                                />
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
          )
        ) : visiblePayments.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <IndianRupee size={22} className="text-muted-foreground mx-auto" />
            <p className="text-foreground mt-2 text-sm font-medium">
              {payments.length === 0 ? 'No payments yet' : 'Nothing matches that'}
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {payments.length === 0
                ? 'Payments recorded against a purchase bill will appear here.'
                : 'Clear the filters to see every payment made.'}
            </p>
          </div>
        ) : (
          <div className="list-scope">
            <div className="list-cards divide-border divide-y">
              {visiblePayments.map((p) => {
                const grns = p.invoice ? grnsOn(p.invoice) : []
                const canExpand = grns.length > 0 || Boolean(p.invoice?.po?.attachments?.length)
                const pOpen = expanded === p.id
                return (
                  <div key={p.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <span className="text-foreground font-mono text-xs font-semibold">
                          {p.paymentNumber}
                        </span>
                        <p className="text-foreground mt-1 font-medium leading-snug">
                          {p.supplier.name}
                        </p>
                      </div>
                      <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">
                        ₹{money(p.amount)}
                      </span>
                    </div>

                    <dl className="mt-2.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Date</dt>
                      <dd className="text-foreground min-w-0">{formatDate(p.paymentDate)}</dd>
                      <dt className="text-muted-foreground">Against</dt>
                      <dd className="text-foreground min-w-0">
                        {p.invoice ? (
                          <a
                            href={`/print/purchase-bill/${p.invoice.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-teal-400 underline-offset-2 hover:underline"
                            title="Open this bill to print or save"
                          >
                            {p.invoice.billNumber}
                          </a>
                        ) : (
                          '—'
                        )}
                      </dd>
                      <dt className="text-muted-foreground">PO</dt>
                      <dd className="text-foreground min-w-0">
                        {p.invoice?.po ? (
                          <a
                            href={`/print/purchase-order/${p.invoice.po.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-teal-400 underline-offset-2 hover:underline"
                            title="Open this order to print or save"
                          >
                            {p.invoice.po.poNumber}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">
                            {p.invoice ? 'Not one order' : '—'}
                          </span>
                        )}
                      </dd>
                      <dt className="text-muted-foreground">How</dt>
                      <dd className="text-foreground min-w-0">
                        {MODE_LABEL[p.mode] ?? p.mode}
                        {(p.chequeNo || p.referenceNo) && (
                          <span className="text-muted-foreground">
                            {' '}
                            · {p.chequeNo || p.referenceNo}
                          </span>
                        )}
                      </dd>
                      <dt className="text-muted-foreground">Paid from</dt>
                      <dd className="text-foreground min-w-0">
                        {p.bankAccount ? (
                          p.bankAccount.accountName
                        ) : (
                          <span className="text-muted-foreground">
                            {p.mode === 'CASH' ? 'Cash in hand' : '—'}
                          </span>
                        )}
                      </dd>
                      {Number(p.tdsAmount ?? 0) > 0 && (
                        <>
                          <dt className="text-muted-foreground">Tax deducted</dt>
                          <dd className="text-foreground min-w-0 tabular-nums">
                            ₹{money(p.tdsAmount ?? 0)}
                          </dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">Recorded by</dt>
                      <dd className="text-foreground min-w-0">{p.createdBy?.name ?? '—'}</dd>
                    </dl>

                    {canExpand && (
                      <div className="mt-3">
                        <button
                          onClick={() => setExpanded(pOpen ? null : p.id)}
                          className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                          aria-expanded={pOpen}
                        >
                          {pOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {pOpen ? 'Hide receipts' : 'Receipts & files'}
                        </button>
                        {pOpen && p.invoice && (
                          <div className="mt-2.5">
                            <BillTrailPanel
                              billNumber={p.invoice.billNumber}
                              po={p.invoice.po}
                              lines={p.invoice.lines}
                            />
                          </div>
                        )}
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
                    <th style={{ width: 30 }} />
                    <th>Payment</th>
                    <th>Date</th>
                    <th>Supplier</th>
                    <th className="col-roomy">Against</th>
                    <th className="col-full">PO</th>
                    <th className="col-wide">How</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th className="col-full">Recorded by</th>
                    <th className="col-roomy">Files</th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePayments.map((p) => {
                    const grns = p.invoice ? grnsOn(p.invoice) : []
                    const canExpand = grns.length > 0 || Boolean(p.invoice?.po?.attachments?.length)
                    const pOpen = expanded === p.id
                    return (
                      <Fragment key={p.id}>
                        <tr>
                          <td>
                            <button
                              className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                                !canExpand
                                  ? 'text-muted-foreground cursor-not-allowed opacity-50'
                                  : 'bg-primary/10 text-primary hover:bg-primary/20'
                              }`}
                              onClick={() => setExpanded(pOpen ? null : p.id)}
                              disabled={!canExpand}
                              title={pOpen ? 'Hide receipts' : 'Show receipts and files'}
                              aria-label={`${pOpen ? 'Hide' : 'Show'} receipts on ${p.paymentNumber}`}
                              aria-expanded={pOpen}
                            >
                              {pOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </td>
                          <td className="font-mono text-xs text-teal-400">{p.paymentNumber}</td>
                          <td className="text-xs">{formatDate(p.paymentDate)}</td>
                          <td>
                            <div className="text-foreground max-w-[14rem] truncate">
                              {p.supplier.name}
                            </div>
                          </td>
                          <td className="col-roomy text-xs">
                            {p.invoice ? (
                              <a
                                href={`/print/purchase-bill/${p.invoice.id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono text-teal-400 hover:underline"
                                title="Open this bill to print or save"
                              >
                                {p.invoice.billNumber}
                              </a>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="col-full whitespace-nowrap text-xs">
                            {p.invoice?.po ? (
                              <a
                                href={`/print/purchase-order/${p.invoice.po.id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono text-teal-400 hover:underline"
                                title="Open this order to print or save"
                              >
                                {p.invoice.po.poNumber}
                              </a>
                            ) : (
                              <span className="text-muted-foreground">
                                {p.invoice ? 'Not one order' : '—'}
                              </span>
                            )}
                          </td>
                          <td className="col-wide">
                            <span className="text-foreground text-xs">
                              {MODE_LABEL[p.mode] ?? p.mode}
                            </span>
                            {/* One line, not three: the reference and the
                              account are what a query about a payment starts
                              from, and a third line would set this row taller
                              than every other on the list. */}
                            {(p.chequeNo || p.referenceNo || p.bankAccount) && (
                              <div className="text-muted-foreground text-[10px]">
                                {[
                                  p.chequeNo || p.referenceNo,
                                  p.bankAccount?.accountName,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </div>
                            )}
                          </td>
                          <td className="text-foreground text-right font-medium tabular-nums">
                            ₹{money(p.amount)}
                            {Number(p.tdsAmount ?? 0) > 0 && (
                              <div className="text-muted-foreground text-[10px] font-normal">
                                +₹{money(p.tdsAmount ?? 0)} tax
                              </div>
                            )}
                          </td>
                          <td className="col-full text-xs">{p.createdBy?.name ?? '—'}</td>
                          <td className="col-roomy whitespace-nowrap">
                            {/* The payment's own papers count here too —
                              the advice and the counterfoil were attached to
                              this payment, and a file button that ignored
                              them would say a payment with three scans on it
                              had none. */}
                            <FilesCell
                              count={billFiles(paymentTrail(p)).length}
                              onOpen={() =>
                                setFilesFor({
                                  trail: paymentTrail(p),
                                  label: p.invoice?.billNumber ?? p.paymentNumber,
                                })
                              }
                              what="on this payment, and on its bill's order and receipts"
                            />
                          </td>
                        </tr>
                        {pOpen && canExpand && p.invoice && (
                          <tr>
                            <td colSpan={10} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              <BillTrailPanel
                                billNumber={p.invoice.billNumber}
                                po={p.invoice.po}
                                lines={p.invoice.lines}
                              />
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
      </div>

      {filesFor && (
        <BillFilesDialog
          trail={filesFor.trail}
          label={filesFor.label}
          onClose={() => setFilesFor(null)}
        />
      )}

      {paying && (
        <RecordPaymentDialog
          bill={paying}
          onClose={() => setPaying(null)}
          onSaved={(msg) => {
            setPaying(null)
            setMessage(msg)
            void load()
          }}
        />
      )}
    </div>
  )
}
