'use client'

import { useEffect, useMemo, useState } from 'react'
import { Boxes, Loader2, Plus, Printer, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { openPrintTab } from '@/components/packages/packageTypes'
import { printCartons, type Carton, type CartonOrder, type StockItem } from './cartonTypes'

/**
 * A carton packed from the finished pieces in a store: the store, the order
 * it is for (optional — its buyer and number go on the sticker), then each
 * style in it, its items down and sizes across, as many of each as go in.
 * Every box says how many are free: in the store and not already in a carton.
 */
export function PackCartonDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string, carton: Carton) => void }) {
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([])
  const [orders, setOrders] = useState<CartonOrder[]>([])
  const [storeId, setStoreId] = useState('')
  const [soId, setSoId] = useState('')
  const [stock, setStock] = useState<StockItem[] | null>(null)
  const [styleIds, setStyleIds] = useState<string[]>([])
  const [qty, setQty] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Array<{ id: string; name: string; departmentId?: string | null }> }>('/masters/warehouses?limit=200&active=true')
      .then((r) => {
        // Cartons are packed in a store, never on a process floor.
        const list = r.data.filter((w) => !w.departmentId)
        setStores(list)
        setStoreId((s) => s || (list.find((w) => /finish|\bfg\b/i.test(w.name)) ?? list.find((w) => /^store$/i.test(w.name)) ?? list[0])?.id || '')
      })
      .catch(() => setError('Could not load the stores.'))
    // The orders need sales access; without it a carton is packed for no order.
    api
      .get<{ data: CartonOrder[] }>('/fg-cartons/dispatch/orders')
      .then((r) => setOrders(r.data))
      .catch(() => setOrders([]))
  }, [])

  useEffect(() => {
    // Another store, or none: its own pieces, and nothing typed for the last one.
    setQty({})
    setStyleIds([])
    if (!storeId) {
      setStock([])
      return
    }
    setStock(null)
    api
      .get<{ data: StockItem[] }>(`/fg-cartons/stock?warehouseId=${storeId}`)
      .then((r) => setStock(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the stock.'))
  }, [storeId])

  const order = orders.find((o) => o.soId === soId) ?? null
  // Packed for an order: only its items.
  const usable = useMemo(() => (stock ?? []).filter((i) => i.sizes.some((z) => z.free > 0) && (!order || order.itemIds.includes(i.id))), [stock, order])
  const styles = useMemo(() => {
    const m = new Map<string, { id: string; code: string; name: string; items: StockItem[] }>()
    for (const i of usable) {
      const key = i.style?.id ?? `item:${i.id}`
      const s = m.get(key) ?? { id: key, code: i.style?.code ?? i.code, name: i.style?.name ?? i.name, items: [] }
      s.items.push(i)
      m.set(key, s)
    }
    return [...m.values()].sort((a, b) => a.code.localeCompare(b.code))
  }, [usable])

  const cell = (itemId: string, sizeId: string, grade: string) => `${itemId}|${sizeId}|${grade}`
  const lines = Object.entries(qty)
    .map(([k, v]) => {
      const [itemId, sizeId, grade] = k.split('|')
      return { itemId, sizeId, grade: grade as 'A' | 'B', qty: Math.floor(Number(v) || 0) }
    })
    .filter((l) => l.qty > 0)
  const pieces = lines.reduce((t, l) => t + l.qty, 0)

  const save = async (andPrint: boolean) => {
    if (!storeId) return setError('Pick the store.')
    if (!pieces) return setError('Put at least one piece in the carton.')
    const tab = andPrint ? openPrintTab() : null
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string; data: Carton }>('/fg-cartons', { warehouseId: storeId, soId: soId || null, notes: notes.trim() || null, lines })
      if (andPrint) printCartons([res.data.id], tab)
      onDone(res.message, res.data)
    } catch (err) {
      tab?.close()
      setError(err instanceof ApiError ? err.message : 'Could not pack the carton.')
      setBusy(false)
    }
  }

  return (
    <FormFrame
      icon={Boxes}
      title="Pack a carton"
      subtitle="Finished pieces from the store, under one carton sticker. The stock stays in the store until the carton is dispatched."
      onClose={onClose}
      busy={busy}
      error={error}
      width="max-w-5xl"
      primaryInHeader={false}
      primary={
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void save(false)}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Boxes size={15} />} Pack {pieces ? `${pieces} pcs` : ''}
        </button>
      }
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void save(true)}>
            <Printer size={15} /> Pack &amp; print sticker
          </button>
        </>
      }
      footerNote={<span>{pieces ? `${pieces} pcs in this carton` : 'Type how many of each go in.'}</span>}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-foreground font-medium">Store</span>
            <SmartSelect className="form-input" value={storeId} onChange={(e) => setStoreId(e.target.value)} aria-label="Store">
              <option value="">Pick the store…</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SmartSelect>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-foreground font-medium">For order (optional)</span>
            <SmartSelect
              className="form-input"
              value={soId}
              onChange={(e) => {
                setSoId(e.target.value)
                setQty({})
                setStyleIds([])
              }}
              aria-label="For order"
            >
              <option value="">No order — any buyer</option>
              {orders.map((o) => (
                <option key={o.soId} value={o.soId} data-sub={[o.customer, o.poRef ? `PO ${o.poRef}` : ''].filter(Boolean).join(' · ')}>
                  {o.soNumber}
                </option>
              ))}
            </SmartSelect>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-foreground font-medium">Note (optional)</span>
            <input className="form-input" value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. carton 3 of 10" aria-label="Note" />
          </label>
        </div>

        {!storeId ? (
          <p className="text-muted-foreground rounded-lg border border-dashed border-border p-6 text-center text-sm">Pick the store the carton is packed in.</p>
        ) : stock === null ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 size={15} className="animate-spin" /> Loading the store&apos;s finished pieces…
          </p>
        ) : !styles.length ? (
          <p className="text-muted-foreground rounded-lg border border-dashed border-border p-6 text-center text-sm">
            {order ? `No pieces of ${order.soNumber}'s items are free in this store.` : 'No finished pieces are free in this store: all are already in cartons, or none are here.'}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-foreground text-sm font-medium">Add a style</span>
              <SmartSelect
                className="form-input h-9 w-80"
                value=""
                onChange={(e) => e.target.value && setStyleIds((ids) => (ids.includes(e.target.value) ? ids : [...ids, e.target.value]))}
                aria-label="Add a style to the carton"
              >
                <option value="">Pick a style…</option>
                {styles
                  .filter((s) => !styleIds.includes(s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id} data-sub={`${s.name} · ${s.items.length} ${s.items.length === 1 ? 'item' : 'items'}`}>
                      {s.code}
                    </option>
                  ))}
              </SmartSelect>
              {styleIds.length === 0 && <span className="text-muted-foreground text-xs">One carton can hold several items and styles.</span>}
            </div>
            {styleIds.map((sid) => {
              const s = styles.find((x) => x.id === sid)
              if (!s) return null
              // The sizes any of its items has, in run order.
              const sizes = [...new Map(s.items.flatMap((i) => i.sizes).map((z) => [z.sizeId, z])).values()].sort((a, b) => a.sequence - b.sequence)
              const rows = s.items.flatMap((i) => [...new Set(i.sizes.map((z) => z.grade))].map((grade) => ({ item: i, grade })))
              return (
                <div key={sid} className="border-border space-y-2 rounded-xl border p-3" aria-label={`Carton style ${s.code}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-teal-400">{s.code}</span>
                    <span className="text-foreground text-sm">{s.name}</span>
                    <button
                      type="button"
                      className="btn-ghost ml-auto p-1"
                      onClick={() => {
                        setStyleIds((ids) => ids.filter((x) => x !== sid))
                        setQty((q) => Object.fromEntries(Object.entries(q).filter(([k]) => !s.items.some((i) => k.startsWith(`${i.id}|`)))))
                      }}
                      aria-label={`Remove ${s.code} from the carton`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="subtable text-sm">
                      <thead>
                        <tr className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
                          <th className="min-w-56 py-1.5 pr-3 text-left">Item</th>
                          {sizes.map((z) => (
                            <th key={z.sizeId} className="w-20 px-1 py-1.5 text-center">
                              {z.code}
                            </th>
                          ))}
                          <th className="px-3 py-1.5 text-right">Pcs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(({ item, grade }) => {
                          const rowPcs = sizes.reduce((t, z) => t + (Number(qty[cell(item.id, z.sizeId, grade)]) || 0), 0)
                          return (
                            <tr key={`${item.id}|${grade}`} className="border-border border-t">
                              <td className="py-1.5 pr-3">
                                <div className="text-foreground font-medium">
                                  {item.colour || item.code}
                                  {grade === 'B' && <span className="badge-purple ml-1.5">B-grade</span>}
                                </div>
                                <div className="text-muted-foreground font-mono text-[11px]">{item.code}</div>
                                <div className="text-muted-foreground max-w-64 truncate text-[11px]" title={item.name}>
                                  {item.name}
                                </div>
                                {item.description && <div className="text-muted-foreground max-w-64 truncate text-[11px] italic">{item.description}</div>}
                              </td>
                              {sizes.map((z) => {
                                const at = item.sizes.find((x) => x.sizeId === z.sizeId && x.grade === grade)
                                const free = at?.free ?? 0
                                const k = cell(item.id, z.sizeId, grade)
                                const n = Number(qty[k]) || 0
                                return (
                                  <td key={z.sizeId} className="px-1 py-1.5 align-top">
                                    <StepInput
                                      className={cn('form-input h-8 text-right', n > free && 'border-red-500')}
                                      value={qty[k] ?? ''}
                                      disabled={!free}
                                      max={free}
                                      onValueChange={(v) => setQty((q) => ({ ...q, [k]: v }))}
                                      aria-label={`Pieces of ${item.code} size ${z.code}${grade === 'B' ? ' B-grade' : ''}`}
                                    />
                                    <div className={cn('mt-0.5 text-center text-[10px]', free ? 'text-muted-foreground' : 'text-muted-foreground/50')}>{free ? `${free} free` : '—'}</div>
                                  </td>
                                )
                              })}
                              <td className="text-foreground px-3 py-1.5 text-right font-semibold tabular-nums">{rowPcs || ''}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })}
            {styleIds.length > 0 && styleIds.length < styles.length && (
              <p className="text-muted-foreground flex items-center gap-1 text-xs">
                <Plus size={12} /> Another style in the same carton: pick it above.
              </p>
            )}
          </>
        )}
      </div>
    </FormFrame>
  )
}
