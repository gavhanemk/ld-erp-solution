'use client'

import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertCircle, Plus, Trash2 } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'

/**
 * The three ways stock moves without a purchase or a sale behind it.
 *
 * They share one dialog because they are the same act to the person doing it —
 * pick a store, list some items, say how much — and splitting them into three
 * screens would mean three places for the same mistake to be fixed.
 *
 * What differs is the second column, and that difference is the whole point:
 *
 *   opening    quantity + rate   what was on hand the day we started
 *   count      counted quantity  what is on the rack right now
 *   transfer   quantity          what is being carried across the yard
 *
 * The count asks for what was counted, never for a plus-or-minus figure. A
 * store keeper working out "I have 40 more than the book, so +40" is a store
 * keeper who will one day type −40.
 */

export type MoveMode = 'opening' | 'count' | 'transfer'

interface ItemOption {
  id: string
  code: string
  name: string
  standardRate?: string | number | null
  uom?: { symbol: string } | null
}

interface WarehouseOption {
  id: string
  code: string
  name: string
}

interface Line {
  itemId: string
  qty: string
  rate: string
}

const emptyLine = (): Line => ({ itemId: '', qty: '', rate: '' })

const COPY: Record<
  MoveMode,
  { title: string; blurb: string; qtyLabel: string; action: string }
> = {
  opening: {
    title: 'Opening stock',
    blurb:
      'What was already on hand the day this system started. It can only be entered once per item and store — after that, correct it with a stock count.',
    qtyLabel: 'Quantity',
    action: 'Record opening stock',
  },
  count: {
    title: 'Stock count',
    blurb:
      'Type what you counted on the rack. The difference against the book is worked out here, and every change is written to the ledger with your reason.',
    qtyLabel: 'Counted',
    action: 'Save the count',
  },
  transfer: {
    title: 'Move stock',
    blurb:
      'Between two of our own stores. What it is worth travels with it — moving cloth across the yard does not change its value.',
    qtyLabel: 'Quantity',
    action: 'Move it',
  },
}

