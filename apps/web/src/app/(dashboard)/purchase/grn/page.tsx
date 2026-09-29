'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { OrderAttachmentsDialog } from '@/components/purchase/OrderAttachmentsDialog'
import { FilesCell } from '@/components/tables/FilesCell'
import { RowPanel } from '@/components/tables/RowPanel'
import {
  Plus,
  Search,
  RefreshCw,
  AlertCircle,
  Ban,
  ChevronDown,
  ChevronRight,
  Printer,
  PackageCheck,
  Pencil,
  Trash2,
  FileText,
  FileMinus,
  ReceiptIndianRupee,
  Paperclip,
  ClipboardCheck,
} from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { ReceiveGoodsDialog } from '@/components/purchase/ReceiveGoodsDialog'
import { GrnQcDialog, QC_RESULT } from '@/components/purchase/GrnQcDialog'
import { Pagination } from '@/components/tables/Pagination'
import { ExportButton } from '@/components/tables/ExportButton'
import { ColumnsButton } from '@/components/tables/ColumnsButton'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
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
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { formatDate, itemsPreview } from '@/lib/utils'
import { shortCloseNoun, shortCloseVerb, wasNeverReceived } from '@/components/purchase/shortClose'

/**
 * What has actually turned up against the purchase orders.
 *
 * A receipt cannot be edited once it is saved, because the stock moved when it
 * saved. The only way back is to cancel it, which takes the stock out again and
 * gives the quantity back to the order — so that is the only action offered.
 */

interface ReceiptLine {
  id: string
  orderedQty: string | number
  receivedQty: string | number
  rejectedQty: string | number
  acceptedQty: string | number
  batchNumber: string | null
  unitRate: string | number
  amount: string | number
  item: {
    id: string
    code: string
    name: string
    hsnCode: string | null
    uom: { symbol: string } | null
  }
  warehouse: { id: string; name: string }
}

interface Receipt {
  id: string
  grnNumber: string
  grnDate: string
  vehicleNo: string | null
  status: 'DRAFT' | 'QC_PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED'
  notes: string | null
  po: {
    id: string
    poNumber: string
    supplier: { id: string; name: string } | null
  }
  lines: ReceiptLine[]
  /** How many files were scanned onto the receipt — the challan, usually. */
  _count?: { attachments: number }
  challanNo?: string | null
  challanDate?: string | null
  gateEntryNo?: string | null
  supplierInvoiceNo?: string | null
  supplierInvoiceDate?: string | null
  /**
   * How much of what was accepted has been billed, worked out by the API so
   * this screen and the bill form cannot disagree about what is still owed.
   */
  billing?: {
    acceptedQty: number
    billedQty: number
    pendingQty: number
    status: 'NOTHING_TO_BILL' | 'NOT_BILLED' | 'PARTLY_BILLED' | 'BILLED'
  }
  bills?: Array<{ id: string; billNumber: string }>
  /** The quality check standing on this receipt, if one was done. */
  qc?: {
    id: string
    result: 'PASS' | 'CONDITIONAL_PASS' | 'FAIL'
    inspectionDate: string
    rejectedQty: number
  } | null
}

/**
 * One line of the export: a receipt and one of its items.
 *
 * `l` is null only for a receipt that somehow has no lines — it is still
 * listed rather than dropped, because a receipt missing from a file nobody
 * knows is incomplete is worse than a row with empty quantities.
 */
type ExportRow = { g: Receipt; l: ReceiptLine | null }

/** How the billing state of a receipt reads on the row. */
function billStage(grn: Receipt): { label: string; cls: string } | null {
  if (grn.status === 'CANCELLED') return null
  const b = grn.billing
  if (!b) return null
  if (b.status === 'NOTHING_TO_BILL') return { label: 'Nothing to bill', cls: 'badge-neutral' }
  if (b.status === 'BILLED') return { label: 'Billed', cls: 'badge-success' }
  if (b.status === 'PARTLY_BILLED') return { label: 'Part billed', cls: 'badge-info' }
  return { label: 'Bill pending', cls: 'badge-warning' }
}

/**
 * An order that has been sent and is still owed goods.
 *
 * The mill's old ERP put these on the receipt screen itself, with an Add GRN
 * button on every row, and that is the right way round: a store keeper opens
 * this screen holding a delivery challan, and what they need is the order it
 * belongs to. A list of receipts already made answers a question they are not
 * asking, and on a system with nothing received yet it is simply blank.
 */
interface WaitingLine {
  id: string
  qty: string | number
  receivedQty: string | number
  pendingQty: string | number
  /**
   * Rejected on the receipts against this line, summed across all of them.
   *
   * `receivedQty` only ever counts what was accepted — a delivery that came
   * in full but was half refused leaves no other trace on the order, so this
   * is worked out server-side from the receipts themselves and sent
   * alongside it.
   */
  rejectedQty: string | number
  shortClosed: boolean
  shortCloseReason: string | null
  styleNo?: string | null
  style?: { id: string; code: string; name: string } | null
  item?: {
    id: string
    code: string
    name: string
    uom?: { symbol: string } | null
    category?: { id: string; name: string; parent?: { id: string; name: string } | null } | null
  } | null
}

interface WaitingOrder {
  id: string
  poNumber: string
  poDate: string
  status: string
  reference: string | null
  totalAmount: string | number
  supplier?: { id: string; name: string } | null
  lines?: WaitingLine[]
  _count?: { attachments: number }
}

const qty = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/** A rate or an amount, to the rupee and paise — never abbreviated, since
 * this is what a bill gets checked against, not a dashboard tile. */
const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * A receipt's lines added into one received, accepted and rejected figure
 * each, for the list row — the same simplification the row's other totals
 * already make, plain numbers rather than grouped by unit. Most receipts
 * carry one unit throughout; the odd one that does not still reads sensibly
 * as a total.
 */
function receiptTotals(grn: Receipt) {
  return grn.lines.reduce(
    (t, l) => ({
      received: t.received + Number(l.receivedQty),
      accepted: t.accepted + Number(l.acceptedQty),
      rejected: t.rejected + Number(l.rejectedQty),
    }),
    { received: 0, accepted: 0, rejected: 0 }
  )
}

/**
 * An order's lines added up by unit, not blindly added up together.
 *
 * A single-item order is one group and the sum is just its quantity. A
 * multi-item order almost never shares one unit — metres of fabric next to
 * pieces of button next to rolls of tape — and adding those raw numbers
 * together produces a total that is not wrong so much as meaningless. Each
 * unit gets its own running total instead, in the order its first line was
 * seen, so Total/Received/Pending line up group-for-group across the row.
 */
function qtyByUnit(lines: WaitingLine[]) {
  const groups = new Map<
    string,
    { unit: string; ordered: number; received: number; pending: number }
  >()
  for (const l of lines) {
    const unit = l.item?.uom?.symbol ?? ''
    const g = groups.get(unit) ?? { unit, ordered: 0, received: 0, pending: 0 }
    g.ordered += Number(l.qty)
    g.received += Number(l.receivedQty)
    g.pending += Number(l.pendingQty)
    groups.set(unit, g)
  }
  return [...groups.values()]
}

/** The columns of the panel that opens under a waiting order — the same shape as the order screen's own, so a line reads the same wherever it is looked at from. */
const WAITING_COLS: Array<{ label: string; width: string; numeric?: boolean }> = [
  { label: 'Item code', width: '9%' },
  { label: 'Item', width: '19%' },
  { label: 'Style no', width: '8%' },
  { label: 'Category', width: '10%' },
  { label: 'Subcategory', width: '10%' },
  { label: 'Qty', width: '8%', numeric: true },
  { label: 'Received qty', width: '9%', numeric: true },
  { label: 'Rejected', width: '9%', numeric: true },
  { label: 'Pending qty', width: '18%', numeric: true },
]

/** One of the three qty columns, condensed the same way an item list is. */
function qtyPreview(
  groups: Array<{ unit: string; ordered: number; received: number; pending: number }>,
  field: 'ordered' | 'received' | 'pending'
): { shown: string; extra: string; full: string } {
  const parts = groups.map((g) => `${qty(g[field])}${g.unit ? ` ${g.unit}` : ''}`)
  const shown = parts.slice(0, 2).join(', ')
  const extra = parts.length > 2 ? ` +${parts.length - 2} more` : ''
  return { shown, extra, full: parts.join(', ') }
}

/** The word a store keeper would use, not the word in the database. */
function stage(status: Receipt['status']): { label: string; cls: string } {
  switch (status) {
    case 'ACCEPTED':
      return { label: 'Received', cls: 'badge-success' }
    case 'CANCELLED':
      return { label: 'Cancelled', cls: 'badge-neutral' }
    case 'QC_PENDING':
      return { label: 'Waiting for checking', cls: 'badge-warning' }
    case 'REJECTED':
      return { label: 'Refused', cls: 'badge-danger' }
    default:
      return { label: 'Draft', cls: 'badge-info' }
  }
}

/**
 * Every column the Goods receipts table can draw, in the order they sit.
 *
 * One definition read by both the header and the body, instead of two lists
 * of JSX that have to be kept in step by hand — that is how a header and a
 * row end up one cell apart from each other, which is the exact "misaligned"
 * report this replaced.
 *
 * No width tier here, unlike the Waiting tab's own table: this one scrolls
 * sideways instead (`ScrollableTable`, below), so nothing about whether a
 * column shows depends on how wide the window happens to be. `locked`
 * columns identify the row or act on it and are always shown; every other
 * column can still be turned off from the Columns button, which is a choice
 * that then holds regardless of screen size.
 */
interface ReceiptColumn {
  key: string
  label: string
  numeric?: boolean
  cellClass?: string
  locked?: boolean
}

