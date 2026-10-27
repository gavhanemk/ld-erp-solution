'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Filter, Loader2, Package, X } from 'lucide-react'
import { api } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { Scanner } from './Scanner'
import { STATUS, qtyText } from './packageTypes'

/** One sticker as the search hands it back: what it is, where it came from, where it went. */
export interface FoundPackage {
  id: string
  code: string
  status: string
  qty: number
  unit: string
  packType: string
  item: { id: string; code: string; name: string }
  store: string
  rack: string | null
  lotNo: string | null
  owner: string | null
  came: { ref: string | null; date: string | null; challan: string | null; po: string | null; from: string | null }
  went: Array<{ mr: string; department: string | null; mo: string | null; so: string | null }>
}

type Params = Record<string, string | undefined>

const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '')
const query = (p: Params) => {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(p)) if (v) qs.set(k, v)
  return qs.toString()
}

/** "In stock", or for one emptied by an issue, "Issued". */
export const statusOf = (p: FoundPackage) =>
  p.status === 'EMPTY' && p.went.length ? { label: 'Issued', cls: 'badge-neutral' } : (STATUS[p.status] ?? { label: p.status, cls: 'badge-neutral' })

/** Where it came from, in one line: GRN-0001 · challan BPF/DC/2210 · PO-0001 · Bhiwandi Powerloom. */
export const cameLine = (p: FoundPackage) =>
  [p.came.ref, p.came.challan ? `challan ${p.came.challan}` : null, p.came.po, p.came.from].filter(Boolean).join(' · ')

/** Where it went, in one line: MR-2627-0001 → MO-2627-0001 (SO-2627-0001). */
export const wentLine = (p: FoundPackage) =>
  p.went.map((w) => [w.mr, w.mo ? `→ ${w.mo}` : null, w.so ? `(${w.so})` : null].filter(Boolean).join(' ')).join(', ')

/** A typed sticker number as the code it is: "57", "pk 57" → PK-0057 (the server also finds an older PK-000057). */
const asCode = (t: string) => {
  const m = t.trim().match(/^(?:pk)?[-\s]?(\d{1,9})$/i)
  return m ? `PK-${String(Number(m[1])).padStart(4, '0')}` : null
}
/** What a scanner gun or a phone's QR reader sends: left alone, never second-guessed. */
const looksScanned = (t: string) => /^https?:\/\//i.test(t.trim()) || /^(PK|G)-?\d{4,}$/i.test(t.trim())

/**
 * The scan box, with the stickers that match what is being typed listed under
 * it: part of the item, a lot, a rack, the GRN, challan, PO or supplier it came
 * on, the requisition, MO or order it went to. Scanning works as before; a
 * typed word and Enter takes the first match, the arrows move through them.
 */
