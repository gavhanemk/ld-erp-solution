'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
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
  ArrowLeft,
  ArrowRight,
  Check,
  Users,
  Factory,
  IndianRupee,
  Equal,
  type LucideIcon,
} from 'lucide-react'
import { api, ApiError, can, masterResource, type Paginated } from '@/lib/api'
import { cn, formatDate, formatRupees } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'

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

/** One labour or overhead row of a BOM's costing. */
export interface BomCostLine {
  id?: string
  kind: 'LABOUR' | 'OVERHEAD'
  name: string
  departmentId?: string | null
  department?: { id: string; code: string; name: string } | null
  basis: 'PER_PIECE' | 'PERCENT'
  value: number | string
  amount: number | string
  sortOrder?: number
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
  /** Material only. */
  totalCost: string | number | null
  /**
   * The costing below is sent only to people who may approve masters. For
   * everyone else these fields are simply absent.
   */
  labourCost?: string | number | null
  overheadCost?: string | number | null
  costPerPiece?: string | number | null
  /** A share of the selling price: 20 means cost ÷ 0.80. */
  marginPercent?: string | number | null
  /** Before GST, rounded up to the rupee. */
  sellingPrice?: string | number | null
  pricedBy?: { id: string; name: string } | null
  pricedAt?: string | null
  costLines?: BomCostLine[]
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

/** A routing as the list returns it, with the steps "Fill from routing" copies. */
interface RoutingOption {
  id: string
  code: string
  name: string
  steps?: Array<{
    sequence: number
    ratePerPiece: number | string | null
    departmentId?: string
    department?: { id: string; name: string } | null
    operation?: { name: string } | null
  }>
}

interface Props {
  open: boolean
  onClose: () => void
  onSaved: (message?: string) => void
  record?: Bom | null
}

/** Every BOM save answers with the BOM as it now stands, and sometimes a word about it. */
interface SaveResponse {
  success: boolean
  message?: string
  data: Bom
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

/** A labour or overhead row while it is being typed. */
interface EditCostRow {
  rowKey: number
  kind: 'LABOUR' | 'OVERHEAD'
  name: string
  departmentId: string
  basis: 'PER_PIECE' | 'PERCENT'
  value: string
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

const emptyCostRow = (kind: EditCostRow['kind']): EditCostRow => ({
  rowKey: nextRowKey++,
  kind,
  name: '',
  departmentId: '',
  basis: 'PER_PIECE',
  value: '',
})

const round = (n: number, dp: number) => Number(n.toFixed(dp))

/**
 * The same sums the server does, so the figure on screen is the figure that
 * will be saved. Margin is a share of the selling price, rounded to the paisa
 * first so an exact division is not pushed up a rupee, then up to the rupee.
 */
const priceFromMargin = (cost: number, margin: number) =>
  Math.ceil(round(cost / (1 - margin / 100), 2))
const marginFromPrice = (cost: number, price: number) => round(((price - cost) / price) * 100, 2)

/** Shows a stored decimal the way it was typed: 20, not 20.00. */
const plain = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)))

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

type Step = 1 | 2 | 3

const STEPS: Array<{ id: Step; label: string }> = [
  { id: 1, label: 'Materials' },
  { id: 2, label: 'Costing' },
  { id: 3, label: 'Pricing' },
]

/**
 * A BOM is made in three steps: what one piece is made of, what else it costs
 * to make (labour and overhead), and what it sells for. Each step saves before
 * moving on, so somebody can stop after the materials and come back.
 *
 * Costing and pricing are for people who may approve masters. Everyone else
 * sees only the first step — exactly the form they had before — and the API
 * leaves labour, overhead, margin and price out of what it sends them.
 *
 * Approving locks the materials and the costing. The price stays open: cost is
 * a fact about how the garment is made, price is a commercial call that moves
 * with each buyer.
 */