const RECEIPT_COLUMNS: ReceiptColumn[] = [
  { key: 'number', label: 'GRN', locked: true, cellClass: 'whitespace-nowrap' },
  { key: 'against', label: 'PO no.', cellClass: 'whitespace-nowrap' },
  { key: 'supplier', label: 'Supplier', locked: true },
  { key: 'challanNo', label: 'Challan no.', cellClass: 'text-xs whitespace-nowrap' },
  { key: 'challanDate', label: 'Challan date', cellClass: 'text-xs whitespace-nowrap' },
  { key: 'gate', label: 'Gate entry', cellClass: 'text-xs whitespace-nowrap' },
  { key: 'receivedDate', label: 'Received on', cellClass: 'text-xs whitespace-nowrap' },
  { key: 'vehicle', label: 'Vehicle no.', cellClass: 'text-xs whitespace-nowrap' },
  { key: 'supplierBillNo', label: 'Supplier bill no.', cellClass: 'text-xs whitespace-nowrap' },
  { key: 'supplierBillDate', label: 'Supplier bill date', cellClass: 'text-xs whitespace-nowrap' },
  { key: 'items', label: 'Items', cellClass: 'text-xs' },
  {
    key: 'receivedQty',
    label: 'Received qty',
    numeric: true,
    cellClass: 'text-right text-sm tabular-nums',
  },
  {
    key: 'accepted',
    label: 'Accepted',
    numeric: true,
    cellClass: 'text-right text-sm tabular-nums',
  },
  {
    key: 'rejected',
    label: 'Rejected',
    numeric: true,
    cellClass: 'text-right text-sm tabular-nums',
  },
  { key: 'status', label: 'Status', locked: true },
  { key: 'billing', label: 'Billing', cellClass: 'whitespace-nowrap' },
  { key: 'files', label: 'Files', cellClass: 'whitespace-nowrap' },
]

/** The picker only offers what can actually be turned off. */
const RECEIPT_TOGGLEABLE = RECEIPT_COLUMNS.filter((c) => !c.locked)
const RECEIPT_DEFAULT_COLS = RECEIPT_TOGGLEABLE.map((c) => c.key)
const RECEIPT_COLUMNS_STORAGE_KEY = 'grn-receipts-columns-v1'

/**
 * Kept as the 50 this screen already asked for, rather than the user's rows-per-page
 * setting that the order and bill lists follow. Changing it is a decision for
 * whoever owns this screen, not a side effect of giving it a pager.
 */
const PER_PAGE = 50

