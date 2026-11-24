'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, PackagePlus, Plus, Shirt, Trash2, Wand2, Package } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { cn } from '@/lib/utils'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

/*
 * Opening stock by hand. Where and when first; then garments style by style —
 * sizes across, colours down, a rate for each size — and materials item by
 * item, with their lot and roll. Saved as one entry, checked and brought in
 * exactly as an uploaded sheet is, so both land in stock the same way.
 */

interface Colour {
  colour: string
  item: { id: string; code: string } | null
}
interface StyleOption {
  id: string
  code: string
  name: string
  colours: Colour[]
  sizes: Array<{ id: string; code: string }>
}
interface ItemOption {
  id: string
  code: string
  name: string
  type: string
  category: string | null
  unit: string | null
  decimals: number
}
interface FormOptions {
  processes: Array<{ id: string; name: string; floor: string | null }>
  stores: Array<{ id: string; name: string; code: string }>
  styles: StyleOption[]
  items: ItemOption[]
}

/** A style being entered: a rate per size, pieces per colour and size. */
interface StyleBlock {
  key: string
  styleId: string
  rates: Record<string, string>
  qty: Record<string, string>
  lot: string
  bundle: string
}
/** A material: one item, one lot or roll. */
interface MaterialRow {
  key: string
  itemId: string
  lot: string
  bundle: string
  qty: string
  rate: string
}

const STATUSES = [
  { value: 'OK', label: 'OK — ready to use' },
  { value: 'Hold', label: 'Hold — kept aside' },
  { value: 'Rejected', label: 'Rejected' },
  { value: 'B-Grade', label: 'B-Grade (garments only)' },
]

const todayInIndia = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10)
const money = (v: number) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const cellKey = (colour: string, sizeId: string) => `${colour}|${sizeId}`
let seq = 0
const nextKey = () => `k${++seq}`