export function BomFormDialog({ open, onClose, onSaved, record }: Props) {
  const canCost = can('masters', 'approve')

  const [styles, setStyles] = useState<StyleOption[]>([])
  const [items, setItems] = useState<ItemOption[]>([])
  const [departments, setDepartments] = useState<DepartmentOption[]>([])
  const [routings, setRoutings] = useState<RoutingOption[]>([])
  const [gstRate, setGstRate] = useState<number | null>(null)

  // The BOM as the server last returned it. It starts as the record being
  // edited, and becomes the new BOM once the first step has saved one.
  const [current, setCurrent] = useState<Bom | null>(null)
  const [step, setStep] = useState<Step>(1)

  const [styleId, setStyleId] = useState('')
  const [color, setColor] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<EditLine[]>([emptyLine()])
  // The line a row's + button just added, which takes the cursor.
  const [addedKey, setAddedKey] = useState<number | null>(null)

  const [costRows, setCostRows] = useState<EditCostRow[]>([])
  const [routingPick, setRoutingPick] = useState('')

  const [margin, setMargin] = useState('')
  const [price, setPrice] = useState('')
  // Whichever of the two was typed last is the one sent, so the price saved is
  // the one the person chose rather than one worked back and forth.
  const [priceSource, setPriceSource] = useState<'margin' | 'price'>('margin')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const isEdit = Boolean(current)
  const frozen = Boolean(current && current.status !== 'DRAFT')

  useEffect(() => {
    if (!open) return

    setCurrent(record ?? null)
    setStep(1)
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
    setCostRows(
      (record?.costLines ?? []).map((c) => ({
        rowKey: nextRowKey++,
        kind: c.kind,
        name: c.name,
        departmentId: c.departmentId ?? '',
        basis: c.basis,
        value: plain(c.value),
      })),
    )
    setMargin(plain(record?.marginPercent))
    setPrice(plain(record?.sellingPrice))
    setPriceSource('margin')
    setRoutings([])
    setRoutingPick('')
    setError(null)
    setNotice(null)
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

    // The GST line under the price is a convenience. Somebody who cannot read
    // the tax settings still prices the BOM; they just do not see that line.
    if (canCost) {
      void api
        .get<{ data: Array<{ rate: number | string; isDefault: boolean }> }>('/settings/tax-rates')
        .then((res) => {
          const rate = res.data.find((t) => t.isDefault)
          setGstRate(rate ? Number(rate.rate) : null)
        })
        .catch(() => setGstRate(null))
    }
  }, [open, record, canCost])

  // The style's routings, fetched when costing is reached, for "Fill from routing".
  useEffect(() => {
    if (!open || step !== 2 || !styleId || frozen) return
    let cancelled = false
    void api
      .get<Paginated<RoutingOption>>(`/masters/routings?styleId=${styleId}&active=true&limit=50`)
      .then((res) => {
        if (cancelled) return
        setRoutings(res.data)
        setRoutingPick((picked) => picked || res.data[0]?.id || '')
      })
      .catch(() => {
        if (!cancelled) setRoutings([])
      })
    return () => {
      cancelled = true
    }
  }, [open, step, styleId, frozen])

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

  // ── Materials ──────────────────────────────────────────────

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

  // ── Costing ────────────────────────────────────────────────

  // The material figure the server saved, once there is one: that is what the
  // costing is worked out against, not whatever is half-typed on step 1.
  const material = current?.totalCost != null ? Number(current.totalCost) : grandTotal
  const labourRows = costRows.filter((r) => r.kind === 'LABOUR')
  const overheadRows = costRows.filter((r) => r.kind === 'OVERHEAD')
  const labourCost = round(
    labourRows.reduce((sum, r) => sum + round(Number(r.value) || 0, 2), 0),
    2,
  )
  const overheadBase = round(material + labourCost, 2)
  const overheadOf = (r: EditCostRow) =>
    r.basis === 'PERCENT'
      ? round((overheadBase * (Number(r.value) || 0)) / 100, 2)
      : round(Number(r.value) || 0, 2)
  const overheadCost = round(
    overheadRows.reduce((sum, r) => sum + overheadOf(r), 0),
    2,
  )
  const liveCost = round(material + labourCost + overheadCost, 2)

  const setCostRow = (rowKey: number, patch: Partial<EditCostRow>) =>
    setCostRows((rows) => rows.map((r) => (r.rowKey === rowKey ? { ...r, ...patch } : r)))

  /** A new row directly below `after`, or at the end of its own kind when there is none. */
  const addCostRow = (kind: EditCostRow['kind'], after?: number) => {
    const row = emptyCostRow(kind)
    setAddedKey(row.rowKey)
    setCostRows((rows) => {
      const at = after !== undefined ? rows.findIndex((r) => r.rowKey === after) : -1
      if (at >= 0) return [...rows.slice(0, at + 1), row, ...rows.slice(at + 1)]
      // Labour rows come first in the list, so a new labour row goes after the
      // last of them rather than after the overheads.
      const lastOfKind = rows.map((r) => r.kind).lastIndexOf(kind)
      if (lastOfKind >= 0) return [...rows.slice(0, lastOfKind + 1), row, ...rows.slice(lastOfKind + 1)]
      return kind === 'LABOUR' ? [row, ...rows] : [...rows, row]
    })
  }

  const removeCostRow = (rowKey: number) =>
    setCostRows((rows) => rows.filter((r) => r.rowKey !== rowKey))

  /**
   * A routing's rated steps, as labour rows — a starting point, not a link.
   * The routings in the system so far carry demo rates, so they are copied in
   * to be checked and changed, never read live.
   */
  const fillFromRouting = () => {
    const routing = routings.find((r) => r.id === routingPick)
    if (!routing) return
    const rated = (routing.steps ?? []).filter((s) => Number(s.ratePerPiece ?? 0) > 0)
    if (rated.length === 0) {
      setError(`${routing.code} has no rates on its steps, so there is nothing to copy.`)
      return
    }
    if (
      labourRows.length > 0 &&
      !confirm(
        `Replace the ${labourRows.length} labour row${labourRows.length === 1 ? '' : 's'} here with the ${rated.length} rated step${rated.length === 1 ? '' : 's'} from ${routing.code}?`,
      )
    )
      return
    const filled: EditCostRow[] = rated.map((s) => ({
      rowKey: nextRowKey++,
      kind: 'LABOUR',
      name: s.operation?.name ?? 'Step',
      departmentId: s.department?.id ?? s.departmentId ?? '',
      basis: 'PER_PIECE',
      value: plain(s.ratePerPiece),
    }))
    setError(null)
    setCostRows((rows) => [...filled, ...rows.filter((r) => r.kind === 'OVERHEAD')])
  }

  // ── Pricing ────────────────────────────────────────────────

  const cost = Number(current?.costPerPiece ?? 0)
  const priceNum = Number(price)
  const hasPrice = price.trim() !== '' && priceNum > 0
  const profit = hasPrice ? round(priceNum - cost, 2) : null
  const withGst = hasPrice && gstRate !== null ? round(priceNum * (1 + gstRate / 100), 2) : null

  const typeMargin = (value: string) => {
    setMargin(value)
    setPriceSource('margin')
    const m = Number(value)
    if (value.trim() !== '' && m >= 0 && m < 100 && cost > 0) setPrice(String(priceFromMargin(cost, m)))
  }

  const typePrice = (value: string) => {
    setPrice(value)
    setPriceSource('price')
    const p = Number(value)
    if (value.trim() !== '' && p > 0 && cost > 0) setMargin(String(marginFromPrice(cost, p)))
  }

  // ── Saving ─────────────────────────────────────────────────

  /** One place for the spinner and for turning a refusal into words on screen. */
  const run = async (work: () => Promise<void>) => {
    setSaving(true)
    setError(null)
    setFieldErrors({})
    try {
      await work()
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

  const saveMaterials = (then: 'close' | 'next') => {
    // An approved BOM's components are locked, and the server refuses a save
    // that sends them at all — so only the note goes, which it does allow.
    if (frozen) {
      void run(async () => {
        const res = await api.patch<SaveResponse>(`/masters/bom/${current!.id}`, { notes })
        setCurrent(res.data)
        onSaved(res.message)
        onClose()
      })
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
      return
    }

    // Caught here as well as on the server, so the person is told before a
    // round trip rather than after it.
    if (!isEdit && styleColours.length > 0 && !color) {
      setError(
        `${style?.code ?? 'This style'} comes in ${styleColours.join(', ')}. Pick the colour this BOM is for — each colour has its own BOM.`,
      )
      return
    }

    // Version, routing, base size and whether it is offered are not sent. A new
    // BOM starts at version 1.0 with none of the others; an edit keeps whatever
    // it had. Later versions come from Copy on the BOM list.
    void run(async () => {
      const res = isEdit
        ? await api.patch<SaveResponse>(`/masters/bom/${current!.id}`, { notes, lines: payloadLines })
        : await api.post<SaveResponse>('/masters/bom', {
            styleId,
            color: color || null,
            notes,
            lines: payloadLines,
          })
      setCurrent(res.data)
      onSaved(res.message)
      if (then === 'close') {
        onClose()
        return
      }
      // A rate warning ("one component has no rate yet") is worth keeping in
      // view on the next step, where the cost it leaves out is being built.
      setNotice(res.message ?? null)
      setStep(2)
    })
  }

  const saveCosting = () => {
    // A row with nothing in it is left out quietly, as a blank material line is.
    const filled = costRows.filter((r) => r.name.trim() !== '' || r.value.trim() !== '')
    const nameless = filled.find((r) => r.name.trim() === '')
    if (nameless) {
      setError(
        `A ${nameless.kind === 'LABOUR' ? 'labour' : 'overhead'} row has an amount but no name. Name it, such as Stitching or Transport, or remove it.`,
      )
      return
    }
    const valueless = filled.find((r) => r.value.trim() === '' || Number(r.value) < 0)
    if (valueless) {
      setError(`"${valueless.name}" has no amount. Type what it costs for one piece, or remove it.`)
      return
    }
    const overPercent = filled.find((r) => r.kind === 'OVERHEAD' && r.basis === 'PERCENT' && Number(r.value) > 100)
    if (overPercent) {
      setError(`"${overPercent.name}" is more than 100%. Check the percentage.`)
      return
    }

    const payload = filled.map((r) => ({
      kind: r.kind,
      name: r.name.trim(),
      departmentId: r.departmentId || null,
      basis: r.kind === 'LABOUR' ? 'PER_PIECE' : r.basis,
      value: Number(r.value),
    }))

    void run(async () => {
      const res = await api.patch<SaveResponse>(`/masters/bom/${current!.id}`, { costLines: payload })
      setCurrent(res.data)
      onSaved(res.message)
      // A draft's price follows its margin, so the server may have moved it.
      setMargin(plain(res.data.marginPercent))
      setPrice(plain(res.data.sellingPrice))
      setPriceSource('margin')
      setNotice(null)
      setStep(3)
    })
  }

  const savePrice = () => {
    if (priceSource === 'margin') {
      const m = Number(margin)
      if (margin.trim() === '' || !(m >= 0 && m < 100)) {
        setError('Type a margin from 0 up to, but not including, 100%.')
        return
      }
    } else if (!hasPrice) {
      setError('Type a selling price above zero.')
      return
    }

    void run(async () => {
      const res = await api.patch<SaveResponse>(
        `/masters/bom/${current!.id}/price`,
        priceSource === 'margin' ? { marginPercent: Number(margin) } : { sellingPrice: priceNum },
      )
      setCurrent(res.data)
      onSaved(res.message)
      onClose()
    })
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (step === 1) {
      // An approver looking at an approved BOM just moves on: nothing on this
      // step can change except the notes, which have their own button.
      if (canCost && frozen) setStep(2)
      else saveMaterials(canCost ? 'next' : 'close')
    } else if (step === 2) {
      if (frozen) setStep(3)
      else saveCosting()
    } else savePrice()
  }

  const title = isEdit ? 'Edit Bill of Materials' : 'New Bill of Materials'
  // The version is not edited here, but an open BOM still says which one it is.
  const summary = [style?.code, color || null, current ? `v${current.version}` : null]
    .filter(Boolean)
    .join(' · ')
  const statusBadge = current ? (STATUS_BADGE[current.status] ?? STATUS_BADGE.DRAFT) : null

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
  /** A figure worked out, not typed: a box that looks like a field but takes no cursor. */
  const readout =
    'flex items-center justify-end gap-2 rounded-lg border border-border bg-secondary/60 px-3 py-2.5'

  /** The header of each panel: an icon tile, a title, and what the panel is for. */
  const panelHead = (Icon: LucideIcon, heading: React.ReactNode, sub: React.ReactNode, action?: React.ReactNode) => (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon size={16} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{heading}</h3>
          <p className="text-xs text-muted-foreground">{sub}</p>
        </div>
      </div>
      {action}
    </div>
  )

  /** The row buttons shared by the material and costing tables. */
  const rowButtons = (onAdd: () => void, onRemove: () => void, label: string) => (
    <div className="flex items-center justify-center gap-1.5">
      <button
        type="button"
        className={cn('btn-secondary text-primary', rowBtn)}
        disabled={frozen}
        title={`Add a ${label} below this one`}
        aria-label={`Add a ${label} below this one`}
        onClick={onAdd}
      >
        <Plus size={15} />
      </button>
      <button
        type="button"
        className={cn('btn-danger', rowBtn)}
        disabled={frozen}
        title={`Remove this ${label}`}
        aria-label={`Remove this ${label}`}
        onClick={onRemove}
      >
        <Trash2 size={15} />
      </button>
    </div>
  )

  /** Material + labour + overhead = cost, as the sum it is. */
  const buildUp = (m: number, l: number, o: number, total: number) => (
    <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
      <Term label="Material" amount={m} />
      <Operator icon={Plus} />
      <Term label="Labour" amount={l} />
      <Operator icon={Plus} />
      <Term label="Overhead" amount={o} />
      <Operator icon={Equal} />
      <Term label="Cost per piece" amount={total} strong />
    </div>
  )

  // ── Step 1: materials ──────────────────────────────────────

  const materialsStep = (
    <>
      <section className={panel} aria-label="BOM details">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="form-label" htmlFor="bom-style">
              Style<span className="ml-0.5 text-red-400">*</span>
            </label>
            <SmartSelect
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
            </SmartSelect>
            {fieldErrors.styleId && <p className="mt-1 text-xs text-red-400">{fieldErrors.styleId}</p>}
          </div>

          <div>
            <label className="form-label" htmlFor="bom-colour">
              Colour
              {styleColours.length > 0 && <span className="ml-0.5 text-red-400">*</span>}
            </label>
            <SmartSelect
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
            </SmartSelect>
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
        {panelHead(
          Layers,
          <>
            Components
            {filledLines > 0 && <span className="ml-1.5 font-normal text-muted-foreground">({filledLines})</span>}
          </>,
          <>
            Everything one piece uses. A blank rate uses the item&apos;s standard rate, shown as
            &ldquo;std&rdquo; in the box; an amber outline marks what a line still needs.
          </>,
        )}

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
                        <SmartSelect
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
                        </SmartSelect>
                      </div>
                    </td>
                    <td className="px-2 py-2 align-middle">
                      <SmartSelect
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
                      </SmartSelect>
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
                          className={cn(field, 'pl-7 text-right tabular-nums', p.needsRate && 'border-accent')}
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
                      <div className={readout}>
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
                      {rowButtons(
                        () => addLineAfter(index),
                        () => removeLine(index),
                        'component',
                      )}
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
        <label className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground" htmlFor="bom-notes">
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
    </>
  )

  // ── Step 2: costing ────────────────────────────────────────

  const costTable = (kind: EditCostRow['kind']) => {
    const rows = kind === 'LABOUR' ? labourRows : overheadRows
    const label = kind === 'LABOUR' ? 'labour row' : 'overhead'
    const columns = kind === 'LABOUR' ? 4 : 5

    return (
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[720px] table-fixed text-sm">
          <colgroup>
            <col />
            {kind === 'LABOUR' ? <col className="w-56" /> : <col className="w-60" />}
            <col className="w-36" />
            {kind === 'OVERHEAD' && <col className="w-32" />}
            <col className="w-28" />
          </colgroup>
          <thead className="bg-secondary/60">
            <tr className="border-b border-border">
              <th className={cn(th, 'pl-3 text-left')}>{kind === 'LABOUR' ? 'Work' : 'Overhead'}</th>
              <th className={cn(th, 'text-left')}>{kind === 'LABOUR' ? 'Department' : 'Charged as'}</th>
              <th className={cn(th, 'text-right')}>{kind === 'LABOUR' ? 'Paid / pc' : 'Amount'}</th>
              {kind === 'OVERHEAD' && (
                <th className={cn(th, 'text-right')}>
                  Cost <span className="font-medium normal-case tracking-normal">(₹ / pc)</span>
                </th>
              )}
              <th className={cn(th, 'pr-3 text-center')}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns} className="px-3 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      {kind === 'LABOUR'
                        ? frozen
                          ? 'No labour was entered before this BOM was approved.'
                          : 'No labour yet. Add what one piece pays for cutting, stitching, kaj button, finishing and packing.'
                        : frozen
                          ? 'No overheads were entered before this BOM was approved.'
                          : 'No overheads yet. Add power, rent or transport, in rupees or as a percentage.'}
                    </p>
                    {!frozen && (
                      <button type="button" className="btn-secondary" onClick={() => addCostRow(kind)}>
                        <Plus size={15} />
                        {kind === 'LABOUR' ? 'Add labour' : 'Add overhead'}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.rowKey} className="border-b border-border/50">
                <td className="py-2 pl-3 pr-2 align-middle">
                  <input
                    className={field}
                    value={row.name}
                    disabled={frozen}
                    autoFocus={row.rowKey === addedKey}
                    placeholder={kind === 'LABOUR' ? 'e.g. Stitching' : 'e.g. Factory overhead'}
                    aria-label={`${kind === 'LABOUR' ? 'Labour' : 'Overhead'} name`}
                    onChange={(e) => setCostRow(row.rowKey, { name: e.target.value })}
                  />
                </td>
                <td className="px-2 py-2 align-middle">
                  {kind === 'LABOUR' ? (
                    <SmartSelect
                      className={field}
                      value={row.departmentId}
                      disabled={frozen}
                      aria-label={`Department for ${row.name || 'this labour row'}`}
                      onChange={(e) => setCostRow(row.rowKey, { departmentId: e.target.value })}
                    >
                      <option value="">Not set</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </SmartSelect>
                  ) : (
                    <SmartSelect
                      className={field}
                      value={row.basis}
                      disabled={frozen}
                      aria-label={`How ${row.name || 'this overhead'} is charged`}
                      onChange={(e) =>
                        setCostRow(row.rowKey, { basis: e.target.value as EditCostRow['basis'] })
                      }
                    >
                      <option value="PER_PIECE">Rupees per piece</option>
                      <option value="PERCENT">% of material + labour</option>
                    </SmartSelect>
                  )}
                </td>
                <td className="px-2 py-2 align-middle">
                  <div className="relative">
                    {row.basis === 'PER_PIECE' && (
                      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                        ₹
                      </span>
                    )}
                    <input
                      type="number"
                      step="any"
                      min="0"
                      max={row.basis === 'PERCENT' ? 100 : undefined}
                      inputMode="decimal"
                      className={cn(
                        field,
                        'text-right tabular-nums',
                        row.basis === 'PER_PIECE' ? 'pl-7' : 'pr-8',
                      )}
                      value={row.value}
                      disabled={frozen}
                      aria-label={`${row.name || label} amount`}
                      onChange={(e) => setCostRow(row.rowKey, { value: e.target.value })}
                    />
                    {row.basis === 'PERCENT' && (
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                        %
                      </span>
                    )}
                  </div>
                </td>
                {kind === 'OVERHEAD' && (
                  <td className="px-2 py-2 align-middle">
                    <div className={readout}>
                      <span className="whitespace-nowrap font-mono text-sm font-semibold text-foreground">
                        {row.value.trim() !== '' ? formatRupees(overheadOf(row)) : '—'}
                      </span>
                    </div>
                  </td>
                )}
                <td className="py-2 pl-2 pr-3 align-middle">
                  {rowButtons(
                    () => addCostRow(kind, row.rowKey),
                    () => removeCostRow(row.rowKey),
                    label,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="bg-primary/5">
                <td colSpan={columns - 2} className="py-3 pl-3 pr-2 text-right text-sm font-medium text-primary">
                  {kind === 'LABOUR' ? 'Labour per piece' : 'Overhead per piece'}
                </td>
                <td className="whitespace-nowrap py-3 pl-2 pr-5 text-right font-mono text-base font-bold text-primary">
                  {formatRupees(kind === 'LABOUR' ? labourCost : overheadCost)}
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    )
  }

  const selectedRouting = routings.find((r) => r.id === routingPick)
  const fillAction =
    !frozen && routings.length > 0 ? (
      <div className="flex flex-wrap items-center gap-2">
        {routings.length > 1 && (
          <SmartSelect
            className={cn(field, 'h-9 w-56')}
            value={routingPick}
            aria-label="Routing to fill labour from"
            onChange={(e) => setRoutingPick(e.target.value)}
          >
            {routings.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} — {r.name}
              </option>
            ))}
          </SmartSelect>
        )}
        <button type="button" className="btn-secondary" onClick={fillFromRouting}>
          Fill from {routings.length === 1 && selectedRouting ? selectedRouting.code : 'routing'}
        </button>
      </div>
    ) : undefined

  const costingStep = (
    <>
      <section className={cn(panel, 'space-y-3')}>
        {panelHead(
          Users,
          'Labour',
          'What one piece pays the people who make it, in rupees — in-house lines and outside job workers alike.',
          fillAction,
        )}
        {costTable('LABOUR')}
      </section>

      <section className={cn(panel, 'space-y-3')}>
        {panelHead(
          Factory,
          'Overheads',
          'Everything else one piece has to carry — power, rent, transport. Type rupees, or a percentage of material and labour together.',
        )}
        {costTable('OVERHEAD')}
      </section>

      <section className={cn(panel, 'space-y-3')}>
        {panelHead(
          IndianRupee,
          'Cost of one piece',
          'Material from the first step, with the labour and overheads above.',
        )}
        {buildUp(material, labourCost, overheadCost, liveCost)}
      </section>
    </>
  )

  // ── Step 3: pricing ────────────────────────────────────────

  const pricingStep =
    cost <= 0 ? (
      <div className="flex items-start gap-3 rounded-lg border border-accent/40 bg-accent/5 p-3">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
        <p className="text-sm text-foreground">
          This BOM has no cost yet, so there is nothing to price. Go back and enter its materials and
          costing first.
        </p>
      </div>
    ) : (
      <>
        <section className={cn(panel, 'space-y-3')}>
          {panelHead(Layers, 'Cost of one piece', 'As saved on the costing step.')}
          {buildUp(
            Number(current?.totalCost ?? 0),
            Number(current?.labourCost ?? 0),
            Number(current?.overheadCost ?? 0),
            cost,
          )}
        </section>

        <section className={cn(panel, 'space-y-4')}>
          {panelHead(
            IndianRupee,
            'Selling price',
            'Type a margin and the price is worked out, or type the price and the margin is worked back. The margin is a share of the selling price — at 20%, the price is the cost ÷ 0.80. Prices are before GST, rounded up to the rupee.',
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="form-label" htmlFor="bom-margin">
                Margin
              </label>
              <div className="relative">
                <input
                  id="bom-margin"
                  type="number"
                  step="any"
                  min="0"
                  max="99.99"
                  inputMode="decimal"
                  className={cn(field, 'pr-8 text-right tabular-nums')}
                  value={margin}
                  placeholder="e.g. 20"
                  onChange={(e) => typeMargin(e.target.value)}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                  %
                </span>
              </div>
            </div>

            <div>
              <label className="form-label" htmlFor="bom-price">
                Selling price per piece
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                  ₹
                </span>
                <input
                  id="bom-price"
                  type="number"
                  step="any"
                  min="0"
                  inputMode="decimal"
                  className={cn(field, 'pl-7 text-right font-semibold tabular-nums')}
                  value={price}
                  onChange={(e) => typePrice(e.target.value)}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card px-4 py-2.5">
              <p className="text-xs text-muted-foreground">Profit per piece</p>
              <p
                className={cn(
                  'font-mono text-lg font-bold',
                  profit !== null && profit < 0 ? 'text-red-400' : 'text-primary',
                )}
              >
                {profit !== null ? formatRupees(profit) : '—'}
              </p>
              {withGst !== null && (
                <p className="text-xs text-muted-foreground">
                  {formatRupees(withGst)} with {gstRate}% GST
                </p>
              )}
            </div>
          </div>

          {profit !== null && profit < 0 && (
            <p className="text-xs text-red-400">
              This price is below the cost: every piece sold loses {formatRupees(-profit)}.
            </p>
          )}

          <div className="space-y-1 text-xs text-muted-foreground">
            {frozen && (
              <p>
                The cost is locked because this BOM is approved. The price stays open, and every
                change is kept in the log.
              </p>
            )}
            {current?.pricedBy && (
              <p>
                Last priced by <span className="text-foreground">{current.pricedBy.name}</span>
                {current.pricedAt && ` on ${formatDate(current.pricedAt)}`}.
              </p>
            )}
          </div>
        </section>
      </>
    )

  // ── Frame ──────────────────────────────────────────────────

  const footerFigure =
    step === 1
      ? { label: 'Material per piece', amount: grandTotal }
      : step === 2
        ? { label: 'Cost per piece', amount: liveCost }
        : { label: 'Selling price', amount: hasPrice ? priceNum : null }

  const primaryLabel =
    step === 1
      ? !canCost
        ? isEdit
          ? frozen
            ? 'Save notes'
            : 'Save changes'
          : 'Create BOM'
        : frozen
          ? 'Next'
          : 'Save and continue'
      : step === 2
        ? frozen
          ? 'Next'
          : 'Save and continue'
        : 'Save price'
  const primaryMoves = primaryLabel === 'Next' || primaryLabel === 'Save and continue'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      {/*
        Solid rather than see-through glass: the form's panels are tinted, and
        over a dimmed page the glass turned the whole body the same grey.
      */}
      <div className="glass-card w-full max-w-7xl my-auto bg-card" role="dialog" aria-modal="true" aria-label={title}>
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
            {/* Where the person is. Not clickable: each step saves on the way out. */}
            {canCost && (
              <ol className="flex flex-wrap items-center gap-2" aria-label="Steps">
                {STEPS.map((s, i) => {
                  const done = step > s.id
                  const active = step === s.id
                  return (
                    <Fragment key={s.id}>
                      {i > 0 && <li aria-hidden="true" className="h-px w-8 bg-border" />}
                      <li
                        aria-current={active ? 'step' : undefined}
                        className={cn(
                          'flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm',
                          active
                            ? 'bg-primary/10 font-semibold text-primary'
                            : done
                              ? 'text-foreground'
                              : 'text-muted-foreground',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-6 w-6 items-center justify-center rounded-full border text-xs',
                            active
                              ? 'border-primary bg-primary text-primary-foreground'
                              : done
                                ? 'border-primary/40 bg-primary/10 text-primary'
                                : 'border-border',
                          )}
                        >
                          {done ? <Check size={13} /> : s.id}
                        </span>
                        {s.label}
                      </li>
                    </Fragment>
                  )
                })}
              </ol>
            )}

            {frozen && step !== 3 && (
              <div className="flex items-start gap-3 rounded-lg border border-accent/40 bg-accent/5 p-3">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
                <p className="text-sm text-foreground">
                  This BOM is approved, so its components and costing cannot be changed — only the
                  notes{canCost ? ' and the price' : ''}. Copy it to a new version, or to another
                  colour, from the BOM list instead.
                </p>
              </div>
            )}

            {notice && (
              <div className="flex items-start gap-3 rounded-lg border border-accent/40 bg-accent/5 p-3">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
                <p className="text-sm text-foreground">{notice}</p>
              </div>
            )}

            {step === 1 && materialsStep}
            {step === 2 && costingStep}
            {step === 3 && pricingStep}
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
                {step === 1 &&
                  !frozen &&
                  [
                    missingQty > 0 &&
                      `${missingQty} line${missingQty === 1 ? ' needs' : 's need'} a quantity`,
                    missingProcess > 0 && `${missingProcess} without a process`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <div className="mr-2 text-right">
                  <p className="text-xs text-muted-foreground">{footerFigure.label}</p>
                  <p className="font-mono text-sm font-bold text-foreground">
                    {footerFigure.amount !== null ? formatRupees(footerFigure.amount) : '—'}
                  </p>
                </div>

                {step === 1 ? (
                  <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setError(null)
                      setStep((step - 1) as Step)
                    }}
                    className="btn-secondary"
                    disabled={saving}
                  >
                    <ArrowLeft size={15} />
                    Back
                  </button>
                )}

                {/* An approver on an approved BOM can still correct its notes. */}
                {step === 1 && canCost && frozen && (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={saving}
                    onClick={() => saveMaterials('close')}
                  >
                    <Save size={15} />
                    Save notes
                  </button>
                )}

                <button
                  type="submit"
                  className="btn-primary"
                  disabled={saving || (step === 3 && cost <= 0)}
                >
                  {saving ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : primaryMoves ? null : (
                    <Save size={15} />
                  )}
                  {primaryLabel}
                  {!saving && primaryMoves && <ArrowRight size={15} />}
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

/** One figure in the "material + labour + overhead = cost" sum. */
function Term({ label, amount, strong }: { label: string; amount: number; strong?: boolean }) {
  return (
    <div
      className={cn(
        'flex-1 rounded-lg border px-4 py-3',
        strong ? 'border-primary/30 bg-primary/5' : 'border-border bg-card',
      )}
    >
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('mt-1 font-mono text-lg font-bold', strong ? 'text-primary' : 'text-foreground')}>
        {formatRupees(amount)}
      </p>
    </div>
  )
}

function Operator({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex items-center justify-center text-muted-foreground" aria-hidden="true">
      <Icon size={16} />
    </span>
  )
}
