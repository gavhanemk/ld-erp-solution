'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2, Copy, Send, Undo2, Factory, Truck, Boxes, FileText } from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import type { InwardRef } from '@/components/packages/InwardStickers'
import type { OutwardRef } from '@/components/packages/packageTypes'

/**
 * Sending material out to an outside unit, and taking it back.
 *
 * The material may be ours, or a customer's — cut panels from their fabric
 * going out for embroidery. Each line says whose it is; a customer's stays
 * theirs at the unit and comes back as theirs. Coming back, every piece
 * settled is good, damaged at the unit, or wasted, and the three must add up
 * to what is being settled.
 *
 * Two dialogs rather than one screen doing both, because they happen weeks
 * apart and to different people: the store sends the cloth, and whoever is on
 * the gate when the lorry returns books it back.
 *
 * Both sit in the same frame as every other form — the title bar with its
 * icon and main button, white titled sections, a footer that stays in reach.
 */

interface Option {
  id: string
  name: string
}

interface Category {
  id: string
  name: string
  parentId?: string | null
  parent?: { id: string; name: string } | null
}

interface ItemOption extends Option {
  code?: string
  uom?: { symbol: string } | null
  category?: Category | null
}

/** One balance the store it leaves from holds: an item, whose it is, its size. */
interface Held {
  itemId: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId: string | null
  ownerName: string | null
  sizeId: string | null
  sizeCode: string | null
  qty: number
}

const OURS = 'OWNED||'
const heldKey = (h: Pick<Held, 'ownership' | 'ownerCustomerId' | 'sizeId'>) => `${h.ownership}|${h.ownerCustomerId ?? ''}|${h.sizeId ?? ''}`
const parseWhose = (k: string) => {
  const [ownership, ownerCustomerId, sizeId] = k.split('|')
  return {
    ownership: (ownership || 'OWNED') as 'OWNED' | 'CUSTOMER_OWNED',
    ownerCustomerId: ownerCustomerId || null,
    sizeId: sizeId || null,
  }
}

interface OrderOption {
  id: string
  soNumber: string
  customerId: string
  customer?: { name: string } | null
}

const num = (v: string) => Number(v) || 0
const fmt = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/** The main category and sub-category of an item: a category with a parent is a sub-category. */
const placeOf = (it: ItemOption) => {
  const c = it.category
  if (!c) return { main: '', sub: '' }
  return c.parentId || c.parent ? { main: c.parent?.id ?? c.parentId ?? '', sub: c.id } : { main: c.id, sub: '' }
}

interface OutLine {
  categoryId: string
  subCategoryId: string
  itemId: string
  qty: string
  /** Whose stock and which size: "OWNED||" for our own, unsized. */
  whose: string
}

const emptyOut = (): OutLine => ({ categoryId: '', subCategoryId: '', itemId: '', qty: '', whose: OURS })

/** A required field's label, with the red star the other forms use. */
const Req = ({ children }: { children: React.ReactNode }) => (
  <span className="form-label">
    {children}
    <span className="ml-0.5 text-red-500">*</span>
  </span>
)

