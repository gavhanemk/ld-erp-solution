'use client'

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, AlertCircle, Plus, Trash2, Undo2, FileText, Truck, Boxes } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Section } from '@/components/purchase/Section'

/**
 * Sending a customer's own material back to them unworked.
 *
 * Only what is theirs and here can be picked: the customer list is the
 * customers with something in our stores, the store list is where theirs sits,
 * and each item shows how much of theirs is in that store. The server checks
 * the same again, so two people returning the same roll cannot both succeed.
 */

export interface HeldStock {
  itemId: string
  itemCode: string
  itemName: string
  uom: string
  warehouseId: string
  warehouseName: string
  customerId: string
  customerName: string
  qty: number
}

interface Line {
  itemId: string
  qty: string
  notes: string
}

const REASONS = [
  { value: 'LEFTOVER', label: 'Left over after their order' },
  { value: 'REJECTED', label: 'Rejected at inspection' },
  { value: 'EXCESS', label: 'More than their challan' },
  { value: 'OTHER', label: 'Other (say why in the note)' },
]

const emptyLine = (): Line => ({ itemId: '', qty: '', notes: '' })
const num = (v: string) => Number(v) || 0
const fmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })

export function CustomerReturnDialog({
  held,
  receipts,
  start,
  onClose,
  onSaved,
}: {
  /** What of each customer's is in our stores now. */
  held: HeldStock[]
  /** Their receipts not cancelled, to return against one. */
  receipts: Array<{ id: string; grnNumber: string; customerId: string; date: string }>
  /** Opened from a row of "Still with us": that customer, store and item. */
  start?: { customerId: string; warehouseId: string; itemId?: string }
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [customerId, setCustomerId] = useState(start?.customerId ?? '')
  const [warehouseId, setWarehouseId] = useState(start?.warehouseId ?? '')
  const [grnId, setGrnId] = useState('')
  const [returnDate, setReturnDate] = useState('')
  const [reason, setReason] = useState('LEFTOVER')
  const [vehicleNo, setVehicleNo] = useState('')
  const [transporter, setTransporter] = useState('')
  const [lrNumber, setLrNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([start?.itemId ? { itemId: start.itemId, qty: '', notes: '' } : emptyLine()])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const customers = useMemo(() => {
    const m = new Map<string, string>()
    for (const h of held) if (h.qty > 0) m.set(h.customerId, h.customerName)
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [held])

  const stores = useMemo(() => {
    const m = new Map<string, string>()
    for (const h of held) if (h.customerId === customerId && h.qty > 0) m.set(h.warehouseId, h.warehouseName)
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [held, customerId])

  const theirs = useMemo(
    () =>
      held
        .filter((h) => h.customerId === customerId && h.warehouseId === warehouseId && h.qty > 0)
        .sort((a, b) => a.itemName.localeCompare(b.itemName)),
    [held, customerId, warehouseId],
  )
  const heldOf = (itemId: string) => theirs.find((h) => h.itemId === itemId)

  const setLine = (index: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  const filled = lines.filter((l) => l.itemId && num(l.qty) > 0)
  const over = filled.filter((l) => num(l.qty) > (heldOf(l.itemId)?.qty ?? 0) + 1e-9)

  const pickCustomer = (id: string) => {
    setCustomerId(id)
    setGrnId('')
    const own = held.filter((h) => h.customerId === id && h.qty > 0)
    const only = [...new Set(own.map((h) => h.warehouseId))]
    setWarehouseId(only.length === 1 ? only[0] : '')
    setLines([emptyLine()])
  }

  const save = async () => {
    setError(null)
    if (!customerId) return setError('Whose material is going back?')
    if (!warehouseId) return setError('Which store is it leaving from?')
    if (filled.length === 0) return setError('Enter how much is going back on at least one line.')
    if (over.length) return setError('One of the lines is more than we hold of theirs in that store.')
    if (reason === 'OTHER' && !notes.trim()) return setError('Say why it is going back, in the note.')

    setSaving(true)
    try {
      const res = await api.post<{ message?: string; data: { returnNumber: string } }>('/inventory/customer-return', {
        customerId,
        grnId: grnId || null,
        warehouseId,
        returnDate: returnDate || undefined,
        reason,
        vehicleNo: vehicleNo || null,
        transporter: transporter || null,
        lrNumber: lrNumber || null,
        notes: notes || null,
        lines: filled.map((l) => ({ itemId: l.itemId, qty: num(l.qty), notes: l.notes || null })),
      })
      onSaved(res.message ?? `${res.data.returnNumber} saved.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const saveButton = (
    <button type="submit" form="customer-return-form" className="btn-primary" disabled={saving}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <Undo2 size={15} />}
      Return material
    </button>
  )

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <form
        id="customer-return-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        noValidate
        className="glass-card po-form flex max-h-full w-full max-w-6xl flex-col self-center overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-return-title"
      >
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <Undo2 size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="customer-return-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                Return material to customer
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                Their own material going back unworked. It leaves our books; no bill, no money.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden md:block">{saveButton}</div>
            <button type="button" onClick={onClose} className="btn-ghost p-2" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <Section icon={FileText} title="Customer & reason">
            <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block min-w-0">
                <span className="form-label">
                  Customer <span className="text-red-400">*</span>
                </span>
                <select className="form-input" value={customerId} onChange={(e) => pickCustomer(e.target.value)} autoFocus={!start}>
                  <option value="">{customers.length ? 'Choose…' : 'No customer material with us'}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block min-w-0">
                <span className="form-label">
                  Why it is going back <span className="text-red-400">*</span>
                </span>
                <select className="form-input" value={reason} onChange={(e) => setReason(e.target.value)}>
                  {REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block min-w-0">
                <span className="form-label">Against their receipt</span>
                <select className="form-input" value={grnId} onChange={(e) => setGrnId(e.target.value)} disabled={!customerId}>
                  <option value="">Not against one receipt</option>
                  {receipts
                    .filter((r) => r.customerId === customerId)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.grnNumber} · {new Date(r.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </option>
                    ))}
                </select>
              </label>
              <label className="block min-w-0">
                <span className="form-label">Returned on</span>
                <input type="date" className="form-input" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
              </label>
            </div>
          </Section>

          <Section icon={Truck} title="Dispatch">
            <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block min-w-0">
                <span className="form-label">
                  From which store <span className="text-red-400">*</span>
                </span>
                <select
                  className="form-input"
                  value={warehouseId}
                  onChange={(e) => {
                    setWarehouseId(e.target.value)
                    setLines([emptyLine()])
                  }}
                  disabled={!customerId}
                >
                  <option value="">{customerId ? 'Choose…' : 'Choose the customer first'}</option>
                  {stores.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
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
                <span className="form-label">Transport</span>
                <input className="form-input" value={transporter} onChange={(e) => setTransporter(e.target.value)} />
              </label>
              <label className="block min-w-0">
                <span className="form-label">LR number</span>
                <input className="form-input" value={lrNumber} onChange={(e) => setLrNumber(e.target.value)} />
              </label>
              <label className="block min-w-0 sm:col-span-2 lg:col-span-4">
                <span className="form-label">
                  Note{reason === 'OTHER' && <span className="text-red-400"> *</span>}
                </span>
                <input
                  className="form-input placeholder:text-muted-foreground/60"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Order SO-0012 complete, 3 rolls unused"
                />
              </label>
            </div>
          </Section>

          <Section
            icon={Boxes}
            title="Items going back"
            actions={
              <button
                type="button"
                className="btn-secondary h-8 text-xs"
                onClick={() => setLines((prev) => [...prev, emptyLine()])}
                disabled={!warehouseId}
              >
                <Plus size={14} /> Add item
              </button>
            }
          >
            <div className="-mx-4 -mb-3.5 -mt-3 overflow-x-auto">
              <table className="data-table w-full [&>tbody>tr>td]:px-3 [&>thead>tr>th]:px-3">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>#</th>
                    <th style={{ width: '38%' }}>Item</th>
                    <th style={{ textAlign: 'right' }}>Theirs in this store</th>
                    <th style={{ textAlign: 'right' }}>Going back</th>
                    <th>Line note</th>
                    <th style={{ width: 44 }} />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => {
                    const h = heldOf(line.itemId)
                    const tooMuch = !!h && num(line.qty) > h.qty + 1e-9
                    const taken = new Set(lines.filter((_, x) => x !== i).map((l) => l.itemId))
                    return (
                      <tr key={i}>
                        <td className="text-muted-foreground text-xs tabular-nums">{i + 1}</td>
                        <td className="min-w-[240px]">
                          <select
                            className="form-input h-9"
                            value={line.itemId}
                            onChange={(e) => setLine(i, { itemId: e.target.value, qty: '' })}
                            disabled={!warehouseId}
                            aria-label={`Item on line ${i + 1}`}
                          >
                            <option value="">{warehouseId ? 'Choose an item…' : 'Choose the store first'}</option>
                            {theirs
                              .filter((t) => !taken.has(t.itemId))
                              .map((t) => (
                                <option key={t.itemId} value={t.itemId}>
                                  {t.itemCode} · {t.itemName} · {fmt(t.qty)} {t.uom}
                                </option>
                              ))}
                          </select>
                        </td>
                        <td className="whitespace-nowrap text-right text-sm tabular-nums">
                          {h ? (
                            <>
                              {fmt(h.qty)} <span className="text-muted-foreground text-xs">{h.uom}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="min-w-[170px]">
                          <div className="flex items-center gap-1.5">
                            <div className="relative flex-1">
                              <input
                                className={`form-input h-9 pr-10 text-right ${tooMuch ? 'border-red-500 focus:border-red-500' : ''}`}
                                inputMode="decimal"
                                value={line.qty}
                                onChange={(e) => setLine(i, { qty: e.target.value })}
                                disabled={!line.itemId}
                                aria-label={`Quantity going back on line ${i + 1}`}
                              />
                              {h?.uom && (
                                <span className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs">
                                  {h.uom}
                                </span>
                              )}
                            </div>
                            {h && (
                              <button
                                type="button"
                                className="btn-ghost h-9 whitespace-nowrap px-2 text-xs text-primary"
                                onClick={() => setLine(i, { qty: String(h.qty) })}
                                title="Return all of it"
                              >
                                All
                              </button>
                            )}
                          </div>
                          {tooMuch && <div className="mt-0.5 text-[11px] text-red-500">Only {fmt(h!.qty)} {h!.uom} of theirs here</div>}
                        </td>
                        <td className="min-w-[150px]">
                          <input
                            className="form-input h-9 placeholder:text-muted-foreground/60"
                            value={line.notes}
                            onChange={(e) => setLine(i, { notes: e.target.value })}
                            placeholder="e.g. 3 rolls, lot 7"
                            aria-label={`Note on line ${i + 1}`}
                          />
                        </td>
                        <td className="text-right">
                          <button
                            type="button"
                            className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400"
                            onClick={() => setLines((prev) => (prev.length === 1 ? [emptyLine()] : prev.filter((_, x) => x !== i)))}
                            aria-label={`Remove line ${i + 1}`}
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        </div>

        <div className="border-border flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">
          <span className="text-muted-foreground mr-auto hidden text-xs sm:inline">
            {filled.length} {filled.length === 1 ? 'item' : 'items'} going back · a delivery challan prints after saving
          </span>
          <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
            Cancel
          </button>
          {saveButton}
        </div>
      </form>
    </div>,
    document.body,
  )
}
