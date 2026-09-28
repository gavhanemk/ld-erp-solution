'use client'

import { useEffect, useState } from 'react'
import { X, Loader2, AlertCircle, Plus, Trash2 } from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'

/**
 * Sending our fabric out to an outside unit, and taking it back.
 *
 * Two dialogs rather than one screen doing both, because they happen weeks
 * apart and to different people: the store sends the cloth, and whoever is on
 * the gate when the lorry returns books it back.
 */

interface Option {
  id: string
  name: string
}

interface ItemOption extends Option {
  uom?: { symbol: string } | null
}

const num = (v: string) => Number(v) || 0

interface OutLine {
  itemId: string
  qty: string
}

const emptyOut = (): OutLine => ({ itemId: '', qty: '' })

export function SendJobWorkDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [workers, setWorkers] = useState<Option[]>([])
  const [items, setItems] = useState<ItemOption[]>([])
  const [warehouses, setWarehouses] = useState<Option[]>([])
  const [loadingLists, setLoadingLists] = useState(true)

  const [jobWorkerId, setJobWorkerId] = useState('')
  const [process, setProcess] = useState('')
  const [fromWarehouseId, setFromWarehouseId] = useState('')
  const [toWarehouseId, setToWarehouseId] = useState('')
  const [expectedBackOn, setExpectedBackOn] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [lrNumber, setLrNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<OutLine[]>([emptyOut()])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [s, i, w] = await Promise.all([
          masterResource<Option>('suppliers').list({ limit: 300 }),
          masterResource<ItemOption>('items').list({ limit: 500 }),
          masterResource<Option>('warehouses').list({ limit: 100 }),
        ])
        if (cancelled) return
        setWorkers(s.data)
        setItems(i.data)
        setWarehouses(w.data)
      } catch {
        if (!cancelled) setError('Could not load units, items and stores.')
      } finally {
        if (!cancelled) setLoadingLists(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const setLine = (index: number, patch: Partial<OutLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  const filled = lines.filter((l) => l.itemId && num(l.qty) > 0)

  const save = async () => {
    setError(null)
    if (!jobWorkerId) return setError('Which unit is doing the work?')
    if (process.trim().length < 2)
      return setError('Say what the work is — cutting, dyeing, stitching.')
    if (!fromWarehouseId) return setError('Which store does it leave?')
    if (!toWarehouseId) return setError("Which store stands for the unit's floor?")
    if (filled.length === 0) return setError('Add at least one item with a quantity.')

    setSaving(true)
    try {
      const res = await api.post<{ message?: string; data: { challanNumber: string } }>(
        '/inventory/job-work',
        {
          jobWorkerId,
          process: process.trim(),
          fromWarehouseId,
          toWarehouseId,
          expectedBackOn: expectedBackOn || null,
          vehicleNo: vehicleNo || null,
          lrNumber: lrNumber || null,
          notes: notes || null,
          lines: filled.map((l) => ({ itemId: l.itemId, qty: num(l.qty) })),
        }
      )
      onSaved(res.message ?? `${res.data.challanNumber} saved.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:p-8">
      <div className="glass-card my-auto w-full max-w-4xl" role="dialog" aria-modal="true">
        <div className="border-border flex items-start justify-between gap-4 border-b px-5 py-4">
          <div>
            <h2 className="text-foreground text-base font-semibold">Send out for job work</h2>
            <p className="text-muted-foreground mt-1 max-w-2xl text-xs">
              The goods stay ours. They move to the store standing for that unit&apos;s floor, so
              the stock screen still shows them — just somewhere else.
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

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="form-label">Unit doing the work</span>
              <select
                className="form-input"
                value={jobWorkerId}
                onChange={(e) => setJobWorkerId(e.target.value)}
                disabled={loadingLists}
              >
                <option value="">Choose…</option>
                {workers.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="form-label">What is the work</span>
              <input
                className="form-input"
                value={process}
                onChange={(e) => setProcess(e.target.value)}
                placeholder="Cutting, stitching, dyeing — navy"
              />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="form-label">Leaves from</span>
              <select
                className="form-input"
                value={fromWarehouseId}
                onChange={(e) => setFromWarehouseId(e.target.value)}
                disabled={loadingLists}
              >
                <option value="">Choose…</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="form-label">Goes to</span>
              <select
                className="form-input"
                value={toWarehouseId}
                onChange={(e) => setToWarehouseId(e.target.value)}
                disabled={loadingLists}
              >
                <option value="">Choose…</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="form-label">Due back</span>
              <input
                type="date"
                className="form-input"
                value={expectedBackOn}
                onChange={(e) => setExpectedBackOn(e.target.value)}
              />
            </label>
          </div>

          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th style={{ width: '55%' }}>Item</th>
                  <th style={{ textAlign: 'right' }}>Quantity</th>
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={i}>
                    <td>
                      <select
                        className="form-input h-9"
                        value={line.itemId}
                        onChange={(e) => setLine(i, { itemId: e.target.value })}
                        disabled={loadingLists}
                        aria-label={`Item on line ${i + 1}`}
                      >
                        <option value="">Choose an item…</option>
                        {items.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="form-input h-9 text-right"
                        inputMode="decimal"
                        value={line.qty}
                        onChange={(e) => setLine(i, { qty: e.target.value })}
                        aria-label={`Quantity on line ${i + 1}`}
                      />
                    </td>
                    <td className="text-right">
                      <button
                        className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400"
                        onClick={() =>
                          setLines((prev) =>
                            prev.length === 1 ? [emptyOut()] : prev.filter((_, x) => x !== i)
                          )
                        }
                        aria-label={`Remove line ${i + 1}`}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            className="btn-ghost text-xs"
            onClick={() => setLines((prev) => [...prev, emptyOut()])}
          >
            <Plus size={14} /> Add another item
          </button>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="form-label">Vehicle number</span>
              <input
                className="form-input"
                value={vehicleNo}
                onChange={(e) => setVehicleNo(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="form-label">LR number</span>
              <input
                className="form-input"
                value={lrNumber}
                onChange={(e) => setLrNumber(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="form-label">Note</span>
              <input
                className="form-input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
          </div>
        </div>

        <div className="border-border flex items-center justify-end gap-2 border-t px-5 py-4">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 size={15} className="animate-spin" />}
            Send it out
          </button>
        </div>
      </div>
    </div>
  )
}

interface ChallanLine {
  id: string
  qty: string | number
  outstanding: number
  item: { id: string; name: string; uom: { symbol: string } | null }
}

interface ReturnEntry {
  consumed: string
  itemId: string
  received: string
  wasted: string
  warehouseId: string
}

export function ReceiveJobWorkDialog({
  challan,
  onClose,
  onSaved,
}: {
  challan: {
    id: string
    challanNumber: string
    process: string
    jobWorker: { name: string }
    fromWarehouse: { id: string; name: string }
    lines: ChallanLine[]
  }
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [items, setItems] = useState<ItemOption[]>([])
  const [warehouses, setWarehouses] = useState<Option[]>([])
  const [entries, setEntries] = useState<Record<string, ReturnEntry>>({})
  const [theirChallanNo, setTheirChallanNo] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [i, w] = await Promise.all([
          masterResource<ItemOption>('items').list({ limit: 500 }),
          masterResource<Option>('warehouses').list({ limit: 100 }),
        ])
        if (cancelled) return
        setItems(i.data)
        setWarehouses(w.data)
        setEntries(
          Object.fromEntries(
            challan.lines.map((l) => [
              l.id,
              {
                consumed: l.outstanding > 0 ? String(l.outstanding) : '',
                itemId: l.item.id,
                received: l.outstanding > 0 ? String(l.outstanding) : '',
                wasted: '',
                warehouseId: challan.fromWarehouse.id,
              },
            ])
          )
        )
      } catch {
        if (!cancelled) setError('Could not load items and stores.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [challan])

  const setEntry = (id: string, patch: Partial<ReturnEntry>) =>
    setEntries((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const save = async () => {
    setError(null)
    const lines = challan.lines
      .map((l) => ({ line: l, e: entries[l.id] }))
      .filter(({ e }) => e && num(e.consumed) > 0)

    if (lines.length === 0) return setError('Enter what came back on at least one line.')
    if (lines.some(({ e }) => !e.warehouseId))
      return setError('Every line needs a store to go into.')

    setSaving(true)
    try {
      const res = await api.post<{ message?: string; data: { challanNumber: string } }>(
        `/inventory/job-work/${challan.id}/returns`,
        {
          theirChallanNo: theirChallanNo || null,
          notes: notes || null,
          lines: lines.map(({ line, e }) => ({
            challanLineId: line.id,
            consumedQty: num(e.consumed),
            itemId: e.itemId,
            receivedQty: num(e.received),
            wastedQty: num(e.wasted),
            warehouseId: e.warehouseId,
          })),
        }
      )
      onSaved(res.message ?? 'Return saved.')
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
            <h2 className="text-foreground text-base font-semibold">
              Take back {challan.challanNumber}
            </h2>
            <p className="text-muted-foreground mt-1 max-w-2xl text-xs">
              {challan.process} at {challan.jobWorker.name}. If the unit made something of it,
              change the item that came back — the value of what went in follows it.
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

          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Sent</th>
                  <th style={{ textAlign: 'right' }}>Still out</th>
                  <th style={{ textAlign: 'right' }}>Settling</th>
                  <th>Came back as</th>
                  <th style={{ textAlign: 'right' }}>Quantity back</th>
                  <th style={{ textAlign: 'right' }}>Wasted</th>
                  <th>Into store</th>
                </tr>
              </thead>
              <tbody>
                {challan.lines.map((l) => {
                  const e = entries[l.id]
                  const done = l.outstanding <= 0
                  return (
                    <tr key={l.id}>
                      <td>
                        <div className="text-sm">{l.item.name}</div>
                        <div className="text-muted-foreground text-[10px]">
                          {Number(l.qty)} {l.item.uom?.symbol ?? ''} sent
                        </div>
                      </td>
                      <td className="text-right text-sm tabular-nums">
                        {done ? <span className="badge-success">all back</span> : l.outstanding}
                      </td>
                      <td>
                        <input
                          className="form-input h-9 text-right"
                          inputMode="decimal"
                          value={e?.consumed ?? ''}
                          onChange={(ev) => setEntry(l.id, { consumed: ev.target.value })}
                          disabled={done}
                          aria-label={`Quantity of ${l.item.name} being settled`}
                        />
                      </td>
                      <td>
                        <select
                          className="form-input h-9"
                          value={e?.itemId ?? ''}
                          onChange={(ev) => setEntry(l.id, { itemId: ev.target.value })}
                          disabled={done}
                          aria-label={`What came back for ${l.item.name}`}
                        >
                          {items.map((it) => (
                            <option key={it.id} value={it.id}>
                              {it.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="form-input h-9 text-right"
                          inputMode="decimal"
                          value={e?.received ?? ''}
                          onChange={(ev) => setEntry(l.id, { received: ev.target.value })}
                          disabled={done}
                          aria-label={`Quantity back for ${l.item.name}`}
                        />
                      </td>
                      <td>
                        <input
                          className="form-input h-9 text-right"
                          inputMode="decimal"
                          value={e?.wasted ?? ''}
                          onChange={(ev) => setEntry(l.id, { wasted: ev.target.value })}
                          disabled={done}
                          placeholder="0"
                          aria-label={`Wasted for ${l.item.name}`}
                        />
                      </td>
                      <td>
                        <select
                          className="form-input h-9"
                          value={e?.warehouseId ?? ''}
                          onChange={(ev) => setEntry(l.id, { warehouseId: ev.target.value })}
                          disabled={done}
                          aria-label={`Store for ${l.item.name}`}
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

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="form-label">Their challan number</span>
              <input
                className="form-input"
                value={theirChallanNo}
                onChange={(e) => setTheirChallanNo(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="form-label">Note</span>
              <input
                className="form-input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything worth remembering about this lot"
              />
            </label>
          </div>
        </div>

        <div className="border-border flex items-center justify-end gap-2 border-t px-5 py-4">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 size={15} className="animate-spin" />}
            Take it back
          </button>
        </div>
      </div>
    </div>
  )
}
