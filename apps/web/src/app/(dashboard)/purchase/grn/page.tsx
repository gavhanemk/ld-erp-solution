'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { OrderAttachmentsDialog } from '@/components/purchase/OrderAttachmentsDialog'
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
  ReceiptIndianRupee,
  Paperclip,
} from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { ReceiveGoodsDialog } from '@/components/purchase/ReceiveGoodsDialog'
import { Pagination } from '@/components/tables/Pagination'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { formatDate, itemsPreview } from '@/lib/utils'

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
  item: { id: string; code: string; name: string; uom: { symbol: string } | null }
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
}

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
}

const qty = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

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
  { label: 'Item code', width: '10%' },
  { label: 'Item', width: '22%' },
  { label: 'Style no', width: '9%' },
  { label: 'Category', width: '12%' },
  { label: 'Subcategory', width: '12%' },
  { label: 'Qty', width: '9%', numeric: true },
  { label: 'Received qty', width: '10%', numeric: true },
  { label: 'Pending qty', width: '16%', numeric: true },
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
  /** The receipt whose files are open, off the paperclip on its row. */
  const [filesFor, setFilesFor] = useState<Receipt | null>(null)

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

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(PER_PAGE) })
      if (debounced) qs.set('q', debounced)
      if (status) qs.set('status', status)
      // At the server, unlike the waiting list: receipts are an archive that
      // grows for ever and this page only ever holds fifty of them, so
      // filtering in the browser would filter the page and not the list.
      if (supplierId) qs.set('supplierId', supplierId)
      if (itemId) qs.set('itemId', itemId)
      if (fromDate) qs.set('from', fromDate)
      if (toDate) qs.set('to', toDate)
      const res = await api.get<Paginated<Receipt>>(`/purchase/grn?${qs}`)
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

  /** Every supplier with an order still waiting, in name order, no repeats. */
  const waitingSuppliers = useMemo(() => {
    const seen = new Map<string, string>()
    for (const po of waiting) if (po.supplier) seen.set(po.supplier.id, po.supplier.name)
    return [...seen]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [waiting])

  /** Every item somebody is still waiting for, in name order, no repeats. */
  const waitingItems = useMemo(() => {
    const seen = new Map<string, { code: string; name: string }>()
    for (const po of waiting) {
      for (const l of po.lines ?? []) {
        if (l.item) seen.set(l.item.id, { code: l.item.code, name: l.item.name })
      }
    }
    return [...seen].map(([id, v]) => ({ id, ...v })).sort((a, b) => a.name.localeCompare(b.name))
  }, [waiting])

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
      items.push(
        {
          // The old ERP's "Add Bill From GRN", in the same place: beside the
          // receipt, where somebody holding the supplier's invoice is already
          // looking. It opens the bill form with this receipt's lines already
          // gathered, rather than making them find it from the other end.
          key: 'bill',
          label: 'Book a bill for this',
          icon: <ReceiptIndianRupee size={14} />,
          href: `/purchase/bills?fromGrn=${grn.id}`,
        },
        {
          key: 'edit',
          label: 'Correct this receipt',
          icon: <Pencil size={14} />,
          onClick: () => setEditGrnId(grn.id),
        },
        {
          key: 'cancel',
          label: 'Cancel',
          icon: <Ban size={14} />,
          onClick: () => setConfirmAction({ type: 'cancel', grn }),
          danger: true,
        }
      )
    }
    items.push({
      key: 'delete',
      label: 'Delete for good',
      icon: <Trash2 size={14} />,
      onClick: () => setConfirmAction({ type: 'delete', grn }),
      danger: true,
    })
    return items
  }

  return (
    <div className="space-y-5">
      <div className="page-header flex-wrap gap-3">
        <div>
          <h1 className="page-title">Goods Receipt</h1>
          <p className="page-subtitle">What has arrived against your purchase orders</p>
        </div>
        <div className="flex items-center gap-2">
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
          <button className="btn-primary" onClick={() => setDialog('')}>
            <Plus size={15} /> Receive goods
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
        <div className="border-border flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-3 py-2">
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

          {/* One box for words, whichever list is showing. It reaches item
            names and codes as well as the order and the supplier, so "poplin"
            finds the order that has poplin on it. */}
          <div className="border-border bg-secondary flex min-w-0 shrink grow basis-full items-center gap-2 rounded-lg border px-2.5 py-1.5 sm:min-w-[150px] sm:max-w-[190px] sm:basis-0">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder={
                tab === 'waiting' ? 'Order, supplier, item...' : 'Receipt, order, supplier...'
              }
              value={tab === 'waiting' ? waitSearch : search}
              onChange={(e) =>
                tab === 'waiting' ? setWaitSearch(e.target.value) : setSearch(e.target.value)
              }
              aria-label="Search"
            />
          </div>

          <select
            className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-32"
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
            className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-36"
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

          {/* Two dates, not a preset list. A mill asks "what came in between
            the 3rd and the 11th" far more often than it asks for last month,
            and either end on its own is a valid question: everything since the
            3rd, everything up to the 11th. */}
          <div className="flex shrink-0 items-center gap-1">
            <input
              type="date"
              className="form-input h-8 w-[7.5rem] py-0 text-xs"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => setFromDate(e.target.value)}
              aria-label="From date"
            />
            <span className="text-muted-foreground text-xs">to</span>
            <input
              type="date"
              className="form-input h-8 w-[7.5rem] py-0 text-xs"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => setToDate(e.target.value)}
              aria-label="To date"
            />
          </div>

          {/* The one filter the two lists cannot share: an order can be part
            received and a receipt cannot, and a receipt can be cancelled where
            an order on this list never is. */}
          {tab === 'waiting' ? (
            <select
              className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-36"
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
              className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-36"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filter by status"
            >
              <option value="">Any status</option>
              <option value="ACCEPTED">Received</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          )}

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
                                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
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
                                      Still due
                                    </dt>
                                    <dd className="tabular-nums">
                                      {line.shortClosed ? (
                                        <span
                                          className="text-amber-500"
                                          title={line.shortCloseReason ?? undefined}
                                        >
                                          Closed short
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
                  {/* What goes when the list narrows, in the order it goes:

                      under "full"   the reference and the item summary
                      under "wide"   the order date and what has arrived so far
                      under "roomy"  the ordered quantity

                      Never dropped: the order number, the supplier, what is
                      still due, the status, and Receive. Still-due is the
                      figure this whole tab exists to show. */}
                  <table className="data-table table-compact w-full">
                    <thead>
                      <tr className="bg-secondary">
                        <th style={{ width: 30 }} />
                        <th>Order</th>
                        <th>Supplier</th>
                        <th className="col-wide">Date</th>
                        <th className="col-full">Reference</th>
                        <th className="col-full">Items</th>
                        <th className="col-roomy" style={{ textAlign: 'right' }}>
                          Total qty
                        </th>
                        <th className="col-wide" style={{ textAlign: 'right' }}>
                          Received qty
                        </th>
                        <th style={{ textAlign: 'right' }}>Pending qty</th>
                        <th>Status</th>
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
                              <td className="col-wide whitespace-nowrap text-xs">
                                {formatDate(po.poDate)}
                              </td>
                              <td className="col-full text-xs">
                                {po.reference || <span className="text-muted-foreground">—</span>}
                              </td>
                              <td className="col-full text-xs">
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
                              <td className="col-roomy whitespace-nowrap text-right text-xs tabular-nums">
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
                              <td className="col-wide whitespace-nowrap text-right text-xs tabular-nums">
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
                                <td colSpan={11} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                                  <div className="border-border bg-card overflow-hidden rounded-lg border">
                                    <div className="border-border flex items-center gap-1.5 border-b px-3 py-1.5">
                                      <FileText
                                        size={13}
                                        className="text-muted-foreground shrink-0"
                                      />
                                      <h4 className="text-foreground text-[11px] font-semibold">
                                        Item Details
                                      </h4>
                                      <span className="text-muted-foreground ml-auto text-[10px]">
                                        {lines.length} {lines.length === 1 ? 'line' : 'lines'} on{' '}
                                        {po.poNumber}
                                      </span>
                                    </div>
                                    {/* Capped and scrollable — an order with
                                  thirty trims on it would otherwise push the
                                  next order, and the pager, halfway down the
                                  screen. */}
                                    <div className="max-h-[22rem] overflow-y-auto">
                                      <table className="w-full table-fixed text-sm">
                                        <thead className="sticky top-0 z-10">
                                          <tr className="bg-secondary border-border border-b">
                                            {WAITING_COLS.map(({ label: h, width, numeric }) => (
                                              <th
                                                key={h}
                                                style={{ width }}
                                                className={`text-muted-foreground px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${
                                                  numeric ? 'text-right' : 'text-left'
                                                }`}
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
                                                    <span className="text-muted-foreground">—</span>
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
                                                  {qty(line.qty)} {line.item?.uom?.symbol ?? ''}
                                                </td>
                                                <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs tabular-nums">
                                                  {qty(line.receivedQty)}
                                                </td>
                                                <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs tabular-nums">
                                                  {line.shortClosed ? (
                                                    <div className="flex items-center justify-end gap-1 whitespace-normal text-amber-500">
                                                      <span
                                                        title={line.shortCloseReason ?? undefined}
                                                      >
                                                        Closed short
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
                                                        Close short
                                                      </button>
                                                    </div>
                                                  ) : (
                                                    <span className="text-muted-foreground">—</span>
                                                  )}
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
                    return (
                      <div key={grn.id} className="p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-foreground font-mono text-xs font-semibold">
                                {grn.grnNumber}
                              </span>
                              <span className={s.cls}>{s.label}</span>
                              {(() => {
                                const b = billStage(grn)
                                return b ? <span className={b.cls}>{b.label}</span> : null
                              })()}
                              {grn._count?.attachments ? (
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 text-[10px] transition"
                                  onClick={() => setFilesFor(grn)}
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
                          <dt className="text-muted-foreground">Against order</dt>
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
                                    ['Arrived', Number(l.receivedQty ?? 0)],
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
                  {/* What goes when the list narrows, in the order it goes:

                      under "full"   the challan, the item summary, and how
                                     much was accepted
                      under "wide"   the order it came against
                      under "roomy"  the date it arrived, and the billing
                                     badge

                      Never dropped: the receipt number, the supplier, the
                      status and the actions.

                      The billing badge goes last of the three and loses
                      nothing when it does: the Add bill button in the actions
                      cell is only there while something is still unbilled, so
                      on a narrow list the button is the badge. Both together
                      cost 306px of a 718px list, which is what pushed this
                      table over the edge on a tablet.

                      This table used to hold a 1180px floor and scroll
                      sideways below it — on a 1366px laptop, which has 1056px
                      to give, that meant dragging on the commonest screen in
                      the building. */}
                  <table className="data-table w-full">
                    <thead>
                      <tr>
                        <th style={{ width: 30 }} />
                        <th>Number</th>
                        <th className="col-wide">Against order</th>
                        <th>Supplier</th>
                        {/* The supplier's own document, which is what the
                          store and the accounts team both quote when they
                          argue about a delivery. It was on the receipt all
                          along and not on the screen. */}
                        <th className="col-full">Challan</th>
                        <th className="col-roomy">Received</th>
                        <th className="col-full">Items</th>
                        <th className="col-full" style={{ textAlign: 'right' }}>
                          Accepted
                        </th>
                        <th>Status</th>
                        <th className="col-roomy">Billing</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((grn) => {
                        const s = stage(grn.status)
                        const expanded = open === grn.id

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
                              <td className="font-mono text-xs text-teal-400">
                                {grn.grnNumber}
                                {/* The challan that came off the lorry is
                                  scanned onto the receipt, so the paperclip
                                  belongs with the receipt's own number. */}
                                {grn._count?.attachments ? (
                                  // A paperclip that cannot be pressed is a
                                  // tease: it says a file exists and offers no
                                  // way to see it.
                                  <button
                                    type="button"
                                    className="text-muted-foreground hover:text-foreground mt-0.5 inline-flex items-center gap-0.5 text-[10px] transition"
                                    onClick={() => setFilesFor(grn)}
                                    title={`Open the ${grn._count.attachments} file${
                                      grn._count.attachments === 1 ? '' : 's'
                                    } on this receipt`}
                                  >
                                    <Paperclip size={10} />
                                    {grn._count.attachments}
                                  </button>
                                ) : null}
                              </td>
                              <td className="col-wide whitespace-nowrap">
                                <a
                                  href={`/print/purchase-order/${grn.po.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="font-mono text-xs text-teal-400 hover:underline"
                                  title="Open this order's PDF"
                                >
                                  {grn.po.poNumber}
                                </a>
                              </td>
                              <td>
                                <div className="max-w-[15rem] truncate text-sm">
                                  {grn.po.supplier?.name ?? '—'}
                                </div>
                              </td>
                              <td className="col-full text-xs">
                                {grn.challanNo ? (
                                  <>
                                    <div className="text-foreground font-mono">{grn.challanNo}</div>
                                    {grn.challanDate && (
                                      <div className="text-muted-foreground text-[10px]">
                                        {formatDate(grn.challanDate)}
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                                {grn.gateEntryNo && (
                                  <div
                                    className="text-muted-foreground text-[10px]"
                                    title="Gate entry number"
                                  >
                                    Gate {grn.gateEntryNo}
                                  </div>
                                )}
                              </td>
                              <td className="col-roomy text-xs">
                                {formatDate(grn.grnDate)}
                                {grn.vehicleNo && (
                                  <div className="text-muted-foreground text-[10px]">
                                    {grn.vehicleNo}
                                  </div>
                                )}
                              </td>
                              <td className="col-full text-xs">
                                <div className="text-foreground whitespace-nowrap text-sm tabular-nums">
                                  {grn.lines.length}
                                </div>
                                {(() => {
                                  const p = itemsPreview(grn.lines.map((l) => l.item?.name))
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
                              </td>
                              <td className="col-full text-right text-sm tabular-nums">
                                {grn.billing
                                  ? Number(grn.billing.acceptedQty).toLocaleString('en-IN', {
                                      maximumFractionDigits: 3,
                                    })
                                  : '—'}
                              </td>
                              <td>
                                <span className={s.cls}>{s.label}</span>
                              </td>
                              <td className="col-roomy whitespace-nowrap">
                                {(() => {
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
                                })()}
                              </td>
                              <td className="whitespace-nowrap text-right">
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
                                <td colSpan={8} className="bg-secondary/40 p-0">
                                  <div className="max-h-[22rem] overflow-y-auto">
                                    <table className="data-table w-full">
                                      <thead className="sticky top-0 z-10">
                                        <tr className="bg-secondary">
                                          <th>Item</th>
                                          <th>Store</th>
                                          <th style={{ textAlign: 'right' }}>Ordered</th>
                                          <th style={{ textAlign: 'right' }}>Arrived</th>
                                          <th style={{ textAlign: 'right' }}>Rejected</th>
                                          <th style={{ textAlign: 'right' }}>Into stock</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {grn.lines.map((l) => (
                                          <tr key={l.id}>
                                            <td>
                                              <div className="text-sm">{l.item.name}</div>
                                              <div className="text-muted-foreground font-mono text-[10px]">
                                                {l.item.code}
                                                {l.batchNumber ? ` · batch ${l.batchNumber}` : ''}
                                              </div>
                                            </td>
                                            <td className="text-xs">{l.warehouse.name}</td>
                                            <td className="text-right text-sm tabular-nums">
                                              {qty(l.orderedQty)}
                                            </td>
                                            <td className="text-right text-sm tabular-nums">
                                              {qty(l.receivedQty)}
                                            </td>
                                            <td className="text-right text-sm tabular-nums">
                                              {Number(l.rejectedQty) > 0 ? (
                                                <span className="text-red-400">
                                                  {qty(l.rejectedQty)}
                                                </span>
                                              ) : (
                                                <span className="text-muted-foreground">—</span>
                                              )}
                                            </td>
                                            <td className="text-right text-sm tabular-nums">
                                              {qty(l.acceptedQty)} {l.item.uom?.symbol ?? ''}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                  {grn.notes && (
                                    <p className="text-muted-foreground px-4 py-2 text-xs">
                                      {grn.notes}
                                    </p>
                                  )}
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
              ? `Close ${lineConfirm.line.item?.name ?? 'this line'} short?`
              : `Reopen ${lineConfirm.line.item?.name ?? 'this line'}?`
          }
          description={
            lineConfirm.type === 'close'
              ? `This says the rest of it is not coming — it does not touch what has already ` +
                `been received against ${lineConfirm.po.poNumber}.`
              : `It will count as pending again on ${lineConfirm.po.poNumber}.`
          }
          confirmLabel={lineConfirm.type === 'close' ? 'Close short' : 'Reopen'}
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
          kind="receipt"
          docId={filesFor.id}
          docNumber={filesFor.grnNumber}
          onClose={() => setFilesFor(null)}
        />
      )}
    </div>
  )
}
