'use client'

import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertCircle, Plus, Trash2 } from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'

/**
 * A department asking the store for material.
 *
 * The store is chosen once at the top rather than per line, because in practice
 * one requisition is walked to one counter. Every line is saved against that
 * store, so there is still only one place the answer lives.
 */

interface ItemOption {
  id: string
  code: string
  name: string
  uom?: { symbol: string } | null
}

interface Line {
  itemId: string
  requestedQty: string
  purpose: string
}

const emptyLine = (): Line => ({ itemId: '', requestedQty: '', purpose: '' })

export function RequisitionDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [items, setItems] = useState<ItemOption[]>([])
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([])
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([])
  const [loadingLists, setLoadingLists] = useState(true)

  const [departmentId, setDepartmentId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [requiredDate, setRequiredDate] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([emptyLine()])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [i, d, w] = await Promise.all([
          masterResource<ItemOption>('items').list({ limit: 500 }),
          masterResource<{ id: string; name: string }>('departments').list({ limit: 100 }),
          masterResource<{ id: string; name: string }>('warehouses').list({ limit: 100 }),
        ])
        if (cancelled) return
        setItems(i.data)
        setDepartments(d.data)
        setWarehouses(w.data)
      } catch {
        if (!cancelled) setError('Could not load items, departments and stores.')
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

  const filled = lines.filter((l) => l.itemId && Number(l.requestedQty) > 0)

  const save = async () => {
    setError(null)
    if (!departmentId) return setError('Which department is asking?')
    if (!warehouseId) return setError('Which store should it come from?')
    if (filled.length === 0) return setError('Add at least one item with a quantity.')

    setSaving(true)
    try {
      const res = await api.post<{ data: { mrNumber: string } }>('/inventory/requisitions', {
        departmentId,
        warehouseId,
        requiredDate: requiredDate || null,
        notes: notes || null,
        lines: filled.map((l) => ({
          itemId: l.itemId,
          requestedQty: Number(l.requestedQty),
          purpose: l.purpose || null,
        })),
      })
      onSaved(`${res.data.mrNumber} raised. It needs someone else to approve it.`)
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
            <h2 className="text-foreground text-base font-semibold">New material requisition</h2>
            <p className="text-muted-foreground mt-1 max-w-2xl text-xs">
              Nothing leaves the store on this alone. Somebody else has to approve it, and then the
              store hands it over — those are three different people on purpose.
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
              <span className="form-label">Department asking</span>
              <select
                className="form-input"
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                disabled={loadingLists}
              >
                <option value="">Choose…</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="form-label">Draw from</span>
              <select
                className="form-input"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
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
              <span className="form-label">Needed by (optional)</span>
              <input
                type="date"
                className="form-input"
                value={requiredDate}
                onChange={(e) => setRequiredDate(e.target.value)}
              />
            </label>
          </div>

          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>Item</th>
                  <th style={{ textAlign: 'right' }}>Quantity</th>
                  <th>What for</th>
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
                          value={line.requestedQty}
                          onChange={(e) => setLine(i, { requestedQty: e.target.value })}
                          aria-label={`Quantity on line ${i + 1}`}
                        />
                        <span className="text-muted-foreground w-8 text-left text-xs">
                          {itemsById.get(line.itemId)?.uom?.symbol ?? ''}
                        </span>
                      </div>
                    </td>
                    <td>
                      <input
                        className="form-input h-9"
                        value={line.purpose}
                        onChange={(e) => setLine(i, { purpose: e.target.value })}
                        placeholder="Cutting lay 1, sample, …"
                        aria-label={`Purpose on line ${i + 1}`}
                      />
                    </td>
                    <td className="text-right">
                      <button
                        className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400"
                        onClick={() =>
                          setLines((prev) =>
                            prev.length === 1 ? [emptyLine()] : prev.filter((_, x) => x !== i)
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
            onClick={() => setLines((prev) => [...prev, emptyLine()])}
          >
            <Plus size={14} /> Add another item
          </button>

          <label className="block">
            <span className="form-label">Note (optional)</span>
            <input
              className="form-input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Against which order, or anything the store should know"
            />
          </label>
        </div>

        <div className="border-border flex items-center justify-end gap-2 border-t px-5 py-4">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 size={15} className="animate-spin" />}
            Raise it
          </button>
        </div>
      </div>
    </div>
  )
}
