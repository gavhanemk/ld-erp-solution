'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Calculator,
  FileMinus,
  FilePlus2,
  Info,
  Landmark,
  Link2,
  Loader2,
  Package,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { api, apiErrorMessage, ApiError, can, masterResource } from '@/lib/api'
import { Section } from '@/components/purchase/Section'
import { AttachmentsBox, type AttachmentsBoxHandle } from '@/components/purchase/AttachmentsBox'
import {
  DOC_WORDS,
  EFFECT_WORDS,
  type NoteDoc,
  type NoteEffect,
  type NoteIssuer,
  type PurchaseNote,
} from '@/components/purchase/noteTypes'
import { SmartSelect } from '@/components/ui/SmartSelect'

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

/** An item, with what a manually typed line needs to default itself from. */
interface ItemOption {
  id: string
  code?: string
  name: string
  hsnCode?: string | null
  standardRate?: string | number | null
  taxRate?: { rate: string | number } | null
  uom?: { symbol: string } | null
}

/**
 * What happened. An event — nothing more.
 *
 * `commonly` is the document this usually turns out to be. It is a starting
 * point for the ordinary case and is labelled as one on screen; it is not the
 * answer, because the event does not have one.
 */
interface ReasonOption {
  value: string
  label: string
  hint: string
  movesGoods: boolean
  consumesQty: boolean
  commonly: NoteDoc
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

/** A receipt worth offering to pull rejected quantity off — one with some. */
interface GrnOption {
  id: string
  grnNumber: string
  status: string
  po: { supplier?: { id: string; name: string } | null } | null
  lines: Array<{ rejectedQty: string | number }>
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
  grnId: string | null
  rejectedQty: number
  receivedQty: number
  acceptedQty: number
  warehouseId: string | null
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

/** What a receipt still has left to note — the counterpart to `AdjustableLine`, for a note with no bill behind it. */
interface AdjustableGrnLine {
  grnLineId: string
  itemId: string
  itemCode: string
  itemName: string
  uom: string | null
  hsnCode: string | null
  gstRate: number
  rejectedQty: number
  rejectedRate: number
  receivedQty: number
  acceptedQty: number
  notedQty: number
  remainingQty: number
  warehouseId: string
}

interface GrnContext {
  grn: { id: string; grnNumber: string; status: string }
  po: {
    id: string
    poNumber: string
    supplier: { id: string; code: string; name: string; gstin: string | null }
  }
  lines: AdjustableGrnLine[]
}

/** One row of the form — a bill line, a receipt line, or a hand-typed item, plus what is being claimed for it. */
interface FormLine {
  billLineId: string | null
  /** The receipt line this claims, when it was pulled from one. */
  grnLineId: string | null
  itemId: string
  picked: boolean
  qty: string
  unitPrice: string
  gstRate: number
  remarks: string
  /** Everything needed to draw a bill-picked row without going back to the context. Null for a receipt-picked or hand-typed line — nothing bounds those. */
  meta: AdjustableLine | null
  /** Set on a receipt-picked line, for the same reason `meta` is on a bill-picked one. */
  grnMeta: AdjustableGrnLine | null
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
  initialGrnId,
  financialOnly = false,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  record?: PurchaseNote | null
  moduleType: NoteDoc
  /** A bill to open straight onto, for "Adjust this bill" on the bills screen. */
  initialBillId?: string | null
  /**
   * A receipt to open straight onto, for "Raise a note" beside a rejected
   * line on the goods-receipt screen — the same shortcut `initialBillId` is,
   * for the document a note can be raised against when there is no bill.
   */
  initialGrnId?: string | null
  /**
   * A money-only adjustment: a rate difference, a discount after the bill,
   * excess billing. Offered from the bill as "Raise direct debit note".
   *
   * Only the reasons where nothing physically moves are offered, the godown
   * box is not shown, and no rejected quantity is pre-filled. Goods that are
   * going back to the supplier go out on a return challan first — raised from
   * the same bill — and the challan writes its own note.
   */
  financialOnly?: boolean
}) {
  const isEdit = Boolean(record)
  const mayPost = can('purchase', 'post')

  const [reasons, setReasons] = useState<ReasonOption[]>([])
  const [suppliers, setSuppliers] = useState<Option[]>([])
  const [items, setItems] = useState<ItemOption[]>([])
  const [warehouses, setWarehouses] = useState<Option[]>([])
  const [bills, setBills] = useState<BillOption[]>([])
  const [grnOptions, setGrnOptions] = useState<GrnOption[]>([])
  const [grnPickerId, setGrnPickerId] = useState('')

  /* Three separate pieces of state, because they are three separate facts.
     One of them used to carry all three and could describe two of the eight
     combinations that occur. */
  const [docType, setDocType] = useState<NoteDoc>(moduleType)
  const [issuedBy, setIssuedBy] = useState<NoteIssuer>(DOC_WORDS[moduleType].issuedBy)
  const [reason, setReason] = useState<string>('')
  const [reasonNote, setReasonNote] = useState('')
  const [effect, setEffect] = useState<NoteEffect>(
    DOC_WORDS[moduleType].effect ?? 'REDUCES_PAYABLE'
  )

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
  const [grnContext, setGrnContext] = useState<GrnContext | null>(null)
  const [formLines, setFormLines] = useState<FormLine[]>([])

  /*
   * Carried on the note whichever way it was raised — off a bill (where they
   * are the bill's own order and receipts) or off a receipt directly (where
   * there is no bill to read them from). Kept as their own state rather than
   * derived at submit time, because the receipt-only path has nothing to
   * derive them from.
   */
  const [poId, setPoId] = useState<string | null>(null)
  const [grnId, setGrnId] = useState<string | null>(null)

  const [pulling, setPulling] = useState(false)
  const [pullingGrn, setPullingGrn] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const filesRef = useRef<AttachmentsBoxHandle>(null)
  const [fileCount, setFileCount] = useState(0)

  const rule = useMemo(() => reasons.find((r) => r.value === reason), [reasons, reason])
  /* Their number is what makes a document theirs, and it is what the
     department matches against at return time. Required for both of the
     supplier's kinds, optional on our own claim — they may not have sent
     anything at all. */
  const needsSupplierDoc = issuedBy === 'SUPPLIER'

  // ── Opening ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return
    setError(null)
    const opening = record?.docType ?? moduleType
    setDocType(opening)
    setIssuedBy(record?.issuedBy ?? DOC_WORDS[opening].issuedBy)
    setReason(record?.reason ?? '')
    setReasonNote(record?.reasonNote ?? '')
    setEffect(record?.effect ?? DOC_WORDS[opening].effect ?? 'REDUCES_PAYABLE')
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
    setGrnContext(null)
    setPoId(record?.po?.id ?? null)
    setGrnId(record?.grn?.id ?? null)
    // A note with a bill gets its lines from `loadBill` below, the moment
    // `billId` is set. One raised with no bill has nowhere else to read them
    // from — they are typed by hand or pulled from a receipt, and reopening
    // one to correct it has to start from what it already has.
    setFormLines(
      record && !record.bill
        ? record.lines.map((l) => ({
            billLineId: null,
            grnLineId: l.grnLineId ?? null,
            itemId: l.item.id,
            picked: true,
            qty: String(num(l.qty)),
            unitPrice: String(num(l.unitPrice)),
            gstRate: num(l.gstRate),
            remarks: l.remarks ?? '',
            meta: null,
            grnMeta: null,
          }))
        : []
    )
  }, [open, record, moduleType, initialBillId])

  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const [r, s, i, w] = await Promise.all([
          api.get<{ data: { reasons: ReasonOption[] } }>('/purchase/notes/reasons'),
          masterResource<Option>('suppliers').list({ limit: 500 }),
          masterResource<ItemOption>('items').list({ limit: 500, active: true }),
          masterResource<Option>('warehouses').list({ limit: 200 }),
        ])
        setReasons(r.data.reasons)
        setSuppliers([...s.data].sort((a, b) => a.name.localeCompare(b.name)))
        setItems(i.data)
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

  /* The receipts worth offering to pull rejected quantity off: this
     supplier's, and only the ones with something actually rejected on
     them — a receipt with nothing refused has nothing for this picker to
     read, the same way a fully-billed bill has nothing left for the other
     one. */
  useEffect(() => {
    if (!open || !noBill) return
    void (async () => {
      try {
        const qs = new URLSearchParams({ limit: '100' })
        if (supplierId) qs.set('supplierId', supplierId)
        const res = await api.get<{ data: GrnOption[] }>(`/purchase/grn?${qs}`)
        setGrnOptions(
          res.data.filter(
            (g) => g.status !== 'CANCELLED' && g.lines.some((l) => Number(l.rejectedQty) > 0)
          )
        )
      } catch {
        setGrnOptions([])
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
        setPoId(res.data.bill.po?.id ?? null)
        setGrnId(res.data.bill.receipts[0]?.id ?? null)

        const existing = new Map(
          (record?.lines ?? []).map((l) => [l.billLineId ?? `item:${l.item.id}`, l])
        )

        // Set once, from whichever suggested line is found first — the
        // godown the receipt itself named, so a note that moves goods
        // defaults to where they actually are instead of asking again.
        // `prev || ...` leaves a warehouse the person already picked alone.
        let firstSuggestedWarehouse: string | null = null

        setFormLines(
          res.data.lines.map((l) => {
            const was = existing.get(l.billLineId)
            /* Whatever brought somebody to this bill — the "raise a note for
               the rejected qty" shortcut, or just picking it from the list —
               a line still carrying an unclaimed rejection is suggested and
               pre-filled on sight. `adjustedQty` is what every other live,
               quantity-consuming note has already taken off this line, so a
               rejection a previous note already claimed in full is not
               suggested again — `remainingQty` alone would not catch that,
               since a line can still have plenty of billing headroom left
               after its one rejection has been fully claimed. A bill can
               carry more than one receipt's lines, so every line with
               something still unclaimed is suggested, not only one, and one
               note can close out the whole bill's rejections in one save. */
            const stillRejected = Math.max(0, l.rejectedQty - l.adjustedQty)
            const suggestRejected = !financialOnly && !record && !was && stillRejected > 0
            const suggestedQty = suggestRejected ? Math.min(stillRejected, l.remainingQty) : 0
            if (suggestedQty > 0 && l.warehouseId && !firstSuggestedWarehouse) {
              firstSuggestedWarehouse = l.warehouseId
            }
            return {
              billLineId: l.billLineId,
              grnLineId: null,
              itemId: l.itemId,
              picked: Boolean(was) || suggestedQty > 0,
              qty: was ? String(num(was.qty)) : suggestedQty > 0 ? String(suggestedQty) : '',
              unitPrice: was ? String(num(was.unitPrice)) : String(l.billedRate),
              gstRate: was ? num(was.gstRate) : l.gstRate,
              remarks: was?.remarks ?? '',
              meta: l,
              grnMeta: null,
            }
          })
        )
        if (firstSuggestedWarehouse) {
          const w = firstSuggestedWarehouse
          setWarehouseId((prev) => prev || w)
        }
      } catch (err) {
        setContext(null)
        setFormLines([])
        setError(err instanceof ApiError ? err.message : 'Could not read that bill.')
      } finally {
        setPulling(false)
      }
    },
    [record, financialOnly]
  )

  useEffect(() => {
    // Nothing here to do once there is no bill — a no-bill note's lines are
    // `pullFromGrn`'s and `addManualLine`'s to manage, not this effect's.
    // It used to clear them unconditionally whenever `billId` was empty,
    // which is also true the instant `pullFromGrn` sets `noBill` and clears
    // `billId` together — so the very lines it had just added were wiped by
    // this effect on the next render.
    if (!open || noBill) return
    if (!billId) {
      setContext(null)
      setFormLines([])
      return
    }
    void loadBill(billId)
  }, [open, billId, noBill, loadBill])

  /*
   * What a receipt still has left to note, added to the form — the
   * counterpart to `loadBill` for the document a note can be raised against
   * with no bill behind it. Adds rather than replaces and can be called more
   * than once, the same way pulling a second bill's receipt would.
   */
  const pullFromGrn = useCallback(
    async (id: string) => {
      setPullingGrn(true)
      setError(null)
      try {
        const qs = record?.id ? `?exclude=${record.id}` : ''
        const res = await api.get<{ data: GrnContext }>(`/purchase/notes/from-grn/${id}${qs}`)
        const d = res.data
        const openLines = d.lines.filter((l) => l.remainingQty > 0)

        if (!openLines.length) {
          setError(`Everything rejected on ${d.grn.grnNumber} has already been noted.`)
          return
        }

        setGrnContext(d)
        setNoBill(true)
        setBillId('')
        setContext(null)
        setSupplierId(d.po.supplier.id)
        setPoId(d.po.id)
        setGrnId(d.grn.id)
        setGrnPickerId(d.grn.id)
        setWithoutBillReason((prev) =>
          prev.trim() ? prev : `Rejected at goods receipt on ${d.grn.grnNumber} — never billed`
        )
        // The godown the receipt itself named — every GRN line has one — so
        // a note that moves goods defaults to where they actually are.
        // Left alone if the person already picked one of their own.
        const firstWarehouse = openLines[0]?.warehouseId
        if (firstWarehouse) setWarehouseId((prev) => prev || firstWarehouse)

        setFormLines((prev) => {
          const already = new Set(prev.map((l) => l.grnLineId).filter(Boolean))
          const fresh = openLines.filter((l) => !already.has(l.grnLineId))
          if (!fresh.length) return prev
          return [
            ...prev,
            ...fresh.map((l) => ({
              billLineId: null,
              grnLineId: l.grnLineId,
              itemId: l.itemId,
              picked: true,
              qty: String(l.remainingQty),
              unitPrice: String(l.rejectedRate),
              gstRate: l.gstRate,
              remarks: '',
              meta: null,
              grnMeta: l,
            })),
          ]
        })
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not read that receipt.')
      } finally {
        setPullingGrn(false)
      }
    },
    [record]
  )

  /** The note a return challan wrote, if this is one. */
  const fromChallan = record?.purchaseReturn ?? null
  /*
   * A note a challan wrote keeps its goods reason — that is what happened —
   * but moves nothing, so it is treated as money-only everywhere below.
   */
  const noGoods = financialOnly || Boolean(fromChallan)
  const reasonChoices = financialOnly ? reasons.filter((r) => !r.movesGoods) : reasons

  /* The reason SUGGESTS a document. It does not decide one.
     Applied only when the reason is changed by hand, so reopening a saved
     note never silently re-derives what was actually on it. */
  const pickReason = (value: string) => {
    setReason(value)
    const r = reasons.find((x) => x.value === value)
    if (r) {
      pickDoc(r.commonly)
      if (!r.movesGoods) setWarehouseId('')
    }
  }

  /* The document decides who issued it and which way the money goes — by
     definition, for every kind but OTHER. Those two follow rather than being
     offered, because a "supplier credit note" our company issued is not one,
     and an adjustment whose direction disagrees with its document is money
     moving the wrong way with a correct-looking form above it. */
  const pickDoc = (value: NoteDoc) => {
    setDocType(value)
    const d = DOC_WORDS[value]
    setIssuedBy(d.issuedBy)
    if (d.effect) setEffect(d.effect)
  }

  /*
   * Gathers the receipt the "Raise a note" shortcut arrived with, once and
   * once only — the same ref-guarded shape as the bill form's own
   * `initialGrnIds` effect, singular here because one receipt's rejections
   * are what one press of that button means. Placed after `pickReason` so it
   * can default the reason the same way a person filling the form by hand
   * would pick it first.
   *
   * A bill arriving alongside the receipt means the rejection now has a bill
   * line to be checked against — `loadBill` (already running off `billId`,
   * set from `initialBillId` on open) picks that line out and suggests its
   * quantity itself, so there is nothing here to pull off the receipt
   * directly. Only when no bill exists yet does this fall back to the
   * receipt-only, nothing-to-check-it-against path.
   */
  const autoPulledGrn = useRef<string | null>(null)
  useEffect(() => {
    if (!open || record || !initialGrnId) return
    if (autoPulledGrn.current === initialGrnId) return
    autoPulledGrn.current = initialGrnId
    if (!reason) pickReason('QUALITY_REJECTION')
    if (initialBillId) return
    void pullFromGrn(initialGrnId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, record, initialGrnId, initialBillId, pullFromGrn])

  useEffect(() => {
    if (!open) autoPulledGrn.current = null
  }, [open])

  const setLine = (index: number, patch: Partial<FormLine>) =>
    setFormLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  /** Every item, by id, for the no-bill line editor to default a rate and a GST from. */
  const itemById = useMemo(() => new Map(items.map((it) => [it.id, it])), [items])

  /** A blank row on a no-bill note, typed rather than pulled from anywhere. */
  const addManualLine = () =>
    setFormLines((prev) => [
      ...prev,
      {
        billLineId: null,
        grnLineId: null,
        itemId: '',
        picked: true,
        qty: '',
        unitPrice: '',
        gstRate: 0,
        remarks: '',
        meta: null,
        grnMeta: null,
      },
    ])

  const removeManualLine = (index: number) =>
    setFormLines((prev) => prev.filter((_, i) => i !== index))

  const pickManualItem = (index: number, itemId: string) => {
    const item = itemById.get(itemId)
    setLine(index, {
      itemId,
      unitPrice:
        formLines[index].unitPrice || (item?.standardRate != null ? String(item.standardRate) : ''),
      gstRate: formLines[index].gstRate || (item?.taxRate ? Number(item.taxRate.rate) : 0),
    })
  }

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
    if (!l.picked) return null
    const qty = num(l.qty)
    if (qty <= 0) return 'Enter how much is coming off'

    if (l.meta) {
      if (rule?.consumesQty && qty > l.meta.remainingQty + 0.0005) {
        return `Only ${qtyFmt(l.meta.remainingQty)}${l.meta.uom ? ` ${l.meta.uom}` : ''} left to adjust`
      }
      const value = round2(qty * num(l.unitPrice))
      if (value > l.meta.remainingValue + 0.005) {
        return `That comes to ₹${inr(value)}; only ₹${inr(l.meta.remainingValue)} of this line is still adjustable`
      }
      return null
    }

    // A receipt-picked line has the same ceiling as a bill-picked one, read
    // from the receipt instead — nothing on the server enforces it (there is
    // no bill line to check against), but the form still catches the
    // obvious mistake of pulling the same rejection twice.
    if (l.grnMeta && qty > l.grnMeta.remainingQty + 0.0005) {
      return `Only ${qtyFmt(l.grnMeta.remainingQty)}${l.grnMeta.uom ? ` ${l.grnMeta.uom}` : ''} left to note on this receipt`
    }
    return null
  }

  const problems = formLines.map(lineProblem)
  const firstProblem = problems.find(Boolean) ?? null

  // ── Saving ────────────────────────────────────────────────────────────────

  /** Every reason the form can refuse to save, read once by both buttons. */
  const validate = (): string | null => {
    if (!reason) return 'Start with what happened — pick a reason at the top.'
    if (reason === 'OTHER' && !reasonNote.trim()) {
      return 'Say what happened. "Something else" on its own tells the next reader nothing.'
    }
    if (!noBill && !billId) return 'Pick the supplier bill this adjusts.'
    if (noBill && !withoutBillReason.trim()) {
      return 'Say why this adjustment has no bill behind it.'
    }
    if (noBill && !supplierId) return 'Pick the supplier.'
    if (needsSupplierDoc && !supplierDocNo.trim()) {
      return "Enter the supplier's document number, as printed on their note."
    }
    if (!picked.length) return 'Tick at least one line and say how much is coming off it.'
    if (firstProblem) return firstProblem
    if (rule?.movesGoods && !warehouseId && !noBill) {
      return 'Name the godown the goods left. Posting the note takes that quantity out of its stock.'
    }
    return null
  }

  const buildPayload = () => ({
    reason,
    reasonNote: reasonNote.trim() || null,
    issuedBy,
    docType,
    effect,
    supplierId: context?.bill.supplier.id ?? supplierId,
    billId: noBill ? null : billId,
    withoutBillReason: noBill ? withoutBillReason.trim() : null,
    poId,
    grnId,
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
      grnLineId: l.grnLineId,
      description: l.meta?.description ?? null,
      hsnCode: l.meta?.hsnCode ?? l.grnMeta?.hsnCode ?? null,
      originalQty: l.meta?.billedQty ?? l.grnMeta?.rejectedQty ?? null,
      originalRate: l.meta?.billedRate ?? l.grnMeta?.rejectedRate ?? null,
      qty: num(l.qty),
      unitPrice: num(l.unitPrice),
      gstRate: l.gstRate,
      remarks: l.remarks.trim() || null,
    })),
  })

  /** Creates or updates the note, then sends whatever files were chosen
   *  before it existed. Shared by "Save as draft" and "Confirm & Post" —
   *  posting is a second step on top of exactly the same save. */
  const saveNote = async () => {
    const saved = isEdit
      ? await api.patch<{ data: PurchaseNote }>(`/purchase/notes/${record!.id}`, buildPayload())
      : await api.post<{ data: PurchaseNote }>('/purchase/notes', buildPayload())
    const failed = await filesRef.current?.uploadPending(saved.data.id)
    return { note: saved.data, failedFiles: failed?.failed ?? [] }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const problem = validate()
    if (problem) return setError(problem)

    setSaving(true)
    try {
      const { note, failedFiles } = await saveNote()
      if (failedFiles.length) {
        setError(`Saved, but these files did not go up: ${failedFiles.join(', ')}`)
      }
      onSaved()
      if (!failedFiles.length) onClose()
      return note
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save this note.'))
    } finally {
      setSaving(false)
    }
  }

  // ── Confirm, then post ──────────────────────────────────────────────────
  //
  // "Confirm & Post" does not post from the form itself — a figure typed a
  // moment ago and a figure about to change what the supplier is owed
  // deserve one more look between them, in the same shape the note will
  // actually be saved in rather than as scattered form fields. The save
  // itself happens once: `postedNoteRef` remembers what was created so a
  // retry after a failed post does not file the same note twice.
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const postedNoteRef = useRef<PurchaseNote | null>(null)

  const openConfirmPost = () => {
    setError(null)
    const problem = validate()
    if (problem) return setError(problem)
    postedNoteRef.current = null
    setPostError(null)
    setConfirmOpen(true)
  }

  const confirmAndPost = async () => {
    setPosting(true)
    setPostError(null)
    try {
      let note = postedNoteRef.current
      if (!note) {
        const { note: saved, failedFiles } = await saveNote()
        note = saved
        postedNoteRef.current = saved
        if (failedFiles.length) {
          setPostError(
            `${saved.noteNumber} was saved, but these files did not go up: ${failedFiles.join(', ')}. Posting anyway.`
          )
        }
      }
      await api.post(`/purchase/notes/${note.id}/post`, {})
      setConfirmOpen(false)
      onSaved()
      onClose()
    } catch (err) {
      setPostError(
        postedNoteRef.current
          ? apiErrorMessage(
              err,
              `${postedNoteRef.current.noteNumber} is saved as a draft, but posting failed.`
            )
          : apiErrorMessage(err, 'Could not save this note.')
      )
    } finally {
      setPosting(false)
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

  /* Minus where the bill comes down, plus where it goes up — keyed on what
     the money does, not on the word "debit", which appears on one document
     that reduces the bill and another that raises it. */
  const Icon = effect === 'INCREASES_PAYABLE' ? FilePlus2 : FileMinus
  const title = DOC_WORDS[docType].plain
  /* Its own number, so it can be tracked before it ever leaves this screen —
     given by the series when the note is saved, the same way a GRN or a bill
     gets theirs. Shown, not typed: nobody picks their own tracking number. */
  const docLabel = title.charAt(0).toUpperCase() + title.slice(1)

  const supplierName =
    context?.bill.supplier.name ?? suppliers.find((s) => s.id === supplierId)?.name ?? '—'

  return createPortal(
    <>
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
                  {fromChallan
                    ? `Raised from return challan ${fromChallan.returnNumber} — the goods have already left. Its items and quantities follow the challan; the rate and GST are yours to settle.`
                    : financialOnly
                      ? 'A rate or money difference only — nothing leaves the godown. Goods going back to the supplier go out on a return challan from the bill.'
                      : DOC_WORDS[docType].hint +
                        ' Saved as a draft; nothing moves until it is posted.'}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="submit"
                form="note-form"
                className={mayPost ? 'btn-secondary' : 'btn-primary'}
                disabled={saving}
              >
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
                <span className="hidden sm:inline">
                  {isEdit ? 'Save changes' : 'Save as draft'}
                </span>
              </button>
              {mayPost && (
                <button
                  type="button"
                  onClick={openConfirmPost}
                  className="btn-primary"
                  disabled={saving}
                >
                  <Landmark size={15} />
                  <span className="hidden sm:inline">Confirm &amp; Post</span>
                </button>
              )}
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

              {/* ── 1. What happened, and the bill it adjusts ────────────────── */}
              <Section
                icon={Link2}
                title="Original Purchase Reference"
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
                        } else {
                          setGrnContext(null)
                          setGrnPickerId('')
                          setPoId(null)
                          setGrnId(null)
                        }
                      }}
                    />
                    No bill to link
                  </label>
                }
              >
                {noBill ? (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <label className="form-label" htmlFor="reason-pick">
                          What happened
                        </label>
                        <SmartSelect
                          id="reason-pick"
                          className="form-input"
                          value={reason}
                          onChange={(e) => pickReason(e.target.value)}
                        >
                          <option value="">Pick one…</option>
                          {reasonChoices.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </SmartSelect>
                      </div>
                      <div>
                        <label className="form-label" htmlFor="note-number">
                          {docLabel}
                        </label>
                        <input
                          id="note-number"
                          className="form-input text-muted-foreground"
                          value={record?.noteNumber ?? 'Assigned when you save'}
                          disabled
                        />
                      </div>
                      <div>
                        <label className="form-label" htmlFor="no-bill-supplier">
                          Supplier
                        </label>
                        <SmartSelect
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
                        </SmartSelect>
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

                    {reason === 'OTHER' && (
                      <div>
                        <label className="form-label" htmlFor="reason-note">
                          What happened, in your own words
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

                    {/* The direction (money off the bill or onto it) follows
                    from the document, which follows from the reason above —
                    nothing left to ask, except the one kind nothing
                    defines. */}
                    {rule && DOC_WORDS[docType].effect === null && (
                      <div className="border-field-edge bg-field rounded-lg border p-2.5">
                        <label className="form-label" htmlFor="note-effect">
                          What does this do to what we owe?
                        </label>
                        <SmartSelect
                          id="note-effect"
                          className="form-input"
                          value={effect}
                          onChange={(e) => setEffect(e.target.value as NoteEffect)}
                        >
                          {(Object.keys(EFFECT_WORDS) as NoteEffect[]).map((k) => (
                            <option key={k} value={k}>
                              {EFFECT_WORDS[k].label}
                            </option>
                          ))}
                        </SmartSelect>
                        <p className="text-muted-foreground mt-1 text-[11px]">
                          Nothing defines the direction of an &ldquo;other&rdquo; adjustment, so it
                          has to be said.
                        </p>
                      </div>
                    )}

                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5">
                      <AlertCircle size={14} className="warn-text mt-0.5 shrink-0" />
                      <p className="warn-text text-[11px] leading-snug">
                        Nothing checks this one. With a bill behind it the form will not let you
                        claim back more than was charged; without one there is nothing to check it
                        against, so the figures below are taken on trust.
                      </p>
                    </div>

                    {/* Goods rejected at the gate are never billed, so there is
                    no bill line below to pick them from — this reads what a
                    receipt still has left to note instead, the same way the
                    bill picker reads a bill. Optional: a note with no bill
                    can just as well be typed by hand with "Add line" below. */}
                    <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                      <div>
                        <label className="form-label" htmlFor="grn-pick">
                          Pull rejected quantity off a receipt{' '}
                          <span className="text-muted-foreground font-normal">(optional)</span>
                        </label>
                        <SmartSelect
                          id="grn-pick"
                          className="form-input"
                          value={grnPickerId}
                          onChange={(e) => setGrnPickerId(e.target.value)}
                        >
                          <option value="">Pick a receipt…</option>
                          {grnOptions.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.grnNumber}
                              {g.po?.supplier ? ` · ${g.po.supplier.name}` : ''}
                            </option>
                          ))}
                        </SmartSelect>
                      </div>
                      <button
                        type="button"
                        className="btn-secondary h-9"
                        disabled={!grnPickerId || pullingGrn}
                        onClick={() => grnPickerId && void pullFromGrn(grnPickerId)}
                      >
                        {pullingGrn ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Link2 size={14} />
                        )}
                        Pull
                      </button>
                    </div>

                    {grnContext && (
                      <div className="border-field-edge bg-field grid gap-x-4 gap-y-2 rounded-lg border p-3 sm:grid-cols-2">
                        <Fact label="Against order" value={grnContext.po.poNumber} />
                        <Fact label="Receipt" value={grnContext.grn.grnNumber} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <label className="form-label" htmlFor="reason-pick-bill">
                          What happened
                        </label>
                        <SmartSelect
                          id="reason-pick-bill"
                          className="form-input"
                          value={reason}
                          onChange={(e) => pickReason(e.target.value)}
                        >
                          <option value="">Pick one…</option>
                          {reasonChoices.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </SmartSelect>
                      </div>
                      <div>
                        <label className="form-label" htmlFor="note-number-bill">
                          {docLabel}
                        </label>
                        <input
                          id="note-number-bill"
                          className="form-input text-muted-foreground"
                          value={record?.noteNumber ?? 'Assigned when you save'}
                          disabled
                        />
                      </div>
                      <div>
                        <label className="form-label" htmlFor="bill-supplier">
                          Supplier <span className="text-muted-foreground">(narrows the list)</span>
                        </label>
                        <SmartSelect
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
                        </SmartSelect>
                      </div>
                      <div>
                        <label className="form-label" htmlFor="bill-pick">
                          Supplier bill
                        </label>
                        <SmartSelect
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
                        </SmartSelect>
                      </div>
                    </div>

                    {reason === 'OTHER' && (
                      <div>
                        <label className="form-label" htmlFor="reason-note-bill">
                          What happened, in your own words
                        </label>
                        <input
                          id="reason-note-bill"
                          className="form-input"
                          value={reasonNote}
                          onChange={(e) => setReasonNote(e.target.value)}
                          placeholder="50 metres rejected for printing defects; supplier agreed the adjustment"
                          maxLength={500}
                        />
                      </div>
                    )}

                    {rule && DOC_WORDS[docType].effect === null && (
                      <div className="border-field-edge bg-field rounded-lg border p-2.5">
                        <label className="form-label" htmlFor="note-effect-bill">
                          What does this do to what we owe?
                        </label>
                        <SmartSelect
                          id="note-effect-bill"
                          className="form-input"
                          value={effect}
                          onChange={(e) => setEffect(e.target.value as NoteEffect)}
                        >
                          {(Object.keys(EFFECT_WORDS) as NoteEffect[]).map((k) => (
                            <option key={k} value={k}>
                              {EFFECT_WORDS[k].label}
                            </option>
                          ))}
                        </SmartSelect>
                        <p className="text-muted-foreground mt-1 text-[11px]">
                          Nothing defines the direction of an &ldquo;other&rdquo; adjustment, so it
                          has to be said.
                        </p>
                      </div>
                    )}

                    {pulling && (
                      <p className="text-muted-foreground flex items-center gap-2 text-xs">
                        <Loader2 size={13} className="animate-spin" /> Reading the bill…
                      </p>
                    )}

                    {/* What the chosen bill is, so nobody has to open it in
                    another tab to be sure they picked the right one. */}
                    {context && (
                      <div className="border-field-edge bg-field grid gap-x-4 gap-y-2 rounded-lg border p-3 sm:grid-cols-3 xl:grid-cols-6">
                        <Fact
                          label="Their invoice"
                          value={context.bill.supplierInvoiceNo ?? '—'}
                          sub={
                            context.bill.supplierInvoiceDate
                              ? new Date(context.bill.supplierInvoiceDate).toLocaleDateString(
                                  'en-GB'
                                )
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
                title="Item Details"
                actions={
                  noBill ? (
                    <button type="button" onClick={addManualLine} className="btn-secondary text-xs">
                      <Plus size={14} /> Add line
                    </button>
                  ) : picked.length > 0 ? (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {picked.length} of {formLines.length} lines
                    </span>
                  ) : undefined
                }
              >
                {noBill ? (
                  formLines.length === 0 ? (
                    <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                      <Info size={12} className="mt-0.5 shrink-0 opacity-70" />
                      Pull a receipt above, or press "Add line" to type an item by hand.
                    </p>
                  ) : (
                    <>
                      {/* ── Wide: a table. Narrow: one card per line ──────────
                      A line pulled off a receipt keeps its item fixed — it is
                      what makes "left to note" mean anything — and a hand-typed
                      one picks freely, so the two rows differ only in that one
                      cell. */}
                      <div className="border-border hidden overflow-x-auto rounded-lg border sm:block">
                        <table className="w-full min-w-[52rem] text-sm">
                          <thead>
                            <tr className="border-border bg-secondary border-b text-left">
                              <th className="text-muted-foreground px-2 py-2 text-xs font-medium">
                                Item
                              </th>
                              <th className="text-muted-foreground px-2 py-2 text-right text-xs font-medium">
                                Qty
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
                              <th className="w-8 px-2 py-2"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {formLines.map((l, i) => {
                              const g = l.grnMeta
                              const problem = problems[i]
                              const value = round2(num(l.qty) * num(l.unitPrice))
                              const item = itemById.get(l.itemId)
                              return (
                                <tr key={i} className="border-border/60 border-b last:border-0">
                                  <td className="px-2 py-2 align-top">
                                    {g ? (
                                      <>
                                        <p className="text-foreground text-[13px] font-medium">
                                          {g.itemCode} — {g.itemName}
                                        </p>
                                        <p className="text-muted-foreground text-[11px]">
                                          {grnContext?.grn.grnNumber} ·{' '}
                                          <span
                                            className={
                                              g.remainingQty <= 0
                                                ? 'text-red-400'
                                                : 'text-emerald-400'
                                            }
                                          >
                                            {qtyFmt(g.remainingQty)}
                                            {g.uom ? ` ${g.uom}` : ''} left to note
                                          </span>
                                        </p>
                                      </>
                                    ) : (
                                      <SmartSelect
                                        className="form-input h-8 py-0 text-[13px]"
                                        value={l.itemId}
                                        onChange={(e) => pickManualItem(i, e.target.value)}
                                        aria-label={`Line ${i + 1} item`}
                                      >
                                        <option value="">Select…</option>
                                        {items.map((it) => (
                                          <option key={it.id} value={it.id}>
                                            {it.code ? `${it.code} — ${it.name}` : it.name}
                                          </option>
                                        ))}
                                      </SmartSelect>
                                    )}
                                    {problem && (
                                      <p className="mt-1 text-[11px] text-red-400">{problem}</p>
                                    )}
                                    <input
                                      className="form-input mt-1.5 h-7 py-0 text-xs"
                                      value={l.remarks}
                                      onChange={(e) => setLine(i, { remarks: e.target.value })}
                                      placeholder="Remark for this line (optional)"
                                      maxLength={500}
                                    />
                                  </td>
                                  <td className="px-2 py-2 align-top">
                                    <input
                                      type="number"
                                      step="0.001"
                                      min="0"
                                      className="form-input h-8 w-24 py-0 text-right text-[13px]"
                                      value={l.qty}
                                      onChange={(e) => setLine(i, { qty: e.target.value })}
                                      aria-label={`Quantity for line ${i + 1}`}
                                    />
                                    {item?.uom?.symbol && (
                                      <p className="text-muted-foreground mt-0.5 text-right text-[10px]">
                                        {item.uom.symbol}
                                      </p>
                                    )}
                                  </td>
                                  <td className="px-2 py-2 align-top">
                                    <input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      className="form-input h-8 w-24 py-0 text-right text-[13px]"
                                      value={l.unitPrice}
                                      onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                                      aria-label={`Rate for line ${i + 1}`}
                                    />
                                    {g && (
                                      <p className="text-muted-foreground mt-0.5 text-right text-[10px]">
                                        off receipt ₹{inr(g.rejectedRate)}
                                      </p>
                                    )}
                                  </td>
                                  <td className="px-2 py-2 align-top">
                                    <input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      max="100"
                                      className="form-input h-8 w-20 py-0 text-right text-[13px]"
                                      value={l.gstRate}
                                      onChange={(e) =>
                                        setLine(i, { gstRate: Number(e.target.value) || 0 })
                                      }
                                      aria-label={`GST rate for line ${i + 1}`}
                                    />
                                  </td>
                                  <td className="text-foreground px-2 py-2 text-right align-top text-[13px] font-medium tabular-nums">
                                    ₹{inr(value)}
                                  </td>
                                  <td className="px-2 py-2 align-top">
                                    <button
                                      type="button"
                                      onClick={() => removeManualLine(i)}
                                      className="btn-ghost text-muted-foreground p-1 hover:text-red-400"
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

                      <div className="space-y-2 sm:hidden">
                        {formLines.map((l, i) => {
                          const g = l.grnMeta
                          const problem = problems[i]
                          return (
                            <div
                              key={i}
                              className="border-border bg-primary/[0.05] rounded-lg border p-2.5"
                            >
                              <div className="flex items-start justify-between gap-2">
                                {g ? (
                                  <div className="min-w-0 flex-1">
                                    <p className="text-foreground text-[13px] font-medium">
                                      {g.itemCode} — {g.itemName}
                                    </p>
                                    <p className="text-muted-foreground text-[11px]">
                                      {grnContext?.grn.grnNumber} ·{' '}
                                      <span
                                        className={
                                          g.remainingQty <= 0 ? 'text-red-400' : 'text-emerald-400'
                                        }
                                      >
                                        {qtyFmt(g.remainingQty)}
                                        {g.uom ? ` ${g.uom}` : ''} left
                                      </span>
                                    </p>
                                  </div>
                                ) : (
                                  <SmartSelect
                                    className="form-input h-8 min-w-0 flex-1 py-0 text-[13px]"
                                    value={l.itemId}
                                    onChange={(e) => pickManualItem(i, e.target.value)}
                                    aria-label={`Line ${i + 1} item`}
                                  >
                                    <option value="">Select…</option>
                                    {items.map((it) => (
                                      <option key={it.id} value={it.id}>
                                        {it.code ? `${it.code} — ${it.name}` : it.name}
                                      </option>
                                    ))}
                                  </SmartSelect>
                                )}
                                <button
                                  type="button"
                                  onClick={() => removeManualLine(i)}
                                  className="btn-ghost text-muted-foreground shrink-0 p-1 hover:text-red-400"
                                  aria-label={`Remove line ${i + 1}`}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
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
                                <div>
                                  <label className="form-label text-[11px]">GST %</label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    max="100"
                                    className="form-input h-8 py-0 text-[13px]"
                                    value={l.gstRate}
                                    onChange={(e) =>
                                      setLine(i, { gstRate: Number(e.target.value) || 0 })
                                    }
                                  />
                                </div>
                                <div>
                                  <label className="form-label text-[11px]">Remark</label>
                                  <input
                                    className="form-input h-8 py-0 text-[13px]"
                                    value={l.remarks}
                                    onChange={(e) => setLine(i, { remarks: e.target.value })}
                                    maxLength={500}
                                  />
                                </div>
                                {problem && (
                                  <p className="col-span-2 text-[11px] text-red-400">{problem}</p>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )
                ) : !context ? (
                  <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                    <Info size={12} className="mt-0.5 shrink-0 opacity-70" />
                    Pick the bill above and its lines will appear here.
                  </p>
                ) : formLines.length === 0 ? (
                  <p className="text-muted-foreground text-xs">That bill has no lines on it.</p>
                ) : (
                  <>
                    <p className="text-muted-foreground mb-2 text-[11px] leading-snug">
                      Anything rejected at the gate is ticked and filled in already — check the
                      quantity. <strong>Left</strong> is what is still adjustable after every other
                      note standing against this bill; yours cannot go past it.
                    </p>

                    {/* ── Wide: a table. Narrow: one card per line ────────────
                    A quantity box squashed to two characters is one somebody
                    mis-keys, and this form's whole job is getting a quantity
                    right. The same split the bill and receipt forms use. */}
                    <div className="border-border hidden overflow-x-auto rounded-lg border sm:block">
                      <table className="w-full min-w-[54rem] text-sm">
                        <thead>
                          <tr className="border-border bg-secondary border-b text-left">
                            <th className="w-8 px-2 py-1.5"></th>
                            <th className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                              Item
                            </th>
                            <th className="text-muted-foreground px-2 py-1.5 text-right text-xs font-medium">
                              Received / Rejected
                            </th>
                            <th className="text-muted-foreground px-2 py-1.5 text-right text-xs font-medium">
                              Left
                            </th>
                            <th className="text-muted-foreground px-2 py-1.5 text-right text-xs font-medium">
                              Adjust qty
                            </th>
                            <th className="text-muted-foreground px-2 py-1.5 text-right text-xs font-medium">
                              Rate
                            </th>
                            <th className="text-muted-foreground px-2 py-1.5 text-right text-xs font-medium">
                              GST
                            </th>
                            <th className="text-muted-foreground px-2 py-1.5 text-right text-xs font-medium">
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
                                <td className="px-2 py-1.5 align-top">
                                  <input
                                    type="checkbox"
                                    className="accent-primary mt-1"
                                    checked={l.picked}
                                    onChange={(e) => setLine(i, { picked: e.target.checked })}
                                    aria-label={`Adjust ${m.itemName}`}
                                  />
                                </td>
                                <td className="px-2 py-1.5 align-top">
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
                                      className="form-input mt-1 h-7 py-0 text-xs"
                                      value={l.remarks}
                                      onChange={(e) => setLine(i, { remarks: e.target.value })}
                                      placeholder="Remark for this line (optional)"
                                      maxLength={500}
                                    />
                                  )}
                                </td>
                                <td className="px-2 py-1.5 text-right align-top text-[13px] tabular-nums">
                                  {m.grnId ? (
                                    <>
                                      <span className="text-muted-foreground">
                                        {qtyFmt(m.receivedQty)}
                                        {m.uom ? ` ${m.uom}` : ''} recd
                                      </span>
                                      <span className="text-muted-foreground block text-[11px]">
                                        {qtyFmt(m.acceptedQty)} accepted
                                        {m.rejectedQty > 0 && (
                                          <span className="font-medium text-red-400">
                                            {' '}
                                            · {qtyFmt(m.rejectedQty)} rejected
                                          </span>
                                        )}
                                      </span>
                                    </>
                                  ) : (
                                    <>
                                      <span className="text-muted-foreground">
                                        {qtyFmt(m.billedQty)}
                                        {m.uom ? ` ${m.uom}` : ''} billed
                                      </span>
                                      <span className="text-muted-foreground block text-[11px] opacity-70">
                                        @ ₹{inr(m.billedRate)}
                                      </span>
                                    </>
                                  )}
                                </td>
                                <td className="px-2 py-1.5 text-right align-top text-[13px] tabular-nums">
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
                                <td className="px-2 py-1.5 align-top">
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
                                <td className="px-2 py-1.5 align-top">
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
                                <td className="text-muted-foreground px-2 py-1.5 text-right align-top text-[13px] tabular-nums">
                                  {l.gstRate}%
                                </td>
                                <td className="text-foreground px-2 py-1.5 text-right align-top text-[13px] font-medium tabular-nums">
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
                                  {m.grnId ? (
                                    <>
                                      {qtyFmt(m.receivedQty)}
                                      {m.uom ? ` ${m.uom}` : ''} recd · {qtyFmt(m.acceptedQty)}{' '}
                                      accepted
                                      {m.rejectedQty > 0 && (
                                        <span className="font-medium text-red-400">
                                          {' '}
                                          · {qtyFmt(m.rejectedQty)} rejected
                                        </span>
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      {qtyFmt(m.billedQty)}
                                      {m.uom ? ` ${m.uom}` : ''} billed @ ₹{inr(m.billedRate)}
                                    </>
                                  )}{' '}
                                  ·{' '}
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

              {/* ── 4. Details &amp; totals ─────────────────────────────────────
              One panel, not four — transport, dates, attachments and the
              tax breakdown were each their own bordered card with a fold
              arrow, which read as four decisions to make rather than a
              handful of fields to fill in. They are still exactly the same
              fields, just run together with a rule between each group
              instead of a card each. */}
              <Section icon={Calculator} title="Details &amp; Totals">
                <div className="grid items-start gap-4 lg:grid-cols-[1fr_320px]">
                  {/* Everything about the note itself — where the goods went,
                  when it happened, what the supplier's own paperwork says,
                  and what's attached — in one column so the money sits apart
                  from it in its own summary rather than at the foot of the
                  same list. */}
                  <div className="border-border rounded-lg border">
                    <div className="p-3.5">
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
                        {!noGoods && (
                          <div>
                            <label className="form-label" htmlFor="note-warehouse">
                              Godown they left
                            </label>
                            <SmartSelect
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
                            </SmartSelect>
                          </div>
                        )}
                        <div>
                          <label className="form-label" htmlFor="sup-doc-no">
                            Supplier&rsquo;s document number
                            {needsSupplierDoc && <span className="text-red-400"> *</span>}
                          </label>
                          <input
                            id="sup-doc-no"
                            className="form-input"
                            value={supplierDocNo}
                            onChange={(e) => setSupplierDocNo(e.target.value)}
                            placeholder={
                              needsSupplierDoc ? 'As printed on their note' : 'If they sent one'
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

                      {/* Its own row, not squeezed beside the short fields
                      above — a textarea and a drop-zone next to single-line
                      inputs stretched the whole row to their height and left
                      the short boxes sitting on dead space. */}
                      <div className="mt-3 grid gap-3 sm:grid-cols-3">
                        <div className="sm:col-span-2">
                          <label className="form-label" htmlFor="note-notes">
                            Notes
                          </label>
                          <textarea
                            id="note-notes"
                            className="form-input min-h-[38px]"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Anything the next reader needs — what was agreed, and with whom"
                            maxLength={2000}
                          />
                        </div>
                        <div>
                          <span className="form-label">
                            Attachments
                            {fileCount > 0 && (
                              <span className="text-muted-foreground font-normal">
                                {' '}
                                · {fileCount} file{fileCount === 1 ? '' : 's'}
                              </span>
                            )}
                          </span>
                          <AttachmentsBox
                            ref={filesRef}
                            basePath="/purchase/notes"
                            linkBasePath="/purchase/notes/attachments"
                            recordId={record?.id}
                            onError={setError}
                            onCountChange={setFileCount}
                          />
                        </div>
                      </div>
                      {rule?.movesGoods && (
                        <p className="text-muted-foreground mt-2 flex items-start gap-1.5 text-[11px]">
                          <Info size={12} className="mt-0.5 shrink-0 opacity-70" />
                          Naming a godown is what takes the quantity out of its stock when the note
                          is posted. Leave it blank only if the material never physically moved.
                        </p>
                      )}
                    </div>
                  </div>

                  {/* The money, apart from the paperwork — what is typed, what
                  it comes to, and what that means for the bill, read
                  top-to-bottom in one card rather than split across the
                  fields that drive it. */}
                  <div className="border-border bg-secondary/40 h-fit space-y-3 rounded-lg border p-3.5">
                    <h4 className="text-foreground text-sm font-semibold">Bill Summary</h4>

                    <div className="grid grid-cols-2 gap-3">
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

                    <div className="border-border/70 space-y-1 border-t pt-3">
                      <Row label="Taxable value" value={totals.taxable} />
                      {totals.intra ? (
                        <>
                          <Row label="CGST" value={totals.cgst} />
                          <Row label="SGST" value={totals.sgst} />
                        </>
                      ) : (
                        <Row label="IGST" value={totals.igst} />
                      )}
                      <Row label="Round off" value={totals.roundOff} />
                    </div>

                    <div className="border-border/70 border-t pt-3">
                      <div className="flex items-center justify-between">
                        <span className="text-foreground text-sm font-semibold">
                          {effect === 'REDUCES_PAYABLE'
                            ? 'Coming off the bill'
                            : 'Added to the bill'}
                        </span>
                        <span className="text-primary text-lg font-semibold tabular-nums">
                          ₹{inr(totals.total)}
                        </span>
                      </div>
                      <p className="text-muted-foreground mt-1 text-[11px]">
                        Pre-GST amount: ₹{inr(totals.taxable)} + taxes: ₹
                        {inr(totals.intra ? totals.cgst + totals.sgst : totals.igst)} = ₹
                        {inr(totals.total)}
                      </p>
                      {context && effect === 'REDUCES_PAYABLE' && (
                        <p className="text-muted-foreground mt-1 text-[11px]">
                          {context.bill.billNumber} owes ₹{inr(num(context.bill.balanceAmount))}{' '}
                          today. Posting this would leave{' '}
                          <span className="text-foreground font-medium">
                            ₹{inr(Math.max(0, num(context.bill.balanceAmount) - totals.total))}
                          </span>
                          .
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </Section>
            </div>

            <div className="border-border flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2.5">
              <p className="text-muted-foreground hidden text-[11px] sm:block">
                {mayPost
                  ? "Save as draft leaves what the supplier is owed untouched. Confirm & Post changes it, once you've checked the figures."
                  : 'Saving makes a draft. It is posted separately once someone with the right to post has looked at it.'}
              </p>
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={onClose} className="btn-ghost">
                  Cancel
                </button>
                <button
                  type="submit"
                  className={mayPost ? 'btn-secondary' : 'btn-primary'}
                  disabled={saving}
                >
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
                  {isEdit ? 'Save changes' : 'Save as draft'}
                </button>
                {mayPost && (
                  <button
                    type="button"
                    onClick={openConfirmPost}
                    className="btn-primary"
                    disabled={saving}
                  >
                    <Landmark size={15} />
                    Confirm &amp; Post
                  </button>
                )}
              </div>
            </div>
          </form>
        </div>
      </div>

      {/* One more look, in the shape the note will actually be saved in,
      before a figure typed a moment ago changes what the supplier is
      owed. Cancelling here changes nothing — it only closes this panel
      and returns to the form. */}
      {confirmOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm">
          <div
            className="glass-card flex w-full max-w-xl flex-col overflow-hidden rounded-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-post-title"
          >
            <div className="border-border flex shrink-0 items-center gap-2.5 border-b px-4 py-3">
              <div className="bg-primary/10 border-primary/20 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
                <Landmark size={16} className="text-primary" />
              </div>
              <div className="min-w-0">
                <h3 id="confirm-post-title" className="text-foreground text-base font-semibold">
                  Post this {title}?
                </h3>
                <p className="text-muted-foreground text-xs">
                  {record?.noteNumber ?? `${docLabel} · assigned when this saves`}
                </p>
              </div>
            </div>

            <div className="max-h-[75vh] space-y-4 overflow-y-auto px-4 py-3.5">
              {postError && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 p-2.5">
                  <AlertCircle size={14} className="mt-0.5 shrink-0 text-red-400" />
                  <p className="text-xs text-red-400">{postError}</p>
                </div>
              )}

              <div className="border-field-edge bg-field grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-lg border p-3 sm:grid-cols-3">
                <Fact
                  label="What happened"
                  value={rule?.label ?? '—'}
                  sub={reason === 'OTHER' ? reasonNote || undefined : undefined}
                />
                <Fact label="Supplier" value={supplierName} />
                <Fact
                  label="Against"
                  value={noBill ? 'No bill' : (context?.bill.billNumber ?? '—')}
                  sub={noBill ? withoutBillReason || undefined : undefined}
                />
                {(context?.bill.po ?? grnContext?.po) && (
                  <Fact
                    label="Purchase order"
                    value={context?.bill.po?.poNumber ?? grnContext?.po.poNumber ?? '—'}
                  />
                )}
                {(context?.bill.receipts.length || grnContext?.grn) && (
                  <Fact
                    label="Receipt (GRN)"
                    value={
                      context?.bill.receipts.length
                        ? context.bill.receipts.map((r) => r.grnNumber).join(', ')
                        : (grnContext?.grn.grnNumber ?? '—')
                    }
                  />
                )}
                <Fact
                  label="Note date"
                  value={noteDate ? new Date(noteDate).toLocaleDateString('en-GB') : '—'}
                />
                {warehouseId && (
                  <Fact
                    label="Godown"
                    value={warehouses.find((w) => w.id === warehouseId)?.name ?? '—'}
                  />
                )}
                {supplierDocNo && (
                  <Fact
                    label="Their document"
                    value={supplierDocNo}
                    sub={
                      supplierDocDate
                        ? new Date(supplierDocDate).toLocaleDateString('en-GB')
                        : undefined
                    }
                  />
                )}
                {lrNumber && <Fact label="LR / RR number" value={lrNumber} />}
                {vehicleNo && <Fact label="Vehicle number" value={vehicleNo} />}
                {otherRef && <Fact label="Other reference" value={otherRef} />}
              </div>

              <div className="border-border overflow-hidden rounded-lg border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-border bg-secondary border-b text-left">
                      <th className="text-muted-foreground px-2.5 py-1.5 font-medium">Item</th>
                      <th className="text-muted-foreground px-2.5 py-1.5 text-right font-medium">
                        Qty
                      </th>
                      <th className="text-muted-foreground px-2.5 py-1.5 text-right font-medium">
                        Rate
                      </th>
                      <th className="text-muted-foreground px-2.5 py-1.5 text-right font-medium">
                        Value
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {picked.map((l, i) => (
                      <tr key={i} className="border-border/60 border-b last:border-0">
                        <td className="text-foreground px-2.5 py-1.5">
                          {l.meta?.itemName ?? l.grnMeta?.itemName ?? itemById.get(l.itemId)?.name}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          {qtyFmt(num(l.qty))}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          ₹{inr(num(l.unitPrice))}
                        </td>
                        <td className="text-foreground px-2.5 py-1.5 text-right font-medium tabular-nums">
                          ₹{inr(round2(num(l.qty) * num(l.unitPrice)))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="border-border bg-secondary/40 space-y-1 rounded-lg border p-3">
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
                <Row label="Round off" value={totals.roundOff} />
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

              {notes.trim() && (
                <div className="border-border rounded-lg border p-2.5">
                  <p className="text-muted-foreground text-[11px]">Notes</p>
                  <p className="text-foreground mt-0.5 whitespace-pre-wrap text-xs leading-snug">
                    {notes}
                  </p>
                </div>
              )}

              <p className="text-muted-foreground flex items-start gap-1.5 text-[11px]">
                <Info size={12} className="mt-0.5 shrink-0 opacity-70" />
                Posting changes what {supplierName} is owed
                {warehouseId
                  ? ` and takes the quantity out of ${warehouses.find((w) => w.id === warehouseId)?.name ?? 'stock'}`
                  : ''}
                . Check the figures above before you go ahead.
              </p>
            </div>

            <div className="border-border flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="btn-secondary"
                disabled={posting}
              >
                Go back and edit
              </button>
              <button
                type="button"
                onClick={() => void confirmAndPost()}
                className="btn-primary"
                disabled={posting}
              >
                {posting ? <Loader2 size={15} className="animate-spin" /> : <Landmark size={15} />}
                {postedNoteRef.current ? 'Retry post' : 'Confirm & Post'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
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
      <span className="text-foreground tabular-nums">
        {value < 0 ? '−' : ''}₹{inr(Math.abs(value))}
      </span>
    </div>
  )
}
