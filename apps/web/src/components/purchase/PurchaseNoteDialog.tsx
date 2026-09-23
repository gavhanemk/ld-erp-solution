'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Calculator,
  FileMinus,
  FilePlus2,
  HelpCircle,
  Info,
  Link2,
  Loader2,
  MessageSquare,
  Package,
  Paperclip,
  Truck,
  X,
} from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'
import { Section } from '@/components/purchase/Section'
import { AttachmentsBox, type AttachmentsBoxHandle } from '@/components/purchase/AttachmentsBox'
import type { PurchaseNote, NoteType } from '@/components/purchase/noteTypes'

/**
 * Raising a debit or credit note against a supplier.
 *
 * One form for both. They adjust the same bill against the same remaining
 * balance and differ only in who signed the paper, so the difference is a
 * field near the top rather than a second file that drifts.
 *
 * ── The shape of it ─────────────────────────────────────────────────────────
 *
 * The first thing asked is **what happened**, not what document to raise. A
 * buyer knows that eighty metres came back short and does not know whether
 * that is a debit or a credit against the supplier's ledger — and a form that
 * asks them to decide gets a coin toss recorded as an accounting position.
 * The reason then chooses the document, the direction, and whether a godown
 * has to be named; all three stay visible and the first two stay changeable,
 * because the supplier sometimes gets there first with their own credit note.
 *
 * The lines are **picked from the bill**, never typed. Each row shows what was
 * billed and what is still adjustable after every other note standing against
 * it, so the ceiling is visible while the number is being typed rather than
 * explained by a refusal afterwards.
 */

interface Option {
  id: string
  code?: string
  name: string
}

interface ReasonOption {
  value: string
  label: string
  hint: string
  defaultType: NoteType
  effect: 'REDUCES_PAYABLE' | 'INCREASES_PAYABLE'
  movesGoods: boolean
  consumesQty: boolean
}

interface BillOption {
  id: string
  billNumber: string
  supplierInvoiceNo: string | null
  billDate: string
  totalAmount: string | number
  balanceAmount: string | number
  status: string
  supplier?: { id: string; name: string } | null
}

interface AdjustableLine {
  billLineId: string
  itemId: string
  itemCode: string
  itemName: string
  uom: string | null
  description: string | null
  hsnCode: string | null
  gstRate: number
  billedQty: number
  billedRate: number
  billedTaxable: number
  adjustedQty: number
  adjustedValue: number
  remainingQty: number
  remainingValue: number
}

interface BillContext {
  bill: {
    id: string
    billNumber: string
    supplierInvoiceNo: string | null
    supplierInvoiceDate: string | null
    billDate: string
    totalAmount: string | number
    paidAmount: string | number
    noteAdjustment: string | number
    balanceAmount: string | number
    status: string
    supplier: { id: string; code: string; name: string; gstin: string | null }
    po: { id: string; poNumber: string } | null
    receipts: Array<{ id: string; grnNumber: string }>
  }
  isIntraState: boolean
  lines: AdjustableLine[]
}

/** One row of the form, which is a bill line plus what is being taken off it. */
interface FormLine {
  billLineId: string | null
  itemId: string
  picked: boolean
  qty: string
  unitPrice: string
  gstRate: number
  remarks: string
  /** Everything needed to draw the row without going back to the context. */
  meta: AdjustableLine | null
}

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const inr = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const qtyFmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })

const round2 = (n: number) => Math.round(n * 100) / 100