export function StickerScanner({
  onCode,
  busy,
  placeholder = 'Scan a sticker, or type an item, lot, rack, challan, PO, supplier or MO',
  focusKey,
  status = 'ALL',
  itemIds,
  warehouseId,
}: {
  onCode: (code: string) => void
  busy?: boolean
  placeholder?: string
  focusKey?: number
  status?: 'IN_STOCK' | 'ALL'
  /** Only these items: what a requisition still asks for. */
  itemIds?: string[]
  warehouseId?: string
}) {
  const [text, setText] = useState('')
  const [hits, setHits] = useState<{ for: string; list: FoundPackage[] } | null>(null)
  const [searching, setSearching] = useState(false)
  const [active, setActive] = useState(-1)
  // A fresh box after a pick from the list, so what was typed goes.
  const [round, setRound] = useState(0)
  const items = itemIds?.join(',')

  useEffect(() => {
    const t = text.trim()
    setActive(-1)
    if (t.length < 2 || looksScanned(t)) {
      setHits(null)
      return
    }
    let live = true
    setSearching(true)
    const timer = setTimeout(() => {
      api
        .get<{ data: FoundPackage[] }>(`/packages/find?${query({ q: t, status, itemIds: items, warehouseId, limit: '12' })}`)
        .then((r) => live && setHits({ for: t, list: r.data }))
        .catch(() => live && setHits({ for: t, list: [] }))
        .finally(() => live && setSearching(false))
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [text, status, items, warehouseId])

  const list = hits && hits.for === text.trim() ? hits.list : null
  const pick = (code: string) => {
    setText('')
    setHits(null)
    setRound((r) => r + 1)
    onCode(code)
  }
  // Enter: the highlighted one; else the sticker whose number was typed; else, for a
  // typed word, the first match — but only matches for what is in the box now, so a
  // fast scanner gun is never answered with what it had typed half-way.
  const submit = (typed: string) => {
    const t = typed.trim()
    if (list && active >= 0 && list[active]) return pick(list[active].code)
    const code = asCode(t)
    if (code && list?.some((h) => h.code === code)) return pick(code)
    if (!looksScanned(t) && !code && list?.length) return pick(list[0].code)
    setText('')
    setHits(null)
    onCode(t)
  }
  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!list?.length) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (e.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : Math.max(-1, i - 1)))
      return true
    }
    if (e.key === 'Escape') {
      // Closes the list only; the window around it stays open.
      e.preventDefault()
      e.stopPropagation()
      setHits(null)
      return true
    }
    return false
  }

  return (
    <Scanner
      key={round}
      onCode={submit}
      busy={busy}
      placeholder={placeholder}
      focusKey={focusKey}
      onType={setText}
      onKeyDown={keys}
      suggestions={
        text.trim().length >= 2 && !looksScanned(text) ? (
          <div className="glass-card absolute left-0 right-0 top-full z-30 mt-1 max-h-96 overflow-y-auto p-1 shadow-xl sm:right-[12.5rem]" role="listbox" aria-label="Matching stickers">
            {list?.length ? (
              list.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(p.code)}
                  className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left ${i === active ? 'bg-primary/10' : 'hover:bg-secondary'}`}
                >
                  <span className="bg-primary/10 text-primary mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                    <Package size={15} />
                  </span>
                  <FoundText p={p} />
                </button>
              ))
            ) : (
              <p className="text-muted-foreground px-3 py-3 text-sm">{searching || !list ? 'Looking…' : `No sticker matches “${text.trim()}”.`}</p>
            )}
          </div>
        ) : null
      }
    />
  )
}

/** A found sticker in two lines. */
function FoundText({ p }: { p: FoundPackage }) {
  const st = statusOf(p)
  return (
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-foreground font-mono text-sm font-semibold">{p.code}</span>
        <span className="text-foreground truncate text-sm">{p.item.name}</span>
        <span className="text-foreground text-sm font-semibold tabular-nums">
          {p.status === 'IN_STOCK' ? `${qtyText(p.qty)} ${p.unit}` : ''}
        </span>
        <span className={`${st.cls} text-[10px]`}>{st.label}</span>
      </span>
      <span className="text-muted-foreground block truncate text-xs">
        {[p.store + (p.rack ? ` · rack ${p.rack}` : ''), p.lotNo ? `lot ${p.lotNo}` : null, cameLine(p), p.went.length ? `went ${wentLine(p)}` : null].filter(Boolean).join(' · ')}
      </span>
    </span>
  )
}

// ── Find by details ─────────────────────────────────────────────────────────

interface Options {
  items: Array<{ id: string; code: string; name: string }>
  stores: Array<{ id: string; name: string }>
  suppliers: Array<{ id: string; name: string }>
  pos: Array<{ id: string; poNumber: string; supplierId: string }>
  receipts: Array<{ id: string; number: string; challan: string | null; date: string; from: string; poId: string | null; supplierId: string | null; soId: string | null }>
  lots: string[]
  racks: string[]
  sos: Array<{ id: string; soNumber: string; customer: string }>
  mos: Array<{ id: string; moNumber: string; soId: string | null }>
}

const KEYS = ['itemId', 'warehouseId', 'supplierId', 'poId', 'grnId', 'lot', 'rack', 'soId', 'moId'] as const
type Picks = Record<(typeof KEYS)[number], string> & { status: 'IN_STOCK' | 'ALL' }
const EMPTY: Picks = { itemId: '', warehouseId: '', supplierId: '', poId: '', grnId: '', lot: '', rack: '', soId: '', moId: '', status: 'ALL' }

/**
 * Finding stickers from whatever is known about them, one dropdown a detail:
 * the item, the store or rack, the supplier, PO or challan it came on, the lot,
 * or the order or MO it went to. Each list offers only what stickers carry,
 * and a supplier narrows its POs and challans, an order its MOs.
 */
export function StickerFinder({ onOpen }: { onOpen: (code: string) => void }) {
  const [o, setO] = useState<Options | null>(null)
  const [f, setF] = useState<Picks>(EMPTY)
  const [rows, setRows] = useState<FoundPackage[] | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const latest = useRef(0)

  useEffect(() => {
    api
      .get<{ data: Options }>('/packages/find/options')
      .then((r) => setO(r.data))
      .catch(() => setO({ items: [], stores: [], suppliers: [], pos: [], receipts: [], lots: [], racks: [], sos: [], mos: [] }))
  }, [])

  const any = KEYS.some((k) => f[k])
  useEffect(() => {
    if (!any) {
      setRows(null)
      return
    }
    const ticket = ++latest.current
    setLoading(true)
    api
      .get<{ data: FoundPackage[]; total: number }>(`/packages/find?${query({ ...f, limit: '100' })}`)
      .then((r) => {
        if (ticket !== latest.current) return
        setRows(r.data)
        setTotal(r.total)
      })
      .catch(() => ticket === latest.current && setRows([]))
      .finally(() => ticket === latest.current && setLoading(false))
  }, [f, any])

  const set = (patch: Partial<Picks>) => setF((x) => ({ ...x, ...patch }))
  const pos = useMemo(() => (o?.pos ?? []).filter((p) => !f.supplierId || p.supplierId === f.supplierId), [o, f.supplierId])
  const receipts = useMemo(
    () => (o?.receipts ?? []).filter((r) => (!f.supplierId || r.supplierId === f.supplierId) && (!f.poId || r.poId === f.poId)),
    [o, f.supplierId, f.poId],
  )
  const mos = useMemo(() => (o?.mos ?? []).filter((m) => !f.soId || m.soId === f.soId), [o, f.soId])
  const cls = 'form-input h-9 px-2 py-0 text-sm'
  const box = (label: string, el: React.ReactNode) => (
    <label className="block min-w-0">
      <span className="text-muted-foreground mb-0.5 block text-[11px] font-semibold uppercase tracking-wide">{label}</span>
      {el}
    </label>
  )

  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Filter size={15} className="text-primary" />
        <h3 className="text-foreground text-sm font-semibold">Find by details</h3>
        <span className="text-muted-foreground text-xs">Pick whatever you know — the rest narrows itself.</span>
        {any && (
          <button type="button" className="btn-ghost ml-auto h-8 px-2 text-xs" onClick={() => setF(EMPTY)}>
            <X size={14} /> Clear
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-5">
        {box(
          'Item',
          <SmartSelect className={cls} value={f.itemId} onChange={(e) => set({ itemId: e.target.value })} aria-label="Item">
            <option value="">Any item</option>
            {o?.items.map((i) => (
              <option key={i.id} value={i.id} data-sub={i.code}>
                {i.name}
              </option>
            ))}
          </SmartSelect>,
        )}
        {box(
          'Supplier',
          <SmartSelect className={cls} value={f.supplierId} onChange={(e) => set({ supplierId: e.target.value, poId: '', grnId: '' })} aria-label="Supplier">
            <option value="">Any supplier</option>
            {o?.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SmartSelect>,
        )}
        {box(
          'Purchase order',
          <SmartSelect className={cls} value={f.poId} onChange={(e) => set({ poId: e.target.value, grnId: '' })} aria-label="Purchase order">
            <option value="">Any PO</option>
            {pos.map((p) => (
              <option key={p.id} value={p.id} data-sub={o?.suppliers.find((s) => s.id === p.supplierId)?.name}>
                {p.poNumber}
              </option>
            ))}
          </SmartSelect>,
        )}
        {box(
          'Challan / GRN',
          <SmartSelect className={cls} value={f.grnId} onChange={(e) => set({ grnId: e.target.value })} aria-label="Challan or GRN">
            <option value="">Any receipt</option>
            {receipts.map((r) => (
              <option key={r.id} value={r.id} data-sub={[r.number, day(r.date), r.from].filter(Boolean).join(' · ')}>
                {r.challan ? `Challan ${r.challan}` : r.number}
              </option>
            ))}
          </SmartSelect>,
        )}
        {box(
          'Lot',
          <SmartSelect className={cls} value={f.lot} onChange={(e) => set({ lot: e.target.value })} aria-label="Lot">
            <option value="">Any lot</option>
            {o?.lots.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </SmartSelect>,
        )}
        {box(
          'Store',
          <SmartSelect className={cls} value={f.warehouseId} onChange={(e) => set({ warehouseId: e.target.value })} aria-label="Store">
            <option value="">Any store</option>
            {o?.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SmartSelect>,
        )}
        {box(
          'Rack',
          <SmartSelect className={cls} value={f.rack} onChange={(e) => set({ rack: e.target.value })} aria-label="Rack">
            <option value="">Any rack</option>
            {o?.racks.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </SmartSelect>,
        )}
        {box(
          'Sales order',
          <SmartSelect className={cls} value={f.soId} onChange={(e) => set({ soId: e.target.value, moId: '' })} aria-label="Sales order">
            <option value="">Any order</option>
            {o?.sos.map((s) => (
              <option key={s.id} value={s.id} data-sub={s.customer}>
                {s.soNumber}
              </option>
            ))}
          </SmartSelect>,
        )}
        {box(
          'MO',
          <SmartSelect className={cls} value={f.moId} onChange={(e) => set({ moId: e.target.value })} aria-label="Manufacturing order">
            <option value="">Any MO</option>
            {mos.map((m) => (
              <option key={m.id} value={m.id}>
                {m.moNumber}
              </option>
            ))}
          </SmartSelect>,
        )}
        {box(
          'Show',
          <SmartSelect className={cls} value={f.status} onChange={(e) => set({ status: e.target.value as Picks['status'] })} aria-label="Show">
            <option value="ALL">Everything</option>
            <option value="IN_STOCK">Only in stock</option>
          </SmartSelect>,
        )}
      </div>

      {any && (
        <div className="border-border border-t">
          {loading && !rows ? (
            <p className="text-muted-foreground flex items-center gap-2 px-4 py-6 text-sm">
              <Loader2 size={14} className="animate-spin" /> Finding the stickers…
            </p>
          ) : !rows?.length ? (
            <p className="text-muted-foreground px-4 py-6 text-center text-sm">No sticker has all of that. Clear a detail or two.</p>
          ) : (
            <>
              <p className="text-muted-foreground px-4 pt-2 text-xs">
                {total > rows.length ? `The first ${rows.length} of ${total} stickers` : `${total} ${total === 1 ? 'sticker' : 'stickers'}`} — open one to see it, issue it or move it.
              </p>
              <div className="hidden overflow-x-auto md:block">
                <table className="data-table table-compact w-full">
                  <thead>
                    <tr className="bg-secondary">
                      <th>Sticker</th>
                      <th>Item</th>
                      <th style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>In it</th>
                      <th>Store · rack</th>
                      <th>Lot</th>
                      <th>Came in on</th>
                      <th>Went to</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p, n) => {
                      const st = statusOf(p)
                      return (
                        <tr key={p.id} className="cursor-pointer" onClick={() => onOpen(p.code)} data-row tabIndex={n === 0 ? 0 : -1}>
                          <td className="text-primary whitespace-nowrap font-mono text-xs font-semibold">{p.code}</td>
                          <td>
                            <span className="text-foreground">{p.item.name}</span>
                            <span className="text-muted-foreground block font-mono text-[11px]">{p.item.code}</span>
                          </td>
                          <td className="whitespace-nowrap text-right tabular-nums">{p.status === 'IN_STOCK' ? `${qtyText(p.qty)} ${p.unit}` : '—'}</td>
                          <td className="whitespace-nowrap text-sm">
                            {p.store}
                            {p.rack && <span className="text-muted-foreground"> · {p.rack}</span>}
                          </td>
                          <td className="whitespace-nowrap text-sm">{p.lotNo ?? <span className="text-muted-foreground">—</span>}</td>
                          <td className="text-xs">
                            <span className="text-foreground">{p.came.ref}</span>
                            <span className="text-muted-foreground block">{[p.came.challan ? `challan ${p.came.challan}` : null, p.came.po, p.came.from].filter(Boolean).join(' · ')}</span>
                          </td>
                          <td className="text-xs">
                            {p.went.length ? (
                              p.went.map((w) => (
                                <span key={w.mr} className="block whitespace-nowrap">
                                  <span className="text-foreground">{[w.mo, w.so].filter(Boolean).join(' · ') || w.mr}</span>
                                  <span className="text-muted-foreground block">{[w.mr, w.department].filter(Boolean).join(' · ')}</span>
                                </span>
                              ))
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td>
                            <span className={st.cls}>{st.label}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="divide-border/60 divide-y md:hidden">
                {rows.map((p) => (
                  <button key={p.id} type="button" onClick={() => onOpen(p.code)} className="hover:bg-secondary/60 flex w-full items-start gap-3 px-4 py-3 text-left">
                    <FoundText p={p} />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
