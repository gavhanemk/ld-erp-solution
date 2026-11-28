'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  Search,
  RefreshCw,
  AlertCircle,
  Ban,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Printer,
  FileText,
  CheckCircle2,
  XCircle,
  Tags,
  Truck,
  PackageCheck,
  Undo2,
} from 'lucide-react'
import { api, ApiError, can, currentUser, type Paginated } from '@/lib/api'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { RowPanel } from '@/components/tables/RowPanel'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { formatDate, formatRupees } from '@/lib/utils'
import { StickerNote, type StickerNews } from '@/components/inventory/StockInNext'
import { StickersReady, printDocStickers } from '@/components/packages/StickersReady'
import { TransitStepDialog, onTheWay, type TransitStep } from '@/components/inventory/TransitStepDialog'
import { OutwardStickers } from '@/components/packages/OutwardStickers'
import { itemShadeCols, type ShadeFields } from '@/lib/items'

/**
 * The stock documents: what was moved between stores, and what was corrected
 * after a count.
 *
 * Both used to leave nothing behind but ledger rows tagged with the clock, so
 * "what did we move last month" and "who changed that figure, and why" had no
 * answer anywhere in the system. This screen is that answer.
 *
 * A count changes stock only once a store manager approves it, here or from
 * the approvals inbox; until then it waits as Pending. Every line says whose
 * stock it is — ours, or a customer's cloth in our store — and its size.
 */

interface Line {
  id: string
  item: ShadeFields & { id: string; code: string; name: string; uom: { symbol: string } | null }
  ownership?: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomer?: { id: string; name: string } | null
  size?: { id: string; code: string } | null
}

/** "Cotton County Retail's · size 40", or nothing for our own unsized stock. */
const whoseLabel = (l: Line) =>
  [l.ownership === 'CUSTOMER_OWNED' ? `${l.ownerCustomer?.name ?? 'Customer'}'s` : null, l.size ? `size ${l.size.code}` : null]
    .filter(Boolean)
    .join(' · ')

interface TransferLine extends Line {
  qty: string | number
  unitRate: string | number | null
  /** Sent in transit: what arrived good, damaged, went back, was lost. */
  receivedQty?: string | number
  damagedQty?: string | number
  returnedQty?: string | number
  lostQty?: string | number
}

type TransferStatus = 'DISPATCHED' | 'PARTLY_RECEIVED' | 'RECEIVED' | 'DISCREPANCY' | 'CANCELLED'

/** An in-transit transfer's status, as a store keeper says it. */
const TRANSIT_STATUS: Record<TransferStatus, { label: string; badge: string }> = {
  DISPATCHED: { label: 'On the way', badge: 'badge-warning' },
  PARTLY_RECEIVED: { label: 'Part received', badge: 'badge-warning' },
  RECEIVED: { label: 'Received', badge: 'badge-success' },
  DISCREPANCY: { label: 'Received, with differences', badge: 'badge-info' },
  CANCELLED: { label: 'Cancelled', badge: 'badge-neutral' },
}

interface AdjustmentLine extends Line {
  bookQty: string | number
  countedQty: string | number
  difference: string | number
  unitRate?: string | number | null
}

interface Transfer {
  id: string
  transferNumber: string
  transferDate: string
  notes: string | null
  fromWarehouse: { id: string; name: string }
  toWarehouse: { id: string; name: string }
  movedBy: { id: string; name: string } | null
  cancelledAt: string | null
  cancelledBy: { id: string; name: string } | null
  cancelReason: string | null
  mode?: 'DIRECT' | 'IN_TRANSIT'
  status?: TransferStatus
  transitWarehouse?: { id: string; name: string } | null
  lines: TransferLine[]
}

interface Adjustment {
  id: string
  adjustmentNumber: string
  adjustmentDate: string
  reason: string
  warehouse: { id: string; name: string }
  madeBy: { id: string; name: string } | null
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  approvedBy: { id: string; name: string } | null
  approvedAt: string | null
  rejectReason: string | null
  /** COUNT for a physical count; STOCK_IN for stock that came in without a purchase order. */
  kind?: string
  source?: string | null
  lines: AdjustmentLine[]
}

