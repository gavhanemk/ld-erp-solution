'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertCircle, Plus, Trash2, Ruler, ExternalLink } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { cn, formatRupees } from '@/lib/utils'

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
  departmentId?: string | null
  department?: { id: string; code: string; name: string } | null
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
  department?: { id: string; name: string }
  workstation?: { id: string; name: string; type: string } | null
}

export interface Bom {
  id: string
  styleId: string
  /** One BOM per colour. Blank only on BOMs made before colour was recorded. */
  color: string | null
  version: string
  status: string
  isActive: boolean
  totalCost: string | number | null
  labourCost: string | number | null
  notes: string | null
  routingId: string | null
  baseSizeId: string | null
  style?: {
    id: string
    code: string
    name: string
    brandType: string
    sizeGroupId: string | null
    colors: string[]
  }
  baseSize?: { id: string; code: string; label: string } | null
  approvedBy?: { id: string; name: string } | null
  approvedAt?: string | null
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
  colors: string[]
}

interface DepartmentOption {
  id: string
  code: string
  name: string
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
  /** The department that draws it from the store. Blank is allowed but warned. */
  departmentId: string
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
  departmentId: '',
  qtyPerUnit: '',
  wastagePercent: '0',
  unitCost: '',
  notes: '',
  sizeWise: false,
  sizeQty: {},
  step: '',
})

const round = (n: number, dp: number) => Number(n.toFixed(dp))

/** The same three of the six fixed status colours the BOM list uses. */
const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-info' },
  APPROVED: { label: 'Approved', cls: 'badge-success' },
  OBSOLETE: { label: 'Obsolete', cls: 'badge-neutral' },
}

