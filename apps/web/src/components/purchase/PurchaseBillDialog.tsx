'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  X,
  Loader2,
  AlertCircle,
  Plus,
  Trash2,
  Download,
  TriangleAlert,
  Receipt,
  Info,
  FileText,
  Package,
  Calculator,
} from 'lucide-react'
import { api, apiErrorMessage, ApiError, masterResource, type Paginated } from '@/lib/api'
// The same panel the order and receipt forms are built from, so all three
// read as one module rather than three people's ideas of a form.
import { Section } from '@/components/purchase/PurchaseOrderDialog'
import type { NoteDoc, NoteGst, NoteIssuer } from '@/components/purchase/noteTypes'
import type { NewItem } from '@/components/purchase/NewItemDialog'
import { ExpenseHeadDialog } from '@/components/purchase/ExpenseHeadDialog'

export interface BillLine {
  itemId: string
  grnLineId?: string | null
  description?: string | null
  qty: number | string
  unitPrice: number | string
  discount: number | string
  gstRate: number | string
  /** Only set when the line came from a receipt — drives the variance notes. */
  acceptedQty?: number
  pendingQty?: number
  /**
   * How much of this line's quantity was refused at the gate, carried so the
   * form can say so while it is being billed — the bill still claims the
   * whole delivery, tax invoice and all, but the rejected part of it is a
   * debit note still to be raised, not goods that reached the rack.
   */
  rejectedQty?: number
  orderedRate?: number
  /**
   * What to do about a rate that does not match the order. Only ever set on a
   * line where the two actually differ; the API refuses the bill until every
   * such line carries one.
   */
  rateAction?: 'ACCEPT' | 'DEBIT_NOTE' | null
  grnNumber?: string
}

export interface BillCharge {
  chargeTypeId: string
  amount: number | string
  gstRate: number | string
}

/** A file hanging off an order or a receipt. The bill itself holds none. */
export interface BillAttachment {
  id: string
  fileName: string
  mimeType: string | null
  sizeBytes: number
  createdAt: string
}

export interface PurchaseBill {
  id: string
  billNumber: string
  supplierId: string
  poId: string | null
  supplierInvoiceNo: string | null
  supplierInvoiceDate: string | null
  billDate: string
  dueDate: string | null
  subtotal: string | number
  discountAmount: string | number
  taxableAmount: string | number
  cgst: string | number
  sgst: string | number
  igst: string | number
  tdsSection: string | null
  tdsRate: string | number | null
  tdsAmount: string | number
  isReverseCharge: boolean
  roundOff: string | number
  totalAmount: string | number
  paidAmount: string | number
  balanceAmount: string | number
  status: string
  notes: string | null
  supplier?: {
    id: string
    name: string
    code: string
    gstin: string | null
    stateCode: string | null
    isMsme?: boolean
    creditDays?: number
  }
  po?: { id: string; poNumber: string; attachments?: BillAttachment[] } | null
  createdBy?: { id: string; name: string } | null
  createdAt?: string
  lines?: Array<
    BillLine & {
      id: string
      item?: {
        id: string
        code: string
        name: string
        hsnCode: string | null
        uom?: { symbol: string } | null
      }
      hsnCode?: string | null
      taxableValue?: string | number
      cgst?: string | number
      sgst?: string | number
      igst?: string | number
      amount?: string | number
      grnLine?: {
        id: string
        receivedQty: string
        acceptedQty: string
        rejectedQty: string
        /** Already claimed by a note raised straight off the receipt, before this bill existed. */
        rejectedNotedQty?: number
        unitRate?: string | number
        grn: { id: string; grnNumber: string; attachments?: BillAttachment[] }
      } | null
    }
  >
  charges?: Array<
    BillCharge & {
      id: string
      chargeType?: { id: string; name: string } | null
      cgst?: string | number
      sgst?: string | number
      igst?: string | number
    }
  >
  payments?: Array<{
    id: string
    paymentNumber: string
    paymentDate: string
    amount: string | number
    mode: string
    referenceNo: string | null
    chequeDate: string | null
    createdBy?: { id: string; name: string } | null
  }>
  /**
   * The debit and credit notes standing against this bill.
   *
   * Cancelled and rejected ones are left out by the API — they claim nothing,
   * and a bill listing four notes of which two are void reads as though the
   * supplier is being chased twice.
   */
  adjustments?: Array<{
    id: string
    noteNumber: string
    docType: NoteDoc
    issuedBy: NoteIssuer
    gstTreatment: NoteGst
    noteDate: string
    reason: string
    reasonNote: string | null
    effect: 'REDUCES_PAYABLE' | 'INCREASES_PAYABLE'
    supplierDocNo: string | null
    taxableAmount: string | number
    totalAmount: string | number
    status: string
  }>
  /** What POSTED notes have already taken off — positive reduces the payable. */
  noteAdjustment?: string | number
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
  defaultGstRate?: string | number | null
  applyOnPurchase?: boolean
  /** Payment to an MSME supplier falls due within 45 days by law. */
  isMsme?: boolean
  /** The terms agreed with this supplier — what the due date is counted in. */
  creditDays?: number | null
  /** An item's category, nested as the master sends it — what marks an expense head. */
  category?: { id: string; name: string; parentId: string | null } | null
}

interface Category {
  id: string
  name: string
  parentId: string | null
}

/** The item-list choice that opens "new expense head" instead of picking one. */
const ADD_EXPENSE_HEAD = '__new_expense__'

/**
 * Whether a category is where expense heads live: named for expenses, or
 * filed under one that is. Read off the name so the mill sets it up in
 * Masters like any other category — no switch to find, nothing to migrate.
 */
const EXPENSE_NAME = /expense/i

interface GrnOption {
  id: string
  grnNumber: string
  status: string
  /**
   * Shaped exactly as `/purchase/grn` returns it — the supplier arrives
   * nested inside the order, not flattened onto it.
   *
   * This was written as `supplierId` once, which is not a field the API has
   * ever sent. Nothing failed loudly: the filter below read `undefined`,
   * compared it against the chosen supplier, and quietly offered no receipts
   * at all, so a bill could never be started from one.
   */
  po?: {
    id: string
    poNumber: string
    supplier?: { id: string; name: string; code?: string } | null
  } | null
  /** When the lorry arrived. */
  grnDate?: string | null
  /*
   * The supplier's own delivery challan — the number printed on the note that
   * travelled with the goods.
   *
   * This is what the accounts clerk has in front of them. The supplier's
   * invoice quotes his challan numbers, never our receipt numbers, so a
   * picker that offers only GRN numbers is asking them to translate between
   * two documents in their head — which is how the wrong delivery gets
   * billed.
   */
  challanNo?: string | null
  challanDate?: string | null
  /**
   * The supplier's invoice number as the gate wrote it down.
   *
   * Caught on the receipt long before accounts book anything, which is what
   * makes it worth filtering on: the clerk is holding that invoice, and this
   * is the mill's own record of having seen it arrive.
   */
  supplierInvoiceNo?: string | null
  /** What is still unbilled on this receipt. Sent by `/purchase/grn`. */
  billing?: {
    acceptedQty: number | string
    billedQty: number | string
    pendingQty: number | string
    /** The unbilled part priced at the rate it came in at. An estimate. */
    pendingValue?: number | string
    status?: string
  } | null
}

const emptyLine = (): BillLine => ({
  itemId: '',
  grnLineId: null,
  qty: '',
  unitPrice: '',
  discount: '0',
  gstRate: '',
})

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const inr = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * The longest a bill to a registered small supplier may be left unpaid.
 *
 * Section 15 of the MSMED Act. Forty-five days is a ceiling, not a term —
 * shorter can be agreed and usually has been, longer cannot be — so it is
 * used as the fallback when the master carries no terms, and as a cap over
 * whatever it does carry.
 */
const MSME_DAYS = 45

/**
 * A date this many days later, in the `yyyy-mm-dd` a date input wants.
 *
 * Built out of the local parts rather than `toISOString`, which converts to
 * UTC first: east of Greenwich that hands back the day before, so a bill dated
 * the 28th would fall due on the 11th rather than the 12th.
 */
const addDays = (iso: string, days: number) => {
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return ''
  d.setDate(d.getDate() + days)
  const two = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate())
}