export function SendJobWorkDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  /** `outward`: the challan just saved, for its labels. */
  onSaved: (message: string, outward?: OutwardRef) => void
}) {
  const [workers, setWorkers] = useState<Option[]>([])
  const [items, setItems] = useState<ItemOption[]>([])
  const [warehouses, setWarehouses] = useState<Option[]>([])
  const [held, setHeld] = useState<Held[]>([])
  const [orders, setOrders] = useState<OrderOption[]>([])
  const [soId, setSoId] = useState('')
  const [loadingLists, setLoadingLists] = useState(true)

  const [jobWorkerId, setJobWorkerId] = useState('')
  const [process, setProcess] = useState('')
  const [fromWarehouseId, setFromWarehouseId] = useState('')
  const [toWarehouseId, setToWarehouseId] = useState('')
  const [expectedBackOn, setExpectedBackOn] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [lrNumber, setLrNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<OutLine[]>([emptyOut()])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [s, i, w, o] = await Promise.all([
          // Active only: a switched-off unit, item or store is not offered for anything new.
          masterResource<Option>('suppliers').list({ limit: 200, active: true, sort: 'name', order: 'asc' }),
          masterResource<ItemOption>('items').list({ limit: 200, active: true, sort: 'name', order: 'asc' }),
          masterResource<Option>('warehouses').list({ limit: 100, active: true }),
          // Open sales orders, for the optional "for order" link. Without Sales rights, none.
          api.get<{ data: OrderOption[] }>('/sales/orders/options?open=1').catch(() => ({ data: [] as OrderOption[] })),
        ])
        if (cancelled) return
        setWorkers(s.data)
        setItems(i.data)
        setWarehouses(w.data)
        setOrders(o.data)
      } catch {
        if (!cancelled) setError('Could not load units, items and stores.')
      } finally {
        if (!cancelled) setLoadingLists(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // What the store it leaves from holds, by item, owner and size.
  useEffect(() => {
    if (!fromWarehouseId) {
      setHeld([])
      return
    }
    let cancelled = false
    api
      .get<{ data: Held[] }>(`/inventory/held?warehouseId=${fromWarehouseId}`)
      .then((res) => {
        if (cancelled) return
        setHeld(res.data)
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
  }, [fromWarehouseId])

  const setLine = (index: number, patch: Partial<OutLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  /** A copy of a line, put just under it. */
  const copyLine = (index: number) =>
    setLines((prev) => (prev[index] ? [...prev.slice(0, index + 1), { ...prev[index] }, ...prev.slice(index + 1)] : prev))

  const filled = lines.filter((l) => l.itemId && num(l.qty) > 0)

  /** Main categories that have at least one item. */
  const mainCategories = useMemo(() => {
    const m = new Map<string, string>()
    for (const it of items) {
      const c = it.category
      if (!c) continue
      const main = c.parent ?? (c.parentId ? null : c)
      if (main) m.set(main.id, main.name)
    }
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [items])

  const subCategoriesOf = (mainId: string) => {
    const m = new Map<string, string>()
    for (const it of items) {
      const c = it.category
      if (c && (c.parent?.id ?? c.parentId) === mainId) m.set(c.id, c.name)
    }
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }

  const itemsFor = (l: OutLine) =>
    items.filter((it) => {
      const p = placeOf(it)
      return (!l.categoryId || p.main === l.categoryId) && (!l.subCategoryId || p.sub === l.subCategoryId)
    })

  /** What the store it leaves from holds of an item, for the owner and size the line chose. */
  const onHand = (l: OutLine) => held.find((h) => h.itemId === l.itemId && heldKey(h) === l.whose)?.qty ?? 0

  const fromName = warehouses.find((w) => w.id === fromWarehouseId)?.name

  const save = async () => {
    setError(null)
    if (!jobWorkerId) return setError('Which unit is doing the work?')
    if (process.trim().length < 2) return setError('Say what the work is — cutting, dyeing, stitching.')
    if (!fromWarehouseId) return setError('Which store does it leave?')
    if (!toWarehouseId) return setError("Which store stands for the unit's floor?")
    if (fromWarehouseId === toWarehouseId) return setError('It has to go to a different store from the one it leaves.')
    if (filled.length === 0) return setError('Add at least one item with a quantity.')
    const over = filled.find((l) => num(l.qty) > onHand(l) + 1e-9)
    if (over) {
      const it = items.find((x) => x.id === over.itemId)
      return setError(`${fromName} has only ${fmt(onHand(over))} ${it?.uom?.symbol ?? ''} of ${it?.name ?? 'that item'} for that owner.`)
    }
    // A customer's material goes out only for their own order.
    const order = orders.find((o) => o.id === soId)
    const wrong = order && filled.find((l) => parseWhose(l.whose).ownerCustomerId && parseWhose(l.whose).ownerCustomerId !== order.customerId)
    if (wrong) return setError(`${order!.soNumber} is ${order!.customer?.name ?? 'another customer'}'s order; another customer's material cannot go out against it.`)

    setSaving(true)
    try {
      const res = await api.post<{ message?: string; data: { id: string; challanNumber: string } }>('/inventory/job-work', {
        jobWorkerId,
        process: process.trim(),
        fromWarehouseId,
        toWarehouseId,
        expectedBackOn: expectedBackOn || null,
        vehicleNo: vehicleNo || null,
        lrNumber: lrNumber || null,
        notes: notes || null,
        soId: soId || null,
        lines: filled.map((l) => ({ itemId: l.itemId, qty: num(l.qty), ...parseWhose(l.whose) })),
      })
      onSaved(res.message ?? `${res.data.challanNumber} saved.`, { type: 'JOB_WORK', id: res.data.id })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const sendButton = (
    <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || loadingLists}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
      Send it out
    </button>
  )

  const storeSelect = (value: string, onChange: (v: string) => void, other: string, label: string) => (
    <SmartSelect className="form-input" value={value} onChange={(e) => onChange(e.target.value)} disabled={loadingLists} aria-label={label}>
      <option value="">{loadingLists ? 'Loading...' : 'Choose a store...'}</option>
      {warehouses
        .filter((w) => w.id !== other)
        .map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
    </SmartSelect>
  )

  return (
    <FormFrame
      icon={Send}
      title="Send out for job work"
      subtitle="The goods stay whoever's they are — ours, or the customer's. They move to the store standing for that unit's floor, so the stock screen still shows them, just somewhere else."
      width="max-w-6xl"
      primary={sendButton}
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={`${filled.length} ${filled.length === 1 ? 'item' : 'items'} to send. A delivery challan is made for the lorry.`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={Factory} title="Job worker & work">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block min-w-0">
            <Req>Unit doing the work</Req>
            <SmartSelect className="form-input" value={jobWorkerId} onChange={(e) => setJobWorkerId(e.target.value)} disabled={loadingLists} autoFocus>
              <option value="">{loadingLists ? 'Loading...' : 'Choose a unit...'}</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </SmartSelect>
          </label>
          <label className="block min-w-0">
            <Req>What is the work</Req>
            <input
              className="form-input placeholder:text-muted-foreground/60"
              value={process}
              onChange={(e) => setProcess(e.target.value)}
              placeholder="Cutting, stitching, dyeing — navy"
            />
          </label>
          <label className="block min-w-0">
            <Req>Leaves from</Req>
            {storeSelect(fromWarehouseId, setFromWarehouseId, toWarehouseId, 'Leaves from')}
          </label>
          <label className="block min-w-0">
            <Req>Goes to</Req>
            {storeSelect(toWarehouseId, setToWarehouseId, fromWarehouseId, 'Goes to')}
            <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">The store that stands for the unit&apos;s floor.</span>
          </label>
        </div>
      </Section>

      <Section icon={Truck} title="Dispatch">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block min-w-0">
            <span className="form-label">Due back</span>
            <input type="date" className="form-input" value={expectedBackOn} onChange={(e) => setExpectedBackOn(e.target.value)} />
          </label>
          <label className="block min-w-0">
            <span className="form-label">Vehicle number</span>
            <input
              className="form-input placeholder:text-muted-foreground/60"
              value={vehicleNo}
              onChange={(e) => setVehicleNo(e.target.value)}
              placeholder="e.g. MH04AB1234"
            />
          </label>
          <label className="block min-w-0">
            <span className="form-label">LR number</span>
            <input className="form-input" value={lrNumber} onChange={(e) => setLrNumber(e.target.value)} />
          </label>
          <label className="block min-w-0">
            <span className="form-label">For order</span>
            <SmartSelect className="form-input" value={soId} onChange={(e) => setSoId(e.target.value)} disabled={loadingLists} aria-label="For sales order">
              <option value="">No order</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id} data-sub={o.customer?.name}>
                  {o.soNumber}
                </option>
              ))}
            </SmartSelect>
          </label>
          <label className="block min-w-0 sm:col-span-2 lg:col-span-4">
            <span className="form-label">Note</span>
            <input
              className="form-input placeholder:text-muted-foreground/60"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the unit should know"
            />
          </label>
        </div>
      </Section>

      <Section
        icon={Boxes}
        title="Items"
        actions={
          <button
            type="button"
            className="btn-secondary h-8 text-xs"
            onClick={() => setLines((prev) => [...prev, emptyOut()])}
            data-grid-add
            aria-keyshortcuts="Alt+A"
            title="Add item (Alt+A)"
          >
            <Plus size={14} /> Add item
          </button>
        }
      >
        <div className="-mx-4 -mb-3.5 -mt-3 overflow-x-auto">
          <table className="data-table w-full [&>tbody>tr>td]:px-3 [&>thead>tr>th]:px-3">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Category · Sub-category · Item</th>
                <th>Whose stock</th>
                <th style={{ textAlign: 'right' }}>{fromName ? `In ${fromName}` : 'In the store'}</th>
                <th style={{ textAlign: 'right' }}>Quantity to send</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody data-grid>
              {lines.map((line, i) => {
                const item = items.find((x) => x.id === line.itemId)
                const uom = item?.uom?.symbol ?? ''
                const subs = line.categoryId ? subCategoriesOf(line.categoryId) : []
                const choices = itemsFor(line)
                const have = line.itemId && fromWarehouseId ? onHand(line) : null
                const owners = held.filter((h) => h.itemId === line.itemId)
                const over = have !== null && num(line.qty) > have + 1e-9
                return (
                  <tr key={i} data-grid-row className="align-top">
                    <td className="text-muted-foreground pt-4 text-xs tabular-nums">{i + 1}</td>
                    {/* Category and sub-category narrow the item list, as on the other forms. */}
                    <td className="min-w-[320px]">
                      <div className="grid grid-cols-2 gap-1.5">
                        <SmartSelect
                          className="form-input h-9"
                          value={line.categoryId}
                          onChange={(e) => {
                            const categoryId = e.target.value
                            const keep = item && (!categoryId || placeOf(item).main === categoryId)
                            setLine(i, { categoryId, subCategoryId: '', itemId: keep ? line.itemId : '' })
                          }}
                          disabled={loadingLists}
                          aria-label={`Category on line ${i + 1}`}
                        >
                          <option value="">All categories</option>
                          {mainCategories.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </SmartSelect>
                        <SmartSelect
                          className="form-input h-9"
                          value={line.subCategoryId}
                          onChange={(e) => {
                            const subCategoryId = e.target.value
                            const keep = item && (!subCategoryId || placeOf(item).sub === subCategoryId)
                            setLine(i, { subCategoryId, itemId: keep ? line.itemId : '' })
                          }}
                          disabled={!line.categoryId || subs.length === 0}
                          aria-label={`Sub-category on line ${i + 1}`}
                        >
                          <option value="">{!line.categoryId ? 'Sub-category' : subs.length ? 'All sub-categories' : 'No sub-categories'}</option>
                          {subs.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </SmartSelect>
                      </div>
                      <SmartSelect
                        className="form-input mt-1.5 h-9"
                        value={line.itemId}
                        onChange={(e) => {
                          const picked = items.find((x) => x.id === e.target.value)
                          // Picking an item fills in its category and sub-category.
                          const place = picked ? placeOf(picked) : null
                          const offered = held.filter((h) => h.itemId === e.target.value)
                          setLine(i, {
                            itemId: e.target.value,
                            whose: offered.length === 1 ? heldKey(offered[0]) : OURS,
                            ...(place ? { categoryId: place.main, subCategoryId: place.sub } : {}),
                          })
                        }}
                        disabled={loadingLists}
                        aria-label={`Item on line ${i + 1}`}
                      >
                        <option value="">Choose an item… ({choices.length})</option>
                        {choices.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.code ? `${it.code} · ` : ''}
                            {it.name}
                          </option>
                        ))}
                      </SmartSelect>
                    </td>
                    <td className="min-w-[200px] pt-1.5">
                      <SmartSelect
                        className="form-input h-9"
                        value={line.whose}
                        onChange={(e) => setLine(i, { whose: e.target.value })}
                        disabled={!line.itemId}
                        aria-label={`Whose stock on line ${i + 1}`}
                      >
                        {!owners.some((h) => heldKey(h) === OURS) && <option value={OURS}>Ours</option>}
                        {owners.map((h) => (
                          <option key={heldKey(h)} value={heldKey(h)}>
                            {h.ownership === 'CUSTOMER_OWNED' ? `${h.ownerName ?? 'Customer'}'s` : 'Ours'}
                            {h.sizeCode ? ` · size ${h.sizeCode}` : ''}
                          </option>
                        ))}
                      </SmartSelect>
                    </td>
                    <td className="whitespace-nowrap pt-4 text-right text-sm tabular-nums">
                      {have === null ? (
                        <span className="text-muted-foreground">{line.itemId ? 'pick the store' : '—'}</span>
                      ) : (
                        <span className={have > 0 ? 'text-foreground' : 'text-red-500'}>
                          {fmt(have)} {uom}
                        </span>
                      )}
                    </td>
                    <td className="min-w-[130px]">
                      <div className="relative">
                        <StepInput
                          decimals
                          className={`form-input h-9 pr-10 text-right ${over ? 'border-red-500/60' : ''}`}
                          value={line.qty}
                          onValueChange={(v) => setLine(i, { qty: v })}
                          aria-label={`Quantity on line ${i + 1}`}
                        />
                        {uom && (
                          <span className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs">{uom}</span>
                        )}
                      </div>
                      {over && <p className="mt-1 text-right text-[11px] text-red-500">More than the store has</p>}
                    </td>
                    <td className="pt-1.5 text-right">
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400"
                          onClick={() => setLines((prev) => (prev.length === 1 ? [emptyOut()] : prev.filter((_, x) => x !== i)))}
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
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </FormFrame>
  )
}

interface ChallanLine {
  id: string
  qty: string | number
  outstanding: number
  item: { id: string; name: string; uom: { symbol: string } | null }
}

interface ReturnEntry {
  consumed: string
  itemId: string
  received: string
  damaged: string
  wasted: string
  warehouseId: string
}

/** Good + damaged + wasted against what is being settled, when the same thing came back. */
const balanceOf = (e: ReturnEntry | undefined, sentItemId: string) => {
  if (!e || e.itemId !== sentItemId || num(e.consumed) <= 0) return null
  const accounted = Math.round((num(e.received) + num(e.damaged) + num(e.wasted)) * 1000) / 1000
  return { accounted, ok: Math.abs(accounted - num(e.consumed)) < 1e-9 }
}

export function ReceiveJobWorkDialog({
  challan,
  onClose,
  onSaved,
}: {
  challan: {
    id: string
    challanNumber: string
    process: string
    jobWorker: { name: string }
    fromWarehouse: { id: string; name: string }
    lines: ChallanLine[]
  }
  onClose: () => void
  /** `stickers`: the return just saved, for its sticker window. */
  onSaved: (message: string, stickers?: InwardRef) => void
}) {
  const [items, setItems] = useState<ItemOption[]>([])
  const [warehouses, setWarehouses] = useState<Option[]>([])
  const [entries, setEntries] = useState<Record<string, ReturnEntry>>({})
  const [theirChallanNo, setTheirChallanNo] = useState('')
  const [notes, setNotes] = useState('')
  const [loadingLists, setLoadingLists] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [i, w] = await Promise.all([
          masterResource<ItemOption>('items').list({ limit: 200, active: true, sort: 'name', order: 'asc' }),
          masterResource<Option>('warehouses').list({ limit: 100, active: true }),
        ])
        if (cancelled) return
        // The items sent are always offered, even if one has since been switched off.
        const sent = challan.lines.map((l) => l.item).filter((s) => !i.data.some((x) => x.id === s.id))
        setItems([...sent, ...i.data])
        setWarehouses(w.data)
        setEntries(
          Object.fromEntries(
            challan.lines.map((l) => [
              l.id,
              {
                consumed: l.outstanding > 0 ? String(l.outstanding) : '',
                itemId: l.item.id,
                received: l.outstanding > 0 ? String(l.outstanding) : '',
                damaged: '',
                wasted: '',
                warehouseId: challan.fromWarehouse.id,
              },
            ]),
          ),
        )
      } catch {
        if (!cancelled) setError('Could not load items and stores.')
      } finally {
        if (!cancelled) setLoadingLists(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [challan])

  const setEntry = (id: string, patch: Partial<ReturnEntry>) => setEntries((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const settling = challan.lines.filter((l) => num(entries[l.id]?.consumed ?? '') > 0)

  const save = async () => {
    setError(null)
    const lines = challan.lines.map((l) => ({ line: l, e: entries[l.id] })).filter(({ e }) => e && num(e.consumed) > 0)

    if (lines.length === 0) return setError('Enter what came back on at least one line.')
    if (lines.some(({ e }) => !e.warehouseId)) return setError('Every line needs a store to go into.')
    const over = lines.find(({ line, e }) => num(e.consumed) > line.outstanding + 1e-9)
    if (over) return setError(`Only ${fmt(over.line.outstanding)} ${over.line.item.uom?.symbol ?? ''} of ${over.line.item.name} is still out.`)
    const unbalanced = lines.find(({ line, e }) => balanceOf(e, line.item.id)?.ok === false)
    if (unbalanced) {
      const e = unbalanced.e
      return setError(
        `${unbalanced.line.item.name}: ${fmt(num(e.received))} good + ${fmt(num(e.damaged))} damaged + ${fmt(num(e.wasted))} wasted has to come to the ${fmt(num(e.consumed))} being settled.`,
      )
    }

    setSaving(true)
    try {
      const res = await api.post<{ message?: string; data: { challanNumber: string }; returnId?: string }>(`/inventory/job-work/${challan.id}/returns`, {
        theirChallanNo: theirChallanNo || null,
        notes: notes || null,
        lines: lines.map(({ line, e }) => ({
          challanLineId: line.id,
          consumedQty: num(e.consumed),
          itemId: e.itemId,
          receivedQty: num(e.received),
          damagedQty: num(e.damaged),
          wastedQty: num(e.wasted),
          warehouseId: e.warehouseId,
        })),
      })
      onSaved(res.message ?? 'Return saved.', res.returnId ? { type: 'JOB_WORK_RETURN', id: res.returnId } : undefined)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const takeButton = (
    <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || loadingLists}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <Undo2 size={15} />}
      Take it back
    </button>
  )

  const qtyInput = (value: string, onChange: (v: string) => void, label: string, uom: string, disabled: boolean, bad = false) => (
    <div className="relative">
      <StepInput
        decimals
        className={`form-input h-9 pr-10 text-right ${bad ? 'border-red-500/60' : ''}`}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        placeholder="0"
        aria-label={label}
      />
      {uom && <span className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs">{uom}</span>}
    </div>
  )

  return (
    <FormFrame
      icon={Undo2}
      title={`Take back ${challan.challanNumber}`}
      subtitle={`${challan.process} at ${challan.jobWorker.name}. Good + damaged + wasted must add up to what is being settled; damaged pieces can be charged to the unit on a debit note. If the unit made something of it, change the item that came back.`}
      width="max-w-6xl"
      primary={takeButton}
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={`${settling.length} of ${challan.lines.length} ${challan.lines.length === 1 ? 'line' : 'lines'} being settled.`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={FileText} title="Their paperwork">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
          <label className="block min-w-0">
            <span className="form-label">Their challan no.</span>
            <input
              className="form-input placeholder:text-muted-foreground/60"
              value={theirChallanNo}
              onChange={(e) => setTheirChallanNo(e.target.value)}
              placeholder="As on their paperwork"
              autoFocus
            />
          </label>
          <label className="block min-w-0 sm:col-span-2">
            <span className="form-label">Note</span>
            <input
              className="form-input placeholder:text-muted-foreground/60"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything worth remembering about this lot"
            />
          </label>
        </div>
      </Section>

      <Section icon={Boxes} title="Items">
        <div className="-mx-4 -mb-3.5 -mt-3 overflow-x-auto">
          <table className="data-table w-full [&>tbody>tr>td]:px-3 [&>thead>tr>th]:px-3">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Sent</th>
                <th style={{ textAlign: 'right' }}>Still out</th>
                <th style={{ textAlign: 'right' }}>Settling</th>
                <th>Came back as</th>
                <th style={{ textAlign: 'right' }}>Good back</th>
                <th style={{ textAlign: 'right' }}>Damaged</th>
                <th style={{ textAlign: 'right' }}>Wasted</th>
                <th>Into store</th>
              </tr>
            </thead>
            <tbody data-grid>
              {challan.lines.map((l, i) => {
                const e = entries[l.id]
                const done = l.outstanding <= 0
                const sentUom = l.item.uom?.symbol ?? ''
                const backUom = items.find((x) => x.id === e?.itemId)?.uom?.symbol ?? sentUom
                return (
                  <tr key={l.id} data-grid-row className={done ? 'opacity-60' : undefined}>
                    <td className="text-muted-foreground text-xs tabular-nums">{i + 1}</td>
                    <td className="min-w-[180px]">
                      <div className="text-sm font-medium text-foreground">{l.item.name}</div>
                      <div className="text-muted-foreground text-[11px]">
                        {fmt(Number(l.qty))} {sentUom} sent
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-right text-sm tabular-nums">
                      {done ? (
                        <span className="badge-success">all back</span>
                      ) : (
                        <span className="font-medium text-amber-500">
                          {fmt(l.outstanding)} {sentUom}
                        </span>
                      )}
                    </td>
                    <td className="min-w-[120px]">
                      {qtyInput(
                        e?.consumed ?? '',
                        (v) => setEntry(l.id, { consumed: v }),
                        `Quantity of ${l.item.name} being settled`,
                        sentUom,
                        done,
                        num(e?.consumed ?? '') > l.outstanding + 1e-9,
                      )}
                    </td>
                    <td className="min-w-[200px]">
                      <SmartSelect
                        className="form-input h-9"
                        value={e?.itemId ?? ''}
                        onChange={(ev) => setEntry(l.id, { itemId: ev.target.value })}
                        disabled={done || loadingLists}
                        aria-label={`What came back for ${l.item.name}`}
                      >
                        {items.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.name}
                          </option>
                        ))}
                      </SmartSelect>
                    </td>
                    <td className="min-w-[120px]">
                      {qtyInput(e?.received ?? '', (v) => setEntry(l.id, { received: v }), `Good quantity back for ${l.item.name}`, backUom, done, balanceOf(e, l.item.id)?.ok === false)}
                      {balanceOf(e, l.item.id)?.ok === false && (
                        <p className="mt-1 text-right text-[11px] text-red-500">
                          adds up to {fmt(balanceOf(e, l.item.id)!.accounted)}, not {fmt(num(e!.consumed))}
                        </p>
                      )}
                    </td>
                    <td className="min-w-[110px]">
                      {qtyInput(e?.damaged ?? '', (v) => setEntry(l.id, { damaged: v }), `Damaged at the unit for ${l.item.name}`, backUom, done)}
                    </td>
                    <td className="min-w-[110px]">
                      {qtyInput(e?.wasted ?? '', (v) => setEntry(l.id, { wasted: v }), `Wasted for ${l.item.name}`, sentUom, done)}
                    </td>
                    <td className="min-w-[160px]">
                      <SmartSelect
                        className="form-input h-9"
                        value={e?.warehouseId ?? ''}
                        onChange={(ev) => setEntry(l.id, { warehouseId: ev.target.value })}
                        disabled={done || loadingLists}
                        aria-label={`Store for ${l.item.name}`}
                      >
                        <option value="">Choose a store...</option>
                        {warehouses.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                      </SmartSelect>
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
