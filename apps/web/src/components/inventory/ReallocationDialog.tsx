'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRightLeft, Plus, Trash2 } from 'lucide-react'
import { api, apiErrorMessage, masterResource } from '@/lib/api'
import { newRequestId } from '@/lib/utils'
import { everyItem, itemShade, type ShadeFields } from '@/lib/items'
import { loadInHouseBrands, type OwnBrand } from '@/components/sales/brand'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

type Kind = 'EARMARK' | 'MOVE' | 'RELEASE'
interface Store {
  id: string
  name: string
  kind?: string
}
type Item = ShadeFields & { id: string; code: string; name: string; uom?: { symbol: string } | null }
interface HeldRow {
  itemId: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  sizeId: string | null
  sizeCode: string | null
  grade?: string
  brandId?: string | null
  qty: number
}
interface ShareInfo {
  brandId: string | null
  share: string
  qty: number
  held: number
  free: number
  avgRate: number
  loose: number
  stickers: Array<{ code: string; qty: number; lotNo: string | null; rack: string | null; onRoll: string | null }>
  tags: string[]
}
interface Line {
  key: string
  pick: string
  qty: string
  stickers: string[]
  tags: string
}

const KINDS: Array<{ kind: Kind; label: string; hint: string }> = [
  { kind: 'EARMARK', label: 'Earmark for a brand', hint: 'Central stock set aside for one brand' },
  { kind: 'MOVE', label: 'Move between brands', hint: 'One brand’s earmark handed to another' },
  { kind: 'RELEASE', label: 'Release to central', hint: 'A brand’s earmark given back' },
]

const pickKey = (h: Pick<HeldRow, 'itemId' | 'sizeId' | 'grade'>) => `${h.itemId}|${h.sizeId ?? ''}|${h.grade ?? 'A'}`
const parsePick = (k: string) => {
  const [itemId, sizeId, grade] = k.split('|')
  return { itemId, sizeId: sizeId || null, grade: grade || 'A' }
}
const emptyLine = (): Line => ({ key: Math.random().toString(36).slice(2), pick: '', qty: '', stickers: [], tags: '' })
const splitCodes = (t: string) => [...new Set(t.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))]
const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Raising a Stock Reallocation: central stock earmarked for a brand, one
 * brand's stock handed to another, or an earmark released. Nothing moves on
 * the rack; it waits for someone other than its maker to approve it.
 */
