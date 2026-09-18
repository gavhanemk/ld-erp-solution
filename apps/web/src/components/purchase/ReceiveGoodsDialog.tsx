'use client'

import { useEffect, useRef, useState } from 'react'
import { X, Loader2, AlertCircle, Plus, Minus, ChevronDown, ChevronRight } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated, type Single } from '@/lib/api'

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
  deliveryWarehouse: { id: string; name: string } | null
}

interface OrderLine {
  id: string
  qty: string | number
  receivedQty: string | number
  pendingQty: string | number
  unitRate: string | number
  item: { id: string; code: string; name: string; uom: { symbol: string } | null }
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
  rejected: string
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
  gateEntryNo: '',
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

export function ReceiveGoodsDialog({
  onClose,
  onSaved,
  poId: startOn,
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
}) {
  const [orders, setOrders] = useState<OrderOption[]>([])
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([])
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
  const [paperworkOpen, setPaperworkOpen] = useState(true)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Rows need a stable key of their own — two rows can hold the same store. */
  const nextKey = useRef(0)
  const makeKey = () => `a${nextKey.current++}`

  // Only orders that have actually been sent can be received against, so those
  // are the only ones offered. A draft in this list would be a door the server
  // is certain to shut.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [sent, partly, w] = await Promise.all([
          api.get<Paginated<OrderOption>>('/purchase/orders?status=SENT&limit=100'),
          api.get<Paginated<OrderOption>>('/purchase/orders?status=PARTIALLY_RECEIVED&limit=100'),
          masterResource<{ id: string; name: string }>('warehouses').list({ limit: 100 }),
        ])
        if (cancelled) return
        setOrders([...sent.data, ...partly.data])
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
  }, [])

  useEffect(() => {
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
        const res = await api.get<Single<OrderDetail>>(`/purchase/orders/${poId}`)
        if (cancelled) return

        const detail = res.data
        setOrder(detail)

        // Where the supplier was told to deliver is the sensible default, and
        // the store keeper can move any line somewhere else.
        const fallback = detail.deliveryWarehouse?.id ?? warehouses[0]?.id ?? ''

        setEntries(
          Object.fromEntries(
            detail.lines.map((l) => {
              const pending = num(l.qty) - num(l.receivedQty)
              return [
                l.id,
                [
                  {
                    key: makeKey(),
                    warehouseId: fallback,
                    received: pending > 0 ? String(pending) : '',
                    rejected: '',
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
  }, [poId, warehouses])

  const setAlloc = (lineId: string, key: string, patch: Partial<Alloc>) =>
    setEntries((prev) => ({
      ...prev,
      [lineId]: (prev[lineId] ?? []).map((a) => (a.key === key ? { ...a, ...patch } : a)),
    }))

  /*
   * A second store for a line starts empty, not with the quantity still due.
   * The first row already offered that, and splitting a delivery means moving
   * some of it — an offer here would have to be deleted before it could be
   * corrected.
   */
  const addAlloc = (lineId: string) =>
    setEntries((prev) => ({
      ...prev,
      [lineId]: [
        ...(prev[lineId] ?? []),
        { key: makeKey(), warehouseId: '', received: '', rejected: '' },
      ],
    }))

  const removeAlloc = (lineId: string, key: string) =>
    setEntries((prev) => ({
      ...prev,
      [lineId]: (prev[lineId] ?? []).filter((a) => a.key !== key),
    }))

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

    // The date and the time are typed separately and sent as one instant. Two
    // deliveries from the same supplier on one day are told apart by nothing
    // else.
    const stamp = grnDate ? (grnTime ? `${grnDate}T${grnTime}` : grnDate) : undefined

    setSaving(true)
    try {
      const res = await api.post<{ message?: string; data: { grnNumber: string } }>(
        '/purchase/grn',
        {
          poId: order.id,
          grnDate: stamp,
          vehicleNo: text(vehicleNo),
          notes: text(notes),

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
            rejectedQty: num(alloc.rejected),
          })),
        }
      )
      onSaved(res.message ?? `${res.data.grnNumber} saved and the stock is in.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  /** The paperwork boxes, so thirteen near-identical labels are written once. */
  const paper = (
    label: string,
    field: keyof Delivery,
    opts: { type?: string; placeholder?: string; help?: string } = {}
  ) => (
    <label className="block">
      <span className="form-label">{label}</span>
      <input
        type={opts.type ?? 'text'}
        className="form-input h-9"
        value={delivery[field]}
        onChange={(e) => setField({ [field]: e.target.value } as Partial<Delivery>)}
        placeholder={opts.placeholder}
      />
      {opts.help && (
        <span className="text-muted-foreground mt-1 block text-[11px]">{opts.help}</span>
      )}
    </label>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:p-8">
      <div className="glass-card my-auto w-full max-w-5xl" role="dialog" aria-modal="true">
        <div className="border-border flex items-start justify-between gap-4 border-b px-5 py-4">
          <div>
            <h2 className="text-foreground text-base font-semibold">Receive goods</h2>
            <p className="text-muted-foreground mt-1 max-w-2xl text-xs">
              Saving puts the stock on the rack straight away. Anything you reject stays off the
              books — it is still standing at the gate waiting to go back.
            </p>
          </div>
          <button className="btn-ghost p-1.5" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block sm:col-span-2 lg:col-span-1">
              <span className="form-label">Purchase order</span>
              <select
                className="form-input h-9"
                value={poId}
                onChange={(e) => setPoId(e.target.value)}
                disabled={loadingLists}
              >
                <option value="">Choose…</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.poNumber} — {o.supplier?.name ?? 'supplier not named'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="form-label">Vehicle number</span>
              <input
                className="form-input h-9"
                value={vehicleNo}
                onChange={(e) => setVehicleNo(e.target.value)}
                placeholder="MH04AB1234"
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

          {/* ── The delivery's own paperwork ──────────────────────────────

            Thirteen boxes, none of them required. They are here because the
            mill's old ERP had every one of them, and because they are what
            settles a query about the supplier's bill months later: the gate
            entry is our own independent trace that a lorry came, and the
            challan is the document that physically travelled with the goods.

            Collapsible, and open to start. Somebody standing at the gate with
            the paperwork in hand wants it in front of them; somebody booking
            in a walk-in delivery with no paperwork at all can fold it away. */}
          <div className="border-border rounded-lg border">
            <button
              type="button"
              onClick={() => setPaperworkOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
              aria-expanded={paperworkOpen}
            >
              <span className="text-foreground flex items-center gap-2 text-sm font-medium">
                {paperworkOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                Delivery paperwork
              </span>
              <span className="text-muted-foreground text-[11px]">
                Gate entry, challan, the supplier&apos;s invoice — all optional
              </span>
            </button>

            {paperworkOpen && (
              <div className="border-border grid gap-3 border-t px-3 py-3 sm:grid-cols-2 lg:grid-cols-4">
                {paper('Gate entry number', 'gateEntryNo')}
                {paper('Gate entry date', 'gateEntryDate', { type: 'date' })}
                {paper('Challan number', 'challanNo', {
                  placeholder: '1872 - 1887',
                  help: 'A range is fine when one delivery covers several',
                })}
                {paper('Challan date', 'challanDate', { type: 'date' })}

                {paper('Supplier bill number', 'supplierBillNo')}
                {paper('Supplier invoice number', 'supplierInvoiceNo', {
                  help: 'What accounts will book the bill against',
                })}
                {paper('Supplier invoice date', 'supplierInvoiceDate', { type: 'date' })}
                {paper('Packages', 'packageCount', {
                  type: 'number',
                  placeholder: '0',
                  help: 'Bales, cartons or rolls off the vehicle',
                })}

                {paper('Driver name', 'driverName')}
                {paper('Form number', 'formNo')}
                {paper('Client name', 'clientName')}
                {paper('Ordered by', 'orderedBy')}
                {paper('Reference', 'referenceNo')}
              </div>
            )}
          </div>

          {!loadingLists && orders.length === 0 && (
            <p className="text-muted-foreground py-6 text-center text-sm">
              No orders are waiting for goods. An order has to be sent to the supplier before
              anything can be received against it.
            </p>
          )}

          {loadingOrder && <p className="text-muted-foreground py-6 text-sm">Opening the order…</p>}

          {order && !loadingOrder && (
            <div className="border-border overflow-x-auto rounded-lg border">
              {/* A floor, so the columns scroll rather than squash. Most of
                them are figures being typed into, and a number box squeezed to
                two characters is one somebody will mis-key. */}
              <table className="data-table w-full min-w-[920px]">
                <thead>
                  <tr>
                    <th style={{ width: '24%' }}>Item</th>
                    <th style={{ textAlign: 'right' }}>Ordered</th>
                    <th style={{ textAlign: 'right' }}>Received</th>
                    <th style={{ textAlign: 'right' }}>Still due</th>
                    <th style={{ textAlign: 'right' }}>Arrived</th>
                    <th style={{ textAlign: 'right' }}>Rejected</th>
                    <th style={{ textAlign: 'right' }}>Into stock</th>
                    <th>Store</th>
                    <th style={{ width: '1%' }}>
                      <span className="sr-only">Split across stores</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => {
                    const allocs = entries[line.id] ?? []
                    const ordered = num(line.qty)
                    const already = num(line.receivedQty)
                    const pending = ordered - already
                    const unit = line.item.uom?.symbol ?? ''
                    const done = pending <= 0

                    /* The whole line's share of this delivery, added across
                      its stores — the figure that has to fit inside what is
                      still due, and the one the server checks. */
                    const lineAccepted = allocs.reduce(
                      (sum, a) => sum + (num(a.received) - num(a.rejected)),
                      0
                    )
                    const over = lineAccepted > pending + 0.0001

                    return allocs.map((alloc, i) => {
                      const accepted = num(alloc.received) - num(alloc.rejected)
                      const first = i === 0

                      return (
                        <tr key={alloc.key}>
                          {first && (
                            <>
                              <td rowSpan={allocs.length} className="align-top">
                                <div className="text-foreground text-sm">{line.item.name}</div>
                                <div className="text-muted-foreground font-mono text-[10px]">
                                  {line.item.code}
                                </div>
                                {over && (
                                  <div className="mt-1 text-[11px] text-red-400">
                                    That is {Number((lineAccepted - pending).toFixed(3))} {unit}{' '}
                                    more than is still due.
                                  </div>
                                )}
                              </td>
                              <td
                                rowSpan={allocs.length}
                                className="text-right align-top text-sm tabular-nums"
                              >
                                {ordered}
                              </td>
                              <td
                                rowSpan={allocs.length}
                                className="text-muted-foreground text-right align-top text-sm tabular-nums"
                              >
                                {already > 0 ? already : '—'}
                              </td>
                              <td
                                rowSpan={allocs.length}
                                className="text-right align-top text-sm tabular-nums"
                              >
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
                              onChange={(e) =>
                                setAlloc(line.id, alloc.key, { received: e.target.value })
                              }
                              disabled={done}
                              aria-label={`Quantity of ${line.item.name} that arrived${
                                first ? '' : `, row ${i + 1}`
                              }`}
                            />
                          </td>
                          <td>
                            <input
                              className="form-input h-9 text-right"
                              inputMode="decimal"
                              value={alloc.rejected}
                              onChange={(e) =>
                                setAlloc(line.id, alloc.key, { rejected: e.target.value })
                              }
                              disabled={done}
                              placeholder="0"
                              aria-label={`Quantity of ${line.item.name} rejected${
                                first ? '' : `, row ${i + 1}`
                              }`}
                            />
                          </td>
                          <td className="text-right text-sm tabular-nums">
                            {accepted > 0 ? (
                              <span className="text-foreground">
                                {Number(accepted.toFixed(3))} {unit}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td>
                            <select
                              className="form-input h-9"
                              value={alloc.warehouseId}
                              onChange={(e) =>
                                setAlloc(line.id, alloc.key, { warehouseId: e.target.value })
                              }
                              disabled={done}
                              aria-label={`Store for ${line.item.name}${
                                first ? '' : `, row ${i + 1}`
                              }`}
                            >
                              <option value="">Choose…</option>
                              {warehouses.map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            {/* One delivery can go to more than one store.
                              The first row keeps the add button; the rest can
                              be taken away again. */}
                            <div className="flex gap-1">
                              {first ? (
                                <button
                                  type="button"
                                  className="border-border text-muted-foreground hover:text-foreground hover:bg-secondary inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40"
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
                                  className="border-border text-muted-foreground inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors hover:text-red-400"
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
                    })
                  })}
                </tbody>
              </table>
            </div>
          )}

          {order && !loadingOrder && (
            <label className="block">
              <span className="form-label">Note (optional)</span>
              <input
                className="form-input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything worth remembering about this delivery"
              />
            </label>
          )}
        </div>

        <div className="border-border flex items-center justify-end gap-2 border-t px-5 py-4">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void save()}
            disabled={saving || !order || loadingOrder}
          >
            {saving && <Loader2 size={15} className="animate-spin" />}
            Receive goods
          </button>
        </div>
      </div>
    </div>
  )
}
