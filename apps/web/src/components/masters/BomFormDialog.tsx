'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  X,
  Loader2,
  AlertCircle,
  Plus,
  Trash2,
  Box,
  Layers,
  FileText,
  Save,
  Shirt,
  Cylinder,
  CircleDot,
  Tag,
  Package,
  Scissors,
  type LucideIcon,
} from 'lucide-react'
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
  type?: string
  standardRate?: string | number | null
  uom?: { symbol: string } | null
  category?: { name: string } | null
}

interface StyleOption {
  id: string
  code: string
  name: string
  colors: string[]
}

interface DepartmentOption {
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

/**
 * What an older line was saved with that this form no longer asks for: the
 * part it goes into, a wastage percent, a note, and quantities by size. None of
 * it is shown, but all of it is sent back as it came, so opening and saving an
 * old BOM does not quietly wipe it or change what it costs.
 */
interface CarriedOver {
  component: string | null
  wastagePercent: number
  notes: string | null
  sizes: { sizeId: string; qtyPerUnit: number }[]
}

const nothingCarried: CarriedOver = { component: null, wastagePercent: 0, notes: null, sizes: [] }

/** What the form holds while it is being typed, before it becomes a payload. */
interface EditLine {
  /** A stable React key, so a line added mid-list does not take over the next line's inputs. */
  rowKey: number
  componentItemId: string
  /**
   * The department that draws it from the store. Nothing reads it yet; it is
   * asked for now because production orders are to raise one store request per
   * department from the BOM, and every BOM typed without it would need opening
   * again then. Blank is allowed but outlined.
   */
  departmentId: string
  qtyPerUnit: string
  unitCost: string
  carried: CarriedOver
}

let nextRowKey = 0

const emptyLine = (): EditLine => ({
  rowKey: nextRowKey++,
  componentItemId: '',
  departmentId: '',
  qtyPerUnit: '',
  unitCost: '',
  carried: nothingCarried,
})

const round = (n: number, dp: number) => Number(n.toFixed(dp))

/**
 * A picture of what kind of thing a line is, so a long list can be scanned
 * without reading every name. Read from the item's category, then its type;
 * anything unrecognised gets a plain box.
 */
function itemIcon(item?: ItemOption): LucideIcon {
  const kind = `${item?.category?.name ?? ''} ${item?.type ?? ''}`.toLowerCase()
  if (kind.includes('fabric')) return Shirt
  if (kind.includes('thread')) return Cylinder
  if (kind.includes('button') || kind.includes('fastener')) return CircleDot
  if (kind.includes('label') || kind.includes('tag')) return Tag
  if (kind.includes('pack')) return Package
  if (kind.includes('trim')) return Scissors
  return Box
}

/** The same three of the six fixed status colours the BOM list uses. */
const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-info' },
  APPROVED: { label: 'Approved', cls: 'badge-success' },
  OBSOLETE: { label: 'Obsolete', cls: 'badge-neutral' },
}

/**
 * The form asks only for what the BOM is used for today: the style and colour
 * it is for, what one piece consumes and at what rate, and which department
 * draws each item from the store. The rest of a BOM — its routing, base size
 * and whether it is offered — is left as it is on an existing BOM and at its
 * default on a new one; offering and retiring are done from the BOM list.
 */
