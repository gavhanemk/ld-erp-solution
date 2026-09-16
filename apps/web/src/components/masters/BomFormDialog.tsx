'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertCircle, Plus, Trash2, Ruler } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { formatCurrency } from '@/lib/utils'

export interface BomLineSize {
  id?: string
  sizeId: string
  qtyPerUnit: number | string
  effectiveQty?: number | string
  totalCost?: number | string | null
  size?: { id: string; code: string; label: string; sequence: number }
}

export interface BomLine {
  id?: string
  componentItemId: string
  component?: string | null
  qtyPerUnit: number | string
  wastagePercent: number | string
  effectiveQty?: number | string
  unitCost?: number | string | null
  totalCost?: number | string | null
  notes?: string | null
  sizes?: BomLineSize[]
  componentItem?: {
    id: string
    code: string
    name: string
    standardRate: string | number | null
    uom?: { symbol: string } | null
  }
}

export interface RoutingStepBrief {
  id: string
  sequence: number
  isQcStep: boolean
  ratePerPiece: number | string | null
  smv: number | string | null
  operation?: { id: string; name: string; code: string }
}

export interface Bom {
  id: string
  styleId: string
  version: string
  status: string
  isActive: boolean
  totalCost: string | number | null
  labourCost: string | number | null
  notes: string | null
  routingId: string | null
  baseSizeId: string | null
  style?: { id: string; code: string; name: string; brandType: string; sizeGroupId: string | null }
  baseSize?: { id: string; code: string; label: string } | null
  approvedBy?: { id: string; name: string } | null
  routing?: { id: string; code: string; name: string; steps?: RoutingStepBrief[] } | null
  lines?: BomLine[]
}

interface ItemOption {
  id: string
  code: string
  name: string
  standardRate?: string | number | null
  uom?: { symbol: string } | null
}

interface StyleOption {
  id: string
  code: string
  name: string
  sizeGroupId: string | null
}

interface SizeOption {
  id: string
  code: string
  label: string
  sequence: number
  sizeGroupId: string
}

interface RoutingOption {
  id: string
  code: string
  name: string
}

interface Props {
  open: boolean
  onClose: () => void
  onSaved: (message?: string) => void
  record?: Bom | null
}

/** What the form holds while it is being typed, before it becomes a payload. */
interface EditLine {
  componentItemId: string
  component: string
  qtyPerUnit: string
  wastagePercent: string
  unitCost: string
  notes: string
  /** Whether this component's consumption differs by size. */
  sizeWise: boolean
  /** sizeId to quantity, only for the sizes actually typed. */
  sizeQty: Record<string, string>
  /** The step used by "Fill sizes", kept per line. */
  step: string
}

const emptyLine = (): EditLine => ({
  componentItemId: '',
  component: '',
  qtyPerUnit: '',
  wastagePercent: '0',
  unitCost: '',
  notes: '',
  sizeWise: false,
  sizeQty: {},
  step: '',
})

const round = (n: number, dp: number) => Number(n.toFixed(dp))