export default function GoodsReceiptPage() {
  const [rows, setRows] = useState<Receipt[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')

  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<string | null>(null)

  /** Which waiting order has its lines open — a store keeper checks one at a time. */
  const [openOrder, setOpenOrder] = useState<string | null>(null)

  /** A line being closed short or reopened — the reason box (if any) asks once both are known. */
  const [lineConfirm, setLineConfirm] = useState<{
    type: 'close' | 'reopen'
    po: WaitingOrder
    line: WaitingLine
  } | null>(null)

  /**
   * The receiving form, and the order it should open on.
   *
   * `null` is closed; a string is the order to start from, and the empty string
   * is the plain "Receive goods" button with nothing chosen yet.
   */
  const [dialog, setDialog] = useState<string | null>(null)

  /** The receipt being corrected, or null when the form above is closed. */
  const [editGrnId, setEditGrnId] = useState<string | null>(null)
  const [qcGrnId, setQcGrnId] = useState<string | null>(null)
  /** The receipt whose files are open, off the paperclip on its row. */
  const [filesFor, setFilesFor] = useState<{
    id: string
    number: string
    kind: 'order' | 'receipt'
  } | null>(null)

  /** Which receipt is being cancelled or deleted, and which — the reason box asks once both are known. */
  const [confirmAction, setConfirmAction] = useState<{
    type: 'cancel' | 'delete'
    grn: Receipt
  } | null>(null)

  /**
   * Which of the two lists is showing.
   *
   * Opens on what is waiting, because that is the question somebody standing
   * at the gate with a delivery has. The receipts are the record afterwards.
   */
  const [tab, setTab] = useState<'waiting' | 'receipts'>('waiting')

  /**
   * Which of the Goods receipts table's optional columns this browser
   * chooses to show, remembered across visits.
   *
   * Starts at the default — every column on, the table as it always drew —
   * so the server-rendered page and the client's first paint agree; the
   * saved choice, if there is one, is applied straight after in an effect
   * rather than read during render, which is what a `localStorage` read
   * inside `useState` would do and hydration cannot forgive.
   */
  const [visibleCols, setVisibleCols] = useState<Set<string>>(new Set(RECEIPT_DEFAULT_COLS))

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(RECEIPT_COLUMNS_STORAGE_KEY)
      if (!saved) return
      const known = new Set(RECEIPT_DEFAULT_COLS)
      const kept = (JSON.parse(saved) as string[]).filter((k) => known.has(k))
      setVisibleCols(new Set(kept))
    } catch {
      // A corrupt or blocked store just keeps the default columns.
    }
  }, [])

  const toggleReceiptColumn = (key: string) => {
    setVisibleCols((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        window.localStorage.setItem(RECEIPT_COLUMNS_STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // Not worth reporting — the choice still holds for the rest of this visit.
      }
      return next
    })
  }

  const resetReceiptColumns = () => {
    setVisibleCols(new Set(RECEIPT_DEFAULT_COLS))
    try {
      window.localStorage.removeItem(RECEIPT_COLUMNS_STORAGE_KEY)
    } catch {
      // Same as above.
    }
  }

  const shownReceiptCols = RECEIPT_COLUMNS.filter((c) => c.locked || visibleCols.has(c.key))

  /*
   * The suppliers that actually appear on this screen.
   *
   * Built from the rows rather than fetched from the master. The mill has
   * seventeen suppliers today and will have two hundred; a dropdown listing
   * every one of them, most with nothing outstanding, is a list to scroll
   * rather than a filter. This one only offers names there is something to
   * find under.
   */
  /*
   * The filters, shared by both tabs.
   *
   * One set, not two. He asked for them beside the tabs, and a row of controls
   * that silently emptied and refilled as the tab changed would be a row you
   * could not trust — so switching tabs keeps the supplier, the item, the
   * dates and the words, and only the status list changes, because "part
   * received" is a thing an order can be and a receipt cannot.
   */
  const [supplierId, setSupplierId] = useState('')
  const [itemId, setItemId] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [waitSearch, setWaitSearch] = useState('')
  const [waitStatus, setWaitStatus] = useState('')

  const [waiting, setWaiting] = useState<WaitingOrder[]>([])
  const [waitingError, setWaitingError] = useState(false)

  /*
   * Every name these two filters have shown, kept rather than recomputed.
   *
   * Without this a filter can erase its own selection: narrow to one supplier
   * and then add a date range that matches nothing, and the rows the list was
   * built from are gone — so the chosen name drops out of its own dropdown,
   * the box falls back to displaying "All suppliers", and the filter is still
   * applied underneath. A control saying one thing while doing another is the
   * worst of the three possible outcomes; an extra name in a list is the
   * mildest.
   *
   * It also fills the gap left by the receipts being paged: page through the
   * list once and the dropdowns hold everything that went past.
   */
  const seenSuppliers = useRef(new Map<string, string>())
  const seenItems = useRef(new Map<string, { code: string; name: string }>())

  /*
   * Everything that has ever been received, asked for once.
   *
   * Without it these two filters could only offer what the current page
   * happened to contain, so a receipt on page four was unreachable by its own
   * supplier's name. Held in state rather than in the refs above so its
   * arrival re-renders the dropdowns; it is merged with them, not substituted
   * for them, because the orders still awaiting goods belong in the same list
   * and are known before this lands.
   */
  const [receivedEver, setReceivedEver] = useState<{
    suppliers: Array<{ id: string; name: string }>
    items: Array<{ id: string; code: string; name: string }>
  }>({ suppliers: [], items: [] })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await api.get<{
          data: {
            suppliers: Array<{ id: string; name: string }>
            items: Array<{ id: string; code: string; name: string }>
          }
        }>('/purchase/grn/filter-options')
        if (!cancelled) setReceivedEver(res.data)
      } catch {
        // The dropdowns still work off what is on screen. A filter offering
        // fewer names is a smaller problem than an error banner over a list
        // that loaded perfectly well.
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
   * Arriving from a purchase order row.
   *
   * `?receive=<id>` opens the form already on that order — the Add GRN button
   * on the order list. `?q=PO-0002` fills the search box instead, which is the
   * history of one order's receipts. Read once, on the way in: after that the
   * screen is the user's, and re-applying the address every render would fight
   * whatever they typed next. Read off `window.location` rather than through
   * `useSearchParams`, which would oblige this page to carry a Suspense
   * boundary it has no other use for.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const receive = params.get('receive')
    if (receive) setDialog(receive)
    const q = params.get('q')
    if (q) {
      setSearch(q)
      setDebounced(q)
      // A search is a question about receipts already made, so land on them
      // rather than on the queue of what is still owed.
      setTab('receipts')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * The list's query string, built once.
   *
   * The export calls this too, so a filtered screen and the file it produces
   * cannot describe two different lists.
   *
   * Filtered at the server, unlike the waiting list: receipts are an archive
   * that grows for ever and this page only ever holds fifty of them, so
   * filtering in the browser would filter the page and not the list.
   */
  const query = (p: number, limit: number) => {
    const qs = new URLSearchParams({ page: String(p), limit: String(limit) })
    if (debounced) qs.set('q', debounced)
    if (status) qs.set('status', status)
    if (supplierId) qs.set('supplierId', supplierId)
    if (itemId) qs.set('itemId', itemId)
    if (fromDate) qs.set('from', fromDate)
    if (toDate) qs.set('to', toDate)
    return `/purchase/grn?${qs}`
  }

  /**
   * One row per item received, not one per receipt.
   *
   * A receipt's whole substance is its lines — what turned up, how much was
   * taken and how much went back. One row per receipt would have to render
   * that as "2 items", which is the one thing a spreadsheet cannot work with.
   * The receipt's own details repeat down its lines, so the file pivots by
   * item, by supplier or by month without any further preparation.
   *
   * The orders export goes the other way, one row per order, because an order
   * carries money: repeating its total against every line would double-count
   * the moment somebody put a sum under the column.
   */
  const exportRows = (list: Receipt[]): ExportRow[] =>
    list.flatMap<ExportRow>((g) =>
      g.lines.length ? g.lines.map((l) => ({ g, l })) : [{ g, l: null }]
    )

  const EXPORT_COLUMNS: ExportColumn<ExportRow>[] = [
    { header: 'GRN No.', value: ({ g }) => g.grnNumber },
    { header: 'Received On', value: ({ g }) => asDate(g.grnDate) },
    { header: 'Status', value: ({ g }) => stage(g.status).label },
    { header: 'Order No.', value: ({ g }) => g.po?.poNumber ?? '' },
    { header: 'Supplier', value: ({ g }) => g.po?.supplier?.name ?? '' },
    { header: 'Challan No.', value: ({ g }) => g.challanNo ?? '' },
    { header: 'Challan Date', value: ({ g }) => asDate(g.challanDate) },
    { header: 'Gate Entry', value: ({ g }) => g.gateEntryNo ?? '' },
    { header: 'Vehicle', value: ({ g }) => g.vehicleNo ?? '' },
    { header: 'Supplier Bill No.', value: ({ g }) => g.supplierInvoiceNo ?? '' },
    { header: 'Supplier Bill Date', value: ({ g }) => asDate(g.supplierInvoiceDate) },
    { header: 'Item Code', value: ({ l }) => l?.item.code ?? '' },
    { header: 'Item', value: ({ l }) => l?.item.name ?? '' },
    { header: 'UOM', value: ({ l }) => l?.item.uom?.symbol ?? '' },
    { header: 'Ordered', value: ({ l }) => asNumber(l?.orderedQty) },
    { header: 'Received', value: ({ l }) => asNumber(l?.receivedQty) },
    { header: 'Rejected', value: ({ l }) => asNumber(l?.rejectedQty) },
    { header: 'Into Stock', value: ({ l }) => asNumber(l?.acceptedQty) },
    { header: 'Store', value: ({ l }) => l?.warehouse.name ?? '' },
    { header: 'Batch', value: ({ l }) => l?.batchNumber ?? '' },
    { header: 'Billing', value: ({ g }) => billStage(g)?.label ?? '' },
    { header: 'Billed On', value: ({ g }) => (g.bills ?? []).map((b) => b.billNumber).join(', ') },
    { header: 'Files', value: ({ g }) => g._count?.attachments ?? 0 },
    { header: 'Notes', value: ({ g }) => g.notes ?? '' },
  ]

  /**
   * The same filters, built as a report rather than as a grid.
   *
   * Receipts, whichever tab is showing — the same subject the plain export
   * has always had. The waiting list is a view of orders, not of receipts,
   * and a button that silently changed what it reported on between two tabs
   * would be the least findable bug on this screen.
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
      setMessage(describeReport(await downloadReport('goods-receipt-register', 'xlsx', params)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The report could not be built.')
    }
  }

  const exportList = async (format: ExportFormat) => {
    setError(null)
    try {
      const { rows: all, total, truncated } = await fetchEveryPage<Receipt>((p) => query(p, 100))
      const flat = exportRows(all)
      if (flat.length === 0) {
        setMessage('Nothing to export — no receipts match these filters.')
        return
      }
      await downloadRows({
        rows: flat,
        columns: EXPORT_COLUMNS,
        name: 'goods-receipts',
        sheet: 'Goods Receipts',
        format,
      })
      setMessage(
        truncated
          ? `Exported the first ${all.length} of ${total} receipts. Narrow the filters to get the rest.`
          : `Exported ${all.length} ${all.length === 1 ? 'receipt' : 'receipts'} as ${flat.length} rows, one per item.`
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the export.')
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<Paginated<Receipt>>(query(page, PER_PAGE))
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing goods receipts.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [debounced, status, supplierId, itemId, fromDate, toDate, page])

  /**
   * The orders still owed goods.
   *
   * Two statuses, because an order that has had part of a delivery booked in
   * is still waiting for the rest and must not drop off this list. A draft
   * never appears: the server refuses a receipt against one, so offering it
   * here would be a door that is certain to be shut.
   *
   * Its own loader rather than part of `load`, so the search box and the pager
   * — which belong to the receipts below — do not refetch it on every
   * keystroke.
   */
  const loadWaiting = useCallback(async () => {
    setWaitingError(false)
    try {
      const [sent, partly] = await Promise.all([
        api.get<Paginated<WaitingOrder>>('/purchase/orders?status=SENT&limit=100'),
        api.get<Paginated<WaitingOrder>>('/purchase/orders?status=PARTIALLY_RECEIVED&limit=100'),
      ])
      setWaiting([...sent.data, ...partly.data])
    } catch {
      setWaiting([])
      setWaitingError(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadWaiting()
  }, [loadWaiting])

  // Narrowing a filter while on page 3 would show an empty page 3 of a shorter
  // list, which reads as "nothing found" rather than "you moved".
  useEffect(() => {
    setPage(1)
  }, [debounced, status, supplierId, itemId, fromDate, toDate])

  /*
   * What the two filters can offer.
   *
   * Both lists were built from `waiting` alone — the orders still owed goods.
   * The filters are shared by both tabs, though, and the receipts tab is a
   * different set of documents entirely: once every order has been received in
   * full, `waiting` is empty and both dropdowns offered nothing but "All
   * suppliers" and "All items" while five receipts from a named supplier sat
   * on the screen underneath them. A filter that cannot name the only supplier
   * in the list is not a narrow filter, it is a broken one.
   *
   * So both sources are read — the orders still waiting, and the receipts on
   * screen. The original intent stands: this offers names there is something
   * to find under, rather than the whole master. What it now counts as
   * "something to find" includes what has already arrived.
   *
   * One limit worth knowing: the receipts are paged by the server, so these
   * cover the page in front of you plus everything still on order. Narrowing
   * Three sources, deduped: everything ever received (asked for once, from
   * `/purchase/grn/filter-options`), everything still on order, and whatever
   * is on the page right now. The first of those is what closes the gap the
   * paging used to leave — a supplier whose only receipts are on page four is
   * offered before that page is ever opened.
   */
  const waitingSuppliers = useMemo(() => {
    const seen = seenSuppliers.current
    for (const s of receivedEver.suppliers) seen.set(s.id, s.name)
    for (const po of waiting) if (po.supplier) seen.set(po.supplier.id, po.supplier.name)
    for (const grn of rows) {
      if (grn.po.supplier) seen.set(grn.po.supplier.id, grn.po.supplier.name)
    }
    return [...seen]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [waiting, rows, receivedEver])

  /** Every item on order or ever received, in name order, no repeats. */
  const waitingItems = useMemo(() => {
    const seen = seenItems.current
    for (const it of receivedEver.items) seen.set(it.id, { code: it.code, name: it.name })
    for (const po of waiting) {
      for (const l of po.lines ?? []) {
        if (l.item) seen.set(l.item.id, { code: l.item.code, name: l.item.name })
      }
    }
    for (const grn of rows) {
      for (const l of grn.lines) {
        if (l.item) seen.set(l.item.id, { code: l.item.code, name: l.item.name })
      }
    }
    return [...seen].map(([id, v]) => ({ id, ...v })).sort((a, b) => a.name.localeCompare(b.name))
  }, [waiting, rows, receivedEver])

  /*
   * Filtered here rather than at the server. The whole list is already in the
   * browser — it is every order still owed goods, which is a working list and
   * not an archive — so a round trip per keystroke would buy nothing.
   */
  const waitingShown = useMemo(() => {
    const q = waitSearch.trim().toLowerCase()
    return waiting.filter((po) => {
      if (supplierId && po.supplier?.id !== supplierId) return false
      if (waitStatus && po.status !== waitStatus) return false
      if (itemId && !(po.lines ?? []).some((l) => l.item?.id === itemId)) return false

      /*
       * Compared as text, not as dates.
       *
       * The boxes hand back YYYY-MM-DD and the order's date arrives as an ISO
       * string that starts with exactly that. Both ends are inclusive, which
       * is what somebody typing the same day into both boxes means.
       */
      if (fromDate || toDate) {
        const day = String(po.poDate).slice(0, 10)
        if (fromDate && day < fromDate) return false
        if (toDate && day > toDate) return false
      }

      if (!q) return true
      return [
        po.poNumber,
        po.supplier?.name,
        po.reference,
        ...(po.lines ?? []).flatMap((l) => [l.item?.name, l.item?.code]),
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    })
  }, [waiting, waitSearch, waitStatus, supplierId, itemId, fromDate, toDate])

  const anyFilter = Boolean(
    waitSearch || search || supplierId || itemId || fromDate || toDate || waitStatus || status
  )

  /** Puts every filter back, whichever tab is showing. */
  const clearFilters = () => {
    setWaitSearch('')
    setSearch('')
    setSupplierId('')
    setItemId('')
    setFromDate('')
    setToDate('')
    setWaitStatus('')
    setStatus('')
  }

  const cancel = async (grn: Receipt, reason: string) => {
    setBusy(grn.id)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/purchase/grn/${grn.id}/cancel`, {
        reason,
      })
      setConfirmAction(null)
      await load()
      // Cancelling hands the quantity back to the order, which can put it back
      // on the waiting list or move it off completed.
      void loadWaiting()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel it.')
    } finally {
      setBusy(null)
    }
  }

  /*
   * Removing a receipt for good, not the ordinary undo. If it is still live,
   * the server reverses its stock first — refusing outright if any of that
   * stock has already left the warehouse — so this can never delete a
   * receipt while leaving its movement sitting unexplained on the ledger.
   */
  const remove = async (grn: Receipt, reason: string) => {
    setBusy(grn.id)
    setError(null)
    setMessage(null)
    try {
      const res = await api.delete<{ message?: string }>(`/purchase/grn/${grn.id}`, { reason })
      setConfirmAction(null)
      await load()
      void loadWaiting()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete it.')
    } finally {
      setBusy(null)
    }
  }

  /*
   * Tells one line that the rest of it is not coming, instead of leaving the
   * order "Part received" forever waiting on a delivery that will not arrive.
   * Reversible — `reopenLine` below undoes it — so this is a decision recorded
   * with a reason, not a deletion.
   */
  const closeLineShort = async (po: WaitingOrder, line: WaitingLine, reason: string) => {
    setBusy(line.id)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(
        `/purchase/orders/${po.id}/lines/${line.id}/short-close`,
        { reason }
      )
      setLineConfirm(null)
      void loadWaiting()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not close that line.')
    } finally {
      setBusy(null)
    }
  }

  const reopenLine = async (po: WaitingOrder, line: WaitingLine) => {
    setBusy(line.id)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(
        `/purchase/orders/${po.id}/lines/${line.id}/reopen`,
        {}
      )
      setLineConfirm(null)
      void loadWaiting()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reopen that line.')
    } finally {
      setBusy(null)
    }
  }

  /** What can be done to one receipt, in words, behind a single Actions button. */
  const rowActions = (grn: Receipt): RowAction[] => {
    const items: RowAction[] = [
      {
        key: 'view',
        label: 'View / print',
        icon: <Printer size={14} />,
        href: `/print/goods-receipt/${grn.id}`,
        newTab: true,
      },
    ]
    if (grn.status !== 'CANCELLED') {
      /*
       * Billing: whichever of the two this receipt is actually at.
       *
       * "Book a bill for this" used to sit on every live receipt, the ones
       * already billed in full included. Pressing it there could only end one
       * way — the bill form opens, gathers nothing, and says everything on the
       * receipt has already been billed. Read off the menu, though, it looks
       * like a second bill is the ordinary next step, and a clerk working
       * through a stack of supplier invoices has no reason to think otherwise.
       * So the line is decided by what is genuinely left, and a receipt that
       * is settled offers the bill it is settled on instead.
       *
       * `pendingQty` is counted by the API over bills that are not cancelled.
       * Cancel the bill and the receipt is waiting on one again the moment the
       * list reloads — the way back is to cancel and raise it afresh, never to
       * put a second bill on top.
       */
      const leftToBill = Number(grn.billing?.pendingQty ?? 0)
      const billedOn = grn.bills ?? []

      // One line per bill, not just the first. A receipt split across two
      // supplier invoices names both, rather than picking one and leaving the
      // other with nowhere to be opened from.
      for (const b of billedOn) {
        items.push({
          key: `view-bill-${b.id}`,
          label: `View bill ${b.billNumber}`,
          icon: <ReceiptIndianRupee size={14} />,
          href: `/print/purchase-bill/${b.id}`,
          newTab: true,
        })
      }

      if (leftToBill > 0) {
        items.push({
          // The old ERP's "Add Bill From GRN", in the same place: beside the
          // receipt, where somebody holding the supplier's invoice is already
          // looking. It opens the bill form with this receipt's lines already
          // gathered, rather than making them find it from the other end.
          key: 'bill',
          label: billedOn.length ? 'Bill what is still left' : 'Book a bill for this',
          icon: <ReceiptIndianRupee size={14} />,
          href: `/purchase/bills?fromGrn=${grn.id}`,
        })
      }

      /*
       * Cancelling and deleting stop the moment a bill or a note has hold of
       * the receipt. Correcting does not.
       *
       * Both were on the menu of a receipt that was billed and paid, and
       * either would have broken something behind the screen: the stock
       * ledger says these goods came in, the bill says they were bought, the
       * payment says they were paid for, and all three were written off one
       * another. Taking the receipt away leaves the other two standing on a
       * document that no longer records the goods arriving. The way to undo a
       * billed receipt is to cancel the bill first — a reversal with paperwork
       * behind it.
       *
       * Correcting is left alone, because a correction is not an undo. Most of
       * a receipt — the vehicle, the challan number, the dates, the note, and
       * any quantity not yet claimed — can be put right without making one
       * word of a posted document untrue, and the server checks that line by
       * line rather than by the presence of a bill. Hiding it would have made
       * a mis-typed vehicle number on a part-billed receipt cost a cancelled
       * invoice to fix.
       */
      const heldByBill = billedOn.length > 0
      /*
       * A quality check moved rejected goods out of this receipt's godowns on
       * the strength of its quantities, so the receipt stays as it is while a
       * check stands on it. Shown and greyed rather than hidden, so the way to
       * a correction — cancel the check first — is on the menu itself.
       */
      const heldByQc = grn.qc
        ? { disabled: true, hint: 'Cancel its QC first (Quality check → Cancel QC)' }
        : {}

      items.push({
        key: 'qc',
        label: grn.qc ? 'Quality check — view / cancel' : 'Quality check (QC)',
        icon: <ClipboardCheck size={14} />,
        onClick: () => setQcGrnId(grn.id),
      })

      items.push(
        ...(grn.lines.some((l) => Number(l.rejectedQty) > 0)
          ? [
              {
                // What was rejected here never gets billed, so it has no
                // other way onto a debit note. Beside "Book a bill for
                // this" for the same reason that one is: whoever is
                // looking at the receipt is who knows what to claim back.
                //
                // Blocked until a bill exists, even though the note itself
                // does not need one — raising it this early reads as the
                // normal order (bill, then note against it) being skipped,
                // which is what caused the confusion this button is now
                // held back from causing again. Once a bill exists, `fromBill`
                // rides along too so the note is raised against that bill's
                // line — checked for real — rather than the receipt alone.
                key: 'note',
                label: 'Raise a note for the rejected qty',
                icon: <FileMinus size={14} />,
                ...(grn.bills?.length
                  ? {
                      href: `/purchase/debit-notes?fromGrn=${grn.id}&fromBill=${grn.bills[0].id}`,
                    }
                  : { disabled: true, hint: 'Book a bill for this receipt first' }),
              },
            ]
          : []),
        {
          key: 'edit',
          label: 'Correct this receipt',
          icon: <Pencil size={14} />,
          onClick: () => setEditGrnId(grn.id),
          ...heldByQc,
        },
        ...(heldByBill
          ? []
          : [
              {
                key: 'cancel',
                label: 'Cancel',
                icon: <Ban size={14} />,
                onClick: () => setConfirmAction({ type: 'cancel', grn }),
                danger: true,
                ...heldByQc,
              },
            ])
      )
    }
    // Deleting is the last one, and it goes for the same reason: the bill's
    // line points at this receipt's line, so removing it would leave the bill
    // describing goods with no record of arriving.
    if (!(grn.bills ?? []).length) {
      items.push({
        key: 'delete',
        label: 'Delete for good',
        icon: <Trash2 size={14} />,
        onClick: () => setConfirmAction({ type: 'delete', grn }),
        danger: true,
        ...(grn.qc
          ? { disabled: true, hint: 'Cancel its QC first (Quality check → Cancel QC)' }
          : {}),
      })
    }
    return items
  }

  /** One row's content for one column of the Goods receipts table, by key. */
  const receiptCell = (
    key: string,
    grn: Receipt,
    s: { label: string; cls: string },
    t: { received: number; accepted: number; rejected: number }
  ) => {
    switch (key) {
      case 'number':
        return (
          <a
            href={`/print/goods-receipt/${grn.id}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-teal-400 hover:underline"
            title={`Open the printed sheet for ${grn.grnNumber}`}
          >
            {grn.grnNumber}
          </a>
        )
      case 'against':
        return (
          <a
            href={`/print/purchase-order/${grn.po.id}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-teal-400 hover:underline"
            title="Open this order's PDF"
          >
            {grn.po.poNumber}
          </a>
        )
      case 'supplier':
        return <div className="max-w-[15rem] truncate text-sm">{grn.po.supplier?.name ?? '—'}</div>
      case 'challanNo':
        return grn.challanNo ? (
          <span className="text-foreground font-mono">{grn.challanNo}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      case 'challanDate':
        return grn.challanDate ? (
          formatDate(grn.challanDate)
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      case 'gate':
        return grn.gateEntryNo ?? <span className="text-muted-foreground">—</span>
      case 'receivedDate':
        return formatDate(grn.grnDate)
      case 'vehicle':
        return grn.vehicleNo ?? <span className="text-muted-foreground">—</span>
      case 'supplierBillNo':
        return grn.supplierInvoiceNo ?? <span className="text-muted-foreground">—</span>
      case 'supplierBillDate':
        return grn.supplierInvoiceDate ? (
          formatDate(grn.supplierInvoiceDate)
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      case 'items':
        // Just the count here — the names are what "Show items" on this
        // row opens the panel below for, and repeating them in the row
        // itself was what forced this column, and the ones after it,
        // wider than their own content needed.
        return <span className="tabular-nums">{grn.lines.length}</span>
      case 'receivedQty':
        return qty(t.received)
      case 'accepted':
        return qty(t.accepted)
      case 'rejected':
        return t.rejected > 0 ? (
          <span className="text-red-400">{qty(t.rejected)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      case 'status':
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className={s.cls}>{s.label}</span>
            <QcBadge qc={grn.qc} />
          </span>
        )
      case 'billing': {
        const b = billStage(grn)
        if (!b) return <span className="text-muted-foreground">—</span>
        return (
          <>
            <span className={b.cls}>{b.label}</span>
            {grn.bills && grn.bills.length > 0 && (
              <div className="text-muted-foreground mt-0.5 font-mono text-[10px]">
                {grn.bills.map((x) => x.billNumber).join(', ')}
              </div>
            )}
          </>
        )
      }
      case 'files':
        return (
          <FilesCell
            count={grn._count?.attachments ?? 0}
            onOpen={() => setFilesFor({ id: grn.id, number: grn.grnNumber, kind: 'receipt' })}
            what="on this receipt"
          />
        )
      default:
        return null
    }
  }

  return (
    <div className="space-y-5">
      {/* `gap-3` without `flex-wrap` — see Purchase Orders for why: refresh,
        Export and the primary button stay on the title's own row at every
        width instead of dropping under it. */}
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Goods Receipt</h1>
          {/* Desk only. On a phone the screen is short and the heading
            already says what this is — the sentence under it cost a line of
            a list somebody is scrolling. */}
          <p className="page-subtitle hidden sm:block">
            What has arrived against your purchase orders
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            className="btn-ghost"
            onClick={() => {
              void load()
              void loadWaiting()
            }}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {tab === 'receipts' && (
            <ColumnsButton
              columns={RECEIPT_TOGGLEABLE}
              visible={visibleCols}
              onToggle={toggleReceiptColumn}
              onReset={resetReceiptColumns}
            />
          )}
          <ExportButton onExport={exportList} onReport={exportReport} disabled={loading} />
          <button className="btn-primary" onClick={() => setDialog('')} aria-label="Receive goods">
            <Plus size={15} /> <span className="hidden sm:inline">Receive goods</span>
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
        {/* Two lists, one card.

          They answer two different questions — what is owed to us, and what
          has turned up — and both belong on this screen: a store keeper
          arrives holding a challan and needs the order it is against, then
          wants to see the receipt they just made. In a box of its own above
          the list the first one read as a banner rather than as work. */}
        {/* ── Rows on a phone, one flowing row at a desk ─────────────────

          Five full-width controls stacked five deep took a third of a phone
          screen before a single order showed. Grouped, they take two rows:
          what you type and when, then the three things you pick.

          The grouping wrappers are `sm:contents`, so above a phone they stop
          existing and their children rejoin the one wrapping row they were
          always in. That keeps a single set of controls rather than one set
          per layout, which is how these bars end up disagreeing with
          themselves. The same arrangement as the purchase order list. */}
        <div className="border-border flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
          {/* A pair of pills, not underlined tabs. They now sit in a row of
            controls, and a rule under one of them reads as a stray line rather
            than as the thing that is selected. */}
          <div className="bg-secondary/60 flex shrink-0 gap-1 rounded-lg p-0.5" role="tablist">
            {(
              [
                ['waiting', 'Waiting for goods', waiting.length],
                ['receipts', 'Goods receipts', total],
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

          {/* Search on its own line at a phone width, the two dates on the
            one under it — sharing a row with a fixed-width date pair left
            the search box too narrow to read what was typed into it. See
            the same fix on Supplier Payments. `sm:contents` still
            dissolves both back into the one row a tablet or a desk has
            the width for. */}
          <div className="flex flex-col gap-2 sm:contents">
            {/* One box for words, whichever list is showing. It reaches item
              names and codes as well as the order and the supplier, so
              "poplin" finds the order that has poplin on it — which is what
              the title says, because the placeholder no longer has room to.

              The magnifying glass is a desk luxury: it costs 22px of a row
              that already has two date boxes in it, and a box you type into
              needs no icon to explain itself. */}
            <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 sm:min-w-[150px] sm:max-w-[190px] sm:basis-0 sm:px-2.5">
              <Search size={14} className="text-muted-foreground hidden shrink-0 sm:block" />
              <input
                className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
                placeholder="Search..."
                title={
                  tab === 'waiting'
                    ? 'Reaches the order, the supplier, and the items on it'
                    : 'Reaches the receipt, the order, the supplier, and the items on it'
                }
                value={tab === 'waiting' ? waitSearch : search}
                onChange={(e) =>
                  tab === 'waiting' ? setWaitSearch(e.target.value) : setSearch(e.target.value)
                }
                aria-label="Search"
              />
            </div>

            {/* Two dates, not a preset list. A mill asks "what came in between
              the 3rd and the 11th" far more often than it asks for last month,
              and either end on its own is a valid question: everything since
              the 3rd, everything up to the 11th.

              The word between them is a desk luxury too — on a phone the two
              boxes sitting against each other say the same thing for 18px
              less, and those 18px go to the box you type in. */}
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

          <div className="flex items-center gap-1 sm:contents">
            <select
              className="form-input h-8 min-w-0 grow basis-[6.6rem] px-1 py-0 text-[10px] sm:w-32 sm:flex-none sm:px-3 sm:text-xs"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              aria-label="Filter by supplier"
            >
              <option value="">All suppliers</option>
              {waitingSuppliers.map((sup) => (
                <option key={sup.id} value={sup.id}>
                  {sup.name}
                </option>
              ))}
            </select>

            {/* Built from what is actually on order, not from the item master.
              The mill has forty items today and will have four hundred; a list
              of every one of them, most with nothing outstanding, is something
              to scroll rather than a filter. */}
            <select
              className="form-input h-8 min-w-0 grow basis-[4.85rem] px-1 py-0 text-[10px] sm:w-36 sm:flex-none sm:px-3 sm:text-xs"
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              aria-label="Filter by item"
            >
              <option value="">All items</option>
              {waitingItems.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                </option>
              ))}
            </select>

            {/* The one filter the two lists cannot share: an order can be part
              received and a receipt cannot, and a receipt can be cancelled
              where an order on this list never is. */}
            {tab === 'waiting' ? (
              <select
                className="form-input h-8 min-w-0 grow basis-[8.95rem] px-1 py-0 text-[10px] sm:w-36 sm:flex-none sm:px-3 sm:text-xs"
                value={waitStatus}
                onChange={(e) => setWaitStatus(e.target.value)}
                aria-label="Filter by how much has arrived"
              >
                <option value="">Anything still due</option>
                <option value="SENT">Nothing arrived yet</option>
                <option value="PARTIALLY_RECEIVED">Part received</option>
              </select>
            ) : (
              <select
                className="form-input h-8 min-w-0 grow basis-[8.95rem] px-1 py-0 text-[10px] sm:w-36 sm:flex-none sm:px-3 sm:text-xs"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                aria-label="Filter by status"
              >
                <option value="">Any status</option>
                <option value="ACCEPTED">Received</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            )}
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
              {tab === 'waiting'
                ? waitingShown.length === waiting.length
                  ? `${waiting.length} ${waiting.length === 1 ? 'order' : 'orders'}`
                  : `${waitingShown.length} of ${waiting.length}`
                : `${total} ${total === 1 ? 'receipt' : 'receipts'}`}
            </span>
          </div>
        </div>

        {tab === 'waiting' ? (
          <>
            {waitingError ? (
              <p className="text-muted-foreground px-4 py-8 text-sm">
                Could not load the open orders. Press refresh above to try again.
              </p>
            ) : waitingShown.length === 0 ? (
              <p className="text-muted-foreground px-4 py-10 text-center text-sm">
                {waiting.length === 0
                  ? 'Nothing is waiting. Every order you have sent has been received in full.'
                  : 'No order matches those filters. Clear them to see the rest.'}
              </p>
            ) : (
              <div className="list-scope">
                {/* ── On a phone, not a table ────────────────────────────────

                  This tab had no such thing until now: eleven columns behind
                  a 1080px floor and a sideways drag, at every width including
                  the laptop everyone here uses. It is the one screen in
                  purchase that somebody stands at a gate with a phone to use,
                  and it was the one screen you could not.

                  What is due is the figure the whole tab exists for, so it
                  sits where the money sits on the other cards — hard right of
                  the first line — and Receive is a full-width press rather
                  than a 13px icon. */}
                <div className="list-cards divide-border divide-y">
                  {waitingShown.map((po) => {
                    const part = po.status === 'PARTIALLY_RECEIVED'
                    const lines = po.lines ?? []
                    const groups = qtyByUnit(lines)
                    const anyPending = groups.some((g) => g.pending > 0)
                    const expanded = openOrder === po.id
                    const items = itemsPreview(lines.map((l) => l.item?.name))
                    const ordered = qtyPreview(groups, 'ordered')
                    const received = qtyPreview(groups, 'received')
                    const pending = qtyPreview(groups, 'pending')
                    return (
                      <div key={po.id} className="p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <a
                                href={`/print/purchase-order/${po.id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono text-xs font-semibold text-teal-400 hover:underline"
                                title="Open this order's PDF"
                              >
                                {po.poNumber}
                              </a>
                              <span className={part ? 'badge-warning' : 'badge-info'}>
                                {part ? 'Part received' : 'Sent'}
                              </span>
                              {/* The card carries what the table's files
                                column carries, so the two views agree on
                                whether anything is scanned onto the order. */}
                              {po._count?.attachments ? (
                                <button
                                  type="button"
                                  className="text-primary hover:text-primary/80 inline-flex items-center gap-0.5 text-[10px] underline transition"
                                  onClick={() =>
                                    setFilesFor({
                                      id: po.id,
                                      number: po.poNumber,
                                      kind: 'order',
                                    })
                                  }
                                  title={`Open the ${po._count.attachments} file${
                                    po._count.attachments === 1 ? '' : 's'
                                  } attached to ${po.poNumber}`}
                                >
                                  <Paperclip size={10} />
                                  {po._count.attachments}
                                </button>
                              ) : null}
                            </div>
                            <p className="text-foreground mt-1 font-medium leading-snug">
                              {po.supplier?.name ?? '—'}
                            </p>
                          </div>
                          <span className="shrink-0 text-right" title={pending.full}>
                            <span
                              className={`block text-sm font-semibold tabular-nums ${
                                anyPending ? 'text-amber-500' : 'text-muted-foreground'
                              }`}
                            >
                              {pending.shown}
                              {pending.extra}
                            </span>
                            <span className="text-muted-foreground block text-[10px]">
                              still due
                            </span>
                          </span>
                        </div>

                        <dl className="mt-2.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                          <dt className="text-muted-foreground">Ordered</dt>
                          <dd className="text-foreground min-w-0 tabular-nums" title={ordered.full}>
                            {ordered.shown}
                            {ordered.extra}
                          </dd>
                          <dt className="text-muted-foreground">Received</dt>
                          <dd
                            className="text-foreground min-w-0 tabular-nums"
                            title={received.full}
                          >
                            {received.shown}
                            {received.extra}
                          </dd>
                          <dt className="text-muted-foreground">Ordered on</dt>
                          <dd className="text-foreground min-w-0">{formatDate(po.poDate)}</dd>
                          {po.reference ? (
                            <>
                              <dt className="text-muted-foreground">Reference</dt>
                              <dd className="text-foreground min-w-0 truncate">{po.reference}</dd>
                            </>
                          ) : null}
                          <dt className="text-muted-foreground">Items</dt>
                          <dd className="text-foreground min-w-0 truncate" title={items.full}>
                            {lines.length} {lines.length === 1 ? 'item' : 'items'}
                            {items.shown ? (
                              <span className="text-muted-foreground">
                                {' '}
                                · {items.shown}
                                {items.extra}
                              </span>
                            ) : null}
                          </dd>
                        </dl>

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            onClick={() => setOpenOrder(expanded ? null : po.id)}
                            disabled={lines.length === 0}
                            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                              lines.length === 0
                                ? 'text-muted-foreground cursor-not-allowed opacity-50'
                                : 'bg-primary/10 text-primary hover:bg-primary/20'
                            }`}
                            aria-expanded={expanded}
                          >
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            {expanded ? 'Hide items' : 'Show items'}
                          </button>
                          <button
                            className="btn-ghost border-border ml-auto h-8 rounded-lg border px-2.5 text-xs"
                            onClick={() => {
                              setTab('receipts')
                              setSearch(po.poNumber)
                              setStatus('')
                            }}
                            title={`Show the receipts already made against ${po.poNumber}`}
                          >
                            History
                          </button>
                          <button
                            className="btn-primary h-8 px-3 text-xs"
                            onClick={() => setDialog(po.id)}
                          >
                            <PackageCheck size={14} /> Receive
                          </button>
                        </div>

                        {expanded && lines.length > 0 && (
                          <div className="border-border bg-secondary/40 mt-2.5 max-h-[22rem] space-y-2 overflow-y-auto rounded-lg border p-2">
                            {lines.map((line) => (
                              <div
                                key={line.id}
                                className="border-border bg-card rounded-lg border p-2.5"
                              >
                                <p className="text-foreground text-sm font-medium leading-snug">
                                  {line.item?.name ?? '—'}
                                </p>
                                <p className="text-muted-foreground mt-0.5 truncate text-[10px]">
                                  <span className="font-mono">{line.item?.code ?? '—'}</span>
                                  {(line.style?.code || line.styleNo) && (
                                    <> · {line.style?.code ?? line.styleNo}</>
                                  )}
                                </p>
                                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                                  <div>
                                    <dt className="text-muted-foreground text-[10px] uppercase tracking-wider">
                                      Ordered
                                    </dt>
                                    <dd className="text-foreground tabular-nums">
                                      {qty(line.qty)} {line.item?.uom?.symbol ?? ''}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="text-muted-foreground text-[10px] uppercase tracking-wider">
                                      Received
                                    </dt>
                                    <dd className="text-foreground tabular-nums">
                                      {qty(line.receivedQty)}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="text-muted-foreground text-[10px] uppercase tracking-wider">
                                      Rejected
                                    </dt>
                                    <dd className="tabular-nums">
                                      {Number(line.rejectedQty) > 0 ? (
                                        <span className="text-red-400">
                                          {qty(line.rejectedQty)}
                                        </span>
                                      ) : (
                                        <span className="text-muted-foreground">—</span>
                                      )}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="text-muted-foreground text-[10px] uppercase tracking-wider">
                                      Still due
                                    </dt>
                                    <dd className="tabular-nums">
                                      {line.shortClosed ? (
                                        <span
                                          className="text-amber-500"
                                          title={line.shortCloseReason ?? undefined}
                                        >
                                          {shortCloseNoun(line.receivedQty)} ·{' '}
                                          {qty(Number(line.qty) - Number(line.receivedQty))}
                                        </span>
                                      ) : (
                                        <span className="text-foreground">
                                          {qty(Number(line.qty) - Number(line.receivedQty))}
                                        </span>
                                      )}
                                    </dd>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                <div className="list-rows w-full">
                  {/* Every column shows regardless of window width — the
                    table scrolls sideways instead, with a second scrollbar
                    above the header so reaching it never means scrolling
                    past every order first. Never dropped: the order
                    number, the supplier, what is still due, the status,
                    and Receive — still-due is the figure this whole tab
                    exists to show. */}
                  <ScrollableTable>
                    <table className="data-table table-compact min-w-full">
                      <thead>
                        <tr className="bg-secondary">
                          <th style={{ width: 30 }} />
                          <th className="whitespace-nowrap">Order</th>
                          <th className="whitespace-nowrap">Supplier</th>
                          <th className="whitespace-nowrap">Date</th>
                          <th className="whitespace-nowrap">Reference</th>
                          <th className="whitespace-nowrap">Items</th>
                          <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>
                            Total qty
                          </th>
                          <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>
                            Received qty
                          </th>
                          <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>
                            Pending qty
                          </th>
                          <th className="whitespace-nowrap">Status</th>
                          <th className="whitespace-nowrap">Files</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {waitingShown.map((po) => {
                          const part = po.status === 'PARTIALLY_RECEIVED'
                          const lines = po.lines ?? []
                          const groups = qtyByUnit(lines)
                          const anyPending = groups.some((g) => g.pending > 0)
                          const expanded = openOrder === po.id
                          return (
                            <Fragment key={po.id}>
                              <tr>
                                <td>
                                  <button
                                    className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                                      lines.length === 0
                                        ? 'text-muted-foreground cursor-not-allowed opacity-50'
                                        : 'bg-primary/10 text-primary hover:bg-primary/20'
                                    }`}
                                    onClick={() => setOpenOrder(expanded ? null : po.id)}
                                    disabled={lines.length === 0}
                                    title={expanded ? 'Hide items' : 'Show items'}
                                    aria-label={`${expanded ? 'Hide' : 'Show'} items on ${po.poNumber}`}
                                    aria-expanded={expanded}
                                  >
                                    {expanded ? (
                                      <ChevronDown size={14} />
                                    ) : (
                                      <ChevronRight size={14} />
                                    )}
                                  </button>
                                </td>
                                <td className="whitespace-nowrap">
                                  <a
                                    href={`/print/purchase-order/${po.id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="font-mono text-xs font-semibold text-teal-400 hover:underline"
                                    title="Open this order's PDF"
                                  >
                                    {po.poNumber}
                                  </a>
                                </td>
                                <td>
                                  <div className="max-w-[15rem] truncate text-sm">
                                    {po.supplier?.name ?? '—'}
                                  </div>
                                </td>
                                <td className="whitespace-nowrap text-xs">
                                  {formatDate(po.poDate)}
                                </td>
                                <td className="text-xs">
                                  {po.reference || <span className="text-muted-foreground">—</span>}
                                </td>
                                <td className="text-xs">
                                  {lines.length === 0 ? (
                                    <span className="text-muted-foreground">—</span>
                                  ) : (
                                    <>
                                      <div className="text-foreground whitespace-nowrap">
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
                                {/* Three columns, not one net figure — a mixed-unit
                            order cannot be netted into a single "still due"
                            without pretending metres and pieces are the same
                            thing. Grouped by unit and truncated the same way
                            the item list above is, with every group on hover. */}
                                <td className="whitespace-nowrap text-right text-xs tabular-nums">
                                  {(() => {
                                    const p = qtyPreview(groups, 'ordered')
                                    return (
                                      <span title={p.full}>
                                        {p.shown}
                                        {p.extra}
                                      </span>
                                    )
                                  })()}
                                </td>
                                <td className="whitespace-nowrap text-right text-xs tabular-nums">
                                  {(() => {
                                    const p = qtyPreview(groups, 'received')
                                    return (
                                      <span title={p.full}>
                                        {p.shown}
                                        {p.extra}
                                      </span>
                                    )
                                  })()}
                                </td>
                                <td className="whitespace-nowrap text-right text-xs tabular-nums">
                                  {(() => {
                                    const p = qtyPreview(groups, 'pending')
                                    return (
                                      <span
                                        className={
                                          anyPending
                                            ? 'font-medium text-amber-500'
                                            : 'text-muted-foreground'
                                        }
                                        title={p.full}
                                      >
                                        {p.shown}
                                        {p.extra}
                                      </span>
                                    )
                                  })()}
                                </td>
                                <td>
                                  <span className={part ? 'badge-warning' : 'badge-info'}>
                                    {part ? 'Part received' : 'Sent'}
                                  </span>
                                </td>
                                <td className="whitespace-nowrap">
                                  <FilesCell
                                    count={po._count?.attachments ?? 0}
                                    onOpen={() =>
                                      setFilesFor({
                                        id: po.id,
                                        number: po.poNumber,
                                        kind: 'order',
                                      })
                                    }
                                    what={`attached to ${po.poNumber}`}
                                  />
                                </td>
                                <td className="whitespace-nowrap text-right">
                                  <div className="flex justify-end gap-1.5">
                                    <button
                                      className="btn-primary h-7 px-2.5 text-xs"
                                      onClick={() => setDialog(po.id)}
                                    >
                                      <PackageCheck size={13} /> Receive
                                    </button>
                                    <button
                                      className="btn-ghost border-border h-7 rounded-lg border px-2.5 text-xs"
                                      onClick={() => {
                                        setTab('receipts')
                                        setSearch(po.poNumber)
                                        setStatus('')
                                      }}
                                      title={`Show the receipts already made against ${po.poNumber}`}
                                    >
                                      History
                                    </button>
                                  </div>
                                </td>
                              </tr>

                              {expanded && lines.length > 0 && (
                                <tr>
                                  <td colSpan={12} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                                    {/* Sized to the *visible* row, not the cell.
                                    This `td` spans a table that now scrolls sideways —
                                    its own box is however wide the table's columns add
                                    up to, often well past the screen — so a plain
                                    `w-full` panel inside it stretched nine columns of
                                    mostly short figures out across all of that, and a
                                    fixed cap just swapped "too wide" for "too narrow"
                                    on a bigger screen. `100cqw` asks the nearest sized
                                    ancestor instead — `.list-scope`, which is the row's
                                    own on-screen width regardless of how far the table
                                    under it scrolls. */}
                                    <div className="w-[100cqw]">
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
                                              {WAITING_COLS.map(({ label: h, width, numeric }) => (
                                                <th
                                                  key={h}
                                                  style={{ width }}
                                                  className={numeric ? 'text-right' : undefined}
                                                >
                                                  {h}
                                                </th>
                                              ))}
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {lines.map((line) => {
                                              const cat = line.item?.category
                                              const parent = cat?.parent
                                              return (
                                                <tr
                                                  key={line.id}
                                                  className="border-border/40 border-b last:border-0"
                                                >
                                                  <td className="text-muted-foreground whitespace-nowrap px-3 py-1.5 font-mono text-xs">
                                                    {line.item?.code ?? '—'}
                                                  </td>
                                                  <td className="px-3 py-1.5">
                                                    <div className="text-foreground truncate text-xs">
                                                      {line.item?.name ?? '—'}
                                                    </div>
                                                  </td>
                                                  <td className="px-3 py-1.5 text-xs">
                                                    {line.style?.code || line.styleNo ? (
                                                      <div className="text-foreground truncate font-mono text-xs">
                                                        {line.style?.code ?? line.styleNo}
                                                      </div>
                                                    ) : (
                                                      <span className="text-muted-foreground">
                                                        —
                                                      </span>
                                                    )}
                                                  </td>
                                                  <td>
                                                    {parent?.name ?? cat?.name ?? (
                                                      <span className="text-muted-foreground">
                                                        —
                                                      </span>
                                                    )}
                                                  </td>
                                                  <td>
                                                    {parent ? (
                                                      cat?.name
                                                    ) : (
                                                      <span className="text-muted-foreground">
                                                        —
                                                      </span>
                                                    )}
                                                  </td>
                                                  <td className="whitespace-nowrap text-right tabular-nums">
                                                    {qty(line.qty)} {line.item?.uom?.symbol ?? ''}
                                                  </td>
                                                  <td className="whitespace-nowrap text-right tabular-nums">
                                                    {qty(line.receivedQty)}
                                                  </td>
                                                  <td className="whitespace-nowrap text-right tabular-nums">
                                                    {Number(line.rejectedQty) > 0 ? (
                                                      <span className="text-red-400">
                                                        {qty(line.rejectedQty)}
                                                      </span>
                                                    ) : (
                                                      <span className="text-muted-foreground">
                                                        —
                                                      </span>
                                                    )}
                                                  </td>
                                                  <td className="whitespace-nowrap text-right tabular-nums">
                                                    {line.shortClosed ? (
                                                      <div className="flex items-center justify-end gap-1 whitespace-normal text-amber-500">
                                                        <span
                                                          title={line.shortCloseReason ?? undefined}
                                                        >
                                                          {shortCloseNoun(line.receivedQty)} ·{' '}
                                                          {qty(
                                                            Number(line.qty) -
                                                              Number(line.receivedQty)
                                                          )}
                                                        </span>
                                                        <span className="text-muted-foreground">
                                                          ·
                                                        </span>
                                                        <button
                                                          type="button"
                                                          className="text-primary underline"
                                                          onClick={() =>
                                                            setLineConfirm({
                                                              type: 'reopen',
                                                              po,
                                                              line,
                                                            })
                                                          }
                                                        >
                                                          Reopen
                                                        </button>
                                                      </div>
                                                    ) : Number(line.pendingQty) > 0 ? (
                                                      <div className="flex items-center justify-end gap-1 whitespace-normal">
                                                        <span>{qty(line.pendingQty)}</span>
                                                        <span className="text-muted-foreground">
                                                          ·
                                                        </span>
                                                        <button
                                                          type="button"
                                                          className="text-primary underline"
                                                          onClick={() =>
                                                            setLineConfirm({
                                                              type: 'close',
                                                              po,
                                                              line,
                                                            })
                                                          }
                                                        >
                                                          {shortCloseVerb(line.receivedQty)}
                                                        </button>
                                                      </div>
                                                    ) : (
                                                      <span className="text-muted-foreground">
                                                        —
                                                      </span>
                                                    )}
                                                  </td>
                                                </tr>
                                              )
                                            })}
                                          </tbody>
                                        </table>
                                      </RowPanel>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  </ScrollableTable>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {loading && rows.length === 0 ? (
              <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
            ) : rows.length === 0 ? (
              <div className="px-4 py-10 text-center">
                {/* Two different nothings. A list emptied by a filter and a
                  list that has never had anything in it look identical, and
                  telling somebody to go and receive some goods when they have
                  simply filtered them all out is how a screen loses trust. */}
                <p className="text-muted-foreground text-sm">
                  {anyFilter
                    ? 'No receipt matches those filters. Clear them to see the rest.'
                    : 'Nothing received yet. When a delivery arrives against a purchase order, book it in here and the stock goes up.'}
                </p>
              </div>
            ) : (
              <div className="list-scope">
                {/* ── On a phone, not a table ──────────────────────────────

                  Same reasoning as the tab beside it: eleven columns cannot
                  be made to fit a phone, and a table you drag sideways costs
                  two gestures for every read and keeps the buttons off
                  whichever edge you are not looking at. On a narrow list each
                  row is a block instead.

                  Measured on the list rather than the window — see
                  `.list-scope` in globals.css. */}
                <div className="list-cards divide-border divide-y">
                  {rows.map((grn) => {
                    const s = stage(grn.status)
                    const expanded = open === grn.id
                    const t = receiptTotals(grn)
                    return (
                      <div key={grn.id} className="p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <a
                                href={`/print/goods-receipt/${grn.id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono text-xs font-semibold text-teal-400 hover:underline"
                                title={`Open the printed sheet for ${grn.grnNumber}`}
                              >
                                {grn.grnNumber}
                              </a>
                              <span className={s.cls}>{s.label}</span>
                              <QcBadge qc={grn.qc} />
                              {(() => {
                                const b = billStage(grn)
                                return b ? <span className={b.cls}>{b.label}</span> : null
                              })()}
                              {grn._count?.attachments ? (
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 text-[10px] transition"
                                  onClick={() =>
                                    setFilesFor({
                                      id: grn.id,
                                      number: grn.grnNumber,
                                      kind: 'receipt',
                                    })
                                  }
                                  title="Open the files on this receipt"
                                >
                                  <Paperclip size={10} />
                                  {grn._count.attachments}
                                </button>
                              ) : null}
                            </div>
                            <p className="text-foreground mt-1 font-medium leading-snug">
                              {grn.po.supplier?.name ?? '—'}
                            </p>
                          </div>
                          <span className="text-muted-foreground shrink-0 text-right text-xs">
                            {grn.lines.length} {grn.lines.length === 1 ? 'item' : 'items'}
                          </span>
                        </div>

                        <dl className="mt-2.5 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                          <dt className="text-muted-foreground">PO no.</dt>
                          <dd className="min-w-0">
                            <a
                              href={`/print/purchase-order/${grn.po.id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono text-teal-400 hover:underline"
                              title="Open this order's PDF"
                            >
                              {grn.po.poNumber}
                            </a>
                          </dd>
                          <dt className="text-muted-foreground">Items</dt>
                          {(() => {
                            const p = itemsPreview(grn.lines.map((l) => l.item?.name))
                            return (
                              <dd className="text-foreground min-w-0 truncate" title={p.full}>
                                {p.shown}
                                {p.extra}
                              </dd>
                            )
                          })()}
                          <dt className="text-muted-foreground">Received</dt>
                          <dd className="text-foreground min-w-0">
                            {formatDate(grn.grnDate)}
                            {grn.vehicleNo && (
                              <span className="text-muted-foreground"> · {grn.vehicleNo}</span>
                            )}
                          </dd>
                          <dt className="text-muted-foreground">Qty</dt>
                          <dd className="text-foreground min-w-0 tabular-nums">
                            {qty(t.received)} received
                            <span className="text-muted-foreground">
                              {' '}
                              · {qty(t.accepted)} accepted
                            </span>
                            {t.rejected > 0 && (
                              <span className="text-red-400"> · {qty(t.rejected)} rejected</span>
                            )}
                          </dd>
                        </dl>

                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                          <button
                            onClick={() => setOpen(expanded ? null : grn.id)}
                            className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                            aria-expanded={expanded}
                          >
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            {expanded ? 'Hide items' : 'What arrived'}
                          </button>
                          {grn.status !== 'CANCELLED' &&
                            grn.billing &&
                            Number(grn.billing.pendingQty) > 0 && (
                              <Link
                                href={`/purchase/bills?fromGrn=${grn.id}`}
                                className="btn-secondary h-7 whitespace-nowrap px-2 text-xs"
                              >
                                Add bill
                              </Link>
                            )}
                          <ActionMenu
                            label={`Actions for ${grn.grnNumber}`}
                            items={rowActions(grn)}
                          />
                        </div>

                        {expanded && (
                          <div className="border-border bg-secondary/40 mt-2.5 max-h-[22rem] space-y-2 overflow-y-auto rounded-lg border p-2">
                            {grn.lines.map((l) => (
                              <div
                                key={l.id}
                                className="border-border bg-card rounded-lg border p-2.5"
                              >
                                <p className="text-foreground text-sm font-medium leading-snug">
                                  {l.item.name}
                                </p>
                                <p className="text-muted-foreground mt-0.5 truncate text-[10px]">
                                  <span className="font-mono">{l.item.code}</span>
                                  {l.warehouse?.name && <> · {l.warehouse.name}</>}
                                </p>
                                <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
                                  {[
                                    ['Ordered', Number(l.orderedQty ?? 0)],
                                    ['Received', Number(l.receivedQty ?? 0)],
                                    ['Rejected', Number(l.rejectedQty ?? 0)],
                                    ['Stock', Number(l.acceptedQty ?? 0)],
                                  ].map(([label, value]) => (
                                    <div key={String(label)}>
                                      <dt className="text-muted-foreground text-[10px] uppercase tracking-wider">
                                        {label}
                                      </dt>
                                      <dd className="text-foreground tabular-nums">{value}</dd>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                <div className="list-rows w-full">
                  {/* Every enabled column shows, whatever the window's
                    width — the table scrolls sideways instead of dropping
                    any of them, with a second scrollbar right above the
                    header so reaching it never means scrolling past fifty
                    rows first. What actually shows is the Columns button's
                    job, not the window's. */}
                  <ScrollableTable>
                    <table className="data-table min-w-full">
                      <thead>
                        <tr className="bg-secondary">
                          <th style={{ width: 30 }} />
                          {shownReceiptCols.map((c) => (
                            <th
                              key={c.key}
                              className="whitespace-nowrap"
                              style={c.numeric ? { textAlign: 'right' } : undefined}
                            >
                              {c.label}
                            </th>
                          ))}
                          <th className="border-border bg-secondary sticky right-0 z-10 border-l" />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((grn) => {
                          const s = stage(grn.status)
                          const expanded = open === grn.id
                          const t = receiptTotals(grn)

                          return (
                            <Fragment key={grn.id}>
                              <tr>
                                <td>
                                  <button
                                    className="btn-ghost p-1"
                                    onClick={() => setOpen(expanded ? null : grn.id)}
                                    aria-label={expanded ? 'Hide items' : 'Show items'}
                                  >
                                    {expanded ? (
                                      <ChevronDown size={14} />
                                    ) : (
                                      <ChevronRight size={14} />
                                    )}
                                  </button>
                                </td>
                                {shownReceiptCols.map((c) => (
                                  <td key={c.key} className={c.cellClass}>
                                    {receiptCell(c.key, grn, s, t)}
                                  </td>
                                ))}
                                <td className="border-border bg-card sticky right-0 z-10 whitespace-nowrap border-l text-right">
                                  <div className="flex items-center justify-end gap-1.5">
                                    {/* The old ERP puts Add Bill From GRN on the
                                    row itself, not behind a menu, because a
                                    clerk working through a stack of supplier
                                    invoices does this on nearly every receipt.
                                    Shown only while something is still left to
                                    bill. */}
                                    {grn.status !== 'CANCELLED' &&
                                      grn.billing &&
                                      Number(grn.billing.pendingQty) > 0 && (
                                        <Link
                                          href={`/purchase/bills?fromGrn=${grn.id}`}
                                          className="btn-secondary h-7 whitespace-nowrap px-2 text-xs"
                                          title={`Raise a bill for the ${Number(
                                            grn.billing.pendingQty
                                          ).toLocaleString(
                                            'en-IN'
                                          )} still unbilled on ${grn.grnNumber}`}
                                        >
                                          Add bill
                                        </Link>
                                      )}
                                    <ActionMenu
                                      label={`Actions for ${grn.grnNumber}`}
                                      items={rowActions(grn)}
                                    />
                                  </div>
                                </td>
                              </tr>

                              {expanded && (
                                <tr>
                                  {/* Stops at the last data column — Files — rather
                                    than running under Actions as well.

                                    Actions is a sticky column pinned to the right
                                    edge, and a panel spreading beneath it put the
                                    detail of one receipt under the buttons of the row
                                    above it. The blank cell below keeps that column's
                                    own background and left border unbroken down the
                                    expanded row, so the column reads as continuous
                                    instead of as a hole. */}
                                  <td
                                    colSpan={shownReceiptCols.length + 1}
                                    className="bg-secondary/40 !px-2 !pb-2 !pt-0"
                                  >
                                    {/* The cell's own width, which is now the data
                                      columns and nothing else.

                                      It used to be pinned to `100cqw` — the width
                                      actually on screen — because the cell spanned
                                      every column including the sticky Actions one
                                      and grew with the sideways scroll. Capping it
                                      there was tried again here and is worse than it
                                      looks: the sub-table has nine columns of its
                                      own, and squeezing them into the visible width
                                      puts the last two underneath the sticky Actions
                                      cell, where they cannot be scrolled into view at
                                      all. Following the cell instead, the panel is as
                                      wide as the columns it belongs to; when those
                                      scroll, it scrolls with them like every other
                                      row on the screen. */}
                                    <div className="w-full">
                                      <RowPanel
                                        icon={FileText}
                                        title="What arrived"
                                        note={`${grn.lines.length} ${
                                          grn.lines.length === 1 ? 'line' : 'lines'
                                        } on ${grn.grnNumber}`}
                                      >
                                        {/* Full width, with the share of it each column
                                      gets written down.

                                      This table used to size to its own content, to
                                      avoid the other failure: stretch nine columns to
                                      fill a wide card with no instructions and the
                                      browser hands the slack out between all of them,
                                      so every figure drifts away from its heading.
                                      Sizing to content cured that but moved the whole
                                      surplus to one place — about two fifths of the
                                      card left blank down the right, which is what it
                                      looked like and what it was.

                                      Neither is necessary once the widths are stated.
                                      `table-fixed` makes this colgroup the only vote,
                                      the percentages add to 100, and the item gets the
                                      quarter it needs while the figures keep the narrow
                                      columns that hold them under their own headings.

                                      The `[&_th]`/`[&_td]` padding overrides went with
                                      it: they existed to stop content-sized columns
                                      touching, and `.subtable`'s own padding is tuned
                                      for exactly this — a table that fills its row.

                                      Matches the Waiting tab's panel above, which has
                                      been `w-full table-fixed` all along. */}
                                        <table className="subtable w-full table-fixed">
                                          <colgroup>
                                            <col style={{ width: '25%' }} />
                                            <col style={{ width: '6%' }} />
                                            <col style={{ width: '14%' }} />
                                            <col style={{ width: '8%' }} />
                                            <col style={{ width: '8%' }} />
                                            <col style={{ width: '8%' }} />
                                            <col style={{ width: '9%' }} />
                                            <col style={{ width: '10%' }} />
                                            <col style={{ width: '12%' }} />
                                          </colgroup>
                                          <thead className="sticky top-0 z-10">
                                            <tr>
                                              <th>Item</th>
                                              <th>HSN</th>
                                              <th>Store</th>
                                              <th className="text-right">Ordered</th>
                                              <th className="text-right">Received</th>
                                              <th className="text-right">Rejected</th>
                                              <th className="text-right">Into stock</th>
                                              <th className="text-right">Rate</th>
                                              <th className="text-right">Amount</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {grn.lines.map((l) => {
                                              const unit = l.item.uom?.symbol ?? ''
                                              return (
                                                <tr key={l.id}>
                                                  <td>
                                                    <div className="text-foreground">
                                                      {l.item.name}
                                                    </div>
                                                    <div className="text-muted-foreground font-mono text-[10px]">
                                                      {l.item.code}
                                                      {l.batchNumber
                                                        ? ` · batch ${l.batchNumber}`
                                                        : ''}
                                                    </div>
                                                  </td>
                                                  <td className="font-mono text-xs">
                                                    {l.item.hsnCode || (
                                                      <span className="text-muted-foreground">
                                                        —
                                                      </span>
                                                    )}
                                                  </td>
                                                  <td>{l.warehouse.name}</td>
                                                  <td className="text-right tabular-nums">
                                                    {qty(l.orderedQty)} {unit}
                                                  </td>
                                                  <td className="text-right tabular-nums">
                                                    {qty(l.receivedQty)} {unit}
                                                  </td>
                                                  <td className="text-right tabular-nums">
                                                    {Number(l.rejectedQty) > 0 ? (
                                                      <span className="text-red-400">
                                                        {qty(l.rejectedQty)} {unit}
                                                      </span>
                                                    ) : (
                                                      <span className="text-muted-foreground">
                                                        —
                                                      </span>
                                                    )}
                                                  </td>
                                                  <td className="text-right tabular-nums">
                                                    {qty(l.acceptedQty)} {unit}
                                                  </td>
                                                  <td className="text-right tabular-nums">
                                                    {money(l.unitRate)}
                                                  </td>
                                                  <td className="text-right tabular-nums">
                                                    {money(l.amount)}
                                                  </td>
                                                </tr>
                                              )
                                            })}
                                          </tbody>
                                        </table>
                                        {/* Labelled, so the line reads as a remark
                                      somebody wrote rather than as a stray sentence
                                      that fell off the bottom of the table.

                                      Theme tokens rather than fixed greys: this panel
                                      is read in both themes, and a slate-50 card with
                                      slate-600 text on it is a white box in a dark
                                      screen. `bg-card`, `border-border` and
                                      `text-muted-foreground` are the same intent, and
                                      they follow whichever theme is on. */}
                                        {grn.notes && (
                                          <div className="border-border text-muted-foreground flex items-start gap-2 border-t px-3 py-2 text-xs">
                                            <span className="text-foreground shrink-0 font-semibold">
                                              Remarks:
                                            </span>
                                            <span className="min-w-0">{grn.notes}</span>
                                          </div>
                                        )}
                                      </RowPanel>
                                    </div>
                                  </td>
                                  {/* The Actions column, left empty. Same sticky
                                    position, background and left border as the row
                                    above, so the column carries straight down past
                                    the panel rather than stopping short of it. */}
                                  <td className="border-border bg-card sticky right-0 z-10 border-l" />
                                </tr>
                              )}
                            </Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  </ScrollableTable>
                </div>
              </div>
            )}

            <Pagination
              page={page}
              pages={Math.ceil(total / PER_PAGE) || 1}
              onPageChange={setPage}
              busy={loading}
            />
          </>
        )}
      </div>

      {dialog !== null && (
        <ReceiveGoodsDialog
          poId={dialog || undefined}
          onClose={() => setDialog(null)}
          onSaved={(msg) => {
            setDialog(null)
            setMessage(msg)
            void load()
            // The order this came from may now be fully received, or may have
            // dropped to part received. Either way the list above is stale.
            void loadWaiting()
          }}
        />
      )}

      {qcGrnId !== null && (
        <GrnQcDialog
          grnId={qcGrnId}
          onClose={() => setQcGrnId(null)}
          onSaved={(msg) => {
            setQcGrnId(null)
            setMessage(msg)
            void load()
          }}
        />
      )}

      {editGrnId !== null && (
        <ReceiveGoodsDialog
          grnId={editGrnId}
          onClose={() => setEditGrnId(null)}
          onSaved={(msg) => {
            setEditGrnId(null)
            setMessage(msg)
            void load()
            void loadWaiting()
          }}
        />
      )}

      {confirmAction && (
        <ReasonDialog
          title={
            confirmAction.type === 'cancel'
              ? `Cancel ${confirmAction.grn.grnNumber}?`
              : `Delete ${confirmAction.grn.grnNumber} for good?`
          }
          description={
            confirmAction.type === 'cancel'
              ? 'The stock it brought in will be taken back out.'
              : 'This removes the receipt entirely — it will not show up anywhere, not even as ' +
                'cancelled. If its stock is still on the shelf, that stock is taken back out first.'
          }
          confirmLabel={confirmAction.type === 'cancel' ? 'Cancel receipt' : 'Delete for good'}
          danger
          requireReason={confirmAction.type === 'cancel'}
          busy={busy === confirmAction.grn.id}
          onCancel={() => setConfirmAction(null)}
          onConfirm={(reason) =>
            void (confirmAction.type === 'cancel'
              ? cancel(confirmAction.grn, reason)
              : remove(confirmAction.grn, reason))
          }
        />
      )}

      {lineConfirm && (
        <ReasonDialog
          title={
            lineConfirm.type === 'close'
              ? `${shortCloseVerb(lineConfirm.line.receivedQty)} ${lineConfirm.line.item?.name ?? 'this line'}?`
              : `Reopen ${lineConfirm.line.item?.name ?? 'this line'}?`
          }
          description={
            lineConfirm.type === 'close'
              ? wasNeverReceived(lineConfirm.line.receivedQty)
                ? `Nothing has ever been received against this line on ${lineConfirm.po.poNumber} — it will be marked as never coming.`
                : `This says the rest of it is not coming — it does not touch what has already ` +
                  `been received against ${lineConfirm.po.poNumber}.`
              : `It will count as pending again on ${lineConfirm.po.poNumber}.`
          }
          confirmLabel={
            lineConfirm.type === 'close' ? shortCloseVerb(lineConfirm.line.receivedQty) : 'Reopen'
          }
          danger={lineConfirm.type === 'close'}
          requireReason={lineConfirm.type === 'close'}
          busy={busy === lineConfirm.line.id}
          onCancel={() => setLineConfirm(null)}
          onConfirm={(reason) =>
            void (lineConfirm.type === 'close'
              ? closeLineShort(lineConfirm.po, lineConfirm.line, reason)
              : reopenLine(lineConfirm.po, lineConfirm.line))
          }
        />
      )}

      {filesFor && (
        <OrderAttachmentsDialog
          kind={filesFor.kind}
          docId={filesFor.id}
          docNumber={filesFor.number}
          onClose={() => setFilesFor(null)}
        />
      )}
    </div>
  )
}

/**
 * Whether a quality check stands on the receipt, and what it found — beside
 * the status, so a receipt with rejects in the reject godown is seen before
 * anybody bills or returns against it.
 */
function QcBadge({ qc }: { qc: Receipt['qc'] }) {
  if (!qc) return null
  const r = QC_RESULT[qc.result]
  return (
    <span
      className={r?.cls ?? 'badge-neutral'}
      title={qc.rejectedQty > 0 ? `${qc.rejectedQty} rejected on QC` : 'Everything passed QC'}
    >
      {r?.label ?? 'QC done'}
    </span>
  )
}
