'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
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
  PackageCheck,
  History,
  Paperclip,
} from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import {
  PurchaseOrderDialog,
  type PurchaseOrder,
  type PoLine,
} from '@/components/purchase/PurchaseOrderDialog'
import { OrderAttachmentsDialog } from '@/components/purchase/OrderAttachmentsDialog'
import { Pagination } from '@/components/tables/Pagination'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate, itemsPreview } from '@/lib/utils'

const qty = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/**
 * A line-by-line total is only honest when every line shares a unit.
 * Fabric in metres next to buttons in pieces cannot be added into one
 * number, so each unit gets its own running total — grouped and truncated
 * the same way the item list is, in the order its first line was seen.
 */
function totalQtyByUnit(lines: PoLine[]): { shown: string; extra: string; full: string } {
  const groups = new Map<string, number>()
  for (const l of lines) {
    const unit = l.item?.uom?.symbol ?? ''
    groups.set(unit, (groups.get(unit) ?? 0) + Number(l.qty))
  }
  const parts = [...groups.entries()].map(([unit, sum]) => `${qty(sum)}${unit ? ` ${unit}` : ''}`)
  const shown = parts.slice(0, 2).join(', ')
  const extra = parts.length > 2 ? ` +${parts.length - 2} more` : ''
  return { shown, extra, full: parts.join(', ') }
}

/*
 * The columns of the panel that opens under an order.
 *
 * Shares, so seven columns of short values spread across a wide card
 * instead of three of them taking three hundred and seventy pixels each
 * while the quantity, rate and amount were squeezed into the last third.
 */
const INNER_COLS: Array<{ label: string; width: string }> = [
  { label: 'Item code', width: '10%' },
  { label: 'Item', width: '24%' },
  /* The style the item was bought for. Typed as free text on the form and
     matched against the style master where it can be, so a line can carry a
     style number that is not a style yet — which is the ordinary case when the
     buying runs ahead of the master. */
  { label: 'Style no', width: '10%' },
  /* Category and subcategory in one column, the subcategory underneath — an
     item filed with no parent has nothing to put there and the column would
     otherwise sit empty as often as the category column has something in it. */
  { label: 'Category', width: '18%' },
  { label: 'Qty', width: '9%' },
  { label: 'Rate', width: '8%' },
  { label: 'Disc', width: '6%' },
  { label: 'GST', width: '5%' },
  { label: 'Amount', width: '10%' },
]

