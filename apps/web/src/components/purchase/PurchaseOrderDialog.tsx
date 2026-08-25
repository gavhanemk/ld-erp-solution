'use client'

import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertCircle, Plus, Trash2 } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'

export interface PoLine {
  itemId: string
  description?: string | null
  qty: number | string
  unitRate: number | string
  discount: number | string
  gstRate: number | string
  item?: { id: string; code: string; name: string; hsnCode: string | null; uom?: { symbol: string } | null }
}

export interface PurchaseOrder {
  id: string
  poNumber: string
  supplierId: string
  poDate: string
  deliveryDate: string | null
  deliveryWarehouseId: string | null
  status: string
  subtotal: string | number
  discountAmount: string | number
  taxableAmount: string | number
  cgst: string | number
  sgst: string | number
  igst: string | number
  roundOff: string | number
  totalAmount: string | number
  notes: string | null
  terms: string | null
  supplier?: { id: string; name: string; code: string; gstin: string | null; stateCode: string | null }
  lines?: PoLine[]
}

interface Option {
  id: string
  code?: string
  name: string
  gstin?: string | null
  stateCode?: string | null
  hsnCode?: string | null
  standardRate?: string | number | null
  taxRate?: { rate: string | number } | null
  uom?: { symbol: string } | null
}