export function BomFormDialog({ open, onClose, onSaved, record }: Props) {
  const isEdit = Boolean(record)
  const frozen = Boolean(record && record.status !== 'DRAFT')

  const [styles, setStyles] = useState<StyleOption[]>([])
  const [items, setItems] = useState<ItemOption[]>([])
  const [departments, setDepartments] = useState<DepartmentOption[]>([])

  const [styleId, setStyleId] = useState('')
  const [color, setColor] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<EditLine[]>([emptyLine()])
  // The line a row's + button just added, which takes the cursor.
  const [addedKey, setAddedKey] = useState<number | null>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return

    setStyleId(record?.styleId ?? '')
    setColor(record?.color ?? '')
    setNotes(record?.notes ?? '')
    setAddedKey(null)
    setLines(
      record?.lines?.length
        ? record.lines.map((l) => ({
            rowKey: nextRowKey++,
            componentItemId: l.componentItemId,
            departmentId: l.departmentId ?? '',
            qtyPerUnit: String(l.qtyPerUnit),
            unitCost: l.unitCost != null ? String(l.unitCost) : '',
            carried: {
              component: l.component ?? null,
              wastagePercent: Number(l.wastagePercent ?? 0),
              notes: l.notes ?? null,
              sizes: (l.sizes ?? []).map((s) => ({ sizeId: s.sizeId, qtyPerUnit: Number(s.qtyPerUnit) })),
            },
          }))
        : [emptyLine()],
    )
    setError(null)
    setFieldErrors({})

    void Promise.all([
      masterResource<StyleOption>('styles').list({ limit: 200, active: true }),
      masterResource<ItemOption>('items').list({ limit: 200, active: true }),
      masterResource<DepartmentOption>('departments').list({ limit: 200, active: true }),
    ])
      .then(([s, i, d]) => {
        setStyles((s as Paginated<StyleOption>).data)
        setItems((i as Paginated<ItemOption>).data)
        setDepartments((d as Paginated<DepartmentOption>).data)
      })
      .catch(() => setError('Could not load styles, items and departments.'))
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

  if (!open) return null

  const setLine = (index: number, patch: Partial<EditLine>) => {
    setLines((ls) => ls.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }

  /** A new blank line directly below this one, rather than at the foot of a long list. */
  const addLineAfter = (index: number) => {
    const line = emptyLine()
    setAddedKey(line.rowKey)
    setLines((ls) => [...ls.slice(0, index + 1), line, ...ls.slice(index + 1)])
  }

  const removeLine = (index: number) => {
    setLines((ls) => (ls.length === 1 ? [emptyLine()] : ls.filter((_, i) => i !== index)))
  }

  /**
   * Mirrors the server's costing so the number is on screen before saving: a
   * blank rate falls back to the item's standard rate, and a wastage carried
   * over from an older line still inflates the consumed quantity.
   */
  const priceOf = (line: EditLine) => {
    const item = itemsById.get(line.componentItemId)
    const hasItem = Boolean(line.componentItemId)
    const hasQty = line.qtyPerUnit.trim() !== ''
    const typedRate = line.unitCost.trim() !== ''
    const standardRate = item?.standardRate != null ? Number(item.standardRate) : null
    const qty = Number(line.qtyPerUnit) || 0
    const wastage = line.carried.wastagePercent
    const rate = typedRate ? Number(line.unitCost) : (standardRate ?? 0)
    const effective = round(qty * (1 + wastage / 100), 4)
    return {
      rate,
      cost: round(effective * rate, 2),
      unit: item?.uom?.symbol ?? '',
      wastage,
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

  const filledLines = lines.filter((l) => l.componentItemId).length
  const missingQty = priced.filter((p) => p.needsQty).length
  const missingProcess = priced.filter((p) => p.needsProcess).length

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setFieldErrors({})

    const send = async (body: Record<string, unknown>) => {
      try {
        const res = isEdit
          ? await api.patch<{ message?: string }>(`/masters/bom/${record!.id}`, body)
          : await api.post<{ message?: string }>('/masters/bom', body)
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

    // An approved BOM's components are locked, and the server refuses a save
    // that sends them at all — so only the note goes, which it does allow.
    if (frozen) {
      await send({ notes })
      return
    }

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
      .map((l, index) => ({
        componentItemId: l.componentItemId,
        ...(l.departmentId ? { departmentId: l.departmentId } : {}),
        qtyPerUnit: Number(l.qtyPerUnit),
        ...(l.unitCost.trim() !== '' ? { unitCost: Number(l.unitCost) } : {}),
        wastagePercent: l.carried.wastagePercent,
        ...(l.carried.component ? { component: l.carried.component } : {}),
        ...(l.carried.notes ? { notes: l.carried.notes } : {}),
        ...(l.carried.sizes.length > 0 ? { sizes: l.carried.sizes } : {}),
        sortOrder: index,
      }))

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

    // Version, routing, base size and whether it is offered are not sent. A new
    // BOM starts at version 1.0 with none of the others; an edit keeps whatever
    // it had. Later versions come from Copy on the BOM list.
    await send(
      isEdit
        ? { notes, lines: payloadLines }
        : { styleId, color: color || null, notes, lines: payloadLines },
    )
  }

  const title = isEdit ? 'Edit Bill of Materials' : 'New Bill of Materials'
  // The version is not edited here, but an open BOM still says which one it is.
  const summary = [style?.code, color || null, record ? `v${record.version}` : null]
    .filter(Boolean)
    .join(' · ')
  const statusBadge = record ? (STATUS_BADGE[record.status] ?? STATUS_BADGE.DRAFT) : null

  /** Header cells: one style, so every column label sits on the same line. */
  const th = 'px-2 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground'
  /**
   * Fields sit on a tinted panel, so they take the card colour to stand out
   * from it — white on grey in the light theme, an inset well in the dark.
   */
  const field = 'form-input bg-card'
  /** The quiet panel each part of the form sits in. */
  const panel = 'rounded-xl border border-border bg-secondary/60 p-4'
  /** Row buttons are icon-only and square; switched off, they fade rather than keep their colour. */
  const rowBtn = 'p-2 disabled:pointer-events-none disabled:opacity-40'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      {/*
        Solid rather than see-through glass: the form's panels are tinted, and
        over a dimmed page the glass turned the whole body the same grey.
      */}
      <div className="glass-card w-full max-w-6xl my-auto bg-card" role="dialog" aria-modal="true" aria-label={title}>
        <form onSubmit={submit}>
          {/* The header stays in view while a long component list scrolls. */}
          <div className="sticky top-0 z-10 flex items-center justify-between gap-4 rounded-t-xl border-b border-border bg-card px-6 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Box size={18} />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-foreground">{title}</h2>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">
                  {summary || 'Pick a style and colour, then list what goes into one piece.'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {statusBadge && <span className={statusBadge.cls}>{statusBadge.label}</span>}
              <button type="button" onClick={onClose} className="btn-ghost p-2" aria-label="Close">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="space-y-4 px-6 py-5">
            {frozen && (
              <div className="flex items-start gap-3 rounded-lg border border-accent/40 bg-accent/5 p-3">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
                <p className="text-sm text-foreground">
                  This BOM is approved, so its components cannot be changed — only the notes. Copy it
                  to a new version, or to another colour, from the BOM list instead.
                </p>
              </div>
            )}

            <section className={panel} aria-label="BOM details">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="form-label" htmlFor="bom-style">
                    Style<span className="ml-0.5 text-red-400">*</span>
                  </label>
                  <select
                    id="bom-style"
                    className={field}
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
                    className={field}
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
              </div>

              {isEdit && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Style and colour are fixed once a BOM is made. To cost another colour, copy this BOM.
                </p>
              )}
            </section>

            <section className={cn(panel, 'space-y-3')}>
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Layers size={16} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground">
                    Components
                    {filledLines > 0 && (
                      <span className="ml-1.5 font-normal text-muted-foreground">({filledLines})</span>
                    )}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Everything one piece uses. A blank rate uses the item&apos;s standard rate, shown as
                    &ldquo;std&rdquo; in the box; an amber outline marks what a line still needs.
                  </p>
                </div>
              </div>

              {/*
                Not .data-table: its reading-table padding, sixteen pixels either
                side of every cell, is too loose for a grid of inputs. Same header
                type and row dividers, tighter cells.
              */}
              <div className="overflow-x-auto rounded-lg border border-border bg-card">
                <table className="w-full min-w-[860px] table-fixed text-sm">
                  <colgroup>
                    <col />
                    <col className="w-40" />
                    {/* Wide enough for 1.7325 beside its unit and the number spinner. */}
                    <col className="w-36" />
                    <col className="w-32" />
                    <col className="w-32" />
                    <col className="w-28" />
                  </colgroup>
                  <thead className="bg-secondary/60">
                    <tr className="border-b border-border">
                      <th className={cn(th, 'pl-3 text-left')}>Item</th>
                      <th className={cn(th, 'text-left')} title="The department that takes this item from the store">
                        Process
                      </th>
                      <th className={cn(th, 'text-right')}>Qty / pc</th>
                      <th className={cn(th, 'text-right')}>
                        Rate <span className="font-medium normal-case tracking-normal">(₹ / unit)</span>
                      </th>
                      <th className={cn(th, 'text-right')}>
                        Cost <span className="font-medium normal-case tracking-normal">(₹)</span>
                      </th>
                      <th className={cn(th, 'pr-3 text-center')}>Actions</th>
                    </tr>
                  </thead>

                  <tbody>
                    {lines.map((line, index) => {
                      const p = priced[index]
                      const item = itemsById.get(line.componentItemId)
                      const Icon = itemIcon(item)

                      return (
                        <tr key={line.rowKey} className="border-b border-border/50">
                          <td className="py-2 pl-3 pr-2 align-middle">
                            <div className="flex items-stretch gap-2">
                              <span
                                aria-hidden="true"
                                className={cn(
                                  'flex w-10 shrink-0 items-center justify-center rounded-lg border',
                                  item
                                    ? 'border-primary/20 bg-primary/10 text-primary'
                                    : 'border-border bg-secondary text-muted-foreground',
                                )}
                              >
                                <Icon size={16} />
                              </span>
                              <select
                                className={cn(field, 'min-w-0')}
                                value={line.componentItemId}
                                disabled={frozen}
                                title={item?.name}
                                aria-label={`Line ${index + 1} item`}
                                autoFocus={line.rowKey === addedKey}
                                onChange={(e) =>
                                  setLine(index, {
                                    componentItemId: e.target.value,
                                    // A different item is a different line: what the old
                                    // one carried (its part, wastage, sizes) was about
                                    // that item, not this one.
                                    carried: nothingCarried,
                                  })
                                }
                              >
                                <option value="">Select item...</option>
                                {itemOptions.map((i) => (
                                  <option key={i.id} value={i.id}>
                                    {i.code} — {i.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </td>
                          <td className="px-2 py-2 align-middle">
                            <select
                              className={cn(field, p.needsProcess && 'border-accent')}
                              value={line.departmentId}
                              disabled={frozen}
                              aria-label={`Line ${index + 1} process`}
                              // Not refused — a BOM can be costed before this is
                              // decided — but a production order will not be able to
                              // ask the store for the item until it is.
                              title={
                                p.needsProcess
                                  ? 'Which department uses this? Production orders will need it to ask the store.'
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
                            {/* The unit sits inside the box, where it reads with the figure. */}
                            <div className="relative">
                              <input
                                type="number"
                                step="any"
                                min="0"
                                inputMode="decimal"
                                className={cn(
                                  field,
                                  'text-right tabular-nums',
                                  p.unit && 'pr-10',
                                  p.needsQty && 'border-accent',
                                )}
                                value={line.qtyPerUnit}
                                disabled={frozen}
                                aria-label={`Line ${index + 1} quantity per piece${p.unit ? `, in ${p.unit}` : ''}`}
                                title={p.needsQty ? 'Enter how much one piece uses' : undefined}
                                onChange={(e) => setLine(index, { qtyPerUnit: e.target.value })}
                              />
                              {p.unit && (
                                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                                  {p.unit}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-2 align-middle">
                            <div className="relative">
                              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                                ₹
                              </span>
                              <input
                                type="number"
                                step="any"
                                min="0"
                                inputMode="decimal"
                                className={cn(
                                  field,
                                  'pl-7 text-right tabular-nums',
                                  p.needsRate && 'border-accent',
                                )}
                                value={line.unitCost}
                                disabled={frozen}
                                // "std 178", never a bare "178": a figure that looks
                                // typed is how an empty box got mistaken for a filled one.
                                placeholder={p.standardRate !== null ? `std ${p.standardRate}` : ''}
                                aria-label={`Line ${index + 1} rate${p.unit ? ` per ${p.unit}` : ''}`}
                                title={
                                  p.needsRate
                                    ? 'This item has no standard rate. Type one.'
                                    : p.standardRate !== null
                                      ? `Blank uses the standard rate, ${formatRupees(p.standardRate)}${p.unit ? ` per ${p.unit}` : ''}`
                                      : undefined
                                }
                                onChange={(e) => setLine(index, { unitCost: e.target.value })}
                              />
                            </div>
                          </td>
                          <td className="px-2 py-2 align-middle">
                            {/* Worked out, not typed, so it is a box that cannot take the cursor. */}
                            <div className="flex items-center justify-end gap-2 rounded-lg border border-border bg-secondary/60 px-3 py-2.5">
                              {p.wastage > 0 && (
                                // A line saved when wastage was still typed here keeps it,
                                // so its cost is more than quantity times rate. Said, not hidden.
                                <span
                                  className="mr-auto text-xs text-accent"
                                  title={`Includes ${p.wastage}% wastage saved on this line earlier`}
                                >
                                  +{p.wastage}%
                                </span>
                              )}
                              <span className="whitespace-nowrap font-mono text-sm font-semibold text-foreground">
                                {p.hasItem && p.hasQty ? formatRupees(p.cost) : '—'}
                              </span>
                            </div>
                          </td>
                          <td className="py-2 pl-2 pr-3 align-middle">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                className={cn('btn-secondary text-primary', rowBtn)}
                                disabled={frozen}
                                title="Add a component below this one"
                                aria-label={`Add a component below line ${index + 1}`}
                                onClick={() => addLineAfter(index)}
                              >
                                <Plus size={15} />
                              </button>
                              <button
                                type="button"
                                className={cn('btn-danger', rowBtn)}
                                disabled={frozen}
                                title="Remove this component"
                                aria-label={`Remove line ${index + 1}`}
                                onClick={() => removeLine(index)}
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>

                  <tfoot>
                    <tr className="bg-primary/5">
                      <td colSpan={4} className="py-3 pl-3 pr-2">
                        <div className="flex items-center justify-between gap-3">
                          <Layers size={16} className="shrink-0 text-primary" />
                          <span className="text-right text-sm font-medium text-primary">
                            Total material cost per piece
                          </span>
                        </div>
                      </td>
                      {/* Right-padded to sit under the figures in the cost boxes above. */}
                      <td className="whitespace-nowrap py-3 pl-2 pr-5 text-right font-mono text-base font-bold text-primary">
                        {formatRupees(grandTotal)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            <section className={panel}>
              <label
                className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground"
                htmlFor="bom-notes"
              >
                <FileText size={16} className="text-primary" />
                Notes
              </label>
              <textarea
                id="bom-notes"
                rows={2}
                className={field}
                placeholder="Anything the cutting floor or the store should know about this BOM"
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
              <p className="text-xs text-accent">
                {!frozen &&
                  [
                    missingQty > 0 &&
                      `${missingQty} line${missingQty === 1 ? ' needs' : 's need'} a quantity`,
                    missingProcess > 0 && `${missingProcess} without a process`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
              </p>

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
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  {isEdit ? (frozen ? 'Save notes' : 'Save changes') : 'Create BOM'}
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