export function ReallocationDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string, id: string) => void }) {
  const [kind, setKind] = useState<Kind>('EARMARK')
  const [stores, setStores] = useState<Store[]>([])
  const [brands, setBrands] = useState<OwnBrand[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [warehouseId, setWarehouseId] = useState('')
  const [fromBrandId, setFromBrandId] = useState('')
  const [toBrandId, setToBrandId] = useState('')
  const [reason, setReason] = useState('')
  const [held, setHeld] = useState<HeldRow[]>([])
  const [shares, setShares] = useState<Record<string, ShareInfo[]>>({})
  const [lines, setLines] = useState<Line[]>([emptyLine()])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(newRequestId())

  useEffect(() => {
    void (async () => {
      try {
        const [w, b, i] = await Promise.all([
          masterResource<Store>('warehouses').list({ limit: 100, active: true }),
          loadInHouseBrands(),
          everyItem<Item>({ active: true, sort: 'name', order: 'asc' }),
        ])
        const real = w.data.filter((x) => x.kind !== 'TRANSIT')
        setStores(real)
        if (real.length === 1) setWarehouseId(real[0].id)
        setBrands(b)
        setItems(i)
      } catch (err) {
        setError(apiErrorMessage(err, 'Could not load stores, brands and items.'))
      }
    })()
  }, [])

  // What the store holds, share by share: the giving share's items are offered.
  useEffect(() => {
    if (!warehouseId) return setHeld([])
    api
      .get<{ data: HeldRow[] }>(`/inventory/held?warehouseId=${warehouseId}&grades=all&shares=1`)
      .then((r) => setHeld(r.data.filter((h) => h.ownership === 'OWNED')))
      .catch(() => setHeld([]))
    setShares({})
  }, [warehouseId])

  const giving = kind === 'EARMARK' ? null : fromBrandId || undefined
  const offered = useMemo(() => (giving === undefined ? [] : held.filter((h) => (h.brandId ?? null) === giving)), [held, giving])
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const brandName = (id: string | null) => (id ? (brands.find((b) => b.id === id)?.name ?? 'a brand') : 'Central stock')

  // Each picked balance's shares, for what is free, its stickers and its tags.
  useEffect(() => {
    if (!warehouseId) return
    const want = [...new Set(lines.map((l) => l.pick).filter(Boolean))].filter((k) => !(k in shares))
    if (!want.length) return
    void Promise.all(
      want.map(async (k) => {
        const p = parsePick(k)
        const qs = new URLSearchParams({ warehouseId, itemId: p.itemId, grade: p.grade })
        if (p.sizeId) qs.set('sizeId', p.sizeId)
        try {
          return [k, (await api.get<{ data: ShareInfo[] }>(`/inventory/reallocations/shares?${qs}`)).data] as const
        } catch {
          return [k, [] as ShareInfo[]] as const
        }
      }),
    ).then((got) => setShares((s) => ({ ...s, ...Object.fromEntries(got) })))
  }, [lines, warehouseId, shares])

  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const shareOf = (l: Line) => (l.pick ? (shares[l.pick] ?? []).find((s) => s.brandId === (giving ?? null)) : undefined)

  const problem = (() => {
    if (!warehouseId) return 'Pick the store'
    if (kind !== 'EARMARK' && !fromBrandId) return 'Pick the brand it comes from'
    if (kind !== 'RELEASE' && !toBrandId) return 'Pick the brand it goes to'
    if (kind === 'MOVE' && fromBrandId === toBrandId) return 'The two brands are the same'
    if (reason.trim().length < 5) return 'Say why, in a few words'
    const filled = lines.filter((l) => l.pick && Number(l.qty) > 0)
    if (!filled.length) return 'Add an item and how much'
    for (const l of filled) {
      const s = shareOf(l)
      const name = itemsById.get(parsePick(l.pick).itemId)?.name ?? 'An item'
      if (s && Number(l.qty) > s.free + 0.0005) return `${name}: only ${s.free} is free in ${s.share}`
      if (s && !parsePick(l.pick).sizeId) {
        const need = round3(Math.max(0, Number(l.qty) - s.loose))
        const named = round3(l.stickers.reduce((t, c) => t + (s.stickers.find((x) => x.code === c)?.qty ?? 0), 0))
        if (named + 0.0005 < need) return `${name}: tick rolls for at least ${need} (only ${s.loose} is loose)`
      }
      if (s && parsePick(l.pick).sizeId) {
        const need = Math.max(0, Math.ceil(Number(l.qty) - (s.qty - s.tags.length) - 1e-9))
        if (splitCodes(l.tags).length < need) return `${name}: scan at least ${need} of the pieces’ tags`
      }
    }
    return null
  })()

  const save = async () => {
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      const body = {
        kind,
        warehouseId,
        fromBrandId: kind === 'EARMARK' ? null : fromBrandId,
        toBrandId: kind === 'RELEASE' ? null : toBrandId,
        reason: reason.trim(),
        requestId: requestId.current,
        lines: lines
          .filter((l) => l.pick && Number(l.qty) > 0)
          .map((l) => {
            const p = parsePick(l.pick)
            return {
              itemId: p.itemId,
              sizeId: p.sizeId,
              grade: p.grade,
              qty: Number(l.qty),
              ...(l.stickers.length ? { packageCodes: l.stickers } : {}),
              ...(splitCodes(l.tags).length ? { garmentCodes: splitCodes(l.tags) } : {}),
            }
          }),
      }
      const res = await api.post<{ data: { id: string }; message: string }>('/inventory/reallocations', body)
      onSaved(res.message, res.data.id)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not raise it.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormFrame
      icon={ArrowRightLeft}
      title="Brand stock: earmark, move or release"
      subtitle="Nothing moves on the rack. Someone other than you approves it."
      width="max-w-5xl"
      busy={busy}
      error={error}
      onClose={onClose}
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Raise for approval'}
        </button>
      }
      footer={
        <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      }
      footerNote={problem ? <span className="text-amber-600">{problem}</span> : 'Value moves at the giving share’s average: the company’s stock and value do not change.'}
    >
      <div className="border-border bg-secondary flex flex-wrap gap-1 rounded-lg border p-1" role="radiogroup" aria-label="What it does">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={kind === k.kind}
            title={k.hint}
            onClick={() => {
              setKind(k.kind)
              setLines([emptyLine()])
            }}
            className={kind === k.kind ? 'bg-primary text-primary-foreground rounded-lg px-3 py-1.5 text-xs font-semibold' : 'text-muted-foreground rounded-lg px-3 py-1.5 text-xs'}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="form-label">Store</span>
          <SmartSelect className="form-input" value={warehouseId} onChange={(e) => (setWarehouseId(e.target.value), setLines([emptyLine()]))} aria-label="Store">
            <option value="">Choose a store…</option>
            {stores.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </SmartSelect>
        </label>
        {kind !== 'EARMARK' && (
          <label className="block">
            <span className="form-label">From brand</span>
            <SmartSelect className="form-input" value={fromBrandId} onChange={(e) => (setFromBrandId(e.target.value), setLines([emptyLine()]))} aria-label="From brand">
              <option value="">Choose a brand…</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SmartSelect>
          </label>
        )}
        {kind !== 'RELEASE' && (
          <label className="block">
            <span className="form-label">To brand</span>
            <SmartSelect className="form-input" value={toBrandId} onChange={(e) => setToBrandId(e.target.value)} aria-label="To brand">
              <option value="">Choose a brand…</option>
              {brands
                .filter((b) => b.id !== fromBrandId)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </SmartSelect>
          </label>
        )}
      </div>
      <label className="block">
        <span className="form-label">Why</span>
        <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Fabric for the Stich Code summer range" maxLength={500} />
      </label>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="data-table table-compact w-full min-w-[760px]">
          <thead>
            <tr>
              <th>Item, from {brandName(giving ?? null)}</th>
              <th className="w-56">In that share</th>
              <th className="w-36 text-right">Quantity</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const s = shareOf(l)
              const p = l.pick ? parsePick(l.pick) : null
              const item = p ? itemsById.get(p.itemId) : undefined
              const unit = item?.uom?.symbol ?? ''
              const need = s && p && !p.sizeId ? round3(Math.max(0, Number(l.qty || 0) - s.loose)) : 0
              return (
                <Fragment key={l.key}>
                  <tr>
                    <td>
                      <SmartSelect
                        className="form-input h-9"
                        value={l.pick}
                        onChange={(e) => setLine(l.key, { pick: e.target.value, stickers: [], tags: '' })}
                        aria-label={`Item on line ${i + 1}`}
                        disabled={!warehouseId || giving === undefined}
                      >
                        <option value="">{!warehouseId ? 'Pick the store first' : giving === undefined ? 'Pick the brand first' : offered.length ? 'Choose…' : 'Nothing in this share here'}</option>
                        {offered.map((h) => {
                          const it = itemsById.get(h.itemId)
                          return (
                            <option key={pickKey(h)} value={pickKey(h)}>
                              {it ? `${it.code} · ${it.name}` : h.itemId}
                              {itemShade(it) ? ` · ${itemShade(it)}` : ''}
                              {h.sizeCode ? ` · size ${h.sizeCode}` : ''}
                              {h.grade && h.grade !== 'A' ? ` · grade ${h.grade}` : ''} · {h.qty.toLocaleString('en-IN')} {it?.uom?.symbol ?? ''}
                            </option>
                          )
                        })}
                      </SmartSelect>
                    </td>
                    <td className="text-xs">
                      {s ? (
                        <>
                          {s.qty} {unit} · {s.free} free{s.held > 0 ? ` (${s.held} held)` : ''}
                          <span className="text-muted-foreground block">at ₹{s.avgRate.toLocaleString('en-IN')} each{!p?.sizeId ? ` · ${s.loose} loose` : ''}</span>
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="text-right">
                      <StepInput className="form-input h-9 text-right" value={l.qty} onValueChange={(v) => setLine(l.key, { qty: v })} decimals min={0} aria-label={`Quantity on line ${i + 1}`} />
                    </td>
                    <td>
                      {lines.length > 1 && (
                        <button type="button" className="btn-ghost h-8 px-2" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}>
                          <Trash2 size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                  {s && p && !p.sizeId && s.stickers.length > 0 && (
                    <tr>
                      <td colSpan={4} className="pb-2 pt-0">
                        <div className={`rounded-lg border p-2 ${need > 0 ? 'border-amber-500/60' : 'border-border'} bg-secondary/40`}>
                          <p className="text-xs font-medium">
                            Rolls · <span className="text-muted-foreground font-normal">{need > 0 ? `tick rolls for at least ${need} ${unit}; the last one ticked can go in part, riding on its roll as a sticker of its own` : 'loose stock covers it; tick rolls only if these are the ones'}</span>
                          </p>
                          <div className="mt-1.5 grid max-h-40 grid-cols-2 gap-x-3 overflow-y-auto sm:grid-cols-4">
                            {s.stickers.map((st) => (
                              <label key={st.code} className="flex items-center gap-1.5 font-mono text-[11px]">
                                <input
                                  type="checkbox"
                                  checked={l.stickers.includes(st.code)}
                                  onChange={(e) => setLine(l.key, { stickers: e.target.checked ? [...l.stickers, st.code] : l.stickers.filter((x) => x !== st.code) })}
                                />
                                {st.code} · {st.qty} {unit}
                                {st.lotNo ? ` · lot ${st.lotNo}` : ''}
                              </label>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  {s && p?.sizeId && s.tags.length > 0 && (
                    <tr>
                      <td colSpan={4} className="pb-2 pt-0">
                        <textarea
                          className="form-input min-h-[38px] w-full font-mono text-xs"
                          placeholder={`Scan the tags of the pieces moving (${s.tags.length} of the ${s.qty} here are tagged)`}
                          value={l.tags}
                          onChange={(e) => setLine(l.key, { tags: e.target.value })}
                          aria-label={`Tags on line ${i + 1}`}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn-ghost h-8 text-xs" onClick={() => setLines([...lines, emptyLine()])}>
        <Plus size={13} /> Another item
      </button>
    </FormFrame>
  )
}