export function StockMoveDialog({
  mode,
  onClose,
  onSaved,
}: {
  mode: MoveMode
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const copy = COPY[mode]

  const [items, setItems] = useState<ItemOption[]>([])
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([])
  const [loadingLists, setLoadingLists] = useState(true)

  const [warehouseId, setWarehouseId] = useState('')
  const [toWarehouseId, setToWarehouseId] = useState('')
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([emptyLine()])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [i, w] = await Promise.all([
          masterResource<ItemOption>('items').list({ limit: 500 }),
          masterResource<WarehouseOption>('warehouses').list({ limit: 100 }),
        ])
        if (cancelled) return
        setItems(i.data)
        setWarehouses(w.data)
        // One store is the overwhelmingly common case, so choosing it for them
        // removes a click without ever choosing wrongly.
        if (w.data.length === 1) setWarehouseId(w.data[0].id)
      } catch {
        if (!cancelled) setError('Could not load items and stores.')
      } finally {
        if (!cancelled) setLoadingLists(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  const setLine = (index: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  const addLine = () => setLines((prev) => [...prev, emptyLine()])
  const removeLine = (index: number) =>
    setLines((prev) => (prev.length === 1 ? [emptyLine()] : prev.filter((_, i) => i !== index)))

  const filled = lines.filter((l) => l.itemId && l.qty !== '')

  const save = async () => {
    setError(null)

    if (!warehouseId) return setError('Choose a store.')
    if (mode === 'transfer' && !toWarehouseId) return setError('Choose where it is going.')
    if (mode === 'transfer' && warehouseId === toWarehouseId) {
      return setError('The two stores are the same, so nothing would move.')
    }
    if (mode === 'count' && reason.trim().length < 5) {
      return setError('Say why the figure is being changed — one line is enough.')
    }
    if (filled.length === 0) return setError('Add at least one item with a quantity.')
    // A count or an opening sets each line against the book once, so an item
    // entered on two lines would be applied twice. Moves may repeat an item.
    if (mode !== 'transfer') {
      const ids = filled.map((l) => l.itemId)
      const twice = ids.find((id, i) => ids.indexOf(id) !== i)
      if (twice) {
        return setError(
          `${itemsById.get(twice)?.name ?? 'An item'} is on the list twice. Enter it once, with the total.`,
        )
      }
    }

    setSaving(true)
    try {
      let res: { message?: string }

      if (mode === 'opening') {
        res = await api.post('/inventory/opening', {
          warehouseId,
          notes: notes || null,
          lines: filled.map((l) => ({
            itemId: l.itemId,
            qty: Number(l.qty),
            unitRate: Number(l.rate || 0),
          })),
        })
      } else if (mode === 'count') {
        res = await api.post('/inventory/adjustments', {
          warehouseId,
          reason: reason.trim(),
          lines: filled.map((l) => ({
            itemId: l.itemId,
            countedQty: Number(l.qty),
            ...(l.rate ? { unitRate: Number(l.rate) } : {}),
          })),
        })
      } else {
        res = await api.post('/inventory/transfers', {
          fromWarehouseId: warehouseId,
          toWarehouseId,
          notes: notes || null,
          lines: filled.map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })),
        })
      }

      onSaved(res.message ?? 'Saved.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div className="glass-card w-full max-w-4xl my-auto" role="dialog" aria-modal="true">
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-foreground">{copy.title}</h2>
            <p className="mt-1 text-xs text-muted-foreground max-w-2xl">{copy.blurb}</p>
          </div>
          <button className="btn-ghost p-1.5" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {error && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
              <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="form-label">
                {mode === 'transfer' ? 'Take it from' : 'Store'}
              </span>
              <select
                className="form-input"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                disabled={loadingLists}
              >
                <option value="">Choose a store…</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>

            {mode === 'transfer' && (
              <label className="block">
                <span className="form-label">Send it to</span>
                <select
                  className="form-input"
                  value={toWarehouseId}
                  onChange={(e) => setToWarehouseId(e.target.value)}
                  disabled={loadingLists}
                >
                  <option value="">Choose a store…</option>
                  {warehouses
                    .filter((w) => w.id !== warehouseId)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                </select>
              </label>
            )}

            {mode === 'count' && (
              <label className="block">
                <span className="form-label">Why the figure is changing</span>
                <input
                  className="form-input"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Monthly physical count, damage found, …"
                />
              </label>
            )}
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th style={{ width: '50%' }}>Item</th>
                  <th style={{ textAlign: 'right' }}>{copy.qtyLabel}</th>
                  {mode !== 'transfer' && <th style={{ textAlign: 'right' }}>Rate ₹</th>}
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => {
                  const item = itemsById.get(line.itemId)
                  return (
                    <tr key={i}>
                      <td>
                        <select
                          className="form-input h-9"
                          value={line.itemId}
                          onChange={(e) => {
                            const picked = itemsById.get(e.target.value)
                            setLine(i, {
                              itemId: e.target.value,
                              // The item's standard rate is a starting point for
                              // an opening balance, not for a count — a count
                              // priced at the list rate would quietly revalue
                              // stock that is already carried at something else.
                              rate:
                                mode === 'opening' && picked?.standardRate != null
                                  ? String(picked.standardRate)
                                  : line.rate,
                            })
                          }}
                          disabled={loadingLists}
                          aria-label={`Item on line ${i + 1}`}
                        >
                          <option value="">Choose an item…</option>
                          {items.map((it) => (
                            <option key={it.id} value={it.id}>
                              {it.code} — {it.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <input
                            type="number"
                            step="0.001"
                            min="0"
                            className="form-input h-9 w-28 text-right tabular-nums"
                            value={line.qty}
                            onChange={(e) => setLine(i, { qty: e.target.value })}
                            aria-label={`${copy.qtyLabel} on line ${i + 1}`}
                          />
                          <span className="text-xs text-muted-foreground w-8 text-left">
                            {item?.uom?.symbol ?? ''}
                          </span>
                        </div>
                      </td>
                      {mode !== 'transfer' && (
                        <td className="text-right">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            className="form-input h-9 w-28 text-right tabular-nums"
                            value={line.rate}
                            onChange={(e) => setLine(i, { rate: e.target.value })}
                            placeholder={mode === 'count' ? 'only if new' : ''}
                            aria-label={`Rate on line ${i + 1}`}
                          />
                        </td>
                      )}
                      <td className="text-right">
                        <button
                          className="btn-ghost p-1.5 text-muted-foreground hover:text-red-400"
                          onClick={() => removeLine(i)}
                          aria-label={`Remove line ${i + 1}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <button className="btn-ghost text-xs" onClick={addLine}>
            <Plus size={14} /> Add another item
          </button>

          {mode !== 'count' && (
            <label className="block">
              <span className="form-label">Note (optional)</span>
              <input
                className="form-input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the store should know"
              />
            </label>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 size={15} className="animate-spin" />}
            {copy.action}
          </button>
        </div>
      </div>
    </div>
  )
}
