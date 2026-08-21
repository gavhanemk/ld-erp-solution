'use client'

import { useEffect, useState } from 'react'
import { X, Loader2, AlertCircle, Plus, Trash2 } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { formatCurrency } from '@/lib/utils'

export interface BomLine {
  id?: string
  componentItemId: string
  qtyPerUnit: number | string
  wastagePercent: number | string
  effectiveQty?: number | string
  unitCost?: number | string | null
  totalCost?: number | string | null
  notes?: string | null
  componentItem?: {
    id: string
    code: string
    name: string
    standardRate: string | number | null
    uom?: { symbol: string } | null
  }
}

export interface Bom {
  id: string
  styleId: string
  version: string
  isActive: boolean
  totalCost: string | number | null
  notes: string | null
  style?: { id: string; code: string; name: string; brandType: string }
  lines?: BomLine[]
}

interface Option {
  id: string
  code: string
  name: string
  standardRate?: string | number | null
  uom?: { symbol: string } | null
}

interface Props {
  open: boolean
  onClose: () => void
  onSaved: () => void
  record?: Bom | null
}

/** A blank component row, ready for the user to pick an item. */
const emptyLine = (): BomLine => ({
  componentItemId: '',
  qtyPerUnit: '',
  wastagePercent: '0',
})

