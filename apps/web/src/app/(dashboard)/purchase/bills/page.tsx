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
  FileText,
} from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { PurchaseBillDialog, type PurchaseBill } from '@/components/purchase/PurchaseBillDialog'
import { BillItems, BillDetailDialog, BillFilesDialog } from '@/components/purchase/BillDetail'
import { Pagination } from '@/components/tables/Pagination'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { FilesCell } from '@/components/tables/FilesCell'
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
    (bill.lines ?? []).map((l) => l.grnLine?.grn?.grnNumber).filter((n): n is string => Boolean(n))
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
  /** The bill open in the full detail window. */
  const [detail, setDetail] = useState<PurchaseBill | null>(null)
  /** The bill whose files are open on their own, from the paperclip. */
  const [filesFor, setFilesFor] = useState<PurchaseBill | null>(null)

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

  /** What can be done to one bill, in words, behind a single Actions button. */
  const billActions = (bill: PurchaseBill): RowAction[] => {
    const items: RowAction[] = [
      {
        key: 'view',
        label: 'View full detail',
        icon: <Eye size={14} />,
        onClick: () => setDetail(bill),
      },
      {
        key: 'print',
        label: 'Print',
        icon: <Printer size={14} />,
        href: `/print/purchase-bill/${bill.id}`,
        newTab: true,
      },
    ]
    // A bill can be corrected right up until a payment lands against it —
    // after that it is part of the payment record, and cancelling or a debit
    // note is how it is undone instead.
    if (bill.status !== 'CANCELLED' && Number(bill.paidAmount) === 0) {
      items.push(
        {
          key: 'edit',
          label: 'Edit',
          icon: <Pencil size={14} />,
          onClick: () => setDialog({ open: true, record: bill }),
        },
        {
          key: 'cancel',
          label: 'Cancel',
          icon: <Ban size={14} />,
          onClick: () => void cancel(bill),
          danger: true,
        }
      )
    }
    return items
  }

  return (
    <div className="space-y-5">
      {/* One row at every width. It used to carry `flex-wrap`, which on a
        phone put refresh and Book Bill on a line of their own underneath —
        a whole row spent on two buttons, on the screen with the least room
        to spend. Without it the heading gives way instead: it wraps to two
        short lines on the narrowest phones and the buttons stay where they
        belong, hard right of the title. */}
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title">Purchase Bills</h1>
          {/* Desk only. On a phone the heading already says what this is —
            the sentence under it cost a line of a list somebody is
            scrolling. */}
          <p className="page-subtitle hidden sm:block">
            What your suppliers have charged you, and what is still owed
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
        <div className="border-border flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-3 py-2">
          <div className="border-border bg-secondary flex min-w-0 shrink grow basis-full items-center gap-2 rounded-lg border px-2.5 py-1.5 sm:min-w-[150px] sm:max-w-[220px] sm:basis-0">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Our number, theirs, or supplier..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search purchase bills"
            />
          </div>
          <select
            className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-36"
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
          <label className="text-muted-foreground flex shrink-0 cursor-pointer items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(e) => setOverdueOnly(e.target.checked)}
            />
            Overdue only
          </label>
          {(search || status || overdueOnly) && (
            <button
              className="btn-ghost h-8 shrink-0 px-2 text-xs"
              onClick={() => {
                setSearch('')
                setStatus('')
                setOverdueOnly(false)
              }}
            >
              Clear
            </button>
          )}
          <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
            {total} {total === 1 ? 'bill' : 'bills'}
          </span>
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
          <div className="list-scope">
            {/* ── On a phone, not a table ──────────────────────────────────

              Eleven columns cannot be made to fit a phone, and a table you
              drag sideways costs two gestures for every read and keeps the
              buttons off whichever edge you are not looking at. Under 700px
              of list each row is a block instead.

              Measured on the list rather than the window, so collapsing the
              sidebar widens it — see `.list-scope` in globals.css. */}
            <div className="list-cards divide-border divide-y">
              {rows.map((bill) => {
                const s = STATUS[bill.status] ?? { label: bill.status, cls: 'badge-neutral' }
                const overdue =
                  bill.dueDate &&
                  bill.status !== 'PAID' &&
                  bill.status !== 'CANCELLED' &&
                  new Date(bill.dueDate) < new Date()
                const open = expanded === bill.id
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
                          // Pressable here too. On the card this was a count
                          // and nothing else, so the same paperclip opened
                          // the files in the table and did nothing at all on
                          // a phone.
                          <button
                            type="button"
                            className="text-primary hover:text-primary/80 ml-1.5 inline-flex items-center gap-0.5 underline transition"
                            onClick={() => setFilesFor(bill)}
                            title={`Open the ${fileCountOn(bill)} file${
                              fileCountOn(bill) === 1 ? '' : 's'
                            } on this bill's order and receipts`}
                          >
                            <Paperclip size={10} />
                            {fileCountOn(bill)}
                          </button>
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

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <button
                        onClick={() => setExpanded(open ? null : bill.id)}
                        disabled={!bill.lines?.length}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                          !bill.lines?.length
                            ? 'text-muted-foreground cursor-not-allowed opacity-50'
                            : 'bg-primary/10 text-primary hover:bg-primary/20'
                        }`}
                        aria-expanded={open}
                      >
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {open ? 'Hide items' : 'Bill items'}
                      </button>
                      <ActionMenu
                        label={`Actions for ${bill.billNumber}`}
                        items={billActions(bill)}
                      />
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

            <div className="list-rows w-full">
              {/* What goes when the list narrows, in the order it goes:

                  under "full"   our own reference and the booking date — the
                              supplier's number is the one both sides quote
                              and ours is on the card and in the detail
                              window, and nobody scans a list for the day a
                              bill was keyed in
                  under "wide"   the receipts it settles, and the due date
                  under "roomy"  what is outstanding

                  Never dropped: the bill number, the supplier, the total, the
                  status and the actions. That is enough to find a row and do
                  something to it, which is the floor.

                  Sized by content, not by a table of percentages. Percentages
                  only ever add to 100% with every column showing — with five
                  of them gone the other half of the table went to whichever
                  column the browser felt like, which here was the 30px expand
                  toggle: 345px of empty first column and a bill number
                  spilling out of 79px beside it. Content sizing redistributes
                  on its own, and the two columns that can run long are capped
                  below so one supplier with a long name cannot push the
                  figures off the end. */}
              <table className="data-table w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th style={{ width: 30 }} />
                    {/* The supplier's own number leads, because that is the one
                      both sides quote. Ours is the book reference beside it —
                      the old ERP printed one value in both places and lost the
                      distinction entirely. */}
                    <th>Bill no.</th>
                    <th className="col-full">Our ref</th>
                    {/* The receipts this bill settles. The old ERP called it
                      Reference# and put a GRN number in it, because that is
                      what the accounts team reconciles against — the bill's
                      own number means nothing to the store. */}
                    <th className="col-wide">Against receipt</th>
                    <th>Supplier</th>
                    <th className="col-full">Booked</th>
                    <th className="col-full">Due</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th className="col-roomy" style={{ textAlign: 'right' }}>
                      Outstanding
                    </th>
                    <th>Status</th>
                    <th className="col-roomy">Files</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((bill) => {
                    const s = STATUS[bill.status] ?? { label: bill.status, cls: 'badge-neutral' }
                    const overdue = isOverdue(bill)
                    const open = expanded === bill.id
                    const lines = bill.lines ?? []
                    return (
                      <Fragment key={bill.id}>
                        <tr>
                          <td>
                            <button
                              className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                                lines.length === 0
                                  ? 'text-muted-foreground cursor-not-allowed opacity-50'
                                  : 'bg-primary/10 text-primary hover:bg-primary/20'
                              }`}
                              onClick={() => setExpanded(open ? null : bill.id)}
                              disabled={lines.length === 0}
                              title={open ? 'Hide items' : 'Show items'}
                              aria-label={`${open ? 'Hide' : 'Show'} items on ${bill.billNumber}`}
                              aria-expanded={open}
                            >
                              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </td>
                          <td className="whitespace-nowrap font-mono text-xs">
                            {/* The number opens the printable bill, the way the
                            old ERP's invoice number did. */}
                            <Link
                              href={`/print/purchase-bill/${bill.id}`}
                              target="_blank"
                              className="text-teal-400 underline-offset-2 hover:underline"
                              title="Open this bill to print or save"
                            >
                              {bill.supplierInvoiceNo || bill.billNumber}
                            </Link>
                            {bill.supplierInvoiceDate && (
                              <div className="text-muted-foreground text-[10px]">
                                {formatDate(bill.supplierInvoiceDate)}
                              </div>
                            )}
                          </td>
                          <td className="text-muted-foreground col-full font-mono text-xs">
                            {bill.billNumber}
                          </td>
                          <td className="col-wide text-xs">
                            <div className="flex items-center gap-2">
                              {receiptsOn(bill).length ? (
                                <span className="text-foreground max-w-[11rem] truncate font-mono">
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
                            </div>
                          </td>
                          <td>
                            {/* Capped, because nothing else caps it. Under
                            content sizing the column grows to whatever the
                            longest name on the page is, and one
                            "Shree Balaji Textiles Private Limited" would push
                            the figures off the end of the screen. */}
                            <div className="text-foreground max-w-[15rem] truncate font-medium">
                              {bill.supplier?.name}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5">
                              {bill.supplier?.gstin && (
                                <span className="text-muted-foreground font-mono text-[10px]">
                                  {bill.supplier.gstin}
                                </span>
                              )}
                              {bill.isReverseCharge && <span className="badge-purple">RCM</span>}
                            </div>
                          </td>
                          <td className="col-full whitespace-nowrap text-xs">
                            {formatDate(bill.billDate)}
                          </td>
                          <td className="col-full whitespace-nowrap text-xs">
                            {bill.dueDate ? (
                              <span className={overdue ? 'font-medium text-red-400' : undefined}>
                                {formatDate(bill.dueDate)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                            ₹{money(bill.totalAmount)}
                          </td>
                          <td className="col-roomy whitespace-nowrap text-right tabular-nums">
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
                          <td className="col-roomy whitespace-nowrap">
                            {/* A paperclip opens the files, and only the
                              files. It used to open the whole detail window
                              scrolled down to its attachments panel — which
                              answers "tell me everything about this bill"
                              when the question asked was "let me see the
                              challan". */}
                            <FilesCell
                              count={fileCountOn(bill)}
                              onOpen={() => setFilesFor(bill)}
                              what="on this bill's order and receipts"
                            />
                          </td>
                          <td className="whitespace-nowrap text-right">
                            <div className="flex justify-end">
                              <ActionMenu
                                label={`Actions for ${bill.billNumber}`}
                                items={billActions(bill)}
                              />
                            </div>
                          </td>
                        </tr>
                        {open && lines.length > 0 && (
                          <tr>
                            <td colSpan={12} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              <div className="border-border bg-card overflow-hidden rounded-lg border">
                                <div className="border-border flex items-center gap-1.5 border-b px-3 py-1.5">
                                  <FileText size={13} className="text-muted-foreground shrink-0" />
                                  <h4 className="text-foreground text-[11px] font-semibold">
                                    Bill Items
                                  </h4>
                                  <span className="text-muted-foreground ml-auto text-[10px]">
                                    {lines.length} {lines.length === 1 ? 'line' : 'lines'} on{' '}
                                    {bill.billNumber}
                                  </span>
                                </div>
                                <div className="max-h-[22rem] overflow-y-auto">
                                  <BillItems bill={bill} />
                                </div>
                              </div>
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

      {filesFor && (
        <BillFilesDialog
          trail={filesFor}
          label={filesFor.supplierInvoiceNo || filesFor.billNumber}
          onClose={() => setFilesFor(null)}
        />
      )}

      {detail && <BillDetailDialog bill={detail} onClose={() => setDetail(null)} />}
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
