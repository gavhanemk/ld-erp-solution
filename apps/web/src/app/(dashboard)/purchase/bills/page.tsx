'use client'

import { Fragment, Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Plus,
  Pencil,
  Printer,
  Search,
  RefreshCw,
  AlertCircle,
  Ban,
  ChevronDown,
  ChevronRight,
  Eye,
  Paperclip,
} from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { PurchaseBillDialog, type PurchaseBill } from '@/components/purchase/PurchaseBillDialog'
import { BillItems, BillDetailDialog } from '@/components/purchase/BillDetail'
import { Pagination } from '@/components/tables/Pagination'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate } from '@/lib/utils'

const STATUS: Record<string, { label: string; cls: string }> = {
  UNPAID: { label: 'Unpaid', cls: 'badge-warning' },
  PARTIAL: { label: 'Part paid', cls: 'badge-info' },
  PAID: { label: 'Paid', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * The goods receipts a bill was raised from, without repeats.
 *
 * One bill routinely settles several — a supplier ships through the week and
 * invoices once — so this is a list, not a field. A bill with none behind it
 * was typed by hand, which is legitimate for a service or a transporter.
 */
const receiptsOn = (bill: PurchaseBill): string[] => [
  ...new Set(
    (bill.lines ?? [])
      .map((l) => l.grnLine?.grn?.grnNumber)
      .filter((n): n is string => Boolean(n))
  ),
]

/**
 * How many files sit behind a bill, counting the order's and each receipt's.
 *
 * A bill holds no files of its own — the quotation is on the order and the
 * challan on the receipt — so this counts by id across both, or a receipt
 * reached through two lines would be counted twice.
 */
const fileCountOn = (bill: PurchaseBill): number => {
  const ids = new Set<string>()
  for (const f of bill.po?.attachments ?? []) ids.add(f.id)
  for (const l of bill.lines ?? []) {
    for (const f of l.grnLine?.grn?.attachments ?? []) ids.add(f.id)
  }
  return ids.size
}

function PurchaseBillsTable() {
  const { rowsPerPage } = useAppSettings()

  const [rows, setRows] = useState<PurchaseBill[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<{ open: boolean; record: PurchaseBill | null }>({
    open: false,
    record: null,
  })
  /** The one bill whose items are showing. One at a time, so the list stays a list. */
  const [expanded, setExpanded] = useState<string | null>(null)
  /** The bill open in the full detail window, and where to land in it. */
  const [detail, setDetail] = useState<{
    bill: PurchaseBill
    focus?: 'attachments'
  } | null>(null)

  /*
   * Arriving from "Book a bill for this" on a goods receipt.
   *
   * The receipt's id travels in the address rather than in shared state so the
   * link is an ordinary link — it survives a new tab, a refresh and the back
   * button, none of which a click handler would.
   */
  const router = useRouter()
  const searchParams = useSearchParams()
  const fromGrn = searchParams.get('fromGrn')

  useEffect(() => {
    if (fromGrn) setDialog({ open: true, record: null })
  }, [fromGrn])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(rowsPerPage) })
      if (debounced) qs.set('q', debounced)
      if (status) qs.set('status', status)
      if (overdueOnly) qs.set('overdue', 'true')
      const res = await api.get<Paginated<PurchaseBill>>(`/purchase/bills?${qs}`)
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing purchase bills.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [debounced, status, overdueOnly, page, rowsPerPage])

  useEffect(() => {
    void load()
  }, [load])

  // Narrowing a filter while on page 3 would show an empty page 3 of a shorter
  // list, which reads as "nothing found" rather than "you moved".
  useEffect(() => {
    setPage(1)
  }, [debounced, status, overdueOnly])

  const cancel = async (bill: PurchaseBill) => {
    const reason = prompt(
      `Cancel ${bill.billNumber}?\n\nThe bill and its number stay on the record. Say why:`
    )
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
      setError(err instanceof ApiError ? err.message : 'Could not cancel that bill.')
    } finally {
      setBusy(false)
    }
  }

  const pages = Math.ceil(total / rowsPerPage) || 1

  const isOverdue = (b: PurchaseBill) =>
    b.dueDate != null &&
    new Date(b.dueDate) < new Date() &&
    (b.status === 'UNPAID' || b.status === 'PARTIAL')

  return (
    <div className="space-y-5">
      <div className="page-header flex-wrap gap-3">
        <div>
          <h1 className="page-title">Purchase Bills</h1>
          <p className="page-subtitle">
            What your suppliers have charged you, and what is still owed
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-primary" onClick={() => setDialog({ open: true, record: null })}>
            <Plus size={15} /> Book Bill
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
        <div className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <div className="bg-secondary border-border flex w-full min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 py-2 sm:w-auto sm:min-w-[220px] sm:max-w-sm">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Search our number, theirs, or supplier..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search purchase bills"
            />
          </div>
          <select
            className="form-input h-9 w-full sm:w-40"
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
          </select>
          <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(e) => setOverdueOnly(e.target.checked)}
            />
            Overdue only
          </label>
          <span className="text-muted-foreground ml-auto text-xs">{total} bills</span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              {debounced || status || overdueOnly
                ? 'No bills match what you are looking for. Clear the filters to see them all.'
                : 'No supplier bills booked yet. Book one to record what a supplier has charged you — start from a goods receipt and it fills itself in.'}
            </p>
          </div>
        ) : (
          <>
            {/* ── On a phone, not a table ──────────────────────────────────

              Same reasoning as the purchase order list: 9 columns cannot be
              made to fit a phone, and a table you drag sideways costs two
              gestures for every read and keeps the buttons off whichever edge
              you are not looking at. Below xl each row is a block instead.

              xl and not lg, because lg is where the sidebar comes back and
              takes 260px of the screen with it. */}
            <div className="divide-border divide-y xl:hidden">
              {rows.map((bill) => {
                const s = STATUS[bill.status] ?? { label: bill.status, cls: 'badge-neutral' }
                const overdue =
                  bill.dueDate &&
                  bill.status !== 'PAID' &&
                  bill.status !== 'CANCELLED' &&
                  new Date(bill.dueDate) < new Date()
                return (
                  <div key={bill.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/print/purchase-bill/${bill.id}`}
                            target="_blank"
                            className="font-mono text-xs font-semibold text-teal-400 underline-offset-2 hover:underline"
                            title="Open this bill to print or save"
                          >
                            {bill.supplierInvoiceNo || bill.billNumber}
                          </Link>
                          <span className="text-muted-foreground font-mono text-[10px]">
                            {bill.billNumber}
                          </span>
                          <span className={s.cls}>{s.label}</span>
                          {bill.isReverseCharge && <span className="badge-purple">RCM</span>}
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">
                          {bill.supplier?.name ?? '—'}
                        </p>
                        {bill.supplier?.gstin && (
                          <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">
                            {bill.supplier.gstin}
                          </p>
                        )}
                      </div>
                      <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">
                        ₹{money(bill.totalAmount)}
                      </span>
                    </div>

                    <dl className="mt-2.5 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Their invoice</dt>
                      <dd className="text-foreground min-w-0">
                        {bill.supplierInvoiceNo ? (
                          <>
                            <span className="font-mono">{bill.supplierInvoiceNo}</span>
                            {bill.supplierInvoiceDate && (
                              <span className="text-muted-foreground">
                                {' '}
                                · {formatDate(bill.supplierInvoiceDate)}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </dd>
                      <dt className="text-muted-foreground">Against</dt>
                      <dd className="text-foreground min-w-0">
                        {receiptsOn(bill).length ? (
                          <span className="font-mono">{receiptsOn(bill).join(', ')}</span>
                        ) : (
                          <span className="text-muted-foreground">Direct</span>
                        )}
                        {fileCountOn(bill) > 0 && (
                          <span className="text-muted-foreground ml-1.5 inline-flex items-center gap-0.5">
                            <Paperclip size={10} />
                            {fileCountOn(bill)}
                          </span>
                        )}
                      </dd>
                      <dt className="text-muted-foreground">Booked</dt>
                      <dd className="text-foreground min-w-0">{formatDate(bill.billDate)}</dd>
                      <dt className="text-muted-foreground">Due</dt>
                      <dd className="min-w-0">
                        {bill.dueDate ? (
                          <span
                            className={overdue ? 'font-medium text-red-400' : 'text-foreground'}
                          >
                            {formatDate(bill.dueDate)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </dd>
                      <dt className="text-muted-foreground">Outstanding</dt>
                      <dd className="text-foreground min-w-0 tabular-nums">
                        {bill.status === 'CANCELLED' ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>₹{money(bill.balanceAmount)}</>
                        )}
                      </dd>
                    </dl>

                    <div className="mt-3 flex justify-end gap-1">
                      <button
                        className="btn-ghost border-border rounded-lg border p-1.5"
                        onClick={() => setDetail({ bill })}
                        title="View full detail"
                        aria-label={`View details of ${bill.billNumber}`}
                      >
                        <Eye size={15} />
                      </button>
                      <Link
                        href={`/print/purchase-bill/${bill.id}`}
                        target="_blank"
                        className="btn-ghost border-border rounded-lg border p-1.5"
                        title="Print"
                        aria-label={`Print ${bill.billNumber}`}
                      >
                        <Printer size={15} />
                      </Link>
                      {bill.status !== 'CANCELLED' && Number(bill.paidAmount) === 0 && (
                        <>
                          <button
                            className="btn-ghost border-border rounded-lg border p-1.5"
                            onClick={() => setDialog({ open: true, record: bill })}
                            title="Edit"
                            aria-label={`Edit ${bill.billNumber}`}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            className="btn-ghost border-border text-muted-foreground rounded-lg border p-1.5 hover:text-red-400"
                            onClick={() => void cancel(bill)}
                            disabled={busy}
                            title="Cancel"
                            aria-label={`Cancel ${bill.billNumber}`}
                          >
                            <Ban size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="hidden w-full overflow-x-auto xl:block">
              {/* A floor, so the nine columns scroll rather than squash. With no
              minimum they squeeze to fit whatever they are given, and on a
              narrow screen the supplier and the invoice number end up two
              characters wide over four lines. 900px is under the 1058px a
              1366px laptop has to give, so the commonest screen still shows
              the whole table without scrolling. */}
              <table className="data-table w-full min-w-[1020px]">
                <thead>
                  <tr>
                    {/* The supplier's own number leads, because that is the one
                      both sides quote. Ours is the book reference beside it —
                      the old ERP printed one value in both places and lost the
                      distinction entirely. */}
                    <th>Bill no.</th>
                    <th>Our ref</th>
                    {/* The receipts this bill settles. The old ERP called it
                      Reference# and put a GRN number in it, because that is
                      what the accounts team reconciles against — the bill's
                      own number means nothing to the store. */}
                    <th>Against receipt</th>
                    <th>Supplier</th>
                    <th>Booked</th>
                    <th>Due</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th style={{ textAlign: 'right' }}>Outstanding</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((bill) => {
                    const s = STATUS[bill.status] ?? { label: bill.status, cls: 'badge-neutral' }
                    const overdue = isOverdue(bill)
                    const open = expanded === bill.id
                    return (
                      <Fragment key={bill.id}>
                      <tr
                        className="cursor-pointer"
                        onClick={() => setExpanded(open ? null : bill.id)}
                      >
                        <td className="font-mono text-xs">
                          <span className="inline-flex items-center gap-1">
                            <span className="text-muted-foreground">
                              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </span>
                            {/* The number opens the printable bill, the way the
                              old ERP's invoice number did. The rest of the row
                              still expands to the items. */}
                            <Link
                              href={`/print/purchase-bill/${bill.id}`}
                              target="_blank"
                              className="text-teal-400 underline-offset-2 hover:underline"
                              onClick={(e) => e.stopPropagation()}
                              title="Open this bill to print or save"
                            >
                              {bill.supplierInvoiceNo || bill.billNumber}
                            </Link>
                          </span>
                          {bill.supplierInvoiceDate && (
                            <div className="text-muted-foreground pl-[18px] text-[10px]">
                              {formatDate(bill.supplierInvoiceDate)}
                            </div>
                          )}
                        </td>
                        <td className="text-muted-foreground font-mono text-xs">
                          {bill.billNumber}
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            {receiptsOn(bill).length ? (
                              <span className="text-foreground font-mono text-xs">
                                {receiptsOn(bill).join(', ')}
                              </span>
                            ) : (
                              <span
                                className="text-muted-foreground"
                                title="Entered by hand — a service or transport bill with no goods receipt behind it"
                              >
                                Direct
                              </span>
                            )}
                            {fileCountOn(bill) > 0 && (
                              // A paperclip that cannot be pressed is a tease.
                              // It opens the detail window at its attachments,
                              // which is where the files are listed and signed.
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-0.5 text-[10px] transition"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setDetail({ bill, focus: 'attachments' })
                                }}
                                title={`Open the ${fileCountOn(bill)} file${
                                  fileCountOn(bill) === 1 ? '' : 's'
                                } on this bill's order and receipts`}
                              >
                                <Paperclip size={11} />
                                {fileCountOn(bill)}
                              </button>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="text-foreground font-medium">{bill.supplier?.name}</div>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            {bill.supplier?.gstin && (
                              <span className="text-muted-foreground font-mono text-[10px]">
                                {bill.supplier.gstin}
                              </span>
                            )}
                            {bill.isReverseCharge && <span className="badge-purple">RCM</span>}
                          </div>
                        </td>
                        <td className="text-xs">{formatDate(bill.billDate)}</td>
                        <td className="text-xs">
                          {bill.dueDate ? (
                            <span className={overdue ? 'font-medium text-red-400' : undefined}>
                              {formatDate(bill.dueDate)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="text-right font-semibold tabular-nums">
                          ₹{money(bill.totalAmount)}
                        </td>
                        <td className="text-right tabular-nums">
                          {bill.status === 'CANCELLED' ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <>
                              ₹{money(bill.balanceAmount)}
                              {Number(bill.tdsAmount) > 0 && (
                                <div className="text-muted-foreground text-[10px]">
                                  after ₹{money(bill.tdsAmount)} TDS
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td>
                          <span className={s.cls}>{s.label}</span>
                        </td>
                        <td className="whitespace-nowrap text-right">
                          {/* The row opens the detail panel; these do their own
                            jobs and must not also open it. */}
                          <div
                            className="flex justify-end gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              className="btn-ghost p-1.5"
                              onClick={() => setDetail({ bill })}
                              title="View full detail"
                              aria-label={`View details of ${bill.billNumber}`}
                            >
                              <Eye size={15} />
                            </button>
                            <Link
                              href={`/print/purchase-bill/${bill.id}`}
                              target="_blank"
                              className="btn-ghost p-1.5"
                              title="Print"
                              aria-label={`Print ${bill.billNumber}`}
                            >
                              <Printer size={15} />
                            </Link>
                            {bill.status !== 'CANCELLED' && Number(bill.paidAmount) === 0 && (
                              <>
                                <button
                                  className="btn-ghost p-1.5"
                                  onClick={() => setDialog({ open: true, record: bill })}
                                  title="Edit"
                                  aria-label={`Edit ${bill.billNumber}`}
                                >
                                  <Pencil size={15} />
                                </button>
                                <button
                                  className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400"
                                  onClick={() => void cancel(bill)}
                                  disabled={busy}
                                  title="Cancel"
                                  aria-label={`Cancel ${bill.billNumber}`}
                                >
                                  <Ban size={15} />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          {/* The panel spans the table rather than sitting in a
                            cell, so its own columns are free of the list's. */}
                          <td colSpan={9} className="p-0">
                            <BillItems bill={bill} />
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />
      </div>

      <p className="text-muted-foreground text-xs">
        A bill can be changed until a payment is made against it. After that it is part of the
        payment record — cancel it, or raise a debit note. A bill for more than was accepted at the
        gate is refused, which is the whole point of booking it against the receipt.
      </p>

      <PurchaseBillDialog
        open={dialog.open}
        record={dialog.record}
        initialGrnId={fromGrn}
        onClose={() => {
          setDialog({ open: false, record: null })
          // The receipt has been dealt with one way or another; leaving it in
          // the address would reopen the form on the next visit to this page.
          if (fromGrn) router.replace('/purchase/bills')
        }}
        onSaved={() => void load()}
      />

      {detail && (
        <BillDetailDialog
          bill={detail.bill}
          focus={detail.focus}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}

export default function PurchaseBillsPage() {
  // useSearchParams needs a Suspense boundary or the whole route opts out of
  // static rendering and Next refuses to build.
  return (
    <Suspense fallback={<p className="text-muted-foreground text-sm">Loading...</p>}>
      <PurchaseBillsTable />
    </Suspense>
  )
}
