'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  FileText,
  Hash,
  Info,
  Loader2,
  MapPin,
  Package,
  Save,
  Truck,
  Warehouse as WarehouseIcon,
  Wand2,
  X,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate, formatRupees } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

interface PrepSize {
  sizeId: string
  code: string
  sequence: number
  ordered: number
  sent: number
  pending: number
  inStock: number
}

interface PrepLine {
  soLineId: string
  item: { id: string; code: string; name: string; color: string | null; hsnCode: string | null }
  color: string | null
  unitPrice: number
  discount: number
  gstRate: number
  ordered: number
  sent: number
  pending: number
  inStock: number
  sizes: PrepSize[] | null
}

interface Prepared {
  order: {
    id: string
    soNumber: string
    status: string
    isJobWork: boolean
    deliveryDate: string | null
    deliveryAddress: string | null
    customerPORef: string | null
    customer: { id: string; name: string; gstin: string | null; shippingCity: string | null; billingCity: string | null }
  }
  stores: Array<{ id: string; name: string }>
  warehouseId: string | null
  lines: PrepLine[]
}

/** A saved draft, as the challan detail returns it. */
interface SavedChallan {
  id: string
  dcNumber: string
  soId: string
  status: string
  dcDate: string
  warehouseId: string | null
  deliveryAddress: string | null
  transporter: string | null
  vehicleNumber: string | null
  lrNumber: string | null
  eWayBillNumber: string | null
  cartons: number | null
  packingNote: string | null
  notes: string | null
  lines: Array<{
    soLineId: string | null
    qty: string | number
    overNote: string | null
    sizes: Array<{ sizeId: string; qty: string | number }>
  }>
}

/** What is typed per line: pieces by size, or one figure, and the over note. */
type SendDraft = Record<string, { sizes: Record<string, string>; qty: string; overNote: string }>

const today = () => new Date().toISOString().slice(0, 10)
const pcs = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
/** The value above which goods need an e-way bill to travel. Shown, not enforced. */
const EWAY_LIMIT = 50_000

