'use client'

import { useEffect, useState } from 'react'
import { X, Loader2, AlertCircle } from 'lucide-react'
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

/** What the store keeper is typing, kept as text so a half-typed number is not a zero. */
interface Entry {
  warehouseId: string
  received: string
  rejected: string
}

const num = (v: string | number) => Number(v) || 0

export function ReceiveGoodsDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [orders, setOrders] = useState<OrderOption[]>([])
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([])
  const [loadingLists, setLoadingLists] = useState(true)

  const [poId, setPoId] = useState('')
  const [order, setOrder] = useState<OrderDetail | null>(null)
  const [loadingOrder, setLoadingOrder] = useState(false)

  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [vehicleNo, setVehicleNo] = useState('')
  const [grnDate, setGrnDate] = useState('')
  const [notes, setNotes] = useState('')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
                {
                  warehouseId: fallback,
                  received: pending > 0 ? String(pending) : '',
                  rejected: '',
                },
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

  const setEntry = (lineId: string, patch: Partial<Entry>) =>
    setEntries((prev) => ({ ...prev, [lineId]: { ...prev[lineId], ...patch } }))

  const save = async () => {
    setError(null)
    if (!order) return setError('Choose the order these goods came against.')

    const lines = order.lines
      .map((l) => ({ line: l, entry: entries[l.id] }))
      .filter(({ entry }) => entry && num(entry.received) > 0)

    if (lines.length === 0) {
      return setError('Enter what arrived on at least one line.')
    }
    if (lines.some(({ entry }) => !entry.warehouseId)) {
      return setError('Every line needs a store to go into.')
    }

    setSaving(true)
    try {
      const res = await api.post<{ message?: string; data: { grnNumber: string } }>(
        '/purchase/grn',
        {
          poId: order.id,
          grnDate: grnDate || undefined,
          vehicleNo: vehicleNo || null,
          notes: notes || null,
          lines: lines.map(({ line, entry }) => ({
            poLineId: line.id,
            warehouseId: entry.warehouseId,
            receivedQty: num(entry.received),
            rejectedQty: num(entry.rejected),
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

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="form-label">Purchase order</span>
              <select
                className="form-input"
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
              <span className="form-label">Vehicle number (optional)</span>
              <input
                className="form-input"
                value={vehicleNo}
                onChange={(e) => setVehicleNo(e.target.value)}
                placeholder="MH04AB1234"
              />
            </label>
            <label className="block">
              <span className="form-label">Received on</span>
              <input
                type="date"
                className="form-input"
                value={grnDate}
                onChange={(e) => setGrnDate(e.target.value)}
              />
            </label>
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
              {/* A floor, so the seven columns scroll rather than squash.
                Six of them are figures being typed into, and a number box
                squeezed to two characters is one somebody will mis-key. */}
              <table className="data-table w-full min-w-[760px]">
                <thead>
                  <tr>
                    <th style={{ width: '28%' }}>Item</th>
                    <th style={{ textAlign: 'right' }}>Ordered</th>
                    <th style={{ textAlign: 'right' }}>Still due</th>
                    <th style={{ textAlign: 'right' }}>Arrived</th>
                    <th style={{ textAlign: 'right' }}>Rejected</th>
                    <th style={{ textAlign: 'right' }}>Into stock</th>
                    <th>Store</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => {
                    const entry = entries[line.id]
                    const pending = num(line.qty) - num(line.receivedQty)
                    const accepted = num(entry?.received) - num(entry?.rejected)
                    const unit = line.item.uom?.symbol ?? ''

                    return (
                      <tr key={line.id}>
                        <td>
                          <div className="text-foreground text-sm">{line.item.name}</div>
                          <div className="text-muted-foreground font-mono text-[10px]">
                            {line.item.code}
                          </div>
                        </td>
                        <td className="text-right text-sm tabular-nums">{num(line.qty)}</td>
                        <td className="text-right text-sm tabular-nums">
                          {pending > 0 ? (
                            <span>
                              {pending} {unit}
                            </span>
                          ) : (
                            <span className="badge-success">complete</span>
                          )}
                        </td>
                        <td>
                          <input
                            className="form-input h-9 text-right"
                            inputMode="decimal"
                            value={entry?.received ?? ''}
                            onChange={(e) => setEntry(line.id, { received: e.target.value })}
                            disabled={pending <= 0}
                            aria-label={`Quantity of ${line.item.name} that arrived`}
                          />
                        </td>
                        <td>
                          <input
                            className="form-input h-9 text-right"
                            inputMode="decimal"
                            value={entry?.rejected ?? ''}
                            onChange={(e) => setEntry(line.id, { rejected: e.target.value })}
                            disabled={pending <= 0}
                            placeholder="0"
                            aria-label={`Quantity of ${line.item.name} rejected`}
                          />
                        </td>
                        <td className="text-right text-sm tabular-nums">
                          {accepted > 0 ? (
                            <span className="text-foreground">
                              {accepted} {unit}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td>
                          <select
                            className="form-input h-9"
                            value={entry?.warehouseId ?? ''}
                            onChange={(e) => setEntry(line.id, { warehouseId: e.target.value })}
                            disabled={pending <= 0}
                            aria-label={`Store for ${line.item.name}`}
                          >
                            <option value="">Choose…</option>
                            {warehouses.map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    )
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
                placeholder="Challan number, or anything worth remembering about this delivery"
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