const emptyLine = (): PoLine => ({
  itemId: '',
  qty: '',
  unitRate: '',
  discount: '0',
  gstRate: '',
})

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function PurchaseOrderDialog({
  open,
  onClose,
  onSaved,
  record,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  record?: PurchaseOrder | null
}) {
  const isEdit = Boolean(record)

  const [suppliers, setSuppliers] = useState<Option[]>([])
  const [items, setItems] = useState<Option[]>([])
  const [warehouses, setWarehouses] = useState<Option[]>([])
  const [companyState, setCompanyState] = useState<string | null>(null)

  const [supplierId, setSupplierId] = useState('')
  const [poDate, setPoDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [deliveryDate, setDeliveryDate] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  // Empty rather than '0'. A zero sitting in the box is not a value anyone
  // typed, and typing 5000 after it produces 05000.
  const [discountAmount, setDiscountAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState('')
  const [lines, setLines] = useState<PoLine[]>([emptyLine()])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSupplierId(record?.supplierId ?? '')
    setPoDate((record?.poDate ?? new Date().toISOString()).slice(0, 10))
    setDeliveryDate(record?.deliveryDate?.slice(0, 10) ?? '')
    setWarehouseId(record?.deliveryWarehouseId ?? '')
    // An order saved with no discount reopens with the box empty, not with a
    // zero in it.
    setDiscountAmount(num(record?.discountAmount) > 0 ? String(record?.discountAmount) : '')
    setNotes(record?.notes ?? '')
    setTerms(record?.terms ?? '')
    setLines(
      record?.lines?.length
        ? record.lines.map((l) => ({
            itemId: l.itemId,
            description: l.description ?? '',
            qty: String(l.qty),
            unitRate: String(l.unitRate),
            discount: String(l.discount ?? 0),
            gstRate: String(l.gstRate ?? ''),
          }))
        : [emptyLine()],
    )
    setError(null)
  }, [open, record])

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void Promise.all([
      masterResource<Option>('suppliers').list({ limit: 500, active: true }),
      masterResource<Option>('items').list({ limit: 500, active: true }),
      masterResource<Option>('warehouses').list({ limit: 100, active: true }),
      api.get<{ success: boolean; data: { stateCode: string | null } }>('/settings/company').catch(() => null),
    ]).then(([s, i, w, c]) => {
      if (cancelled) return
      setSuppliers((s as Paginated<Option>).data)
      setItems((i as Paginated<Option>).data)
      setWarehouses((w as Paginated<Option>).data)
      setCompanyState(c?.data?.stateCode ?? null)
    })

    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const supplier = suppliers.find((s) => s.id === supplierId)

  // Which way the tax falls, shown live so nobody is surprised by the printed
  // sheet. An unregistered supplier charges none at all.
  const taxMode = !supplier
    ? null
    : !supplier.gstin
      ? 'NONE'
      : (supplier.stateCode ?? supplier.gstin?.slice(0, 2)) === companyState
        ? 'CGST_SGST'
        : 'IGST'

  const totals = useMemo(() => {
    const lineAmounts = lines.map((l) => num(l.qty) * num(l.unitRate) * (1 - num(l.discount) / 100))
    const subtotal = lineAmounts.reduce((s, n) => s + n, 0)
    const discount = Math.min(num(discountAmount), subtotal)
    const taxable = subtotal - discount
    const factor = subtotal > 0 ? taxable / subtotal : 1

    const tax =
      taxMode === 'NONE'
        ? 0
        : lines.reduce((s, l, i) => s + lineAmounts[i] * factor * (num(l.gstRate) / 100), 0)

    const beforeRound = taxable + tax
    const total = Math.round(beforeRound)

    return {
      lineAmounts,
      subtotal,
      discount,
      taxable,
      tax,
      roundOff: total - beforeRound,
      total,
    }
  }, [lines, discountAmount, taxMode])

  if (!open) return null

  const setLine = (index: number, patch: Partial<PoLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  /** Choosing an item brings its rate and GST with it, so nobody retypes them. */
  const pickItem = (index: number, itemId: string) => {
    const item = itemById.get(itemId)
    setLine(index, {
      itemId,
      unitRate: lines[index].unitRate || (item?.standardRate != null ? String(item.standardRate) : ''),
      gstRate: lines[index].gstRate || (item?.taxRate ? String(item.taxRate.rate) : ''),
    })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const payload = {
      supplierId,
      poDate,
      deliveryDate: deliveryDate || null,
      deliveryWarehouseId: warehouseId || null,
      discountAmount: num(discountAmount),
      notes: notes.trim() || null,
      terms: terms.trim() || null,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        description: (l.description as string)?.trim() || null,
        qty: num(l.qty),
        unitRate: num(l.unitRate),
        discount: num(l.discount),
        gstRate: num(l.gstRate),
      })),
    }

    try {
      if (isEdit && record) {
        await api.patch(`/purchase/orders/${record.id}`, payload)
      } else {
        await api.post('/purchase/orders', payload)
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Is the API running?')
    } finally {
      setSaving(false)
    }
  }

  const incomplete = !supplierId || lines.some((l) => !l.itemId || num(l.qty) <= 0)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div className="glass-card w-full max-w-6xl my-auto" role="dialog" aria-modal="true">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {isEdit ? `Edit ${record?.poNumber}` : 'New Purchase Order'}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isEdit ? 'Only a draft order can be changed' : 'The order number is given when you save'}
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-5">
          {error && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
              <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="md:col-span-2">
              <label className="form-label" htmlFor="po-supplier">
                Supplier<span className="text-red-400 ml-0.5">*</span>
              </label>
              <select
                id="po-supplier"
                className="form-input"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              >
                <option value="">Select...</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code ? `${s.code} — ${s.name}` : s.name}
                  </option>
                ))}
              </select>
              {supplier && (
                <p className="text-xs text-muted-foreground mt-1">
                  {supplier.gstin ? (
                    <>
                      GSTIN {supplier.gstin} ·{' '}
                      {taxMode === 'CGST_SGST' ? 'within the state, CGST + SGST' : 'other state, IGST'}
                    </>
                  ) : (
                    'No GSTIN on file — this order will carry no GST'
                  )}
                </p>
              )}
            </div>

            <div>
              <label className="form-label" htmlFor="po-date">
                Order date
              </label>
              <input
                id="po-date"
                type="date"
                className="form-input"
                value={poDate}
                onChange={(e) => setPoDate(e.target.value)}
              />
            </div>

            <div>
              <label className="form-label" htmlFor="po-delivery">
                Wanted by
              </label>
              <input
                id="po-delivery"
                type="date"
                className="form-input"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
              />
            </div>

            <div className="md:col-span-2">
              <label className="form-label" htmlFor="po-warehouse">
                Deliver to
              </label>
              <select
                id="po-warehouse"
                className="form-input"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
              >
                <option value="">Our main address</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Lines */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                What you are ordering
              </h3>
              <button
                type="button"
                onClick={() => setLines((p) => [...p, emptyLine()])}
                className="btn-secondary text-xs"
              >
                <Plus size={14} /> Add line
              </button>
            </div>

            <div className="overflow-x-auto border border-border rounded-lg">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="border-b border-border bg-secondary/40">
                    {['Item', 'Description', 'Qty', 'Rate', 'Disc %', 'GST %', 'Amount', ''].map((h, i) => (
                      <th
                        key={h || i}
                        className={`text-[10px] uppercase tracking-wider text-muted-foreground py-2 px-3 ${
                          ['Qty', 'Rate', 'Disc %', 'GST %', 'Amount'].includes(h) ? 'text-right' : 'text-left'
                        }`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => {
                    const item = itemById.get(line.itemId)
                    return (
                      <tr key={i} className="border-b border-border/50 last:border-0">
                        <td className="py-2 px-3 min-w-[200px]">
                          <select
                            className="form-input h-9"
                            value={line.itemId}
                            onChange={(e) => pickItem(i, e.target.value)}
                            aria-label={`Line ${i + 1} item`}
                          >
                            <option value="">Select...</option>
                            {items.map((it) => (
                              <option key={it.id} value={it.id}>
                                {it.code ? `${it.code} — ${it.name}` : it.name}
                              </option>
                            ))}
                          </select>
                          {item?.hsnCode && (
                            <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                              HSN {item.hsnCode}
                            </p>
                          )}
                        </td>
                        <td className="py-2 px-3 min-w-[160px]">
                          <input
                            className="form-input h-9"
                            placeholder="Optional"
                            value={(line.description as string) ?? ''}
                            onChange={(e) => setLine(i, { description: e.target.value })}
                            aria-label={`Line ${i + 1} description`}
                          />
                        </td>
                        <td className="py-2 px-3 w-28">
                          <input
                            type="number"
                            step="0.001"
                            min={0}
                            className="form-input h-9 text-right"
                            value={String(line.qty)}
                            onChange={(e) => setLine(i, { qty: e.target.value })}
                            aria-label={`Line ${i + 1} quantity`}
                          />
                          {item?.uom?.symbol && (
                            <p className="text-[10px] text-muted-foreground mt-0.5 text-right">
                              {item.uom.symbol}
                            </p>
                          )}
                        </td>
                        <td className="py-2 px-3 w-28">
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            className="form-input h-9 text-right"
                            value={String(line.unitRate)}
                            onChange={(e) => setLine(i, { unitRate: e.target.value })}
                            aria-label={`Line ${i + 1} rate`}
                          />
                        </td>
                        <td className="py-2 px-3 w-20">
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            max={100}
                            className="form-input h-9 text-right"
                            value={String(line.discount)}
                            onChange={(e) => setLine(i, { discount: e.target.value })}
                            aria-label={`Line ${i + 1} discount`}
                          />
                        </td>
                        <td className="py-2 px-3 w-20">
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            max={100}
                            className="form-input h-9 text-right"
                            disabled={taxMode === 'NONE'}
                            value={taxMode === 'NONE' ? '' : String(line.gstRate)}
                            onChange={(e) => setLine(i, { gstRate: e.target.value })}
                            aria-label={`Line ${i + 1} GST rate`}
                          />
                        </td>
                        <td className="py-2 px-3 text-right font-medium tabular-nums w-32">
                          {totals.lineAmounts[i]?.toLocaleString('en-IN', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </td>
                        <td className="py-2 px-3 w-12">
                          <button
                            type="button"
                            onClick={() =>
                              setLines((p) => (p.length === 1 ? p : p.filter((_, x) => x !== i)))
                            }
                            disabled={lines.length === 1}
                            className="btn-ghost p-1 text-muted-foreground hover:text-red-400 disabled:opacity-25"
                            aria-label={`Remove line ${i + 1}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Totals and notes */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="space-y-4">
              <div>
                <label className="form-label" htmlFor="po-terms">
                  Terms
                </label>
                <textarea
                  id="po-terms"
                  rows={3}
                  className="form-input"
                  placeholder="Leave blank to use the terms set in Settings → Documents"
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                />
              </div>
              <div>
                <label className="form-label" htmlFor="po-notes">
                  Notes
                </label>
                <textarea
                  id="po-notes"
                  rows={2}
                  className="form-input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2 text-sm h-fit">
              <Row label="Subtotal" value={totals.subtotal} />
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="po-discount" className="text-muted-foreground">
                  Discount on the whole order
                </label>
                <input
                  id="po-discount"
                  type="number"
                  step="0.01"
                  min={0}
                  /* No placeholder. A grey 0 sitting in the box reads exactly
                     like a typed 0 and raised the same question the empty box
                     was meant to answer. The label says what the box is for. */
                  className="form-input h-8 w-32 text-right"
                  value={discountAmount}
                  onChange={(e) => setDiscountAmount(e.target.value)}
                />
              </div>
              <Row label="Taxable value" value={totals.taxable} />
              {taxMode === 'CGST_SGST' && (
                <>
                  <Row label="CGST" value={totals.tax / 2} />
                  <Row label="SGST" value={totals.tax / 2} />
                </>
              )}
              {taxMode === 'IGST' && <Row label="IGST" value={totals.tax} />}
              {taxMode === 'NONE' && (
                <p className="text-xs text-muted-foreground py-1">
                  No GST — this supplier is not registered.
                </p>
              )}
              {/* Which way the tax falls is decided by the supplier's state, so
                  until one is chosen there is no CGST/SGST or IGST row to show.
                  The tax was still being added to the total, which left the
                  taxable value and the total not adding up on screen with
                  nothing to account for the difference. It is shown as one
                  provisional line instead. */}
              {taxMode === null && (
                <>
                  <Row label="GST" value={totals.tax} />
                  <p className="text-xs text-muted-foreground py-1">
                    Choose a supplier to see whether this splits into CGST + SGST or is IGST.
                  </p>
                </>
              )}
              <Row label="Rounding" value={totals.roundOff} />
              <div className="flex items-center justify-between pt-2 border-t border-border">
                <span className="font-semibold text-foreground">Total</span>
                <span className="font-semibold text-foreground tabular-nums text-lg">
                  ₹
                  {totals.total.toLocaleString('en-IN', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
            <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving || incomplete}>
              {saving && <Loader2 size={15} className="animate-spin" />}
              {isEdit ? 'Save changes' : 'Create order'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">
        {value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    </div>
  )
}
