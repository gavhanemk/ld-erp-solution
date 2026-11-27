'use client'

import { useQtyRules } from '@/lib/qtyRules'
import { newRequestId } from '@/lib/utils'
import { QtyProblem } from '@/components/ui/QtyProblem'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Loader2,
  Plus,
  Trash2,
  Copy,
  Package,
  PackagePlus,
  ClipboardCheck,
  ArrowRightLeft,
  Warehouse,
  Truck,
  Tags,
} from 'lucide-react'
import { api, apiErrorMessage, masterResource } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

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
 *   stockin    quantity + rate   what came in without a purchase order
 *
 * The count asks for what was counted, never for a plus-or-minus figure. A
 * store keeper working out "I have 40 more than the book, so +40" is a store
 * keeper who will one day type −40.
 *
 * A count or a move also says whose stock each line is — ours, or a
 * customer's cloth held in our store — and its size for a sized garment. The
 * choices are what the store actually holds, so a customer's leftover fabric
 * is moved or counted as theirs and never taken for ours. A count goes to a
 * store manager; stock changes once it is approved.
 */

export type MoveMode = 'opening' | 'count' | 'transfer' | 'stockin'

/** Where stock that came in without a purchase order came from. */
const SOURCES = [
  ['SAMPLE', 'Sample'],
  ['OTHER_UNIT', 'From another unit'],
  ['SUPPLIER_REPLACEMENT', "Supplier's replacement"],
  ['FREE_GOODS', 'Free goods'],
  ['FOUND', 'Found in store'],
  ['OTHER', 'Other'],
] as const

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
  /** TRANSIT: where goods wait on the road. Never picked as a store here. */
  kind?: string
}

/** How a transfer travels: straight there, or on the road until the other store receives it. */
type Goes = 'DIRECT' | 'IN_TRANSIT'

interface Line {
  itemId: string
  qty: string
  rate: string
  /** Whose stock, which size and which grade: "OWNED||" for our own, unsized, good. */
  whose: string
  /** Garment tags moving with the pieces, scanned or picked: one per piece. */
  tags: string[]
}

/** One balance's garment tags in the store: what is held, how much of it is tagged, the tags free to move. */
interface TagInfo {
  held: number
  tagged: number
  untagged: number
  codes: string[]
}

/** A scanner types a code and Enter; typed by hand they may be spaced or comma separated. */
const splitCodes = (text: string) => [...new Set(text.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))]

/** One balance a store holds: an item, whose it is, its size and its grade. */
interface Held {
  itemId: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId: string | null
  ownerName: string | null
  sizeId: string | null
  sizeCode: string | null
  /** A good, B seconds, R held or rejected. */
  grade?: string
  qty: number
}

/** How a grade reads beside its balance: nothing for good stock. */
const GRADE_WORDS: Record<string, string> = { B: 'B-grade', R: 'rejected' }

const OURS = 'OWNED||'
// Good stock keeps the key it always had; another grade adds itself on the end.
const heldKey = (h: Pick<Held, 'ownership' | 'ownerCustomerId' | 'sizeId' | 'grade'>) =>
  `${h.ownership}|${h.ownerCustomerId ?? ''}|${h.sizeId ?? ''}${h.grade && h.grade !== 'A' ? `|${h.grade}` : ''}`
const parseWhose = (k: string) => {
  const [ownership, ownerCustomerId, sizeId, grade] = k.split('|')
  return {
    ownership: (ownership || 'OWNED') as 'OWNED' | 'CUSTOMER_OWNED',
    ownerCustomerId: ownerCustomerId || null,
    sizeId: sizeId || null,
    grade: (grade || 'A') as 'A' | 'B' | 'R',
  }
}