export function BomFormDialog({ open, onClose, onSaved, record }: Props) {
  const isEdit = Boolean(record)
  const frozen = Boolean(record && record.status !== 'DRAFT')

  const [styles, setStyles] = useState<StyleOption[]>([])
  const [items, setItems] = useState<ItemOption[]>([])
  const [sizes, setSizes] = useState<SizeOption[]>([])
  const [routings, setRoutings] = useState<RoutingOption[]>([])
  // Tracked separately from the list, so "no routing set up yet" is only said
  // once the answer is actually known — not while it is still loading, and not
  // when the request failed.
  const [routingState, setRoutingState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [departments, setDepartments] = useState<DepartmentOption[]>([])

  const [styleId, setStyleId] = useState('')
  const [color, setColor] = useState('')
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
    setColor(record?.color ?? '')
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
            departmentId: l.departmentId ?? '',
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
      masterResource<DepartmentOption>('departments').list({ limit: 200, active: true }),
    ])
      .then(([s, i, z, d]) => {
        setStyles((s as Paginated<StyleOption>).data)
        setItems((i as Paginated<ItemOption>).data)
        setSizes((z as Paginated<SizeOption>).data)
        setDepartments((d as Paginated<DepartmentOption>).data)
      })
      .catch(() => setError('Could not load styles, items, sizes and departments.'))
  }, [open, record])

  // Routings belong to a style, so the list is refetched when the style changes.
  useEffect(() => {
    if (!open || !styleId) {
      setRoutings([])
      setRoutingState('idle')
      return
    }
    let cancelled = false
    setRoutingState('loading')
    void api
      .get<Paginated<RoutingOption>>(`/masters/routings?styleId=${styleId}&active=true&limit=200`)
      .then((res) => {
        if (cancelled) return
        setRoutings(res.data)
        setRoutingState('ready')
      })
      .catch(() => {
        if (cancelled) return
        setRoutings([])
        setRoutingState('failed')
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
  const styleColours = style?.colors ?? []
  // A BOM whose colour has since been taken off the style still shows it,
  // rather than rendering as an empty choice.
  const colourOptions =
    color && !styleColours.includes(color) ? [...styleColours, color] : styleColours
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
    const hasItem = Boolean(line.componentItemId)
    const hasQty = line.qtyPerUnit.trim() !== ''
    const typedRate = line.unitCost.trim() !== ''
    const standardRate = item?.standardRate != null ? Number(item.standardRate) : null
    const qty = Number(line.qtyPerUnit) || 0
    const wastage = Number(line.wastagePercent) || 0
    const factor = 1 + wastage / 100
    const rate = typedRate ? Number(line.unitCost) : (standardRate ?? 0)
    const effective = round(qty * factor, 4)
    return {
      effective,
      rate,
      cost: round(effective * rate, 2),
      unit: item?.uom?.symbol ?? '',
      factor,
      standardRate,
      hasItem,
      hasQty,
      // What a line still needs. Shown as an amber outline on the box itself, so
      // the row keeps its height instead of growing a line of text beneath it.
      needsQty: hasItem && !hasQty,
      needsRate: hasItem && !typedRate && standardRate === null,
      needsProcess: hasItem && !line.departmentId,
    }
  }

  const priced = lines.map(priceOf)

  const grandTotal = round(
    priced.reduce((sum, p) => sum + p.cost, 0),
    2,
  )

  /** Per-size totals, so the cost of a 3XL is visible before saving. */
  const sizeTotals = groupSizes
    .map((size) => {
      let cost = 0
      let anyWise = false
      lines.forEach((line, i) => {
        const { factor, rate, cost: base } = priced[i]
        const own = line.sizeWise ? line.sizeQty[size.id] : undefined
        if (own !== undefined && own !== '') {
          anyWise = true
          cost += round(round(Number(own) * factor, 4) * rate, 2)
        } else {
          cost += base
        }
      })
      return { label: size.label, cost, anyWise }
    })
    .filter((s) => s.anyWise)

  const filledLines = lines.filter((l) => l.componentItemId).length
  const missingQty = priced.filter((p) => p.needsQty).length
  const missingProcess = priced.filter((p) => p.needsProcess).length

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

    // A line with an item but no quantity used to be dropped on save without a
    // word, and with an example figure sitting in the empty box it looked like a
    // saved line vanishing. Half-filled lines are refused and named instead;
    // only a completely blank row is left out quietly.
    const unfinished = lines.findIndex(
      (l) => Boolean(l.componentItemId) !== (l.qtyPerUnit.trim() !== ''),
    )
    if (unfinished >= 0) {
      const l = lines[unfinished]
      const name = itemsById.get(l.componentItemId)?.name
      setError(
        l.componentItemId
          ? `Line ${unfinished + 1}${name ? ` (${name})` : ''} has no quantity. Enter how much one piece uses, or remove the line.`
          : `Line ${unfinished + 1} has a quantity but no item. Pick the item, or remove the line.`,
      )
      setSaving(false)
      return
    }

    const payloadLines = lines
      .filter((l) => l.componentItemId && l.qtyPerUnit.trim() !== '')
      .map((l, index) => {
        const sizes = l.sizeWise
          ? Object.entries(l.sizeQty)
              .filter(([, v]) => v !== '' && v != null)
              .map(([sizeId, v]) => ({ sizeId, qtyPerUnit: Number(v) }))
          : []
        return {
          componentItemId: l.componentItemId,
          ...(l.component ? { component: l.component } : {}),
          ...(l.departmentId ? { departmentId: l.departmentId } : {}),
          qtyPerUnit: Number(l.qtyPerUnit),
          wastagePercent: Number(l.wastagePercent) || 0,
          ...(l.unitCost.trim() !== '' ? { unitCost: Number(l.unitCost) } : {}),
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

    // Caught here as well as on the server, so the person is told before a
    // round trip rather than after it.
    if (!isEdit && styleColours.length > 0 && !color) {
      setError(
        `${style?.code ?? 'This style'} comes in ${styleColours.join(', ')}. Pick the colour this BOM is for — each colour has its own BOM.`,
      )
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
        : await api.post<{ message?: string }>('/masters/bom', {
            ...body,
            styleId,
            color: color || null,
          })
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

  const title = isEdit ? 'Edit Bill of Materials' : 'New Bill of Materials'
  const summary = [style?.code, color || null, version ? `v${version}` : null]
    .filter(Boolean)
    .join(' · ')
  const statusBadge = record ? (STATUS_BADGE[record.status] ?? STATUS_BADGE.DRAFT) : null
  const baseSizeLabel = groupSizes.find((s) => s.id === baseSizeId)?.label

  // An existing BOM whose routing has since been retired still shows it.
  const routingOptions =
    record?.routing && !routings.some((r) => r.id === record.routing!.id)
      ? [...routings, record.routing]
      : routings
  const noRoutings = routingState === 'ready' && routingOptions.length === 0
  const routingPlaceholder = !styleId
    ? 'Pick a style first'
    : routingState === 'loading'
      ? 'Loading routings...'
      : routingState === 'failed'
        ? 'Could not load routings — material cost only'
        : noRoutings
          ? `No routing set up for ${style?.code ?? 'this style'} yet — material cost only`
          : 'No routing — material cost only'

  /** Header cells: one style, so every column label sits on the same line. */
  const th = 'px-2 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div className="glass-card w-full max-w-7xl my-auto" role="dialog" aria-modal="true" aria-label={title}>
        <form onSubmit={submit}>
          {/* The header stays in view while a long component list scrolls. */}
          <div className="sticky top-0 z-10 flex items-center justify-between gap-4 rounded-t-xl border-b border-border bg-card px-6 py-4">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-foreground">{title}</h2>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {summary || 'Pick a style and colour, then list what goes into one piece.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {statusBadge && <span className={statusBadge.cls}>{statusBadge.label}</span>}
              <button type="button" onClick={onClose} className="btn-ghost p-2" aria-label="Close">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="space-y-6 px-6 py-5">
            {frozen && (
              <div className="flex items-start gap-3 rounded-lg border border-accent/40 bg-accent/5 p-3">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
                <p className="text-sm text-foreground">
                  This BOM is approved, so its components cannot be changed. Copy it to a new version,
                  or to another colour, instead.
                </p>
              </div>
            )}

            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                BOM details
              </h3>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="sm:col-span-2">
                  <label className="form-label" htmlFor="bom-style">
                    Style<span className="ml-0.5 text-red-400">*</span>
                  </label>
                  <select
                    id="bom-style"
                    className="form-input"
                    value={styleId}
                    onChange={(e) => {
                      setStyleId(e.target.value)
                      // Another style has its own colours, so the pick no longer applies.
                      setColor('')
                    }}
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
                    <p className="mt-1 text-xs text-red-400">{fieldErrors.styleId}</p>
                  )}
                </div>

                <div>
                  <label className="form-label" htmlFor="bom-colour">
                    Colour
                    {styleColours.length > 0 && <span className="ml-0.5 text-red-400">*</span>}
                  </label>
                  <select
                    id="bom-colour"
                    className="form-input"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    // Like the style, the colour is what this BOM is. Another colour
                    // is made by copying, so each keeps its own history.
                    disabled={isEdit || colourOptions.length === 0}
                  >
                    <option value="">
                      {!styleId
                        ? 'Pick a style first'
                        : colourOptions.length === 0
                          ? 'No colours on this style'
                          : 'Select a colour...'}
                    </option>
                    {colourOptions.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {fieldErrors.color && <p className="mt-1 text-xs text-red-400">{fieldErrors.color}</p>}
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
                    disabled={frozen}
                  />
                  {fieldErrors.version && (
                    <p className="mt-1 text-xs text-red-400">{fieldErrors.version}</p>
                  )}
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
                    <option value="">
                      {!styleId
                        ? 'Pick a style first'
                        : groupSizes.length === 0
                          ? 'No size run on this style'
                          : 'No particular size'}
                    </option>
                    {groupSizes.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2 lg:col-span-3">
                  <div className="flex items-center justify-between gap-2">
                    <label className="form-label" htmlFor="bom-routing">
                      Routing
                    </label>
                    {noRoutings && (
                      // A new tab, so the half-typed BOM is still here afterwards.
                      <a
                        href="/masters/routings"
                        target="_blank"
                        rel="noreferrer"
                        className="mb-1.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        Set up a routing
                        <ExternalLink size={13} />
                      </a>
                    )}
                  </div>
                  <select
                    id="bom-routing"
                    className="form-input"
                    value={routingId}
                    onChange={(e) => setRoutingId(e.target.value)}
                    disabled={frozen || routingOptions.length === 0}
                  >
                    <option value="">{routingPlaceholder}</option>
                    {routingOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.code} — {r.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {isEdit && (
                <p className="text-xs text-muted-foreground">
                  Style and colour are fixed once a BOM is made. To cost another colour, copy this BOM.
                </p>
              )}
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Components{filledLines > 0 && ` (${filledLines})`}
                </h3>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={frozen}
                  onClick={() => setLines((ls) => [...ls, emptyLine()])}
                >
                  <Plus size={15} />
                  Add component
                </button>
              </div>

              {/*
                Not .data-table: its reading-table padding, sixteen pixels either
                side of every cell, pushes a ten-column editing grid past the width
                of the dialog. Same header type and row dividers, tighter cells.
              */}
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[1100px] table-fixed text-sm">
                  <colgroup>
                    <col className="w-10" />
                    <col />
                    <col className="w-24" />
                    <col className="w-36" />
                    <col className="w-24" />
                    <col className="w-24" />
                    <col className="w-24" />
                    <col className="w-24" />
                    <col className="w-28" />
                    <col className="w-20" />
                  </colgroup>
                  <thead className="bg-secondary/60">
                    <tr className="border-b border-border">
                      <th className={cn(th, 'text-center')}>#</th>
                      <th className={cn(th, 'text-left')}>Item</th>
                      <th className={cn(th, 'text-left')}>Part</th>
                      <th className={cn(th, 'text-left')}>Process</th>
                      <th className={cn(th, 'text-right')}>Qty / pc</th>
                      <th className={cn(th, 'text-right')}>Wastage %</th>
                      <th className={cn(th, 'text-right')}>Effective</th>
                      <th className={cn(th, 'text-right')}>Rate</th>
                      <th className={cn(th, 'text-right')}>Cost</th>
                      <th className={th}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {lines.map((line, index) => {
                      const p = priced[index]
                      const itemName = itemsById.get(line.componentItemId)?.name

                      return (
                        <Fragment key={index}>
                          <tr className="border-b border-border/50">
                            <td className="px-2 py-2 text-center align-middle font-mono text-xs text-muted-foreground">
                              {index + 1}
                            </td>
                            <td className="px-2 py-2 align-middle">
                              <select
                                className="form-input"
                                value={line.componentItemId}
                                disabled={frozen}
                                title={itemName}
                                aria-label={`Line ${index + 1} item`}
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
                            <td className="px-2 py-2 align-middle">
                              <input
                                className="form-input"
                                value={line.component}
                                disabled={frozen}
                                placeholder="e.g. Body"
                                aria-label={`Line ${index + 1} part`}
                                onChange={(e) => setLine(index, { component: e.target.value })}
                              />
                            </td>
                            <td className="px-2 py-2 align-middle">
                              <select
                                className={cn('form-input', p.needsProcess && 'border-accent')}
                                value={line.departmentId}
                                disabled={frozen}
                                aria-label={`Line ${index + 1} process`}
                                // Not refused — a BOM can be costed before this is
                                // decided — but an order cannot ask the store for the
                                // item until it is, so the box is outlined.
                                title={
                                  p.needsProcess
                                    ? 'Which department uses this? An order needs it to ask the store.'
                                    : undefined
                                }
                                onChange={(e) => setLine(index, { departmentId: e.target.value })}
                              >
                                <option value="">Select...</option>
                                {departments.map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-2 py-2 align-middle">
                              <input
                                type="number"
                                step="any"
                                min="0"
                                inputMode="decimal"
                                className={cn(
                                  'form-input text-right tabular-nums',
                                  p.needsQty && 'border-accent',
                                )}
                                value={line.qtyPerUnit}
                                disabled={frozen}
                                aria-label={`Line ${index + 1} quantity per piece`}
                                title={p.needsQty ? 'Enter how much one piece uses' : undefined}
                                onChange={(e) => setLine(index, { qtyPerUnit: e.target.value })}
                              />
                            </td>
                            <td className="px-2 py-2 align-middle">
                              <input
                                type="number"
                                step="any"
                                min="0"
                                max="100"
                                inputMode="decimal"
                                className="form-input text-right tabular-nums"
                                value={line.wastagePercent}
                                disabled={frozen}
                                aria-label={`Line ${index + 1} wastage percent`}
                                onChange={(e) => setLine(index, { wastagePercent: e.target.value })}
                              />
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-right align-middle font-mono text-xs text-muted-foreground">
                              {p.hasItem && p.hasQty ? `${p.effective} ${p.unit}` : '—'}
                            </td>
                            <td className="px-2 py-2 align-middle">
                              <input
                                type="number"
                                step="any"
                                min="0"
                                inputMode="decimal"
                                className={cn(
                                  'form-input text-right tabular-nums',
                                  p.needsRate && 'border-accent',
                                )}
                                value={line.unitCost}
                                disabled={frozen}
                                // "std 178", never a bare "178": a figure that looks
                                // typed is how an empty box got mistaken for a filled one.
                                placeholder={p.standardRate !== null ? `std ${p.standardRate}` : ''}
                                aria-label={`Line ${index + 1} rate`}
                                title={
                                  p.needsRate
                                    ? 'This item has no standard rate. Type one.'
                                    : p.standardRate !== null
                                      ? `Blank uses the standard rate, ${formatRupees(p.standardRate)}`
                                      : undefined
                                }
                                onChange={(e) => setLine(index, { unitCost: e.target.value })}
                              />
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-right align-middle font-mono text-sm font-semibold text-foreground">
                              {p.hasItem && p.hasQty ? formatRupees(p.cost) : '—'}
                            </td>
                            <td className="px-2 py-2 align-middle">
                              <div className="flex items-center justify-end gap-1">
                                {groupSizes.length > 0 && (
                                  <button
                                    type="button"
                                    className="btn-ghost p-1.5"
                                    disabled={frozen}
                                    title={line.sizeWise ? 'Same for every size' : 'Quantities by size'}
                                    aria-label={line.sizeWise ? 'Same for every size' : 'Quantities by size'}
                                    onClick={() =>
                                      setLine(index, {
                                        sizeWise: !line.sizeWise,
                                        sizeQty: line.sizeWise ? {} : line.sizeQty,
                                      })
                                    }
                                  >
                                    <Ruler size={14} className={line.sizeWise ? 'text-primary' : undefined} />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn-ghost p-1.5 text-red-400"
                                  aria-label={`Remove line ${index + 1}`}
                                  disabled={frozen}
                                  onClick={() =>
                                    setLines((ls) =>
                                      ls.length === 1 ? [emptyLine()] : ls.filter((_, i) => i !== index),
                                    )
                                  }
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>

                          {line.sizeWise && groupSizes.length > 0 && (
                            <tr className="border-b border-border/50">
                              <td />
                              <td colSpan={9} className="px-2 pb-3">
                                <div className="space-y-2 rounded-lg bg-secondary/60 p-3">
                                  <p className="text-xs text-muted-foreground">
                                    Quantity per piece for each size. A size left blank uses{' '}
                                    {p.hasQty ? `${line.qtyPerUnit} ${p.unit}`.trim() : 'the quantity on the line'}.
                                  </p>
                                  <div className="flex flex-wrap items-end gap-3">
                                    {groupSizes.map((s) => (
                                      <div key={s.id} className="w-20">
                                        <label
                                          className="mb-1 block text-xs font-medium text-muted-foreground"
                                          htmlFor={`sz-${index}-${s.id}`}
                                        >
                                          {s.label}
                                        </label>
                                        <input
                                          id={`sz-${index}-${s.id}`}
                                          type="number"
                                          step="any"
                                          min="0"
                                          inputMode="decimal"
                                          className="form-input text-right tabular-nums"
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
                                      <label
                                        className="mb-1 block text-xs font-medium text-muted-foreground"
                                        htmlFor={`step-${index}`}
                                      >
                                        Step up by
                                      </label>
                                      <input
                                        id={`step-${index}`}
                                        type="number"
                                        step="any"
                                        inputMode="decimal"
                                        className="form-input text-right tabular-nums"
                                        value={line.step}
                                        disabled={frozen}
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
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>

                  <tfoot>
                    <tr className="bg-secondary/40">
                      <td colSpan={8} className="px-2 py-3 text-right text-sm font-semibold text-foreground">
                        Material cost per piece
                        {baseSizeLabel && ` (size ${baseSizeLabel})`}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 text-right font-mono text-sm font-bold text-primary">
                        {formatRupees(grandTotal)}
                      </td>
                      <td />
                    </tr>
                    {sizeTotals.length > 0 && (
                      <tr className="bg-secondary/40">
                        <td colSpan={10} className="px-2 pb-3 text-right">
                          <span className="inline-flex flex-wrap justify-end gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
                            {sizeTotals.map((s) => (
                              <span key={s.label}>
                                {s.label} {formatRupees(s.cost)}
                              </span>
                            ))}
                          </span>
                        </td>
                      </tr>
                    )}
                  </tfoot>
                </table>
              </div>

              <p className="text-xs text-muted-foreground">
                A blank rate uses the item&apos;s standard rate, shown as &ldquo;std&rdquo; in the box. An
                amber outline marks what a line still needs.
              </p>
            </section>

            <section>
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
            </section>
          </div>

          {/* The footer stays in view too, so the total and Save are never scrolled away. */}
          <div className="sticky bottom-0 z-10 space-y-3 rounded-b-xl border-t border-border bg-card px-6 py-4">
            {error && (
              <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="accent-teal-500"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                  />
                  Offer this BOM on new orders
                </label>
                {(missingQty > 0 || missingProcess > 0) && (
                  <p className="text-xs text-accent">
                    {[
                      missingQty > 0 &&
                        `${missingQty} line${missingQty === 1 ? ' needs' : 's need'} a quantity`,
                      missingProcess > 0 &&
                        `${missingProcess} without a process`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3">
                <div className="mr-2 text-right">
                  <p className="text-xs text-muted-foreground">Material per piece</p>
                  <p className="font-mono text-sm font-bold text-foreground">
                    {formatRupees(grandTotal)}
                  </p>
                </div>
                <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={saving}>
                  {saving && <Loader2 size={15} className="animate-spin" />}
                  {isEdit ? 'Save changes' : 'Create BOM'}
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
