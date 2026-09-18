'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Plus,
  Pencil,
  Printer,
  Search,
  RefreshCw,
  AlertCircle,
  Send,
  Ban,
  Trash2,
  ChevronDown,
  ChevronRight,
  CalendarDays,
  FileText,
  Info,
  Undo2,
} from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { PurchaseOrderDialog, type PurchaseOrder } from '@/components/purchase/PurchaseOrderDialog'
import { Pagination } from '@/components/tables/Pagination'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate } from '@/lib/utils'

/*
 * One row action.
 *
 * A bordered box rather than a bare glyph. A draft row carries four of these
 * and as plain icons they ran together into a grey smudge at the right edge —
 * a border says where one target ends and the next begins, and gives the
 * pointer something 28px square to find.
 */
const ICON_BTN =
  'border-border text-muted-foreground hover:bg-secondary hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-50'

/*
 * The columns of the panel that opens under an order.
 *
 * Shares, so seven columns of short values spread across a wide card
 * instead of three of them taking three hundred and seventy pixels each
 * while the quantity, rate and amount were squeezed into the last third.
 */
const INNER_COLS: Array<{ label: string; width: string }> = [
  { label: 'Item code', width: '11%' },
  { label: 'Item', width: '27%' },
  { label: 'Category', width: '15%' },
  { label: 'Subcategory', width: '15%' },
  { label: 'Qty', width: '10%' },
  { label: 'Rate', width: '10%' },
  { label: 'Amount', width: '12%' },
]

const STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral' },
  SENT: { label: 'Sent', cls: 'badge-info' },
  PARTIALLY_RECEIVED: { label: 'Part received', cls: 'badge-warning' },
  COMPLETED: { label: 'Completed', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-danger' },
}

