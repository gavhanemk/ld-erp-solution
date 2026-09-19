'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
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
} from 'lucide-react'
import Link from 'next/link'
import { api, ApiError, type Paginated } from '@/lib/api'
import { ReceiveGoodsDialog } from '@/components/purchase/ReceiveGoodsDialog'
import { Pagination } from '@/components/tables/Pagination'
import { formatDate } from '@/lib/utils'

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
interface WaitingOrder {
  id: string
  poNumber: string
  poDate: string
  status: string
  reference: string | null
  totalAmount: string | number
  supplier?: { id: string; name: string } | null
  lines?: Array<{
    id: string
    qty: string | number
    receivedQty: string | number
    item?: { id: string; code: string; name: string } | null
  }>
}

const qty = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

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

  /**
   * The receiving form, and the order it should open on.
   *
   * `null` is closed; a string is the order to start from, and the empty string
   * is the plain "Receive goods" button with nothing chosen yet.
   */
  const [dialog, setDialog] = useState<string | null>(null)

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

  const cancel = async (grn: Receipt) => {
    const reason = prompt(
      `Why is ${grn.grnNumber} being cancelled?\n\nThe stock it brought in will be taken back out.`
    )
    if (!reason || reason.trim().length < 5) return

    setBusy(grn.id)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/purchase/grn/${grn.id}/cancel`, {
        reason: reason.trim(),
      })
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
          <div className="border-border bg-secondary flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 sm:min-w-[150px] sm:max-w-[190px]">
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
              <div className="w-full overflow-x-auto">
                <table className="data-table table-compact w-full min-w-[860px]">
                  <thead>
                    <tr className="bg-secondary">
                      <th style={{ width: '11%' }}>Order</th>
                      <th style={{ width: '25%' }}>Supplier</th>
                      <th style={{ width: '12%' }}>Date</th>
                      <th style={{ width: '12%' }}>Reference</th>
                      <th style={{ width: '10%' }}>Items</th>
                      <th style={{ width: '11%', textAlign: 'right' }}>Total</th>
                      <th style={{ width: '10%', textAlign: 'right' }}>Still due</th>
                      <th style={{ width: '9%' }}>Status</th>
                      <th style={{ width: '14%' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {waitingShown.map((po) => {
                      const ordered = (po.lines ?? []).reduce((t, l) => t + Number(l.qty), 0)
                      const got = (po.lines ?? []).reduce((t, l) => t + Number(l.receivedQty), 0)
                      const due = Math.max(0, ordered - got)
                      const part = po.status === 'PARTIALLY_RECEIVED'
                      return (
                        <tr key={po.id}>
                          <td className="whitespace-nowrap font-mono text-xs font-semibold">
                            {po.poNumber}
                          </td>
                          <td className="text-sm">{po.supplier?.name ?? '—'}</td>
                          <td className="whitespace-nowrap text-xs">{formatDate(po.poDate)}</td>
                          <td className="text-xs">
                            {po.reference || <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="whitespace-nowrap text-xs">
                            {(po.lines ?? []).length}{' '}
                            {(po.lines ?? []).length === 1 ? 'item' : 'items'}
                          </td>
                          <td className="whitespace-nowrap text-right text-sm font-semibold tabular-nums">
                            ₹
                            {Number(po.totalAmount).toLocaleString('en-IN', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </td>
                          {/* Of the ordered quantity, not of the money. What a
                            store keeper checks off a challan is pieces. */}
                          <td className="whitespace-nowrap text-right text-xs tabular-nums">
                            {qty(due)}
                            {part && (
                              <span className="text-muted-foreground"> of {qty(ordered)}</span>
                            )}
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
                      )
                    })}
                  </tbody>
                </table>
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
              <>
                {/* ── On a phone, not a table ──────────────────────────────────

              Same reasoning as the purchase order list: 8 columns cannot be
              made to fit a phone, and a table you drag sideways costs two
              gestures for every read and keeps the buttons off whichever edge
              you are not looking at. Below xl each row is a block instead.

              xl and not lg, because lg is where the sidebar comes back and
              takes 260px of the screen with it. */}
                <div className="divide-border divide-y xl:hidden">
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
                          <dd className="text-foreground min-w-0 font-mono">{grn.po.poNumber}</dd>
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
                          <div className="flex gap-1">
                            {/* Printable even once cancelled. A cancelled receipt
                          is still the record of a delivery that happened, and
                          somebody will need the paper for it. */}
                            <Link
                              href={`/print/goods-receipt/${grn.id}`}
                              target="_blank"
                              className="btn-ghost border-border rounded-lg border p-1.5"
                              title="Print the goods receipt note"
                              aria-label={`Print ${grn.grnNumber}`}
                            >
                              <Printer size={15} />
                            </Link>
                            {grn.status !== 'CANCELLED' && (
                              <button
                                className="btn-ghost border-border rounded-lg border p-1.5 hover:text-red-400"
                                onClick={() => void cancel(grn)}
                                disabled={busy === grn.id}
                                title="Cancel this receipt"
                                aria-label={`Cancel ${grn.grnNumber}`}
                              >
                                <Ban size={15} />
                              </button>
                            )}
                          </div>
                        </div>

                        {expanded && (
                          <div className="border-border bg-secondary/40 mt-2.5 space-y-2 rounded-lg border p-2">
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

                <div className="hidden w-full overflow-x-auto xl:block">
                  {/* A floor, so the table scrolls rather than squashing.

              Eight columns with no minimum width squeeze to fit whatever they
              are given: on a narrow screen the supplier and the number end up
              two characters wide and wrapped over four lines. 900px is what
              these columns need to stay readable, and the wrapper around them
              already scrolls — which is the honest behaviour when a table is
              genuinely wider than the screen.

              It is under the 1058px a 1366px laptop has to give, so the
              commonest screen there is still shows the whole table without
              scrolling at all. */}
                  <table className="data-table w-full min-w-[900px]">
                    <thead>
                      <tr>
                        <th style={{ width: 30 }} />
                        <th>Number</th>
                        <th>Against order</th>
                        <th>Supplier</th>
                        <th>Received</th>
                        <th style={{ textAlign: 'right' }}>Items</th>
                        <th>Status</th>
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
                              <td className="font-mono text-xs text-teal-400">{grn.grnNumber}</td>
                              <td className="font-mono text-xs">{grn.po.poNumber}</td>
                              <td className="text-sm">{grn.po.supplier?.name ?? '—'}</td>
                              <td className="text-xs">
                                {formatDate(grn.grnDate)}
                                {grn.vehicleNo && (
                                  <div className="text-muted-foreground text-[10px]">
                                    {grn.vehicleNo}
                                  </div>
                                )}
                              </td>
                              <td className="text-right text-sm tabular-nums">
                                {grn.lines.length}
                              </td>
                              <td>
                                <span className={s.cls}>{s.label}</span>
                              </td>
                              <td className="whitespace-nowrap text-right">
                                <Link
                                  href={`/print/goods-receipt/${grn.id}`}
                                  target="_blank"
                                  className="btn-ghost p-1.5"
                                  title="Print the goods receipt note"
                                  aria-label={`Print ${grn.grnNumber}`}
                                >
                                  <Printer size={15} />
                                </Link>
                                {grn.status !== 'CANCELLED' && (
                                  <button
                                    className="btn-ghost p-1.5 hover:text-red-400"
                                    onClick={() => void cancel(grn)}
                                    disabled={busy === grn.id}
                                    title="Cancel this receipt"
                                    aria-label={`Cancel ${grn.grnNumber}`}
                                  >
                                    <Ban size={15} />
                                  </button>
                                )}
                              </td>
                            </tr>

                            {expanded && (
                              <tr>
                                <td colSpan={8} className="bg-secondary/40 p-0">
                                  <table className="data-table w-full">
                                    <thead>
                                      <tr>
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
              </>
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
    </div>
  )
}
