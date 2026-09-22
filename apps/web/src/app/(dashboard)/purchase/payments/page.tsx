'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
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
  mode: string
  referenceNo?: string | null
  chequeDate?: string | null
  supplier: { id: string; name: string }
  invoice?: ({ id: string; billNumber: string } & BillTrail) | null
  createdBy?: { id: string; name: string } | null
}

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
  const [paying, setPaying] = useState<OutstandingBill | null>(null)
  /** Which row's receipts and files are showing. One at a time, on whichever tab is open. */
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'outstanding') {
        const res = await api.get<{ data: OutstandingBill[]; summary: Summary }>(
          '/purchase/payments/outstanding'
        )
        setBills(res.data)
        setSummary(res.summary)
      } else {
        const res = await api.get<{ data: Payment[] }>('/purchase/payments')
        setPayments(res.data)
      }
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
  }, [tab])

  useEffect(() => {
    void load()
  }, [load])

  const term = search.trim().toLowerCase()
  const visibleBills = term
    ? bills.filter(
        (b) =>
          b.supplier.name.toLowerCase().includes(term) ||
          b.billNumber.toLowerCase().includes(term) ||
          (b.supplierInvoiceNo ?? '').toLowerCase().includes(term)
      )
    : bills
  const visiblePayments = term
    ? payments.filter(
        (p) =>
          p.supplier.name.toLowerCase().includes(term) ||
          p.paymentNumber.toLowerCase().includes(term) ||
          (p.invoice?.billNumber ?? '').toLowerCase().includes(term) ||
          (p.referenceNo ?? '').toLowerCase().includes(term)
      )
    : payments

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
                  : 'Try a different supplier or bill number.'}
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
                : 'Try a different supplier, bill, or reference.'}
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
                        {p.referenceNo && (
                          <span className="text-muted-foreground"> · {p.referenceNo}</span>
                        )}
                      </dd>
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
                            {p.referenceNo && (
                              <div className="text-muted-foreground text-[10px]">
                                {p.referenceNo}
                              </div>
                            )}
                          </td>
                          <td className="text-foreground text-right font-medium tabular-nums">
                            ₹{money(p.amount)}
                          </td>
                          <td className="col-full text-xs">{p.createdBy?.name ?? '—'}</td>
                          <td className="col-roomy whitespace-nowrap">
                            <FilesCell
                              count={p.invoice ? billFiles(p.invoice).length : 0}
                              onOpen={() =>
                                p.invoice &&
                                setFilesFor({
                                  trail: p.invoice,
                                  label: p.invoice.billNumber,
                                })
                              }
                              what="on this bill's order and receipts"
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