type Kind = 'transfers' | 'adjustments'

const qty = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/**
 * The item panels' columns, as shares of the row, so each table fits the panel it opens in.
 * A fabric's own Design No. and Colour sit beside its name: same-name items told apart.
 */
const TRANSFER_COLS = [
  { label: 'Code', width: '14%' },
  { label: 'Item', width: '34%' },
  { label: 'Design No.', width: '12%' },
  { label: 'Colour', width: '12%' },
  { label: 'Quantity', width: '14%', numeric: true },
  { label: 'Carried at', width: '14%', numeric: true },
]
/** Sent in transit: what was sent, and what became of it. */
const TRANSIT_COLS = [
  { label: 'Code', width: '11%' },
  { label: 'Item', width: '27%' },
  { label: 'Sent', width: '10%', numeric: true },
  { label: 'Arrived', width: '10%', numeric: true },
  { label: 'Damaged', width: '10%', numeric: true },
  { label: 'Back / lost', width: '11%', numeric: true },
  { label: 'On the way', width: '11%', numeric: true },
  { label: 'Carried at', width: '10%', numeric: true },
]
const ADJUSTMENT_COLS = [
  { label: 'Code', width: '12%' },
  { label: 'Item', width: '30%' },
  { label: 'Design No.', width: '10%' },
  { label: 'Colour', width: '10%' },
  { label: 'Book said', width: '12%', numeric: true },
  { label: 'Counted', width: '13%', numeric: true },
  { label: 'Difference', width: '13%', numeric: true },
]
/** A stock-in is what is coming in and what it is worth, not a count. */
const STOCK_IN_COLS = [
  { label: 'Code', width: '12%' },
  { label: 'Item', width: '26%' },
  { label: 'Design No.', width: '9%' },
  { label: 'Colour', width: '9%' },
  { label: 'In store now', width: '11%', numeric: true },
  { label: 'Coming in', width: '11%', numeric: true },
  { label: 'Rate', width: '10%', numeric: true },
  { label: 'Worth', width: '12%', numeric: true },
]

/** A line's Design No. and Colour cells. */
function ShadeCells({ item }: { item: ShadeFields }) {
  const c = itemShadeCols(item)
  return (
    <>
      <td className="truncate text-xs">{c.designNo || <span className="text-muted-foreground">—</span>}</td>
      <td className="truncate text-xs">{c.colour || <span className="text-muted-foreground">—</span>}</td>
    </>
  )
}

