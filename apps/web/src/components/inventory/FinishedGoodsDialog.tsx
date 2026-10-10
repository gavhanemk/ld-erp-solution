'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Loader2, PackagePlus, Plus, Shirt, Trash2, Warehouse as WarehouseIcon, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { fetchEveryPage } from '@/lib/export'
import { formatRupees } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { SizeQtyGrid, sumSizes, type SizeOption } from '@/components/sales/SizeQtyGrid'

interface ItemOption {
  id: string
  code: string
  name: string
  color: string | null
  styleId: string | null
}
interface StyleOption {
  id: string
  sizeGroupId: string | null
}
interface SizeGroupOption {
  id: string
  sizes: Array<SizeOption & { sequence: number }>
}
interface WarehouseOption {
  id: string
  name: string
}
interface OrderOption {
  id: string
  soNumber: string
  status: string
  customer: { name: string }
}
type Rate = { rate: number; source: 'BOM' | 'STANDARD'; bomVersion: string | null } | null

interface LineDraft {
  key: string
  itemId: string
  sizes: Record<string, string>
  qty: string
}

let lineKey = 0
const blankLine = (): LineDraft => ({ key: `f${++lineKey}`, itemId: '', sizes: {}, qty: '' })
const today = () => new Date().toISOString().slice(0, 10)

/**
 * Finished goods in: packed pieces into the finished-goods store, by item and
 * size. Each piece goes in at the style's approved BOM cost, else the item's
 * standard rate; the form shows which before anything is saved, and an item
 * with neither cannot be put in until one is set.
 */