export function BomFormDialog({ open, onClose, onSaved, record }: Props) {
  const isEdit = Boolean(record)

  const [styles, setStyles] = useState<Option[]>([])
  const [items, setItems] = useState<Option[]>([])
  const [styleId, setStyleId] = useState('')
  const [version, setVersion] = useState('1.0')
  const [notes, setNotes] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [lines, setLines] = useState<BomLine[]>([emptyLine()])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return

    setStyleId(record?.styleId ?? '')
    setVersion(record?.version ?? '1.0')
    setNotes(record?.notes ?? '')
    setIsActive(record?.isActive ?? true)
    setLines(
      record?.lines?.length
        ? record.lines.map((l) => ({
            componentItemId: l.componentItemId,
            qtyPerUnit: String(l.qtyPerUnit),
            wastagePercent: String(l.wastagePercent ?? 0),
            unitCost: l.unitCost != null ? String(l.unitCost) : '',
            notes: l.notes ?? '',
          }))
        : [emptyLine()],
    )
    setError(null)
    setFieldErrors({})

    void Promise.all([
      masterResource<Option>('styles').list({ limit: 200, active: true }),
      masterResource<Option>('items').list({ limit: 200, active: true }),
    ])
      .then(([s, i]) => {
        setStyles((s as Paginated<Option>).data)
        setItems((i as Paginated<Option>).data)
      })
      .catch(() => setError('Could not load styles and items.'))
  }, [open, record])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  const setLine = (index: number, patch: Partial<BomLine>) => {
    setLines((ls) => ls.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }

  /**
   * Mirrors the server's costing so the user sees the number before saving:
   * wastage inflates the consumed quantity, and a blank rate falls back to the
   * item's standard rate.
   */
  const priceOf = (line: BomLine) => {
    const item = items.find((i) => i.id === line.componentItemId)
    const qty = Number(line.qtyPerUnit) || 0
    const wastage = Number(line.wastagePercent) || 0
    const effective = qty * (1 + wastage / 100)
    const rate =
      line.unitCost !== '' && line.unitCost != null
        ? Number(line.unitCost)
        : Number(item?.standardRate ?? 0)
    return { effective, rate, cost: effective * rate, uom: item?.uom?.symbol ?? '' }
  }

  const grandTotal = lines.reduce((sum, l) => sum + priceOf(l).cost, 0)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setFieldErrors({})

    const payloadLines = lines
      .filter((l) => l.componentItemId && l.qtyPerUnit !== '')
      .map((l, index) => ({
        componentItemId: l.componentItemId,
        qtyPerUnit: Number(l.qtyPerUnit),
        wastagePercent: Number(l.wastagePercent) || 0,
        ...(l.unitCost !== '' && l.unitCost != null ? { unitCost: Number(l.unitCost) } : {}),
        ...(l.notes ? { notes: l.notes } : {}),
        sortOrder: index,
      }))

    if (payloadLines.length === 0) {
      setError('Add at least one component with a quantity.')
      setSaving(false)
      return
    }

    try {
      if (isEdit && record) {
        await api.patch(`/masters/bom/${record.id}`, { version, notes, isActive, lines: payloadLines })
      } else {
        await api.post('/masters/bom', { styleId, version, notes, isActive, lines: payloadLines })
      }
      onSaved()
      onClose()
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fieldErrors) setFieldErrors(err.fieldErrors)
        setError(err.message)
      } else {
        setError('Could not save. Is the API running?')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div className="glass-card w-full max-w-5xl my-auto" role="dialog" aria-modal="true">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            {isEdit ? 'Edit Bill of Materials' : 'New Bill of Materials'}
          </h2>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-5">
          {error && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
              <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="form-label" htmlFor="bom-style">
                Style<span className="text-red-400 ml-0.5">*</span>
              </label>
              <select
                id="bom-style"
                className="form-input"
                value={styleId}
                onChange={(e) => setStyleId(e.target.value)}
                // A BOM belongs to the style it was created against; moving it
                // would silently rewrite another style's costing.
                disabled={isEdit}
              >
                <option value="">Select a style...</option>
                {styles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </select>
              {fieldErrors.styleId && (
                <p className="text-xs text-red-400 mt-1">{fieldErrors.styleId}</p>
              )}
              {isEdit && (
                <p className="text-xs text-muted-foreground mt-1">
                  Create a new BOM to cost a different style.
                </p>
              )}
            </div>

            <div>
              <label className="form-label" htmlFor="bom-version">
                Version
              </label>
              <input
                id="bom-version"
                className="form-input"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Components
              </h3>
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => setLines((ls) => [...ls, emptyLine()])}
              >
                <Plus size={13} />
                Add component
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="min-w-56">Item</th>
                    <th className="w-28 text-right">Qty / pc</th>
                    <th className="w-24 text-right">Wastage %</th>
                    <th className="w-28 text-right">Rate</th>
                    <th className="w-28 text-right">Cost</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => {
                    const { effective, rate, cost, uom } = priceOf(line)

                    return (
                      <tr key={index}>
                        <td>
                          <select
                            className="form-input"
                            value={line.componentItemId}
                            onChange={(e) => setLine(index, { componentItemId: e.target.value })}
                          >
                            <option value="">Select item...</option>
                            {items.map((i) => (
                              <option key={i.id} value={i.id}>
                                {i.code} — {i.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            step="any"
                            min="0"
                            className="form-input text-right"
                            value={String(line.qtyPerUnit)}
                            onChange={(e) => setLine(index, { qtyPerUnit: e.target.value })}
                            placeholder="1.65"
                          />
                          {uom && (
                            <p className="text-[10px] text-muted-foreground text-right mt-0.5">
                              {effective.toFixed(4)} {uom} after wastage
                            </p>
                          )}
                        </td>
                        <td>
                          <input
                            type="number"
                            step="any"
                            min="0"
                            max="100"
                            className="form-input text-right"
                            value={String(line.wastagePercent)}
                            onChange={(e) => setLine(index, { wastagePercent: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            step="any"
                            min="0"
                            className="form-input text-right"
                            value={line.unitCost != null ? String(line.unitCost) : ''}
                            onChange={(e) => setLine(index, { unitCost: e.target.value })}
                            placeholder={rate ? String(rate) : '0'}
                          />
                          <p className="text-[10px] text-muted-foreground text-right mt-0.5">
                            blank uses standard rate
                          </p>
                        </td>
                        <td className="text-right font-semibold align-top pt-3">
                          {formatCurrency(cost)}
                        </td>
                        <td className="align-top pt-3">
                          <button
                            type="button"
                            className="btn-ghost p-1.5 text-red-400"
                            aria-label="Remove component"
                            onClick={() =>
                              setLines((ls) =>
                                ls.length === 1 ? [emptyLine()] : ls.filter((_, i) => i !== index),
                              )
                            }
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                  <tr>
                    <td colSpan={4} className="text-right font-semibold">
                      Total material cost per piece
                    </td>
                    <td className="text-right font-bold text-teal-400">
                      {formatCurrency(grandTotal)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <label className="form-label" htmlFor="bom-notes">
              Notes
            </label>
            <textarea
              id="bom-notes"
              rows={2}
              className="form-input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-teal-500"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Active
          </label>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
            <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving && <Loader2 size={15} className="animate-spin" />}
              {isEdit ? 'Save changes' : 'Create BOM'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