/** The inner columns whose figures line up on the right. */
const INNER_NUMERIC = ['Qty', 'Rate', 'Disc', 'GST', 'Amount']

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
  const [supplierId, setSupplierId] = useState('')
  const [itemId, setItemId] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  // Which order has its items open. One at a time, as on the receipt screen.
  const [open, setOpen] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ open: boolean; record: PurchaseOrder | null }>({
    open: false,
    record: null,
  })
  /** Which order's files are open in the read-only viewer, or null when closed. */
  const [filesFor, setFilesFor] = useState<PurchaseOrder | null>(null)

  /*
   * Every supplier and every item, for the two filter dropdowns.
   *
   * The receipt screen scopes these to what is actually on a waiting order,
   * because that list was already sitting in the browser fully loaded. This
   * list is paginated at the server, so there is no free set of "suppliers on
   * this page" worth building — the master list is what a filter needs here,
   * fetched once rather than on every keystroke.
   */
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [items, setItems] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [s, i] = await Promise.all([
          masterResource<{ id: string; name: string }>('suppliers').list({ limit: 500 }),
          masterResource<{ id: string; name: string }>('items').list({ limit: 500 }),
        ])
        if (cancelled) return
        setSuppliers([...s.data].sort((a, b) => a.name.localeCompare(b.name)))
        setItems([...i.data].sort((a, b) => a.name.localeCompare(b.name)))
      } catch {
        // The filters just come up empty — the list itself still loads and
        // still works without them.
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

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(rowsPerPage) })
      if (debounced) qs.set('q', debounced)
      if (status) qs.set('status', status)
      if (supplierId) qs.set('supplierId', supplierId)
      if (itemId) qs.set('itemId', itemId)
      if (fromDate) qs.set('from', fromDate)
      if (toDate) qs.set('to', toDate)
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
  }, [debounced, status, supplierId, itemId, fromDate, toDate, page, rowsPerPage])

  useEffect(() => {
    void load()
  }, [load])

  // Narrowing a filter while on page 3 would show an empty page 3 of a
  // shorter list, which reads as "nothing found" rather than "you moved".
  useEffect(() => {
    setPage(1)
  }, [debounced, status, supplierId, itemId, fromDate, toDate])

  const anyFilter = Boolean(search || status || supplierId || itemId || fromDate || toDate)

  const clearFilters = () => {
    setSearch('')
    setStatus('')
    setSupplierId('')
    setItemId('')
    setFromDate('')
    setToDate('')
  }

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
  const rowActions = (po: PurchaseOrder): RowAction[] => {
    const items: RowAction[] = [
      {
        key: 'print',
        label: 'Print order',
        icon: <Printer size={15} />,
        href: `/print/purchase-order/${po.id}`,
        newTab: true,
      },
    ]

    // Booking in a delivery, and the deliveries already booked in. The mill's
    // old ERP carried Add GRN and View History of GRN on the order row itself,
    // and that is where somebody looks for them: they are holding this order's
    // paperwork. Both lead to the receipt screen rather than opening a form
    // here, so the store keeper lands where the rest of the receiving work is.
    if (po.status === 'SENT' || po.status === 'PARTIALLY_RECEIVED') {
      items.push({
        key: 'receive',
        label: 'Receive goods',
        icon: <PackageCheck size={15} />,
        href: `/purchase/grn?receive=${po.id}`,
      })
    }
    if (po.status !== 'DRAFT') {
      items.push({
        key: 'history',
        label: 'Goods receipt history',
        icon: <History size={15} />,
        href: `/purchase/grn?q=${encodeURIComponent(po.poNumber)}`,
      })
    }

    // A sent order cannot be edited in place — the supplier is working from
    // paper. It can be pulled back to a draft, which is a decision rather than
    // a slip: it asks first and it is written to the activity log. Gone once a
    // receipt or a bill exists against the order, because those reconcile
    // against it line by line.
    if (po.status === 'SENT') {
      items.push({
        key: 'reopen',
        label: 'Reopen as a draft',
        icon: <Undo2 size={15} />,
        onClick: () => void act(po, 'reopen'),
      })
    }
    if (po.status === 'DRAFT') {
      items.push(
        {
          key: 'edit',
          label: 'Edit order',
          icon: <Pencil size={15} />,
          onClick: () => setDialog({ open: true, record: po }),
        },
        {
          key: 'send',
          label: 'Mark as sent to supplier',
          icon: <Send size={15} />,
          onClick: () => void act(po, 'send'),
        }
      )
    }
    if (po.status !== 'CANCELLED' && po.status !== 'COMPLETED') {
      items.push({
        key: 'cancel',
        label: 'Cancel order',
        icon: <Ban size={15} />,
        onClick: () => void act(po, 'cancel'),
        danger: true,
      })
    }
    if (po.status === 'DRAFT' || po.status === 'CANCELLED') {
      items.push({
        key: 'delete',
        label: 'Delete for good',
        icon: <Trash2 size={15} />,
        onClick: () => void remove(po),
        danger: true,
      })
    }

    return items
  }

  const money = (v: string | number) =>
    Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const pages = Math.ceil(total / rowsPerPage) || 1

  return (
    <div className="space-y-5">
      <div className="page-header flex-wrap gap-3">
        <div>
          <h1 className="page-title">Purchase Orders</h1>
          {/* Desk only. On a phone the screen is short and the heading
            already says what this is — the sentence under it cost a line of
            a list somebody is scrolling. */}
          <p className="page-subtitle hidden sm:block">What you have ordered from your suppliers</p>
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
        {/* ── Two rows on a phone, one flowing row at a desk ─────────────

          Five full-width controls stacked five deep took a third of a phone
          screen before a single order showed. Grouped, they take two rows:
          what you type and when, then the three things you pick.

          The grouping wrappers are `sm:contents`, so above a phone they stop
          existing and their children rejoin the one wrapping row they were
          always in. That keeps a single set of controls rather than one set
          per layout, which is how these bars end up disagreeing with
          themselves. */}
        <div className="border-border flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex items-center gap-2 sm:contents">
            {/* One box for words. It reaches the supplier as well as the order
              number, so typing "ambika" finds every order raised against them
              just as typing "PO-0006" finds the one order. */}
            <div className="border-border bg-secondary flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 sm:min-w-[150px] sm:max-w-[190px] sm:basis-0 sm:px-2.5">
              {/* The glass costs 22px of a row that has two date boxes in it
                already, and a box you type into needs no icon to explain
                itself. Desk only. */}
              <Search size={14} className="text-muted-foreground hidden shrink-0 sm:block" />
              <input
                className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search purchase orders"
                title="Reaches the supplier as well as the order number"
              />
            </div>

            {/* Two dates, not a preset list — the order date, so "what did we
              place between the 3rd and the 11th" is answered directly. The
              word between them is a desk luxury; on a phone the two boxes
              sitting against each other say the same thing for 18px less. */}
            <div className="flex shrink-0 items-center gap-1">
              <input
                type="date"
                className="form-input h-8 w-[6.9rem] px-1 py-0 text-[10px] sm:w-[7.75rem] sm:px-3 sm:text-xs"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label="From date"
              />
              <span className="text-muted-foreground hidden text-xs sm:inline">to</span>
              <input
                type="date"
                className="form-input h-8 w-[6.9rem] px-1 py-0 text-[10px] sm:w-[7.75rem] sm:px-3 sm:text-xs"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                aria-label="To date"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 sm:contents">
            <select
              className="form-input h-8 min-w-0 flex-1 px-1.5 py-0 text-[11px] sm:w-32 sm:flex-none sm:px-3 sm:text-xs"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              aria-label="Filter by supplier"
            >
              <option value="">All suppliers</option>
              {suppliers.map((sup) => (
                <option key={sup.id} value={sup.id}>
                  {sup.name}
                </option>
              ))}
            </select>

            <select
              className="form-input h-8 min-w-0 flex-1 px-1.5 py-0 text-[11px] sm:w-36 sm:flex-none sm:px-3 sm:text-xs"
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              aria-label="Filter by item"
            >
              <option value="">All items</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                </option>
              ))}
            </select>

            <select
              className="form-input h-8 min-w-0 flex-1 px-1.5 py-0 text-[11px] sm:w-36 sm:flex-none sm:px-3 sm:text-xs"
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
          </div>

          <div className="flex items-center gap-2 sm:contents">
            {/* Only when it is doing something. A permanent Clear is a control
              that does nothing on the screen somebody usually sees. */}
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
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              No purchase orders yet. Create one to order fabric, buttons or trims.
            </p>
          </div>
        ) : (
          <div className="list-scope">
            {/* ── On a phone, not a table ──────────────────────────────────

              Ten columns cannot be made to fit 360px, and the honest options
              are a table you drag sideways or no table. Dragging lost: you
              cannot see the number and the total at the same time, the
              buttons are always off the edge you are not looking at, and
              every read costs two gestures.

              So on a narrow list each order is a block instead: the number
              and the status on the first line, the supplier under it, the
              money hard right, and the rest as label-and-value pairs that
              wrap. Nothing scrolls sideways at any width.

              Where it switches is decided by how wide the list is, not how
              wide the window is — those are two different numbers, and the
              sidebar between them is 260px and collapsible. See
              `.list-scope` in globals.css. */}
            <div className="list-cards divide-border divide-y">
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
                          {po._count?.attachments ? (
                            <button
                              type="button"
                              className="text-primary inline-flex items-center gap-0.5 text-[10px] underline"
                              onClick={() => setFilesFor(po)}
                            >
                              <Paperclip size={10} />
                              {po._count.attachments}
                            </button>
                          ) : null}
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
                            {(() => {
                              const p = itemsPreview(lines.map((l) => l.item?.name))
                              return (
                                p.shown && (
                                  <span className="text-muted-foreground" title={p.full}>
                                    {' '}
                                    · {p.shown}
                                    {p.extra}
                                  </span>
                                )
                              )
                            })()}
                          </>
                        )}
                      </dd>
                      {lines.length > 0 && (
                        <>
                          <dt className="text-muted-foreground">Total qty</dt>
                          <dd className="text-foreground min-w-0">
                            {(() => {
                              const p = totalQtyByUnit(lines)
                              return (
                                <span title={p.full}>
                                  {p.shown}
                                  {p.extra}
                                </span>
                              )
                            })()}
                          </dd>
                        </>
                      )}
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
                      <ActionMenu label={`Actions for ${po.poNumber}`} items={rowActions(po)} />
                    </div>

                    {expanded && lines.length > 0 && (
                      <div className="border-border bg-secondary/40 mt-2.5 max-h-[22rem] space-y-2 overflow-y-auto rounded-lg border p-2">
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
            <div className="list-rows w-full">
              {/* What goes when the list narrows, in the order it goes:

                  under "full"   the reference and the item summary — somebody
                                 else's paperwork, and a list of names that is
                                 one press away under the expand arrow
                  under "wide"   the total quantity
                  under "roomy"  the order date

                  Never dropped: the order number, the supplier, the total,
                  the status and the actions.

                  Sized by content. This table used to carry a set of
                  percentages tuned so that all ten columns fit a 1058px
                  laptop — which worked, at the cost of every column being
                  exactly as wide as the tuning said rather than as wide as it
                  needed, and of falling apart the moment a column was hidden:
                  percentages only add to 100% when they are all showing, and
                  the leftover goes wherever the browser likes. */}
              <table className="data-table w-full">
                <thead>
                  {/* Filled, not just underlined. Ten columns of small grey
                  capitals over white read as another row of data; a tint says
                  where the list starts. */}
                  <tr className="bg-secondary">
                    <th style={{ width: 30 }} />
                    <th>Order</th>
                    <th>Supplier</th>
                    <th className="col-roomy">Date</th>
                    {/* Reference and enquiry are both somebody else's paperwork
                    this order answers to, so they read as one column — the
                    enquiry underneath, the way an item's HSN sits under its
                    name. Two columns that are each empty as often as not read
                    as gaps in the table; one column that is sometimes short
                    and sometimes two lines reads as an ordinary column. */}
                    <th className="col-full">Reference</th>
                    <th className="col-full">Items</th>
                    {/* The quantity, not just the count — grouped by unit,
                    because metres of fabric and pieces of button cannot be
                    added into one figure. Where "Location" sat before: a
                    warehouse or customer name is on the printed order and the
                    item table below, and was empty on every order that had
                    nothing filled in for it, which is most of them. */}
                    <th className="col-wide" style={{ textAlign: 'right' }}>
                      Total qty
                    </th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th>Status</th>
                    <th />
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
                          <td>
                            <div className="text-foreground font-mono text-xs font-semibold">
                              {po.poNumber}
                            </div>
                            {/* Attachments hang off the order, not off a
                              line, so the paperclip sits with the order's own
                              identity rather than claiming a column that is
                              empty on every order nobody has scanned a bill
                              onto yet. Clickable, because a sent order has no
                              edit screen to open otherwise — this count was
                              previously the only trace a file existed, with
                              no way to actually see it. */}
                            {po._count?.attachments ? (
                              <button
                                type="button"
                                className="text-primary mt-0.5 inline-flex items-center gap-0.5 text-[10px] underline"
                                onClick={() => setFilesFor(po)}
                                title={`Open the ${po._count.attachments} file${
                                  po._count.attachments === 1 ? '' : 's'
                                } attached to ${po.poNumber}`}
                              >
                                <Paperclip size={10} />
                                {po._count.attachments}
                              </button>
                            ) : null}
                          </td>
                          <td>
                            {/* Capped, because nothing else caps it. Under
                              content sizing this column grows to the longest
                              name on the page, and one long trading name
                              would push the figures off the right-hand
                              edge. */}
                            <div className="text-foreground max-w-[15rem] truncate font-medium">
                              {po.supplier?.name}
                            </div>
                            {po.supplier?.gstin && (
                              <div className="text-muted-foreground font-mono text-[10px] leading-tight">
                                {po.supplier.gstin}
                              </div>
                            )}
                          </td>
                          <td className="col-roomy whitespace-nowrap text-xs">
                            <span className="flex items-center gap-1.5">
                              <CalendarDays size={13} className="text-muted-foreground shrink-0" />
                              {formatDate(po.poDate)}
                            </span>
                          </td>
                          <td className="col-full text-xs">
                            {po.reference || po.enquiryNo ? (
                              <>
                                <div className="text-foreground max-w-[11rem] truncate">
                                  {po.reference || (
                                    <span className="font-mono">{po.enquiryNo}</span>
                                  )}
                                </div>
                                {po.reference && po.enquiryNo && (
                                  <div className="text-muted-foreground max-w-[11rem] truncate font-mono text-[10px] leading-tight">
                                    Enq: {po.enquiryNo}
                                  </div>
                                )}
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="col-full whitespace-nowrap text-xs">
                            {lines.length === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <>
                                <div className="text-foreground">
                                  {lines.length} {lines.length === 1 ? 'item' : 'items'}
                                </div>
                                {(() => {
                                  const p = itemsPreview(lines.map((l) => l.item?.name))
                                  return (
                                    <div
                                      className="text-muted-foreground truncate text-[10px] leading-tight"
                                      title={p.full}
                                    >
                                      {p.shown}
                                      {p.extra}
                                    </div>
                                  )
                                })()}
                              </>
                            )}
                          </td>
                          <td className="col-wide whitespace-nowrap text-right text-xs tabular-nums">
                            {lines.length === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              (() => {
                                const p = totalQtyByUnit(lines)
                                return (
                                  <span title={p.full}>
                                    {p.shown}
                                    {p.extra}
                                  </span>
                                )
                              })()
                            )}
                          </td>
                          <td className="text-right font-semibold tabular-nums">
                            ₹{money(po.totalAmount)}
                          </td>
                          <td>
                            <span className={s.cls}>{s.label}</span>
                          </td>
                          <td className="whitespace-nowrap text-right">
                            <div className="flex justify-end">
                              <ActionMenu
                                label={`Actions for ${po.poNumber}`}
                                items={rowActions(po)}
                              />
                            </div>
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
                                {/* Capped and scrollable, not left to grow with
                                  the order. A kit's worth of trims can run to
                                  thirty lines, and without this the panel would
                                  push everything below it — the next order, the
                                  pager — halfway down the screen. The header
                                  stays pinned so a long list never loses its
                                  column names. */}
                                <div className="max-h-[22rem] overflow-y-auto">
                                  <table className="w-full table-fixed text-sm">
                                    <thead className="sticky top-0 z-10">
                                      <tr className="bg-secondary border-border border-b">
                                        {INNER_COLS.map(({ label: h, width }) => (
                                          <th
                                            key={h}
                                            style={width ? { width } : undefined}
                                            className={`text-muted-foreground px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${
                                              INNER_NUMERIC.includes(h) ? 'text-right' : 'text-left'
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
                                              {line.style?.code || line.styleNo ? (
                                                <>
                                                  <div className="text-foreground truncate font-mono text-xs">
                                                    {line.style?.code ?? line.styleNo}
                                                  </div>
                                                  {line.style?.name && (
                                                    <div className="text-muted-foreground truncate text-[10px] leading-tight">
                                                      {line.style.name}
                                                    </div>
                                                  )}
                                                </>
                                              ) : (
                                                <span className="text-muted-foreground">—</span>
                                              )}
                                            </td>
                                            <td className="px-3 py-1.5 text-xs">
                                              {(parent?.name ?? cat?.name) ? (
                                                <>
                                                  <div className="text-foreground truncate">
                                                    {parent?.name ?? cat?.name}
                                                  </div>
                                                  {parent && cat?.name && (
                                                    <div className="text-muted-foreground truncate text-[10px] leading-tight">
                                                      {cat.name}
                                                    </div>
                                                  )}
                                                </>
                                              ) : (
                                                <span className="text-muted-foreground">—</span>
                                              )}
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs tabular-nums">
                                              {Number(line.qty)} {line.item?.uom?.symbol ?? ''}
                                              {line.shortClosed ? (
                                                <div
                                                  className="mt-0.5 whitespace-normal text-[10px] font-normal normal-case text-amber-500"
                                                  title={line.shortCloseReason ?? undefined}
                                                >
                                                  Closed short
                                                </div>
                                              ) : (
                                                (po.status === 'SENT' ||
                                                  po.status === 'PARTIALLY_RECEIVED') &&
                                                Number(line.pendingQty) > 0 && (
                                                  <div className="text-muted-foreground mt-0.5 whitespace-normal text-[10px] font-normal normal-case">
                                                    {Number(line.pendingQty)} pending
                                                  </div>
                                                )
                                              )}
                                            </td>
                                            <td className="px-3 py-1.5 text-right text-xs tabular-nums">
                                              ₹{money(line.unitRate)}
                                            </td>
                                            {/* A discount is stored as a percentage
                                            whatever was typed into the form, so it
                                            is shown as one. A dash rather than 0%,
                                            because nothing was taken off. */}
                                            <td className="px-3 py-1.5 text-right text-xs tabular-nums">
                                              {Number(line.discount) > 0 ? (
                                                `${Number(line.discount)}%`
                                              ) : (
                                                <span className="text-muted-foreground">—</span>
                                              )}
                                            </td>
                                            <td className="px-3 py-1.5 text-right text-xs tabular-nums">
                                              {Number(line.gstRate) > 0 ? (
                                                `${Number(line.gstRate)}%`
                                              ) : (
                                                <span className="text-muted-foreground">—</span>
                                              )}
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

      {filesFor && (
        <OrderAttachmentsDialog
          docId={filesFor.id}
          docNumber={filesFor.poNumber}
          onClose={() => setFilesFor(null)}
        />
      )}
    </div>
  )
}
