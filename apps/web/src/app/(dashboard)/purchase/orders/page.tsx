'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  Plus,
  Pencil,
  History,
  Printer,
  Search,
  RefreshCw,
  AlertCircle,
  Ban,
  Trash2,
  ChevronDown,
  ChevronRight,
  CalendarDays,
  FileText,
  Info,
  PackageCheck,
  Paperclip,
  LayoutDashboard,
  Loader2,
} from 'lucide-react'
import Link from 'next/link'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import {
  PurchaseOrderDialog,
  type PurchaseOrder,
  type PoLine,
} from '@/components/purchase/PurchaseOrderDialog'
import type { EnquiryQuote, EnquiryRecord } from '@/components/purchase/enquiryTypes'
import { takeHandedEnquiry } from '@/components/purchase/enquiryHandoff'
import { OrderAttachmentsDialog } from '@/components/purchase/OrderAttachmentsDialog'
import { GoodsReceiptHistoryDialog } from '@/components/purchase/GoodsReceiptHistoryDialog'
import { Pagination } from '@/components/tables/Pagination'
import { ExportButton } from '@/components/tables/ExportButton'
import { describeReport, downloadReport } from '@/lib/reportDownload'
import {
  asDate,
  asNumber,
  downloadRows,
  fetchEveryPage,
  type ExportColumn,
  type ExportFormat,
} from '@/lib/export'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { FilesCell } from '@/components/tables/FilesCell'
import { RowPanel } from '@/components/tables/RowPanel'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate, itemsPreview } from '@/lib/utils'
import { shortCloseNoun, shortCloseVerb, wasNeverReceived } from '@/components/purchase/shortClose'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { SmartSelect } from '@/components/ui/SmartSelect'

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
  /*
   * The enquiry an order is being raised from, arrived at by ?fromEnquiry=.
   *
   * A link rather than a dialog handing over an object, because the Order
   * button lives on a different screen. The enquiry screen leaves its freshly
   * loaded copy in session storage (see enquiryHandoff) so the form opens at
   * once; without it — a refresh, an old link — it is fetched here.
   */
  const [fromEnquiry, setFromEnquiry] = useState<{
    enquiry: EnquiryRecord
    quote: EnquiryQuote
  } | null>(null)
  /** True while an enquiry is being fetched to prefill the order form. */
  const [openingEnquiry, setOpeningEnquiry] = useState(false)
  /** Which order's files are open in the read-only viewer, or null when closed. */
  const [filesFor, setFilesFor] = useState<PurchaseOrder | null>(null)
  const [historyFor, setHistoryFor] = useState<PurchaseOrder | null>(null)

  /*
   * Arriving from an enquiry's Order button.
   *
   * Read straight off `window.location` rather than through `useSearchParams`,
   * which would opt this whole page into a Suspense boundary for one optional
   * parameter. Runs once: the dialog's own close handler clears both the state
   * and the query string.
   *
   * A failure opens the blank order form and says why, rather than leaving the
   * buyer on a list with nothing having happened — they can still raise the
   * order by hand, which is what they would have done before any of this.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    // Arriving from the dashboard, which links to one order by its number.
    const q = params.get('q')
    if (q) {
      setSearch(q)
      setDebounced(q)
    }
    const id = params.get('fromEnquiry')
    const quoteId = params.get('fromQuote')
    if (!id || !quoteId) return
    let alive = true
    const openWith = (enquiry: EnquiryRecord) => {
      const quote = enquiry.quotes.find((q) => q.id === quoteId)
      if (!quote) {
        setError('That supplier is no longer on the enquiry.')
        setDialog({ open: true, record: null })
        return
      }
      setFromEnquiry({ enquiry, quote })
      setDialog({ open: true, record: null })
    }
    const handed = takeHandedEnquiry(id)
    if (handed) {
      openWith(handed)
      return
    }
    setOpeningEnquiry(true)
    void api
      .get<{ data: EnquiryRecord }>(`/purchase/enquiries/${id}`)
      .then((res) => {
        if (alive) openWith(res.data)
      })
      .catch((err) => {
        if (!alive) return
        setError(
          err instanceof ApiError
            ? `That enquiry could not be opened: ${err.message}`
            : 'That enquiry could not be opened.'
        )
        setDialog({ open: true, record: null })
      })
      .finally(() => {
        if (alive) setOpeningEnquiry(false)
      })
    return () => {
      alive = false
    }
  }, [])

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

  /*
   * Only the newest request may fill the list. Two loads can be in flight at
   * once — the page's first, unfiltered one and the one a search starts — and
   * whichever answered last used to win, so a slow first reply could paint the
   * whole list over a search that had already narrowed it.
   */
  const latestLoad = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++latestLoad.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<Paginated<PurchaseOrder>>(query(page, rowsPerPage))
      if (ticket !== latestLoad.current) return
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      if (ticket !== latestLoad.current) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing purchase orders.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setRows([])
    } finally {
      if (ticket === latestLoad.current) setLoading(false)
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

  /**
   * The list's query string, built once.
   *
   * The export calls this too. An exporter that assembled its own filters
   * would be one `if` away from handing somebody a spreadsheet of a different
   * list than the one on their screen, and nothing about the file would say so.
   */
  const query = (p: number, limit: number) => {
    const qs = new URLSearchParams({ page: String(p), limit: String(limit) })
    if (debounced) qs.set('q', debounced)
    if (status) qs.set('status', status)
    if (supplierId) qs.set('supplierId', supplierId)
    if (itemId) qs.set('itemId', itemId)
    if (fromDate) qs.set('from', fromDate)
    if (toDate) qs.set('to', toDate)
    return `/purchase/orders?${qs}`
  }

  const clearFilters = () => {
    setSearch('')
    setStatus('')
    setSupplierId('')
    setItemId('')
    setFromDate('')
    setToDate('')
  }

  /**
   * What goes in the spreadsheet.
   *
   * The eight columns on screen, plus the five that are on the order but not
   * on the row — the tax split, the discount and the delivery date. A list is
   * read; a spreadsheet is worked on, and the figures somebody is going to
   * total are exactly the ones the row had no width for.
   */
  const EXPORT_COLUMNS: ExportColumn<PurchaseOrder>[] = [
    { header: 'Order No.', value: (po) => po.poNumber },
    { header: 'Order Date', value: (po) => asDate(po.poDate) },
    { header: 'Status', value: (po) => STATUS[po.status]?.label ?? po.status },
    { header: 'Supplier', value: (po) => po.supplier?.name ?? '' },
    { header: 'Supplier Code', value: (po) => po.supplier?.code ?? '' },
    { header: 'GSTIN', value: (po) => po.supplier?.gstin ?? '' },
    { header: 'Reference', value: (po) => po.reference ?? '' },
    { header: 'Enquiry No.', value: (po) => po.enquiryNo ?? '' },
    { header: 'Delivery Date', value: (po) => asDate(po.deliveryDate) },
    { header: 'Items', value: (po) => (po.lines ?? []).length },
    { header: 'Subtotal', value: (po) => asNumber(po.subtotal) },
    { header: 'Discount', value: (po) => asNumber(po.discountAmount) },
    { header: 'Taxable', value: (po) => asNumber(po.taxableAmount) },
    { header: 'CGST', value: (po) => asNumber(po.cgst) },
    { header: 'SGST', value: (po) => asNumber(po.sgst) },
    { header: 'IGST', value: (po) => asNumber(po.igst) },
    { header: 'Other Charges', value: (po) => asNumber(po.otherCharges) },
    { header: 'Total', value: (po) => asNumber(po.totalAmount) },
    { header: 'Files', value: (po) => po._count?.attachments ?? 0 },
    { header: 'Remark', value: (po) => po.remark ?? '' },
  ]

  /**
   * Every order the filters allow, not the twenty-five on this page.
   *
   * The API caps a request at 200, so this walks the pages. Somebody who has
   * filtered to a supplier and a month wants that month, and a file holding
   * only its first page would be wrong in the quietest possible way.
   */
  const exportList = async (format: ExportFormat) => {
    setError(null)
    try {
      const {
        rows: all,
        total,
        truncated,
      } = await fetchEveryPage<PurchaseOrder>((p) => query(p, 200))
      if (all.length === 0) {
        setMessage('Nothing to export — no orders match these filters.')
        return
      }
      await downloadRows({
        rows: all,
        columns: EXPORT_COLUMNS,
        name: 'purchase-orders',
        sheet: 'Purchase Orders',
        format,
      })
      setMessage(
        truncated
          ? `Exported the first ${all.length} of ${total} orders. Narrow the filters to get the rest.`
          : `Exported ${all.length} ${all.length === 1 ? 'order' : 'orders'}.`
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the export.')
    }
  }

  /**
   * The same filters, built as a report rather than as a grid.
   *
   * Every filter on this screen goes up with it — the search box and the item
   * picker included, which the report learned to take for exactly this. A
   * report that answered a different question from the one on screen, and
   * said nothing about it, would be worse than no button.
   *
   * The server does the work: it reads inside one transaction, so the file is
   * one moment rather than a stitch of several, and it is the only thing that
   * can count the charts in the finished file.
   */
  const exportReport = async () => {
    setError(null)
    try {
      const params: Record<string, string> = {}
      if (debounced) params.q = debounced
      if (status) params.status = status
      if (supplierId) params.supplierId = supplierId
      if (itemId) params.itemId = itemId
      if (fromDate) params.from = fromDate
      if (toDate) params.to = toDate
      setMessage(describeReport(await downloadReport('purchase-order-status', 'xlsx', params)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The report could not be built.')
    }
  }

  /*
   * Closing one line short, from the order it belongs to.
   *
   * The same two endpoints the goods-receipt screen has always called, the
   * same dialog, the same required reason — nothing about what happens is
   * different here. Only where it can be reached from is: this decision is
   * about an order, and a buyer chasing a supplier is looking at the order,
   * not at the receipts screen where it used to live alone.
   *
   * `pendingQty` is pinned to zero on the server and `receivedQty` is left
   * exactly as it was, so this never touches stock, a bill, or anything
   * already received. Reversible by the same reopen it always was.
   */
  const [lineConfirm, setLineConfirm] = useState<{
    type: 'close' | 'reopen'
    po: PurchaseOrder
    lineId: string
    itemName: string
    /** Decides whether the word is "Cancel" or "Close short". */
    receivedQty: string | number | null | undefined
  } | null>(null)

  const lineAction = async (
    po: PurchaseOrder,
    lineId: string,
    what: 'short-close' | 'reopen',
    reason?: string
  ) => {
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const res = await api.patch<{ message?: string }>(
        `/purchase/orders/${po.id}/lines/${lineId}/${what}`,
        what === 'short-close' ? { reason } : {}
      )
      setLineConfirm(null)
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.')
    } finally {
      setBusy(false)
    }
  }

  const act = async (po: PurchaseOrder, what: 'cancel') => {
    if (!confirm(`Cancel ${po.poNumber}?`)) return
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
      `it was called off. The number ${po.poNumber} will not be reused.` +
      // Deleting one the supplier holds leaves them working from paper for an
      // order that is no longer on the list. Cancelling is usually what was
      // meant, so the prompt says so rather than quietly allowing it.
      (po.status === 'SENT'
        ? `

The supplier already has this order. If it was real and fell through, cancel it instead so the file still shows what happened.`
        : '')
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

  /*
   * What can be done to one order — five things, in the order somebody
   * reaches for them.
   *
   * Shared by the table and the phone cards. Written once because these
   * conditions are the rules, and a second copy would eventually disagree
   * with this one about a live document.
   *
   * "Reopen as a draft" is gone. Correcting an order the supplier already had
   * used to mean pulling it back to a draft first, then editing, then sending
   * it again — three decisions for one intention, and it left the order
   * sitting as a draft if the buyer was interrupted halfway. Edit is offered
   * straight away now and the order stays sent; the note after saving is what
   * reminds them to send the new copy.
   *
   * "Mark as sent to supplier" is gone because saving the form already does
   * it, and "Goods receipt history" because it belongs on the goods receipt
   * screen, which is where it only ever led.
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

    // Correctable right up until the first delivery. After that the receipts
    // reconcile against these very lines, and the server refuses — replacing
    // a line that a receipt points at would cut the receipt loose.
    if (po.status === 'DRAFT' || po.status === 'SENT') {
      items.push({
        key: 'edit',
        label: 'Edit order',
        icon: <Pencil size={15} />,
        onClick: () => setDialog({ open: true, record: po }),
      })
    }

    // Leads to the receipt screen rather than opening a form here, so the
    // store keeper lands where the rest of the receiving work is.
    if (po.status === 'SENT' || po.status === 'PARTIALLY_RECEIVED') {
      items.push({
        key: 'receive',
        label: 'Receive goods',
        icon: <PackageCheck size={15} />,
        href: `/purchase/grn?receive=${po.id}`,
      })
    }

    // A draft cannot have had anything arrive against it, so it is the one
    // status with nothing to show.
    if (po.status !== 'DRAFT') {
      items.push({
        key: 'history',
        label: 'Goods receipt history',
        icon: <History size={15} />,
        onClick: () => setHistoryFor(po),
      })
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

    // The server allows this only while nothing has been received or billed
    // against the order, and those two are exactly the statuses that can still
    // be true. Offering it on a partly or fully received order would be a
    // button that always failed.
    if (po.status === 'DRAFT' || po.status === 'SENT' || po.status === 'CANCELLED') {
      items.push({
        key: 'delete',
        label: 'Delete order',
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
      {/* `gap-3` without `flex-wrap` — refresh, Export and the primary
        button sit beside the title on every width instead of dropping to
        a row of their own under it. The title takes a size down and the
        primary button loses its words below `sm`, which between them is
        what leaves the row enough space to still fit. */}
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Purchase Orders</h1>
          {/* Desk only. On a phone the screen is short and the heading
            already says what this is — the sentence under it cost a line of
            a list somebody is scrolling. */}
          <p className="page-subtitle hidden sm:block">What you have ordered from your suppliers</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <Link href="/purchase/dashboard" className="btn-secondary" aria-label="Dashboard">
            <LayoutDashboard size={15} /> <span className="hidden md:inline">Dashboard</span>
          </Link>
          <ExportButton onExport={exportList} onReport={exportReport} disabled={loading} />
          <button
            className="btn-primary"
            onClick={() => setDialog({ open: true, record: null })}
            aria-label="New Purchase Order"
          >
            <Plus size={15} /> <span className="hidden sm:inline">New Purchase Order</span>
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
          {/* Search on its own line at a phone width, the two dates on the
            one under it — sharing a row with a fixed-width date pair left
            the search box too narrow to read what was typed into it. See
            the same fix on Supplier Payments. `sm:contents` still
            dissolves both back into the one row a tablet or a desk has
            the width for. */}
          <div className="flex flex-col gap-2 sm:contents">
            {/* One box for words. It reaches the supplier as well as the order
              number, so typing "ambika" finds every order raised against them
              just as typing "PO-0006" finds the one order. */}
            <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 sm:min-w-[150px] sm:max-w-[190px] sm:basis-0 sm:px-2.5">
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

          <div className="flex items-center gap-2 sm:contents">
            <SmartSelect
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
            </SmartSelect>

            <SmartSelect
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
            </SmartSelect>

            <SmartSelect
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
            </SmartSelect>
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
                          {/* The number is the way to the printed order. The
                            goods receipt screen already puts this link on the
                            order it names, so one habit covers both screens. */}
                          <a
                            href={`/print/purchase-order/${po.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-xs font-semibold text-teal-400 hover:underline"
                            title={`Open the printed sheet for ${po.poNumber}`}
                          >
                            {po.poNumber}
                          </a>
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
                    <th className="col-roomy">Files</th>
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
                            <a
                              href={`/print/purchase-order/${po.id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono text-xs font-semibold text-teal-400 hover:underline"
                              title={`Open the printed sheet for ${po.poNumber}`}
                            >
                              {po.poNumber}
                            </a>
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
                          <td className="col-roomy whitespace-nowrap">
                            <FilesCell
                              count={po._count?.attachments ?? 0}
                              onOpen={() => setFilesFor(po)}
                              what={`attached to ${po.poNumber}`}
                            />
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
                            <td colSpan={11} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              <RowPanel
                                icon={FileText}
                                title="Item Details"
                                note={`${lines.length} ${
                                  lines.length === 1 ? 'line' : 'lines'
                                } on ${po.poNumber}`}
                              >
                                <table className="subtable w-full table-fixed">
                                  <thead className="sticky top-0 z-10">
                                    <tr>
                                      {INNER_COLS.map(({ label: h, width }) => (
                                        <th
                                          key={h}
                                          style={width ? { width } : undefined}
                                          className={
                                            INNER_NUMERIC.includes(h) ? 'text-right' : undefined
                                          }
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
                                          <td>
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
                                          <td>
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
                                                {shortCloseNoun(line.receivedQty)}
                                                {line.id &&
                                                  (po.status === 'SENT' ||
                                                    po.status === 'PARTIALLY_RECEIVED') && (
                                                    <button
                                                      type="button"
                                                      className="text-muted-foreground hover:text-foreground ml-1.5 underline underline-offset-2"
                                                      onClick={() =>
                                                        setLineConfirm({
                                                          type: 'reopen',
                                                          po,
                                                          lineId: line.id!,
                                                          itemName: line.item?.name ?? 'this line',
                                                          receivedQty: line.receivedQty,
                                                        })
                                                      }
                                                    >
                                                      Reopen
                                                    </button>
                                                  )}
                                              </div>
                                            ) : (
                                              (po.status === 'SENT' ||
                                                po.status === 'PARTIALLY_RECEIVED') &&
                                              Number(line.pendingQty) > 0 && (
                                                <div className="text-muted-foreground mt-0.5 whitespace-normal text-[10px] font-normal normal-case">
                                                  {Number(line.pendingQty)} pending
                                                  {/* Beside the number it acts on, rather
                                                    than in a menu at the end of the row —
                                                    the decision is about this line's
                                                    balance and nothing else on the row. */}
                                                  {line.id && (
                                                    <button
                                                      type="button"
                                                      className="text-muted-foreground hover:text-foreground ml-1.5 underline underline-offset-2"
                                                      onClick={() =>
                                                        setLineConfirm({
                                                          type: 'close',
                                                          po,
                                                          lineId: line.id!,
                                                          itemName: line.item?.name ?? 'this line',
                                                          receivedQty: line.receivedQty,
                                                        })
                                                      }
                                                      title={`Say the rest of ${line.item?.name ?? 'this line'} is not coming`}
                                                    >
                                                      {shortCloseVerb(line.receivedQty)}
                                                    </button>
                                                  )}
                                                </div>
                                              )
                                            )}
                                          </td>
                                          <td className="text-right tabular-nums">
                                            ₹{money(line.unitRate)}
                                          </td>
                                          {/* A discount is stored as a percentage
                                            whatever was typed into the form, so it
                                            is shown as one. A dash rather than 0%,
                                            because nothing was taken off. */}
                                          <td className="text-right tabular-nums">
                                            {Number(line.discount) > 0 ? (
                                              `${Number(line.discount)}%`
                                            ) : (
                                              <span className="text-muted-foreground">—</span>
                                            )}
                                          </td>
                                          <td className="text-right tabular-nums">
                                            {Number(line.gstRate) > 0 ? (
                                              `${Number(line.gstRate)}%`
                                            ) : (
                                              <span className="text-muted-foreground">—</span>
                                            )}
                                          </td>
                                          <td className="text-right font-medium tabular-nums">
                                            ₹{money(line.amount ?? 0)}
                                          </td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
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

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />

        {/* Inside the card, against the list it is about.

          Loose underneath it sat on the page background as a grey sentence
          with nothing to attach it to, and read as a caption for the whole
          screen rather than the rule that decides which of those buttons a
          row gets. */}
        <div className="border-border bg-secondary/40 flex items-start gap-2 border-t px-4 py-2">
          <Info size={14} className="text-primary mt-0.5 shrink-0" />
          <p className="text-muted-foreground text-xs">
            An order can be changed until the first delivery arrives against it. Change one the
            supplier already has, and send them the new print — they are working from the old paper
            until you do.
          </p>
        </div>
      </div>

      {/* Fetching the enquiry behind an Order click. Without this the list sat
      empty for seconds with nothing to say the form was on its way. */}
      {openingEnquiry && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[1px]"
        >
          <div className="bg-card border-border flex items-center gap-3 rounded-xl border px-5 py-4 shadow-lg">
            <Loader2 size={18} className="text-primary animate-spin" />
            <div>
              <p className="text-foreground text-sm font-medium">Opening the purchase order…</p>
              <p className="text-muted-foreground text-xs">
                Bringing over the supplier, items and rates from his PI.
              </p>
            </div>
          </div>
        </div>
      )}

      <PurchaseOrderDialog
        open={dialog.open}
        record={dialog.record}
        fromEnquiry={fromEnquiry}
        onClose={() => {
          setDialog({ open: false, record: null })
          // Dropped on close, and the query string with it, or coming back to
          // this screen later would silently reopen against the same enquiry.
          setFromEnquiry(null)
          window.history.replaceState(null, '', '/purchase/orders')
        }}
        onSaved={() => {
          // Correcting an order the supplier already holds makes their copy
          // wrong, and nothing else in the system will tell them. This does.
          if (dialog.record?.status === 'SENT') {
            setMessage(
              `${dialog.record.poNumber} has been changed. The supplier is holding the old paper — send them the new print.`
            )
          }
          void load()
        }}
      />

      {historyFor && (
        <GoodsReceiptHistoryDialog
          poId={historyFor.id}
          poNumber={historyFor.poNumber}
          supplierName={historyFor.supplier?.name}
          onClose={() => setHistoryFor(null)}
        />
      )}

      {filesFor && (
        <OrderAttachmentsDialog
          docId={filesFor.id}
          docNumber={filesFor.poNumber}
          onClose={() => setFilesFor(null)}
        />
      )}

      {/* The same dialog and the same words as the receipts screen, because it
        is the same decision being taken from a different desk. */}
      {lineConfirm && (
        <ReasonDialog
          title={
            lineConfirm.type === 'close'
              ? `${shortCloseVerb(lineConfirm.receivedQty)} ${lineConfirm.itemName}?`
              : `Reopen ${lineConfirm.itemName}?`
          }
          description={
            lineConfirm.type === 'close'
              ? wasNeverReceived(lineConfirm.receivedQty)
                ? `Nothing has ever been received against this line on ${lineConfirm.po.poNumber} — it will be marked as never coming.`
                : `This says the rest of it is not coming — it does not touch what has already ` +
                  `been received against ${lineConfirm.po.poNumber}.`
              : `It will count as pending again on ${lineConfirm.po.poNumber}.`
          }
          confirmLabel={
            lineConfirm.type === 'close' ? shortCloseVerb(lineConfirm.receivedQty) : 'Reopen'
          }
          danger={lineConfirm.type === 'close'}
          requireReason={lineConfirm.type === 'close'}
          busy={busy}
          onCancel={() => setLineConfirm(null)}
          onConfirm={(reason) =>
            void lineAction(
              lineConfirm.po,
              lineConfirm.lineId,
              lineConfirm.type === 'close' ? 'short-close' : 'reopen',
              reason
            )
          }
        />
      )}
    </div>
  )
}