export function PurchaseBillDialog({
  open,
  onClose,
  onSaved,
  record,
  initialGrnIds,
  expense,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  record?: PurchaseBill | null
  /**
   * Receipts to gather onto the bill the moment the form opens, for the
   * "Add bill" and "Bill together" shortcuts on the goods receipt screen.
   *
   * A list rather than one, because a supplier routinely sends one invoice
   * for a week of deliveries — which is exactly what the receipts screen
   * lets somebody tick off and send here.
   *
   * The old ERP put an "Add Bill From GRN" button beside every receipt, which
   * is how the accounts team thinks about it — the receipt is on the desk and
   * the bill is raised against it. Reaching the same place by opening Bills,
   * pressing Book Bill, picking the supplier and then finding the receipt is
   * four steps to arrive where the button already was.
   */
  initialGrnIds?: string[] | null
  /**
   * A bill with no order and no receipt behind it — electricity, rent, a
   * repair, a service. The deliveries section goes, the lines are picked from
   * expense heads rather than stock items, and each line carries its own
   * description, because "Electricity" alone does not say which month.
   */
  expense?: boolean
}) {
  const isEdit = Boolean(record)
  // An existing bill with no receipt on any line was booked as an expense,
  // and opens that way again for editing.
  const expenseMode =
    Boolean(expense) ||
    Boolean(isEdit && record?.lines?.length && record.lines.every((l) => !l.grnLineId))

  const [suppliers, setSuppliers] = useState<Option[]>([])
  const [items, setItems] = useState<Option[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  /** The line a new expense head is being created for, if any. */
  const [newHeadFor, setNewHeadFor] = useState<number | null>(null)
  const [chargeTypes, setChargeTypes] = useState<Option[]>([])
  const [grns, setGrns] = useState<GrnOption[]>([])
  const [companyState, setCompanyState] = useState<string | null>(null)

  const [supplierId, setSupplierId] = useState('')
  const [poId, setPoId] = useState<string | null>(null)
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState('')
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState('')
  const [billDate, setBillDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [dueDate, setDueDate] = useState('')
  const [discountAmount, setDiscountAmount] = useState('')
  const [isReverseCharge, setIsReverseCharge] = useState(false)
  /*
   * TDS and the notes box have no controls on the form any more.
   *
   * The state stays, and so does the round trip: a bill already carrying a
   * section, a rate or a note is opened with them, sends them back unchanged
   * and keeps them. Dropping the state would have made editing any older bill
   * silently strip its TDS — a tax figure quietly deleted by opening a form
   * and pressing save is about the worst thing a form can do.
   */
  const [tdsSection, setTdsSection] = useState('')
  const [tdsRate, setTdsRate] = useState('')
  const [notes, setNotes] = useState('')
  /** Why a rate above the order was agreed. Asked for once, not per line. */
  const [rateVarianceReason, setRateVarianceReason] = useState('')
  const [lines, setLines] = useState<BillLine[]>([emptyLine()])
  const [charges, setCharges] = useState<BillCharge[]>([])

  /*
   * The three boxes over the delivery list, and the only state they keep.
   *
   * They narrow what the list shows; they are not part of the bill and none
   * of them is sent anywhere. Kept as plain values rather than derived,
   * because "no filter" and "filtered to the only option there is" have to
   * stay tellable apart — deriving them would silently re-pick a filter the
   * clerk had just cleared.
   */
  const [filterPo, setFilterPo] = useState('')
  const [filterChallan, setFilterChallan] = useState('')
  const [filterBill, setFilterBill] = useState('')
  const [filterGrn, setFilterGrn] = useState('')
  /*
   * Whether the list is open with no filter on it.
   *
   * The table starts folded: a bill is raised against a delivery somebody is
   * holding the paperwork for, so the question is always "which one is this",
   * never "what is there". One press opens it anyway, because a clerk who has
   * lost the challan number still has to be able to look.
   */
  const [showAllReceipts, setShowAllReceipts] = useState(false)

  const [loadingReceipts, setLoadingReceipts] = useState(false)
  /** How many receipts the server holds for this supplier, page or no page. */
  const [receiptTotal, setReceiptTotal] = useState(0)

  const [pulling, setPulling] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSupplierId(record?.supplierId ?? '')
    setPoId(record?.poId ?? null)
    setSupplierInvoiceNo(record?.supplierInvoiceNo ?? '')
    setSupplierInvoiceDate(record?.supplierInvoiceDate?.slice(0, 10) ?? '')
    setBillDate((record?.billDate ?? new Date().toISOString()).slice(0, 10))
    setDueDate(record?.dueDate?.slice(0, 10) ?? '')
    // An existing bill's date is somebody's decision, already taken.
    dueTyped.current = Boolean(record?.dueDate)
    setDiscountAmount(num(record?.discountAmount) > 0 ? String(record?.discountAmount) : '')
    setIsReverseCharge(record?.isReverseCharge ?? false)
    setTdsSection(record?.tdsSection ?? '')
    setTdsRate(num(record?.tdsRate) > 0 ? String(record?.tdsRate) : '')
    setNotes(record?.notes ?? '')
    setRateVarianceReason('')
    setFilterPo('')
    setFilterChallan('')
    setFilterBill('')
    setFilterGrn('')
    setShowAllReceipts(false)
    setLines(
      record?.lines?.length
        ? record.lines.map((l) => ({
            itemId: l.itemId,
            grnLineId: l.grnLineId ?? null,
            description: l.description ?? '',
            qty: String(l.qty),
            unitPrice: String(l.unitPrice),
            discount: String(l.discount ?? 0),
            gstRate: String(l.gstRate ?? ''),
            acceptedQty: l.grnLine ? num(l.grnLine.acceptedQty) : undefined,
            grnNumber: l.grnLine?.grn?.grnNumber,
          }))
        : [freshLine()]
    )
    setCharges(
      record?.charges?.map((c) => ({
        chargeTypeId: c.chargeTypeId,
        amount: String(c.amount),
        gstRate: String(c.gstRate ?? ''),
      })) ?? []
    )
    setError(null)
  }, [open, record])

  /*
   * Gathers the receipt the shortcut arrived with, once and once only.
   *
   * Waits for the receipt list to load, because the picker below is driven by
   * it and a bill that filled itself in while the box beside it still read
   * "choose a receipt" would look broken. The ref stops a re-render pulling
   * the same receipt twice, which the form would rightly refuse as a
   * duplicate.
   */
  /*
   * What is on the bill, readable without waiting for a render.
   *
   * Gathering several receipts in one go calls the puller in a loop, and
   * every call in that loop closes over the same render's `lines` and
   * `supplierId`. The second receipt would therefore be checked against a
   * bill it could not see the first one on — no duplicate caught, no
   * supplier compared. These carry the running truth instead.
   */
  const linesRef = useRef(lines)
  const supplierIdRef = useRef(supplierId)
  useEffect(() => {
    linesRef.current = lines
  }, [lines])
  useEffect(() => {
    supplierIdRef.current = supplierId
  }, [supplierId])

  /**
   * Whether the due date on screen is one somebody typed.
   *
   * The date fills itself in from the supplier's terms, and re-fills whenever
   * the supplier or their bill date changes — but the moment a clerk types one
   * of their own, that is the answer and nothing may overwrite it. An extension
   * agreed on the phone is exactly the kind of thing that gets typed here and
   * would have been silently reverted by the next keystroke in the date beside
   * it.
   */
  const dueTyped = useRef(false)

  const autoPulled = useRef<string | null>(null)
  useEffect(() => {
    if (!open || record || !initialGrnIds?.length) return
    // Keyed on the ids themselves, so a parent handing over a freshly built
    // array on every render does not gather the same receipts again.
    const key = initialGrnIds.join(',')
    if (autoPulled.current === key) return
    if (!grns.length) return

    autoPulled.current = key
    // One after another rather than all at once: each receipt has to be
    // checked against the bill the one before it built.
    void (async () => {
      for (const id of initialGrnIds) await pullFromGrn(id)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, record, initialGrnIds, grns])

  useEffect(() => {
    if (!open) autoPulled.current = null
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void Promise.all([
      masterResource<Option>('suppliers').list({ limit: 500, active: true }),
      masterResource<Option>('items').list({ limit: 500, active: true }),
      masterResource<Option>('charge-types')
        .list({ limit: 100, active: true })
        .catch(() => null),
      api
        .get<{ success: boolean; data: { stateCode: string | null } }>('/settings/company')
        .catch(() => null),
    ]).then(([s, i, c, co]) => {
      if (cancelled) return
      setSuppliers((s as Paginated<Option>).data)
      setItems((i as Paginated<Option>).data)
      // The charge master may have no screen yet; a bill without freight is
      // still a bill, so this degrades rather than breaking the form.
      setChargeTypes(
        c ? (c as Paginated<Option>).data.filter((x) => x.applyOnPurchase !== false) : []
      )
      setCompanyState(co?.data?.stateCode ?? null)
    })

    return () => {
      cancelled = true
    }
  }, [open])

  // Categories, for telling expense heads from stock items. Only an expense
  // bill needs them.
  useEffect(() => {
    if (!open || !expenseMode) return
    let cancelled = false
    masterResource<Category>('item-categories')
      .list({ limit: 500, active: true })
      .then((r) => {
        if (!cancelled) setCategories(r.data)
      })
      .catch(() => {
        // Without them every item is simply listed together.
      })
    return () => {
      cancelled = true
    }
  }, [open, expenseMode])

  const expenseCategoryIds = useMemo(() => {
    const named = new Set(categories.filter((c) => EXPENSE_NAME.test(c.name)).map((c) => c.id))
    for (const c of categories) if (c.parentId && named.has(c.parentId)) named.add(c.id)
    return named
  }, [categories])
  /** The top-level "Expenses" category, where a new head is filed by default. */
  const expenseCategory =
    categories.find((c) => !c.parentId && EXPENSE_NAME.test(c.name)) ??
    categories.find((c) => EXPENSE_NAME.test(c.name))
  /** The top of the expense tree, and the groups filed under it. */
  const expenseTop = expenseCategory?.parentId
    ? (categories.find((c) => c.id === expenseCategory.parentId) ?? expenseCategory)
    : (expenseCategory ?? null)
  const expenseGroups = expenseTop ? categories.filter((c) => c.parentId === expenseTop.id) : []
  const isExpenseHead = (it?: Option | null) =>
    Boolean(
      it?.category &&
      (expenseCategoryIds.has(it.category.id) ||
        (it.category.parentId != null && expenseCategoryIds.has(it.category.parentId)))
    )
  const expenseHeads = useMemo(
    () => items.filter((it) => isExpenseHead(it)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, expenseCategoryIds]
  )

  /**
   * The choices in a line's item picker. On an expense bill the expense heads
   * come first, with a way to add one; every other item is still listed below
   * them, so a bill can be booked before the heads have been set up.
   */
  const itemChoices = () =>
    expenseMode ? (
      <>
        <option value="">Select...</option>
        {expenseHeads.length > 0 && (
          <optgroup label="Expense heads">
            {expenseHeads.map((it) => (
              <option key={it.id} value={it.id}>
                {it.code ? `${it.code} — ${it.name}` : it.name}
              </option>
            ))}
          </optgroup>
        )}
        <option value={ADD_EXPENSE_HEAD}>+ Add a new expense head…</option>
        <optgroup label="Other items">
          {items
            .filter((it) => !isExpenseHead(it))
            .map((it) => (
              <option key={it.id} value={it.id}>
                {it.code ? `${it.code} — ${it.name}` : it.name}
              </option>
            ))}
        </optgroup>
      </>
    ) : (
      <>
        <option value="">Select...</option>
        {items.map((it) => (
          <option key={it.id} value={it.id}>
            {it.code ? `${it.code} — ${it.name}` : it.name}
          </option>
        ))}
      </>
    )

  /** A fresh line: one of whatever it is, on an expense bill — a month's electricity is one. */
  const freshLine = (): BillLine => (expenseMode ? { ...emptyLine(), qty: '1' } : emptyLine())

  /**
   * The deliveries waiting to be billed, asked for again whenever the
   * supplier changes.
   *
   * It used to be one call on open, for the hundred most recent receipts in
   * the mill, filtered down to this supplier's on the screen. That is fine
   * while the mill has seven and quietly wrong once it has thousands: the
   * supplier's oldest unbilled delivery — which is precisely the one nobody
   * has got round to and the one he is chasing — falls off the end of the
   * page and the picker shows no sign that anything is missing. Asking the
   * server for his receipts bounds the list by the only thing that matters.
   *
   * `total` is kept so the strip below can say when even that was more than
   * one page. A picker that silently shows a subset is worse than one that
   * admits it.
   */
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingReceipts(true)
    api
      .get<Paginated<GrnOption>>(
        `/purchase/grn?limit=100${supplierId ? `&supplierId=${supplierId}` : ''}`
      )
      .then((r) => {
        if (cancelled) return
        setGrns(r.data ?? [])
        setReceiptTotal(r.pagination?.total ?? r.data?.length ?? 0)
      })
      .catch(() => {
        // Left as it was rather than emptied. A failed refresh should not
        // take the rows somebody has already ticked off the screen.
        if (!cancelled) setReceiptTotal(0)
      })
      .finally(() => {
        if (!cancelled) setLoadingReceipts(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, supplierId])

  /*
   * A filter cannot outlive the list it was picked from.
   *
   * Ticking a receipt settles the supplier, which fetches that supplier's
   * receipts, which can leave all three boxes pointing at numbers no longer
   * on the list. A `<select>` whose value matches none of its options renders
   * blank — so the box would read as cleared while still filtering the table
   * down to nothing, and the clerk would be looking at an empty list with no
   * filter on screen to explain it.
   */
  useEffect(() => {
    if (filterPo && !grns.some((g) => g.po?.id === filterPo)) setFilterPo('')
    if (filterChallan && !grns.some((g) => (g.challanNo ?? '') === filterChallan)) {
      setFilterChallan('')
    }
    if (filterBill && !grns.some((g) => (g.supplierInvoiceNo ?? '') === filterBill)) {
      setFilterBill('')
    }
    if (filterGrn && !grns.some((g) => g.id === filterGrn)) setFilterGrn('')
  }, [grns, filterPo, filterChallan, filterBill, filterGrn])

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
  const chargeById = useMemo(() => new Map(chargeTypes.map((c) => [c.id, c])), [chargeTypes])
  const supplier = suppliers.find((s) => s.id === supplierId)

  /**
   * How long this supplier gives us, in days.
   *
   * Their own agreed terms where the master holds them — every supplier on the
   * mill's list has them, and they run from 15 to 45 — and ${MSME_DAYS} where
   * it does not. Capped at ${MSME_DAYS} for a registered small supplier
   * whatever the master says, because that is the law's ceiling and a longer
   * term agreed with them is not enforceable anyway.
   *
   * Filling the legal maximum for everybody would have been the simpler rule
   * and the wrong one: Ambika Stitching Unit is on 15 days, and a bill quietly
   * dated 45 would be a month late by the time anybody looked — with interest
   * running on it, since they are an MSME.
   */
  const termDays = useMemo(() => {
    const agreed = Number(supplier?.creditDays ?? 0)
    const base = agreed > 0 ? agreed : MSME_DAYS
    return supplier?.isMsme ? Math.min(base, MSME_DAYS) : base
  }, [supplier])

  /*
   * Counted from the date on their bill, which is what the terms in the master
   * say ("30 days from bill date") and what the supplier will count from when
   * he rings about it. Until that box is filled in, from the day we are
   * booking it — a due date that is roughly right beats an empty box, and it
   * corrects itself the moment their date is typed.
   */
  const dueFrom = supplierInvoiceDate || billDate

  useEffect(() => {
    if (!open || dueTyped.current) return
    // The terms come off the supplier, so there is nothing to work out until
    // there is one. A date guessed before then would visibly correct itself
    // the moment one is picked, which reads as the form changing its mind.
    if (!supplierId || !dueFrom) return
    setDueDate(addDays(dueFrom, termDays))
  }, [open, supplierId, dueFrom, termDays])

  /**
   * The receipts already gathered onto this bill, in order, without repeats.
   *
   * Drives the wording around the picker: the box has to say whether pressing
   * it starts the bill or adds to it, and somebody halfway through gathering a
   * week of deliveries needs to see which ones are already on.
   */
  const billedReceipts = useMemo(
    () => [...new Set(lines.map((l) => l.grnNumber).filter(Boolean))] as string[],
    [lines]
  )

  const billedSet = useMemo(() => new Set(billedReceipts), [billedReceipts])

  /**
   * Every delivery this bill could be for — the ones already on it first,
   * then the rest still waiting.
   *
   * A dropdown picked one at a time hid the thing that matters most here: a
   * supplier's single invoice routinely covers a week of deliveries. Nobody
   * was told that, so everybody assumed one bill meant one delivery and rang
   * to ask. A list you tick says it without a word.
   */
  const receiptChoices = useMemo(() => {
    const mine = grns.filter(
      (g) =>
        g.status !== 'CANCELLED' &&
        (billedSet.has(g.grnNumber) ||
          ((!supplierId || g.po?.supplier?.id === supplierId) &&
            // Nothing left to bill is nothing to offer — ticking it only ever
            // produced "already billed".
            (g.billing == null || Number(g.billing.pendingQty) > 0)))
    )
    return [...mine].sort(
      (a, b) =>
        Number(billedSet.has(b.grnNumber)) - Number(billedSet.has(a.grnNumber)) ||
        a.grnNumber.localeCompare(b.grnNumber)
    )
  }, [grns, supplierId, billedSet])

  /*
   * ── The three filters over the delivery list ─────────────────────────────
   *
   * The clerk holds the supplier's invoice. It quotes his challan numbers and
   * our order numbers; it never quotes our receipt numbers, because those are
   * ours and he has never seen them. So the list has to be reachable from any
   * of the three, and each box narrows the other two rather than standing on
   * its own — picking a challan with no idea which order it was against is
   * exactly the position the clerk is in.
   *
   * Each box's options are built from the receipts the *other* two boxes
   * allow, which is what keeps a filter from offering a choice that would
   * empty the list.
   */
  const matchesPo = (g: GrnOption) => !filterPo || g.po?.id === filterPo
  const matchesChallan = (g: GrnOption) => !filterChallan || (g.challanNo ?? '') === filterChallan
  const matchesBill = (g: GrnOption) => !filterBill || (g.supplierInvoiceNo ?? '') === filterBill
  const matchesGrn = (g: GrnOption) => !filterGrn || g.id === filterGrn

  const poChoices = useMemo(() => {
    const seen = new Map<string, string>()
    for (const g of receiptChoices) {
      if (!g.po || !matchesChallan(g) || !matchesBill(g) || !matchesGrn(g)) continue
      seen.set(g.po.id, g.po.poNumber)
    }
    return [...seen]
      .map(([id, poNumber]) => ({ id, poNumber }))
      .sort((a, b) => a.poNumber.localeCompare(b.poNumber))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptChoices, filterChallan, filterBill, filterGrn])

  const challanChoices = useMemo(() => {
    const seen = new Set<string>()
    for (const g of receiptChoices) {
      // A receipt with no challan recorded has nothing to offer this box. It
      // is still in the table below, wearing a dash, so it can be reached.
      if (!g.challanNo || !matchesPo(g) || !matchesBill(g) || !matchesGrn(g)) continue
      seen.add(g.challanNo)
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptChoices, filterPo, filterBill, filterGrn])

  /** The supplier invoice numbers the gate caught, narrowed like the rest. */
  const billChoices = useMemo(() => {
    const seen = new Set<string>()
    for (const g of receiptChoices) {
      if (!g.supplierInvoiceNo || !matchesPo(g) || !matchesChallan(g) || !matchesGrn(g)) continue
      seen.add(g.supplierInvoiceNo)
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptChoices, filterPo, filterChallan, filterGrn])

  const grnChoices = useMemo(
    () => receiptChoices.filter((g) => matchesPo(g) && matchesChallan(g) && matchesBill(g)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [receiptChoices, filterPo, filterChallan, filterBill]
  )

  /** The rows the table actually shows — everything all four boxes allow. */
  const visibleReceipts = useMemo(
    () =>
      receiptChoices.filter(
        (g) => matchesPo(g) && matchesChallan(g) && matchesBill(g) && matchesGrn(g)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [receiptChoices, filterPo, filterChallan, filterBill, filterGrn]
  )

  /*
   * Whether there is anything to show the table for.
   *
   * A filter, an explicit "show all", or receipts already gathered onto the
   * bill — that last one matters most: clearing a filter after ticking
   * something must not take what is on the bill off the screen.
   */
  const anyReceiptFilter = Boolean(
    supplierId || filterPo || filterChallan || filterBill || filterGrn
  )
  const receiptsOpen = anyReceiptFilter || showAllReceipts || billedReceipts.length > 0

  /**
   * Gathers several receipts one after the other, never at once.
   *
   * `pullFromGrn` reads and rewrites the same `linesRef`, so two of them in
   * flight together would each build their new line list from the same stale
   * one and the second would overwrite the first. The loop is the point.
   */
  const pullMany = async (rows: GrnOption[]) => {
    for (const g of rows) {
      // Read fresh each turn, from the ref rather than the render's own
      // `billedSet` — the receipt pulled a moment ago is on the bill but not
      // yet in this render, and asking for it twice is refused as a
      // duplicate with a message the clerk did nothing to deserve.
      const on = new Set(linesRef.current.map((l) => l.grnNumber).filter(Boolean))
      if (on.has(g.grnNumber)) continue
      await pullFromGrn(g.id)
    }
  }

  /**
   * Picking a challan.
   *
   * The challan is the one number on the supplier's invoice that names a
   * delivery, so choosing one is as close to "this is the delivery I am
   * billing" as the clerk can get — and the receipts under it are ticked for
   * them rather than left as a second step they can forget. The order narrows
   * with it when the challan only ever came against one, which is the normal
   * case.
   */
  const chooseChallan = (no: string) => {
    setFilterChallan(no)
    setFilterGrn('')
    if (!no) return
    const under = receiptChoices.filter((g) => (g.challanNo ?? '') === no)
    const orders = new Set(under.map((g) => g.po?.id).filter(Boolean) as string[])
    if (orders.size === 1) setFilterPo([...orders][0])
    void pullMany(under)
  }

  /**
   * Picking the supplier's own invoice number.
   *
   * The same move as the challan, from the other number printed on the same
   * sheet. Whichever of the two the clerk reads first, they end up on the
   * same deliveries.
   */
  const chooseBill = (no: string) => {
    setFilterBill(no)
    setFilterGrn('')
    if (!no) return
    const under = receiptChoices.filter((g) => (g.supplierInvoiceNo ?? '') === no)
    const orders = new Set(under.map((g) => g.po?.id).filter(Boolean) as string[])
    if (orders.size === 1) setFilterPo([...orders][0])
    const challans = new Set(under.map((g) => g.challanNo).filter(Boolean) as string[])
    if (challans.size === 1) setFilterChallan([...challans][0])
    void pullMany(under)
  }

  /**
   * Picking a receipt number, for whoever is working from our side of the
   * paperwork. Its challan and its order fill themselves in behind it.
   */
  const chooseGrn = (id: string) => {
    setFilterGrn(id)
    if (!id) return
    const g = receiptChoices.find((r) => r.id === id)
    if (!g) return
    if (g.po?.id) setFilterPo(g.po.id)
    if (g.challanNo) setFilterChallan(g.challanNo)
    if (g.supplierInvoiceNo) setFilterBill(g.supplierInvoiceNo)
    void pullMany([g])
  }

  /**
   * Picking the supplier — the top of the cascade.
   *
   * It is the same field the bill itself carries, not a filter of its own: a
   * bill is one supplier's demand for money, so "whose deliveries am I
   * looking at" and "whose bill is this" are one question and have to stay one
   * piece of state. The box in Bill Details below sets it through here too.
   *
   * Refused outright while deliveries are on the bill. Changing it used to be
   * allowed and did nothing but change the name at the top: the lines stayed,
   * still tied to the other supplier's receipts, and the bill went off to
   * somebody who had never sent those goods. Nothing downstream would have
   * caught it — the receipt link is what the goods are matched on, and it
   * would still have been perfectly consistent with itself.
   */
  const chooseSupplier = (id: string) => {
    if (id === supplierId) return
    if (billedReceipts.length > 0) {
      setError(
        `${billedReceipts.join(', ')} ${
          billedReceipts.length === 1 ? 'is' : 'are'
        } on this bill and ${
          billedReceipts.length === 1 ? 'belongs' : 'belong'
        } to the supplier it is already for. Untick ${
          billedReceipts.length === 1 ? 'it' : 'them'
        } before changing who the bill is from.`
      )
      return
    }
    setError(null)
    setSupplierId(id)
    // Everything below it was picked out of the other supplier's paperwork.
    setFilterPo('')
    setFilterChallan('')
    setFilterBill('')
    setFilterGrn('')
    setShowAllReceipts(false)
  }

  /**
   * Picking an order only narrows. It does not tick anything: an order can
   * have a month of deliveries under it, and pulling all of them onto a bill
   * because somebody wanted to look at the list is not a filter, it is a
   * decision taken on their behalf.
   */
  const choosePo = (id: string) => {
    setFilterPo(id)
    // Whatever was chosen below it may not belong to this order any more.
    setFilterChallan((prev) =>
      prev && receiptChoices.some((g) => g.po?.id === id && (g.challanNo ?? '') === prev)
        ? prev
        : ''
    )
    setFilterBill((prev) =>
      prev && receiptChoices.some((g) => g.po?.id === id && (g.supplierInvoiceNo ?? '') === prev)
        ? prev
        : ''
    )
    setFilterGrn((prev) =>
      prev && receiptChoices.some((g) => g.id === prev && g.po?.id === id) ? prev : ''
    )
  }

  /**
   * Takes a delivery back off the bill, and the lines it brought with it.
   *
   * Untickable matters as much as tickable: somebody who ticks the wrong
   * delivery should not have to close the form and start again.
   */
  const dropReceipt = (grnNumber: string) => {
    setLines((prev) => {
      const kept = prev.filter((l) => l.grnNumber !== grnNumber)
      const next = kept.length ? kept : [emptyLine()]
      linesRef.current = next
      return next
    })
  }

  const taxMode = !supplier
    ? null
    : !supplier.gstin && !isReverseCharge
      ? 'NONE'
      : (supplier.stateCode ?? supplier.gstin?.slice(0, 2)) === companyState
        ? 'CGST_SGST'
        : 'IGST'

  /** Mirrors priceBill on the API, so the screen and the saved bill agree. */
  const totals = useMemo(() => {
    const lineGross = lines.map((l) => num(l.qty) * num(l.unitPrice) * (1 - num(l.discount) / 100))
    const subtotal = lineGross.reduce((s, n) => s + n, 0)
    const discount = Math.min(num(discountAmount), subtotal)
    const goodsTaxable = subtotal - discount
    const factor = subtotal > 0 ? goodsTaxable / subtotal : 1

    const chargeTotal = charges.reduce((s, c) => s + num(c.amount), 0)
    const taxable = goodsTaxable + chargeTotal

    const taxable0 = taxMode === 'NONE' ? 0 : 1
    const lineTax = lines.reduce(
      (s, l, i) => s + lineGross[i] * factor * (num(l.gstRate) / 100) * taxable0,
      0
    )
    const chargeTax = charges.reduce(
      (s, c) => s + num(c.amount) * (num(c.gstRate) / 100) * taxable0,
      0
    )
    const tax = lineTax + chargeTax

    // Under reverse charge the supplier bills no tax; we owe it to the
    // government, so it must not swell what they are paid.
    const payable = isReverseCharge ? taxable : taxable + tax
    const total = Math.round(payable)
    const tds = taxable * (num(tdsRate) / 100)

    return {
      lineGross,
      subtotal,
      discount,
      taxable,
      chargeTotal,
      tax,
      roundOff: total - payable,
      total,
      tds,
      balance: total - tds,
    }
  }, [lines, charges, discountAmount, taxMode, isReverseCharge, tdsRate])

  if (!open) return null

  const setLine = (index: number, patch: Partial<BillLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  /**
   * Clears a rate decision the moment the rate it was made about changes.
   *
   * Somebody who picks "book at the order's rate" and then retypes the rate
   * is answering a different question, and carrying the old answer forward
   * would raise a debit note for a difference nobody is looking at any more.
   */
  const setLineRate = (index: number, unitPrice: string) =>
    setLine(index, { unitPrice, rateAction: null })

  const pickItem = (index: number, itemId: string) => {
    if (itemId === ADD_EXPENSE_HEAD) {
      setNewHeadFor(index)
      return
    }
    const item = itemById.get(itemId)
    setLine(index, {
      itemId,
      // A manually added line is not matched to a receipt.
      grnLineId: null,
      acceptedQty: undefined,
      pendingQty: undefined,
      orderedRate: undefined,
      grnNumber: undefined,
      unitPrice:
        lines[index].unitPrice || (item?.standardRate != null ? String(item.standardRate) : ''),
      gstRate: lines[index].gstRate || (item?.taxRate ? String(item.taxRate.rate) : ''),
    })
  }

  /**
   * Adds a receipt's lines to the bill, so nobody retypes what they already
   * entered.
   *
   * Adds rather than replaces, and can be pressed again for another receipt.
   * Suppliers routinely bill a week of deliveries on one invoice, the mill's
   * old ERP let you tick several receipts and press Create Bill, and Mahesh
   * asked for that from day one — so a bill covers as many receipts as it
   * needs to. The three-way match already worked this way: it sums what has
   * been billed against each receipt line, from every bill, so nothing is
   * claimed twice however the lines were gathered.
   *
   * Two things are refused. A receipt from a different supplier, because a
   * bill is somebody's demand for money and it comes from one of them. And a
   * receipt already on this bill, which would double the quantity.
   */
  const pullFromGrn = async (grnId: string) => {
    if (!grnId) return
    setPulling(true)
    setError(null)
    try {
      const res = await api.get<{
        success: boolean
        data: {
          grn: { grnNumber: string }
          po: { id: string; poNumber: string; supplier: { id: string } }
          lines: Array<{
            grnLineId: string
            item: { id: string; name: string }
            receivedQty: number
            acceptedQty: number
            rejectedQty: number
            rejectedNotedQty: number
            billedQty: number
            pendingQty: number
            orderedRate: number
            gstRate: number
          }>
        }
      }>(`/purchase/bills/match/${grnId}`)

      const d = res.data
      const open = d.lines.filter((l) => l.pendingQty > 0)

      if (!open.length) {
        setError(
          `Everything on ${d.grn.grnNumber} has already been billed. Pick another receipt, or add the lines by hand.`
        )
        return
      }

      const existing = linesRef.current.filter((l) => l.grnLineId)

      if (existing.length && supplierIdRef.current && supplierIdRef.current !== d.po.supplier.id) {
        setError(
          `${d.grn.grnNumber} is from a different supplier. One bill is one supplier's demand for money — start a separate bill for it.`
        )
        return
      }

      const already = new Set(existing.map((l) => l.grnLineId))
      const fresh = open.filter((l) => !already.has(l.grnLineId))

      if (!fresh.length) {
        setError(`${d.grn.grnNumber} is already on this bill.`)
        return
      }

      supplierIdRef.current = d.po.supplier.id
      setSupplierId(d.po.supplier.id)

      /*
       * The order link only survives while the bill is about one order.
       *
       * Once receipts from two orders are on it the header cannot honestly
       * name one, and naming the first would make the bill look like it
       * settles an order it only half touches. The lines still carry their
       * receipt, and the receipt still carries its order, so nothing is lost
       * — it is only the shortcut at the top that goes.
       */
      setPoId((prev) => (!prev || prev === d.po.id ? d.po.id : ''))

      const pulled = fresh.map((l) => ({
        itemId: l.item.id,
        grnLineId: l.grnLineId,
        description: '',
        qty: String(l.pendingQty),
        unitPrice: String(l.orderedRate),
        discount: '0',
        gstRate: String(l.gstRate),
        acceptedQty: l.acceptedQty,
        // What is still unclaimed, not the raw reject figure — a rejection
        // already noted straight off the receipt (before this bill existed)
        // has nothing left for the hint below to ask for.
        rejectedQty: Math.max(0, Math.round((l.rejectedQty - l.rejectedNotedQty) * 1000) / 1000),
        pendingQty: l.pendingQty,
        orderedRate: l.orderedRate,
        grnNumber: d.grn.grnNumber,
      }))

      /*
       * Blank rows typed before the first pull are dropped, and only then.
       * A new bill opens with one empty line and keeping it would leave a row
       * with no item on a bill somebody is about to save.
       */
      setLines((prev) => {
        const keep = prev.filter((l) => l.grnLineId || l.itemId)
        const next = [...keep, ...pulled]
        linesRef.current = next
        return next
      })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that goods receipt.')
    } finally {
      setPulling(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    /*
     * Say what is still missing, and take the person to the first of it. The
     * notice sits at the top of a form that by this point is usually scrolled
     * a long way past it, so neither half is any use without the other.
     */
    if (missing.length) {
      const what = missing.map((m) => m.what)
      setError(
        what.length === 1
          ? `Still to fill in: ${what[0]}.`
          : `Still to fill in: ${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}.`
      )
      const id = missing.find((m) => m.focus)?.focus
      requestAnimationFrame(() => {
        const el = document.getElementById(id ?? 'bill-form-error')
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        if (id) el?.focus({ preventScroll: true })
      })
      return
    }

    setSaving(true)
    setError(null)

    const payload = {
      supplierId,
      poId: poId || null,
      supplierInvoiceNo: supplierInvoiceNo.trim(),
      supplierInvoiceDate,
      billDate,
      dueDate: dueDate || null,
      discountAmount: num(discountAmount),
      isReverseCharge,
      tdsSection: tdsSection.trim() || null,
      tdsRate: num(tdsRate) || null,
      notes: notes.trim() || null,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        grnLineId: l.grnLineId || null,
        description: (l.description as string)?.trim() || null,
        qty: num(l.qty),
        unitPrice: num(l.unitPrice),
        discount: num(l.discount),
        gstRate: num(l.gstRate),
        rateAction: l.rateAction ?? null,
      })),
      rateVarianceReason: rateVarianceReason.trim() || null,
      charges: charges
        .filter((c) => c.chargeTypeId && num(c.amount) > 0)
        .map((c) => ({
          chargeTypeId: c.chargeTypeId,
          amount: num(c.amount),
          gstRate: num(c.gstRate),
        })),
    }

    try {
      if (isEdit && record) {
        await api.patch(`/purchase/bills/${record.id}`, payload)
      } else {
        await api.post('/purchase/bills', payload)
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save. Is the API running?'))
    } finally {
      setSaving(false)
    }
  }

  // Over-billing is shown but not blocked here — the API refuses it, and its
  // message says exactly how much is left on which receipt. A rate mismatch
  // does block, because the answer is a choice only a person can make.
  const overBilled = lines.filter((l) => l.pendingQty != null && num(l.qty) > l.pendingQty)
  const rateDrift = lines.filter(
    (l) => l.orderedRate != null && Math.abs(num(l.unitPrice) - l.orderedRate) > 0.005
  )

  /** Every mismatch has to be answered — the API refuses the bill otherwise. */
  const undecidedRates = rateDrift.filter((l) => !l.rateAction)

  /**
   * A reason is owed only for agreeing to pay *more*. Accepting a rate below
   * the order costs the mill nothing and needs no explaining.
   */
  const needsRateReason = rateDrift.some(
    (l) => l.rateAction === 'ACCEPT' && num(l.unitPrice) - (l.orderedRate ?? 0) > 0.005
  )

  /**
   * What is still outstanding, named the way somebody would say it, in the
   * order it appears on the form. This used to be a single boolean whose only
   * job was to switch the button off, so a press answered with nothing at all
   * — and the grey prompts under the two bill fields sit several screens above
   * wherever a person is standing when they reach for Book bill.
   */
  const missing: Array<{ what: string; focus?: string }> = []
  if (!supplierId) missing.push({ what: 'the supplier', focus: 'bill-supplier' })
  // The supplier's invoice is on the desk when a bill is booked, so its
  // number and date are part of the document rather than optional extras.
  if (!supplierInvoiceNo.trim())
    missing.push({ what: 'their bill number', focus: 'bill-supplier-no' })
  if (!supplierInvoiceDate)
    missing.push({ what: 'the date on their bill', focus: 'bill-supplier-date' })
  if (lines.some((l) => !l.itemId)) missing.push({ what: 'an item on every line' })
  if (lines.some((l) => num(l.qty) <= 0)) missing.push({ what: 'a quantity on every line' })
  if (undecidedRates.length > 0) {
    const n = undecidedRates.length
    missing.push({
      what:
        n === 1
          ? 'what to do about the rate that does not match the order'
          : `what to do about the ${n} rates that do not match the order`,
    })
  }
  if (needsRateReason && !rateVarianceReason.trim())
    missing.push({ what: 'why the higher rate was agreed', focus: 'bill-rate-reason' })

  /*
   * Rendered on `document.body`, as the order and receipt dialogs already are.
   *
   * Left in the page it sat 32px from the top and 12px from the bottom, and no
   * amount of centring fixed it: an ancestor in the dashboard shell carries a
   * `backdrop-filter`, and that makes it the containing block for anything
   * `position: fixed` inside it. So `inset-0` was measuring from the top bar
   * rather than from the window, and the strip of page showing above the form
   * was the top bar's own height leaking through.
   */
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      {/* `h-full`, not a cap — see PurchaseOrderDialog for why: a cap only
        says how tall the card may not be, so a form shorter than the screen
        hugs its content and the leftover is split above and below as
        centring slack, which is the whitespace that used to show over the
        top of this one. Filling the height makes the margin the padding and
        nothing else. */}
      <div
        className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bill-dialog-title"
      >
        {newHeadFor !== null && (
          <ExpenseHeadDialog
            expenseCategory={expenseTop}
            groups={expenseGroups}
            onClose={() => setNewHeadFor(null)}
            onCreated={(created: NewItem, createdCategory) => {
              const index = newHeadFor
              setNewHeadFor(null)
              // The first head also made the "Expenses" category. Known here too,
              // so the new head is listed with the expense heads at once.
              if (createdCategory) setCategories((p) => [...p, createdCategory])
              // Into the list this form holds as well as the master, so the
              // line that asked for it can pick it straight away.
              const option: Option = {
                id: created.id,
                code: created.code,
                name: created.name,
                hsnCode: created.hsnCode,
                uom: created.uom,
                category: created.category,
                standardRate: created.standardRate ?? null,
              }
              setItems((p) => [...p, option])
              setLine(index, {
                itemId: created.id,
                grnLineId: null,
                unitPrice: created.standardRate
                  ? String(created.standardRate)
                  : (lines[index]?.unitPrice ?? ''),
              })
            }}
          />
        )}

        {/* Header — stays put while the body scrolls. */}
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="bg-primary/10 border-primary/20 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
              <Receipt size={16} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2
                id="bill-dialog-title"
                className="text-foreground truncate text-xl font-semibold tracking-tight"
              >
                {isEdit
                  ? `Edit ${record?.billNumber}`
                  : expenseMode
                    ? 'Book an Expense Bill'
                    : 'Book a Supplier Bill'}
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {isEdit
                  ? 'A bill can be changed until a payment is made against it'
                  : expenseMode
                    ? 'Electricity, rent, repairs, services — a bill with no order or receipt behind it.'
                    : 'Our reference number is given when you save. Type the supplier’s own number below.'}
              </p>
            </div>
          </div>
          {/* The primary action sits in the header as well as the footer, as
            it does on the goods receipt form — but desk only there too,
            wrapped in its own `hidden md:block`. Without a `min-w-0` chain
            above, the title never actually truncated despite carrying the
            class — a flex child's default min-width is its content's, not
            zero — and this button ran off the right edge of a phone
            instead of the header ever giving the title room to give up. */}
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden md:block">
              <button type="submit" form="bill-form" className="btn-primary" disabled={saving}>
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Receipt size={15} />}
                {isEdit ? 'Save changes' : 'Book bill'}
              </button>
            </div>
            <button onClick={onClose} className="btn-ghost p-1.5" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        <form id="bill-form" onSubmit={submit} className="flex flex-1 flex-col overflow-hidden">
          {/* The same rhythm as the goods receipt and purchase order forms:
            px-4 py-2.5 and a tight gap between blocks. This was px-6 py-5 with
            space-y-5, which on a form this tall reads as a different app —
            twice the air of every other dialog, and a band of nothing under
            the header before anything to fill in. */}
          <div className="flex-1 space-y-2.5 overflow-y-auto px-5 py-3">
            {error && (
              <div
                id="bill-form-error"
                className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3"
              >
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {!isEdit && !expenseMode && (
              <Section icon={Download} title="Deliveries Being Billed">
                {loadingReceipts && receiptChoices.length === 0 ? (
                  <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Loader2 size={12} className="animate-spin" />
                    Looking for deliveries waiting to be billed...
                  </p>
                ) : receiptChoices.length === 0 ? (
                  <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                    <Info size={12} className="mt-0.5 shrink-0 opacity-70" />
                    {supplierId
                      ? 'This supplier has nothing waiting to be billed. Type the bill by hand below.'
                      : 'No deliveries are waiting to be billed. Type the bill by hand below, or receive the goods first.'}
                  </p>
                ) : (
                  <>
                    <p className="text-muted-foreground mb-2 text-[11px] leading-snug">
                      One bill can settle several deliveries — tick every one it covers. Each box
                      below narrows the others.
                    </p>

                    {/* ── The ways in ──────────────────────────────────────
                      The clerk is holding the supplier's invoice. It carries
                      his name, his challan number, his own bill number and our
                      order number — and never our receipt number, which he has
                      never seen. A picker that offered only GRN numbers was
                      asking them to translate between two documents in their
                      head, which is how the wrong delivery gets billed.

                      The supplier leads, because it is the one box that is not
                      only a filter: it is the bill's own supplier, the same
                      field as the one in Bill Details below, and answering it
                      here is answering it there. */}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                      <label className="block">
                        <span className="form-label">
                          Supplier<span className="ml-0.5 text-red-400">*</span>
                        </span>
                        <select
                          className="form-input h-8 text-xs"
                          value={supplierId}
                          onChange={(e) => chooseSupplier(e.target.value)}
                          disabled={pulling}
                        >
                          <option value="">All suppliers</option>
                          {suppliers.map((sup) => (
                            <option key={sup.id} value={sup.id}>
                              {sup.code ? `${sup.code} — ${sup.name}` : sup.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="form-label">PO no.</span>
                        <select
                          className="form-input h-8 text-xs"
                          value={filterPo}
                          onChange={(e) => choosePo(e.target.value)}
                          disabled={pulling}
                        >
                          <option value="">All orders</option>
                          {poChoices.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.poNumber}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="form-label">Challan no. (theirs)</span>
                        <select
                          className="form-input h-8 text-xs"
                          value={filterChallan}
                          onChange={(e) => chooseChallan(e.target.value)}
                          disabled={pulling}
                        >
                          <option value="">All challans</option>
                          {challanChoices.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="form-label">Supplier bill no.</span>
                        <select
                          className="form-input h-8 text-xs"
                          value={filterBill}
                          onChange={(e) => chooseBill(e.target.value)}
                          disabled={pulling || billChoices.length === 0}
                          title={
                            billChoices.length === 0
                              ? 'None of these deliveries had a supplier bill number written down at the gate'
                              : undefined
                          }
                        >
                          <option value="">
                            {billChoices.length === 0 ? 'None recorded' : 'All bill numbers'}
                          </option>
                          {billChoices.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="form-label">Receipt no. (ours)</span>
                        <select
                          className="form-input h-8 text-xs"
                          value={filterGrn}
                          onChange={(e) => chooseGrn(e.target.value)}
                          disabled={pulling}
                        >
                          <option value="">All receipts</option>
                          {grnChoices.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.grnNumber}
                              {g.challanNo ? ` · ${g.challanNo}` : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {/* Folded until one of the boxes above is answered.

                      A bill is raised against a delivery somebody is holding
                      the paperwork for, so the question is always "which one
                      is this" and never "what is there" — and a list of every
                      unbilled delivery in the mill, open by default, is a wall
                      of numbers to scroll past on the way to the form. The
                      press below opens it anyway, because a clerk who has lost
                      the challan number still has to be able to look. */}
                    {!receiptsOpen ? (
                      <div className="border-border/70 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed px-3 py-2.5 text-xs">
                        <span className="text-muted-foreground">
                          {receiptChoices.length === 1
                            ? '1 delivery is waiting to be billed.'
                            : `${receiptChoices.length} deliveries are waiting to be billed.`}{' '}
                          Name the supplier above, or the challan on the invoice in your hand.
                        </span>
                        <button
                          type="button"
                          className="text-primary font-medium hover:underline"
                          onClick={() => setShowAllReceipts(true)}
                        >
                          Show them all
                        </button>
                      </div>
                    ) : (
                      <>
                        {/* ── What is waiting ──────────────────────────────
                          A table, not a strip of chips. "GRN-0009 PO-0006
                          650" read as a receipt, an order and six hundred and
                          fifty rupees; it was six hundred and fifty pieces,
                          and there was nowhere in it for the numbers the clerk
                          actually has in front of them. The order, the
                          challan, our receipt and their bill number come
                          first, in that order — the three the supplier quotes,
                          then ours — and every figure after them gets a column
                          with a heading over it. The money is named an
                          estimate because that is what it is: the supplier's
                          own invoice is what gets booked. */}
                        <div className="border-border bg-card mt-2 max-h-60 overflow-auto rounded-lg border">
                          <table className="w-full min-w-[760px] border-collapse text-xs">
                            <thead className="sticky top-0 z-10">
                              <tr className="bg-secondary">
                                {[
                                  ['', 'w-8', 'left'],
                                  ['PO no.', 'w-24', 'left'],
                                  ['Challan', 'w-28', 'left'],
                                  ['Receipt', 'w-24', 'left'],
                                  ['Supplier bill', 'w-28', 'left'],
                                  ['Received', 'w-24', 'left'],
                                  ['Unbilled', 'w-24', 'right'],
                                  ['Est. value', 'w-28', 'right'],
                                ].map(([label, width, align], n) => (
                                  <th
                                    key={`${label}-${n}`}
                                    className={`${width} bg-secondary border-border text-muted-foreground border-b px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${
                                      align === 'right' ? 'text-right' : 'text-left'
                                    }`}
                                  >
                                    {label}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {visibleReceipts.length === 0 ? (
                                <tr>
                                  <td
                                    colSpan={8}
                                    className="text-muted-foreground px-2 py-6 text-center text-xs"
                                  >
                                    Nothing matches those filters. Clear one to widen the list.
                                  </td>
                                </tr>
                              ) : (
                                visibleReceipts.map((g, n) => {
                                  const on = billedSet.has(g.grnNumber)
                                  const left = Number(g.billing?.pendingQty ?? 0)
                                  const worth = Number(g.billing?.pendingValue ?? 0)
                                  const part = Number(g.billing?.billedQty ?? 0) > 0
                                  const flip = () => {
                                    if (pulling) return
                                    if (on) dropReceipt(g.grnNumber)
                                    else void pullFromGrn(g.id)
                                  }
                                  return (
                                    <tr
                                      key={g.id}
                                      onClick={flip}
                                      className={`border-border/50 cursor-pointer border-b last:border-0 ${
                                        on ? 'bg-primary/5' : n % 2 === 1 ? 'zebra-row' : ''
                                      }`}
                                    >
                                      <td className="px-2 py-1.5">
                                        <input
                                          type="checkbox"
                                          className="accent-primary size-3.5 align-middle"
                                          checked={on}
                                          disabled={pulling}
                                          onChange={flip}
                                          /* The whole row is the hit target.
                                            Without this the click lands twice
                                            — once on the box, once on the row
                                            — and the receipt goes on and
                                            straight back off again. */
                                          onClick={(e) => e.stopPropagation()}
                                          aria-label={`Bill ${g.grnNumber}${
                                            g.challanNo ? `, challan ${g.challanNo}` : ''
                                          }`}
                                        />
                                      </td>
                                      <td className="text-foreground px-2 py-1.5 font-mono">
                                        {g.po?.poNumber ?? '—'}
                                        {/* Only while the bill has no supplier
                                          — until then the list spans all of
                                          them and a receipt number says
                                          nothing about whose delivery it was. */}
                                        {!supplierId && g.po?.supplier?.name && (
                                          <span className="text-muted-foreground block max-w-[10rem] truncate font-sans text-[10px]">
                                            {g.po.supplier.name}
                                          </span>
                                        )}
                                      </td>
                                      <td
                                        className={`px-2 py-1.5 font-mono ${
                                          g.challanNo ? 'text-foreground' : 'text-muted-foreground'
                                        }`}
                                      >
                                        {g.challanNo || '—'}
                                      </td>
                                      <td className="text-muted-foreground px-2 py-1.5 font-mono">
                                        {g.grnNumber}
                                      </td>
                                      <td
                                        className={`px-2 py-1.5 font-mono ${
                                          g.supplierInvoiceNo
                                            ? 'text-foreground'
                                            : 'text-muted-foreground'
                                        }`}
                                      >
                                        {g.supplierInvoiceNo || '—'}
                                      </td>
                                      <td className="text-muted-foreground whitespace-nowrap px-2 py-1.5">
                                        {g.grnDate
                                          ? new Date(g.grnDate).toLocaleDateString('en-IN', {
                                              day: '2-digit',
                                              month: 'short',
                                              year: 'numeric',
                                            })
                                          : '—'}
                                      </td>
                                      <td className="px-2 py-1.5 text-right">
                                        <span className="text-foreground tabular-nums">
                                          {left.toLocaleString('en-IN')}
                                        </span>
                                        {/* Part-billed is the one that has
                                          caught people out: the receipt is on
                                          this list because something is still
                                          owed on it, not because nothing has
                                          been billed. Under the figure it
                                          qualifies, rather than in a column of
                                          its own that is empty on most rows. */}
                                        {part && (
                                          <span className="block text-[10px] text-amber-500">
                                            part billed
                                          </span>
                                        )}
                                      </td>
                                      <td className="text-muted-foreground px-2 py-1.5 text-right tabular-nums">
                                        {worth > 0 ? `₹${inr(worth)}` : '—'}
                                      </td>
                                    </tr>
                                  )
                                })
                              )}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}

                    <div className="text-muted-foreground mt-1.5 space-y-1 text-[11px]">
                      <p className="flex items-center gap-1.5">
                        {pulling ? (
                          <>
                            <Loader2 size={11} className="animate-spin" />
                            Reading the delivery...
                          </>
                        ) : (
                          billedReceipts.length > 0 && (
                            <>
                              <Info size={11} className="shrink-0 opacity-70" />
                              Quantities and rates came from the gate — change them only where their
                              invoice differs.
                            </>
                          )
                        )}
                      </p>
                      {/* Said out loud rather than left to be discovered. The
                        server pages at a hundred, and a picker quietly showing
                        a subset of what is owed is how a delivery goes unbilled
                        for a quarter. */}
                      {receiptTotal > grns.length && (
                        <p className="flex items-start gap-1.5 text-amber-500">
                          <TriangleAlert size={11} className="mt-px shrink-0" />
                          Showing the {grns.length} most recent receipts of {receiptTotal}
                          {supplierId ? ' for this supplier' : ''}. Pick the supplier first, or
                          start the bill from the delivery on the goods receipt screen.
                        </p>
                      )}
                    </div>
                  </>
                )}
              </Section>
            )}

            <Section icon={FileText} title="Bill Details">
              {/* `auto-fit`, not a fixed two columns — their bill's own
                number pairs with its date, and when we booked it pairs
                with when it falls due, on any phone wide enough to hold
                a date field without clipping it to "dd-mm-yyy". Supplier
                and the reverse charge note take `col-span-full` rather
                than a fixed span, so they stay full width whether the
                row beside them has resolved to one column or three —
                one carries a GSTIN line under it and the other a
                paragraph, and either beside a lone date field would read
                as unbalanced. */}
              <div className="grid grid-cols-[repeat(auto-fit,minmax(105px,1fr))] gap-2.5 md:grid-cols-4 xl:grid-cols-8">
                <div className="col-span-full md:col-span-2">
                  <label className="form-label" htmlFor="bill-supplier">
                    Supplier<span className="ml-0.5 text-red-400">*</span>
                  </label>
                  <select
                    id="bill-supplier"
                    className="form-input"
                    value={supplierId}
                    onChange={(e) => chooseSupplier(e.target.value)}
                  >
                    <option value="">Select...</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code ? `${s.code} — ${s.name}` : s.name}
                      </option>
                    ))}
                  </select>
                  {supplier && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {supplier.gstin ? (
                        <>
                          GSTIN {supplier.gstin} ·{' '}
                          {taxMode === 'CGST_SGST'
                            ? 'within the state, CGST + SGST'
                            : 'other state, IGST'}
                        </>
                      ) : isReverseCharge ? (
                        'Not registered — the GST on this bill is ours to pay, not theirs'
                      ) : (
                        'No GSTIN on file — this bill will carry no GST'
                      )}
                    </p>
                  )}
                </div>

                <div>
                  {/* The bill is booked with their invoice on the desk, so this is
                the document's own number rather than an afterthought. It is
                also what stops the same invoice being booked twice. */}
                  <label className="form-label" htmlFor="bill-supplier-no">
                    Bill no.<span className="ml-0.5 text-red-400">*</span>{' '}
                    <span className="text-muted-foreground">(theirs)</span>
                  </label>
                  <input
                    id="bill-supplier-no"
                    className="form-input"
                    placeholder="As printed on their bill"
                    value={supplierInvoiceNo}
                    onChange={(e) => setSupplierInvoiceNo(e.target.value)}
                  />
                  {/* A prompt, not an alarm. An empty box on a form nobody has
                filled in yet has not gone wrong — it is simply not done, and
                amber on first sight reads as a mistake already made. */}
                  {!supplierInvoiceNo.trim() && (
                    <span className="text-muted-foreground mt-1 block text-xs">
                      Put the supplier’s bill number in
                    </span>
                  )}
                </div>

                <div>
                  <label className="form-label" htmlFor="bill-supplier-date">
                    Bill date<span className="ml-0.5 text-red-400">*</span>
                  </label>
                  <input
                    id="bill-supplier-date"
                    type="date"
                    className="form-input"
                    value={supplierInvoiceDate}
                    onChange={(e) => setSupplierInvoiceDate(e.target.value)}
                  />
                  {!supplierInvoiceDate && (
                    <span className="text-muted-foreground mt-1 block text-xs">
                      Put the date on their bill
                    </span>
                  )}
                </div>

                <div>
                  <label className="form-label" htmlFor="bill-date">
                    Booked on
                  </label>
                  <input
                    id="bill-date"
                    type="date"
                    className="form-input"
                    value={billDate}
                    onChange={(e) => setBillDate(e.target.value)}
                  />
                </div>

                <div>
                  <label className="form-label" htmlFor="bill-due">
                    Payment due
                  </label>
                  <input
                    id="bill-due"
                    type="date"
                    className="form-input"
                    value={dueDate}
                    onChange={(e) => {
                      // Theirs from here on. See `dueTyped`.
                      dueTyped.current = true
                      setDueDate(e.target.value)
                    }}
                  />
                  {/* The line under this box said which term the date was
                    worked out from and, for a small supplier, that 45 days is
                    the legal ceiling. Taken off on request. The date is still
                    worked out the same way — see `termDays` — it simply no
                    longer explains itself here. */}
                </div>

                <div className="col-span-full flex items-end md:col-span-2">
                  <label className="text-foreground flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={isReverseCharge}
                      onChange={(e) => setIsReverseCharge(e.target.checked)}
                    />
                    <span>
                      Reverse charge
                      <span className="text-muted-foreground block text-xs">
                        We pay the GST to the government, not to the supplier. Common on transport
                        and on bills from unregistered parties.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            </Section>

            {(overBilled.length > 0 || rateDrift.length > 0) && (
              <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <TriangleAlert size={16} className="warn-text mt-0.5 shrink-0" />
                <div className="warn-text space-y-1 text-xs">
                  {overBilled.map((l, i) => (
                    <p key={`o${i}`}>
                      {itemById.get(l.itemId)?.name ?? 'A line'}: the bill claims {num(l.qty)} but
                      only {l.pendingQty} is left to bill on {l.grnNumber}. Saving this will be
                      refused.
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/*
            The rate half of the three-way match.

            Quantity has always been checked against the receipt. The rate was
            not, so a supplier could bill the goods that did arrive at any
            price. Each mismatch now has to be answered before the bill saves:
            take their rate, with a reason, or hold them to the order's and
            claim the difference back.
          */}
            {rateDrift.length > 0 && (
              <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <div className="flex items-start gap-2">
                  <TriangleAlert size={15} className="mt-0.5 shrink-0 text-amber-400" />
                  <p className="text-sm text-amber-300">
                    {rateDrift.length === 1
                      ? 'One line is billed at a different rate than the order agreed.'
                      : `${rateDrift.length} lines are billed at a different rate than the order agreed.`}{' '}
                    Say what to do with each before saving.
                  </p>
                </div>

                {rateDrift.map((l) => {
                  const index = lines.indexOf(l)
                  const billed = num(l.unitPrice)
                  const ordered = l.orderedRate!
                  const diff = billed - ordered
                  const totalDiff = diff * num(l.qty)
                  const higher = diff > 0

                  return (
                    <div
                      key={`rv${index}`}
                      className="border-border bg-secondary/40 rounded-md border p-2.5"
                    >
                      <p className="text-foreground text-sm">
                        {itemById.get(l.itemId)?.name ?? 'A line'}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        Order ₹{inr(ordered)} · billed ₹{inr(billed)} ·{' '}
                        <span className={higher ? 'text-amber-400' : 'text-emerald-400'}>
                          {higher ? '+' : ''}
                          {inr(diff)} each, {higher ? '+' : ''}
                          {inr(totalDiff)} on this line
                        </span>
                      </p>

                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => setLine(index, { rateAction: 'ACCEPT' })}
                          className={`rounded-md border px-2.5 py-1.5 text-xs transition ${
                            l.rateAction === 'ACCEPT'
                              ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                              : 'border-border text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Accept ₹{inr(billed)}
                        </button>
                        <button
                          type="button"
                          onClick={() => setLine(index, { rateAction: 'DEBIT_NOTE' })}
                          className={`rounded-md border px-2.5 py-1.5 text-xs transition ${
                            l.rateAction === 'DEBIT_NOTE'
                              ? 'border-teal-500/60 bg-teal-500/15 text-teal-300'
                              : 'border-border text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {higher
                            ? `Book ₹${inr(ordered)} and claim the difference`
                            : `Book ₹${inr(ordered)}`}
                        </button>
                      </div>

                      {l.rateAction === 'DEBIT_NOTE' && higher && (
                        <p className="text-muted-foreground mt-1.5 text-[11px]">
                          A debit note for ₹{inr(totalDiff)} plus tax is raised in draft. Nothing is
                          sent to the supplier until somebody sends it.
                        </p>
                      )}
                    </div>
                  )
                })}

                {needsRateReason && (
                  <label className="block">
                    <span className="form-label">Why the higher rate was agreed</span>
                    <input
                      id="bill-rate-reason"
                      className="form-input h-9"
                      value={rateVarianceReason}
                      onChange={(e) => setRateVarianceReason(e.target.value)}
                      placeholder="e.g. yarn price rose, agreed with the supplier on the phone"
                    />
                  </label>
                )}
              </div>
            )}

            {/* Lines */}
            <Section
              icon={Package}
              title={expenseMode ? 'Expense Details' : 'Item Details'}
              actions={
                <button
                  type="button"
                  onClick={() => setLines((p) => [...p, freshLine()])}
                  className="btn-secondary text-xs"
                >
                  <Plus size={14} /> Add line
                </button>
              }
            >
              {expenseMode && categories.length > 0 && expenseHeads.length === 0 && (
                <p className="text-muted-foreground mb-2 flex items-start gap-1.5 text-xs">
                  <Info size={13} className="mt-px shrink-0" />
                  <span>
                    No expense heads yet. Add a category called &ldquo;Expenses&rdquo; in Masters →
                    Item Categories and put heads under it — Electricity, Rent, Repairs &amp;
                    Maintenance — or use &ldquo;+ Add a new expense head…&rdquo; in the list below.
                    Until then every item is listed.
                  </span>
                </p>
              )}
              <div className="border-border hidden overflow-x-auto rounded-lg border sm:block">
                <table className="w-full min-w-[900px] text-sm">
                  <thead>
                    <tr className="border-border bg-secondary/70 border-b">
                      {[
                        'Item',
                        expenseMode ? 'Description' : 'Against receipt',
                        'Qty',
                        'Rate',
                        'Disc %',
                        'GST %',
                        'Amount (₹)',
                        '',
                      ].map((h, i) => (
                        <th
                          key={h || i}
                          className={`text-muted-foreground px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${
                            ['Qty', 'Rate', 'Disc %', 'GST %', 'Amount (₹)'].includes(h)
                              ? 'text-right'
                              : 'text-left'
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
                        <tr
                          key={i}
                          className="border-border/50 border-b last:border-0 [&>td]:align-top"
                        >
                          <td className="min-w-[200px] px-3 py-1.5">
                            <select
                              className="form-input h-8"
                              value={line.itemId}
                              onChange={(e) => pickItem(i, e.target.value)}
                              aria-label={`Line ${i + 1} item`}
                            >
                              {itemChoices()}
                            </select>
                            {item?.hsnCode && (
                              <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">
                                {expenseMode ? 'HSN/SAC' : 'HSN'} {item.hsnCode}
                              </p>
                            )}
                            {expenseMode &&
                              item &&
                              categories.length > 0 &&
                              !isExpenseHead(item) && (
                                <p className="mt-0.5 text-[10px] text-amber-500">
                                  Not an expense head — goods should come in on a receipt
                                </p>
                              )}
                          </td>
                          <td className="min-w-[130px] px-3 py-1.5">
                            {expenseMode ? (
                              <input
                                className="form-input h-8"
                                value={line.description ?? ''}
                                onChange={(e) => setLine(i, { description: e.target.value })}
                                placeholder="e.g. Sept 2026, meter 40231"
                                aria-label={`Line ${i + 1} description`}
                              />
                            ) : line.grnNumber ? (
                              <>
                                <span className="badge-info">{line.grnNumber}</span>
                                {line.pendingQty != null && (
                                  <p className="text-muted-foreground mt-0.5 text-[10px]">
                                    {line.pendingQty} left to bill
                                  </p>
                                )}
                                {/* This bill claims the whole delivery, the
                                  rejected part included — so it is said here,
                                  where the person booking it can still act on
                                  it, rather than left for whoever reconciles
                                  the payment to notice on their own. */}
                                {Boolean(line.rejectedQty) && (
                                  <p className="mt-0.5 text-[10px] text-amber-500">
                                    {line.rejectedQty} rejected — raise a debit note for it
                                  </p>
                                )}
                              </>
                            ) : (
                              <span className="text-muted-foreground text-xs">Not matched</span>
                            )}
                          </td>
                          <td className="w-28 px-3 py-1.5">
                            {/* The wheel and the arrow keys move this by whole units.
                           Not 0.001, which moved it by a thousandth of a piece; and not 1,
                           which would refuse 1500.5 metres of fabric outright. "any" steps
                           by one while still accepting a decimal that is typed. */}
                            <input
                              type="number"
                              step="any"
                              min={0}
                              className="form-input h-8 text-right"
                              value={String(line.qty)}
                              onChange={(e) => setLine(i, { qty: e.target.value })}
                              aria-label={`Line ${i + 1} quantity`}
                            />
                            {item?.uom?.symbol && (
                              <p className="text-muted-foreground mt-0.5 text-right text-[10px]">
                                {item.uom.symbol}
                              </p>
                            )}
                          </td>
                          <td className="w-28 px-3 py-1.5">
                            <input
                              type="number"
                              step="0.01"
                              min={0}
                              className="form-input h-8 text-right"
                              value={String(line.unitPrice)}
                              onChange={(e) => setLineRate(i, e.target.value)}
                              aria-label={`Line ${i + 1} rate`}
                            />
                            {line.orderedRate != null && (
                              <p className="text-muted-foreground mt-0.5 text-right text-[10px]">
                                ordered {inr(line.orderedRate)}
                              </p>
                            )}
                          </td>
                          <td className="w-20 px-3 py-1.5">
                            <input
                              type="number"
                              step="0.01"
                              min={0}
                              max={100}
                              className="form-input h-8 text-right"
                              value={String(line.discount)}
                              onChange={(e) => setLine(i, { discount: e.target.value })}
                              aria-label={`Line ${i + 1} discount`}
                            />
                          </td>
                          <td className="w-20 px-3 py-1.5">
                            <input
                              type="number"
                              step="0.01"
                              min={0}
                              max={100}
                              className="form-input h-8 text-right"
                              disabled={taxMode === 'NONE'}
                              value={taxMode === 'NONE' ? '' : String(line.gstRate)}
                              onChange={(e) => setLine(i, { gstRate: e.target.value })}
                              aria-label={`Line ${i + 1} GST rate`}
                            />
                          </td>
                          <td className="w-32 px-3 py-2 text-right font-medium tabular-nums">
                            {inr(totals.lineGross[i] ?? 0)}
                          </td>
                          <td className="w-12 px-3 py-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setLines((p) => (p.length === 1 ? p : p.filter((_, x) => x !== i)))
                              }
                              disabled={lines.length === 1}
                              className="btn-ghost text-muted-foreground p-1 hover:text-red-400 disabled:opacity-25"
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

              {/* Same lines, one card each, for a screen too narrow for eight
              columns. Every field a line has sits under the last instead of
              off the right edge of a table nobody can widen on a phone. */}
              <div className="space-y-3 sm:hidden">
                {lines.map((line, i) => {
                  const item = itemById.get(line.itemId)
                  const fieldLabel =
                    'text-muted-foreground text-[10px] font-semibold uppercase tracking-wider'

                  return (
                    <div key={i} className="border-border bg-card rounded-lg border p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-muted-foreground text-xs font-semibold tabular-nums">
                          Line {i + 1}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setLines((p) => (p.length === 1 ? p : p.filter((_, x) => x !== i)))
                          }
                          disabled={lines.length === 1}
                          className="btn-ghost text-muted-foreground p-1 hover:text-red-400 disabled:opacity-25"
                          aria-label={`Remove line ${i + 1}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>

                      <div className="space-y-1">
                        <label className={fieldLabel}>Item</label>
                        <select
                          className="form-input h-9 w-full"
                          value={line.itemId}
                          onChange={(e) => pickItem(i, e.target.value)}
                          aria-label={`Line ${i + 1} item`}
                        >
                          {itemChoices()}
                        </select>
                        {item?.hsnCode && (
                          <p className="text-muted-foreground font-mono text-[10px]">
                            {expenseMode ? 'HSN/SAC' : 'HSN'} {item.hsnCode}
                          </p>
                        )}
                        {expenseMode && item && categories.length > 0 && !isExpenseHead(item) && (
                          <p className="text-[10px] text-amber-500">
                            Not an expense head — goods should come in on a receipt
                          </p>
                        )}
                      </div>

                      <div className="mt-2">
                        <p className={fieldLabel}>
                          {expenseMode ? 'Description' : 'Against receipt'}
                        </p>
                        {expenseMode ? (
                          <input
                            className="form-input h-9 w-full"
                            value={line.description ?? ''}
                            onChange={(e) => setLine(i, { description: e.target.value })}
                            placeholder="e.g. Sept 2026, meter 40231"
                            aria-label={`Line ${i + 1} description`}
                          />
                        ) : line.grnNumber ? (
                          <>
                            <span className="badge-info">{line.grnNumber}</span>
                            {line.pendingQty != null && (
                              <p className="text-muted-foreground mt-0.5 text-[10px]">
                                {line.pendingQty} left to bill
                              </p>
                            )}
                            {Boolean(line.rejectedQty) && (
                              <p className="mt-0.5 text-[10px] text-amber-500">
                                {line.rejectedQty} rejected — raise a debit note for it
                              </p>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground text-xs">Not matched</span>
                        )}
                      </div>

                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className={fieldLabel}>Qty</label>
                          <input
                            type="number"
                            step="any"
                            min={0}
                            className="form-input h-9 w-full text-right"
                            value={String(line.qty)}
                            onChange={(e) => setLine(i, { qty: e.target.value })}
                            aria-label={`Line ${i + 1} quantity`}
                          />
                          {item?.uom?.symbol && (
                            <p className="text-muted-foreground text-right text-[10px]">
                              {item.uom.symbol}
                            </p>
                          )}
                        </div>
                        <div className="space-y-1">
                          <label className={fieldLabel}>Rate</label>
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            className="form-input h-9 w-full text-right"
                            value={String(line.unitPrice)}
                            onChange={(e) => setLineRate(i, e.target.value)}
                            aria-label={`Line ${i + 1} rate`}
                          />
                          {line.orderedRate != null && (
                            <p className="text-muted-foreground text-right text-[10px]">
                              ordered {inr(line.orderedRate)}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className={fieldLabel}>Disc %</label>
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            max={100}
                            className="form-input h-9 w-full text-right"
                            value={String(line.discount)}
                            onChange={(e) => setLine(i, { discount: e.target.value })}
                            aria-label={`Line ${i + 1} discount`}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className={fieldLabel}>GST %</label>
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            max={100}
                            className="form-input h-9 w-full text-right"
                            disabled={taxMode === 'NONE'}
                            value={taxMode === 'NONE' ? '' : String(line.gstRate)}
                            onChange={(e) => setLine(i, { gstRate: e.target.value })}
                            aria-label={`Line ${i + 1} GST rate`}
                          />
                        </div>
                      </div>

                      <div className="border-border/70 mt-2.5 flex items-center justify-between border-t pt-2">
                        <span className={fieldLabel}>Amount</span>
                        <span className="font-medium tabular-nums">
                          {inr(totals.lineGross[i] ?? 0)}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </Section>

            {/* TDS and the notes box used to sit to the left of this.
              Taken off the form on request. Nothing was dropped from the
              document: a bill already carrying a TDS section or a note keeps
              both — the form still holds them and still sends them back
              untouched — there is simply no longer anywhere to type a new
              one. */}
            <Section icon={Calculator} title="Totals">
              <div className="border-border bg-secondary/40 h-fit space-y-1.5 rounded-lg border p-2.5 text-sm">
                <Row label={expenseMode ? 'Subtotal' : 'Goods subtotal'} value={totals.subtotal} />
                <div className="flex items-center justify-between gap-4">
                  <label htmlFor="bill-discount" className="text-muted-foreground">
                    Discount on the whole bill
                  </label>
                  <input
                    id="bill-discount"
                    type="number"
                    step="0.01"
                    min={0}
                    className="form-input h-8 w-32 text-right"
                    value={discountAmount}
                    onChange={(e) => setDiscountAmount(e.target.value)}
                  />
                </div>
                {chargeTypes.length > 0 && (
                  <div className="space-y-1.5 py-0.5">
                    {charges.map((c, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <select
                          className="form-input h-8 min-w-0 flex-1 text-xs"
                          value={c.chargeTypeId}
                          onChange={(e) => {
                            const ct = chargeById.get(e.target.value)
                            setCharges((p) =>
                              p.map((x, y) =>
                                y === i
                                  ? {
                                      ...x,
                                      chargeTypeId: e.target.value,
                                      gstRate:
                                        x.gstRate ||
                                        (ct?.defaultGstRate != null
                                          ? String(ct.defaultGstRate)
                                          : ''),
                                    }
                                  : x
                              )
                            )
                          }}
                          aria-label={`Charge ${i + 1} type`}
                        >
                          <option value="">Charge type…</option>
                          {chargeTypes.map((ct) => (
                            <option key={ct.id} value={ct.id}>
                              {ct.name}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          className="form-input h-8 w-24 shrink-0 text-right text-xs"
                          placeholder="Amount"
                          value={String(c.amount)}
                          onChange={(e) =>
                            setCharges((p) =>
                              p.map((x, y) => (y === i ? { ...x, amount: e.target.value } : x))
                            )
                          }
                          aria-label={`Charge ${i + 1} amount`}
                        />
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          max={100}
                          className="form-input h-8 w-16 shrink-0 text-right text-xs"
                          placeholder="GST%"
                          disabled={taxMode === 'NONE'}
                          value={taxMode === 'NONE' ? '' : String(c.gstRate)}
                          onChange={(e) =>
                            setCharges((p) =>
                              p.map((x, y) => (y === i ? { ...x, gstRate: e.target.value } : x))
                            )
                          }
                          aria-label={`Charge ${i + 1} GST rate`}
                        />
                        <button
                          type="button"
                          onClick={() => setCharges((p) => p.filter((_, y) => y !== i))}
                          className="btn-ghost text-muted-foreground shrink-0 p-1 hover:text-red-400"
                          aria-label={`Remove charge ${i + 1}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        setCharges((p) => [...p, { chargeTypeId: '', amount: '', gstRate: '' }])
                      }
                      className="text-muted-foreground flex items-center gap-1 text-xs transition-colors hover:text-teal-400"
                    >
                      <Plus size={12} /> Add charge
                    </button>
                  </div>
                )}
                <Row label="Taxable value" value={totals.taxable} />
                {taxMode === 'CGST_SGST' && (
                  <>
                    <Row label="CGST" value={totals.tax / 2} />
                    <Row label="SGST" value={totals.tax / 2} />
                  </>
                )}
                {taxMode === 'IGST' && <Row label="IGST" value={totals.tax} />}
                {taxMode === 'NONE' && (
                  <p className="text-muted-foreground py-1 text-xs">
                    No GST — this supplier is not registered.
                  </p>
                )}
                {taxMode === null && (
                  <>
                    <Row label="GST" value={totals.tax} />
                    <p className="text-muted-foreground py-1 text-xs">
                      Choose a supplier to see whether this splits into CGST + SGST or is IGST.
                    </p>
                  </>
                )}
                {isReverseCharge && totals.tax > 0 && (
                  <p className="py-1 text-xs text-amber-400">
                    Reverse charge — the ₹{inr(totals.tax)} of GST above is payable by us to the
                    government and is not part of what the supplier is paid.
                  </p>
                )}
                <Row label="Rounding" value={totals.roundOff} />
                <div className="border-border flex items-center justify-between border-t pt-2">
                  <span className="text-foreground font-semibold">Bill total</span>
                  <span className="text-foreground text-lg font-semibold tabular-nums">
                    ₹{inr(totals.total)}
                  </span>
                </div>
                {totals.tds > 0 && (
                  <>
                    <Row
                      label={`TDS withheld${tdsSection ? ` (${tdsSection})` : ''}`}
                      value={-totals.tds}
                    />
                    <div className="border-border flex items-center justify-between border-t pt-2">
                      <span className="text-foreground font-medium">Payable to supplier</span>
                      <span className="text-foreground font-semibold tabular-nums">
                        ₹{inr(totals.balance)}
                      </span>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      Paying this smaller amount settles the bill in full — the TDS is accounted for
                      rather than left outstanding against them.
                    </p>
                  </>
                )}
              </div>
            </Section>
          </div>

          {/* Footer — stays put, so Save is always one press away. */}
          <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-3 border-t px-5 py-3.5">
            <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving && <Loader2 size={15} className="animate-spin" />}
              {isEdit ? 'Save changes' : 'Book bill'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground tabular-nums">{inr(value)}</span>
    </div>
  )
}