export function BomFormDialog({ open, onClose, onSaved, record }: Props) {
  const isEdit = Boolean(record)
  const frozen = Boolean(record && record.status !== 'DRAFT')

  const [styles, setStyles] = useState<StyleOption[]>([])
  const [items, setItems] = useState<ItemOption[]>([])
  const [sizes, setSizes] = useState<SizeOption[]>([])
  const [routings, setRoutings] = useState<RoutingOption[]>([])

  const [styleId, setStyleId] = useState('')
  const [version, setVersion] = useState('1.0')
  const [routingId, setRoutingId] = useState('')
  const [baseSizeId, setBaseSizeId] = useState('')
  const [notes, setNotes] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [lines, setLines] = useState<EditLine[]>([emptyLine()])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return

    setStyleId(record?.styleId ?? '')
    setVersion(record?.version ?? '1.0')
    setRoutingId(record?.routingId ?? '')
    setBaseSizeId(record?.baseSizeId ?? '')
    setNotes(record?.notes ?? '')
    setIsActive(record?.isActive ?? true)
    setLines(
      record?.lines?.length
        ? record.lines.map((l) => ({
            componentItemId: l.componentItemId,
            component: l.component ?? '',
            qtyPerUnit: String(l.qtyPerUnit),
            wastagePercent: String(l.wastagePercent ?? 0),
            unitCost: l.unitCost != null ? String(l.unitCost) : '',
            notes: l.notes ?? '',
            sizeWise: (l.sizes?.length ?? 0) > 0,
            sizeQty: Object.fromEntries(
              (l.sizes ?? []).map((s) => [s.sizeId, String(s.qtyPerUnit)]),
            ),
            step: '',
          }))
        : [emptyLine()],
    )
    setError(null)
    setFieldErrors({})

    void Promise.all([
      masterResource<StyleOption>('styles').list({ limit: 200, active: true }),
      masterResource<ItemOption>('items').list({ limit: 200, active: true }),
      masterResource<SizeOption>('sizes').list({ limit: 200 }),
    ])
      .then(([s, i, z]) => {
        setStyles((s as Paginated<StyleOption>).data)
        setItems((i as Paginated<ItemOption>).data)
        setSizes((z as Paginated<SizeOption>).data)
      })
      .catch(() => setError('Could not load styles, items and sizes.'))
  }, [open, record])

  // Routings belong to a style, so the list is refetched when the style changes.
  useEffect(() => {
    if (!open || !styleId) {
      setRoutings([])
      return
    }
    let cancelled = false
    void api
      .get<Paginated<RoutingOption>>(`/masters/routings?styleId=${styleId}&active=true&limit=200`)
      .then((res) => {
        if (!cancelled) setRoutings(res.data)
      })
      .catch(() => {
        if (!cancelled) setRoutings([])
      })
    return () => {
      cancelled = true
    }
  }, [open, styleId])

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

  /**
   * The item list is one page of active items, which is not enough on its own:
   * a component that has since been deactivated, or that sits past the first
   * page, would render as a blank dropdown priced at zero — and the row would
   * look like a mistake somebody should delete. The record already carries its
   * own components, so they are merged back in.
   */
  const itemsById = useMemo(() => {
    const map = new Map<string, ItemOption>()
    for (const i of items) map.set(i.id, i)
    for (const l of record?.lines ?? []) {
      const c = l.componentItem
      if (c && !map.has(c.id)) {
        map.set(c.id, { id: c.id, code: c.code, name: c.name, standardRate: c.standardRate, uom: c.uom })
      }
    }
    return map
  }, [items, record])

  const itemOptions = useMemo(
    () => [...itemsById.values()].sort((a, b) => a.code.localeCompare(b.code)),
    [itemsById],
  )

  const style = styles.find((s) => s.id === styleId) ?? record?.style
  const groupSizes = useMemo(
    () =>
      style?.sizeGroupId
        ? sizes.filter((s) => s.sizeGroupId === style.sizeGroupId).sort((a, b) => a.sequence - b.sequence)
        : [],
    [sizes, style],
  )

  if (!open) return null

  const setLine = (index: number, patch: Partial<EditLine>) => {
    setLines((ls) => ls.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }

  /**
   * Mirrors the server's costing so the number is on screen before saving:
   * wastage inflates the consumed quantity, and a blank rate falls back to the
   * item's standard rate.
   */
  const priceOf = (line: EditLine) => {
    const item = itemsById.get(line.componentItemId)
    const qty = Number(line.qtyPerUnit) || 0
    const wastage = Number(line.wastagePercent) || 0
    const factor = 1 + wastage / 100
    const rate = line.unitCost !== '' ? Number(line.unitCost) : Number(item?.standardRate ?? 0)
    const effective = round(qty * factor, 4)
    return {
      effective,
      rate,
      cost: round(effective * rate, 2),
      unit: item?.uom?.symbol ?? '',
      factor,
      hasRate: line.unitCost !== '' || item?.standardRate != null,
    }
  }

  const grandTotal = round(
    lines.reduce((sum, l) => sum + priceOf(l).cost, 0),
    2,
  )

  /** Per-size totals, so the cost of a 3XL is visible before saving. */
  const sizeTotals = groupSizes
    .map((size) => {
      let cost = 0
      let anyWise = false
      for (const line of lines) {
        const { factor, rate, cost: base } = priceOf(line)
        const own = line.sizeWise ? line.sizeQty[size.id] : undefined
        if (own !== undefined && own !== '') {
          anyWise = true
          cost += round(round(Number(own) * factor, 4) * rate, 2)
        } else {
          cost += base
        }
      }
      return { label: size.label, cost, anyWise }
    })
    .filter((s) => s.anyWise)

  /**
   * A size set is built as a fixed increment per size, not six free numbers.
   * Filling walks outward from the base size so the merchandiser edits the
   * exceptions rather than typing the whole run.
   */
  const fillSizes = (index: number) => {
    const line = lines[index]
    const base = Number(line.qtyPerUnit) || 0
    const step = Number(line.step) || 0
    const anchor = groupSizes.findIndex((s) => s.id === baseSizeId)
    const from = anchor >= 0 ? anchor : Math.floor(groupSizes.length / 2)
    const next: Record<string, string> = {}
    groupSizes.forEach((s, i) => {
      next[s.id] = String(round(base + step * (i - from), 4))
    })
    setLine(index, { sizeQty: next })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setFieldErrors({})

    const payloadLines = lines
      .filter((l) => l.componentItemId && l.qtyPerUnit !== '')
      .map((l, index) => {
        const sizes = l.sizeWise
          ? Object.entries(l.sizeQty)
              .filter(([, v]) => v !== '' && v != null)
              .map(([sizeId, v]) => ({ sizeId, qtyPerUnit: Number(v) }))
          : []
        return {
          componentItemId: l.componentItemId,
          ...(l.component ? { component: l.component } : {}),
          qtyPerUnit: Number(l.qtyPerUnit),
          wastagePercent: Number(l.wastagePercent) || 0,
          ...(l.unitCost !== '' ? { unitCost: Number(l.unitCost) } : {}),
          ...(l.notes ? { notes: l.notes } : {}),
          ...(sizes.length > 0 ? { sizes } : {}),
          sortOrder: index,
        }
      })

    if (payloadLines.length === 0) {
      setError('Add at least one component with a quantity.')
      setSaving(false)
      return
    }

    const body = {
      version,
      notes,
      isActive,
      routingId: routingId || null,
      baseSizeId: baseSizeId || null,
      lines: payloadLines,
    }

    try {
      const res = isEdit
        ? await api.patch<{ message?: string }>(`/masters/bom/${record!.id}`, body)
        : await api.post<{ message?: string }>('/masters/bom', { ...body, styleId })
      onSaved(res?.message)
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

          {frozen && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-amber-500/40 bg-amber-500/5">
              <AlertCircle size={16} className="text-amber-400 mt-0.5 shrink-0" />
              <p className="text-sm text-foreground">
                This BOM is approved, so its components cannot be changed. Copy it to a new version
                instead.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                disabled={frozen}
              />
            </div>

            <div>
              <label className="form-label" htmlFor="bom-base-size">
                Sized on
              </label>
              <select
                id="bom-base-size"
                className="form-input"
                value={baseSizeId}
                onChange={(e) => setBaseSizeId(e.target.value)}
                disabled={frozen || groupSizes.length === 0}
              >
                <option value="">No particular size</option>
                {groupSizes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                {groupSizes.length === 0
                  ? 'This style has no size run yet. Add one on the style to set quantities per size.'
                  : 'The size the quantities below are measured against.'}
              </p>
            </div>

            <div className="md:col-span-2">
              <label className="form-label" htmlFor="bom-routing">
                Routing
              </label>
              <select
                id="bom-routing"
                className="form-input"
                value={routingId}
                onChange={(e) => setRoutingId(e.target.value)}
                disabled={frozen || !styleId}
              >
                <option value="">No routing — material cost only</option>
                {routings.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code} — {r.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                The steps come from the routing — the BOM does not repeat them. Labour is the sum of
                the rate per piece on each step.
              </p>
            </div>
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Components
              </h3>
              <button
                type="button"
                className="btn-ghost text-xs"
                disabled={frozen}
                onClick={() => setLines((ls) => [...ls, emptyLine()])}
              >
                <Plus size={13} />
                Add component
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="data-table min-w-[820px]">
                <thead>
                  <tr>
                    <th className="min-w-56">Item</th>
                    <th className="w-28">Part</th>
                    <th className="w-28 text-right">Qty / pc</th>
                    <th className="w-24 text-right">Wastage %</th>
                    <th className="w-28 text-right">Rate</th>
                    <th className="w-28 text-right">Cost</th>
                    <th className="w-20" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => {
                    const { effective, rate, cost, unit, hasRate } = priceOf(line)

                    return (
                      <Fragment key={index}>
                        <tr>
                          <td>
                            <select
                              className="form-input"
                              value={line.componentItemId}
                              disabled={frozen}
                              onChange={(e) => setLine(index, { componentItemId: e.target.value })}
                            >
                              <option value="">Select item...</option>
                              {itemOptions.map((i) => (
                                <option key={i.id} value={i.id}>
                                  {i.code} — {i.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              className="form-input"
                              value={line.component}
                              disabled={frozen}
                              placeholder="Body"
                              onChange={(e) => setLine(index, { component: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              step="any"
                              min="0"
                              className="form-input text-right"
                              value={line.qtyPerUnit}
                              disabled={frozen}
                              onChange={(e) => setLine(index, { qtyPerUnit: e.target.value })}
                              placeholder="1.65"
                            />
                            {unit && (
                              <p className="text-xs text-muted-foreground text-right mt-1">
                                {effective} {unit} after wastage
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
                              value={line.wastagePercent}
                              disabled={frozen}
                              onChange={(e) => setLine(index, { wastagePercent: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              step="any"
                              min="0"
                              className="form-input text-right"
                              value={line.unitCost}
                              disabled={frozen}
                              onChange={(e) => setLine(index, { unitCost: e.target.value })}
                              placeholder={rate ? String(rate) : '0'}
                            />
                            <p className="text-xs text-muted-foreground text-right mt-1">
                              {hasRate ? 'Blank uses the standard rate' : 'No rate on this item yet'}
                            </p>
                          </td>
                          <td className="text-right font-semibold align-top pt-3">
                            {formatCurrency(cost)}
                          </td>
                          <td className="align-top pt-3">
                            <div className="flex items-center gap-1 justify-end">
                              {groupSizes.length > 0 && (
                                <button
                                  type="button"
                                  className="btn-ghost p-1.5"
                                  disabled={frozen}
                                  title={line.sizeWise ? 'Same for every size' : 'Size-wise'}
                                  onClick={() =>
                                    setLine(index, {
                                      sizeWise: !line.sizeWise,
                                      sizeQty: line.sizeWise ? {} : line.sizeQty,
                                    })
                                  }
                                >
                                  <Ruler
                                    size={14}
                                    className={line.sizeWise ? 'text-teal-400' : undefined}
                                  />
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn-ghost p-1.5 text-red-400"
                                aria-label="Remove component"
                                disabled={frozen}
                                onClick={() =>
                                  setLines((ls) =>
                                    ls.length === 1
                                      ? [emptyLine()]
                                      : ls.filter((_, i) => i !== index),
                                  )
                                }
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>

                        {line.sizeWise && groupSizes.length > 0 && (
                          <tr>
                            <td colSpan={7} className="bg-secondary/40">
                              <div className="flex flex-wrap items-end gap-3 py-2">
                                {groupSizes.map((s) => (
                                  <div key={s.id} className="w-20">
                                    <label className="form-label" htmlFor={`sz-${index}-${s.id}`}>
                                      {s.label}
                                    </label>
                                    <input
                                      id={`sz-${index}-${s.id}`}
                                      type="number"
                                      step="any"
                                      min="0"
                                      className="form-input text-right"
                                      value={line.sizeQty[s.id] ?? ''}
                                      disabled={frozen}
                                      onChange={(e) =>
                                        setLine(index, {
                                          sizeQty: { ...line.sizeQty, [s.id]: e.target.value },
                                        })
                                      }
                                    />
                                  </div>
                                ))}
                                <div className="w-24">
                                  <label className="form-label" htmlFor={`step-${index}`}>
                                    Step up by
                                  </label>
                                  <input
                                    id={`step-${index}`}
                                    type="number"
                                    step="any"
                                    className="form-input text-right"
                                    value={line.step}
                                    disabled={frozen}
                                    placeholder="0.05"
                                    onChange={(e) => setLine(index, { step: e.target.value })}
                                  />
                                </div>
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  disabled={frozen}
                                  onClick={() => fillSizes(index)}
                                >
                                  Fill sizes
                                </button>
                                <p className="text-xs text-muted-foreground flex-1 min-w-48">
                                  Only fabric and interlining usually change by size. A size left
                                  blank uses the quantity above.
                                </p>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                  <tr>
                    <td colSpan={5} className="text-right font-semibold">
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

            {sizeTotals.length > 0 && (
              <p className="flex flex-wrap gap-3 text-xs text-muted-foreground mt-2">
                {sizeTotals.map((s) => (
                  <span key={s.label}>
                    {s.label} {formatCurrency(s.cost)}
                  </span>
                ))}
              </p>
            )}
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
            Offer this BOM on new orders
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
