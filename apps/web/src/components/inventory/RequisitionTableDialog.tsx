'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, ShoppingCart, Lock } from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { formatDate } from '@/lib/utils'

/**
 * Every item on a requisition in one table, the way the old system's "Create
 * Indent For Raw Material" and "Reserve Raw Material" screens laid it out:
 * available, asked, issued, already on the indent or ordered, reserved — and
 * one box per row for the indent or the reservation. Tick the rows to save.
 *
 * It reads the same figures as the Fulfil window, so the two always agree.
 * Opened without a requisition (from the Reservations tab), it first asks which.
 */

interface Line {
  id: string
  requestedQty: string | number
  issuedQty: string | number
  purpose: string | null
  ownership?: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomer?: { id: string; name: string } | null
  item: { id: string; code: string; name: string; uom: { symbol: string } }
  warehouse: { id: string; name: string }
}

export interface TableRequisition {
  id: string
  mrNumber: string
  requestDate: string
  status: string
  closedAt: string | null
  issuedAt: string | null
  department: { id: string; name: string }
  so?: { id: string; soNumber: string; customer: { id: string; name: string } } | null
  lines: Line[]
}

interface Fresh {
  lines: Array<{ id: string; requestedQty: number; issuedQty: number; purchaseQty: number | null; fulfilment: string }>
  bought: Array<{ lineId: string; buyQty: number; orderedQty: number; receivedQty: number; poNumbers: string[] }>
  stock: Array<{ itemId: string; warehouseId: string; warehouseName: string; ownership: string; ownerCustomerId: string | null; qty: number }>
  reservations: Array<{ itemId: string; warehouseId: string; mrLineId: string; qty: number; mrNumber: string; customerName: string | null }>
}

const fmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const r3 = (v: number) => Math.round(v * 1000) / 1000
const num = (v: string) => (v.trim() === '' ? 0 : Number(v))