function Field({
  label,
  icon: Icon,
  htmlFor,
  className = '',
  children,
}: {
  label: string
  icon?: React.ElementType
  htmlFor?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label className="form-label" htmlFor={htmlFor}>
        {label}
      </label>
      {Icon ? (
        <div className="relative">
          <Icon size={14} className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2" />
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
}

/**
 * The delivery challan form: goods leaving for the buyer against one sales
 * order. Laid out like the purchase forms — Basic Details, then the pieces,
 * then packing and transport — and saved the same two ways as the order:
 * Save as draft, or Dispatch, which takes the pieces out of stock.
 *
 * For each line, each size shows what is still pending and what is packed in
 * the chosen store, with a box for what goes now. "Fill what can go" fills
 * every box with the smaller of the two. Sending more than pending is allowed
 * with a note; more than is in stock is not.
 */
export function DeliveryChallanDialog({
  open,
  soId,
  challanId,
  onClose,
  onSaved,
}: {
  open: boolean
  /** The order to dispatch against, for a new challan. */
  soId: string | null
  /** A draft to change, instead. */
  challanId: string | null
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [prep, setPrep] = useState<Prepared | null>(null)
  const [saved, setSaved] = useState<SavedChallan | null>(null)
  const [loading, setLoading] = useState(false)
  const [warehouseId, setWarehouseId] = useState('')
  const [dcDate, setDcDate] = useState(today())
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [transporter, setTransporter] = useState('')
  const [vehicleNumber, setVehicleNumber] = useState('')
  const [lrNumber, setLrNumber] = useState('')
  const [eWayBillNumber, setEWayBillNumber] = useState('')
  const [cartons, setCartons] = useState('')
  const [packingNote, setPackingNote] = useState('')
  const [notes, setNotes] = useState('')
  const [send, setSend] = useState<SendDraft>({})
  const [saving, setSaving] = useState<'draft' | 'dispatch' | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  /** The order's lines and stock for one store. */
  const loadPrep = useCallback(async (orderId: string, store: string | null) => {
    const qs = new URLSearchParams({ soId: orderId })
    if (store) qs.set('warehouseId', store)
    const res = await api.get<{ data: Prepared }>(`/sales/challans/prepare?${qs}`)
    return res.data
  }, [])

  // Opening: a draft's own figures, or a fresh challan for the order.
  useEffect(() => {
    if (!open) return
    let alive = true
    setError(null)
    setPrep(null)
    setSaved(null)
    setSend({})
    setDcDate(today())
    setTransporter('')
    setVehicleNumber('')
    setLrNumber('')
    setEWayBillNumber('')
    setCartons('')
    setPackingNote('')
    setNotes('')
    setLoading(true)
    void (async () => {
      try {
        let draft: SavedChallan | null = null
        if (challanId) draft = (await api.get<{ data: SavedChallan }>(`/sales/challans/${challanId}`)).data
        const orderId = draft?.soId ?? soId
        if (!orderId) throw new Error('No order to dispatch against.')
        const p = await loadPrep(orderId, draft?.warehouseId ?? null)
        if (!alive) return
        setPrep(p)
        setWarehouseId(p.warehouseId ?? '')
        if (draft) {
          setSaved(draft)
          setDcDate(draft.dcDate.slice(0, 10))
          setDeliveryAddress(draft.deliveryAddress ?? '')
          setTransporter(draft.transporter ?? '')
          setVehicleNumber(draft.vehicleNumber ?? '')
          setLrNumber(draft.lrNumber ?? '')
          setEWayBillNumber(draft.eWayBillNumber ?? '')
          setCartons(draft.cartons != null ? String(draft.cartons) : '')
          setPackingNote(draft.packingNote ?? '')
          setNotes(draft.notes ?? '')
          const next: SendDraft = {}
          for (const l of draft.lines) {
            if (!l.soLineId) continue
            next[l.soLineId] = {
              sizes: Object.fromEntries(l.sizes.map((s) => [s.sizeId, String(Number(s.qty))])),
              qty: l.sizes.length ? '' : String(Number(l.qty)),
              overNote: l.overNote ?? '',
            }
          }
          setSend(next)
        } else {
          setDeliveryAddress(p.order.deliveryAddress ?? '')
        }
      } catch (err) {
        if (alive) setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not open the order.')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, soId, challanId, loadPrep])

  // A different store: its stock is read again; what was typed stays.
  const pickStore = async (store: string) => {
    setWarehouseId(store)
    if (!prep || !store) return
    try {
      setPrep(await loadPrep(prep.order.id, store))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that store.')
    }
  }

  const draftOf = (soLineId: string) => send[soLineId] ?? { sizes: {}, qty: '', overNote: '' }
  const setDraft = (soLineId: string, patch: Partial<SendDraft[string]>) =>
    setSend((s) => ({ ...s, [soLineId]: { ...draftOf(soLineId), ...patch } }))

  /** Every box filled with what can go: the smaller of pending and in stock. */
  const fillAll = () => {
    if (!prep) return
    const next: SendDraft = {}
    for (const l of prep.lines) {
      next[l.soLineId] = l.sizes
        ? {
            sizes: Object.fromEntries(
              l.sizes.map((s) => [s.sizeId, String(Math.max(0, Math.min(s.pending, s.inStock)) || '')])
            ),
            qty: '',
            overNote: draftOf(l.soLineId).overNote,
          }
        : { sizes: {}, qty: String(Math.max(0, Math.min(l.pending, l.inStock)) || ''), overNote: draftOf(l.soLineId).overNote }
    }
    setSend(next)
  }

  // ── What is being sent, line by line ───────────────────────────────────
  const rows = useMemo(() => {
    if (!prep) return []
    return prep.lines.map((l) => {
      const d = send[l.soLineId] ?? { sizes: {}, qty: '', overNote: '' }
      const sizes = (l.sizes ?? []).map((s) => {
        const now = Number(d.sizes[s.sizeId]) || 0
        return { ...s, now, over: now > s.pending, short: now > s.inStock }
      })
      const now = l.sizes ? sizes.reduce((t, s) => t + s.now, 0) : Number(d.qty) || 0
      const over = l.sizes ? sizes.some((s) => s.over) : now > l.pending
      const short = l.sizes ? sizes.some((s) => s.short) : now > l.inStock
      const value = now * l.unitPrice * (1 - l.discount / 100)
      return { l, d, sizes, now, over, short, value, gst: value * (l.gstRate / 100) }
    })
  }, [prep, send])

  const pieces = rows.reduce((t, r) => t + r.now, 0)
  const value = rows.reduce((t, r) => t + r.value + r.gst, 0)
  const noNote = rows.find((r) => r.now > 0 && r.over && !r.d.overNote.trim())
  const short = rows.find((r) => r.short)

  const blocker = !prep
    ? null
    : !warehouseId
      ? 'Pick the store the goods leave from.'
      : pieces <= 0
        ? 'Put the pieces to send against at least one line.'
        : noNote
          ? `${noNote.l.item.code}: more than the order still wants. Add a note saying why.`
          : null
  // Short of stock still saves as a draft; it cannot go until the stock is there.
  const dispatchBlocker = blocker ?? (short ? `Not enough of ${short.l.item.code} in this store to dispatch.` : null)

  const save = async (dispatch: boolean) => {
    if (!prep || (dispatch ? dispatchBlocker : blocker)) return
    setSaving(dispatch ? 'dispatch' : 'draft')
    setError(null)
    const body = {
      soId: prep.order.id,
      dcDate,
      warehouseId,
      deliveryAddress: deliveryAddress.trim() || null,
      transporter: transporter.trim() || null,
      vehicleNumber: vehicleNumber.trim().toUpperCase() || null,
      lrNumber: lrNumber.trim() || null,
      eWayBillNumber: eWayBillNumber.trim() || null,
      cartons: cartons ? Number(cartons) : null,
      packingNote: packingNote.trim() || null,
      notes: notes.trim() || null,
      dispatch,
      lines: rows
        .filter((r) => r.now > 0)
        .map((r) => ({
          soLineId: r.l.soLineId,
          sizes: r.l.sizes ? r.sizes.filter((s) => s.now > 0).map((s) => ({ sizeId: s.sizeId, qty: s.now })) : undefined,
          qty: r.l.sizes ? undefined : r.now,
          overNote: r.d.overNote.trim() || null,
        })),
    }
    try {
      const res = saved
        ? await api.patch<{ message?: string }>(`/sales/challans/${saved.id}`, body)
        : await api.post<{ message?: string }>('/sales/challans', body)
      onSaved(res.message ?? (dispatch ? 'Dispatched.' : 'Challan saved as a draft.'))
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the challan.')
    } finally {
      setSaving(null)
    }
  }

  if (!open || !mounted) return null

  const o = prep?.order
  const late = o?.deliveryDate && new Date(o.deliveryDate) < new Date(new Date().toDateString())
  const busy = saving !== null || loading

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="dc-title">
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <Truck size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="dc-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                Delivery Challan
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {o ? `Against ${o.soNumber} · ${o.customer.name}` : 'Goods leaving for the buyer'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="btn-primary hidden md:inline-flex"
              onClick={() => void save(true)}
              disabled={busy || !!dispatchBlocker}
            >
              {saving === 'dispatch' ? <Loader2 size={15} className="animate-spin" /> : <Truck size={15} />} Dispatch
            </button>
            <button onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={saving !== null}>
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
              <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}
          {loading || !prep || !o ? (
            !error && <div className="skeleton h-72 w-full rounded-xl" />
          ) : (
            <>
              <Section icon={FileText} title="Basic Details">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-4 gap-y-3 md:grid-cols-4">
                  <Field label="Sales order" icon={Hash}>
                    <div className="form-input pl-9 font-mono">{o.soNumber}</div>
                  </Field>
                  <Field label="Challan no." icon={Hash}>
                    <div className="form-input text-muted-foreground pl-9 font-mono">{saved?.dcNumber ?? 'Given when saved'}</div>
                  </Field>
                  <Field label="Challan date" htmlFor="dc-date">
                    <input id="dc-date" type="date" className="form-input" value={dcDate} max={today()} onChange={(e) => setDcDate(e.target.value || today())} />
                  </Field>
                  <Field label="From store" icon={WarehouseIcon} htmlFor="dc-store">
                    <SmartSelect id="dc-store" className="form-input pl-9" value={warehouseId} onChange={(e) => void pickStore(e.target.value)}>
                      <option value="">Choose a store</option>
                      {prep.stores.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </Field>
                  <Field label="Deliver to" icon={MapPin} htmlFor="dc-address" className="md:col-span-4">
                    <input
                      id="dc-address"
                      className="form-input pl-9"
                      value={deliveryAddress}
                      maxLength={500}
                      placeholder="From the order"
                      onChange={(e) => setDeliveryAddress(e.target.value)}
                    />
                  </Field>
                </div>
                <div className="border-border bg-secondary/30 mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border px-3 py-2 text-xs">
                  <span className="text-foreground font-medium">{o.customer.name}</span>
                  {o.customer.gstin && <span className="text-muted-foreground font-mono">GSTIN {o.customer.gstin}</span>}
                  {o.customerPORef && <span className="text-muted-foreground">Buyer PO {o.customerPORef}</span>}
                  {o.deliveryDate && (
                    <span className={late ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                      Due {formatDate(o.deliveryDate)}
                      {late ? ' · overdue' : ''}
                    </span>
                  )}
                  {o.isJobWork && <span className="badge-purple">Job work · the customer&apos;s own goods</span>}
                </div>
              </Section>

              <Section
                icon={Package}
                title="Pieces to send"
                actions={
                  <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={fillAll}>
                    <Wand2 size={13} /> Fill what can go
                  </button>
                }
              >
                <p className="text-muted-foreground mb-2 text-xs">
                  For each size: what the order still wants, what is packed in this store, and what goes now. &quot;Fill what
                  can go&quot; puts the smaller of the two in every box.
                </p>
                <div className="space-y-3">
                  {rows.map(({ l, d, sizes, now, over, short: lineShort }) => (
                    <div key={l.soLineId} className="border-border bg-card rounded-lg border p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <p className="text-foreground text-sm font-medium">
                          <span className="font-mono text-xs">{l.item.code}</span> — {l.item.name}
                          {(l.color || l.item.color) && <span className="text-muted-foreground font-normal"> · {l.color || l.item.color}</span>}
                        </p>
                        <p className="text-muted-foreground text-xs tabular-nums">
                          Ordered {pcs(l.ordered)} · Sent {pcs(l.sent)} · <span className="text-foreground font-medium">Pending {pcs(l.pending)}</span>
                        </p>
                      </div>
                      <div className="mt-2 overflow-x-auto">
                        <table className="subtable w-auto">
                          <thead>
                            <tr>
                              <th className="text-left" />
                              {l.sizes ? (
                                sizes.map((s) => (
                                  <th key={s.sizeId} className="w-16 text-center">
                                    {s.code}
                                  </th>
                                ))
                              ) : (
                                <th className="w-24 text-center">Pieces</th>
                              )}
                              <th className="w-16 text-right">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td className="text-muted-foreground pr-4 text-xs">Pending</td>
                              {l.sizes ? (
                                sizes.map((s) => (
                                  <td key={s.sizeId} className="text-center text-xs tabular-nums">
                                    {pcs(s.pending)}
                                  </td>
                                ))
                              ) : (
                                <td className="text-center text-xs tabular-nums">{pcs(l.pending)}</td>
                              )}
                              <td className="text-right text-xs tabular-nums">{pcs(l.pending)}</td>
                            </tr>
                            <tr>
                              <td className="text-muted-foreground pr-4 text-xs">In stock</td>
                              {l.sizes ? (
                                sizes.map((s) => (
                                  <td key={s.sizeId} className={`text-center text-xs tabular-nums ${s.inStock < s.pending ? 'warn-text' : ''}`}>
                                    {pcs(s.inStock)}
                                  </td>
                                ))
                              ) : (
                                <td className={`text-center text-xs tabular-nums ${l.inStock < l.pending ? 'warn-text' : ''}`}>{pcs(l.inStock)}</td>
                              )}
                              <td className="text-right text-xs tabular-nums">{pcs(l.inStock)}</td>
                            </tr>
                            <tr>
                              <td className="text-foreground pr-4 text-xs font-medium">Send now</td>
                              {l.sizes ? (
                                sizes.map((s) => (
                                  <td key={s.sizeId} className="px-1 py-1">
                                    <StepInput
                                      className={`form-input h-8 w-14 px-1 text-center text-xs tabular-nums ${
                                        s.short ? 'border-destructive/60' : s.over ? 'border-primary/60' : ''
                                      }`}
                                      value={d.sizes[s.sizeId] ?? ''}
                                      placeholder="0"
                                      aria-label={`${l.item.code} size ${s.code}, send now`}
                                      title={s.short ? `Only ${pcs(s.inStock)} in this store` : s.over ? 'More than the order still wants' : undefined}
                                      onValueChange={(v) => setDraft(l.soLineId, { sizes: { ...d.sizes, [s.sizeId]: v } })}
                                    />
                                  </td>
                                ))
                              ) : (
                                <td className="px-1 py-1">
                                  <StepInput
                                    className={`form-input h-8 w-20 px-1 text-center text-xs tabular-nums ${lineShort ? 'border-destructive/60' : over ? 'border-primary/60' : ''}`}
                                    value={d.qty}
                                    placeholder="0"
                                    aria-label={`${l.item.code}, send now`}
                                    onValueChange={(v) => setDraft(l.soLineId, { qty: v })}
                                  />
                                </td>
                              )}
                              <td className="text-foreground text-right text-xs font-semibold tabular-nums">{pcs(now)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      {now > 0 && over && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="text-xs">More than the order still wants. Why?</span>
                          <input
                            className="form-input h-8 min-w-0 flex-1 basis-60 text-xs"
                            maxLength={300}
                            value={d.overNote}
                            placeholder="Buyer asked for 10 extra"
                            onChange={(e) => setDraft(l.soLineId, { overNote: e.target.value })}
                          />
                        </div>
                      )}
                      {lineShort && (
                        <p className="text-destructive mt-1.5 text-xs">Not enough in this store. It can be saved as a draft, but not dispatched yet.</p>
                      )}
                    </div>
                  ))}
                </div>
              </Section>

              <Section icon={Truck} title="Packing and transport">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-4 gap-y-3 md:grid-cols-4">
                  <Field label="Cartons" htmlFor="dc-cartons">
                    <StepInput id="dc-cartons" className="form-input tabular-nums" value={cartons} placeholder="0" onValueChange={setCartons} />
                  </Field>
                  <Field label="Transporter" htmlFor="dc-transporter">
                    <input id="dc-transporter" className="form-input" maxLength={120} value={transporter} onChange={(e) => setTransporter(e.target.value)} />
                  </Field>
                  <Field label="Vehicle no." htmlFor="dc-vehicle">
                    <input id="dc-vehicle" className="form-input font-mono uppercase" maxLength={30} value={vehicleNumber} placeholder="MH04AB1234" onChange={(e) => setVehicleNumber(e.target.value)} />
                  </Field>
                  <Field label="LR no." htmlFor="dc-lr">
                    <input id="dc-lr" className="form-input font-mono" maxLength={60} value={lrNumber} onChange={(e) => setLrNumber(e.target.value)} />
                  </Field>
                  <Field label="E-way bill no." htmlFor="dc-eway">
                    <input id="dc-eway" className="form-input font-mono" maxLength={30} value={eWayBillNumber} onChange={(e) => setEWayBillNumber(e.target.value)} />
                  </Field>
                  <Field label="Packing" htmlFor="dc-packing" className="md:col-span-3">
                    <input
                      id="dc-packing"
                      className="form-input"
                      maxLength={500}
                      value={packingNote}
                      placeholder="Cartons 1–20, 20 pcs each, size ratio 2:5:6:5:2"
                      onChange={(e) => setPackingNote(e.target.value)}
                    />
                  </Field>
                  <Field label="Notes" htmlFor="dc-notes" className="md:col-span-4">
                    <input id="dc-notes" className="form-input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
                  </Field>
                </div>
                {pieces > 0 && (
                  <p className={`mt-3 flex items-start gap-1.5 text-xs ${value > EWAY_LIMIT && !eWayBillNumber.trim() ? 'warn-text' : 'text-muted-foreground'}`}>
                    <Info size={13} className="mt-px shrink-0" />
                    {pcs(pieces)} pcs worth {formatRupees(Math.round(value))} with GST.{' '}
                    {value > EWAY_LIMIT
                      ? 'Above ₹50,000, so the goods need an e-way bill to travel.'
                      : 'Under ₹50,000: no e-way bill needed.'}
                  </p>
                )}
              </Section>
            </>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3.5">
          {prep && dispatchBlocker && !loading && (
            <p className="warn-text mr-auto flex max-w-xl basis-full items-start gap-1.5 text-xs sm:basis-auto">
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>{dispatchBlocker}</span>
            </p>
          )}
          <button type="button" onClick={onClose} className="btn-secondary hidden sm:inline-flex" disabled={saving !== null}>
            Cancel
          </button>
          <button type="button" className="btn-secondary" onClick={() => void save(false)} disabled={busy || !!blocker}>
            {saving === 'draft' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            <span className="sm:hidden">Draft</span>
            <span className="hidden sm:inline">Save as draft</span>
          </button>
          <button type="button" className="btn-primary" onClick={() => void save(true)} disabled={busy || !!dispatchBlocker}>
            {saving === 'dispatch' ? <Loader2 size={15} className="animate-spin" /> : <Truck size={15} />} Dispatch
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
