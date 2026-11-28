'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  Hash,
  Info,
  Layers,
  Loader2,
  MapPin,
  Package,
  Printer,
  ReceiptText,
  Save,
  Truck,
  Warehouse as WarehouseIcon,
  Wand2,
  X,
} from 'lucide-react'
import { api, ApiError, apiErrorMessage } from '@/lib/api'
import { formatDate, formatRupees } from '@/lib/utils'
import { useEscape } from '@/lib/useEscape'
import { useDialogFocus } from '@/lib/keys'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

interface PrepSize {
  sizeId: string
  code: string
  sequence: number
  ordered: number
  sent: number
  /** What the size still wants; never below nothing. */
  pending: number
  /** Sent beyond what the size ordered (sizes swapped within the line after a size jump). */
  over?: number
  /** Pieces size changes at stitching made in this size beyond its plan: the most it may go over its order by. */
  gained?: number
  /** Available: loose in the store, not sealed in a carton, not on another draft. */
  inStock: number
  /** B-grade pieces of this size available. */
  inStockB: number
  /** Pieces sealed in a carton: they go with their carton, or once it is opened. */
  sealed?: number
  sealedB?: number
  /** Pieces already on other draft challans from this store, and which drafts. */
  held?: number
  heldOn?: string[]
}

/** Which of the customer's rolls a job-work garment was made from, read from production. */
interface Trace {
  mos: Array<{ id: string; moNumber: string }>
  rolls: Array<{
    barcode: string
    designNo: string | null
    lotNo: string | null
    received: number
    issued: number
    grnNumber: string | null
    partyChallan: string | null
    mrNumbers: string[]
  }>
  cuts: Array<{ cutOrderNumber: string; lotNo: string | null; cutterName: string | null; fabricGiven: number; fabricUsed: number; wastage: number; pieces: number }>
  gaps: Array<{ text: string; moId: string | null; moNumber: string | null }>
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
  inStockB: number
  /** Pieces of the garment sealed in cartons in this store, and which cartons. */
  sealed?: number
  cartons?: string[]
  held?: number
  heldOn?: string[]
  /** What a B-grade piece bills at; empty means the line's own rate. */
  bGradeRate: number | null
  sizes: PrepSize[] | null
  trace?: Trace | null
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
  /** The order's other open drafts: open one rather than start another. */
  otherDrafts?: Array<{ id: string; dcNumber: string; dcDate: string }>
  /** Finished-goods cartons already packed for the order. */
  packedCartons?: Array<{ code: string; pieces: number; onChallan: string | null }>
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
  baleNumbers: string | null
  packingListRef: string | null
  grossWeight: string | number | null
  packingNote: string | null
  notes: string | null
  lines: Array<{
    soLineId: string | null
    grade?: string
    qty: string | number
    overNote: string | null
    sizes: Array<{ sizeId: string; qty: string | number }>
  }>
}

/**
 * What is typed per line: pieces by size, or one figure, and the over note —
 * and the same again for B-grade pieces, which go on a line of their own.
 */
type SendDraft = Record<string, { sizes: Record<string, string>; qty: string; overNote: string; bSizes: Record<string, string>; bQty: string }>
const emptyDraft = (): SendDraft[string] => ({ sizes: {}, qty: '', overNote: '', bSizes: {}, bQty: '' })

const today = () => new Date().toISOString().slice(0, 10)
const pcs = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
const mtr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 3 })
const r2 = (n: number) => Math.round(n * 100) / 100
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

