'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  X,
  Loader2,
  AlertCircle,
  Plus,
  Minus,
  PackageCheck,
  Truck,
  MapPin,
  ClipboardList,
  FileText,
  Paperclip,
  Pencil,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  api,
  apiErrorMessage,
  ApiError,
  masterResource,
  type Paginated,
  type Single,
} from '@/lib/api'
import {
  Section,
  addressLine,
  type SupplierAddressRow,
} from '@/components/purchase/PurchaseOrderDialog'
import { AttachmentsBox, type AttachmentsBoxHandle } from '@/components/purchase/AttachmentsBox'
import { IconField, Readout } from '@/components/purchase/FormBits'
import { shortCloseNoun } from '@/components/purchase/shortClose'

/**
 * Booking in what arrived against an order.
 *
 * The order is chosen first and its lines fill themselves in, because the store
 * keeper is checking a delivery against a document that already exists — asking
 * them to pick items again would be asking them to re-type an order somebody
 * else raised, and to get it wrong occasionally.
 *
 * Each line offers the quantity still due, which is right most of the time and
 * wrong visibly rather than silently when a delivery is short.
 *
 * Receiving and inspecting happen on this one screen. The mill's old ERP split
 * them — a store keeper recorded the arrival, and the receipt then sat in a
 * "Pending GRN for QC" list until somebody else entered approve and reject
 * quantities. Mahesh chose one screen on 18 Sep 2026: at this mill the same
 * person does both, and a second screen would be a queue that only ever had
 * one name in it.
 */

interface OrderOption {
  id: string
  poNumber: string
  status: string
  supplier: { id: string; name: string } | null
  deliveryWarehouse: { id: string; name: string; address?: string | null } | null
  /** What the order itself is billed to, snapshotted the day it was raised. */
  supplierAddress?: string | null
}

interface OrderLine {
  id: string
  qty: string | number
  receivedQty: string | number
  pendingQty: string | number
  unitRate: string | number
  /** Set once the balance of this line has been written off as not coming. */
  shortClosed?: boolean
  shortCloseReason?: string | null
  shortClosedBy?: { id: string; name: string } | null
  item: {
    id: string
    code: string
    name: string
    hsnCode?: string | null
    uom: { symbol: string } | null
    category?: { id: string; name: string; parent?: { id: string; name: string } | null } | null
  }
}

interface OrderDetail extends OrderOption {
  lines: OrderLine[]
}

/**
 * One store's share of one line, kept as text so a half-typed number is not a
 * zero.
 *
 * A list rather than a single figure because a delivery of 800kg routinely
 * goes 500 to the fabric godown and 300 to the works. That is one delivery and
 * one receipt, and the old ERP had a row per location for exactly this.
 */
interface Alloc {
  key: string
  warehouseId: string
  received: string
}

/** The delivery's own paperwork, all of it optional. */
interface Delivery {
  gateEntryNo: string
  gateEntryDate: string
  challanNo: string
  challanDate: string
  supplierBillNo: string
  supplierInvoiceNo: string
  supplierInvoiceDate: string
  packageCount: string
  driverName: string
  formNo: string
  clientName: string
  orderedBy: string
  referenceNo: string
}

const BLANK_DELIVERY: Delivery = {
  // The gate keeps its own running count starting at 1 each day, so this is
  // right far more often than it is wrong — and it is one box fewer to type
  // on a delivery that is the first of the day, which is most of them.
  gateEntryNo: '01',
  gateEntryDate: '',
  challanNo: '',
  challanDate: '',
  supplierBillNo: '',
  supplierInvoiceNo: '',
  supplierInvoiceDate: '',
  packageCount: '',
  driverName: '',
  formNo: '',
  clientName: '',
  orderedBy: '',
  referenceNo: '',
}

const num = (v: string | number | undefined) => Number(v) || 0

/** Blank rather than 0 or "", so an untouched box is left out of the payload. */
const text = (v: string) => (v.trim() === '' ? null : v.trim())
const when = (v: string) => (v === '' ? null : v)

