'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  Plus,
  Trash2,
  Package,
  PackagePlus,
  ClipboardCheck,
  ArrowRightLeft,
  Warehouse,
} from 'lucide-react'
import { api, apiErrorMessage, masterResource } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'

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
          // Active only: a deactivated item or store is not offered for new stock.
          masterResource<ItemOption>('items').list({ limit: 200, active: true, sort: 'name', order: 'asc' }),
          masterResource<WarehouseOption>('warehouses').list({ limit: 100, active: true }),
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

    // Opening stock comes in at a rate or it is worth nothing. An empty box
    // used to go through as ₹0 without a word.
    if (mode === 'opening') {
      const unpriced = filled.find((l) => !(Number(l.rate) > 0))
      if (unpriced) {
        const it = itemsById.get(unpriced.itemId)
        return setError(
          `Enter a rate for ${it?.name ?? 'every item'}: what one ${it?.uom?.symbol ?? 'unit'} cost. At ₹0 the stock would be valued at nothing.`,
        )
      }
    }
    if (mode === 'count') {
      const zero = filled.find((l) => l.rate !== '' && !(Number(l.rate) > 0))
      if (zero) {
        return setError(
          `${itemsById.get(zero.itemId)?.name ?? 'An item'}: a rate of ₹0 would value the stock found at nothing. Enter what it cost, or leave the rate empty.`,
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
            unitRate: Number(l.rate),
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
      setError(apiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const Icon = mode === 'opening' ? PackagePlus : mode === 'count' ? ClipboardCheck : ArrowRightLeft

  const primary = (
    <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
      {copy.action}
    </button>
  )

  return (
    <FormFrame
      icon={Icon}
      title={copy.title}
      subtitle={copy.blurb}
      primary={primary}
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={Warehouse} title={mode === 'transfer' ? 'From and to' : 'Store'}>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className="form-label">
              {mode === 'transfer' ? 'Take it from' : 'Store'}
              <span className="ml-0.5 text-red-500">*</span>
            </span>
            <select
              className="form-input"
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              disabled={loadingLists}
              autoFocus
            >
              <option value="">{loadingLists ? 'Loading...' : 'Choose a store...'}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>

          {mode === 'transfer' && (
            <label className="block min-w-0">
              <span className="form-label">
                Send it to<span className="ml-0.5 text-red-500">*</span>
              </span>
              <select
                className="form-input"
                value={toWarehouseId}
                onChange={(e) => setToWarehouseId(e.target.value)}
                disabled={loadingLists}
              >
                <option value="">{loadingLists ? 'Loading...' : 'Choose a store...'}</option>
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
            <label className="block min-w-0">
              <span className="form-label">
                Why the figure is changing<span className="ml-0.5 text-red-500">*</span>
              </span>
              <input
                className="form-input placeholder:text-muted-foreground/60"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Monthly physical count, damage found"
              />
            </label>
          )}

          {mode !== 'count' && (
            <label className={`block min-w-0 ${mode === 'transfer' ? 'sm:col-span-2' : ''}`}>
              <span className="form-label">Note</span>
              <input
                className="form-input placeholder:text-muted-foreground/60"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the store should know"
              />
            </label>
          )}
        </div>
      </Section>

      <Section
        icon={Package}
        title="Items"
        actions={
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={addLine}>
            <Plus size={14} /> Add another item
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="line-table w-full min-w-[620px] text-sm">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
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
                    <td className="text-muted-foreground px-3 py-2 text-xs">{i + 1}</td>
                    <td className="px-3 py-2">
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
                        <option value="">Choose an item...</option>
                        {items.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.code} — {it.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2 text-right">
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
                        <span className="text-muted-foreground w-8 text-left text-xs">
                          {item?.uom?.symbol ?? ''}
                        </span>
                      </div>
                    </td>
                    {mode !== 'transfer' && (
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          className="form-input h-9 w-28 text-right tabular-nums placeholder:text-muted-foreground/60"
                          value={line.rate}
                          onChange={(e) => setLine(i, { rate: e.target.value })}
                          placeholder={mode === 'count' ? 'only if new' : ''}
                          aria-label={`Rate on line ${i + 1}`}
                        />
                      </td>
                    )}
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400"
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
      </Section>
    </FormFrame>
  )
}