export function RequisitionTableDialog({
  mode,
  mr: given,
  onClose,
  onDone,
}: {
  mode: 'indent' | 'reserve'
  /** The requisition; left out, the window asks which one. */
  mr?: TableRequisition | null
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [mr, setMr] = useState<TableRequisition | null>(given ?? null)
  const [choices, setChoices] = useState<TableRequisition[]>([])
  const [fresh, setFresh] = useState<Fresh | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Per line: ticked, the figure typed, and (to reserve) the store. */
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [qty, setQty] = useState<Record<string, string>>({})
  const [store, setStore] = useState<Record<string, string>>({})

  const indent = mode === 'indent'

  // No requisition given: the approved, still-open ones to choose from.
  useEffect(() => {
    if (given) return
    let cancelled = false
    void (async () => {
      try {
        const res = await api.get<Paginated<TableRequisition>>('/inventory/requisitions?status=APPROVED&limit=200')
        if (!cancelled) setChoices(res.data.filter((r) => !r.closedAt && !r.issuedAt))
      } catch {
        if (!cancelled) setError('Could not load the requisitions.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [given])

  // The live figures for the chosen requisition.
  useEffect(() => {
    if (!mr) return
    let cancelled = false
    setLoading(true)
    setFresh(null)
    void (async () => {
      try {
        const res = await api.get<{ data: Fresh }>(`/inventory/requisitions/${mr.id}/fulfil`)
        if (!cancelled) setFresh({ ...res.data, reservations: res.data.reservations ?? [] })
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not open the requisition.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mr])

  /** Everything one row shows, worked out once. */
  const rows = useMemo(() => {
    if (!mr || !fresh) return []
    return mr.lines.map((l) => {
      const f = fresh.lines.find((x) => x.id === l.id)
      const asked = Number(f?.requestedQty ?? l.requestedQty)
      const issued = Number(f?.issuedQty ?? l.issuedQty)
      const owed = r3(Math.max(0, asked - issued))
      const theirs = l.ownership === 'CUSTOMER_OWNED'
      const b = fresh.bought.find((x) => x.lineId === l.id)
      // Per store: on hand, what other lines hold, what this line holds, what is free.
      const byStore = new Map<string, { id: string; name: string; onHand: number; others: number; own: number }>()
      for (const s of fresh.stock) {
        if (s.itemId !== l.item.id || s.qty <= 0) continue
        if (theirs ? s.ownership !== 'CUSTOMER_OWNED' || s.ownerCustomerId !== l.ownerCustomer?.id : s.ownership !== 'OWNED') continue
        const cur = byStore.get(s.warehouseId) ?? { id: s.warehouseId, name: s.warehouseName, onHand: 0, others: 0, own: 0 }
        cur.onHand += s.qty
        byStore.set(s.warehouseId, cur)
      }
      if (!theirs)
        for (const h of fresh.reservations) {
          if (h.itemId !== l.item.id) continue
          const cur = byStore.get(h.warehouseId)
          if (!cur) continue
          if (h.mrLineId === l.id) cur.own += h.qty
          else cur.others += h.qty
        }
      const stores = [...byStore.values()]
        .map((s) => ({ ...s, free: r3(Math.max(0, s.onHand - s.others)) }))
        .sort((a, b2) => b2.free - a.free)
      const free = r3(stores.reduce((t, s) => t + s.free, 0))
      const reserved = r3(stores.reduce((t, s) => t + s.own, 0))
      const onIndent = b?.buyQty ?? 0
      const ordered = b?.orderedQty ?? 0
      return { l, asked, issued, owed, theirs, stores, free, reserved, onIndent, ordered, poNumbers: b?.poNumbers ?? [] }
    })
  }, [mr, fresh])

  // Starting figures: to indent, what is already on it or else what the free stock cannot cover;
  // to reserve, the store with most free and as much as it can hold of what is owed.
  useEffect(() => {
    const q: Record<string, string> = {}
    const st: Record<string, string> = {}
    for (const r of rows) {
      if (indent) {
        const short = r3(Math.max(0, r.owed - r.free))
        q[r.l.id] = String(r.onIndent > 0 ? r.onIndent : short)
      } else {
        const best = r.stores.find((s) => s.own > 0) ?? r.stores[0]
        st[r.l.id] = best?.id ?? ''
        const ownElsewhere = r.stores.filter((s) => s.id !== best?.id).reduce((t, s) => t + s.own, 0)
        q[r.l.id] = best ? String(r3(Math.max(0, Math.min(best.free, r.owed - ownElsewhere)))) : '0'
      }
    }
    setQty(q)
    setStore(st)
    setTicked({})
  }, [rows, indent])

  const editable = rows.filter((r) => !r.theirs && r.owed > 0 && (indent || r.stores.length > 0))
  const allTicked = editable.length > 0 && editable.every((r) => ticked[r.l.id])
  const picked = rows.filter((r) => ticked[r.l.id])

  /** Anything that would stop the save, for the ticked rows. */
  const problems = useMemo(() => {
    const out: string[] = []
    for (const r of picked) {
      const v = num(qty[r.l.id] ?? '')
      const unit = r.l.item.uom.symbol
      if (Number.isNaN(v) || v < 0) {
        out.push(`${r.l.item.name}: enter a number.`)
        continue
      }
      if (indent) {
        if (v + 1e-9 < r.ordered) out.push(`${r.l.item.name}: ${fmt(r.ordered)} ${unit} is already ordered, so the indent cannot go below that.`)
      } else {
        const s = r.stores.find((x) => x.id === store[r.l.id])
        if (!s) out.push(`${r.l.item.name}: pick a store.`)
        else {
          const ownElsewhere = r.stores.filter((x) => x.id !== s.id).reduce((t, x) => t + x.own, 0)
          if (v > s.free + 1e-9) out.push(`${r.l.item.name}: ${s.name} has ${fmt(s.free)} ${unit} free.`)
          else if (v + ownElsewhere > r.owed + 1e-9) out.push(`${r.l.item.name}: only ${fmt(r.owed)} ${unit} is still owed.`)
        }
      }
    }
    return out
  }, [picked, qty, store, indent])

  const save = async () => {
    if (!mr) return
    setError(null)
    if (!picked.length) return setError(`Tick the items to ${indent ? 'put on the indent' : 'reserve'}.`)
    if (problems.length) return setError(problems[0])
    setSaving(true)
    try {
      const res = indent
        ? await api.patch<{ message?: string }>(`/inventory/requisitions/${mr.id}/plan`, {
            lines: picked.map((r) => ({ lineId: r.l.id, buyQty: r3(num(qty[r.l.id] ?? '0')) })),
          })
        : await api.post<{ message?: string }>(`/inventory/requisitions/${mr.id}/reserve`, {
            lines: picked.map((r) => ({ lineId: r.l.id, warehouseId: store[r.l.id], qty: r3(num(qty[r.l.id] ?? '0')) })),
          })
      onDone(res.message ?? 'Saved.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const saveButton = (
    <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || loading || !mr}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : indent ? <ShoppingCart size={15} /> : <Lock size={15} />}
      {indent ? 'Create indent' : 'Reserve'}
    </button>
  )

  const cell = 'px-3 py-2 text-right text-xs tabular-nums'
  const dash = <span className="text-muted-foreground">—</span>

  return (
    <FormFrame
      icon={indent ? ShoppingCart : Lock}
      title={indent ? 'Create indent for raw material' : 'Reserve raw material'}
      subtitle={
        indent
          ? 'The indent quantity goes on the buyer’s list. They raise the order from Purchase Orders → New order → Select from indent.'
          : 'Reserved stock stays on the rack but is not given to any other requisition. Issuing this requisition uses it up.'
      }
      width="max-w-7xl"
      primary={saveButton}
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={
        picked.length
          ? `${picked.length} ${picked.length === 1 ? 'item' : 'items'} ticked${problems.length ? ` · ${problems[0]}` : ''}`
          : `Tick the items to ${indent ? 'put on the indent' : 'reserve'}, or Select All.`
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={indent ? ShoppingCart : Lock} title="Requisition">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block min-w-0">
            <span className="form-label">Request no.</span>
            {given ? (
              <div className="form-input flex items-center font-mono">{given.mrNumber}</div>
            ) : (
              <select
                className="form-input"
                value={mr?.id ?? ''}
                onChange={(e) => setMr(choices.find((c) => c.id === e.target.value) ?? null)}
                autoFocus
              >
                <option value="">{choices.length ? 'Choose an approved requisition…' : 'Loading…'}</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.mrNumber} · {c.department.name}
                    {c.so ? ` · ${c.so.customer.name}` : ''}
                  </option>
                ))}
              </select>
            )}
          </label>
          <div className="min-w-0">
            <span className="form-label">Request date</span>
            <div className="form-input flex items-center">{mr ? formatDate(mr.requestDate) : '—'}</div>
          </div>
          <div className="min-w-0">
            <span className="form-label">Department</span>
            <div className="form-input flex items-center">{mr?.department.name ?? '—'}</div>
          </div>
          <div className="min-w-0">
            <span className="form-label">{indent ? 'For' : 'Held for'}</span>
            <div className="form-input flex items-center truncate">
              {mr?.so ? `${mr.so.customer.name} (${mr.so.soNumber})` : mr ? 'No sales order' : '—'}
            </div>
          </div>
        </div>
      </Section>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2 text-left">
                  <label className="flex items-center gap-1.5 font-semibold normal-case tracking-normal">
                    <input
                      type="checkbox"
                      checked={allTicked}
                      onChange={(e) => setTicked(Object.fromEntries(editable.map((r) => [r.l.id, e.target.checked])))}
                      disabled={!editable.length}
                      aria-label="Select all"
                    />
                    All
                  </label>
                </th>
                <th className="px-3 py-2 text-left font-semibold">Item</th>
                <th className="px-3 py-2 text-left font-semibold">Code</th>
                <th className="px-3 py-2 text-right font-semibold">Available</th>
                <th className="px-3 py-2 text-right font-semibold">Requisition</th>
                <th className="px-3 py-2 text-right font-semibold">Issued</th>
                <th className="px-3 py-2 text-right font-semibold">On indent</th>
                <th className="px-3 py-2 text-right font-semibold">Ordered</th>
                <th className="px-3 py-2 text-right font-semibold">Reserved</th>
                {!indent && <th className="px-3 py-2 text-left font-semibold">From store</th>}
                <th className="px-3 py-2 text-right font-semibold" style={{ width: '9rem' }}>
                  {indent ? 'Indent qty' : 'Reserve qty'}
                </th>
              </tr>
            </thead>
            <tbody>
              {!mr ? (
                <tr>
                  <td colSpan={indent ? 10 : 11} className="px-3 py-10 text-center text-sm text-muted-foreground">
                    Choose a requisition above.
                  </td>
                </tr>
              ) : loading || !fresh ? (
                <tr>
                  <td colSpan={indent ? 10 : 11} className="px-3 py-10 text-center text-sm text-muted-foreground">
                    Reading the stock…
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const unit = r.l.item.uom.symbol
                  const can = editable.includes(r)
                  const why = r.theirs
                    ? `${r.l.ownerCustomer?.name ?? 'The customer'}'s material — not bought or reserved`
                    : r.owed <= 0
                      ? 'issued in full'
                      : !indent && !r.stores.length
                        ? 'none in stock'
                        : null
                  const s = r.stores.find((x) => x.id === store[r.l.id])
                  const v = num(qty[r.l.id] ?? '')
                  const bad = ticked[r.l.id] && problems.some((p) => p.startsWith(`${r.l.item.name}:`))
                  return (
                    <tr key={r.l.id} className={`border-t border-border ${can ? '' : 'opacity-60'} ${ticked[r.l.id] ? 'bg-primary/5' : ''}`}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={!!ticked[r.l.id]}
                          onChange={(e) => setTicked((p) => ({ ...p, [r.l.id]: e.target.checked }))}
                          disabled={!can}
                          aria-label={`Select ${r.l.item.name}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-sm font-medium text-foreground">{r.l.item.name}</div>
                        {why ? (
                          <div className="text-[11px] text-muted-foreground">{why}</div>
                        ) : (
                          r.l.purpose && <div className="text-[11px] text-muted-foreground">for {r.l.purpose}</div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">{r.l.item.code}</td>
                      <td className={cell} title={r.stores.map((x) => `${x.name}: ${fmt(x.free)} free of ${fmt(x.onHand)}`).join('\n') || undefined}>
                        <span className={r.free > 0 ? 'font-semibold text-foreground' : 'text-red-500'}>{fmt(r.free)}</span> {unit}
                        {r.stores.some((x) => x.others > 0) && (
                          <div className="text-[10px] text-violet-500">
                            {fmt(r.stores.reduce((t, x) => t + x.others, 0))} held for others
                          </div>
                        )}
                      </td>
                      <td className={cell}>
                        {fmt(r.asked)} {unit}
                      </td>
                      <td className={cell}>{r.issued > 0 ? <span className="text-emerald-500">{fmt(r.issued)}</span> : dash}</td>
                      <td className={cell}>{r.onIndent > 0 ? <span className="text-sky-500">{fmt(r.onIndent)}</span> : dash}</td>
                      <td className={cell} title={r.poNumbers.join(', ') || undefined}>
                        {r.ordered > 0 ? fmt(r.ordered) : dash}
                      </td>
                      <td className={cell}>{r.reserved > 0 ? <span className="text-violet-500">{fmt(r.reserved)}</span> : dash}</td>
                      {!indent && (
                        <td className="px-3 py-1.5">
                          {r.stores.length ? (
                            <select
                              className="form-input h-8 min-w-[10rem] text-xs"
                              value={store[r.l.id] ?? ''}
                              onChange={(e) => setStore((p) => ({ ...p, [r.l.id]: e.target.value }))}
                              disabled={!can}
                              aria-label={`Store to reserve ${r.l.item.name} in`}
                            >
                              {r.stores.map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.name} · {fmt(x.free)} free
                                </option>
                              ))}
                            </select>
                          ) : (
                            dash
                          )}
                        </td>
                      )}
                      <td className="px-3 py-1.5">
                        <div className="relative ml-auto w-32">
                          <input
                            className={`form-input h-8 pr-9 text-right text-xs tabular-nums ${bad ? 'border-red-500' : ''}`}
                            inputMode="decimal"
                            value={qty[r.l.id] ?? ''}
                            onChange={(e) => {
                              setQty((p) => ({ ...p, [r.l.id]: e.target.value }))
                              setTicked((p) => ({ ...p, [r.l.id]: true }))
                            }}
                            disabled={!can}
                            aria-label={`${indent ? 'Indent' : 'Reserve'} quantity for ${r.l.item.name}`}
                          />
                          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">{unit}</span>
                        </div>
                        {!indent && s && can && v > 0 && <div className="mt-0.5 text-right text-[10px] text-muted-foreground">of {fmt(s.free)} free</div>}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="px-1 text-[11px] text-muted-foreground">
        {indent
          ? 'Indent qty is the total to buy for the line — the figure already on the indent is replaced, never added to. It cannot go below what is already ordered.'
          : 'Reserve qty is the total held in that store for the line — 0 lets it go. Available is free stock: on hand less what other requisitions hold.'}
      </p>
    </FormFrame>
  )
}