const emptyLine = (): Line => ({ itemId: '', qty: '', rate: '', whose: OURS, tags: [] })

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
      'Type what you counted on the rack. The difference against the book is worked out here; a store manager approves it before stock changes.',
    qtyLabel: 'Counted',
    action: 'Save the count',
  },
  stockin: {
    title: 'Stock in',
    blurb:
      'Stock that came in without a purchase order — a sample, material from another unit, a supplier\'s replacement. A store manager approves it before stock goes up.',
    qtyLabel: 'Quantity',
    action: 'Send for approval',
  },
  transfer: {
    title: 'Move stock',
    blurb:
      'Between two of our own stores. What it is worth and whose it is travel with it — a customer\'s cloth stays theirs. Send it in transit when the other store should confirm what arrives.',
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
  /** `data` is the saved document, as the server returned it. */
  onSaved: (message: string, data?: unknown) => void
}) {
  const copy = COPY[mode]

  const [items, setItems] = useState<ItemOption[]>([])
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([])
  const [loadingLists, setLoadingLists] = useState(true)

  const [warehouseId, setWarehouseId] = useState('')
  const [toWarehouseId, setToWarehouseId] = useState('')
  const [goes, setGoes] = useState<Goes>('DIRECT')
  const [transitId, setTransitId] = useState('')
  const [reason, setReason] = useState('')
  const [source, setSource] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([emptyLine()])

  const [saving, setSaving] = useState(false)
  const qtyRules = useQtyRules()
  const [error, setError] = useState<string | null>(null)
  // What the chosen store holds, by item, owner and size.
  const [held, setHeld] = useState<Held[]>([])
  // One id for this form until it saves: a double click or a retry reaches
  // the server as the same request and saves the document once.
  const requestId = useRef(newRequestId())
  // Each balance's garment tags in the store a move leaves, by store, item and whose.
  const [tagInfo, setTagInfo] = useState<Record<string, TagInfo>>({})
  const [scanText, setScanText] = useState<Record<number, string>>({})
  const [picking, setPicking] = useState<number | null>(null)
  const tagKey = (l: Line) => `${warehouseId}|${l.itemId}|${l.whose}`

  useEffect(() => {
    if (mode === 'opening' || mode === 'stockin' || !warehouseId) {
      setHeld([])
      return
    }
    let cancelled = false
    api
      .get<{ data: Held[] }>(`/inventory/held?warehouseId=${warehouseId}&grades=all`)
      .then((res) => {
        if (cancelled) return
        setHeld(res.data)
        // A line whose item the store holds only as one customer's (or one
        // size) starts on that, rather than on "ours" with nothing there.
        setLines((ls) =>
          ls.map((l) => {
            const choices = res.data.filter((h) => h.itemId === l.itemId)
            if (!l.itemId || choices.some((h) => heldKey(h) === l.whose)) return l
            return { ...l, whose: choices.length === 1 ? heldKey(choices[0]) : OURS }
          })
        )
      })
      .catch(() => {
        if (!cancelled) setHeld([])
      })
    return () => {
      cancelled = true
    }
  }, [mode, warehouseId])

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
        // removes a click without ever choosing wrongly. A transit store is
        // never one of them: goods wait there only on their own transfer.
        const real = w.data.filter((x) => x.kind !== 'TRANSIT')
        if (real.length === 1) setWarehouseId(real[0].id)
        const via = w.data.filter((x) => x.kind === 'TRANSIT')
        if (via.length === 1) setTransitId(via[0].id)
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

  // A move of tagged garments names its tags: what the store holds tagged, for each line's stock.
  useEffect(() => {
    if (mode !== 'transfer' || !warehouseId) return
    const wanted = lines.filter((l) => l.itemId && !(tagKey(l) in tagInfo))
    if (!wanted.length) return
    let cancelled = false
    void Promise.all(
      wanted.map(async (l) => {
        const w = parseWhose(l.whose)
        const qs = new URLSearchParams({ warehouseId, itemId: l.itemId, grade: w.grade, ownership: w.ownership })
        if (w.sizeId) qs.set('sizeId', w.sizeId)
        if (w.ownerCustomerId) qs.set('ownerCustomerId', w.ownerCustomerId)
        try {
          const r = await api.get<{ data: TagInfo }>(`/inventory/tags?${qs}`)
          return [tagKey(l), r.data] as const
        } catch {
          return [tagKey(l), { held: 0, tagged: 0, untagged: 0, codes: [] }] as const
        }
      }),
    ).then((got) => {
      if (!cancelled) setTagInfo((t) => ({ ...t, ...Object.fromEntries(got) }))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, warehouseId, lines])

  /** How many of a line's pieces must be named by tag: beyond what the store holds untagged. */
  const tagsNeeded = (l: Line) => {
    const info = tagInfo[tagKey(l)]
    if (!info || !info.tagged) return 0
    return Math.max(0, Math.round(Number(l.qty) || 0) - info.untagged)
  }
  const stores = useMemo(() => warehouses.filter((w) => w.kind !== 'TRANSIT'), [warehouses])
  const transitStores = useMemo(() => warehouses.filter((w) => w.kind === 'TRANSIT'), [warehouses])
  const onTheRoad = mode === 'transfer' && goes === 'IN_TRANSIT'

  const setLine = (index: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  const addLine = () => setLines((prev) => [...prev, emptyLine()])
  const removeLine = (index: number) =>
    setLines((prev) => (prev.length === 1 ? [emptyLine()] : prev.filter((_, i) => i !== index)))
  /** A copy of a line, put just under it. */
  const copyLine = (index: number) =>
    setLines((prev) => (prev[index] ? [...prev.slice(0, index + 1), { ...prev[index] }, ...prev.slice(index + 1)] : prev))

  const filled = lines.filter((l) => l.itemId && l.qty !== '')

  const save = async () => {
    setError(null)

    if (!warehouseId) return setError('Choose a store.')
    if (mode === 'transfer' && !toWarehouseId) return setError('Choose where it is going.')
    if (mode === 'transfer' && warehouseId === toWarehouseId) {
      return setError('The two stores are the same, so nothing would move.')
    }
    if (onTheRoad && !transitStores.length) {
      return setError('There is no transit store yet. Add one in Masters → Warehouses with the kind "In transit", or send it straight there.')
    }
    if (onTheRoad && !transitId) return setError('Choose the transit store it goes through.')
    if (mode === 'stockin' && !source) return setError('Say where it came from.')
    if (mode === 'stockin' && source === 'OTHER' && notes.trim().length < 5) {
      return setError('Say where it came from in the note, in a few words.')
    }
    if (mode === 'count' && reason.trim().length < 5) {
      return setError('Say why the figure is being changed — one line is enough.')
    }
    if (filled.length === 0) return setError('Add at least one item with a quantity.')
    if (mode === 'transfer') {
      const short = filled.findIndex((l) => l.tags.length < tagsNeeded(l))
      if (short >= 0) {
        const l = filled[short]
        return setError(`${itemsById.get(l.itemId)?.name ?? 'A line'}: name ${tagsNeeded(l) - l.tags.length} more of its pieces by their tags — scan them or pick them from the store.`)
      }
    }
    // 2.5 cartons (or 0.6 counted): said under its box, and again here.
    const half = filled.find((l) => qtyRules.placesProblem(l.qty, itemsById.get(l.itemId)))
    if (half) return setError(`${itemsById.get(half.itemId)?.name ?? 'An item'}: ${qtyRules.placesProblem(half.qty, itemsById.get(half.itemId))}`)
    // A count or an opening sets each line against the book once, so an item
    // entered on two lines would be applied twice. Moves may repeat an item.
    if (mode !== 'transfer') {
      const keys = filled.map((l) => `${l.itemId}|${l.whose}`)
      const twice = filled.find((l, i) => keys.indexOf(`${l.itemId}|${l.whose}`) !== i)
      if (twice) {
        return setError(
          `${itemsById.get(twice.itemId)?.name ?? 'An item'} is on the list twice for the same stock. Enter it once, with the total.`,
        )
      }
    }

    // Opening stock comes in at a rate or it is worth nothing. An empty box
    // used to go through as ₹0 without a word. So does a stock-in.
    if (mode === 'opening' || mode === 'stockin') {
      const unpriced = filled.find((l) => !(Number(l.rate) > 0))
      if (unpriced) {
        const it = itemsById.get(unpriced.itemId)
        return setError(
          `Enter a rate for ${it?.name ?? 'every item'}: what one ${it?.uom?.symbol ?? 'unit'} cost. At ₹0 the stock would be valued at nothing.`,
        )
      }
    }
    if (mode === 'count') {
      const zero = filled.find((l) => parseWhose(l.whose).ownership === 'OWNED' && l.rate !== '' && !(Number(l.rate) > 0))
      if (zero) {
        return setError(
          `${itemsById.get(zero.itemId)?.name ?? 'An item'}: a rate of ₹0 would value the stock found at nothing. Enter what it cost, or leave the rate empty.`,
        )
      }
    }

    setSaving(true)
    try {
      let res: { message?: string; data?: unknown }

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
      } else if (mode === 'stockin') {
        res = await api.post('/inventory/stock-in', {
          requestId: requestId.current,
          warehouseId,
          source,
          notes: notes || null,
          lines: filled.map((l) => ({ itemId: l.itemId, qty: Number(l.qty), unitRate: Number(l.rate) })),
        })
      } else if (mode === 'count') {
        res = await api.post('/inventory/adjustments', {
          requestId: requestId.current,
          warehouseId,
          reason: reason.trim(),
          lines: filled.map((l) => ({
            itemId: l.itemId,
            countedQty: Number(l.qty),
            ...parseWhose(l.whose),
            // A customer's cloth carries no value of ours, so no rate goes with it.
            ...(l.rate && parseWhose(l.whose).ownership === 'OWNED' ? { unitRate: Number(l.rate) } : {}),
          })),
        })
      } else {
        res = await api.post('/inventory/transfers', {
          requestId: requestId.current,
          fromWarehouseId: warehouseId,
          toWarehouseId,
          mode: goes,
          transitWarehouseId: onTheRoad ? transitId : null,
          notes: notes || null,
          lines: filled.map((l) => ({ itemId: l.itemId, qty: Number(l.qty), ...parseWhose(l.whose), ...(l.tags.length ? { garmentCodes: l.tags } : {}) })),
        })
      }

      requestId.current = newRequestId()
      onSaved(res.message ?? 'Saved.', res.data)
    } catch (err) {
      setError(apiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const Icon = mode === 'opening' || mode === 'stockin' ? PackagePlus : mode === 'count' ? ClipboardCheck : ArrowRightLeft

  const primary = (
    <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : onTheRoad ? <Truck size={15} /> : <Icon size={15} />}
      {onTheRoad ? 'Send it' : copy.action}
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
            <SmartSelect
              className="form-input"
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              disabled={loadingLists}
              autoFocus
            >
              <option value="">{loadingLists ? 'Loading...' : 'Choose a store...'}</option>
              {stores.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </SmartSelect>
          </label>

          {mode === 'transfer' && (
            <label className="block min-w-0">
              <span className="form-label">
                Send it to<span className="ml-0.5 text-red-500">*</span>
              </span>
              <SmartSelect
                className="form-input"
                value={toWarehouseId}
                onChange={(e) => setToWarehouseId(e.target.value)}
                disabled={loadingLists}
              >
                <option value="">{loadingLists ? 'Loading...' : 'Choose a store...'}</option>
                {stores
                  .filter((w) => w.id !== warehouseId)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
              </SmartSelect>
            </label>
          )}

          {mode === 'transfer' && (
            <div className="block min-w-0 sm:col-span-2">
              <span className="form-label">How it goes</span>
              <div className="flex flex-wrap items-center gap-3">
                <div className="border-border bg-secondary flex gap-1 rounded-lg border p-1" role="radiogroup" aria-label="How it goes">
                  {(
                    [
                      ['DIRECT', 'Straight there'],
                      ['IN_TRANSIT', 'In transit'],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={goes === k}
                      className={
                        goes === k
                          ? 'bg-primary text-primary-foreground rounded-lg px-3 py-1 text-xs font-semibold'
                          : 'text-muted-foreground rounded-lg px-3 py-1 text-xs'
                      }
                      onClick={() => setGoes(k)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {onTheRoad &&
                  (transitStores.length === 0 ? (
                    <span className="text-xs text-amber-500">
                      No transit store yet: add one in Masters → Warehouses with the kind “In transit”.
                    </span>
                  ) : transitStores.length === 1 ? (
                    <span className="text-muted-foreground text-xs">Through {transitStores[0].name}</span>
                  ) : (
                    <SmartSelect
                      className="form-input h-9 max-w-xs"
                      value={transitId}
                      onChange={(e) => setTransitId(e.target.value)}
                      aria-label="Transit store it goes through"
                    >
                      <option value="">Goes through...</option>
                      {transitStores.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </SmartSelect>
                  ))}
              </div>
              <p className="text-muted-foreground mt-1 text-[11px]">
                {onTheRoad
                  ? 'It leaves now and waits in transit, still whoever’s it was and at what it left at. The other store receives what arrives — all, part, or damaged — from Stock Documents → Transfers.'
                  : 'Out of one store and into the other in one go.'}
              </p>
            </div>
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

          {mode === 'stockin' && (
            <label className="block min-w-0">
              <span className="form-label">
                Came from<span className="ml-0.5 text-red-500">*</span>
              </span>
              <SmartSelect className="form-input" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Choose where it came from...</option>
                {SOURCES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </SmartSelect>
            </label>
          )}

          {mode !== 'count' && (
            <label className={`block min-w-0 ${mode === 'transfer' || mode === 'stockin' ? 'sm:col-span-2' : ''}`}>
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
          <button
            type="button"
            className="btn-secondary h-8 px-3 text-xs"
            onClick={addLine}
            data-grid-add
            aria-keyshortcuts="Alt+A"
            title="Add another item (Alt+A)"
          >
            <Plus size={14} /> Add another item
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="line-table w-full min-w-[760px] text-sm">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th style={{ width: mode === 'opening' || mode === 'stockin' ? '50%' : '36%' }}>Item</th>
                {mode !== 'opening' && mode !== 'stockin' && <th style={{ width: '26%' }}>Stock</th>}
                <th style={{ textAlign: 'right' }}>{copy.qtyLabel}</th>
                {mode !== 'transfer' && <th style={{ textAlign: 'right' }}>Rate ₹</th>}
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody data-grid>
              {lines.map((line, i) => {
                const item = itemsById.get(line.itemId)
                const choices = held.filter((h) => h.itemId === line.itemId)
                const ours = choices.find((h) => heldKey(h) === OURS)
                const customers = parseWhose(line.whose).ownership === 'CUSTOMER_OWNED'
                const info = mode === 'transfer' && line.itemId ? tagInfo[tagKey(line)] : undefined
                const need = tagsNeeded(line)
                return (
                  <Fragment key={i}>
                  <tr data-grid-row>
                    <td className="text-muted-foreground px-3 py-2 text-xs">{i + 1}</td>
                    <td className="px-3 py-2">
                      <SmartSelect
                        className="form-input h-9"
                        value={line.itemId}
                        onChange={(e) => {
                          const picked = itemsById.get(e.target.value)
                          const offered = held.filter((h) => h.itemId === e.target.value)
                          setLine(i, {
                            itemId: e.target.value,
                            tags: [],
                            // Held only as one customer's, or one size: start on that.
                            whose: offered.length === 1 ? heldKey(offered[0]) : OURS,
                            // The item's standard rate is a starting point for
                            // an opening balance, not for a count — a count
                            // priced at the list rate would quietly revalue
                            // stock that is already carried at something else.
                            rate:
                              (mode === 'opening' || mode === 'stockin') && picked?.standardRate != null
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
                      </SmartSelect>
                    </td>
                    {mode !== 'opening' && mode !== 'stockin' && (
                      <td className="px-3 py-2">
                        <SmartSelect
                          className="form-input h-9"
                          value={line.whose}
                          onChange={(e) => setLine(i, { whose: e.target.value, tags: [] })}
                          disabled={!line.itemId}
                          aria-label={`Whose stock on line ${i + 1}`}
                        >
                          {!ours && (
                            <option value={OURS}>
                              Ours{warehouseId && line.itemId ? ' · none here' : ''}
                            </option>
                          )}
                          {choices.map((h) => (
                            <option key={heldKey(h)} value={heldKey(h)}>
                              {h.ownership === 'CUSTOMER_OWNED' ? `${h.ownerName ?? 'Customer'}'s` : 'Ours'}
                              {h.sizeCode ? ` · size ${h.sizeCode}` : ''}
                              {h.grade && GRADE_WORDS[h.grade] ? ` · ${GRADE_WORDS[h.grade]}` : ''} · {h.qty.toLocaleString('en-IN')} {item?.uom?.symbol ?? ''}
                            </option>
                          ))}
                        </SmartSelect>
                      </td>
                    )}
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <StepInput
                          decimals
                          className="form-input h-9 w-28 text-right tabular-nums"
                          value={line.qty}
                          onValueChange={(v) => setLine(i, { qty: v })}
                          aria-label={`${copy.qtyLabel} on line ${i + 1}`}
                          aria-invalid={!!qtyRules.placesProblem(line.qty, item)}
                        />
                        <span className="text-muted-foreground w-8 text-left text-xs">
                          {item?.uom?.symbol ?? ''}
                        </span>
                      </div>
                      <QtyProblem className="ml-auto max-w-[14rem] text-right" text={qtyRules.placesProblem(line.qty, item)} />
                    </td>
                    {mode !== 'transfer' && (
                      <td className="px-3 py-2 text-right">
                        <StepInput
                          decimals
                          className="form-input h-9 w-28 text-right tabular-nums placeholder:text-muted-foreground/60"
                          value={line.rate}
                          onValueChange={(v) => setLine(i, { rate: v })}
                          placeholder={customers ? 'customer’s' : mode === 'count' ? 'only if new' : ''}
                          disabled={customers}
                          title={customers ? "A customer's cloth carries no value of ours" : undefined}
                          aria-label={`Rate on line ${i + 1}`}
                        />
                      </td>
                    )}
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400"
                          onClick={() => removeLine(i)}
                          aria-label={`Remove line ${i + 1}`}
                          aria-keyshortcuts="Alt+Delete"
                          data-grid-remove
                        >
                          <Trash2 size={15} />
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-muted-foreground p-1.5 hover:text-primary"
                          onClick={() => copyLine(i)}
                          aria-label={`Copy row ${i + 1}`}
                          title="Copy this line (Alt+C)"
                          aria-keyshortcuts="Alt+C"
                          data-grid-copy
                        >
                          <Copy size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {info && info.tagged > 0 && (
                    <tr data-grid-row="tags">
                      <td />
                      <td colSpan={mode === 'transfer' ? 4 : 5} className="pb-2 pt-0">
                        <div className={`rounded-lg border p-2 ${line.tags.length < need ? 'border-amber-500/60' : 'border-border'} bg-secondary/40`}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-foreground flex items-center gap-1.5 text-xs font-medium">
                              <Tags size={13} /> Garment tags
                              <span className="text-muted-foreground font-normal">
                                · {info.tagged} of the {info.held} here are tagged
                                {need > 0 ? ` — name at least ${need} of the pieces moving` : ' — untagged pieces can move without one'}
                              </span>
                            </span>
                            <span className={`text-xs tabular-nums ${line.tags.length < need ? 'text-amber-500' : 'text-muted-foreground'}`}>
                              {line.tags.length} named
                            </span>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-start gap-2">
                            <textarea
                              className="form-input min-h-[38px] flex-1 font-mono text-xs"
                              placeholder="Scan the tags here, one after another"
                              value={scanText[i] ?? ''}
                              onChange={(e) => setScanText((t) => ({ ...t, [i]: e.target.value }))}
                              onBlur={() => {
                                const codes = splitCodes(scanText[i] ?? '')
                                if (!codes.length) return
                                setLine(i, { tags: [...new Set([...line.tags, ...codes])] })
                                setScanText((t) => ({ ...t, [i]: '' }))
                              }}
                              aria-label={`Scan tags on line ${i + 1}`}
                            />
                            <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setPicking(picking === i ? null : i)}>
                              {picking === i ? 'Done picking' : 'Pick from the store'}
                            </button>
                            {line.tags.length > 0 && (
                              <button type="button" className="btn-ghost h-8 px-2 text-xs" onClick={() => setLine(i, { tags: [] })}>
                                Clear
                              </button>
                            )}
                          </div>
                          {line.tags.length > 0 && (
                            <p className="text-muted-foreground mt-1 break-all font-mono text-[10px]">{line.tags.join(' · ')}</p>
                          )}
                          {picking === i && (
                            <div className="border-border mt-1.5 grid max-h-40 grid-cols-2 gap-x-3 overflow-y-auto rounded border p-1.5 sm:grid-cols-4">
                              {info.codes.length === 0 && <span className="text-muted-foreground text-xs">No tag here can move now.</span>}
                              {info.codes.map((c) => (
                                <label key={c} className="flex items-center gap-1.5 font-mono text-[11px]">
                                  <input
                                    type="checkbox"
                                    checked={line.tags.includes(c)}
                                    onChange={(e) => setLine(i, { tags: e.target.checked ? [...line.tags, c] : line.tags.filter((x) => x !== c) })}
                                  />
                                  {c}
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </FormFrame>
  )
}