export default function PurchaseOrdersPage() {
  const { rowsPerPage } = useAppSettings()

  const [rows, setRows] = useState<PurchaseOrder[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  // Which order has its items open. One at a time, as on the receipt screen.
  const [open, setOpen] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ open: boolean; record: PurchaseOrder | null }>({
    open: false,
    record: null,
  })

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
      const res = await api.get<Paginated<PurchaseOrder>>(`/purchase/orders?${qs}`)
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing purchase orders.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [debounced, status, page, rowsPerPage])

  useEffect(() => {
    void load()
  }, [load])

  // Narrowing the search while on page 3 would show an empty page 3 of a
  // shorter list, which reads as "nothing found" rather than "you moved".
  useEffect(() => {
    setPage(1)
  }, [debounced, status])

  const act = async (po: PurchaseOrder, what: 'send' | 'cancel' | 'reopen') => {
    if (what === 'cancel' && !confirm(`Cancel ${po.poNumber}?`)) return
    /*
     * Reopening is asked about, because it is the one action here that makes
     * a document somebody already holds wrong. The prompt says that rather
     * than "are you sure?": the supplier has the old sheet, and the person
     * clicking is the one who has to send them the new one.
     */
    if (
      what === 'reopen' &&
      !confirm(
        `Reopen ${po.poNumber} as a draft?

` +
          'The supplier already has this order. Their copy will be out of date ' +
          'until you send it again. This is recorded against your name.'
      )
    )
      return
    setBusy(true)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/purchase/orders/${po.id}/${what}`, {})
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  /*
   * Deleting is not cancelling, and the wording says so.
   *
   * Cancelling keeps the order and records that it was called off, which is
   * what the file should show for a real order that fell through. Deleting is
   * for the ones that should never have been raised — a duplicate, a slip, the
   * rows left over from setting the system up — and it takes the lines,
   * charges and attachments with it.
   *
   * The number is spelled out in the prompt because it is the only thing that
   * cannot be undone: the series counts up and will not hand that number out
   * again.
   */
  const remove = async (po: PurchaseOrder) => {
    const warning =
      `Delete ${po.poNumber} for good? This removes the order, its lines and anything ` +
      'attached to it, and is not the same as cancelling — nothing will be left saying ' +
      `it was called off. The number ${po.poNumber} will not be reused.`
    if (!confirm(warning)) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await api.delete<{ message?: string }>(`/purchase/orders/${po.id}`)
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * What can be done to one order.
   *
   * Shared by the table and the phone cards. Written once because these
   * conditions are the rules — only a draft may be edited or sent, only a
   * draft or a cancelled order may be deleted — and a second copy would
   * eventually disagree with this one about a live document.
   */
  const rowActions = (po: PurchaseOrder) => (
    <>
      <Link
        href={`/print/purchase-order/${po.id}`}
        target="_blank"
        className={ICON_BTN}
        title="Print"
        aria-label={`Print ${po.poNumber}`}
      >
        <Printer size={15} />
      </Link>
      {/* A sent order cannot be edited in place — the supplier is working
          from paper. It can be pulled back to a draft, which is a decision
          rather than a slip: it asks first and it is written to the activity
          log. Gone once a receipt or a bill exists against the order, because
          those reconcile against it line by line. */}
      {po.status === 'SENT' && (
        <button
          className={ICON_BTN}
          onClick={() => void act(po, 'reopen')}
          disabled={busy}
          title="Reopen as a draft so it can be changed"
          aria-label={`Reopen ${po.poNumber} as a draft`}
        >
          <Undo2 size={15} />
        </button>
      )}
      {po.status === 'DRAFT' && (
        <>
          <button
            className={ICON_BTN}
            onClick={() => setDialog({ open: true, record: po })}
            title="Edit"
            aria-label={`Edit ${po.poNumber}`}
          >
            <Pencil size={15} />
          </button>
          <button
            className={`${ICON_BTN} hover:text-teal-400`}
            onClick={() => void act(po, 'send')}
            disabled={busy}
            title="Mark as sent to the supplier"
            aria-label={`Mark ${po.poNumber} sent`}
          >
            <Send size={15} />
          </button>
        </>
      )}
      {po.status !== 'CANCELLED' && po.status !== 'COMPLETED' && (
        <button
          className={`${ICON_BTN} hover:text-red-400`}
          onClick={() => void act(po, 'cancel')}
          disabled={busy}
          title="Cancel"
          aria-label={`Cancel ${po.poNumber}`}
        >
          <Ban size={15} />
        </button>
      )}
      {(po.status === 'DRAFT' || po.status === 'CANCELLED') && (
        <button
          className={`${ICON_BTN} hover:text-red-400`}
          onClick={() => void remove(po)}
          disabled={busy}
          title="Delete for good"
          aria-label={`Delete ${po.poNumber}`}
        >
          <Trash2 size={15} />
        </button>
      )}
    </>
  )

  const money = (v: string | number) =>
    Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const pages = Math.ceil(total / rowsPerPage) || 1

  return (
    <div className="space-y-5">
      <div className="page-header flex-wrap gap-3">
        <div>
          <h1 className="page-title">Purchase Orders</h1>
          <p className="page-subtitle">What you have ordered from your suppliers</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-primary" onClick={() => setDialog({ open: true, record: null })}>
            <Plus size={15} /> New Purchase Order
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
        <div className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
          <div className="bg-secondary border-border flex w-full min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 py-2 sm:w-auto sm:min-w-[220px] sm:max-w-sm">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Search order number or supplier..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search purchase orders"
            />
          </div>
          <select
            className="form-input h-9 w-full sm:w-44"
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
          <span className="text-muted-foreground ml-auto text-xs">
            {total} {total === 1 ? 'order' : 'orders'}
          </span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              No purchase orders yet. Create one to order fabric, buttons or trims.
            </p>
          </div>
        ) : (
          <>
            {/* ── On a phone, not a table ──────────────────────────────────

              Ten columns cannot be made to fit 360px, and the honest options
              are a table you drag sideways or no table. Dragging lost: you
              cannot see the number and the total at the same time, the
              buttons are always off the edge you are not looking at, and
              every read costs two gestures.

              So below xl each order is a block instead: the number and the
              status on the first line, the supplier under it, the money hard
              right, and the rest as label-and-value pairs that wrap. Nothing
              scrolls sideways at any width.

              xl and not lg, because the table needs about 960px and lg is
              where the sidebar reappears and takes 260px of the screen with
              it — at 1024px wide there would be 732px left and the table
              would be back to being dragged. */}
            <div className="divide-border divide-y xl:hidden">
              {rows.map((po) => {
                const s = STATUS[po.status] ?? { label: po.status, cls: 'badge-neutral' }
                const lines = po.lines ?? []
                const expanded = open === po.id
                const facts: { label: string; value: React.ReactNode }[] = [
                  { label: 'Date', value: formatDate(po.poDate) },
                  ...(po.enquiryNo
                    ? [
                        {
                          label: 'Enquiry',
                          value: <span className="font-mono">{po.enquiryNo}</span>,
                        },
                      ]
                    : []),
                  ...(po.reference ? [{ label: 'Reference', value: po.reference }] : []),
                ]

                return (
                  <div key={po.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-foreground font-mono text-xs font-semibold">
                            {po.poNumber}
                          </span>
                          <span className={s.cls}>{s.label}</span>
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">
                          {po.supplier?.name ?? '—'}
                        </p>
                        {po.supplier?.gstin && (
                          <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">
                            {po.supplier.gstin}
                          </p>
                        )}
                      </div>
                      {/* The total goes top right rather than into the list of
                        pairs below. It is the figure somebody is scanning a
                        list of orders for. */}
                      <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">
                        ₹{money(po.totalAmount)}
                      </span>
                    </div>

                    <dl className="mt-2.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      {facts.map((f) => (
                        <Fragment key={f.label}>
                          <dt className="text-muted-foreground">{f.label}</dt>
                          <dd className="text-foreground min-w-0 break-words">{f.value}</dd>
                        </Fragment>
                      ))}
                      <dt className="text-muted-foreground">Items</dt>
                      <dd className="text-foreground min-w-0">
                        {lines.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>
                            {lines.length} {lines.length === 1 ? 'item' : 'items'}
                            {lines[0].item?.name && (
                              <span className="text-muted-foreground"> · {lines[0].item.name}</span>
                            )}
                          </>
                        )}
                      </dd>
                    </dl>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      {/* A worded button, not a chevron. On a phone there is
                        room to say what it opens, and a 12px arrow is a poor
                        target for a thumb. */}
                      <button
                        onClick={() => setOpen(expanded ? null : po.id)}
                        disabled={lines.length === 0}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                          lines.length === 0
                            ? 'text-muted-foreground cursor-not-allowed opacity-50'
                            : 'bg-primary/10 text-primary hover:bg-primary/20'
                        }`}
                        aria-expanded={expanded}
                      >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {expanded ? 'Hide items' : 'Item details'}
                      </button>
                      <div className="flex gap-1">{rowActions(po)}</div>
                    </div>

                    {expanded && lines.length > 0 && (
                      <div className="border-border bg-secondary/40 mt-2.5 space-y-2 rounded-lg border p-2">
                        {lines.map((line, i) => {
                          const cat = line.item?.category
                          const parent = cat?.parent
                          return (
                            <div
                              key={line.itemId + i}
                              className="border-border bg-card rounded-lg border p-2.5"
                            >
                              <p className="text-foreground text-sm font-medium leading-snug">
                                {line.item?.name ?? '—'}
                              </p>
                              <p className="text-muted-foreground mt-0.5 truncate text-[10px]">
                                <span className="font-mono">{line.item?.code ?? '—'}</span>
                                {parent?.name || cat?.name ? (
                                  <> · {parent?.name ?? cat?.name}</>
                                ) : null}
                                {line.item?.hsnCode && (
                                  <>
                                    {' '}
                                    · <span className="font-mono">HSN: {line.item.hsnCode}</span>
                                  </>
                                )}
                              </p>
                              {/* Three figures across, because they are read
                                together: how many, at what, to what. */}
                              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                                {[
                                  [
                                    'Qty',
                                    `${Number(line.qty)} ${line.item?.uom?.symbol ?? ''}`.trim(),
                                  ],
                                  ['Rate', `₹${money(line.unitRate)}`],
                                  ['Amount', `₹${money(line.amount ?? 0)}`],
                                ].map(([label, value], n) => (
                                  <div key={label} className={n === 2 ? 'text-right' : ''}>
                                    <dt className="text-muted-foreground text-[10px] uppercase tracking-wider">
                                      {label}
                                    </dt>
                                    <dd
                                      className={`text-foreground tabular-nums ${
                                        n === 2 ? 'font-medium' : ''
                                      }`}
                                    >
                                      {value}
                                    </dd>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="hidden w-full overflow-x-auto xl:block">
              <table className="data-table table-compact w-full min-w-[960px] table-fixed">
                <thead>
                  {/* Filled, not just underlined. Nine columns of small grey
                  capitals over white read as another row of data; a tint says
                  where the list starts.

                  Every width is declared and the table is `table-fixed`, so
                  the browser stops handing the slack to whichever column
                  happens to hold the longest word. Left to itself it gave
                  three hundred pixels to the supplier and left the total
                  butted up against the status pill — the right-hand end
                  cramped while the left-hand end was half empty.

                  Shares rather than pixels. Pixels fixed the cramping but
                  then whichever column was left blank swallowed all the
                  slack: seven hundred of it sat in one cell. Shares spread
                  it, and they still hold at the 1040px floor, where a set of
                  pixel widths would have taken the whole table and left
                  nothing for the rest.

                  The floor is 1040 and not 1240 because of the commonest
                  laptop there is. A 1366px screen less the 260px sidebar and
                  the page's own padding leaves 1058px, and at a 1240px floor
                  this table overflowed it by nearly two hundred — which put
                  the row's buttons off the right-hand edge of the screen,
                  reachable only by scrolling a table nobody could see needed
                  scrolling. Every column below was measured against what it
                  actually holds so that ten of them fit in 1058px with
                  nothing hidden. */}
                  <tr className="bg-secondary">
                    <th style={{ width: '3.8%' }} />
                    <th style={{ width: '8%' }}>Order</th>
                    <th style={{ width: '16%' }}>Supplier</th>
                    <th style={{ width: '10%' }}>Date</th>
                    {/* 9%, not 7.5%. An enquiry number is thirteen mono
                    characters — ENQ-2026-0187 — and narrower than this it
                    broke across two lines, which made every row on the screen
                    taller for it. */}
                    <th style={{ width: '10%' }}>Enquiry</th>
                    <th style={{ width: '9.4%' }}>Reference</th>
                    <th style={{ width: '11%' }}>Items</th>
                    <th style={{ width: '8%', textAlign: 'right' }}>Total</th>
                    <th style={{ width: '7.5%' }}>Status</th>
                    {/* 16.3%, because a draft row carries five of them — print,
                    edit, send, cancel, delete. Five 28px buttons with 4px
                    between come to 156px, and 16.3% of the 1040px floor is
                    170. At 10% they were 104px and spilled out of the cell on
                    every laptop. */}
                    <th style={{ width: '16.3%' }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((po) => {
                    const s = STATUS[po.status] ?? { label: po.status, cls: 'badge-neutral' }
                    const lines = po.lines ?? []
                    const expanded = open === po.id
                    return (
                      <Fragment key={po.id}>
                        <tr>
                          <td>
                            {/* Item code, category and quantity belong to a line, not
                            to the order — a four-item order has four of each — so
                            they open underneath rather than being flattened into
                            a column that could only ever show the first one. */}
                            <button
                              className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                                lines.length === 0
                                  ? 'text-muted-foreground cursor-not-allowed opacity-50'
                                  : 'bg-primary/10 text-primary hover:bg-primary/20'
                              }`}
                              onClick={() => setOpen(expanded ? null : po.id)}
                              disabled={lines.length === 0}
                              title={expanded ? 'Hide items' : 'Show items'}
                              aria-label={`${expanded ? 'Hide' : 'Show'} items on ${po.poNumber}`}
                              aria-expanded={expanded}
                            >
                              {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>
                          </td>
                          <td className="text-foreground font-mono text-xs font-semibold">
                            {po.poNumber}
                          </td>
                          <td>
                            <div className="text-foreground font-medium">{po.supplier?.name}</div>
                            {po.supplier?.gstin && (
                              <div className="text-muted-foreground font-mono text-[10px] leading-tight">
                                {po.supplier.gstin}
                              </div>
                            )}
                          </td>
                          <td className="whitespace-nowrap text-xs">
                            <span className="flex items-center gap-1.5">
                              <CalendarDays size={13} className="text-muted-foreground shrink-0" />
                              {formatDate(po.poDate)}
                            </span>
                          </td>
                          <td className="text-xs">
                            {po.enquiryNo ? (
                              <>
                                <div className="text-foreground font-mono">{po.enquiryNo}</div>
                                {po.enquiryDate && (
                                  <div className="text-muted-foreground text-[10px]">
                                    {formatDate(po.enquiryDate)}
                                  </div>
                                )}
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="text-xs">
                            {po.reference ? (
                              po.reference
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap text-xs">
                            {lines.length === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <>
                                <div className="text-foreground">
                                  {lines.length} {lines.length === 1 ? 'item' : 'items'}
                                </div>
                                <div className="text-muted-foreground truncate text-[10px] leading-tight">
                                  {lines[0].item?.name}
                                  {lines.length > 1 ? ` +${lines.length - 1} more` : ''}
                                </div>
                              </>
                            )}
                          </td>
                          <td className="text-right font-semibold tabular-nums">
                            ₹{money(po.totalAmount)}
                          </td>
                          <td>
                            <span className={s.cls}>{s.label}</span>
                          </td>
                          <td className="whitespace-nowrap text-right">
                            <div className="flex justify-end gap-1">{rowActions(po)}</div>
                          </td>
                        </tr>

                        {expanded && lines.length > 0 && (
                          <tr>
                            {/* The lines, in a panel of their own on a tinted
                            strip rather than loose under the row. Without the
                            inset the inner table's first row sat flush
                            against the order above it and read as a tenth
                            column of that row. */}
                            <td colSpan={10} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              <div className="border-border bg-card overflow-hidden rounded-lg border">
                                <div className="border-border flex items-center gap-1.5 border-b px-3 py-1.5">
                                  <FileText size={13} className="text-muted-foreground shrink-0" />
                                  <h4 className="text-foreground text-[11px] font-semibold">
                                    Item Details
                                  </h4>
                                  <span className="text-muted-foreground ml-auto text-[10px]">
                                    {lines.length} {lines.length === 1 ? 'line' : 'lines'} on{' '}
                                    {po.poNumber}
                                  </span>
                                </div>
                                <table className="w-full table-fixed text-sm">
                                  <thead>
                                    <tr className="bg-secondary border-border border-b">
                                      {INNER_COLS.map(({ label: h, width }) => (
                                        <th
                                          key={h}
                                          style={width ? { width } : undefined}
                                          className={`text-muted-foreground px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${
                                            ['Qty', 'Rate', 'Amount'].includes(h)
                                              ? 'text-right'
                                              : 'text-left'
                                          }`}
                                        >
                                          {h}
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {lines.map((line, i) => {
                                      // An item is filed under one category, which may
                                      // itself sit under a parent. Where it does, the
                                      // parent is the category and the item's own is the
                                      // subcategory; where it does not, there is no
                                      // subcategory to show.
                                      const cat = line.item?.category
                                      const parent = cat?.parent
                                      return (
                                        <tr
                                          key={line.itemId + i}
                                          className="border-border/40 border-b last:border-0"
                                        >
                                          <td className="text-muted-foreground whitespace-nowrap px-3 py-1.5 font-mono text-xs">
                                            {line.item?.code ?? '—'}
                                          </td>
                                          <td className="px-3 py-1.5">
                                            <div className="text-foreground truncate text-xs">
                                              {line.item?.name ?? '—'}
                                            </div>
                                            {(line.description || line.item?.hsnCode) && (
                                              <div className="text-muted-foreground truncate text-[10px] leading-tight">
                                                {line.description}
                                                {line.description && line.item?.hsnCode
                                                  ? ' · '
                                                  : ''}
                                                {line.item?.hsnCode
                                                  ? `HSN: ${line.item.hsnCode}`
                                                  : ''}
                                              </div>
                                            )}
                                          </td>
                                          <td className="px-3 py-1.5 text-xs">
                                            {parent?.name ?? cat?.name ?? (
                                              <span className="text-muted-foreground">—</span>
                                            )}
                                          </td>
                                          <td className="px-3 py-1.5 text-xs">
                                            {parent ? (
                                              cat?.name
                                            ) : (
                                              <span className="text-muted-foreground">—</span>
                                            )}
                                          </td>
                                          <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs tabular-nums">
                                            {Number(line.qty)} {line.item?.uom?.symbol ?? ''}
                                          </td>
                                          <td className="px-3 py-1.5 text-right text-xs tabular-nums">
                                            ₹{money(line.unitRate)}
                                          </td>
                                          <td className="px-3 py-1.5 text-right text-xs font-medium tabular-nums">
                                            ₹{money(line.amount ?? 0)}
                                          </td>
                                        </tr>
                                      )
                                    })}
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
              </table>
            </div>
          </>
        )}

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />

        {/* Inside the card, against the list it is about.

          Loose underneath it sat on the page background as a grey sentence
          with nothing to attach it to, and read as a caption for the whole
          screen rather than the rule that decides which of those buttons a
          row gets. */}
        <div className="border-border bg-secondary/40 flex items-start gap-2 border-t px-4 py-2">
          <Info size={14} className="text-primary mt-0.5 shrink-0" />
          <p className="text-muted-foreground text-xs">
            An order can be changed while it is a draft. Once it is marked sent, raise a new one
            instead — the supplier is holding the old paper.
          </p>
        </div>
      </div>

      <PurchaseOrderDialog
        open={dialog.open}
        record={dialog.record}
        onClose={() => setDialog({ open: false, record: null })}
        onSaved={() => void load()}
      />
    </div>
  )
}