export function PurchaseNoteDialog({
  open,
  onClose,
  onSaved,
  record,
  /** Which module the form was opened from. Decides the default document. */
  moduleType,
  initialBillId,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  record?: PurchaseNote | null
  moduleType: NoteType
  /** A bill to open straight onto, for "Adjust this bill" on the bills screen. */
  initialBillId?: string | null
}) {
  const isEdit = Boolean(record)

  const [reasons, setReasons] = useState<ReasonOption[]>([])
  const [suppliers, setSuppliers] = useState<Option[]>([])
  const [warehouses, setWarehouses] = useState<Option[]>([])
  const [bills, setBills] = useState<BillOption[]>([])

  const [noteType, setNoteType] = useState<NoteType>(moduleType)
  const [reason, setReason] = useState<string>('')
  const [reasonNote, setReasonNote] = useState('')
  const [effect, setEffect] = useState<'REDUCES_PAYABLE' | 'INCREASES_PAYABLE'>('REDUCES_PAYABLE')

  const [supplierId, setSupplierId] = useState('')
  const [billId, setBillId] = useState<string>('')
  const [noBill, setNoBill] = useState(false)
  const [withoutBillReason, setWithoutBillReason] = useState('')
  const [noteDate, setNoteDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [supplierDocNo, setSupplierDocNo] = useState('')
  const [supplierDocDate, setSupplierDocDate] = useState('')

  const [warehouseId, setWarehouseId] = useState('')
  const [lrNumber, setLrNumber] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [otherRef, setOtherRef] = useState('')

  const [otherCharges, setOtherCharges] = useState('')
  const [discountAmount, setDiscountAmount] = useState('')
  const [notes, setNotes] = useState('')

  const [context, setContext] = useState<BillContext | null>(null)
  const [formLines, setFormLines] = useState<FormLine[]>([])

  const [pulling, setPulling] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const filesRef = useRef<AttachmentsBoxHandle>(null)
  const [fileCount, setFileCount] = useState(0)

  const rule = useMemo(() => reasons.find((r) => r.value === reason), [reasons, reason])

  // ── Opening ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return
    setError(null)
    setNoteType(record?.noteType ?? moduleType)
    setReason(record?.reason ?? '')
    setReasonNote(record?.reasonNote ?? '')
    setEffect(record?.effect ?? 'REDUCES_PAYABLE')
    setSupplierId(record?.supplier?.id ?? '')
    setBillId(record?.bill?.id ?? initialBillId ?? '')
    setNoBill(Boolean(record) && !record?.bill)
    setWithoutBillReason(record?.withoutBillReason ?? '')
    setNoteDate((record?.noteDate ?? new Date().toISOString()).slice(0, 10))
    setSupplierDocNo(record?.supplierDocNo ?? '')
    setSupplierDocDate(record?.supplierDocDate?.slice(0, 10) ?? '')
    setWarehouseId(record?.warehouse?.id ?? '')
    setLrNumber(record?.lrNumber ?? '')
    setVehicleNo(record?.vehicleNo ?? '')
    setOtherRef(record?.otherRef ?? '')
    setOtherCharges(num(record?.otherCharges) > 0 ? String(record?.otherCharges) : '')
    setDiscountAmount(num(record?.discountAmount) > 0 ? String(record?.discountAmount) : '')
    setNotes(record?.notes ?? '')
    setContext(null)
    setFormLines([])
  }, [open, record, moduleType, initialBillId])

  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const [r, s, w] = await Promise.all([
          api.get<{ data: ReasonOption[] }>('/purchase/notes/reasons'),
          masterResource<Option>('suppliers').list({ limit: 500 }),
          masterResource<Option>('warehouses').list({ limit: 200 }),
        ])
        setReasons(r.data)
        setSuppliers([...s.data].sort((a, b) => a.name.localeCompare(b.name)))
        setWarehouses(w.data)
      } catch {
        setError('Could not load the lists this form needs. Is the API running?')
      }
    })()
  }, [open])

  /* The bills worth offering: this supplier's, still standing.
     A cancelled bill has nothing left to adjust and the server refuses one, so
     it is never put in the list to be chosen in the first place. */
  useEffect(() => {
    if (!open || noBill) return
    void (async () => {
      try {
        const qs = new URLSearchParams({ limit: '100' })
        if (supplierId) qs.set('supplierId', supplierId)
        const res = await api.get<{ data: BillOption[] }>(`/purchase/bills?${qs}`)
        setBills(res.data.filter((b) => b.status !== 'CANCELLED'))
      } catch {
        setBills([])
      }
    })()
  }, [open, supplierId, noBill])

  /* What the chosen bill has left, line by line. Re-asked whenever the bill
     changes, and told which note to ignore when one is being edited — without
     that, re-saving a note unchanged fails against its own earlier figures. */
  const loadBill = useCallback(
    async (id: string) => {
      setPulling(true)
      setError(null)
      try {
        const qs = record?.id ? `?exclude=${record.id}` : ''
        const res = await api.get<{ data: BillContext }>(`/purchase/notes/adjustable/${id}${qs}`)
        setContext(res.data)
        setSupplierId(res.data.bill.supplier.id)

        const existing = new Map(
          (record?.lines ?? []).map((l) => [l.billLineId ?? `item:${l.item.id}`, l])
        )

        setFormLines(
          res.data.lines.map((l) => {
            const was = existing.get(l.billLineId)
            return {
              billLineId: l.billLineId,
              itemId: l.itemId,
              picked: Boolean(was),
              qty: was ? String(num(was.qty)) : '',
              unitPrice: was ? String(num(was.unitPrice)) : String(l.billedRate),
              gstRate: was ? num(was.gstRate) : l.gstRate,
              remarks: was?.remarks ?? '',
              meta: l,
            }
          })
        )
      } catch (err) {
        setContext(null)
        setFormLines([])
        setError(err instanceof ApiError ? err.message : 'Could not read that bill.')
      } finally {
        setPulling(false)
      }
    },
    [record]
  )

  useEffect(() => {
    if (!open || noBill || !billId) {
      if (!billId) {
        setContext(null)
        setFormLines([])
      }
      return
    }
    void loadBill(billId)
  }, [open, billId, noBill, loadBill])

  /* The reason decides the document and the direction — and keeps deciding
     until somebody overrides it. Applied only when the reason is changed by
     hand, so reopening a saved note never silently re-derives what was on it. */
  const pickReason = (value: string) => {
    setReason(value)
    const r = reasons.find((x) => x.value === value)
    if (r) {
      setNoteType(r.defaultType)
      setEffect(r.effect)
      if (!r.movesGoods) setWarehouseId('')
    }
  }

  const setLine = (index: number, patch: Partial<FormLine>) =>
    setFormLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  // ── Totals, computed the way the server computes them ─────────────────────

  const picked = formLines.filter((l) => l.picked && num(l.qty) > 0)

  const totals = useMemo(() => {
    const intra = context?.isIntraState ?? true
    let taxable = 0
    let cgst = 0
    let sgst = 0
    let igst = 0

    for (const l of picked) {
      const value = round2(num(l.qty) * num(l.unitPrice))
      const tax = round2(value * (l.gstRate / 100))
      taxable += value
      if (intra) {
        cgst += round2(tax / 2)
        sgst += round2(tax / 2)
      } else {
        igst += tax
      }
    }

    taxable = round2(taxable)
    const charges = round2(num(otherCharges))
    const discount = round2(num(discountAmount))
    const before = taxable + round2(cgst) + round2(sgst) + round2(igst) + charges - discount
    const total = Math.round(before)

    return {
      taxable,
      cgst: round2(cgst),
      sgst: round2(sgst),
      igst: round2(igst),
      charges,
      discount,
      roundOff: round2(total - before),
      total,
      intra,
    }
  }, [picked, otherCharges, discountAmount, context])

  /**
   * What is wrong with each line, said in the row rather than at save time.
   *
   * Both ceilings, matching the server: quantity for a claim on the goods, and
   * value always — because a return at an invented rate slips past a quantity
   * check comfortably.
   */
  const lineProblem = (l: FormLine): string | null => {
    if (!l.picked || !l.meta) return null
    const qty = num(l.qty)
    if (qty <= 0) return 'Enter how much is coming off'
    if (rule?.consumesQty && qty > l.meta.remainingQty + 0.0005) {
      return `Only ${qtyFmt(l.meta.remainingQty)}${l.meta.uom ? ` ${l.meta.uom}` : ''} left to adjust`
    }
    const value = round2(qty * num(l.unitPrice))
    if (value > l.meta.remainingValue + 0.005) {
      return `That comes to ₹${inr(value)}; only ₹${inr(l.meta.remainingValue)} of this line is still adjustable`
    }
    return null
  }

  const problems = formLines.map(lineProblem)
  const firstProblem = problems.find(Boolean) ?? null

  // ── Saving ────────────────────────────────────────────────────────────────

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!reason) return setError('Start with what happened — pick a reason at the top.')
    if (reason === 'OTHER' && !reasonNote.trim()) {
      return setError(
        'Say what happened. "Something else" on its own tells the next reader nothing.'
      )
    }
    if (!noBill && !billId) return setError('Pick the supplier bill this adjusts.')
    if (noBill && !withoutBillReason.trim()) {
      return setError('Say why this adjustment has no bill behind it.')
    }
    if (noBill && !supplierId) return setError('Pick the supplier.')
    if (noteType === 'CREDIT' && !supplierDocNo.trim()) {
      return setError("Enter the supplier's credit note number, as printed on their document.")
    }
    if (!picked.length) return setError('Tick at least one line and say how much is coming off it.')
    if (firstProblem) return setError(firstProblem)
    if (rule?.movesGoods && !warehouseId && !noBill) {
      return setError(
        'Name the godown the goods left. Posting the note takes that quantity out of its stock.'
      )
    }

    setSaving(true)
    try {
      const body = {
        noteType,
        reason,
        reasonNote: reasonNote.trim() || null,
        effect,
        supplierId: context?.bill.supplier.id ?? supplierId,
        billId: noBill ? null : billId,
        withoutBillReason: noBill ? withoutBillReason.trim() : null,
        poId: context?.bill.po?.id ?? null,
        grnId: context?.bill.receipts[0]?.id ?? null,
        noteDate,
        supplierDocNo: supplierDocNo.trim() || null,
        supplierDocDate: supplierDocDate || null,
        warehouseId: warehouseId || null,
        lrNumber: lrNumber.trim() || null,
        vehicleNo: vehicleNo.trim() || null,
        otherRef: otherRef.trim() || null,
        otherCharges: num(otherCharges),
        discountAmount: num(discountAmount),
        notes: notes.trim() || null,
        lines: picked.map((l) => ({
          itemId: l.itemId,
          billLineId: l.billLineId,
          description: l.meta?.description ?? null,
          hsnCode: l.meta?.hsnCode ?? null,
          originalQty: l.meta?.billedQty ?? null,
          originalRate: l.meta?.billedRate ?? null,
          qty: num(l.qty),
          unitPrice: num(l.unitPrice),
          gstRate: l.gstRate,
          remarks: l.remarks.trim() || null,
        })),
      }

      const saved = isEdit
        ? await api.patch<{ data: PurchaseNote }>(`/purchase/notes/${record!.id}`, body)
        : await api.post<{ data: PurchaseNote }>('/purchase/notes', body)

      // Files chosen before the note existed are sent now that it has an id. A
      // file that fails does not fail the save that is already done.
      const failed = await filesRef.current?.uploadPending(saved.data.id)
      if (failed?.failed.length) {
        setError(`Saved, but these files did not go up: ${failed.failed.join(', ')}`)
      }

      onSaved()
      if (!failed?.failed.length) onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this note.')
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  const Icon = noteType === 'DEBIT' ? FileMinus : FilePlus2
  const title = noteType === 'DEBIT' ? 'Debit Note' : "Supplier's Credit Note"

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div
        className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-dialog-title"
      >
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="bg-primary/10 border-primary/20 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
              <Icon size={16} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2
                id="note-dialog-title"
                className="text-foreground truncate text-xl font-semibold tracking-tight"
              >
                {isEdit ? `Edit ${record?.noteNumber}` : `New ${title}`}
              </h2>
              <p className="text-muted-foreground mt-0.5 hidden text-[13px] sm:block">
                {noteType === 'DEBIT'
                  ? 'What you are claiming back from the supplier'
                  : 'A reduction the supplier has granted you'}
                {' — saved as a draft; nothing moves until it is posted.'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="submit" form="note-form" className="btn-primary" disabled={saving}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
              <span className="hidden sm:inline">{isEdit ? 'Save changes' : 'Save as draft'}</span>
            </button>
            <button onClick={onClose} className="btn-ghost p-1.5" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        <form id="note-form" onSubmit={submit} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {error && (
              <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {/* ── 1. What happened ────────────────────────────────────────
              First, and as buttons rather than a dropdown. This is the one
              choice on the form that decides three others, and a reader who
              scrolls past a closed select has decided nothing. */}
            <Section icon={HelpCircle} title="What happened?">
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {reasons.map((r) => {
                  const on = reason === r.value
                  return (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => pickReason(r.value)}
                      aria-pressed={on}
                      className={`rounded-lg border p-2.5 text-left transition-colors ${
                        on
                          ? 'border-primary bg-primary/10'
                          : 'border-border bg-secondary hover:border-primary/40'
                      }`}
                    >
                      <p
                        className={`text-[13px] font-medium ${on ? 'text-primary' : 'text-foreground'}`}
                      >
                        {r.label}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
                        {r.hint}
                      </p>
                    </button>
                  )
                })}
              </div>

              {reason === 'OTHER' && (
                <div className="mt-3">
                  <label className="form-label" htmlFor="reason-note">
                    What happened
                  </label>
                  <input
                    id="reason-note"
                    className="form-input"
                    value={reasonNote}
                    onChange={(e) => setReasonNote(e.target.value)}
                    placeholder="50 metres rejected for printing defects; supplier agreed the adjustment"
                    maxLength={500}
                  />
                </div>
              )}

              {rule && (
                <div className="border-border bg-secondary mt-3 grid gap-2 rounded-lg border p-2.5 sm:grid-cols-2">
                  {/* The two things the reason decided. Shown, and changeable:
                    a purchase return is normally our debit note, but if the
                    supplier sent their own credit note first, the same thing
                    happened and the paper is theirs. */}
                  <div>
                    <label className="form-label" htmlFor="note-type">
                      Which document is this?
                    </label>
                    <select
                      id="note-type"
                      className="form-input"
                      value={noteType}
                      onChange={(e) => setNoteType(e.target.value as NoteType)}
                    >
                      <option value="DEBIT">Debit note — we are raising it</option>
                      <option value="CREDIT">Credit note — the supplier sent it</option>
                    </select>
                  </div>
                  <div>
                    <label className="form-label" htmlFor="note-effect">
                      What it does to what we owe
                    </label>
                    <select
                      id="note-effect"
                      className="form-input"
                      value={effect}
                      onChange={(e) =>
                        setEffect(e.target.value as 'REDUCES_PAYABLE' | 'INCREASES_PAYABLE')
                      }
                    >
                      <option value="REDUCES_PAYABLE">Reduces what we owe</option>
                      <option value="INCREASES_PAYABLE">Increases what we owe</option>
                    </select>
                  </div>
                  <p className="text-muted-foreground flex items-start gap-1.5 text-[11px] sm:col-span-2">
                    <Info size={12} className="mt-0.5 shrink-0 opacity-70" />
                    Set from what happened. Change them only if the paperwork actually differs —
                    these two decide which way the money moves when the note is posted.
                  </p>
                </div>
              )}
            </Section>

            {/* ── 2. The bill it adjusts ──────────────────────────────────── */}
            <Section
              icon={Link2}
              title="Which bill does this adjust?"
              actions={
                <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={noBill}
                    onChange={(e) => {
                      setNoBill(e.target.checked)
                      if (e.target.checked) {
                        setBillId('')
                        setContext(null)
                        setFormLines([])
                      }
                    }}
                  />
                  No bill to link
                </label>
              }
            >
              {noBill ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5">
                    <AlertCircle size={14} className="mt-0.5 shrink-0 text-amber-400" />
                    <p className="text-[11px] leading-snug text-amber-400">
                      Nothing checks this one. With a bill behind it the form will not let you claim
                      back more than was charged; without one there is nothing to check it against,
                      so the figures below are taken on trust.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="form-label" htmlFor="no-bill-supplier">
                        Supplier
                      </label>
                      <select
                        id="no-bill-supplier"
                        className="form-input"
                        value={supplierId}
                        onChange={(e) => setSupplierId(e.target.value)}
                      >
                        <option value="">Pick a supplier…</option>
                        {suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="form-label" htmlFor="no-bill-why">
                        Why is there no bill?
                      </label>
                      <input
                        id="no-bill-why"
                        className="form-input"
                        value={withoutBillReason}
                        onChange={(e) => setWithoutBillReason(e.target.value)}
                        placeholder="Goods returned before the supplier invoiced them"
                        maxLength={500}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="form-label" htmlFor="bill-supplier">
                        Supplier <span className="text-muted-foreground">(narrows the list)</span>
                      </label>
                      <select
                        id="bill-supplier"
                        className="form-input"
                        value={supplierId}
                        onChange={(e) => {
                          setSupplierId(e.target.value)
                          setBillId('')
                        }}
                        disabled={Boolean(context)}
                      >
                        <option value="">Any supplier</option>
                        {suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="form-label" htmlFor="bill-pick">
                        Supplier bill
                      </label>
                      <select
                        id="bill-pick"
                        className="form-input"
                        value={billId}
                        onChange={(e) => setBillId(e.target.value)}
                      >
                        <option value="">Pick the bill…</option>
                        {bills.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.billNumber}
                            {b.supplierInvoiceNo ? ` · ${b.supplierInvoiceNo}` : ''} · ₹
                            {inr(num(b.totalAmount))}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {pulling && (
                    <p className="text-muted-foreground flex items-center gap-2 text-xs">
                      <Loader2 size={13} className="animate-spin" /> Reading the bill…
                    </p>
                  )}

                  {/* What the chosen bill is, so nobody has to open it in
                    another tab to be sure they picked the right one. */}
                  {context && (
                    <div className="border-border bg-secondary grid gap-x-4 gap-y-2 rounded-lg border p-3 sm:grid-cols-3 lg:grid-cols-4">
                      <Fact label="Supplier" value={context.bill.supplier.name} />
                      <Fact
                        label="Their invoice"
                        value={context.bill.supplierInvoiceNo ?? '—'}
                        sub={
                          context.bill.supplierInvoiceDate
                            ? new Date(context.bill.supplierInvoiceDate).toLocaleDateString('en-GB')
                            : undefined
                        }
                      />
                      <Fact label="Bill value" value={`₹${inr(num(context.bill.totalAmount))}`} />
                      <Fact
                        label="Still owed"
                        value={`₹${inr(num(context.bill.balanceAmount))}`}
                        sub={
                          num(context.bill.noteAdjustment) > 0
                            ? `after ₹${inr(num(context.bill.noteAdjustment))} of notes`
                            : undefined
                        }
                      />
                      {context.bill.po && (
                        <Fact label="Against order" value={context.bill.po.poNumber} />
                      )}
                      {context.bill.receipts.length > 0 && (
                        <Fact
                          label={context.bill.receipts.length > 1 ? 'Receipts' : 'Receipt'}
                          value={context.bill.receipts.map((r) => r.grnNumber).join(', ')}
                        />
                      )}
                      <Fact
                        label="Tax on it"
                        value={context.isIntraState ? 'CGST + SGST' : 'IGST'}
                        sub="this note follows it"
                      />
                    </div>
                  )}
                </div>
              )}
            </Section>

            {/* ── 3. The lines ────────────────────────────────────────────── */}
            <Section
              icon={Package}
              title="What is coming off the bill?"
              actions={
                picked.length > 0 ? (
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {picked.length} of {formLines.length} lines
                  </span>
                ) : undefined
              }
            >
              {!context ? (
                <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                  <Info size={12} className="mt-0.5 shrink-0 opacity-70" />
                  {noBill
                    ? 'A note with no bill behind it cannot pick lines from one. Link a bill to raise this against.'
                    : 'Pick the bill above and its lines will appear here.'}
                </p>
              ) : formLines.length === 0 ? (
                <p className="text-muted-foreground text-xs">That bill has no lines on it.</p>
              ) : (
                <>
                  <p className="text-muted-foreground mb-2 text-[11px] leading-snug">
                    Tick the lines this note is for. <strong>Left</strong> is what is still
                    adjustable after every other note standing against this bill — yours cannot go
                    past it.
                  </p>

                  {/* ── Wide: a table. Narrow: one card per line ────────────
                    A quantity box squashed to two characters is one somebody
                    mis-keys, and this form's whole job is getting a quantity
                    right. The same split the bill and receipt forms use. */}
                  <div className="border-border hidden overflow-x-auto rounded-lg border sm:block">
                    <table className="w-full min-w-[54rem] text-sm">
                      <thead>
                        <tr className="border-border bg-secondary border-b text-left">
                          <th className="w-8 px-2 py-2"></th>
                          <th className="text-muted-foreground px-2 py-2 text-xs font-medium">
                            Item
                          </th>
                          <th className="text-muted-foreground px-2 py-2 text-right text-xs font-medium">
                            Billed
                          </th>
                          <th className="text-muted-foreground px-2 py-2 text-right text-xs font-medium">
                            Left
                          </th>
                          <th className="text-muted-foreground px-2 py-2 text-right text-xs font-medium">
                            Adjust qty
                          </th>
                          <th className="text-muted-foreground px-2 py-2 text-right text-xs font-medium">
                            Rate
                          </th>
                          <th className="text-muted-foreground px-2 py-2 text-right text-xs font-medium">
                            GST
                          </th>
                          <th className="text-muted-foreground px-2 py-2 text-right text-xs font-medium">
                            Value
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {formLines.map((l, i) => {
                          const m = l.meta!
                          const problem = problems[i]
                          const value = round2(num(l.qty) * num(l.unitPrice))
                          return (
                            <tr
                              key={l.billLineId ?? i}
                              className={`border-border/60 border-b last:border-0 ${
                                l.picked ? 'bg-primary/[0.04]' : ''
                              }`}
                            >
                              <td className="px-2 py-2 align-top">
                                <input
                                  type="checkbox"
                                  className="accent-primary mt-1"
                                  checked={l.picked}
                                  onChange={(e) => setLine(i, { picked: e.target.checked })}
                                  aria-label={`Adjust ${m.itemName}`}
                                />
                              </td>
                              <td className="px-2 py-2 align-top">
                                <p className="text-foreground text-[13px] font-medium">
                                  {m.itemName}
                                </p>
                                <p className="text-muted-foreground text-[11px]">
                                  {m.itemCode}
                                  {m.hsnCode ? ` · HSN ${m.hsnCode}` : ''}
                                </p>
                                {problem && (
                                  <p className="mt-1 text-[11px] text-red-400">{problem}</p>
                                )}
                                {l.picked && !problem && (
                                  <input
                                    className="form-input mt-1.5 h-7 py-0 text-xs"
                                    value={l.remarks}
                                    onChange={(e) => setLine(i, { remarks: e.target.value })}
                                    placeholder="Remark for this line (optional)"
                                    maxLength={500}
                                  />
                                )}
                              </td>
                              <td className="text-muted-foreground px-2 py-2 text-right align-top text-[13px] tabular-nums">
                                {qtyFmt(m.billedQty)}
                                {m.uom ? ` ${m.uom}` : ''}
                                <span className="block text-[11px] opacity-70">
                                  @ ₹{inr(m.billedRate)}
                                </span>
                              </td>
                              <td className="px-2 py-2 text-right align-top text-[13px] tabular-nums">
                                <span
                                  className={
                                    m.remainingQty <= 0 ? 'text-red-400' : 'text-emerald-400'
                                  }
                                >
                                  {qtyFmt(m.remainingQty)}
                                  {m.uom ? ` ${m.uom}` : ''}
                                </span>
                                <span className="text-muted-foreground block text-[11px]">
                                  ₹{inr(m.remainingValue)}
                                </span>
                              </td>
                              <td className="px-2 py-2 align-top">
                                <input
                                  type="number"
                                  step="0.001"
                                  min="0"
                                  className="form-input h-8 w-24 py-0 text-right text-[13px]"
                                  value={l.qty}
                                  disabled={!l.picked}
                                  onChange={(e) => setLine(i, { qty: e.target.value })}
                                  aria-label={`Quantity coming off ${m.itemName}`}
                                />
                              </td>
                              <td className="px-2 py-2 align-top">
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  className="form-input h-8 w-24 py-0 text-right text-[13px]"
                                  value={l.unitPrice}
                                  disabled={!l.picked}
                                  onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                                  aria-label={`Rate for ${m.itemName}`}
                                />
                              </td>
                              <td className="text-muted-foreground px-2 py-2 text-right align-top text-[13px] tabular-nums">
                                {l.gstRate}%
                              </td>
                              <td className="text-foreground px-2 py-2 text-right align-top text-[13px] font-medium tabular-nums">
                                {l.picked ? `₹${inr(value)}` : '—'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="space-y-2 sm:hidden">
                    {formLines.map((l, i) => {
                      const m = l.meta!
                      const problem = problems[i]
                      return (
                        <div
                          key={l.billLineId ?? i}
                          className={`border-border rounded-lg border p-2.5 ${
                            l.picked ? 'bg-primary/[0.05]' : 'bg-secondary'
                          }`}
                        >
                          <label className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="accent-primary mt-0.5"
                              checked={l.picked}
                              onChange={(e) => setLine(i, { picked: e.target.checked })}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="text-foreground block text-[13px] font-medium">
                                {m.itemName}
                              </span>
                              <span className="text-muted-foreground block text-[11px]">
                                {qtyFmt(m.billedQty)}
                                {m.uom ? ` ${m.uom}` : ''} billed @ ₹{inr(m.billedRate)} ·{' '}
                                <span
                                  className={
                                    m.remainingQty <= 0 ? 'text-red-400' : 'text-emerald-400'
                                  }
                                >
                                  {qtyFmt(m.remainingQty)} left
                                </span>
                              </span>
                            </span>
                          </label>
                          {l.picked && (
                            <div className="mt-2 grid grid-cols-2 gap-2">
                              <div>
                                <label className="form-label text-[11px]">Quantity</label>
                                <input
                                  type="number"
                                  step="0.001"
                                  min="0"
                                  className="form-input h-8 py-0 text-[13px]"
                                  value={l.qty}
                                  onChange={(e) => setLine(i, { qty: e.target.value })}
                                />
                              </div>
                              <div>
                                <label className="form-label text-[11px]">Rate</label>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  className="form-input h-8 py-0 text-[13px]"
                                  value={l.unitPrice}
                                  onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                                />
                              </div>
                              {problem && (
                                <p className="col-span-2 text-[11px] text-red-400">{problem}</p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </Section>

            {/* ── 4. Goods and transport ──────────────────────────────────── */}
            {rule?.movesGoods && (
              <Section
                icon={Truck}
                title="The goods going back"
                foldable
                summary={warehouseId ? 'Godown set' : 'No godown named yet'}
              >
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="sm:col-span-2 lg:col-span-1">
                    <label className="form-label" htmlFor="note-warehouse">
                      Godown they left
                    </label>
                    <select
                      id="note-warehouse"
                      className="form-input"
                      value={warehouseId}
                      onChange={(e) => setWarehouseId(e.target.value)}
                    >
                      <option value="">Not taken out of stock</option>
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="form-label" htmlFor="note-lr">
                      LR / RR number
                    </label>
                    <input
                      id="note-lr"
                      className="form-input"
                      value={lrNumber}
                      onChange={(e) => setLrNumber(e.target.value)}
                      maxLength={50}
                    />
                  </div>
                  <div>
                    <label className="form-label" htmlFor="note-vehicle">
                      Vehicle number
                    </label>
                    <input
                      id="note-vehicle"
                      className="form-input"
                      value={vehicleNo}
                      onChange={(e) => setVehicleNo(e.target.value)}
                      maxLength={30}
                    />
                  </div>
                  <div>
                    <label className="form-label" htmlFor="note-ref">
                      Any other reference
                    </label>
                    <input
                      id="note-ref"
                      className="form-input"
                      value={otherRef}
                      onChange={(e) => setOtherRef(e.target.value)}
                      maxLength={100}
                    />
                  </div>
                </div>
                <p className="text-muted-foreground mt-2 flex items-start gap-1.5 text-[11px]">
                  <Info size={12} className="mt-0.5 shrink-0 opacity-70" />
                  Naming a godown is what takes the quantity out of its stock when the note is
                  posted. Leave it blank only if the material never physically moved.
                </p>
              </Section>
            )}

            {/* ── 5. Dates and the supplier's own document ─────────────────── */}
            <Section icon={MessageSquare} title="Dates, references and notes" foldable>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className="form-label" htmlFor="note-date">
                    Note date
                  </label>
                  <input
                    id="note-date"
                    type="date"
                    className="form-input"
                    value={noteDate}
                    onChange={(e) => setNoteDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="form-label" htmlFor="sup-doc-no">
                    Supplier&rsquo;s document number
                    {noteType === 'CREDIT' && <span className="text-red-400"> *</span>}
                  </label>
                  <input
                    id="sup-doc-no"
                    className="form-input"
                    value={supplierDocNo}
                    onChange={(e) => setSupplierDocNo(e.target.value)}
                    placeholder={
                      noteType === 'CREDIT' ? 'As printed on their note' : 'If they sent one'
                    }
                    maxLength={50}
                  />
                </div>
                <div>
                  <label className="form-label" htmlFor="sup-doc-date">
                    Their document date
                  </label>
                  <input
                    id="sup-doc-date"
                    type="date"
                    className="form-input"
                    value={supplierDocDate}
                    max={noteDate}
                    onChange={(e) => setSupplierDocDate(e.target.value)}
                  />
                </div>
                <div className="sm:col-span-2 lg:col-span-3">
                  <label className="form-label" htmlFor="note-notes">
                    Notes
                  </label>
                  <textarea
                    id="note-notes"
                    className="form-input min-h-[70px]"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Anything the next reader needs — what was agreed, and with whom"
                    maxLength={2000}
                  />
                </div>
              </div>
            </Section>

            {/* ── 6. Evidence ─────────────────────────────────────────────── */}
            <Section
              icon={Paperclip}
              title="Evidence behind the claim"
              foldable
              openByDefault={false}
              summary={
                fileCount ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : 'Nothing attached'
              }
            >
              <AttachmentsBox
                ref={filesRef}
                basePath="/purchase/notes"
                linkBasePath="/purchase/notes/attachments"
                recordId={record?.id}
                onError={setError}
                onCountChange={setFileCount}
              />
            </Section>

            {/* ── 7. Totals ───────────────────────────────────────────────── */}
            <Section icon={Calculator} title="What this note comes to">
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="form-label" htmlFor="note-charges">
                      Other charges
                    </label>
                    <input
                      id="note-charges"
                      type="number"
                      step="0.01"
                      min="0"
                      className="form-input"
                      value={otherCharges}
                      onChange={(e) => setOtherCharges(e.target.value)}
                      placeholder="0.00"
                    />
                  </div>
                  <div>
                    <label className="form-label" htmlFor="note-discount">
                      Less discount
                    </label>
                    <input
                      id="note-discount"
                      type="number"
                      step="0.01"
                      min="0"
                      className="form-input"
                      value={discountAmount}
                      onChange={(e) => setDiscountAmount(e.target.value)}
                      placeholder="0.00"
                    />
                  </div>
                </div>

                <div className="border-border bg-secondary space-y-1 rounded-lg border p-3">
                  <Row label="Taxable value" value={totals.taxable} />
                  {totals.intra ? (
                    <>
                      <Row label="CGST" value={totals.cgst} />
                      <Row label="SGST" value={totals.sgst} />
                    </>
                  ) : (
                    <Row label="IGST" value={totals.igst} />
                  )}
                  {totals.charges > 0 && <Row label="Other charges" value={totals.charges} />}
                  {totals.discount > 0 && <Row label="Less discount" value={-totals.discount} />}
                  {totals.roundOff !== 0 && <Row label="Round off" value={totals.roundOff} />}
                  <div className="border-border/70 flex items-center justify-between border-t pt-1.5">
                    <span className="text-foreground text-sm font-semibold">
                      {effect === 'REDUCES_PAYABLE' ? 'Coming off the bill' : 'Added to the bill'}
                    </span>
                    <span className="text-primary text-lg font-semibold tabular-nums">
                      ₹{inr(totals.total)}
                    </span>
                  </div>
                  {context && effect === 'REDUCES_PAYABLE' && (
                    <p className="text-muted-foreground pt-1 text-[11px]">
                      {context.bill.billNumber} owes ₹{inr(num(context.bill.balanceAmount))} today.
                      Posting this would leave{' '}
                      <span className="text-foreground font-medium">
                        ₹{inr(Math.max(0, num(context.bill.balanceAmount) - totals.total))}
                      </span>
                      .
                    </p>
                  )}
                </div>
              </div>
            </Section>
          </div>

          <div className="border-border flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2.5">
            <p className="text-muted-foreground hidden text-[11px] sm:block">
              Saving makes a draft. It has to be submitted, approved and posted before it changes
              what the supplier is owed.
            </p>
            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={onClose} className="btn-ghost">
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
                {isEdit ? 'Save changes' : 'Save as draft'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground text-[11px]">{label}</p>
      <p className="text-foreground truncate text-[13px] font-medium">{value}</p>
      {sub && <p className="text-muted-foreground truncate text-[11px]">{sub}</p>}
    </div>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground tabular-nums">₹{inr(value)}</span>
    </div>
  )
}