export function OpeningStockEntryDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const [options, setOptions] = useState<FormOptions | null>(null)
  const [date, setDate] = useState(todayInIndia)
  const [where, setWhere] = useState('store')
  const [storeId, setStoreId] = useState('')
  const [orderNo, setOrderNo] = useState('')
  const [status, setStatus] = useState('OK')
  const [notes, setNotes] = useState('')
  const [blocks, setBlocks] = useState<StyleBlock[]>([])
  const [materials, setMaterials] = useState<MaterialRow[]>([])
  const [pickStyle, setPickStyle] = useState('')
  const [problems, setProblems] = useState<Map<string, string[]>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mayMakeItems = can('masters', 'create')

  useEffect(() => {
    api
      .get<{ data: FormOptions }>('/inventory/opening-stock/form')
      .then((r) => {
        setOptions(r.data)
        setStoreId(r.data.stores[0]?.id ?? '')
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the styles and items.'))
  }, [])

  const process = where.startsWith('p:') ? options?.processes.find((p) => p.id === where.slice(2)) : undefined
  const store = options?.stores.find((s) => s.id === storeId)
  const styleOf = (id: string) => options?.styles.find((s) => s.id === id)
  const itemOf = (id: string) => options?.items.find((i) => i.id === id)

  // Every line to bring in, as the sheet's columns, and what each belongs to on screen.
  const { lines, refs, value } = useMemo(() => {
    const out: Array<Record<string, string | number>> = []
    const at: Array<{ key: string; label: string }> = []
    let total = 0
    const base = {
      date,
      process: process ? process.name : where === 'finished' ? 'Finished Goods' : 'Store',
      location: process ? '' : (store?.name ?? ''),
      order: orderNo.trim(),
      status,
    }
    for (const b of blocks) {
      const st = styleOf(b.styleId)
      if (!st) continue
      for (const c of st.colours) {
        for (const s of st.sizes) {
          const q = Number(b.qty[cellKey(c.colour, s.id)] || 0)
          if (!(q > 0)) continue
          const rate = b.rates[s.id] ?? ''
          total += q * Number(rate || 0)
          out.push({ ...base, style: st.code, code: c.item?.code ?? '', colour: c.colour, size: s.code, qty: q, rate, lot: b.lot.trim(), bundle: b.bundle.trim() })
          at.push({ key: b.key, label: `${c.colour} · ${s.code}` })
        }
      }
    }
    for (const m of materials) {
      const it = itemOf(m.itemId)
      const q = Number(m.qty || 0)
      if (!it || !(q > 0)) continue
      total += q * Number(m.rate || 0)
      out.push({ ...base, code: it.code, uom: it.unit ?? '', qty: q, rate: m.rate, lot: m.lot.trim(), bundle: m.bundle.trim() })
      at.push({ key: m.key, label: it.code })
    }
    return { lines: out, refs: at, value: total }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, materials, date, where, storeId, orderNo, status, options])

  const addStyle = (styleId: string) => {
    if (!styleId) return
    setBlocks((bs) => [...bs, { key: nextKey(), styleId, rates: {}, qty: {}, lot: '', bundle: '' }])
    setPickStyle('')
  }
  const updateBlock = (key: string, change: (b: StyleBlock) => StyleBlock) => setBlocks((bs) => bs.map((b) => (b.key === key ? change(b) : b)))
  const addMaterial = () => setMaterials((ms) => [...ms, { key: nextKey(), itemId: '', lot: '', bundle: '', qty: '', rate: '' }])
  const updateMaterial = (key: string, change: Partial<MaterialRow>) => setMaterials((ms) => ms.map((m) => (m.key === key ? { ...m, ...change } : m)))

  // A colour with no item yet, once made, can take pieces at once.
  const colourMade = (styleId: string, colour: string, item: { id: string; code: string }) =>
    setOptions((o) =>
      o && {
        ...o,
        styles: o.styles.map((s) => (s.id === styleId ? { ...s, colours: s.colours.map((c) => (c.colour === colour ? { ...c, item } : c)) } : s)),
      },
    )

  const save = async () => {
    if (where === 'store' || where === 'finished') {
      if (!storeId) return setError('Pick the store the stock is in.')
    }
    if (!lines.length) return setError('Enter pieces for at least one size, or a quantity for at least one item.')
    setBusy(true)
    setError(null)
    setProblems(new Map())
    try {
      const checked = await api.post<{ data: { rows: Array<{ row: number; problems: string[] }> } }>('/inventory/opening-stock/entry', { lines, notes })
      const bad = checked.data.rows.filter((r) => r.problems.length)
      if (bad.length) {
        const byKey = new Map<string, string[]>()
        for (const r of bad) {
          const ref = refs[r.row - 1]
          if (!ref) continue
          byKey.set(ref.key, [...(byKey.get(ref.key) ?? []), ...r.problems.map((p) => `${ref.label}: ${p}`)])
        }
        setProblems(byKey)
        setError(`${bad.length} ${bad.length === 1 ? 'line needs' : 'lines need'} putting right — see the notes in red below. Nothing is saved until every line is right.`)
        return
      }
      const done = await api.post<{ message: string }>('/inventory/opening-stock/entry', { lines, notes, confirm: true })
      onSaved(done.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the opening stock.')
    } finally {
      setBusy(false)
    }
  }

  const styleChoices = (options?.styles ?? []).filter((s) => !blocks.some((b) => b.styleId === s.id))
  const itemsByCategory = useMemo(() => {
    const m = new Map<string, ItemOption[]>()
    for (const i of options?.items ?? []) m.set(i.category ?? 'Other', [...(m.get(i.category ?? 'Other') ?? []), i])
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [options])

  return (
    <FormFrame
      icon={PackagePlus}
      title="Add opening stock"
      subtitle="What you had on the opening date: garments style by style and size by size, materials item by item. It goes into stock as soon as you save."
      onClose={onClose}
      busy={busy}
      error={error}
      width="max-w-6xl"
      footerNote={
        <span className="text-muted-foreground text-sm">
          {lines.length ? (
            <>
              <span className="text-foreground font-semibold">{lines.length}</span> {lines.length === 1 ? 'line' : 'lines'} ·{' '}
              <span className="text-foreground font-semibold">{money(value)}</span>
            </>
          ) : (
            'Nothing entered yet'
          )}
        </span>
      }
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy}>
          Save opening stock
        </button>
      }
    >
      {/* Where and when: one place and date for the whole entry. */}
      <section className="glass-card space-y-3 p-4" aria-label="Where and when">
        <h3 className="text-foreground text-sm font-semibold">1. Where and when</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1 text-sm">
            <span className="text-foreground font-medium">Opening date</span>
            <input type="date" className="form-input" value={date} max={todayInIndia()} onChange={(e) => setDate(e.target.value)} aria-label="Opening date" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-foreground font-medium">Where is it?</span>
            <SmartSelect className="form-input" value={where} onChange={(e) => setWhere(e.target.value)} aria-label="Where is it">
              <optgroup label="In a store">
                <option value="store">Store — raw materials, trims, packing</option>
                <option value="finished">Finished Goods — ready garments</option>
              </optgroup>
              <optgroup label="Work in progress, at a process">
                {(options?.processes ?? []).map((p) => (
                  <option key={p.id} value={`p:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            </SmartSelect>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-foreground font-medium">Location</span>
            {process ? (
              <div className="form-input text-muted-foreground flex items-center" aria-label="Location">
                {process.floor ?? `${process.name} Floor`}
                {!process.floor && <span className="text-primary ml-1 text-xs">· made when you save</span>}
              </div>
            ) : (
              <SmartSelect className="form-input" value={storeId} onChange={(e) => setStoreId(e.target.value)} aria-label="Location">
                {(options?.stores ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </SmartSelect>
            )}
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-foreground font-medium">Stock status</span>
            <SmartSelect className="form-input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Stock status">
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </SmartSelect>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-foreground font-medium">Order No.</span>
            <input className="form-input" value={orderNo} onChange={(e) => setOrderNo(e.target.value)} placeholder="Optional: SO, MO or old order no." aria-label="Order No." />
          </label>
          <label className="space-y-1 text-sm sm:col-span-1 lg:col-span-3">
            <span className="text-foreground font-medium">Remarks</span>
            <input className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional: who counted it, anything to remember" aria-label="Remarks" />
          </label>
        </div>
      </section>

      {/* Garments: a grid per style. */}
      <section className="glass-card space-y-3 p-4" aria-label="Garments by style and size">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
            <Shirt size={15} /> 2. Garments — style by style, size by size
          </h3>
          <SmartSelect className="form-input h-9 w-80" value={pickStyle} onChange={(e) => addStyle(e.target.value)} aria-label="Add a style">
            <option value="">+ Add a style…</option>
            {styleChoices.map((s) => (
              <option key={s.id} value={s.id} data-sub={s.name}>
                {s.code} — {s.name}
              </option>
            ))}
          </SmartSelect>
        </div>
        {blocks.length === 0 && (
          <p className="text-muted-foreground text-sm">Pick a style to enter its pieces: a box for every colour and size. For work in progress, pick the process above.</p>
        )}
        {blocks.map((b) => {
          const st = styleOf(b.styleId)
          if (!st) return null
          return (
            <StyleGrid
              key={b.key}
              block={b}
              style={st}
              problems={problems.get(b.key)}
              mayMakeItems={mayMakeItems}
              onChange={(change) => updateBlock(b.key, change)}
              onRemove={() => setBlocks((bs) => bs.filter((x) => x.key !== b.key))}
              onColourMade={(colour, item) => colourMade(st.id, colour, item)}
            />
          )
        })}
      </section>

      {/* Materials: one row per item and lot. */}
      <section className="glass-card space-y-3 p-4" aria-label="Materials item by item">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
            <Package size={15} /> 3. Materials — fabric, trims, packing, item by item
          </h3>
          <button type="button" className="btn-secondary h-9 text-sm" onClick={addMaterial}>
            <Plus size={14} /> Add an item
          </button>
        </div>
        {materials.length === 0 ? (
          <p className="text-muted-foreground text-sm">Add an item for each lot or roll: fabric by the metre, buttons and labels by the piece.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground text-left text-[11px] font-semibold uppercase tracking-wide">
                  <th className="py-1.5 pr-2">Item</th>
                  <th className="px-2 py-1.5">Lot / Batch / Roll No.</th>
                  <th className="px-2 py-1.5">Bundle / Barcode No.</th>
                  <th className="px-2 py-1.5 text-right">Opening Qty</th>
                  <th className="px-2 py-1.5 text-right">Unit Rate ₹</th>
                  <th className="px-2 py-1.5 text-right">Opening Value</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {materials.map((m) => {
                  const it = itemOf(m.itemId)
                  const rowProblems = problems.get(m.key)
                  return (
                    <tr key={m.key} className="border-border border-t align-top">
                      <td className="min-w-64 py-1.5 pr-2">
                        <SmartSelect className="form-input" value={m.itemId} onChange={(e) => updateMaterial(m.key, { itemId: e.target.value })} aria-label="Item">
                          <option value="">Pick the item…</option>
                          {itemsByCategory.map(([cat, list]) => (
                            <optgroup key={cat} label={cat}>
                              {list.map((i) => (
                                <option key={i.id} value={i.id} data-sub={`${i.code}${i.unit ? ` · in ${i.unit}` : ''}`}>
                                  {i.name}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </SmartSelect>
                        {rowProblems && (
                          <ul className="mt-1 space-y-0.5 text-[11px] text-red-400">
                            {rowProblems.map((p) => (
                              <li key={p}>{p}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <input className="form-input" value={m.lot} onChange={(e) => updateMaterial(m.key, { lot: e.target.value })} placeholder="Optional" aria-label="Lot / Batch / Roll No." />
                      </td>
                      <td className="px-2 py-1.5">
                        <input className="form-input" value={m.bundle} onChange={(e) => updateMaterial(m.key, { bundle: e.target.value })} placeholder="Optional" aria-label="Bundle / Barcode No." />
                      </td>
                      <td className="w-36 px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          <StepInput
                            className="form-input text-right"
                            value={m.qty}
                            decimals={(it?.decimals ?? 0) > 0}
                            onValueChange={(v) => updateMaterial(m.key, { qty: v })}
                            aria-label="Opening Qty"
                          />
                          <span className="text-muted-foreground w-8 text-xs">{it?.unit ?? ''}</span>
                        </div>
                      </td>
                      <td className="w-32 px-2 py-1.5">
                        <StepInput className="form-input text-right" value={m.rate} decimals onValueChange={(v) => updateMaterial(m.key, { rate: v })} aria-label="Unit Rate" />
                      </td>
                      <td className="text-foreground px-2 py-1.5 pt-3.5 text-right font-semibold tabular-nums">
                        {money(Number(m.qty || 0) * Number(m.rate || 0))}
                      </td>
                      <td className="py-1.5 pt-2.5">
                        <button type="button" className="btn-ghost p-1" onClick={() => setMaterials((ms) => ms.filter((x) => x.key !== m.key))} aria-label="Remove this item">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </FormFrame>
  )
}

/**
 * One style: sizes across, colours down. The rate row fills a rate per size
 * (one figure fills them all); each colour has a box per size. A colour with
 * no item yet can be made here, like the style's other colours.
 */
function StyleGrid({
  block,
  style,
  problems,
  mayMakeItems,
  onChange,
  onRemove,
  onColourMade,
}: {
  block: StyleBlock
  style: StyleOption
  problems: string[] | undefined
  mayMakeItems: boolean
  onChange: (change: (b: StyleBlock) => StyleBlock) => void
  onRemove: () => void
  onColourMade: (colour: string, item: { id: string; code: string }) => void
}) {
  const [making, setMaking] = useState<string | null>(null)
  const [choose, setChoose] = useState<{ colour: string; categories: Array<{ id: string; name: string }>; categoryId: string } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [allRate, setAllRate] = useState('')

  const pieces = (colour: string) => style.sizes.reduce((n, s) => n + Number(block.qty[cellKey(colour, s.id)] || 0), 0)
  const valueOf = (colour: string) => style.sizes.reduce((n, s) => n + Number(block.qty[cellKey(colour, s.id)] || 0) * Number(block.rates[s.id] || 0), 0)
  const total = style.colours.reduce((n, c) => n + pieces(c.colour), 0)

  const makeItem = async (colour: string, categoryId?: string) => {
    setMaking(colour)
    setNote(null)
    try {
      const res = await api.post<{ message?: string; data: { item?: { id: string; code: string }; needCategory?: boolean; categories?: Array<{ id: string; name: string }> } }>(
        '/inventory/opening-stock/colour-item',
        { styleId: style.id, colour, categoryId: categoryId ?? null },
      )
      if (res.data.needCategory) {
        setChoose({ colour, categories: res.data.categories ?? [], categoryId: '' })
        return
      }
      if (res.data.item) {
        onColourMade(colour, res.data.item)
        setChoose(null)
        setNote(res.message ?? null)
      }
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Could not make the item.')
    } finally {
      setMaking(null)
    }
  }

  return (
    <div className="border-border space-y-3 rounded-xl border p-3" aria-label={`Style ${style.code}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <span className="font-mono text-sm font-semibold text-teal-400">{style.code}</span> <span className="text-foreground text-sm">{style.name}</span>
          <span className="text-muted-foreground ml-2 text-xs">{total ? `${total.toLocaleString('en-IN')} pcs` : ''}</span>
        </div>
        <button type="button" className="btn-ghost p-1" onClick={onRemove} aria-label={`Remove ${style.code}`}>
          <Trash2 size={14} />
        </button>
      </div>

      {style.sizes.length === 0 ? (
        <p className="text-sm text-amber-500">
          <AlertCircle size={14} className="mr-1 inline" />
          {style.code} has no size run yet. Give it one in Masters → Styles, then add it here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
                <th className="min-w-44 py-1.5 pr-3 text-left">Colour</th>
                {style.sizes.map((s) => (
                  <th key={s.id} className="w-20 px-1 py-1.5 text-center">
                    {s.code}
                  </th>
                ))}
                <th className="px-3 py-1.5 text-right">Pieces</th>
                <th className="px-3 py-1.5 text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-secondary/40">
                <td className="py-1.5 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground text-xs font-semibold">Rate per piece ₹</span>
                    <StepInput
                      className="form-input h-8 w-20 text-right text-xs"
                      value={allRate}
                      decimals
                      onValueChange={(v) => {
                        setAllRate(v)
                        onChange((b) => ({ ...b, rates: Object.fromEntries(style.sizes.map((s) => [s.id, v])) }))
                      }}
                      placeholder="All"
                      aria-label={`Rate for every size of ${style.code}`}
                      title="One rate for every size; change any size after"
                    />
                  </div>
                </td>
                {style.sizes.map((s) => (
                  <td key={s.id} className="px-1 py-1.5">
                    <StepInput
                      className="form-input h-8 text-right text-xs"
                      value={block.rates[s.id] ?? ''}
                      decimals
                      onValueChange={(v) => onChange((b) => ({ ...b, rates: { ...b.rates, [s.id]: v } }))}
                      aria-label={`Rate for size ${s.code}`}
                    />
                  </td>
                ))}
                <td colSpan={2} />
              </tr>
              {style.colours.map((c) => (
                <tr key={c.colour} className="border-border border-t">
                  <td className="py-1.5 pr-3">
                    <div className="text-foreground font-medium">{c.colour}</div>
                    {c.item ? (
                      <div className="text-muted-foreground font-mono text-[11px]">{c.item.code}</div>
                    ) : choose?.colour === c.colour ? (
                      <div className="mt-1 flex items-center gap-1">
                        <SmartSelect
                          className="form-input h-8 text-xs"
                          value={choose.categoryId}
                          onChange={(e) => setChoose({ ...choose, categoryId: e.target.value })}
                          aria-label={`Category for ${style.code} ${c.colour}`}
                        >
                          <option value="">File under…</option>
                          {choose.categories.map((k) => (
                            <option key={k.id} value={k.id}>
                              {k.name}
                            </option>
                          ))}
                        </SmartSelect>
                        <button type="button" className="btn-primary h-8 px-2 text-xs" disabled={!choose.categoryId || making === c.colour} onClick={() => void makeItem(c.colour, choose.categoryId)}>
                          Make
                        </button>
                      </div>
                    ) : mayMakeItems ? (
                      <button type="button" className="text-primary mt-0.5 flex items-center gap-1 text-[11px] hover:underline" disabled={making === c.colour} onClick={() => void makeItem(c.colour)}>
                        <Wand2 size={11} /> {making === c.colour ? 'Making…' : 'No item yet — make it'}
                      </button>
                    ) : (
                      <div className="text-[11px] text-amber-500">No item yet: add it in Items &amp; Products</div>
                    )}
                  </td>
                  {style.sizes.map((s) => (
                    <td key={s.id} className="px-1 py-1.5">
                      <StepInput
                        className={cn('form-input h-8 text-right', !c.item && 'opacity-40')}
                        value={block.qty[cellKey(c.colour, s.id)] ?? ''}
                        disabled={!c.item}
                        onValueChange={(v) => onChange((b) => ({ ...b, qty: { ...b.qty, [cellKey(c.colour, s.id)]: v } }))}
                        aria-label={`Pieces of ${c.colour} size ${s.code}`}
                      />
                    </td>
                  ))}
                  <td className="text-foreground px-3 py-1.5 text-right font-semibold tabular-nums">{pieces(c.colour) || ''}</td>
                  <td className="text-foreground px-3 py-1.5 text-right tabular-nums">{valueOf(c.colour) ? money(valueOf(c.colour)) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-foreground font-medium">Lot / Batch No.</span>
          <input className="form-input" value={block.lot} onChange={(e) => onChange((b) => ({ ...b, lot: e.target.value }))} placeholder="Optional" aria-label={`Lot for ${style.code}`} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-foreground font-medium">Bundle / Barcode No.</span>
          <input className="form-input" value={block.bundle} onChange={(e) => onChange((b) => ({ ...b, bundle: e.target.value }))} placeholder="Optional" aria-label={`Bundle for ${style.code}`} />
        </label>
      </div>
      {note && <p className="text-xs text-emerald-500">{note}</p>}
      {problems && (
        <ul className="space-y-0.5 text-xs text-red-400">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