/** An ISO instant, split for a `<input type="date">` and a `<input type="time">`. */
const toDateInput = (iso?: string | null) => (iso ? iso.slice(0, 10) : '')
const toTimeInput = (iso?: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** What `GET /purchase/grn/:id?view=editing` sends back. */
interface EditingGrn {
  vehicleNo: string | null
  notes: string | null
  grnDate: string
  gateEntryNo: string | null
  gateEntryDate: string | null
  challanNo: string | null
  challanDate: string | null
  supplierBillNo: string | null
  supplierInvoiceNo: string | null
  supplierInvoiceDate: string | null
  packageCount: number | null
  driverName: string | null
  formNo: string | null
  clientName: string | null
  orderedBy: string | null
  referenceNo: string | null
  overReceiptReason?: string | null
  supplierAddress: string | null
  shippingAddress: string | null
  lines: Array<{
    poLineId: string | null
    warehouseId: string
    receivedQty: string | number
    rejectedQty: string | number
  }>
  po: {
    id: string
    poNumber: string
    status: string
    supplier: OrderOption['supplier']
    deliveryWarehouse: OrderOption['deliveryWarehouse']
    supplierAddress?: string | null
    lines: Array<Omit<OrderLine, 'receivedQty' | 'pendingQty'>>
  } | null
  /** Received-elsewhere per order line — this receipt's own lines already left out. */
  otherReceived: Record<string, number>
}

/**
 * How far past its order a line may be booked before the receipt has to say
 * why. The server refuses at the same figure (`OVER_RECEIPT_ALLOWANCE` in the
 * purchase routes) — change both together.
 *
 * A little over is ordinary and needs nothing. Well over is usually a slipped
 * zero, so the line turns amber and the reason becomes required.
 */
const OVER_RECEIPT_ALLOWANCE = 0.1

function wellPastOrder(ordered: number, already: number, taking: number): boolean {
  return ordered > 0 && already + taking > ordered * (1 + OVER_RECEIPT_ALLOWANCE) + 0.0001
}

function OverNote({ extra, unit, wellOver }: { extra: number; unit: string; wellOver: boolean }) {
  const qty = `${Number(extra.toFixed(3))} ${unit}`.trim()
  return wellOver ? (
    <div className="mt-1 text-[11px] font-medium text-amber-400">
      {qty} more than is still due — over {OVER_RECEIPT_ALLOWANCE * 100}% past the order. Check the
      quantity.
    </div>
  ) : (
    <div className="text-muted-foreground mt-1 text-[11px]">{qty} more than is still due.</div>
  )
}

/** A stable empty list, so a line with no rows yet does not defeat the memo below. */
const NO_ALLOCS: Alloc[] = []

/**
 * One order line's rows in the What Arrived table.
 *
 * Its own component so it can be memoised: `setAlloc` replaces only the array
 * of the line that changed, so every other line's `allocs` keeps its identity
 * and skips re-rendering. That stops working the moment something rebuilds
 * `entries` wholesale.
 *
 * ── What the measurement actually showed ───────────────────────────────────
 *
 * Read this before assuming the memo is load-bearing. On a production build,
 * measured inside the page with the test runner's round trip removed, one
 * keystroke in a quantity box costs 67ms against 34ms for the note box outside
 * the table. Extracting and memoising this component, and the card below it,
 * took the DOM changes per keystroke from about 40 to 27 — and moved the
 * wall-clock not at all. 67ms before, 67ms after.
 *
 * So React's render work is NOT what those 33ms are. The figure is quantised
 * to frames (34ms is two, 67ms is four), which points at a second render-and-
 * paint cycle on the quantity path that nothing here has yet identified.
 * Whatever it is, it is not the number of lines being reconciled.
 *
 * These two components are kept anyway, on the ordinary grounds that 300 lines
 * of JSX inline in a map is worse than two named components, and that the work
 * they skip will matter on a twenty-line order in a way it does not on a
 * four-line one. They are not kept because they made typing faster, because
 * they did not.
 *
 * Also worth recording: measured on the dev server the two boxes came out at
 * 127ms and 128ms — indistinguishable — because dev-mode React renders
 * everything twice and buries the very difference being looked for. The
 * production build is the only one worth measuring.
 */
const ReceiptLineRows = memo(function ReceiptLineRows({
  line,
  allocs,
  storeOptions,
  setAlloc,
  addAlloc,
  removeAlloc,
}: {
  line: OrderLine
  allocs: Alloc[]
  storeOptions: React.ReactNode
  setAlloc: (lineId: string, key: string, patch: Partial<Alloc>) => void
  addAlloc: (lineId: string) => void
  removeAlloc: (lineId: string, key: string) => void
}) {
  const ordered = num(line.qty)
  const already = num(line.receivedQty)
  const pending = ordered - already
  const unit = line.item.uom?.symbol ?? ''
  const done = pending <= 0 || Boolean(line.shortClosed)
  const category = line.item.category
  const categoryLabel = category
    ? category.parent
      ? `${category.parent.name} / ${category.name}`
      : category.name
    : null

  /* The whole line's share of this delivery, added across its stores — the
     figure that has to fit inside what is still due, and the one the server
     checks. */
  const lineAccepted = allocs.reduce((sum, a) => sum + num(a.received), 0)
  const over = lineAccepted > pending + 0.0001

  return (
    <>
      {allocs.map((alloc, i) => {
        const first = i === 0

        return (
          <tr key={alloc.key} className="divide-border/60 divide-x [&>td]:align-top">
            {first && (
              <>
                <td rowSpan={allocs.length} className="align-top">
                  <div className="text-foreground text-sm font-medium">{line.item.name}</div>
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px]">
                    <span className="font-mono">{line.item.code}</span>
                    {categoryLabel && (
                      <>
                        <span>·</span>
                        <span>{categoryLabel}</span>
                      </>
                    )}
                    {line.item.hsnCode && (
                      <>
                        <span>·</span>
                        <span>HSN {line.item.hsnCode}</span>
                      </>
                    )}
                  </div>
                  {over && (
                    <OverNote
                      extra={lineAccepted - pending}
                      unit={unit}
                      wellOver={wellPastOrder(ordered, already, lineAccepted)}
                    />
                  )}
                  {line.shortClosed && (
                    <div
                      className="mt-1 text-[11px] text-amber-400"
                      title={line.shortCloseReason ?? undefined}
                    >
                      {shortCloseNoun(line.receivedQty)}
                      {line.shortClosedBy ? ` by ${line.shortClosedBy.name}` : ''} — no more
                      expected
                    </div>
                  )}
                </td>
                <td rowSpan={allocs.length} className="text-right align-top text-sm tabular-nums">
                  {ordered} {unit}
                </td>
                <td
                  rowSpan={allocs.length}
                  className="text-muted-foreground text-right align-top text-sm tabular-nums"
                >
                  {already > 0 ? `${already} ${unit}` : '—'}
                </td>
                <td rowSpan={allocs.length} className="text-right align-top text-sm tabular-nums">
                  {pending > 0 ? (
                    <span>
                      {Number(pending.toFixed(3))} {unit}
                    </span>
                  ) : (
                    <span className="badge-success">complete</span>
                  )}
                </td>
              </>
            )}

            <td>
              <input
                className="form-input h-9 text-right"
                inputMode="decimal"
                value={alloc.received}
                onChange={(e) => setAlloc(line.id, alloc.key, { received: e.target.value })}
                disabled={done}
                placeholder="Qty"
                aria-label={`Quantity of ${line.item.name} received on this receipt${
                  first ? '' : `, row ${i + 1}`
                }`}
              />
            </td>
            <td>
              <select
                className="form-input h-9"
                value={alloc.warehouseId}
                onChange={(e) => setAlloc(line.id, alloc.key, { warehouseId: e.target.value })}
                disabled={done}
                aria-label={`Store for ${line.item.name}${first ? '' : `, row ${i + 1}`}`}
              >
                <option value="">Choose…</option>
                {storeOptions}
              </select>
            </td>
            <td>
              {/* One delivery can go to more than one store. The first row
                keeps the add button; the rest can be taken away again. */}
              <div className="flex gap-1">
                {first ? (
                  <button
                    type="button"
                    className="border-border text-muted-foreground hover:text-foreground hover:bg-secondary inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => addAlloc(line.id)}
                    disabled={done}
                    title={`Send some of ${line.item.name} to another store`}
                    aria-label={`Add another store for ${line.item.name}`}
                  >
                    <Plus size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="border-border text-muted-foreground inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors hover:text-red-400"
                    onClick={() => removeAlloc(line.id, alloc.key)}
                    title="Remove this store"
                    aria-label={`Remove store row ${i + 1} for ${line.item.name}`}
                  >
                    <Minus size={14} />
                  </button>
                )}
              </div>
            </td>
          </tr>
        )
      })}
    </>
  )
})

/**
 * The same line as a card, for a screen too narrow for the table.
 *
 * `sm:hidden` hides it in CSS; React still renders every one of these on every
 * keystroke, on a desktop where not one of them is visible. That is why it is
 * memoised alongside the table rows — half the reconciliation was over here,
 * and memoising only the table would have left it doing the same work.
 *
 * See the note on `ReceiptLineRows` for what this did and did not buy.
 */