/** One figure on the strip at the top: ordered, dispatched, available, this challan. */
function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'primary' | 'warn' }) {
  return (
    <div className="border-border bg-card min-w-0 rounded-xl border px-3.5 py-2.5">
      <p className="text-muted-foreground truncate text-[11px] font-medium uppercase tracking-wide">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${tone === 'primary' ? 'text-primary' : tone === 'warn' ? 'warn-text' : 'text-foreground'}`}>{value}</p>
    </div>
  )
}

/**
 * The delivery challan: finished goods leaving for the buyer against one sales
 * order, redesigned on 28 Nov 2026 to ask the person dispatching only what is
 * theirs to say — how many of each size go, how they are packed, and how they
 * travel. Three sections (Dispatch quantity, Packing, Shipping), a strip of
 * figures above them, and one bar of actions: Cancel, Save draft, Confirm
 * dispatch. Once dispatched, the challan's print and its invoice are a click
 * away.
 *
 * What production knows is not asked again. On a job-work order, which of the
 * customer's rolls each garment was cut from is read from the receipt, the
 * material issue and the cutting, and shown folded under Fabric traceability;
 * where production has not recorded it, that says so and links to the MO.
 *
 * Available is what can go: loose in the store, not sealed in a carton, not
 * already on another draft. "Fill available" fills each size up to what it
 * still wants, then makes up the line's total from pieces made as another size
 * at stitching (a size jump). A draft moves no stock; dispatching checks the
 * stock again and posts the goods issue.
 */
export function DeliveryChallanDialog({
  open,
  soId,
  challanId,
  onClose,
  onSaved,
  onOpenDraft,
}: {
  open: boolean
  /** The order to dispatch against, for a new challan. */
  soId: string | null
  /** A draft to change, instead. */
  challanId: string | null
  onClose: () => void
  onSaved: (message: string) => void
  /** Open another draft of the same order in this window instead. */
  onOpenDraft?: (challanId: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const router = useRouter()

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
  const [baleNumbers, setBaleNumbers] = useState('')
  const [packingListRef, setPackingListRef] = useState('')
  const [grossWeight, setGrossWeight] = useState('')
  const [packingNote, setPackingNote] = useState('')
  const [notes, setNotes] = useState('')
  const [send, setSend] = useState<SendDraft>({})
  const [saving, setSaving] = useState<'draft' | 'dispatch' | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Dispatched: the challan's print and its invoice are offered next. */
  const [done, setDone] = useState<{ id: string; dcNumber: string; message: string } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Escape closes this window only — not the ones behind it.
  useEscape(() => {
    if (!saving) onClose()
  }, open)
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])
  // Tab goes round inside the form, and focus goes back to the button that opened it.
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, open)

  /** The order's lines and stock for one store; a draft's own pieces are not held against it. */
  const loadPrep = useCallback(async (orderId: string, store: string | null, dcId: string | null) => {
    const qs = new URLSearchParams({ soId: orderId })
    if (store) qs.set('warehouseId', store)
    if (dcId) qs.set('dcId', dcId)
    const res = await api.get<{ data: Prepared }>(`/sales/challans/prepare?${qs}`)
    return res.data
  }, [])

  // Opening: a draft's own figures, or a fresh challan for the order.
  useEffect(() => {
    if (!open) return
    let alive = true
    setError(null)
    setDone(null)
    setPrep(null)
    setSaved(null)
    setSend({})
    setDcDate(today())
    setTransporter('')
    setVehicleNumber('')
    setLrNumber('')
    setEWayBillNumber('')
    setCartons('')
    setBaleNumbers('')
    setPackingListRef('')
    setGrossWeight('')
    setPackingNote('')
    setNotes('')
    setLoading(true)
    void (async () => {
      try {
        let draft: SavedChallan | null = null
        if (challanId) draft = (await api.get<{ data: SavedChallan }>(`/sales/challans/${challanId}`)).data
        const orderId = draft?.soId ?? soId
        if (!orderId) throw new Error('No order to dispatch against.')
        const p = await loadPrep(orderId, draft?.warehouseId ?? null, draft?.id ?? null)
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
          setBaleNumbers(draft.baleNumbers ?? '')
          setPackingListRef(draft.packingListRef ?? '')
          setGrossWeight(draft.grossWeight != null ? String(Number(draft.grossWeight)) : '')
          setPackingNote(draft.packingNote ?? '')
          setNotes(draft.notes ?? '')
          const next: SendDraft = {}
          for (const l of draft.lines) {
            if (!l.soLineId) continue
            const d = next[l.soLineId] ?? emptyDraft()
            const sizes = Object.fromEntries(l.sizes.map((s) => [s.sizeId, String(Number(s.qty))]))
            const qty = l.sizes.length ? '' : String(Number(l.qty))
            next[l.soLineId] =
              l.grade === 'B'
                ? { ...d, bSizes: sizes, bQty: qty, overNote: d.overNote || (l.overNote ?? '') }
                : { ...d, sizes, qty, overNote: l.overNote ?? d.overNote }
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
      setPrep(await loadPrep(prep.order.id, store, saved?.id ?? null))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that store.')
    }
  }

  const draftOf = (soLineId: string) => send[soLineId] ?? emptyDraft()
  const setDraft = (soLineId: string, patch: Partial<SendDraft[string]>) =>
    setSend((s) => ({ ...s, [soLineId]: { ...draftOf(soLineId), ...patch } }))

  /**
   * Every size filled with what can go. Each size first takes what is
   * available, up to what it still wants; then, while the line still wants
   * more, extra pieces a size change made in other sizes make it up (ordered
   * M 200 / L 150, made M 180 / L 170: all 350 go). Never more than the line
   * still wants, nor more than is available.
   */
  const fillAll = () => {
    if (!prep) return
    const next: SendDraft = {}
    for (const l of prep.lines) {
      // Good pieces only: B-grade goes when somebody decides to send it. What
      // is typed of it already counts against what the line still wants.
      const keep = draftOf(l.soLineId)
      const typedB = (sizeId?: string) =>
        sizeId ? Number(keep.bSizes[sizeId]) || 0 : l.sizes ? l.sizes.reduce((t, s) => t + (Number(keep.bSizes[s.sizeId]) || 0), 0) : Number(keep.bQty) || 0
      let left = Math.max(0, l.pending - typedB())
      if (!l.sizes) {
        next[l.soLineId] = { ...keep, sizes: {}, qty: String(Math.max(0, Math.min(left, l.inStock)) || '') }
        continue
      }
      const fill: Record<string, number> = {}
      for (const s of l.sizes) {
        const n = Math.max(0, Math.min(s.pending - typedB(s.sizeId), s.inStock, left))
        fill[s.sizeId] = n
        left -= n
      }
      for (const s of l.sizes) {
        if (left <= 0) break
        // Only what a size change made in this size, less what already went over: other stock stays.
        const n = Math.max(0, Math.min(s.inStock - fill[s.sizeId], left, (s.gained ?? 0) - (s.over ?? 0)))
        fill[s.sizeId] += n
        left -= n
      }
      next[l.soLineId] = { ...keep, sizes: Object.fromEntries(l.sizes.map((s) => [s.sizeId, fill[s.sizeId] > 0 ? String(fill[s.sizeId]) : ''])), qty: '' }
    }
    setSend(next)
  }

  // ── What is being sent, line by line ───────────────────────────────────
  const rows = useMemo(() => {
    if (!prep) return []
    return prep.lines.map((l) => {
      const d = send[l.soLineId] ?? emptyDraft()
      // Good and B-grade pieces count together. `vsOrder`: where each size
      // stands against what it ordered once this challan goes, sent before
      // included (+20 more, −20 fewer).
      const sizes = (l.sizes ?? []).map((s) => {
        const nowA = Number(d.sizes[s.sizeId]) || 0
        const nowB = Number(d.bSizes[s.sizeId]) || 0
        return { ...s, now: nowA, nowB, vsOrder: r2(s.sent + nowA + nowB - s.ordered), short: nowA > s.inStock, shortB: nowB > s.inStockB }
      })
      const nowA = l.sizes ? sizes.reduce((t, s) => t + s.now, 0) : Number(d.qty) || 0
      const nowB = l.sizes ? sizes.reduce((t, s) => t + s.nowB, 0) : Number(d.bQty) || 0
      const now = r2(nowA + nowB)
      // A note is wanted only past the line's total, all sizes together: a
      // size over its own order within it is a size jump, not an over-send.
      const over = now > l.pending
      const differ = !!l.sizes && now > 0 && sizes.some((s) => s.vsOrder > 0)
      const done = r2(l.sent + now) >= l.ordered
      const short = l.sizes ? sizes.some((s) => s.short || s.shortB) : nowA > l.inStock || nowB > l.inStockB
      const bRate = l.bGradeRate ?? l.unitPrice
      const value = nowA * l.unitPrice * (1 - l.discount / 100) + nowB * bRate * (1 - l.discount / 100)
      const showB = l.inStockB > 0 || nowB > 0
      return { l, d, sizes, now, nowA, nowB, showB, over, differ, done, short, value, gst: value * (l.gstRate / 100) }
    })
  }, [prep, send])

  const pieces = rows.reduce((t, r) => t + r.now, 0)
  const value = rows.reduce((t, r) => t + r.value + r.gst, 0)
  const noNote = rows.find((r) => r.now > 0 && r.over && !r.d.overNote.trim())
  const short = rows.find((r) => r.short)
  const totals = useMemo(
    () => ({
      ordered: rows.reduce((t, r) => t + r.l.ordered, 0),
      sent: rows.reduce((t, r) => t + r.l.sent, 0),
      pending: rows.reduce((t, r) => t + r.l.pending, 0),
      available: rows.reduce((t, r) => t + r.l.inStock + r.l.inStockB, 0),
    }),
    [rows]
  )

  const blocker = !prep
    ? null
    : !warehouseId
      ? 'Pick the store the goods leave from.'
      : pieces <= 0
        ? 'Enter the pieces to dispatch against at least one size.'
        : noNote
          ? noNote.l.pending > 0
            ? `${noNote.l.item.code}: ${pcs(noNote.now)} pcs is more than the ${pcs(noNote.l.pending)} the order still wants. Add a note saying why.`
            : `${noNote.l.item.code}: all the order wanted has been sent. Add a note saying why ${pcs(noNote.now)} more pcs go.`
          : null
  // Short of stock still saves as a draft; it cannot go until the stock is there.
  const dispatchBlocker = blocker ?? (short ? `Not enough of ${short.l.item.code} available in this store to dispatch.` : null)

  /** Save as a draft, or confirm the dispatch (the goods issue is posted then). */
  const save = async (dispatch: boolean) => {
    if (!prep || saving) return
    // The buttons stay pressable: what is missing is said, not hidden behind a grey button.
    const stop = dispatch ? dispatchBlocker : blocker
    if (stop) {
      setError(stop)
      bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setSaving(dispatch ? 'dispatch' : 'draft')
    setError(null)
    const weight = grossWeight.trim() ? Number(grossWeight) : null
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
      baleNumbers: baleNumbers.trim() || null,
      packingListRef: packingListRef.trim() || null,
      grossWeight: weight != null && Number.isFinite(weight) ? weight : null,
      packingNote: packingNote.trim() || null,
      notes: notes.trim() || null,
      dispatch,
      lines: rows.flatMap((r) => [
        ...(r.nowA > 0
          ? [
              {
                soLineId: r.l.soLineId,
                sizes: r.l.sizes ? r.sizes.filter((s) => s.now > 0).map((s) => ({ sizeId: s.sizeId, qty: s.now })) : undefined,
                qty: r.l.sizes ? undefined : r.nowA,
                overNote: r.d.overNote.trim() || null,
              },
            ]
          : []),
        // B-grade pieces on a line of their own, billed at the B-grade rate.
        ...(r.nowB > 0
          ? [
              {
                soLineId: r.l.soLineId,
                grade: 'B' as const,
                sizes: r.l.sizes ? r.sizes.filter((s) => s.nowB > 0).map((s) => ({ sizeId: s.sizeId, qty: s.nowB })) : undefined,
                qty: r.l.sizes ? undefined : r.nowB,
                overNote: r.d.overNote.trim() || null,
              },
            ]
          : []),
      ]),
    }
    try {
      const res = saved
        ? await api.patch<{ message?: string; data: { id: string; dcNumber: string } }>(`/sales/challans/${saved.id}`, body)
        : await api.post<{ message?: string; data: { id: string; dcNumber: string } }>('/sales/challans', body)
      const message = res.message ?? (dispatch ? 'Dispatched.' : 'Challan saved as a draft.')
      onSaved(message)
      if (dispatch) {
        // Dispatched: the print and the invoice come next, from here.
        setDone({ id: res.data.id, dcNumber: res.data.dcNumber, message })
        bodyRef.current?.scrollTo({ top: 0 })
      } else onClose()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the challan.'))
      bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    } finally {
      setSaving(null)
    }
  }

  if (!open || !mounted) return null

  const o = prep?.order
  const late = o?.deliveryDate && new Date(o.deliveryDate) < new Date(new Date().toDateString())
  const busy = saving !== null || loading
  const traced = rows.filter((r) => r.l.trace)
  const traceRolls = traced.reduce((t, r) => t + (r.l.trace?.rolls.length ?? 0), 0)
  const traceMetres = traced.reduce((t, r) => t + (r.l.trace?.rolls.reduce((s, x) => s + x.issued, 0) ?? 0), 0)
  const traceGaps = traced.reduce((t, r) => t + (r.l.trace?.gaps.length ?? 0), 0)
  const status = done ? 'Dispatched' : saved ? (dispatchBlocker ? 'Draft' : 'Ready to dispatch') : 'New'

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div ref={dialogRef} className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="dc-title">
        {/* ── Title ── */}
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <Truck size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="dc-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                  {done?.dcNumber ?? saved?.dcNumber ?? 'New delivery challan'}
                </h2>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                    status === 'Dispatched' || status === 'Ready to dispatch'
                      ? 'border-primary/30 bg-primary/10 text-primary'
                      : 'border-border bg-secondary/60 text-muted-foreground'
                  }`}
                >
                  {status}
                </span>
              </div>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">{o ? `${o.soNumber} · ${o.customer.name}` : 'Goods leaving for the buyer'}</p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={saving !== null}>
            <X size={18} />
          </button>
        </div>

        <div ref={bodyRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && !done && (
            <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3" role="alert">
              <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}

          {done ? (
            // ── Dispatched: what comes next ──
            <div className="border-border bg-card mx-auto mt-6 max-w-xl rounded-xl border p-6 text-center">
              <CheckCircle2 size={36} className="text-primary mx-auto" />
              <p className="text-foreground mt-3 text-lg font-semibold">{done.dcNumber} dispatched</p>
              <p className="text-muted-foreground mt-1 text-sm">
                {done.message.replace(`${done.dcNumber} dispatched: `, '').replace(/^./, (c) => c.toUpperCase())}. The goods have left the store and the order is
                updated.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <a href={`/print/delivery-challan/${done.id}`} target="_blank" rel="noreferrer" className="btn-secondary">
                  <Printer size={15} /> Print challan
                </a>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    onClose()
                    router.push(`/sales/invoices?create=${done.id}`)
                  }}
                >
                  <ReceiptText size={15} /> Create invoice
                </button>
              </div>
            </div>
          ) : loading || !prep || !o ? (
            !error && <div className="skeleton h-72 w-full rounded-xl" />
          ) : (
            <>
              {/* ── The order, in one line ── */}
              <div className="border-border bg-card flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border px-4 py-2.5 text-xs">
                <span className="text-foreground text-sm font-semibold">{o.customer.name}</span>
                {o.customer.gstin && <span className="text-muted-foreground font-mono">GSTIN {o.customer.gstin}</span>}
                <span className="text-muted-foreground">
                  Order <span className="text-foreground font-mono">{o.soNumber}</span>
                </span>
                {o.customerPORef && <span className="text-muted-foreground">Buyer PO {o.customerPORef}</span>}
                {o.deliveryDate && (
                  <span className={late ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                    Due {formatDate(o.deliveryDate)}
                    {late ? ' · overdue' : ''}
                  </span>
                )}
                {o.isJobWork && <span className="badge-purple">Job work · the customer&apos;s goods</span>}
              </div>

              {/* Another draft already holds this order's pieces: open it rather than promise them twice. */}
              {(prep.otherDrafts ?? []).length > 0 && (
                <div className="border-primary/30 bg-primary/5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-2.5 text-sm">
                  <Info size={15} className="text-primary shrink-0" />
                  <span className="text-foreground min-w-0 flex-1">
                    {prep.otherDrafts!.map((d) => d.dcNumber).join(', ')} {prep.otherDrafts!.length === 1 ? 'is' : 'are'} already a draft for this order. Its pieces are
                    not counted as available here.
                  </span>
                  {onOpenDraft &&
                    prep.otherDrafts!.map((d) => (
                      <button key={d.id} type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => onOpenDraft(d.id)}>
                        Open {d.dcNumber}
                      </button>
                    ))}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Kpi label="Ordered" value={pcs(totals.ordered)} />
                <Kpi label="Dispatched before" value={pcs(totals.sent)} />
                <Kpi label="Available" value={pcs(totals.available)} tone={totals.available < totals.pending ? 'warn' : undefined} />
                <Kpi label="This challan" value={pcs(pieces)} tone="primary" />
              </div>

              {/* ── A. Dispatch quantity ── */}
              <Section
                icon={Package}
                title="Dispatch quantity"
                actions={
                  <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={fillAll} title="Fill each size with what is available, up to what the order still wants">
                    <Wand2 size={13} /> Fill available
                  </button>
                }
              >
                <div className="space-y-3" data-grid>
                  {rows.map(({ l, d, sizes, now, nowB, showB, over, differ, done: lineDone, short: lineShort }) => (
                    <div key={l.soLineId} data-grid-row className="border-border rounded-lg border">
                      <div className="border-border/70 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-3 py-2">
                        <p className="text-foreground text-sm font-medium">
                          <span className="font-mono text-xs">{l.item.code}</span> — {l.item.name}
                          {(l.color || l.item.color) && !l.item.name.includes((l.color || l.item.color)!) && (
                            <span className="text-muted-foreground font-normal"> · {l.color || l.item.color}</span>
                          )}
                        </p>
                        <p className="text-muted-foreground text-xs tabular-nums">
                          Pending <span className="text-foreground font-semibold">{pcs(l.pending)}</span> of {pcs(l.ordered)}
                        </p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-muted-foreground text-[11px] uppercase tracking-wide">
                              <th className="px-3 py-1.5 text-left font-medium">Size</th>
                              <th className="px-3 py-1.5 text-right font-medium">Ordered</th>
                              <th className="px-3 py-1.5 text-right font-medium">Sent before</th>
                              <th className="px-3 py-1.5 text-right font-medium">Pending</th>
                              <th className="px-3 py-1.5 text-right font-medium">Available</th>
                              <th className="w-32 px-3 py-1.5 text-right font-medium">Dispatch now</th>
                              {showB && <th className="w-32 px-3 py-1.5 text-right font-medium text-amber-600">B-grade now</th>}
                            </tr>
                          </thead>
                          <tbody className="divide-border/60 divide-y">
                            {l.sizes ? (
                              sizes.map((s) => (
                                <tr key={s.sizeId}>
                                  <td className="text-foreground px-3 py-1.5 font-medium">{s.code}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{pcs(s.ordered)}</td>
                                  <td className="text-muted-foreground px-3 py-1.5 text-right tabular-nums">{pcs(s.sent)}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums" title={s.over ? `${pcs(s.over)} already sent more than ordered` : undefined}>
                                    {pcs(s.pending)}
                                  </td>
                                  <td className={`px-3 py-1.5 text-right tabular-nums ${s.inStock < s.pending ? 'warn-text' : ''}`}>
                                    {pcs(s.inStock)}
                                    {showB && s.inStockB > 0 && <span className="block text-[10px] leading-tight text-amber-600">+{pcs(s.inStockB)} B-grade</span>}
                                    {s.sealed ? <span className="text-muted-foreground block whitespace-nowrap text-[10px] leading-tight">+{pcs(s.sealed)} sealed</span> : null}
                                    {s.held ? (
                                      <span className="text-muted-foreground block whitespace-nowrap text-[10px] leading-tight" title={`On ${s.heldOn?.join(', ')}`}>
                                        {pcs(s.held)} on a draft
                                      </span>
                                    ) : null}
                                  </td>
                                  <td className="px-3 py-1">
                                    <StepInput
                                      className={`form-input h-8 w-full text-right tabular-nums ${
                                        s.short ? 'border-destructive/60' : s.vsOrder > 0 && s.now > 0 ? 'border-primary/60' : ''
                                      }`}
                                      value={d.sizes[s.sizeId] ?? ''}
                                      placeholder="0"
                                      aria-label={`${l.item.code} size ${s.code}, send now`}
                                      title={
                                        s.short
                                          ? `Only ${pcs(s.inStock)} available in this store`
                                          : s.vsOrder > 0 && s.now > 0
                                            ? `${pcs(s.vsOrder)} more than ordered`
                                            : undefined
                                      }
                                      onValueChange={(v) => setDraft(l.soLineId, { sizes: { ...d.sizes, [s.sizeId]: v } })}
                                    />
                                  </td>
                                  {showB && (
                                    <td className="px-3 py-1">
                                      <StepInput
                                        className={`form-input h-8 w-full text-right tabular-nums ${s.shortB ? 'border-destructive/60' : ''}`}
                                        value={d.bSizes[s.sizeId] ?? ''}
                                        placeholder="0"
                                        aria-label={`${l.item.code} size ${s.code}, B-grade to send`}
                                        onValueChange={(v) => setDraft(l.soLineId, { bSizes: { ...d.bSizes, [s.sizeId]: v } })}
                                      />
                                    </td>
                                  )}
                                </tr>
                              ))
                            ) : (
                              <tr>
                                <td className="text-muted-foreground px-3 py-1.5">—</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{pcs(l.ordered)}</td>
                                <td className="text-muted-foreground px-3 py-1.5 text-right tabular-nums">{pcs(l.sent)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{pcs(l.pending)}</td>
                                <td className={`px-3 py-1.5 text-right tabular-nums ${l.inStock < l.pending ? 'warn-text' : ''}`}>{pcs(l.inStock)}</td>
                                <td className="px-3 py-1">
                                  <StepInput
                                    className={`form-input h-8 w-full text-right tabular-nums ${lineShort ? 'border-destructive/60' : over ? 'border-primary/60' : ''}`}
                                    value={d.qty}
                                    placeholder="0"
                                    aria-label={`${l.item.code}, send now`}
                                    onValueChange={(v) => setDraft(l.soLineId, { qty: v })}
                                  />
                                </td>
                                {showB && (
                                  <td className="px-3 py-1">
                                    <StepInput
                                      className="form-input h-8 w-full text-right tabular-nums"
                                      value={d.bQty}
                                      placeholder="0"
                                      aria-label={`${l.item.code}, B-grade to send`}
                                      onValueChange={(v) => setDraft(l.soLineId, { bQty: v })}
                                    />
                                  </td>
                                )}
                              </tr>
                            )}
                          </tbody>
                          {l.sizes && sizes.length > 1 && (
                            <tfoot>
                              <tr className="border-border bg-secondary/30 border-t text-sm font-semibold">
                                <td className="px-3 py-1.5">Total</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{pcs(l.ordered)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{pcs(l.sent)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{pcs(l.pending)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{pcs(l.inStock)}</td>
                                <td className="text-primary px-3 py-1.5 text-right tabular-nums">{pcs(now - nowB)}</td>
                                {showB && <td className="px-3 py-1.5 text-right tabular-nums text-amber-600">{pcs(nowB)}</td>}
                              </tr>
                            </tfoot>
                          )}
                        </table>
                      </div>
                      <div className="space-y-1.5 px-3 pb-2.5 empty:hidden">
                        {/* Sizes swapped within the line (a size jump at stitching): said in words, no note needed. */}
                        {differ && (
                          <p className="text-muted-foreground pt-2 text-xs">
                            <span className="text-foreground font-medium">
                              {over ? 'Sizes differ from the order.' : lineDone ? 'Sizes differ from the order: same total.' : 'Sizes differ from the order, within what it still wants.'}
                            </span>{' '}
                            {sizes
                              .filter((s) => s.vsOrder !== 0)
                              .map((s) => (s.vsOrder > 0 ? `Size ${s.code}: ${pcs(s.vsOrder)} more than ordered` : `Size ${s.code}: ${pcs(-s.vsOrder)} fewer than ordered${lineDone ? '' : ' so far'}`))
                              .join(' · ')}
                          </p>
                        )}
                        {now > 0 && over && (
                          <div className="flex flex-wrap items-center gap-2 pt-2">
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
                        {l.sealed && l.cartons?.length ? (
                          <p className="text-muted-foreground pt-2 text-xs">
                            {pcs(l.sealed)} pcs are sealed in {l.cartons.length === 1 ? 'carton' : 'cartons'}{' '}
                            <span className="text-foreground font-mono">{l.cartons.join(', ')}</span>: dispatch {l.cartons.length === 1 ? 'it' : 'them'} from Finished Goods →
                            Cartons, or open {l.cartons.length === 1 ? 'it' : 'one'} there first.
                          </p>
                        ) : null}
                        {lineShort && <p className="text-destructive pt-2 text-xs">Not enough available in this store. It can be saved as a draft, but not dispatched yet.</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>

              {/* ── B. Packing ── */}
              <Section icon={Layers} title="Packing">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-4 gap-y-3 md:grid-cols-4">
                  <Field label="Cartons" htmlFor="dc-cartons">
                    <StepInput id="dc-cartons" className="form-input tabular-nums" value={cartons} placeholder="0" onValueChange={setCartons} />
                  </Field>
                  <Field label="Bale / package no." htmlFor="dc-bales">
                    <input id="dc-bales" className="form-input" maxLength={200} value={baleNumbers} placeholder="e.g. 1, 2" onChange={(e) => setBaleNumbers(e.target.value)} />
                  </Field>
                  <Field label="Packing list ref." htmlFor="dc-plist">
                    <input id="dc-plist" className="form-input font-mono" maxLength={60} value={packingListRef} onChange={(e) => setPackingListRef(e.target.value)} />
                  </Field>
                  <Field label="Gross weight (kg)" htmlFor="dc-weight">
                    <StepInput id="dc-weight" className="form-input tabular-nums" decimals value={grossWeight} placeholder="0" onValueChange={setGrossWeight} />
                  </Field>
                  <Field label="Packing note" htmlFor="dc-packing" className="md:col-span-4">
                    <input
                      id="dc-packing"
                      className="form-input"
                      maxLength={500}
                      value={packingNote}
                      placeholder="Cartons 1–20, 20 pcs each, size ratio 2:5:6:5:2"
                      onChange={(e) => setPackingNote(e.target.value)}
                    />
                  </Field>
                </div>
                {(prep.packedCartons ?? []).length > 0 && (
                  <p className="text-muted-foreground mt-3 flex items-start gap-1.5 text-xs">
                    <Package size={13} className="mt-px shrink-0" />
                    <span>
                      Packed for this order in Finished Goods:{' '}
                      {prep.packedCartons!.map((c) => `${c.code} (${pcs(c.pieces)} pcs${c.onChallan ? `, on ${c.onChallan}` : ''})`).join(' · ')}. Cartons go out on their own challan from
                      Finished Goods → Cartons → Dispatch.
                    </span>
                  </p>
                )}
              </Section>

              {/* ── C. Shipping ── */}
              <Section icon={Truck} title="Shipping">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-4 gap-y-3 md:grid-cols-4">
                  <Field label="Dispatch date" htmlFor="dc-date">
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
                  <Field label="Transporter" htmlFor="dc-transporter">
                    <input id="dc-transporter" className="form-input" maxLength={120} value={transporter} onChange={(e) => setTransporter(e.target.value)} />
                  </Field>
                  <Field label="Vehicle no." htmlFor="dc-vehicle">
                    <input id="dc-vehicle" className="form-input font-mono uppercase" maxLength={30} value={vehicleNumber} placeholder="MH04AB1234" onChange={(e) => setVehicleNumber(e.target.value)} />
                  </Field>
                  <Field label="Deliver to" icon={MapPin} htmlFor="dc-address" className="md:col-span-2">
                    <input id="dc-address" className="form-input pl-9" value={deliveryAddress} maxLength={500} placeholder="From the order" onChange={(e) => setDeliveryAddress(e.target.value)} />
                  </Field>
                  <Field label="LR no." htmlFor="dc-lr">
                    <input id="dc-lr" className="form-input font-mono" maxLength={60} value={lrNumber} onChange={(e) => setLrNumber(e.target.value)} />
                  </Field>
                  <Field label="E-way bill no." icon={Hash} htmlFor="dc-eway">
                    <input id="dc-eway" className="form-input pl-9 font-mono" maxLength={30} value={eWayBillNumber} onChange={(e) => setEWayBillNumber(e.target.value)} />
                  </Field>
                  <Field label="Remarks" htmlFor="dc-notes" className="md:col-span-4">
                    <input id="dc-notes" className="form-input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
                  </Field>
                </div>
                {pieces > 0 && value > EWAY_LIMIT && !eWayBillNumber.trim() && (
                  <p className="warn-text mt-3 flex items-start gap-1.5 text-xs">
                    <Info size={13} className="mt-px shrink-0" />
                    Worth {formatRupees(Math.round(value))} with GST: above ₹50,000, so the goods need an e-way bill to travel.
                  </p>
                )}
              </Section>

              {/* ── Fabric traceability: job work, read from production, folded ── */}
              {o.isJobWork && traced.length > 0 && (
                <Section
                  icon={Layers}
                  title="Fabric traceability"
                  foldable
                  openByDefault={traceGaps > 0}
                  summary={
                    <span className={`text-xs ${traceGaps ? 'warn-text' : 'text-muted-foreground'}`}>
                      {traceRolls
                        ? `${traceRolls} customer ${traceRolls === 1 ? 'roll' : 'rolls'} · ${mtr(traceMetres)} m · from production`
                        : 'No rolls recorded yet'}
                      {traceGaps ? ` · ${traceGaps} to put right` : ''}
                    </span>
                  }
                >
                  <div className="space-y-4">
                    {traced.map(({ l }) => {
                      const t = l.trace!
                      return (
                        <div key={l.soLineId} className="space-y-2">
                          {traced.length > 1 && (
                            <p className="text-foreground text-xs font-medium">
                              <span className="font-mono">{l.item.code}</span> — {l.item.name}
                            </p>
                          )}
                          {t.gaps.map((g, i) => (
                            <p key={i} className="warn-text flex flex-wrap items-start gap-1.5 text-xs">
                              <AlertCircle size={13} className="mt-px shrink-0" />
                              <span className="min-w-0 flex-1">{g.text}</span>
                              {g.moId && (
                                <a href={`/production/orders?open=${g.moId}`} target="_blank" rel="noreferrer" className="text-primary font-medium hover:underline">
                                  Open {g.moNumber}
                                </a>
                              )}
                            </p>
                          ))}
                          {t.rolls.length > 0 && (
                            <div className="border-border overflow-x-auto rounded-lg border">
                              <table className="w-full text-xs">
                                <thead className="bg-secondary/40">
                                  <tr className="text-muted-foreground text-[11px] uppercase tracking-wide">
                                    <th className="px-3 py-1.5 text-left font-medium">Roll barcode</th>
                                    <th className="px-3 py-1.5 text-left font-medium">Design</th>
                                    <th className="px-3 py-1.5 text-left font-medium">Lot</th>
                                    <th className="px-3 py-1.5 text-right font-medium">Received (m)</th>
                                    <th className="px-3 py-1.5 text-right font-medium">Issued (m)</th>
                                    <th className="px-3 py-1.5 text-left font-medium">Receipt · their challan</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-border/60 divide-y">
                                  {t.rolls.map((r) => (
                                    <tr key={r.barcode}>
                                      <td className="text-foreground px-3 py-1.5 font-mono font-medium">{r.barcode}</td>
                                      <td className="px-3 py-1.5">{r.designNo ?? '—'}</td>
                                      <td className="px-3 py-1.5">{r.lotNo ?? '—'}</td>
                                      <td className="px-3 py-1.5 text-right tabular-nums">{mtr(r.received)}</td>
                                      <td className="px-3 py-1.5 text-right tabular-nums">{mtr(r.issued)}</td>
                                      <td className="text-muted-foreground px-3 py-1.5">
                                        {[r.grnNumber, r.partyChallan].filter(Boolean).join(' · ') || '—'}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {t.cuts.map((c) => (
                            <p key={c.cutOrderNumber} className="text-muted-foreground text-xs">
                              Cut on <span className="text-foreground font-mono">{c.cutOrderNumber}</span>
                              {c.lotNo ? ` · lot ${c.lotNo}` : ''} · {mtr(c.fabricGiven)} m given, {mtr(c.fabricUsed)} m used, {mtr(c.wastage)} m wastage ·{' '}
                              <span className="text-foreground font-medium">{pcs(c.pieces)} pcs cut</span>
                              {c.cutterName ? ` · ${c.cutterName}` : ''}
                            </p>
                          ))}
                        </div>
                      )
                    })}
                    <p className="text-muted-foreground text-[11px]">
                      Read from the customer&apos;s receipt, the material issue and cutting, and printed on the challan. To change it, change it there.
                    </p>
                  </div>
                </Section>
              )}
            </>
          )}
        </div>

        {/* ── Actions, always in view ── */}
        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3">
          {done ? (
            <button type="button" onClick={onClose} className="btn-secondary">
              Close
            </button>
          ) : (
            <>
              <p className="mr-auto flex min-w-0 max-w-xl basis-full items-start gap-1.5 text-xs sm:basis-auto">
                {prep && !loading && dispatchBlocker ? (
                  <span className="warn-text flex items-start gap-1.5">
                    <AlertCircle size={13} className="mt-px shrink-0" />
                    <span>{dispatchBlocker}</span>
                  </span>
                ) : prep && pieces > 0 ? (
                  <span className="text-muted-foreground">
                    <span className="text-foreground font-semibold">{pcs(pieces)} pcs</span> · {formatRupees(Math.round(value))} with GST
                  </span>
                ) : null}
              </p>
              <button type="button" onClick={onClose} className="btn-secondary hidden sm:inline-flex" disabled={saving !== null}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void save(false)}
                disabled={busy}
                data-hotkey="save"
                aria-keyshortcuts="Control+S Meta+S"
                title="Save as a draft: no stock moves (Ctrl+S)"
              >
                {saving === 'draft' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save draft
              </button>
              <button type="button" className="btn-primary" onClick={() => void save(true)} disabled={busy} title="Post the goods issue: the pieces leave the store">
                {saving === 'dispatch' ? <Loader2 size={15} className="animate-spin" /> : <Truck size={15} />} Confirm dispatch
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