export function FinishedGoodsDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [items, setItems] = useState<ItemOption[]>([])
  const [styles, setStyles] = useState<StyleOption[]>([])
  const [sizeGroups, setSizeGroups] = useState<SizeGroupOption[]>([])
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([])
  const [orders, setOrders] = useState<OrderOption[]>([])
  const [loading, setLoading] = useState(false)

  const [warehouseId, setWarehouseId] = useState('')
  const [receiptDate, setReceiptDate] = useState(today())
  const [soId, setSoId] = useState('')
  /** The manufacturing order packed for, among the order's open ones. */
  const [moId, setMoId] = useState('')
  const [mos, setMos] = useState<Array<{ id: string; moNumber: string; totalPlannedQty: number; totalPackedQty: number }>>([])
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([blankLine()])
  const [rates, setRates] = useState<Record<string, Rate>>({})

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * An order picked: its manufacturing orders on the floor, so the pieces
   * count as packed against the right one. With exactly one, it is picked.
   * Someone without production rights simply does not see the box.
   */
  const pickOrder = (id: string) => {
    setSoId(id)
    setMoId('')
    setMos([])
    if (!id) return
    api
      .get<{ data: Array<{ id: string; moNumber: string; status: string; totalPlannedQty: number; totalPackedQty: number }> }>(
        `/production/orders?soId=${id}&limit=50`
      )
      .then((res) => {
        const live = res.data.filter((m) => !['DRAFT', 'CLOSED', 'COMPLETED'].includes(m.status))
        setMos(live)
        if (live.length === 1) setMoId(live[0].id)
      })
      .catch(() => {})
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose, saving])

  useEffect(() => {
    if (!open) return
    let alive = true
    setError(null)
    setReceiptDate(today())
    setSoId('')
    setMoId('')
    setMos([])
    setNotes('')
    setLines([blankLine()])
    setRates({})
    setLoading(true)
    void (async () => {
      try {
        const [it, st, sg, wh, so] = await Promise.all([
          fetchEveryPage<ItemOption>((p) => `/masters/items?type=FINISHED_GOOD&active=true&limit=200&page=${p}&sort=name&order=asc`),
          fetchEveryPage<StyleOption>((p) => `/masters/styles?limit=200&page=${p}`),
          fetchEveryPage<SizeGroupOption>((p) => `/masters/size-groups?limit=200&page=${p}`),
          api.get<{ data: WarehouseOption[] }>('/masters/warehouses?active=true&limit=100'),
          api.get<{ data: OrderOption[] }>('/sales/orders/options?open=1').catch(() => ({ data: [] as OrderOption[] })),
        ])
        if (!alive) return
        setItems(it.rows)
        setStyles(st.rows)
        setSizeGroups(sg.rows)
        setWarehouses(wh.data)
        setOrders(so.data.filter((o) => ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'].includes(o.status)))
        // The finished-goods store, when one is named so; otherwise the only one.
        const fg = wh.data.find((w) => /finish/i.test(w.name)) ?? (wh.data.length === 1 ? wh.data[0] : null)
        setWarehouseId(fg?.id ?? '')
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err.message : 'Could not load the items, sizes and stores.')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open])

  // The value each picked item goes in at, asked of the server as items are picked.
  const pickedIds = useMemo(() => [...new Set(lines.map((l) => l.itemId).filter(Boolean))].sort().join(','), [lines])
  useEffect(() => {
    if (!open || !pickedIds) return
    let alive = true
    api
      .get<{ data: Record<string, Rate> }>(`/finished-goods/rates?itemIds=${pickedIds}`)
      .then((res) => alive && setRates((r) => ({ ...r, ...res.data })))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open, pickedIds])

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const groupOfStyle = useMemo(() => new Map(styles.map((s) => [s.id, s.sizeGroupId])), [styles])
  const sizesOfGroup = useMemo(
    () => new Map(sizeGroups.map((g) => [g.id, [...g.sizes].sort((a, b) => a.sequence - b.sequence)])),
    [sizeGroups]
  )
  const runOf = (item: ItemOption | undefined): SizeOption[] | null => {
    const g = item?.styleId ? groupOfStyle.get(item.styleId) : null
    const run = g ? sizesOfGroup.get(g) : null
    return run && run.length ? run : null
  }

  const priced = lines.map((l) => {
    const item = itemById.get(l.itemId)
    const run = runOf(item)
    const qty = run ? sumSizes(l.sizes) : Number(l.qty) || 0
    const rate = l.itemId ? rates[l.itemId] : undefined
    return { line: l, item, run, qty, rate, value: rate ? qty * rate.rate : 0 }
  })
  const filled = priced.filter((p) => p.line.itemId)
  const pieces = filled.reduce((s, p) => s + p.qty, 0)
  const value = filled.reduce((s, p) => s + p.value, 0)

  const blocker = !warehouseId
    ? 'Pick the finished-goods store.'
    : filled.length === 0
      ? 'Add at least one item.'
      : filled.find((p) => p.qty <= 0)
        ? `Put in the pieces for ${filled.find((p) => p.qty <= 0)!.item?.code}.`
        : filled.find((p) => p.rate === null)
          ? `${filled.find((p) => p.rate === null)!.item?.code} has no approved BOM cost and no standard rate, so it cannot be valued.`
          : null

  const setLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    // One receipt line per item and size, the way stock holds it.
    const body = {
      receiptDate,
      warehouseId,
      soId: soId || null,
      moId: moId || null,
      notes: notes.trim() || null,
      lines: filled.flatMap((p): Array<{ itemId: string; sizeId: string | null; qty: number }> =>
        p.run
          ? p.run
              .map((s) => ({ itemId: p.line.itemId, sizeId: s.id, qty: Number(p.line.sizes[s.id]) || 0 }))
              .filter((x) => x.qty > 0)
          : [{ itemId: p.line.itemId, sizeId: null, qty: p.qty }]
      ),
    }
    try {
      const res = await api.post<{ message?: string }>('/finished-goods', body)
      onSaved(res.message ?? 'Finished goods put into stock.')
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the receipt.')
    } finally {
      setSaving(false)
    }
  }

  if (!open || !mounted) return null

  const rateWords = (r: Rate | undefined) =>
    r === undefined ? '…' : r === null ? 'No rate' : `₹${r.rate.toLocaleString('en-IN')} · ${r.source === 'BOM' ? `BOM v${r.bomVersion}` : 'standard rate'}`

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="fgr-title">
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <PackagePlus size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="fgr-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                Finished Goods In
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                Packed pieces into the finished-goods store · the number is given when you save
              </p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={saving}>
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
              <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}
          {loading ? (
            <div className="skeleton h-64 w-full rounded-xl" />
          ) : (
            <>
              <Section icon={WarehouseIcon} title="Where and when">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <label className="min-w-0">
                    <span className="form-label">Finished-goods store</span>
                    <SmartSelect className="form-input" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                      <option value="">Choose a store</option>
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  <label className="min-w-0">
                    <span className="form-label">Date packed</span>
                    <input type="date" className="form-input" value={receiptDate} max={today()} onChange={(e) => setReceiptDate(e.target.value || today())} />
                  </label>
                  <label className="min-w-0">
                    <span className="form-label">Packed for order (optional)</span>
                    <SmartSelect className="form-input" value={soId} onChange={(e) => pickOrder(e.target.value)}>
                      <option value="">Not for one order</option>
                      {orders.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.soNumber} · {o.customer.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  {mos.length > 0 && (
                    <label className="min-w-0">
                      <span className="form-label">Manufacturing order</span>
                      <SmartSelect className="form-input" value={moId} onChange={(e) => setMoId(e.target.value)}>
                        <option value="">Not against one</option>
                        {mos.map((m) => (
                          <option key={m.id} value={m.id} data-sub={`${m.totalPackedQty} of ${m.totalPlannedQty} pcs packed`}>
                            {m.moNumber}
                          </option>
                        ))}
                      </SmartSelect>
                    </label>
                  )}
                  <label className="min-w-0 md:col-span-3">
                    <span className="form-label">Notes</span>
                    <input className="form-input" maxLength={500} value={notes} placeholder="Carton numbers, packing lot" onChange={(e) => setNotes(e.target.value)} />
                  </label>
                </div>
              </Section>

              <Section
                icon={Shirt}
                title="Pieces packed"
                actions={<span className="text-muted-foreground text-xs tabular-nums">{pieces.toLocaleString('en-IN')} pcs · {formatRupees(value)}</span>}
              >
                <div className="space-y-3">
                  {priced.map((p, i) => (
                    <div key={p.line.key} className="border-border bg-card space-y-2.5 rounded-lg border p-3">
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="min-w-0 flex-1 basis-64">
                          <span className="form-label">Item (style and colour)</span>
                          <SmartSelect
                            className="form-input"
                            value={p.line.itemId}
                            onChange={(e) => setLine(p.line.key, { itemId: e.target.value, sizes: {}, qty: '' })}
                            aria-label={`Line ${i + 1} item`}
                          >
                            <option value="">Choose an item</option>
                            {items.map((it) => (
                              <option key={it.id} value={it.id}>
                                {it.code} — {it.name}
                                {it.color ? ` (${it.color})` : ''}
                              </option>
                            ))}
                          </SmartSelect>
                        </label>
                        <div className="text-xs">
                          <span className="form-label">Value per piece</span>
                          <span className={`block py-2 tabular-nums ${p.rate === null ? 'warn-text' : 'text-foreground'}`}>
                            {p.line.itemId ? rateWords(p.rate) : '—'}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn-ghost mb-0.5 p-2"
                          aria-label={`Remove line ${i + 1}`}
                          onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== p.line.key) : [blankLine()]))}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                      {p.line.itemId &&
                        (p.run ? (
                          <SizeQtyGrid
                            sizes={p.run}
                            values={p.line.sizes}
                            name={`Line ${i + 1}`}
                            onChange={(sizeId, v) => setLine(p.line.key, { sizes: { ...p.line.sizes, [sizeId]: v } })}
                          />
                        ) : (
                          <input
                            className="form-input w-32 text-right tabular-nums"
                            inputMode="numeric"
                            value={p.line.qty}
                            placeholder="Pieces"
                            aria-label={`Line ${i + 1} pieces`}
                            title="This item's style has no size run, so the pieces are one figure"
                            onChange={(e) => setLine(p.line.key, { qty: e.target.value.replace(/[^\d]/g, '') })}
                          />
                        ))}
                      {p.line.itemId && (
                        <p className="text-muted-foreground text-[11px] tabular-nums">
                          {p.qty.toLocaleString('en-IN')} pcs{p.rate ? ` · ${formatRupees(p.value)}` : ''}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                <button type="button" className="btn-secondary mt-3" onClick={() => setLines((ls) => [...ls, blankLine()])}>
                  <Plus size={15} /> Add item
                </button>
              </Section>
            </>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3.5">
          {blocker && !loading && (
            <p className="warn-text mr-auto flex max-w-xl basis-full items-start gap-1.5 text-xs sm:basis-auto">
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>{blocker}</span>
            </p>
          )}
          <button type="button" onClick={onClose} className="btn-secondary hidden sm:inline-flex" disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || loading || !!blocker}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <PackagePlus size={15} />} Put into stock
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