export default function StockDocumentsPage() {
  const [kind, setKind] = useState<Kind>('transfers')
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [adjustments, setAdjustments] = useState<Adjustment[]>([])
  const [total, setTotal] = useState(0)
  /** Counts and stock-ins waiting for a store manager, shown on the tab so they are not missed. */
  const [waiting, setWaiting] = useState(0)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** After a stock-in is approved: where its stickers are, or why there are none. */
  const [stickers, setStickers] = useState<StickerNews | null>(null)
  /** A stock-in just approved: its stickers were made by themselves, ready to print. */
  const [stickersFor, setStickersFor] = useState<{ id: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [refusing, setRefusing] = useState<Adjustment | null>(null)
  const [approving, setApproving] = useState<Adjustment | null>(null)
  // What approving a count would take out of each brand's earmark (shortages come from central first).
  const [losses, setLosses] = useState<Array<{ lineId: string; brand: string; item: string; size: string | null; unit: string; qty: number; named: boolean }> | null>(null)
  useEffect(() => {
    setLosses(null)
    if (!approving || approving.kind === 'STOCK_IN') return
    let live = true
    api
      .get<{ data: NonNullable<typeof losses> }>(`/inventory/adjustments/${approving.id}/brand-losses`)
      .then((r) => live && setLosses(r.data))
      .catch(() => live && setLosses([]))
    return () => {
      live = false
    }
  }, [approving])
  /** Only transfers with something still on the road. */
  const [onlyOpen, setOnlyOpen] = useState(false)
  /** A step on a transfer in transit: receive, send back, write off. */
  const [stepping, setStepping] = useState<{ t: Transfer; step: TransitStep } | null>(null)
  /** A transfer's labels window: which rolls went, and the labels for them. */
  const [labelling, setLabelling] = useState<Transfer | null>(null)
  const me = currentUser() as { id?: string } | null
  const mayApprove = can('inventory', 'approve')

  // Arriving from the approvals inbox, which links to the counts, or from a
  // stock-in just saved, which opens its own row.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('tab') === 'adjustments') setKind('adjustments')
    if (q.get('open')) setOpen(q.get('open'))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  // Only the latest load may fill the table. Arriving on the Adjustments tab
  // starts a load of transfers first, and when that answer came back last its
  // count of 5 transfers sat over the adjustments.
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const current = () => seq === loadSeq.current
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: '50' })
      if (debounced) qs.set('q', debounced)
      if (kind === 'transfers' && onlyOpen) qs.set('open', '1')

      // Whichever tab is open, the Adjustments tab says how many are waiting.
      void api
        .get<Paginated<Adjustment>>('/inventory/adjustments?status=PENDING&limit=1')
        .then((r) => setWaiting(r.pagination.total))
        .catch(() => {})

      if (kind === 'transfers') {
        const res = await api.get<Paginated<Transfer>>(`/inventory/transfers?${qs}`)
        if (!current()) return
        setTransfers(res.data)
        setTotal(res.pagination.total)
      } else {
        const res = await api.get<Paginated<Adjustment>>(`/inventory/adjustments?${qs}`)
        if (!current()) return
        setAdjustments(res.data)
        setTotal(res.pagination.total)
      }
    } catch (err) {
      if (!current()) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing stock documents.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setTransfers([])
      setAdjustments([])
    } finally {
      if (current()) setLoading(false)
    }
  }, [debounced, kind, onlyOpen])

  useEffect(() => {
    void load()
  }, [load])

  const cancel = async (t: Transfer) => {
    const reason = prompt(
      t.mode === 'IN_TRANSIT'
        ? `Why is ${t.transferNumber} being cancelled?\n\nThe goods come back off the road to ${t.fromWarehouse.name}.`
        : `Why is ${t.transferNumber} being cancelled?\n\nThe goods will be moved back to ${t.fromWarehouse.name}.`
    )
    if (!reason || reason.trim().length < 5) return

    setBusy(t.id)
    setError(null)
    setMessage(null)
    setStickers(null)
    try {
      const res = await api.patch<{ message?: string }>(`/inventory/transfers/${t.id}/cancel`, {
        reason: reason.trim(),
      })
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel it.')
    } finally {
      setBusy(null)
    }
  }

  /** Approve (stock changes now) or refuse (with why) a count that is waiting. */
  const decide = async (a: Adjustment, decision: 'approve' | 'reject', reason?: string) => {
    setBusy(a.id)
    setError(null)
    setMessage(null)
    setStickers(null)
    try {
      const res = await api.post<{ message?: string; stickers?: StickerNews }>(
        `/inventory/adjustments/${a.id}/${decision}`,
        decision === 'reject' ? { reason } : {},
      )
      setRefusing(null)
      setApproving(null)
      await load()
      if (res.message) setMessage(res.message)
      if (res.stickers) setStickers(res.stickers)
      // A stock-in approved: its stickers were made, ready to print.
      if (decision === 'approve' && res.stickers?.tracked.length) setStickersFor({ id: a.id })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${decision === 'approve' ? 'approve' : 'refuse'} it.`)
    } finally {
      setBusy(null)
    }
  }

  const rows = kind === 'transfers' ? transfers : adjustments
  const noun = kind === 'transfers' ? 'transfers' : 'adjustments'

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock Documents</h1>
          <p className="page-subtitle">
            What was moved between stores, what was corrected after a count, and what came in without a purchase order
          </p>
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
          {stickers && <StickerNote stickers={stickers} />}
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <div className="border-border bg-secondary flex gap-1 rounded-lg border p-1">
            {(['transfers', 'adjustments'] as Kind[]).map((k) => (
              <button
                key={k}
                className={
                  k === kind
                    ? 'bg-primary text-primary-foreground rounded-lg px-3 py-1 text-xs font-semibold'
                    : 'text-muted-foreground rounded-lg px-3 py-1 text-xs'
                }
                onClick={() => {
                  setKind(k)
                  setOpen(null)
                }}
              >
                {k === 'transfers' ? 'Transfers' : 'Adjustments'}
                {k === 'adjustments' && waiting > 0 && (
                  <span
                    className={
                      k === kind
                        ? 'bg-primary-foreground/20 text-primary-foreground ml-1.5 rounded-full px-1.5 text-[10px] font-semibold'
                        : 'badge-warning ml-1.5 !px-1.5 !py-0 text-[10px]'
                    }
                  >
                    {waiting} waiting
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="border-field-edge bg-field flex min-w-[200px] max-w-sm flex-1 items-center gap-2 rounded-lg border px-3 py-2">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder={kind === 'transfers' ? 'Search number...' : 'Search number or reason...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={`Search ${noun}`}
              data-hotkey="search"
            />
          </div>
          {kind === 'transfers' && (
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />
              <Truck size={13} /> On the way only
            </label>
          )}
          <span className="text-muted-foreground ml-auto text-xs">
            {total} {noun}
          </span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              {kind === 'transfers'
                ? 'Nothing moved between stores yet. Move stock from the Stock screen and the note will appear here.'
                : 'No counts recorded yet. Correct a figure from the Stock screen and the count sheet will appear here.'}
            </p>
          </div>
        ) : kind === 'transfers' ? (
          <div className="list-scope">
            <ScrollableTable>
              <table className="data-table table-compact min-w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th style={{ width: 30 }} />
                    <th className="whitespace-nowrap">Number</th>
                    <th className="whitespace-nowrap">Moved</th>
                    <th className="whitespace-nowrap">From</th>
                    <th className="whitespace-nowrap">To</th>
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Items</th>
                    <th className="whitespace-nowrap">Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((t, i) => {
                    const expanded = open === t.id
                    // The note that travels with the goods, and the way back if it was a mistake.
                    const actions: RowAction[] = [
                      { key: 'print', label: 'View / print', icon: <Printer size={14} />, href: `/print/stock-transfer/${t.id}`, newTab: true },
                    ]
                    const onTheRoad = t.mode === 'IN_TRANSIT'
                    const stillOpen = onTheRoad && (t.status === 'DISPATCHED' || t.status === 'PARTLY_RECEIVED')
                    // Its labels window: any time for a direct one; on the road, until anything of it is done at the other end.
                    if (!t.cancelledAt && (!onTheRoad || t.status === 'DISPATCHED'))
                      actions.push({ key: 'stickers', label: 'Stickers for what went', icon: <Tags size={14} />, onClick: () => setLabelling(t) })
                    if (stillOpen && busy !== t.id) {
                      actions.push({ key: 'receive', label: `Receive what arrived at ${t.toWarehouse.name}`, icon: <PackageCheck size={14} />, onClick: () => setStepping({ t, step: 'receive' }) })
                      actions.push({ key: 'send-back', label: `Send back what did not arrive`, icon: <Undo2 size={14} />, onClick: () => setStepping({ t, step: 'send-back' }) })
                      if (mayApprove) actions.push({ key: 'write-off', label: 'Write off as lost on the way', icon: <XCircle size={14} />, onClick: () => setStepping({ t, step: 'write-off' }), danger: true })
                    }
                    // Direct: walked back. In transit: only while nothing of it has arrived.
                    if (!t.cancelledAt && busy !== t.id && (!onTheRoad || t.status === 'DISPATCHED'))
                      actions.push({ key: 'cancel', label: onTheRoad ? 'Cancel and bring the goods back' : 'Cancel and move the goods back', icon: <Ban size={14} />, onClick: () => void cancel(t), danger: true })
                    return (
                      <Fragment key={t.id}>
                        <tr data-row tabIndex={i === 0 ? 0 : -1}>
                          <td>
                            <button
                              data-row-open
                              className="bg-primary/10 text-primary hover:bg-primary/20 flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
                              onClick={() => setOpen(expanded ? null : t.id)}
                              title={expanded ? 'Hide items' : 'Show items'}
                              aria-label={`${expanded ? 'Hide' : 'Show'} items on ${t.transferNumber}`}
                              aria-expanded={expanded}
                            >
                              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </td>
                          <td className="whitespace-nowrap">
                            <span className="font-mono text-xs font-semibold text-teal-400">{t.transferNumber}</span>
                          </td>
                          <td className="whitespace-nowrap text-xs">
                            {formatDate(t.transferDate)}
                            {t.movedBy && (
                              <div className="text-muted-foreground text-[10px]">
                                by {t.movedBy.name}
                              </div>
                            )}
                          </td>
                          <td className="whitespace-nowrap text-sm">{t.fromWarehouse.name}</td>
                          <td className="whitespace-nowrap text-sm">
                            <span className="flex items-center gap-1">
                              <ArrowRight size={13} className="text-muted-foreground" />
                              {t.toWarehouse.name}
                            </span>
                          </td>
                          <td className="text-right text-sm tabular-nums">{t.lines.length}</td>
                          <td className="whitespace-nowrap">
                            {t.cancelledAt ? (
                              <>
                                <span className="badge-neutral">Cancelled</span>
                                {t.cancelReason && (
                                  <div className="text-muted-foreground max-w-[200px] truncate text-[10px]">
                                    {t.cancelReason}
                                  </div>
                                )}
                              </>
                            ) : onTheRoad && t.status ? (
                              <>
                                <span className={TRANSIT_STATUS[t.status].badge}>{TRANSIT_STATUS[t.status].label}</span>
                                <div className="text-muted-foreground text-[10px]">in transit via {t.transitWarehouse?.name ?? 'transit'}</div>
                              </>
                            ) : (
                              <span className="badge-success">Moved</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap text-right">
                            <div className="flex justify-end gap-1.5">
                              <ActionMenu label={`Actions for ${t.transferNumber}`} items={actions} />
                            </div>
                          </td>
                        </tr>

                        {expanded && (
                          <tr>
                            <td colSpan={8} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              {/* Sized to the visible row, not the scrolling table. */}
                              <div className="w-[100cqw]">
                                <RowPanel
                                  icon={FileText}
                                  title="Item Details"
                                  note={`${t.lines.length} ${t.lines.length === 1 ? 'line' : 'lines'} on ${t.transferNumber}`}
                                >
                                  <table className="subtable w-full table-fixed">
                                    <thead className="sticky top-0 z-10">
                                      <tr>
                                        {(onTheRoad ? TRANSIT_COLS : TRANSFER_COLS).map((c) => (
                                          <th key={c.label} style={{ width: c.width }} className={c.numeric ? 'text-right' : undefined}>
                                            {c.label}
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {t.lines.map((l) => (
                                        <tr key={l.id}>
                                          <td className="text-muted-foreground whitespace-nowrap font-mono text-xs">{l.item.code}</td>
                                          <td>
                                            <div className="text-foreground truncate text-xs" title={l.item.name}>
                                              {l.item.name}
                                            </div>
                                            {whoseLabel(l) && <div className="text-muted-foreground truncate text-[10px]">{whoseLabel(l)}</div>}
                                          </td>
                                          <ShadeCells item={l.item} />
                                          <td className="whitespace-nowrap text-right text-xs tabular-nums">
                                            {qty(l.qty)} {l.item.uom?.symbol ?? ''}
                                          </td>
                                          {onTheRoad && (
                                            <>
                                              <td className="whitespace-nowrap text-right text-xs tabular-nums">{qty(l.receivedQty ?? 0)}</td>
                                              <td className={`whitespace-nowrap text-right text-xs tabular-nums ${Number(l.damagedQty ?? 0) > 0 ? 'text-amber-500' : ''}`}>
                                                {qty(l.damagedQty ?? 0)}
                                              </td>
                                              <td className="whitespace-nowrap text-right text-xs tabular-nums">
                                                {qty(l.returnedQty ?? 0)} / {qty(l.lostQty ?? 0)}
                                              </td>
                                              <td className="whitespace-nowrap text-right text-xs font-semibold tabular-nums">
                                                {t.cancelledAt ? '—' : qty(onTheWay({ ...l, qty: l.qty }))}
                                              </td>
                                            </>
                                          )}
                                          <td className="whitespace-nowrap text-right text-xs tabular-nums">
                                            {l.unitRate === null ? '—' : qty(l.unitRate)}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  {t.notes && (
                                    <p className="border-border text-muted-foreground border-t px-3 py-2 text-[11px]">{t.notes}</p>
                                  )}
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
        ) : (
          <div className="list-scope">
            <ScrollableTable>
              <table className="data-table table-compact min-w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th style={{ width: 30 }} />
                    <th className="whitespace-nowrap">Number</th>
                    <th className="whitespace-nowrap">Counted</th>
                    <th className="whitespace-nowrap">Store</th>
                    <th className="whitespace-nowrap">Why</th>
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Counted</th>
                    <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>Differences</th>
                    <th className="whitespace-nowrap">Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((a, i) => {
                    const expanded = open === a.id
                    const changed = a.lines.filter((l) => Number(l.difference) !== 0).length
                    const mine = !!a.madeBy && a.madeBy.id === me?.id
                    const actions: RowAction[] = []
                    if (a.status === 'PENDING' && mayApprove && busy !== a.id) {
                      const stockIn = a.kind === 'STOCK_IN'
                      actions.push({
                        key: 'approve',
                        label: stockIn ? (mine ? 'Approve (you entered this)' : 'Approve and add to stock') : mine ? 'Approve (you counted this)' : 'Approve and correct stock',
                        icon: <CheckCircle2 size={14} />,
                        onClick: () => setApproving(a),
                      })
                      actions.push({ key: 'reject', label: 'Refuse', icon: <XCircle size={14} />, onClick: () => setRefusing(a), danger: true })
                    }
                    // The stickers for what a stock-in brought in, any time after it is approved.
                    if (a.kind === 'STOCK_IN' && a.status === 'APPROVED') {
                      actions.push({ key: 'stickers', label: 'Print stickers', icon: <Tags size={14} />, onClick: () => void printDocStickers({ type: 'STOCK_IN', id: a.id }).then(setMessage) })
                    }

                    return (
                      <Fragment key={a.id}>
                        <tr data-row tabIndex={i === 0 ? 0 : -1}>
                          <td>
                            <button
                              data-row-open
                              className="bg-primary/10 text-primary hover:bg-primary/20 flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
                              onClick={() => setOpen(expanded ? null : a.id)}
                              title={expanded ? 'Hide items' : 'Show items'}
                              aria-label={`${expanded ? 'Hide' : 'Show'} items on ${a.adjustmentNumber}`}
                              aria-expanded={expanded}
                            >
                              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </td>
                          <td className="whitespace-nowrap">
                            <span className="font-mono text-xs font-semibold text-teal-400">{a.adjustmentNumber}</span>
                            {/* A stock-in is approved here too, but it is stock arriving, not a count. */}
                            {a.kind === 'STOCK_IN' && <div><span className="badge-info text-[10px]">Stock in</span></div>}
                          </td>
                          <td className="whitespace-nowrap text-xs">
                            {formatDate(a.adjustmentDate)}
                            {a.madeBy && (
                              <div className="text-muted-foreground text-[10px]">
                                by {a.madeBy.name}
                              </div>
                            )}
                          </td>
                          <td className="whitespace-nowrap text-sm">{a.warehouse.name}</td>
                          <td className="text-muted-foreground max-w-[260px] text-xs">{a.reason}</td>
                          <td className="text-right text-sm tabular-nums">{a.lines.length}</td>
                          <td className="whitespace-nowrap text-right">
                            {a.kind === 'STOCK_IN' ? (
                              <span className="badge-info">+{changed} in</span>
                            ) : changed > 0 ? (
                              <span className="badge-warning">{changed}</span>
                            ) : (
                              <span className="badge-success">all matched</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap">
                            {a.status === 'PENDING' ? (
                              <span className="badge-warning">Waiting for approval</span>
                            ) : a.status === 'REJECTED' ? (
                              <>
                                <span className="badge-neutral">Refused</span>
                                {a.rejectReason && <div className="text-muted-foreground max-w-[200px] truncate text-[10px]" title={a.rejectReason}>{a.rejectReason}</div>}
                              </>
                            ) : (
                              <>
                                <span className="badge-success">{a.kind === 'STOCK_IN' ? 'Added to stock' : changed > 0 ? 'Stock corrected' : 'Matched'}</span>
                                {a.approvedBy && <div className="text-muted-foreground text-[10px]">approved by {a.approvedBy.name}</div>}
                              </>
                            )}
                          </td>
                          <td className="whitespace-nowrap text-right">
                            {actions.length > 0 && <ActionMenu label={`Actions for ${a.adjustmentNumber}`} items={actions} />}
                          </td>
                        </tr>

                        {expanded && (
                          <tr>
                            <td colSpan={9} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              {/* Sized to the visible row, not the scrolling table. */}
                              <div className="w-[100cqw]">
                                <RowPanel
                                  icon={FileText}
                                  title="Item Details"
                                  note={`${a.lines.length} ${a.lines.length === 1 ? 'line' : 'lines'} on ${a.adjustmentNumber}`}
                                >
                                  <table className="subtable w-full table-fixed">
                                    <thead className="sticky top-0 z-10">
                                      <tr>
                                        {(a.kind === 'STOCK_IN' ? STOCK_IN_COLS : ADJUSTMENT_COLS).map((c) => (
                                          <th key={c.label} style={{ width: c.width }} className={c.numeric ? 'text-right' : undefined}>
                                            {c.label}
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {a.lines.map((l) => {
                                        const d = Number(l.difference)
                                        if (a.kind === 'STOCK_IN') {
                                          const rate = Number(l.unitRate ?? 0)
                                          return (
                                            <tr key={l.id}>
                                              <td className="text-muted-foreground whitespace-nowrap font-mono text-xs">{l.item.code}</td>
                                              <td>
                                                <div className="text-foreground truncate text-xs" title={l.item.name}>
                                                  {l.item.name}
                                                </div>
                                              </td>
                                              <ShadeCells item={l.item} />
                                              <td className="whitespace-nowrap text-right text-xs tabular-nums">{qty(l.bookQty)}</td>
                                              <td className="whitespace-nowrap text-right text-xs tabular-nums text-emerald-400">
                                                +{qty(d)} {l.item.uom?.symbol ?? ''}
                                              </td>
                                              <td className="whitespace-nowrap text-right text-xs tabular-nums">{formatRupees(rate)}</td>
                                              <td className="whitespace-nowrap text-right text-xs font-semibold tabular-nums">{formatRupees(d * rate)}</td>
                                            </tr>
                                          )
                                        }
                                        return (
                                          <tr key={l.id}>
                                            <td className="text-muted-foreground whitespace-nowrap font-mono text-xs">{l.item.code}</td>
                                            <td>
                                              <div className="text-foreground truncate text-xs" title={l.item.name}>
                                                {l.item.name}
                                              </div>
                                              {whoseLabel(l) && <div className="text-muted-foreground truncate text-[10px]">{whoseLabel(l)}</div>}
                                            </td>
                                            <ShadeCells item={l.item} />
                                            <td className="whitespace-nowrap text-right text-xs tabular-nums">
                                              {qty(l.bookQty)}
                                            </td>
                                            <td className="whitespace-nowrap text-right text-xs tabular-nums">
                                              {qty(l.countedQty)} {l.item.uom?.symbol ?? ''}
                                            </td>
                                            <td className="whitespace-nowrap text-right text-xs tabular-nums">
                                              {d === 0 ? (
                                                <span className="text-muted-foreground">matched</span>
                                              ) : (
                                                <span
                                                  className={d > 0 ? 'text-emerald-400' : 'text-red-400'}
                                                >
                                                  {d > 0 ? '+' : ''}
                                                  {qty(d)}
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
        )}
      </div>

      {labelling && (
        <OutwardStickers
          source={{ type: 'TRANSFER', id: labelling.id }}
          onClose={() => setLabelling(null)}
          onDone={(m) => {
            setLabelling(null)
            setMessage(m)
          }}
        />
      )}
      {stepping && (
        <TransitStepDialog
          transfer={stepping.t}
          step={stepping.step}
          onClose={() => setStepping(null)}
          onDone={(m) => {
            setStepping(null)
            setError(null)
            setStickers(null)
            setMessage(m)
            void load()
          }}
        />
      )}
      {stickersFor && (
        <StickersReady
          source={{ type: 'STOCK_IN', id: stickersFor.id }}
          onClose={() => setStickersFor(null)}
          onDone={(m) => {
            setStickersFor(null)
            setStickers(null)
            setMessage(m)
          }}
        />
      )}
      {approving && (
        <ReasonDialog
          title={`Approve ${approving.adjustmentNumber}?`}
          description={
            approving.kind === 'STOCK_IN'
              ? `${approving.lines.length} ${approving.lines.length === 1 ? 'item goes' : 'items go'} into stock in ${approving.warehouse.name} now, worth ${formatRupees(
                  approving.lines.reduce((s, l) => s + Number(l.difference) * Number(l.unitRate ?? 0), 0),
                )}. This cannot be undone except by a stock count.`
              : (
                  <>
                    {`The ${approving.lines.filter((l) => Number(l.difference) !== 0).length} counted difference(s) in ${approving.warehouse.name} go into stock now. This cannot be undone except by another count.`}
                    {' '}
                    {losses === null
                      ? 'Checking whose stock the shortages come from…'
                      : losses.length === 0
                        ? 'Shortages come out of central stock; gains go to central stock.'
                        : (
                            <>
                              {'Gains go to central stock. Shortages come out of central stock first, but these come out of a brand’s earmark: '}
                              {losses.map((l, i) => (
                                <span key={`${l.lineId}-${i}`} className="text-foreground font-medium">
                                  {i > 0 ? '; ' : ''}
                                  {l.brand} −{l.qty} {l.unit} {l.item}
                                  {l.size ? ` size ${l.size}` : ''}
                                  {l.named ? ' (its own, not found in the count)' : ''}
                                </span>
                              ))}
                              .
                            </>
                          )}
                  </>
                )
          }
          confirmLabel={approving.kind === 'STOCK_IN' ? 'Approve and add to stock' : 'Approve and correct stock'}
          requireReason={false}
          busy={busy === approving.id}
          onConfirm={() => void decide(approving, 'approve')}
          onCancel={() => setApproving(null)}
        />
      )}
      {refusing && (
        <ReasonDialog
          title={`Refuse ${refusing.adjustmentNumber}?`}
          description={
            refusing.kind === 'STOCK_IN'
              ? 'Nothing is added to stock. Say why, so whoever entered it can correct it.'
              : 'Stock stays as it is. Say why, so whoever counted can recount or correct it.'
          }
          confirmLabel={refusing.kind === 'STOCK_IN' ? 'Refuse the stock in' : 'Refuse the count'}
          danger
          busy={busy === refusing.id}
          onConfirm={(reason) => void decide(refusing, 'reject', reason)}
          onCancel={() => setRefusing(null)}
        />
      )}
    </div>
  )
}