const ReceiptLineCard = memo(function ReceiptLineCard({
  line,
  allocs,
  storeOptions,
  setAlloc,
  addAlloc,
  removeAlloc,
}: {
  line: OrderLine
  allocs: Alloc[]
  storeOptions: React.ReactNode
  setAlloc: (lineId: string, key: string, patch: Partial<Alloc>) => void
  addAlloc: (lineId: string) => void
  removeAlloc: (lineId: string, key: string) => void
}) {
  const ordered = num(line.qty)
  const already = num(line.receivedQty)
  const pending = ordered - already
  const unit = line.item.uom?.symbol ?? ''
  const done = pending <= 0 || Boolean(line.shortClosed)
  const category = line.item.category
  const categoryLabel = category
    ? category.parent
      ? `${category.parent.name} / ${category.name}`
      : category.name
    : null
  const lineAccepted = allocs.reduce((sum, a) => sum + num(a.received), 0)
  const over = lineAccepted > pending + 0.0001
  const fieldLabel = 'text-muted-foreground text-[10px] font-semibold uppercase tracking-wider'

  return (
    <div key={line.id} className="border-border bg-card rounded-lg border p-3">
      <div className="text-foreground text-sm font-medium">{line.item.name}</div>
      <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px]">
        <span className="font-mono">{line.item.code}</span>
        {categoryLabel && (
          <>
            <span>·</span>
            <span>{categoryLabel}</span>
          </>
        )}
        {line.item.hsnCode && (
          <>
            <span>·</span>
            <span>HSN {line.item.hsnCode}</span>
          </>
        )}
      </div>
      {over && (
        <OverNote
          extra={lineAccepted - pending}
          unit={unit}
          wellOver={wellPastOrder(ordered, already, lineAccepted)}
        />
      )}
      {line.shortClosed && (
        <div className="mt-1 text-[11px] text-amber-400" title={line.shortCloseReason ?? undefined}>
          {shortCloseNoun(line.receivedQty)}
          {line.shortClosedBy ? ` by ${line.shortClosedBy.name}` : ''} — no more expected
        </div>
      )}

      <div className="border-border/70 mt-2 grid grid-cols-3 gap-2 border-t pt-2">
        <div>
          <p className={fieldLabel}>Ordered</p>
          <p className="text-sm tabular-nums">
            {ordered} {unit}
          </p>
        </div>
        <div>
          <p className={fieldLabel}>Received</p>
          <p className="text-muted-foreground text-sm tabular-nums">
            {already > 0 ? `${already} ${unit}` : '—'}
          </p>
        </div>
        <div>
          <p className={fieldLabel}>Still due</p>
          {pending > 0 ? (
            <p className="text-sm tabular-nums">
              {Number(pending.toFixed(3))} {unit}
            </p>
          ) : (
            <span className="badge-success">complete</span>
          )}
        </div>
      </div>

      {allocs.map((alloc, i) => {
        const accepted = num(alloc.received)
        const first = i === 0

        return (
          <div key={alloc.key} className="border-border/70 mt-2 space-y-2 rounded-md border p-2">
            <div className="flex items-center justify-between">
              <span className={fieldLabel}>{allocs.length > 1 ? `Store ${i + 1}` : 'Store'}</span>
              {first ? (
                <button
                  type="button"
                  className="border-border text-muted-foreground hover:text-foreground hover:bg-secondary inline-flex h-7 w-7 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => addAlloc(line.id)}
                  disabled={done}
                  title={`Send some of ${line.item.name} to another store`}
                  aria-label={`Add another store for ${line.item.name}`}
                >
                  <Plus size={13} />
                </button>
              ) : (
                <button
                  type="button"
                  className="border-border text-muted-foreground inline-flex h-7 w-7 items-center justify-center rounded-lg border transition-colors hover:text-red-400"
                  onClick={() => removeAlloc(line.id, alloc.key)}
                  title="Remove this store"
                  aria-label={`Remove store row ${i + 1} for ${line.item.name}`}
                >
                  <Minus size={13} />
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className={fieldLabel}>Received qty</label>
                <input
                  className="form-input h-9 w-full text-right"
                  inputMode="decimal"
                  value={alloc.received}
                  onChange={(e) => setAlloc(line.id, alloc.key, { received: e.target.value })}
                  disabled={done}
                  placeholder="Qty"
                  aria-label={`Quantity of ${line.item.name} received on this receipt${
                    first ? '' : `, row ${i + 1}`
                  }`}
                />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
})

export function ReceiveGoodsDialog({
  onClose,
  onSaved,
  poId: startOn,
  grnId,
}: {
  onClose: () => void
  onSaved: (message: string) => void
  /**
   * The order to open on, when the screen already knows which one.
   *
   * Pressing "Receive goods" against a row on a list has already answered the
   * first question the form asks. Making somebody answer it again in a dropdown
   * is a chance to pick the wrong order, not a confirmation.
   */
  poId?: string
  /**
   * A receipt already on the books, to correct rather than raise fresh.
   *
   * Its own order is fixed — that cannot be changed here — but everything
   * else, quantities included, can be. Takes over from `poId` entirely: the
   * two are never both passed.
   */
  grnId?: string
}) {
  const editing = Boolean(grnId)
  const [orders, setOrders] = useState<OrderOption[]>([])
  const [warehouses, setWarehouses] = useState<
    Array<{ id: string; name: string; address?: string | null }>
  >([])
  const [loadingLists, setLoadingLists] = useState(true)

  const [poId, setPoId] = useState(startOn ?? '')
  const [order, setOrder] = useState<OrderDetail | null>(null)
  const [loadingOrder, setLoadingOrder] = useState(false)

  const [entries, setEntries] = useState<Record<string, Alloc[]>>({})
  const [vehicleNo, setVehicleNo] = useState('')
  const [grnDate, setGrnDate] = useState('')
  const [grnTime, setGrnTime] = useState('')
  const [notes, setNotes] = useState('')
  const [delivery, setDelivery] = useState<Delivery>(BLANK_DELIVERY)

  /*
   * Which of the supplier's addresses this delivery's own paperwork names.
   *
   * Defaults to the order's own billing address — that is where it was
   * ordered from, and is right most of the time. Offered as a change rather
   * than fixed, because a supplier with more than one branch routinely ships
   * from whichever one has the stock, and the bill that follows has to be
   * checked against the address that is actually on it.
   */
  const [supplierAddresses, setSupplierAddresses] = useState<SupplierAddressRow[]>([])
  const [supplierAddressId, setSupplierAddressId] = useState('')

  /*
   * Which of the mill's own stores this delivery actually arrived at — the
   * old system's "Shipping Address". Defaults to the order's own delivery
   * warehouse, and can be changed when the lorry turned up somewhere else.
   */
  const [shippingWarehouseId, setShippingWarehouseId] = useState('')

  const attachmentsRef = useRef<AttachmentsBoxHandle>(null)
  const [attachmentCount, setAttachmentCount] = useState(0)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * A note on why this receipt books in more than the order asked for.
   *
   * Never required and never demanded — a delivery can run over or short by
   * any amount and still save. The box appears on its own once the numbers
   * typed exceed the order, as somewhere to put the explanation if there is
   * one worth keeping.
   */
  const [overReceiptReason, setOverReceiptReason] = useState('')

  /** Why an already-booked receipt is being corrected. Required on every edit. */
  const [editReason, setEditReason] = useState('')

  /** Rows need a stable key of their own — two rows can hold the same store. */
  const nextKey = useRef(0)
  const makeKey = () => `a${nextKey.current++}`

  /*
   * The store list, built once per set of warehouses.
   *
   * There is one of these dropdowns on every allocation row, and every
   * keystroke in a quantity box re-renders the whole table — so the full
   * option list was being rebuilt for each dropdown on each character typed.
   * Elements are immutable, so the one array is safe to hand to all of them.
   */
  const storeOptions = useMemo(
    () =>
      warehouses.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      )),
    [warehouses]
  )

  // Only orders that have actually been sent can be received against, so those
  // are the only ones offered. A draft in this list would be a door the server
  // is certain to shut.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        /*
         * Correcting a receipt does not need the picker.
         *
         * The order is already decided — the dropdown is replaced by a
         * disabled box showing its number — so the two hundred-row order
         * queries behind it were fetched, waited for, and thrown away every
         * time somebody opened a correction. They were also the slowest part
         * of opening it: the receipt's own lines cannot be drawn until this
         * resolves, because the Store dropdowns need the warehouses.
         *
         * The stores are still wanted either way. Asking for one list instead
         * of three is most of the wait gone.
         */
        const [w, sent, partly] = await Promise.all([
          masterResource<{ id: string; name: string; address?: string | null }>('warehouses').list({
            limit: 100,
          }),
          editing
            ? null
            : api.get<Paginated<OrderOption>>('/purchase/orders?status=SENT&limit=100&view=picker'),
          editing
            ? null
            : api.get<Paginated<OrderOption>>(
                '/purchase/orders?status=PARTIALLY_RECEIVED&limit=100&view=picker'
              ),
        ])
        if (cancelled) return
        setOrders([...(sent?.data ?? []), ...(partly?.data ?? [])])
        setWarehouses(w.data)
      } catch {
        if (!cancelled) setError('Could not load the open purchase orders.')
      } finally {
        if (!cancelled) setLoadingLists(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [editing])

  useEffect(() => {
    // A receipt being corrected loads through the effect below instead —
    // this one exists to turn a freshly-picked order into a blank receipt,
    // which is not what an edit is. That includes its note: clearing it here
    // too would wipe the reason the correction loaded, whenever the store
    // list arrived after the receipt did.
    if (editing) return

    // A fresh order starts with a blank note — carrying one over from
    // whatever order was open before would attach it to the wrong receipt.
    setOverReceiptReason('')

    if (!poId) {
      setOrder(null)
      setEntries({})
      return
    }

    let cancelled = false
    setLoadingOrder(true)
    setError(null)

    void (async () => {
      try {
        const res = await api.get<Single<OrderDetail>>(`/purchase/orders/${poId}?view=receiving`)
        if (cancelled) return

        const detail = res.data
        setOrder(detail)

        // Where the supplier was told to deliver is the sensible default, and
        // the store keeper can move any line somewhere else.
        const fallback = detail.deliveryWarehouse?.id ?? warehouses[0]?.id ?? ''
        setShippingWarehouseId(fallback)

        setEntries(
          Object.fromEntries(
            detail.lines.map((l) => {
              return [
                l.id,
                [
                  {
                    key: makeKey(),
                    warehouseId: fallback,
                    // Blank, not the quantity still due. Pre-filling the full
                    // amount reads as a confirmation that everything ordered
                    // has arrived — the one thing a store keeper is here to
                    // check, not assume.
                    received: '',
                  },
                ],
              ]
            })
          )
        )
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not open that order.')
          setOrder(null)
        }
      } finally {
        if (!cancelled) setLoadingOrder(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [poId, warehouses, editing])

  /*
   * Loads a receipt already on the books, for correcting rather than raising
   * fresh. Everything the create path builds from a freshly-picked order —
   * `order`, the per-line rows, the paperwork, both addresses — is built here
   * instead from the receipt itself and the order it was raised against.
   */
  useEffect(() => {
    if (!grnId) return

    let cancelled = false
    setLoadingOrder(true)
    setError(null)

    void (async () => {
      try {
        const res = await api.get<Single<EditingGrn>>(`/purchase/grn/${grnId}?view=editing`)
        if (cancelled) return

        const g = res.data
        const po = g.po
        if (!po) throw new Error('The order this receipt was raised against no longer exists.')

        const detail: OrderDetail = {
          id: po.id,
          poNumber: po.poNumber,
          status: po.status,
          supplier: po.supplier,
          deliveryWarehouse: po.deliveryWarehouse,
          supplierAddress: po.supplierAddress,
          lines: po.lines.map((l) => ({
            ...l,
            // What every other receipt against this line already accounts
            // for — this receipt's own lines are left out on purpose, the
            // same way saving the correction leaves them out.
            receivedQty: g.otherReceived[l.id] ?? 0,
            pendingQty: 0,
          })),
        }
        setOrder(detail)

        const byPoLine: Record<string, Alloc[]> = {}
        for (const l of g.lines) {
          if (!l.poLineId) continue
          const arr = byPoLine[l.poLineId] ?? (byPoLine[l.poLineId] = [])
          arr.push({
            key: makeKey(),
            warehouseId: l.warehouseId,
            received: String(l.receivedQty),
          })
        }
        // A line this receipt never touched still gets a row — empty, same
        // as a fresh receipt — so it can be added without reopening later.
        const fallback = po.deliveryWarehouse?.id ?? warehouses[0]?.id ?? ''
        for (const l of po.lines) {
          if (!byPoLine[l.id]) {
            byPoLine[l.id] = [{ key: makeKey(), warehouseId: fallback, received: '' }]
          }
        }
        setEntries(byPoLine)

        setVehicleNo(g.vehicleNo ?? '')
        setNotes(g.notes ?? '')
        // Saving the correction writes the note back, so a receipt already
        // explained keeps its explanation rather than losing it to a blank.
        setOverReceiptReason(g.overReceiptReason ?? '')
        setGrnDate(toDateInput(g.grnDate))
        setGrnTime(toTimeInput(g.grnDate))
        setDelivery({
          gateEntryNo: g.gateEntryNo ?? '',
          gateEntryDate: toDateInput(g.gateEntryDate),
          challanNo: g.challanNo ?? '',
          challanDate: toDateInput(g.challanDate),
          supplierBillNo: g.supplierBillNo ?? '',
          supplierInvoiceNo: g.supplierInvoiceNo ?? '',
          supplierInvoiceDate: toDateInput(g.supplierInvoiceDate),
          packageCount: g.packageCount != null ? String(g.packageCount) : '',
          driverName: g.driverName ?? '',
          formNo: g.formNo ?? '',
          clientName: g.clientName ?? '',
          orderedBy: g.orderedBy ?? '',
          referenceNo: g.referenceNo ?? '',
        })

        // Matched back to a warehouse by its address text, the same way the
        // supplier address below is matched — the receipt keeps only the
        // frozen text, never a link to the row that made it.
        const shipSnapshot = g.shippingAddress?.trim()
        const shipMatch = shipSnapshot
          ? warehouses.find((w) => (w.address ?? '').trim() === shipSnapshot)
          : undefined
        setShippingWarehouseId(shipMatch?.id ?? fallback)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not open that receipt.')
          setOrder(null)
        }
      } finally {
        if (!cancelled) setLoadingOrder(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [grnId, warehouses])

  /*
   * The supplier's addresses on file, and which one this receipt starts on.
   *
   * Matched back to the order's own snapshot by its text, the same way the
   * order form itself reopens a saved address — neither document keeps a
   * link to the address row, because an address the master changes tomorrow
   * must not rewrite a receipt already saved today. If nothing matches — a
   * new order, or the supplier's addresses have moved on — the default on
   * file is the honest thing to offer.
   */
  useEffect(() => {
    if (!order?.supplier) {
      setSupplierAddresses([])
      setSupplierAddressId('')
      return
    }
    let cancelled = false
    void api
      .get<{ data: SupplierAddressRow[] }>(`/masters/suppliers/${order.supplier.id}/addresses`)
      .then((res) => {
        if (cancelled) return
        setSupplierAddresses(res.data)
        const snapshot = order.supplierAddress?.trim()
        const same = snapshot ? res.data.find((a) => addressLine(a) === snapshot) : undefined
        setSupplierAddressId(
          same?.id ?? (res.data.find((a) => a.isDefault) ?? res.data[0])?.id ?? ''
        )
      })
      .catch(() => {
        if (!cancelled) setSupplierAddresses([])
      })
    return () => {
      cancelled = true
    }
  }, [order?.supplier?.id, order?.supplierAddress])

  /* These three keep one identity for the life of the dialog, which is what
     lets the memo on `ReceiptLineRows` above actually hold. A fresh function
     every render would be a changed prop on every line, every keystroke. */
  const setAlloc = useCallback(
    (lineId: string, key: string, patch: Partial<Alloc>) =>
      setEntries((prev) => ({
        ...prev,
        [lineId]: (prev[lineId] ?? []).map((a) => (a.key === key ? { ...a, ...patch } : a)),
      })),
    []
  )

  /*
   * A second store for a line starts empty, not with the quantity still due.
   * The first row already offered that, and splitting a delivery means moving
   * some of it — an offer here would have to be deleted before it could be
   * corrected.
   */
  const addAlloc = useCallback(
    (lineId: string) =>
      setEntries((prev) => ({
        ...prev,
        [lineId]: [
          ...(prev[lineId] ?? []),
          { key: `a${nextKey.current++}`, warehouseId: '', received: '' },
        ],
      })),
    []
  )

  const removeAlloc = useCallback(
    (lineId: string, key: string) =>
      setEntries((prev) => ({
        ...prev,
        [lineId]: (prev[lineId] ?? []).filter((a) => a.key !== key),
      })),
    []
  )

  const setField = (patch: Partial<Delivery>) => setDelivery((prev) => ({ ...prev, ...patch }))

  const save = async () => {
    setError(null)
    if (!order) return setError('Choose the order these goods came against.')

    const rows = order.lines.flatMap((line) =>
      (entries[line.id] ?? []).filter((a) => num(a.received) > 0).map((a) => ({ line, alloc: a }))
    )

    if (rows.length === 0) {
      return setError('Enter what arrived on at least one line.')
    }
    if (rows.some(({ alloc }) => !alloc.warehouseId)) {
      return setError('Every row needs a store to go into.')
    }

    /*
     * The challan, refused here as well as on the server.
     *
     * It is the one piece of the delivery's paperwork the receipt cannot do
     * without: it is the paper that travelled with the goods, and it is what
     * a query about the supplier's bill is settled against months later. A
     * receipt that cannot name one cannot be checked against anything.
     *
     * Named separately rather than as one message about "the challan", so the
     * store keeper is not told to look at a box they have already filled in.
     */
    if (!delivery.challanNo.trim()) {
      return setError(
        "Enter the challan number, under Delivery Paperwork — it is on the supplier's delivery note."
      )
    }
    if (!delivery.challanDate) {
      return setError('Enter the challan date, under Delivery Paperwork.')
    }

    // Well past the order is usually a slipped zero. Nothing is refused for
    // it — the store keeper only has to say it is real.
    if (needsOverReason) {
      document.getElementById('grn-over-reason')?.focus()
      return setError(
        `A line is more than ${OVER_RECEIPT_ALLOWANCE * 100}% over its order. Check the quantity; if it is right, say why in "Why more than ordered".`
      )
    }

    /*
     * Caught here as well as on the server. The server's message names the
     * item and is the one that counts, but a store keeper who has just split a
     * line across two stores should be told before the round trip.
     */
    const doubled = rows.find(
      ({ line, alloc }, i) =>
        rows.findIndex(
          (r, j) => j < i && r.line.id === line.id && r.alloc.warehouseId === alloc.warehouseId
        ) !== -1
    )
    if (doubled) {
      return setError(
        `${doubled.line.item.name} is going into the same store on two rows. Put the whole quantity on one row, or pick another store.`
      )
    }

    if (editing && !editReason.trim()) {
      return setError('Say why this receipt is being corrected — one line is enough.')
    }

    // The date and the time are typed separately and sent as one instant. Two
    // deliveries from the same supplier on one day are told apart by nothing
    // else.
    const stamp = grnDate ? (grnTime ? `${grnDate}T${grnTime}` : grnDate) : undefined

    const paperwork = {
      grnDate: stamp,
      vehicleNo: text(vehicleNo),
      notes: text(notes),
      supplierAddressId: supplierAddressId || null,
      shippingWarehouseId: shippingWarehouseId || null,
      overReceiptReason: text(overReceiptReason),

      gateEntryNo: text(delivery.gateEntryNo),
      gateEntryDate: when(delivery.gateEntryDate),
      challanNo: text(delivery.challanNo),
      challanDate: when(delivery.challanDate),
      supplierBillNo: text(delivery.supplierBillNo),
      supplierInvoiceNo: text(delivery.supplierInvoiceNo),
      supplierInvoiceDate: when(delivery.supplierInvoiceDate),
      packageCount: delivery.packageCount.trim() === '' ? null : num(delivery.packageCount),
      driverName: text(delivery.driverName),
      formNo: text(delivery.formNo),
      clientName: text(delivery.clientName),
      orderedBy: text(delivery.orderedBy),
      referenceNo: text(delivery.referenceNo),

      lines: rows.map(({ line, alloc }) => ({
        poLineId: line.id,
        warehouseId: alloc.warehouseId,
        receivedQty: num(alloc.received),
      })),
    }

    setSaving(true)
    try {
      const res = editing
        ? await api.patch<{ message?: string; data: { id: string; grnNumber: string } }>(
            `/purchase/grn/${grnId}`,
            { ...paperwork, editReason: editReason.trim() }
          )
        : await api.post<{ message?: string; data: { id: string; grnNumber: string } }>(
            '/purchase/grn',
            { ...paperwork, poId: order.id }
          )

      /*
       * Files chosen before the receipt existed. It has a number now, so they
       * have something to belong to.
       *
       * A failure here does not undo the receipt — the stock is already on the
       * rack, and throwing that away over an attachment would be the worse
       * outcome. Whatever did not make it is named instead, and can be added
       * by reopening the receipt. Correcting an existing receipt has nothing
       * pending — its files were already sent the moment they were chosen.
       */
      const { failed } = (await attachmentsRef.current?.uploadPending(res.data.id)) ?? {
        failed: [],
      }
      const base = res.message ?? `${res.data.grnNumber} saved and the stock is in.`
      onSaved(
        failed.length
          ? `${base} ${failed.length === 1 ? 'A file' : `${failed.length} files`} did not attach: ${failed.join(', ')}.`
          : base
      )
    } catch (err) {
      setError(apiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  /** The paperwork boxes, so eleven near-identical labels are written once. */
  const paper = (
    label: string,
    field: keyof Delivery,
    opts: {
      type?: string
      placeholder?: string
      help?: string
      min?: number
      /** Refused on save, and said so before the press rather than after it. */
      required?: boolean
    } = {}
  ) => (
    <label className="block">
      <span className="form-label">
        {label}
        {opts.required && (
          <span className="ml-0.5 text-red-400" aria-hidden>
            *
          </span>
        )}
      </span>
      <input
        type={opts.type ?? 'text'}
        required={opts.required}
        aria-required={opts.required}
        /* Tinted while empty, the same amber the order form's missing
          quantities wear. Not red: nothing has gone wrong yet — the box is
          simply not filled in, and a form that opens shouting is a form
          people stop reading. */
        className={`form-input h-9${
          opts.required && delivery[field].trim() === '' ? 'border-amber-500/70' : ''
        }`}
        value={delivery[field]}
        min={opts.min}
        onChange={(e) => {
          const raw = e.target.value
          // A package count under zero is not a smaller delivery, it is a
          // typo — the box simply will not hold one, the same way it will
          // not hold a letter. "-" alone is let through rather than bounced
          // on the first keystroke of a number that has not been typed yet.
          if (opts.min != null && raw !== '-' && Number(raw) < opts.min) return
          setField({ [field]: raw } as Partial<Delivery>)
        }}
        placeholder={opts.placeholder}
      />
      {opts.help && <span className="form-help">{opts.help}</span>}
    </label>
  )

  /*
   * Whether anything on this receipt books in more than the order still has
   * outstanding. Nothing is refused on the strength of it — it only decides
   * whether to offer the note box, so a delivery that ran over has somewhere
   * to say why while an ordinary one stays out of the way.
   */
  const booksOverOrder = (order?.lines ?? []).some((line) => {
    const pending = num(line.qty) - num(line.receivedQty)
    const taking = (entries[line.id] ?? []).reduce((sum, a) => sum + num(a.received), 0)
    return taking > pending
  })
  // A line far enough past its order that the reason stops being optional.
  const wellOverOrder = (order?.lines ?? []).some((line) =>
    wellPastOrder(
      num(line.qty),
      num(line.receivedQty),
      (entries[line.id] ?? []).reduce((sum, a) => sum + num(a.received), 0)
    )
  )
  const needsOverReason = wellOverOrder && overReceiptReason.trim().length < 5

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      {/* `h-full`, not a cap. A cap only says how tall the card may not be, so
        a form shorter than the screen hugs its content and the leftover is
        split above and below as centring slack — which is the strip of dimmed
        page that kept showing over the top. Filling the height makes the
        margin the padding and nothing else. */}
      <div
        className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="grn-dialog-title"
      >
        {/* Header — stays put while the body scrolls, so it is always clear
          what is being filled in and Save is always one press away. */}
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <PackageCheck size={19} className="text-primary" />
            </div>
            <div>
              <h2
                id="grn-dialog-title"
                className="text-foreground truncate text-xl font-semibold tracking-tight"
              >
                {editing ? 'Correct a receipt' : 'Receive goods'}
              </h2>
              <p className="text-muted-foreground mt-0.5 text-[13px]">
                {order
                  ? `${editing ? 'Correcting' : 'Against'} ${order.poNumber} — ${order.supplier?.name ?? 'supplier not named'}`
                  : editing
                    ? 'Opening the receipt…'
                    : 'Book in a delivery against a purchase order'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden md:block">
              <button
                className="btn-primary"
                onClick={() => void save()}
                disabled={saving || !order || loadingOrder}
              >
                {saving ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : editing ? (
                  <Pencil size={15} />
                ) : (
                  <PackageCheck size={15} />
                )}
                {editing ? 'Save correction' : 'Receive goods'}
              </button>
            </div>
            <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body — the only thing that scrolls */}
        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-2.5">
          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {booksOverOrder && (
            <label className="block">
              <span className="form-label">
                Why more than ordered{' '}
                {wellOverOrder ? (
                  <span className="text-red-400">*</span>
                ) : (
                  <span className="text-muted-foreground font-normal">(optional)</span>
                )}
              </span>
              <input
                id="grn-over-reason"
                className={`form-input h-9 ${needsOverReason ? 'border-amber-500/70' : ''}`}
                value={overReceiptReason}
                onChange={(e) => setOverReceiptReason(e.target.value)}
                placeholder="e.g. supplier combined this with next month's delivery"
              />
            </label>
          )}

          {editing && (
            <label className="block">
              <span className="form-label">Why this receipt is being corrected (required)</span>
              <input
                className="form-input h-9"
                value={editReason}
                onChange={(e) => setEditReason(e.target.value)}
                placeholder="e.g. store keeper mis-typed the quantity that arrived"
              />
            </label>
          )}

          <Section icon={FileText} title="Purchase &amp; Supplier Details">
            {/* Two groups rather than one flat row of five, and each sized
              by `auto-fit` rather than a fixed column count. A fixed
              `grid-cols-3` for order/supplier/vehicle looked right on the
              one phone it was built against and then clipped its own date
              and time boxes to "dd-m" and "--:-" on a narrower one — a
              track that has nowhere left to shrink just cuts the text
              inside it instead of admitting defeat. `minmax` gives every
              column a floor it will not shrink past, so a row that cannot
              fit at that floor drops a column instead of clipping one.
              `sm:contents` dissolves both groups at the tablet width up —
              the five fields fall back into the plain `sm:grid-cols-2
              lg:grid-cols-5` row this section already had, unchanged. */}
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
              <div className="grid grid-cols-[repeat(auto-fit,minmax(105px,1fr))] gap-2.5 sm:contents">
                <label className="block">
                  <span className="form-label">Purchase order</span>
                  {editing ? (
                    <input
                      className="form-input text-muted-foreground h-9"
                      value={order?.poNumber ?? ''}
                      disabled
                    />
                  ) : (
                    <select
                      className="form-input h-9"
                      value={poId}
                      onChange={(e) => setPoId(e.target.value)}
                      disabled={loadingLists}
                    >
                      <option value="">Choose…</option>
                      {orders.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.poNumber}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
                <label className="block">
                  <span className="form-label">Supplier</span>
                  <input
                    className="form-input text-muted-foreground h-9"
                    value={order?.supplier?.name ?? ''}
                    disabled
                    placeholder="—"
                  />
                </label>
              </div>
              <div className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(105px,1fr))] gap-2.5 sm:mt-0 sm:contents">
                <label className="block">
                  <span className="form-label">Vehicle number</span>
                  <input
                    className="form-input h-9"
                    value={vehicleNo}
                    onChange={(e) => setVehicleNo(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="form-label">Received on</span>
                  <input
                    type="date"
                    className="form-input h-9"
                    value={grnDate}
                    onChange={(e) => setGrnDate(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="form-label">At</span>
                  <input
                    type="time"
                    className="form-input h-9"
                    value={grnTime}
                    onChange={(e) => setGrnTime(e.target.value)}
                    aria-label="Time the goods were received"
                  />
                </label>
              </div>
            </div>

            {/* The supplier's own address, and which of the mill's stores the
              lorry arrived at — the old system's "Billing Address" and
              "Shipping Address", side by side since they are answered
              together. Shown once an order is picked, since that is where
              both defaults come from. */}
            {order && (
              /* Boxed, and captioned above like every other field on the form.
                 These were a bare line of 11px grey riding on a hairline rule:
                 the address the delivery is checked against read as a footnote
                 rather than as one of the two facts the store keeper is meant
                 to confirm before signing for a lorry. A pin and a lorry say
                 which is which without reading either caption. */
              <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
                {order.supplier &&
                  (supplierAddresses.length > 1 ? (
                    <IconField label="Supplier Address" icon={MapPin}>
                      <select
                        className="form-input pl-9"
                        value={supplierAddressId}
                        onChange={(e) => setSupplierAddressId(e.target.value)}
                        aria-label="Which of the supplier's addresses this delivery is checked against"
                      >
                        {supplierAddresses.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.label ? `${a.label} — ` : ''}
                            {addressLine(a)}
                          </option>
                        ))}
                      </select>
                    </IconField>
                  ) : (
                    <Readout label="Supplier Address" icon={MapPin}>
                      {supplierAddresses[0]
                        ? addressLine(supplierAddresses[0])
                        : (order.supplierAddress ?? '—')}
                    </Readout>
                  ))}

                {warehouses.length > 1 ? (
                  <IconField label="Shipping Address" icon={Truck}>
                    <select
                      className="form-input pl-9"
                      value={shippingWarehouseId}
                      onChange={(e) => setShippingWarehouseId(e.target.value)}
                      aria-label="Which of the mill's stores this delivery arrived at"
                    >
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                          {w.address ? ` — ${w.address}` : ''}
                        </option>
                      ))}
                    </select>
                  </IconField>
                ) : (
                  <Readout label="Shipping Address" icon={Truck}>
                    {warehouses[0]
                      ? `${warehouses[0].name}${warehouses[0].address ? ` — ${warehouses[0].address}` : ''}`
                      : '—'}
                  </Readout>
                )}
              </div>
            )}
          </Section>

          {/* —— The delivery's own paperwork ——

            Eleven boxes, none of them required. They are here because the
            mill's old ERP had every one of them, and because they are what
            settles a query about the supplier's bill months later: the gate
            entry is our own independent trace that a lorry came, and the
            challan is the document that physically travelled with the goods.

            Collapsible, and open to start. Somebody standing at the gate with
            the paperwork in hand wants it in front of them; somebody booking
            in a walk-in delivery with no paperwork at all can fold it away.

            Folded to start when correcting, though. The paperwork was filled
            in when the lorry arrived and is almost never what is wrong — a
            correction is nearly always a quantity. Eleven boxes already
            answered stood between the person and the one row they came to
            change, and pushed the lines off the bottom of the screen on a
            laptop. Folded, the whole receipt fits without scrolling, and the
            paperwork is one press away on the days it is the thing that was
            mis-typed. */}
          <Section
            /* Remounted once a receipt being corrected has arrived. `Section`
              reads `openByDefault` when it mounts, and the form mounts before
              the record does — at that moment every box is empty and "is the
              challan missing?" has no answer yet. */
            key={editing && loadingOrder ? 'paperwork-loading' : 'paperwork'}
            icon={ClipboardList}
            title="Delivery Paperwork"
            foldable
            /* Folded when correcting, because a correction is nearly always a
              quantity — unless the challan is what is missing, in which case
              the panel holding it cannot start out of sight. */
            openByDefault={!editing || !delivery.challanNo || !delivery.challanDate}
            summary="Challan number and date needed — gate entry and the supplier's bill optional"
          >
            {/* `auto-fit`, not a fixed two columns — the gate entry pairs
              with its own date and the challan with its on any phone wide
              enough to hold both without clipping either, and drops to one
              column instead of clipping on a phone that is not. */}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(105px,1fr))] gap-2.5 lg:grid-cols-4">
              {paper('Gate entry number', 'gateEntryNo')}
              {paper('Gate entry date', 'gateEntryDate', { type: 'date' })}
              {paper('Challan number', 'challanNo', {
                required: true,
                help: 'A range is fine when one delivery covers several',
              })}
              {paper('Challan date', 'challanDate', { type: 'date', required: true })}

              {paper('Supplier bill number', 'supplierInvoiceNo', {
                help: 'What accounts will book the bill against',
              })}
              {paper('Supplier bill date', 'supplierInvoiceDate', { type: 'date' })}
              {paper('Packages', 'packageCount', {
                type: 'number',
                placeholder: '0',
                help: 'Bales, cartons or rolls off the vehicle',
                min: 0,
              })}

              {paper('Driver name', 'driverName')}
              {paper('Client name', 'clientName')}
              {paper('Ordered by', 'orderedBy')}
              {paper('Reference', 'referenceNo')}
            </div>
          </Section>

          {/* Only while picking an order, and only as a banner.

              Correcting a receipt has its order already — and a completed
              order is not in the picker's list, which is how "No orders are
              waiting for goods" came to sit in the middle of a form that was
              plainly showing PO-0001's four lines underneath it. Floating
              grey text between two boxed sections read as a stray line
              anyway; a banner says it is a notice about the empty picker
              above, which is the only thing it was ever about. */}
          {!loadingLists && !editing && orders.length === 0 && (
            <div className="border-border bg-secondary/40 text-muted-foreground flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm">
              <ClipboardList size={16} className="mt-px shrink-0" />
              <span>
                No orders are waiting for goods. An order has to be sent to the supplier before
                anything can be received against it.
              </span>
            </div>
          )}

          {/* Otherwise the form ends after two short boxes and leaves the rest
              of the card empty — reading as broken rather than as waiting on
              a choice only the store keeper can make. */}
          {!loadingLists && !editing && orders.length > 0 && !poId && (
            <p className="text-muted-foreground py-10 text-center text-sm">
              Pick a purchase order above to see what&rsquo;s due.
            </p>
          )}

          {/* The shape of what is coming, rather than a line of text.

              The dialog itself has always opened at once — it is this part,
              the lines, that waits on the order. A single grey sentence where
              the table belongs makes that wait read as a stall; a table-shaped
              placeholder makes it read as loading, and the panel does not jump
              when the real rows land on top of it. */}
          {loadingOrder && (
            <Section icon={PackageCheck} title="What Arrived">
              <div
                className="border-border overflow-hidden rounded-lg border"
                role="status"
                aria-label="Opening the order"
              >
                <div className="border-border bg-secondary/40 border-b px-3 py-2.5">
                  <div className="bg-muted-foreground/20 h-3 w-28 animate-pulse rounded" />
                </div>
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="border-border/50 flex items-center gap-3 border-b px-3 py-3 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="bg-muted-foreground/20 h-3.5 w-2/5 animate-pulse rounded" />
                      <div className="bg-muted-foreground/10 h-2.5 w-3/5 animate-pulse rounded" />
                    </div>
                    <div className="bg-muted-foreground/10 h-3 w-12 animate-pulse rounded" />
                    <div className="bg-muted-foreground/10 h-3 w-12 animate-pulse rounded" />
                    <div className="bg-muted-foreground/20 h-9 w-24 animate-pulse rounded-lg" />
                    <div className="bg-muted-foreground/20 h-9 w-32 animate-pulse rounded-lg" />
                  </div>
                ))}
              </div>
              <span className="sr-only">Opening the order…</span>
            </Section>
          )}

          {order && !loadingOrder && (
            <Section icon={PackageCheck} title="What Arrived">
              <div className="border-border hidden overflow-x-auto rounded-lg border sm:block">
                {/* A floor, so the columns scroll rather than squash. Most of
                them are figures being typed into, and a number box squeezed to
                two characters is one somebody will mis-key.

                `table-fixed`, not auto. Auto layout sizes a column off the
                widest thing that could ever sit in it — and a `<select>`'s
                "widest thing" is its longest option, not whatever is currently
                chosen. One warehouse with a long name anywhere in the list was
                enough to push the Store column wide and starve some other
                column of the room this colgroup gives it, which is what was
                actually clipping a name as ordinary as "Fabric Godown". Fixed
                layout makes the colgroup the only vote; content never
                overrides it. The one column without a percentage — the
                add-store button — gets a pixel width instead, because fixed
                layout has no equivalent of auto's "shrink to content" trick. */}
                {/* Nine columns were declared here for a seven-column table.
                    Under `table-fixed` the colgroup is the only vote, so the
                    two spare entries became two empty columns down the right
                    of every row — the whitespace — and every real column was
                    reading a width meant for the one before it. Store was the
                    sixth header taking the sixth col's 8%, which is why a
                    name as ordinary as "Fabric Godown" came out as "Fabric
                    G…" in a box the comment above says was widened to stop
                    exactly that. Seven cols now, one per header, and they add
                    up to 100. */}
                <table className="data-table table-compact w-full min-w-[980px] table-fixed">
                  <colgroup>
                    <col style={{ width: '31%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '15%' }} />
                    <col style={{ width: '20%' }} />
                    <col style={{ width: '4%' }} />
                  </colgroup>
                  <thead>
                    <tr className="divide-border/60 divide-x">
                      <th>Item</th>
                      <th className="text-right">Ordered</th>
                      <th className="text-right">Received till now</th>
                      <th className="text-right">Still due</th>
                      <th className="text-right">Received qty</th>
                      <th>Store</th>
                      <th>
                        <span className="sr-only">Split across stores</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.lines.map((line) => (
                      <ReceiptLineRows
                        key={line.id}
                        line={line}
                        allocs={entries[line.id] ?? NO_ALLOCS}
                        storeOptions={storeOptions}
                        setAlloc={setAlloc}
                        addAlloc={addAlloc}
                        removeAlloc={removeAlloc}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Same lines, one card each, for a screen too narrow for nine
                columns. Every store split for a line sits inside its own
                boxed block underneath, so nothing is typed off the right
                edge of a table nobody can widen. */}
              <div className="space-y-3 sm:hidden">
                {order.lines.map((line) => (
                  <ReceiptLineCard
                    key={line.id}
                    line={line}
                    allocs={entries[line.id] ?? NO_ALLOCS}
                    storeOptions={storeOptions}
                    setAlloc={setAlloc}
                    addAlloc={addAlloc}
                    removeAlloc={removeAlloc}
                  />
                ))}
              </div>

              {/* Note and attachments, side by side — neither is more than a
                few lines tall on its own, and stacking them just to stack them
                was the extra scroll this row removes. The challan, the
                supplier's invoice, a photo of a damaged carton: never
                required, and kept with the items they belong to rather than
                off with the paperwork boxes above. */}
              <div className="border-border mt-2 grid gap-3 border-t pt-2 sm:grid-cols-2">
                <label className="block">
                  <span className="form-label">Note (optional)</span>
                  <input
                    className="form-input h-9"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Anything worth remembering about this delivery"
                  />
                </label>

                <div>
                  <div className="mb-1.5 flex items-center gap-2">
                    <Paperclip size={14} className="text-muted-foreground" />
                    <span className="form-label mb-0">
                      Attachments{' '}
                      <span className="text-muted-foreground font-normal normal-case">
                        —{' '}
                        {attachmentCount
                          ? `${attachmentCount} file${attachmentCount === 1 ? '' : 's'}`
                          : 'optional'}
                      </span>
                    </span>
                  </div>
                  <AttachmentsBox
                    ref={attachmentsRef}
                    basePath="/purchase/grn"
                    linkBasePath="/purchase/grn-attachments"
                    recordId={grnId}
                    onError={setError}
                    onCountChange={setAttachmentCount}
                  />
                </div>
              </div>
            </Section>
          )}
        </div>

        {/* Footer — pinned, so Save stays one press away no matter how far
          the body has scrolled. Repeated from the header's own button, which
          a phone hides. */}
        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-3 border-t px-5 py-3.5">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void save()}
            disabled={saving || !order || loadingOrder}
          >
            {saving ? (
              <Loader2 size={15} className="animate-spin" />
            ) : editing ? (
              <Pencil size={15} />
            ) : (
              <PackageCheck size={15} />
            )}
            {editing ? 'Save correction' : 'Receive goods'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
