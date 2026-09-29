'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2, ClipboardList, FileText, Package } from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'

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
          // Active only: a deactivated item, department or store is not offered
          // for anything new.
          masterResource<ItemOption>('items').list({ limit: 200, active: true, sort: 'name', order: 'asc' }),
          masterResource<{ id: string; name: string }>('departments').list({ limit: 100, active: true }),
          masterResource<{ id: string; name: string }>('warehouses').list({ limit: 100, active: true }),
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

  const raise = (
    <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <ClipboardList size={15} />}
      Raise requisition
    </button>
  )

  return (
    <FormFrame
      icon={ClipboardList}
      title="New material requisition"
      subtitle="A department asking the store for material. Somebody else approves it, and then the store hands it over."
      primary={raise}
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote="Three different people on purpose: who asks, who approves, who hands over."
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={FileText} title="Basic Details">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
          <label className="block min-w-0">
            <span className="form-label">
              Department asking<span className="ml-0.5 text-red-500">*</span>
            </span>
            <select
              className="form-input"
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              disabled={loadingLists}
              autoFocus
            >
              <option value="">{loadingLists ? 'Loading...' : 'Choose a department...'}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className="form-label">
              Draw from<span className="ml-0.5 text-red-500">*</span>
            </span>
            <select
              className="form-input"
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              disabled={loadingLists}
            >
              <option value="">{loadingLists ? 'Loading...' : 'Choose a store...'}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className="form-label">Needed by</span>
            <input
              type="date"
              className="form-input"
              value={requiredDate}
              onChange={(e) => setRequiredDate(e.target.value)}
            />
          </label>
          <label className="block min-w-0 sm:col-span-3">
            <span className="form-label">Note</span>
            <input
              className="form-input placeholder:text-muted-foreground/60"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Against which order, or anything the store should know"
            />
          </label>
        </div>
      </Section>

      <Section
        icon={Package}
        title="Items"
        actions={
          <button
            type="button"
            className="btn-secondary h-8 px-3 text-xs"
            onClick={() => setLines((prev) => [...prev, emptyLine()])}
          >
            <Plus size={14} /> Add another item
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="line-table w-full min-w-[620px] text-sm">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th style={{ width: '45%' }}>Item</th>
                <th style={{ textAlign: 'right' }}>Quantity</th>
                <th>What for</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td className="text-muted-foreground px-3 py-2 text-xs">{i + 1}</td>
                  <td className="px-3 py-2">
                    <select
                      className="form-input h-9"
                      value={line.itemId}
                      onChange={(e) => setLine(i, { itemId: e.target.value })}
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
                        value={line.requestedQty}
                        onChange={(e) => setLine(i, { requestedQty: e.target.value })}
                        aria-label={`Quantity on line ${i + 1}`}
                      />
                      <span className="text-muted-foreground w-8 text-left text-xs">
                        {itemsById.get(line.itemId)?.uom?.symbol ?? ''}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className="form-input h-9 placeholder:text-muted-foreground/60"
                      value={line.purpose}
                      onChange={(e) => setLine(i, { purpose: e.target.value })}
                      placeholder="e.g. Cutting lay 1, sample"
                      aria-label={`Purpose on line ${i + 1}`}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
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
      </Section>
    </FormFrame>
  )
}
