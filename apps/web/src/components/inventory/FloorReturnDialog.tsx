'use client'

import { useEffect, useState } from 'react'
import { Loader2, Undo2, Boxes, Ban, History } from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import type { InwardRef } from '@/components/packages/InwardStickers'

/**
 * Material back from the floor unused: the leftover fabric after cutting,
 * spare buttons after stitching. Against the requisition it was issued on, so
 * the order's issued figure becomes what it actually used. Goes back into
 * stock as whoever's it was — a customer's leftover stays the customer's.
 *
 * Under it, the returns already made on this requisition, each with its own
 * number, and a Cancel for one entered by mistake.
 */

interface EarlierReturn {
  id: string
  returnNumber: string
  returnDate: string
  reason: string | null
  by: string | null
  cancelledAt: string | null
  cancelledBy: string | null
  cancelReason: string | null
  lines: Array<{ item: string; unit: string; qty: number; store: string }>
}

const when = (d: string) =>
  new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })

interface ReturnLine {
  id: string
  issuedQty: string | number
  returnedQty?: string | number
  itemId?: string
  item: { id?: string; name: string; uom: { symbol: string } }
  warehouse: { id: string; name: string }
  ownership?: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId?: string | null
  ownerCustomer?: { name: string } | null
}

const num = (v: string) => Number(v) || 0
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })

export function FloorReturnDialog({
  mr,
  onClose,
  onSaved,
}: {
  mr: { id: string; mrNumber: string; department?: { name: string } | null; lines: ReturnLine[] }
  onClose: () => void
  /** `stickers`: what came back, for its sticker window. */
  onSaved: (message: string, stickers?: InwardRef) => void
}) {
  const open = mr.lines.map((l) => ({ l, left: Math.round((Number(l.issuedQty) - Number(l.returnedQty ?? 0)) * 1000) / 1000 })).filter((x) => x.left > 0)
  const [qty, setQty] = useState<Record<string, string>>({})
  const [store, setStore] = useState<Record<string, string>>(Object.fromEntries(open.map((x) => [x.l.id, x.l.warehouse.id])))
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([])
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [earlier, setEarlier] = useState<EarlierReturn[]>([])
  const [undoing, setUndoing] = useState<string | null>(null)

  useEffect(() => {
    masterResource<{ id: string; name: string }>('warehouses')
      .list({ limit: 100, active: true })
      .then((r) => setStores(r.data))
      .catch(() => setStores([]))
    api
      .get<{ data: EarlierReturn[] }>(`/inventory/requisitions/${mr.id}/floor-returns`)
      .then((r) => setEarlier(r.data))
      .catch(() => setEarlier([]))
  }, [mr.id])

  /** A return entered by mistake: what it put back in the store comes out again. */
  const cancelReturn = async (f: EarlierReturn) => {
    const why = prompt(`Why is ${f.returnNumber} being cancelled?\n\nWhat it put back into the store comes out again, and ${mr.mrNumber} shows it as still with the floor.`)
    if (!why || why.trim().length < 5) return
    setUndoing(f.id)
    setError(null)
    try {
      const res = await api.patch<{ message?: string }>(`/inventory/floor-returns/${f.id}/cancel`, { reason: why.trim() })
      onSaved(res.message ?? `${f.returnNumber} cancelled.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel it.')
    } finally {
      setUndoing(null)
    }
  }

  const lines = open.filter((x) => num(qty[x.l.id] ?? '') > 0)
  const over = lines.find((x) => num(qty[x.l.id] ?? '') > x.left + 1e-9)

  const save = async () => {
    if (!lines.length || over) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/inventory/requisitions/${mr.id}/return`, {
        reason: reason.trim() || null,
        lines: lines.map((x) => ({ lineId: x.l.id, qty: num(qty[x.l.id] ?? ''), warehouseId: store[x.l.id] || x.l.warehouse.id })),
      })
      // What came back, line by line: a requisition can be returned to more
      // than once, so the document alone cannot say what this return was.
      const back = lines
        .map((x) => ({
          itemId: x.l.itemId ?? x.l.item.id ?? '',
          warehouseId: store[x.l.id] || x.l.warehouse.id,
          ownership: x.l.ownership ?? ('OWNED' as const),
          ownerCustomerId: x.l.ownerCustomerId ?? null,
          qty: num(qty[x.l.id] ?? ''),
        }))
        .filter((b) => b.itemId)
      onSaved(res.message ?? 'Returned to the store.', back.length ? { type: 'MR_RETURN', id: mr.id, lines: back } : undefined)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not return it.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={Undo2}
      title={`Back from the floor · ${mr.mrNumber}`}
      subtitle={`What ${mr.department?.name ?? 'the floor'} did not use, back into the store. The order's issued figure becomes what it used.`}
      width="max-w-4xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !lines.length || !!over}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Undo2 size={15} />} Return to store
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={over ? <span className="text-destructive">More than was issued and not yet returned.</span> : `${lines.length} of ${open.length} lines coming back`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={Boxes} title="Coming back">
        {open.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing issued on {mr.mrNumber} is left to return.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Item</th>
                  <th style={{ textAlign: 'right' }}>Issued, not returned</th>
                  <th style={{ textAlign: 'right' }}>Coming back</th>
                  <th>Into store</th>
                </tr>
              </thead>
              <tbody>
                {open.map(({ l, left }) => (
                  <tr key={l.id}>
                    <td>
                      <div className="text-foreground text-sm">{l.item.name}</div>
                      {l.ownership === 'CUSTOMER_OWNED' && <div className="text-muted-foreground text-[11px]">{l.ownerCustomer?.name ?? 'Customer'}&apos;s</div>}
                    </td>
                    <td className="text-right text-sm tabular-nums">
                      {fmt(left)} {l.item.uom.symbol}
                    </td>
                    <td className="w-36">
                      <StepInput
                        decimals
                        className={`form-input h-9 text-right tabular-nums ${num(qty[l.id] ?? '') > left + 1e-9 ? 'border-destructive/60' : ''}`}
                        value={qty[l.id] ?? ''}
                        placeholder="0"
                        onValueChange={(v) => setQty((q) => ({ ...q, [l.id]: v }))}
                        aria-label={`${l.item.name} coming back`}
                      />
                    </td>
                    <td className="w-48">
                      <SmartSelect className="form-input h-9" value={store[l.id] ?? ''} onChange={(e) => setStore((s) => ({ ...s, [l.id]: e.target.value }))} aria-label={`Store for ${l.item.name}`}>
                        {stores.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                      </SmartSelect>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {open.length > 0 && (
          <label className="mt-3 block">
            <span className="form-label">Note</span>
            <input className="form-input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Leftover after cutting" />
          </label>
        )}
      </Section>

      {earlier.length > 0 && (
        <Section icon={History} title="Returned already">
          <ul className="divide-border -my-1 divide-y">
            {earlier.map((f) => (
              <li key={f.id} className={`flex flex-wrap items-start gap-x-4 gap-y-1 py-2 text-sm ${f.cancelledAt ? 'opacity-60' : ''}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className={`text-foreground font-mono text-xs font-semibold ${f.cancelledAt ? 'line-through' : ''}`}>{f.returnNumber}</span>
                    <span className="text-muted-foreground text-xs">
                      {when(f.returnDate)}
                      {f.by ? ` · ${f.by}` : ''}
                    </span>
                    {f.cancelledAt && <span className="badge-danger">Cancelled</span>}
                  </div>
                  <div className="text-foreground">{f.lines.map((l) => `${fmt(l.qty)} ${l.unit} ${l.item} into ${l.store}`).join(', ')}</div>
                  {f.cancelledAt ? (
                    <div className="text-muted-foreground text-xs">
                      Cancelled {when(f.cancelledAt)}
                      {f.cancelledBy ? ` by ${f.cancelledBy}` : ''}
                      {f.cancelReason ? `: ${f.cancelReason}` : ''}
                    </div>
                  ) : (
                    f.reason && <div className="text-muted-foreground text-xs">{f.reason}</div>
                  )}
                </div>
                {!f.cancelledAt && (
                  <button
                    type="button"
                    className="btn-secondary h-8 px-2.5 text-xs text-red-500"
                    onClick={() => void cancelReturn(f)}
                    disabled={undoing === f.id || saving}
                    title="Entered by mistake: take it back"
                  >
                    {undoing === f.id ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />} Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </FormFrame>
  )
}
