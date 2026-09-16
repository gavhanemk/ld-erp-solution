'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  X,
  Loader2,
  AlertCircle,
  Plus,
  Trash2,
  ShoppingCart,
  Building2,
  ListChecks,
  Printer,
  Calculator,
  FileText,
  Package,
  Truck,
  Paperclip,
  ScrollText,
  Search,
  Lock,
} from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'

/**
 * Raising a purchase order.
 *
 * Opens over the order list rather than on a page of its own: the clerk is
 * looking at what has already been ordered when they decide to order more, and
 * taking that list away to ask for a supplier loses the context that prompted
 * it. The list stays behind, dimmed.
 *
 * The form is laid out as the job is done, not as the table is shaped — what
 * the order is, what is on it, who it is from, where it goes, what it says.
 * Only the middle section is real work; the rest is mostly already known.
 */

/**
 * Where a discount is allowed to sit on this order.
 *
 * The buyer picks it before typing any figures, because it decides which
 * discount boxes are live. Stored in `poType`, a column that has existed since
 * the first migration and that nothing has ever set until now.
 */
export type PoType = 'ITEM_LEVEL' | 'ORDER_LEVEL' | 'NONE'

export interface PoLine {
  itemId: string
  description?: string | null
  styleId?: string | null
  qty: number | string
  unitRate: number | string
  discount: number | string
  gstRate: number | string
  /** Priced by the API. Absent on a line the form is still building. */
  amount?: number | string
  style?: { id: string; code: string; name: string } | null
  item?: {
    id: string
    code: string
    name: string
    hsnCode: string | null
    uom?: { symbol: string } | null
    category?: { id: string; name: string; parent?: { id: string; name: string } | null } | null
  }
}

export interface PurchaseOrder {
  id: string
  poNumber: string
  supplierId: string
  poDate: string
  poType?: string | null
  deliveryDate: string | null
  deliveryWarehouseId: string | null
  deliveryCustomerId: string | null
  enquiryNo: string | null
  enquiryDate: string | null
  reference: string | null
  remark: string | null
  status: string
  subtotal: string | number
  discountAmount: string | number
  taxableAmount: string | number
  cgst: string | number
  sgst: string | number
  igst: string | number
  roundOff: string | number
  totalAmount: string | number
  otherCharges?: string | number | null
  charges?: {
    chargeTypeId: string
    amount: string | number
    gstRate: string | number
  }[]
  notes: string | null
  terms: string | null
  supplier?: { id: string; name: string; code: string; gstin: string | null; stateCode: string | null }
  lines?: PoLine[]
}

/** One kind of charge the mill puts on a purchase — transport, freight, dyeing. */
interface ChargeTypeOption {
  id: string
  name: string
  defaultGstRate: string | number
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
  categoryId?: string | null
  category?: { id: string; name: string } | null
  parentId?: string | null
  address?: string | null
  // A customer keeps two addresses. Goods are taxed where they land, so the
  // shipping one wins wherever both are set.
  shippingStateCode?: string | null
  billingStateCode?: string | null
  shippingGstin?: string | null
  shippingAddress?: string | null
  shippingCity?: string | null
  shippingPincode?: string | null
  billingAddress?: string | null
  billingCity?: string | null
  billingPincode?: string | null
}

interface Attachment {
  id: string
  fileName: string
  sizeBytes: number
  mimeType: string | null
  uploadedBy?: { id: string; name: string } | null
  createdAt: string
}

interface CompanyLite {
  name?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  pincode?: string | null
  stateCode?: string | null
  email?: string | null
}

/**
 * The biggest file that may be attached, and the most files on one order.
 *
 * Kept the same as the API and the storage bucket. This copy only exists so
 * the form can say no immediately rather than after the file has been sent;
 * the server and the bucket are what actually enforce it.
 */
const MAX_FILE_MB = 50
const MAX_FILES = 5

/** Two decimals, the same as the API — so what is sent and what is stored agree. */
const round2 = (n: number) => Math.round(n * 100) / 100

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const inr = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** One boxed group. Every section is the same shape so the form reads as a list of steps. */
function Section({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: React.ElementType
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-border bg-secondary/20">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Icon size={14} className="text-muted-foreground shrink-0" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {hint && <span className="text-xs text-muted-foreground ml-auto">{hint}</span>}
      </div>
      <div className="p-3">{children}</div>
    </section>
  )
}

/**
 * A control for something the ERP cannot do yet.
 *
 * Shown rather than hidden, because the field is part of the order the mill
 * knows and leaving it out reads as though it had been forgotten. Disabled
 * rather than accepting input, because a box that takes what you type and
 * throws it away is worse than no box — the same reason an unbuilt endpoint
 * here answers 501 instead of an empty list.
 */
function Faded({ children }: { children: React.ReactNode }) {
  // 70%, not 50%. Half opacity takes a 7:1 label down to roughly 3:1, which is
  // below the floor for text of any size — the control read as damaged rather
  // than switched off. This is still visibly inactive and still legible.
  return <div className="pointer-events-none select-none opacity-70">{children}</div>
}

/**
 * One line covering everything in a section that cannot work yet.
 *
 * Shared rather than repeated per field: four of these sat on one screen, and
 * four near-identical apologies read as a broken product instead of an
 * unfinished one.
 */
function NotBuiltNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Lock size={13} className="mt-0.5 shrink-0" />
      {children}
    </p>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{inr(value)}</span>
    </div>
  )
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
  const [customers, setCustomers] = useState<Option[]>([])
  const [categories, setCategories] = useState<Option[]>([])
  const [styles, setStyles] = useState<Option[]>([])
  const [chargeTypes, setChargeTypes] = useState<ChargeTypeOption[]>([])
  const [company, setCompany] = useState<CompanyLite | null>(null)

  // Header
  const [supplierId, setSupplierId] = useState('')
  const [poType, setPoType] = useState<PoType>('ITEM_LEVEL')
  const [warehouseId, setWarehouseId] = useState('')
  const [enquiryNo, setEnquiryNo] = useState('')
  const [enquiryDate, setEnquiryDate] = useState('')
  const [reference, setReference] = useState('')
  /// Internal. Unlike `notes` it is not printed on the supplier's copy, which
  /// is the whole reason the two are separate fields.
  const [remark, setRemark] = useState('')
  const [deliverTo, setDeliverTo] = useState<'ORGANIZATION' | 'CUSTOMER'>('ORGANIZATION')
  const [deliveryCustomerId, setDeliveryCustomerId] = useState('')
  const [discountAmount, setDiscountAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState('')

  // Lines, and the picker that adds to them
  const [lines, setLines] = useState<PoLine[]>([])
  const [pickSearch, setPickSearch] = useState('')
  const [pickCategory, setPickCategory] = useState('')
  const [pickSubcategory, setPickSubcategory] = useState('')
  const [pickItem, setPickItem] = useState('')
  // Typed with the item rather than in the table afterwards, so one line is
  // entered in one pass and Add is the last thing touched.
  const [pickDescription, setPickDescription] = useState('')
  const [pickQty, setPickQty] = useState('')
  // Offered from the item master when there is one, and overtypable. A first
  // purchase of a brand-new item has no rate on file at all, which is exactly
  // when this box has to be typed into.
  const [pickRate, setPickRate] = useState('')
  const [pickDiscount, setPickDiscount] = useState('')
  const [pickDiscountUnit, setPickDiscountUnit] = useState<'%' | 'INR'>('%')
  const [pickTaxPct, setPickTaxPct] = useState('')
  const [pickTaxExempt, setPickTaxExempt] = useState(false)
  const [pickStyleId, setPickStyleId] = useState('')
  /*
   * What has been typed against each kind of charge, keyed by charge type id.
   *
   * A map rather than a list because the rows are the charge master's rows —
   * the form does not decide which charges exist, Masters → Charges does. Add
   * a charge type there and a row appears here.
   */
  const [charges, setCharges] = useState<Record<string, string>>({})
  const [otherCharges, setOtherCharges] = useState('')

  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Files chosen on a new order, held here until it has a number to hang them
  // on. They go up the moment it is saved.
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)

  const [saving, setSaving] = useState<'draft' | 'send' | 'print' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const firstFieldRef = useRef<HTMLSelectElement | null>(null)
  const qtyRef = useRef<HTMLInputElement | null>(null)

  // document does not exist while this page is rendered on the server, so the
  // portal can only be opened once the browser has it.
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) return
    setSupplierId(record?.supplierId ?? '')
    // Orders raised before this form asked carry the old default, which meant
    // a discount per line — so they reopen as that rather than as a blank.
    setPoType(
      record?.poType === 'ORDER_LEVEL' || record?.poType === 'NONE' ? record.poType : 'ITEM_LEVEL',
    )
    setWarehouseId(record?.deliveryWarehouseId ?? '')
    setEnquiryNo(record?.enquiryNo ?? '')
    setEnquiryDate(record?.enquiryDate?.slice(0, 10) ?? '')
    setReference(record?.reference ?? '')
    setRemark(record?.remark ?? '')
    setDeliveryCustomerId(record?.deliveryCustomerId ?? '')
    setDeliverTo(record?.deliveryCustomerId ? 'CUSTOMER' : 'ORGANIZATION')
    // An order saved with no discount reopens with the box empty, not with a
    // zero in it — a zero sitting there is not a figure anyone typed.
    setDiscountAmount(num(record?.discountAmount) > 0 ? String(record?.discountAmount) : '')
    setNotes(record?.notes ?? '')
    setTerms(record?.terms ?? '')
    setLines(
      record?.lines?.map((l) => ({
        itemId: l.itemId,
        description: l.description ?? '',
        styleId: l.styleId ?? '',
        qty: String(l.qty),
        unitRate: String(l.unitRate),
        discount: String(l.discount ?? 0),
        gstRate: String(l.gstRate ?? ''),
      })) ?? [],
    )
    setPickSearch('')
    setPickCategory('')
    setPickSubcategory('')
    setPickItem('')
    setPickDescription('')
    setPickQty('')
    setPickRate('')
    setPickDiscount('')
    setPickDiscountUnit('%')
    setPickTaxPct('')
    setPickTaxExempt(false)
    setPickStyleId('')
    setCharges(
      Object.fromEntries((record?.charges ?? []).map((c) => [c.chargeTypeId, String(c.amount)])),
    )
    setOtherCharges(num(record?.otherCharges) > 0 ? String(record?.otherCharges) : '')
    setAttachments([])
    setPendingFiles([])
    setError(null)
    setSaving(null)
  }, [open, record])

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void Promise.all([
      masterResource<Option>('suppliers').list({ limit: 500, active: true }),
      masterResource<Option>('items').list({ limit: 500, active: true }),
      masterResource<Option>('warehouses').list({ limit: 100, active: true }),
      masterResource<Option>('customers').list({ limit: 500, active: true }),
      masterResource<Option>('item-categories').list({ limit: 200, active: true }).catch(() => null),
      masterResource<Option>('styles').list({ limit: 500, active: true }).catch(() => null),
      // The charge rows in the totals are these, one row each. Failing to load
      // them costs the charge boxes, not the form.
      masterResource<ChargeTypeOption>('charge-types')
        .list({ limit: 100, active: true })
        .catch(() => null),
      // The company block under "deliver to" is our own address. Settings is
      // the only place that serves it and a purchase clerk may not be allowed
      // in there, so the address is treated as a nicety, not a requirement.
      api.get<{ success: boolean; data: CompanyLite }>('/settings/company').catch(() => null),
    ]).then(([s, i, w, cust, c, st, ct, co]) => {
      if (cancelled) return
      setSuppliers((s as Paginated<Option>).data)
      setItems((i as Paginated<Option>).data)
      setWarehouses((w as Paginated<Option>).data)
      setCustomers((cust as Paginated<Option>).data)
      setCategories(c ? (c as Paginated<Option>).data : [])
      setStyles(st ? (st as Paginated<Option>).data : [])
      // Only the charges the mill actually puts on a purchase. The sales-only
      // ones are in the same master and would be noise here.
      setChargeTypes(
        ct
          ? (ct as Paginated<ChargeTypeOption & { applyOnPurchase?: boolean }>).data.filter(
              (t) => t.applyOnPurchase !== false,
            )
          : [],
      )
      setCompany(co?.data ?? null)
    })

    return () => {
      cancelled = true
    }
  }, [open])

  // Only an order that exists can have files against it.
  useEffect(() => {
    if (!open || !record?.id) return
    let cancelled = false
    void api
      .get<{ success: boolean; data: Attachment[] }>(`/purchase/orders/${record.id}/attachments`)
      .then((res) => {
        if (!cancelled) setAttachments(res.data)
      })
      .catch(() => {
        // An order with no files and a server that would not answer look the
        // same here. The list stays empty; uploading will report the real
        // problem if there is one.
      })
    return () => {
      cancelled = true
    }
  }, [open, record?.id])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // The page behind must not scroll while this is open, or closing the form
    // leaves the list somewhere the clerk did not put it.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = setTimeout(() => firstFieldRef.current?.focus(), 50)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
      clearTimeout(focusTimer)
    }
  }, [open, onClose])

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const supplier = suppliers.find((s) => s.id === supplierId)

  const topCategories = useMemo(() => categories.filter((c) => !c.parentId), [categories])
  const subCategories = useMemo(
    () => (pickCategory ? categories.filter((c) => c.parentId === pickCategory) : []),
    [categories, pickCategory],
  )

  /** Items narrowed by the code search and whichever category level is chosen. */
  const visibleItems = useMemo(() => {
    const q = pickSearch.trim().toLowerCase()
    const childIds = new Set(subCategories.map((c) => c.id))

    return items.filter((it) => {
      if (pickSubcategory && it.categoryId !== pickSubcategory) return false
      if (pickCategory && !pickSubcategory) {
        if (it.categoryId !== pickCategory && !childIds.has(it.categoryId ?? '')) return false
      }
      if (!q) return true
      return (
        (it.code ?? '').toLowerCase().includes(q) ||
        it.name.toLowerCase().includes(q) ||
        (it.hsnCode ?? '').toLowerCase().includes(q)
      )
    })
  }, [items, pickSearch, pickCategory, pickSubcategory, subCategories])

  const deliveryCustomer =
    deliverTo === 'CUSTOMER' ? (customers.find((c) => c.id === deliveryCustomerId) ?? null) : null

  const customerStateCode =
    deliveryCustomer?.shippingStateCode ||
    deliveryCustomer?.billingStateCode ||
    deliveryCustomer?.shippingGstin?.slice(0, 2) ||
    deliveryCustomer?.gstin?.slice(0, 2) ||
    null

  const customerAddress =
    [deliveryCustomer?.shippingAddress, deliveryCustomer?.shippingCity, deliveryCustomer?.shippingPincode]
      .filter(Boolean)
      .join(', ') ||
    [deliveryCustomer?.billingAddress, deliveryCustomer?.billingCity, deliveryCustomer?.billingPincode]
      .filter(Boolean)
      .join(', ') ||
    null

  // Where the goods land. Our own address unless the order says a customer,
  // and it is this — not our state — that the supplier's state is compared
  // against, because goods are taxed where they are delivered.
  const placeOfSupply = customerStateCode || company?.stateCode

  const taxMode = !supplier
    ? null
    : !supplier.gstin
      ? 'NONE'
      : (supplier.stateCode ?? supplier.gstin?.slice(0, 2)) === placeOfSupply
        ? 'CGST_SGST'
        : 'IGST'

  /**
   * Which discounts this order is allowed to have.
   *
   * The dropdown at the top of the items box is not decoration — it decides
   * where a discount may sit, and the calculation has to agree with it or the
   * form shows one figure and saves another. Switching to "without discount"
   * with figures already typed must not leave them quietly in the total, so
   * they are ignored here as well as being greyed out.
   */
  const lineDiscountOf = (l: PoLine) => (poType === 'ITEM_LEVEL' ? num(l.discount) : 0)
  const orderDiscount = poType === 'ORDER_LEVEL' ? num(discountAmount) : 0

  const totals = useMemo(() => {
    const lineGross = lines.map((l) => num(l.qty) * num(l.unitRate))
    const lineAmounts = lines.map((l, i) => lineGross[i] * (1 - lineDiscountOf(l) / 100))
    const subtotal = lineAmounts.reduce((sum, n) => sum + n, 0)

    const discount = Math.min(orderDiscount, subtotal)
    const taxable = subtotal - discount
    const factor = subtotal > 0 ? taxable / subtotal : 1

    const lineTax =
      taxMode === 'NONE'
        ? 0
        : lines.reduce((sum, l, i) => sum + lineAmounts[i] * factor * (num(l.gstRate) / 100), 0)

    /*
     * Each charge is taxed at its own rate and is not discountable — the
     * mill's discount is negotiated on the goods, not on the transporter's
     * bill. Kept as rows so each one can be shown with its own GST.
     */
    const chargeRows = chargeTypes
      .map((t) => ({
        chargeTypeId: t.id,
        name: t.name,
        gstRate: num(t.defaultGstRate),
        amount: num(charges[t.id]),
      }))
      .map((c) => ({ ...c, tax: taxMode === 'NONE' ? 0 : c.amount * (c.gstRate / 100) }))

    const chargeTotal = chargeRows.reduce((sum, c) => sum + c.amount, 0)
    const chargeTax = chargeRows.reduce((sum, c) => sum + c.tax, 0)
    const tax = lineTax + chargeTax

    // No GST of its own, and added after tax — the way the old system had it.
    const other = num(otherCharges)

    const beforeRound = taxable + chargeTotal + tax + other
    const total = Math.round(beforeRound)

    /*
     * "Total discount" is every discount on the order added up, and "Gross
     * total" is what is left after them. Two rows that only make sense read in
     * that order, which is why the old form put them that way round.
     */
    const totalDiscount =
      lines.reduce((sum, l, i) => sum + lineGross[i] * (lineDiscountOf(l) / 100), 0) + discount

    return {
      lineAmounts,
      subtotal,
      discount,
      totalDiscount,
      grossTotal: taxable,
      taxable,
      chargeRows,
      chargeTotal,
      other,
      tax,
      roundOff: total - beforeRound,
      total,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, discountAmount, taxMode, poType, chargeTypes, charges, otherCharges])

  /**
   * The line being typed, priced as it is typed.
   *
   * Net price and Amount are shown beside Add so the buyer can check both
   * against the quotation in front of them before the line joins the order.
   * A rupee discount is held as rupees here and converted once, on Add.
   */
  const draft = useMemo(() => {
    const qty = num(pickQty)
    const rate = num(pickRate)
    const gross = qty * rate
    const typed = poType === 'ITEM_LEVEL' ? num(pickDiscount) : 0
    const discountValue =
      pickDiscountUnit === '%' ? (gross * typed) / 100 : Math.min(typed, gross)
    const amount = Math.max(gross - discountValue, 0)

    return {
      gross,
      discountValue,
      amount,
      netPrice: qty > 0 ? amount / qty : Math.max(rate - discountValue, 0),
      // The only shape a line can be stored in, so a rupee figure becomes the
      // percentage that produces the same amount.
      discountPct: gross > 0 ? Math.min((discountValue / gross) * 100, 100) : 0,
    }
  }, [pickQty, pickRate, pickDiscount, pickDiscountUnit, poType])

  /**
   * A selection that no longer matches the filters is dropped.
   *
   * A `<select>` whose value is not among its options renders blank while the
   * state still holds the old id — so the box looked empty and Add would have
   * put an item on the order that matched neither the code typed nor the
   * category chosen. Clearing it here covers every cause at once rather than
   * being remembered in three separate handlers.
   */
  useEffect(() => {
    if (pickItem && !visibleItems.some((i) => i.id === pickItem)) setPickItem('')
  }, [visibleItems, pickItem])

  /**
   * What the picker is still waiting for.
   *
   * The Add button used to be disabled with nothing to say why, which is the
   * same as being broken from where the clerk is sitting.
   */
  const pickedItem = pickItem ? (itemById.get(pickItem) ?? null) : null
  const alreadyOnOrder = Boolean(pickedItem && lines.some((l) => l.itemId === pickedItem.id))
  const typedCode = pickSearch.trim()
  const pickHint = !pickItem
    ? visibleItems.length === 0
      ? typedCode
        ? `No item matches “${typedCode}”. Check the code, or clear the box and choose a category.`
        : 'Nothing matches those filters. Choose a different category.'
      : null
    : alreadyOnOrder
      ? `${pickedItem?.name} is already on this order — change its quantity in the table below.`
      : num(pickQty) <= 0
        ? `Enter how much ${pickedItem?.name} you want, then press Add.`
        : !pickRate.trim()
          ? // Named separately from the quantity so the buyer is told which of
            // the two boxes is still empty, not merely that something is.
            `Enter the rate you are paying for ${pickedItem?.name}, then press Add.`
          : null

  if (!open || !mounted) return null

  const setLine = (index: number, patch: Partial<PoLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  /**
   * Puts the chosen item on the order.
   *
   * Rate and GST come across from the item master rather than being typed —
   * a rate typed from memory is the mistake the business rules exist to stop.
   * Both stay editable, because a quoted price is often not the standard one.
   */
  /**
   * Picking an item sets the category boxes to where that item is actually
   * filed.
   *
   * Otherwise the four fields sit there contradicting each other — a screen
   * reading "Category: All, Subcategory: None, Item: BOPP Tape" when the tape
   * is plainly filed under Packing Material. The boxes are one statement
   * about one item, so they are kept saying the same thing.
   */
  const selectItem = (itemId: string) => {
    setPickItem(itemId)
    setError(null)
    if (!itemId) return

    /*
     * The master's figures are offered, not imposed.
     *
     * A rate on file is the one agreed last time and is usually right, so it
     * saves typing. It is only a starting figure: a quoted price is often not
     * the standard one, and an item never bought before has nothing on file at
     * all — which is the case that made taking the rate from the master and
     * locking it the wrong answer.
     *
     * Only filled when the box is still empty, so a rate already typed is
     * never overwritten by changing the item in the dropdown.
     */
    const chosen = itemById.get(itemId)
    if (chosen?.standardRate != null && !pickRate.trim()) setPickRate(String(chosen.standardRate))
    if (chosen?.taxRate && !pickTaxPct.trim()) setPickTaxPct(String(chosen.taxRate.rate))

    const cat = categories.find((c) => c.id === itemById.get(itemId)?.categoryId)
    if (!cat) return

    if (cat.parentId) {
      setPickCategory(cat.parentId)
      setPickSubcategory(cat.id)
    } else {
      setPickCategory(cat.id)
      setPickSubcategory('')
    }
  }

  /**
   * The code box resolves an item rather than merely narrowing the list.
   *
   * Every item has one unique code and that code is its identity — it is what
   * is quoted on the phone and written on the rack. So typing one in full
   * picks that item outright, and the category boxes follow. Anything shorter
   * still narrows the dropdown, which is what you want while you are only
   * part way through remembering it.
   */
  const onCodeTyped = (raw: string) => {
    setPickSearch(raw)
    setError(null)

    const typed = raw.trim().toLowerCase()
    if (!typed) return

    const exact = items.find((i) => (i.code ?? '').toLowerCase() === typed)
    if (exact) selectItem(exact.id)
  }

  /** Enter on the code box takes the only match and moves to the quantity. */
  const onCodeEnter = () => {
    if (visibleItems.length === 1) selectItem(visibleItems[0].id)
    if (visibleItems.length <= 1) qtyRef.current?.focus()
  }

  const addLine = () => {
    const item = itemById.get(pickItem)
    if (!item) {
      setError('Choose an item before adding it.')
      return
    }
    if (num(pickQty) <= 0) {
      setError(`How much ${item.name} do you want? Enter a quantity above zero.`)
      return
    }

    // The same item twice is nearly always a slip, and two lines for it make
    // the order hard to check against the bill that follows. Say so and point
    // at the line that already exists rather than quietly making a second.
    if (lines.some((l) => l.itemId === item.id)) {
      setError(
        `${item.name} is already on this order. Change its quantity in the table below instead of adding it twice.`,
      )
      return
    }

    /*
     * A rate of zero is allowed by the API — some purchases genuinely are free
     * of charge — so nothing downstream would query a blank box. Asked for
     * here, because a blank on this form is far more likely to be a rate the
     * buyer has not got to yet than a gift.
     */
    if (!pickRate.trim()) {
      setError(`What rate are you paying for ${item.name}? Enter it, then press Add.`)
      return
    }

    setLines((prev) => [
      ...prev,
      {
        itemId: item.id,
        description: pickDescription.trim(),
        styleId: pickStyleId || null,
        qty: pickQty,
        unitRate: pickRate,
        // Held as a percentage whichever way it was typed — see `draft`.
        // Only an item-level order keeps one: on an order-level order the
        // single discount lives in the totals, and on a no-discount order
        // there is none to keep.
        discount: poType === 'ITEM_LEVEL' ? String(round2(draft.discountPct)) : '0',
        gstRate: pickTaxExempt || taxMode === 'NONE' ? '0' : pickTaxPct,
      },
    ])

    // The category filters stay put: the next line is usually from the same
    // place, and clearing them would make the clerk choose twice.
    setPickItem('')
    setPickDescription('')
    setPickQty('')
    setPickRate('')
    setPickDiscount('')
    // The tax rate, the exemption and the style stay put. A run of lines is
    // nearly always one style bought at one rate, and re-picking them per line
    // is how one line ends up wrong. A run of lines from one
    // supplier is nearly always taxed the same way, and re-picking it per line
    // is the kind of repetition that gets one line wrong.
    setError(null)
  }

  // poDate and deliveryDate are deliberately absent. The form no longer asks
  // for either, and omitting them rather than sending a value means a new
  // order takes today's date from the API, while editing an existing draft
  // leaves the date it already carries alone instead of overwriting it.
  /**
   * Sends files to storage, then tells the API they landed.
   *
   * The bytes go straight from this browser to the bucket on a one-use link
   * the API signs — they never pass through our server. One file at a time on
   * purpose: a mill connection that drops halfway should cost one file, and
   * the message should name it.
   */
  /** The three steps for one file against one order. */
  const uploadOne = async (file: File, orderId: string): Promise<Attachment> => {
    const signed = await api.post<{
      success: boolean
      data: { uploadUrl: string; storagePath: string }
    }>(`/purchase/orders/${orderId}/attachments/upload-url`, {
      fileName: file.name,
      sizeBytes: file.size,
    })

    // The token is in the URL's query string, which is the whole
    // authorisation. No header, and deliberately not our own API token.
    const put = await fetch(signed.data.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    if (!put.ok) {
      throw new Error(`${file.name} could not be sent. Check your connection and try again.`)
    }

    const saved = await api.post<{ success: boolean; data: Attachment }>(
      `/purchase/orders/${orderId}/attachments`,
      { fileName: file.name, storagePath: signed.data.storagePath },
    )
    return saved.data
  }

  /**
   * What the file box does.
   *
   * On an order that exists the file goes up straight away. On one being
   * written it is held instead, because a file needs something to belong to
   * and the order has no number yet — see `save`, which sends them the moment
   * it does.
   */
  const chooseFiles = (fileList: FileList | null) => {
    if (!fileList?.length) return
    const chosen = Array.from(fileList)

    const room = MAX_FILES - attachments.length - pendingFiles.length
    if (chosen.length > room) {
      setError(
        room === 0
          ? `This order already has ${MAX_FILES} files. Remove one before adding another.`
          : `Only ${room} more file${room === 1 ? '' : 's'} can be attached to this order.`,
      )
      return
    }

    const tooBig = chosen.find((f) => f.size > MAX_FILE_MB * 1024 * 1024)
    if (tooBig) {
      setError(
        `${tooBig.name} is ${(tooBig.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_FILE_MB}MB.`,
      )
      return
    }

    setError(null)
    if (record?.id) void uploadFiles(fileList)
    else setPendingFiles((prev) => [...prev, ...chosen])
  }

  const uploadFiles = async (fileList: FileList | null) => {
    if (!fileList?.length || !record?.id) return

    const chosen = Array.from(fileList)
    const room = MAX_FILES - attachments.length
    if (chosen.length > room) {
      setError(
        room === 0
          ? `This order already has ${MAX_FILES} files. Remove one before adding another.`
          : `Only ${room} more file${room === 1 ? '' : 's'} can be attached to this order.`,
      )
      return
    }

    setUploading(true)
    setError(null)

    try {
      for (const file of chosen) {
        if (file.size > MAX_FILE_MB * 1024 * 1024) {
          throw new Error(
            `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_FILE_MB}MB.`,
          )
        }

        const signed = await api.post<{
          success: boolean
          data: { uploadUrl: string; storagePath: string }
        }>(`/purchase/orders/${record.id}/attachments/upload-url`, {
          fileName: file.name,
          sizeBytes: file.size,
        })

        // Straight to storage. Not through lib/api, because this is not our
        // API and it must not carry our token.
        // The token is in the URL's query string, which is the whole
        // authorisation. No header, and deliberately not our own API token.
        const put = await fetch(signed.data.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        })
        if (!put.ok) {
          throw new Error(`${file.name} could not be sent. Check your connection and try again.`)
        }

        const saved = await api.post<{ success: boolean; data: Attachment }>(
          `/purchase/orders/${record.id}/attachments`,
          { fileName: file.name, storagePath: signed.data.storagePath },
        )
        setAttachments((prev) => [...prev, saved.data])
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not attach that file.',
      )
    } finally {
      setUploading(false)
    }
  }

  /** Links are signed on demand and expire, so one is fetched per click. */
  const openFile = async (id: string) => {
    try {
      const res = await api.get<{ success: boolean; data: { url: string } }>(
        `/purchase/attachments/${id}/link`,
      )
      window.open(res.data.url, '_blank', 'noopener')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that file.')
    }
  }

  const removeFile = async (file: Attachment) => {
    if (!confirm(`Remove ${file.fileName}?`)) return
    try {
      await api.delete(`/purchase/attachments/${file.id}`)
      setAttachments((prev) => prev.filter((f) => f.id !== file.id))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that file.')
    }
  }

  const payload = () => ({
    supplierId,
    poType,
    deliveryWarehouseId: deliverTo === 'CUSTOMER' ? null : warehouseId || null,
    deliveryCustomerId: deliverTo === 'CUSTOMER' ? deliveryCustomerId || null : null,
    enquiryNo: enquiryNo.trim() || null,
    enquiryDate: enquiryDate || null,
    reference: reference.trim() || null,
    remark: remark.trim() || null,
    // Only an order-level order has one. Sending whatever is in the box on an
    // item-level order would take the discount twice.
    discountAmount: poType === 'ORDER_LEVEL' ? num(discountAmount) : 0,
    // Only the kind and the amount. The GST rate is read off the charge type
    // on the server, so a rate corrected in the master since this form loaded
    // cannot be overridden from the browser.
    charges: totals.chargeRows
      .filter((c) => c.amount > 0)
      .map((c) => ({ chargeTypeId: c.chargeTypeId, amount: c.amount })),
    otherCharges: num(otherCharges),
    notes: notes.trim() || null,
    terms: terms.trim() || null,
    lines: lines.map((l) => ({
      itemId: l.itemId,
      description: (l.description as string)?.trim() || null,
      styleId: (l.styleId as string) || null,
      qty: num(l.qty),
      unitRate: num(l.unitRate),
      discount: lineDiscountOf(l),
      gstRate: num(l.gstRate),
    })),
  })

  /**
   * `mode` decides what happens after the order is written.
   *
   * Saving a draft stops there. Saving the order marks it sent, which is a
   * second call on purpose — the order exists either way, so if marking it
   * sent fails the work is not lost, it is a draft waiting to be sent.
   */
  const save = async (mode: 'draft' | 'send' | 'print') => {
    setSaving(mode)
    setError(null)

    try {
      let id = record?.id
      if (isEdit && record) {
        await api.patch(`/purchase/orders/${record.id}`, payload())
      } else {
        const res = await api.post<{ success: boolean; data: { id: string } }>(
          '/purchase/orders',
          payload(),
        )
        id = res.data.id
      }

      // Files chosen before the order existed. It has a number now, so they
      // have something to belong to.
      //
      // A failure here does not fail the save — the order is already written
      // and throwing it away over an attachment would be the worse outcome.
      // The names of whatever did not make it are reported instead, and they
      // can be added by reopening the order.
      if (pendingFiles.length && id) {
        const failed: string[] = []
        for (const file of pendingFiles) {
          try {
            await uploadOne(file, id)
          } catch {
            failed.push(file.name)
          }
        }
        setPendingFiles([])

        if (failed.length) {
          onSaved()
          setError(
            `The order was saved, but ${failed.length === 1 ? 'this file' : 'these files'} did not attach: ${failed.join(', ')}. Reopen the order to try again.`,
          )
          setSaving(null)
          return
        }
      }

      if (mode !== 'draft' && id) {
        try {
          await api.patch(`/purchase/orders/${id}/send`, {})
        } catch (err) {
          onSaved()
          setError(
            err instanceof ApiError
              ? `The order was saved, but marking it sent failed: ${err.message} It is waiting as a draft.`
              : 'The order was saved as a draft, but marking it sent failed.',
          )
          setSaving(null)
          return
        }
      }

      /*
       * Printing opens the sheet in a second tab rather than printing from
       * here. The print page is a route of its own that fetches the saved
       * order, so it can only show what was actually written — printing from
       * the form's own state could put a sheet in the supplier's hands that
       * does not match the order on the system.
       *
       * Opened before the form closes, while this click is still the reason
       * anything is happening: a popup blocker refuses a window that no
       * longer traces back to a user action.
       */
      if (mode === 'print' && id) {
        window.open(`/print/purchase-order/${id}`, '_blank', 'noopener')
      }

      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Is the API running?')
    } finally {
      setSaving(null)
    }
  }

  // Sent and still-to-send together: the limit is five files on the order,
  // not five of each.
  const fileCount = attachments.length + pendingFiles.length

  const incomplete = !supplierId || lines.length === 0
  const busy = saving !== null
  const orgAddress = [company?.address, company?.city, company?.pincode].filter(Boolean).join(', ')
  // Where the goods are actually going: the chosen warehouse, or our own
  // address when none is picked.
  const destination = warehouses.find((w) => w.id === warehouseId) ?? null

  /**
   * Rendered into `document.body` rather than where it sits in the page.
   *
   * `position: fixed` is only as good as its ancestors: a transform, a filter,
   * a backdrop-filter or a `contain` anywhere above it silently turns that
   * element into the containing block, and `inset-0` then means the corners of
   * *that* box rather than the corners of the screen. This form lives inside
   * the dashboard shell — sidebar, top bar, a padded main, an animated
   * wrapper — and any one of those acquiring such a property later would put a
   * band of undimmed page above the modal again, for a reason nobody would
   * think to look for.
   *
   * From the body there is nothing above it to get in the way.
   */
  return createPortal(
    /* The overlay stops where the sidebar ends, so the menu is neither dimmed
       nor covered and the app can still be navigated with the form open.
       Stopping short of it beats raising the sidebar above the overlay: on a
       narrower screen a sidebar sitting on top would clip the left edge of a
       centred form. On a phone the sidebar already takes most of the width, so
       there the overlay covers everything as before. */
    <div className="fixed inset-0 sm:left-[var(--sidebar-current-width)] z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-2 sm:p-3">
      {/* `h-full`, not `max-h-full` and not a vh figure.

          A cap only says how tall the card may not be. This form's content
          came out a little shorter than the screen, so the card hugged it and
          the leftover was split above and below as centring slack — about
          27px of dimmed page over the top, which is what kept coming back
          however the cap was tuned.

          Filling the height instead makes the margin the padding and nothing
          else, top and bottom, by construction rather than by arithmetic:
          8px on a phone, 12px on a desktop. The body scrolls inside, which it
          did already. */}
      <div
        className="glass-card w-full h-full max-h-full flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="po-dialog-title"
      >
        {/* Header — stays put while the body scrolls, so it is always clear what is being filled in */}
        <div className="shrink-0 flex items-start justify-between gap-4 px-4 py-3 border-b border-border">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
              <ShoppingCart size={18} className="text-primary" />
            </div>
            <div>
              <h2 id="po-dialog-title" className="text-lg font-semibold text-foreground">
                Purchase Order
              </h2>
              {/* The number moves down here rather than into the heading. The
                  heading says what the form is; the line under it says which
                  one and what may be done to it. */}
              <p className="text-xs text-muted-foreground mt-0.5">
                {isEdit
                  ? `${record?.poNumber} — only a draft order can be changed`
                  : 'New order to a supplier'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-2 shrink-0" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Body — the only thing that scrolls */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {error && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
              <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* 1 — What the order is, and who it is to.

              Two boxes on one row, the way the form has always been laid out:
              the order's own details on the left, the supplier on the right.
              The supplier is one field and gets a box of its own because that
              is where the clerk looks for it. */}
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-3 items-start">
            <Section icon={FileText} title="Basic details">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="form-label" htmlFor="po-location">
                    Location
                  </label>
                  <select
                    id="po-location"
                    ref={firstFieldRef}
                    className="form-input"
                    value={warehouseId}
                    onChange={(e) => setWarehouseId(e.target.value)}
                  >
                    <option value="">Head office</option>
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="form-label" htmlFor="po-enquiry-no">
                    Purchase enquiry no.
                  </label>
                  <input
                    id="po-enquiry-no"
                    className="form-input"
                    placeholder="Their quotation number"
                    value={enquiryNo}
                    onChange={(e) => setEnquiryNo(e.target.value)}
                  />
                </div>

                <div>
                  <label className="form-label" htmlFor="po-enquiry-date">
                    Enquiry date
                  </label>
                  <input
                    id="po-enquiry-date"
                    type="date"
                    className="form-input"
                    value={enquiryDate}
                    onChange={(e) => setEnquiryDate(e.target.value)}
                  />
                </div>

                <div>
                  <label className="form-label" htmlFor="po-reference">
                    Reference
                  </label>
                  <input
                    id="po-reference"
                    className="form-input"
                    placeholder="Job number, indent slip, anything to quote back"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="form-label" htmlFor="po-remark">
                    Remark
                  </label>
                  <input
                    id="po-remark"
                    className="form-input"
                    placeholder="Internal note, not printed on the order"
                    value={remark}
                    onChange={(e) => setRemark(e.target.value)}
                  />
                </div>
              </div>
            </Section>

            <Section icon={Building2} title="Supplier">
              <label className="form-label" htmlFor="po-supplier">
                Supplier<span className="text-red-400 ml-0.5">*</span>
              </label>
              <select
                id="po-supplier"
                className="form-input"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              >
                <option value="">Choose supplier</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code ? `${s.code} — ${s.name}` : s.name}
                  </option>
                ))}
              </select>
              {supplier && (
                <p className="text-xs text-muted-foreground mt-2">
                  {supplier.gstin ? (
                    <>
                      GSTIN {supplier.gstin} ·{' '}
                      {taxMode === 'CGST_SGST'
                        ? 'within the state, CGST + SGST'
                        : 'other state, IGST'}
                    </>
                  ) : (
                    'No GSTIN on file — this order will carry no GST'
                  )}
                </p>
              )}
            </Section>
          </div>

          {/* 2 — Choosing what goes on the order.

              Every box the old ERP had, in the order it had them. Rate is
              typed, not taken from the master and locked: a purchase order is
              often the first time an item is bought at all, so there is no
              rate on file to take. The master's rate is offered as the
              starting figure when there is one, and can be overtyped. */}
          <Section icon={Package} title="Select items from indent items">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h4 className="text-xs font-semibold text-foreground">Item &amp; description</h4>
              <div className="flex items-center gap-2">
                <label
                  className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                  htmlFor="po-type"
                >
                  Purchase order type
                </label>
                <select
                  id="po-type"
                  className="form-input w-auto"
                  value={poType}
                  onChange={(e) => setPoType(e.target.value as PoType)}
                >
                  <option value="ITEM_LEVEL">With discount at item level</option>
                  <option value="ORDER_LEVEL">With discount at order level</option>
                  <option value="NONE">Without discount</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              {poType === 'ITEM_LEVEL'
                ? 'A discount per line. Total discount in the box on the right adds them up.'
                : poType === 'ORDER_LEVEL'
                  ? 'One discount off the whole order — enter it as Total discount on the right. The per-line discount boxes are switched off.'
                  : 'No discount anywhere on this order. Both the per-line and the order-level boxes are switched off.'}
            </p>

            <div className="rounded-lg border border-border bg-background/40 p-3">
              <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                <div>
                  <label className="form-label" htmlFor="po-pick-cat">
                    Category
                  </label>
                  <select
                    id="po-pick-cat"
                    className="form-input"
                    value={pickCategory}
                    onChange={(e) => {
                      // The item is not cleared here. It is dropped by the
                      // effect above, and only if it does not belong under the
                      // category just chosen — so narrowing to the category an
                      // item is already in keeps it.
                      setPickCategory(e.target.value)
                      setPickSubcategory('')
                      setError(null)
                    }}
                  >
                    <option value="">All</option>
                    {topCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="form-label" htmlFor="po-pick-sub">
                    Subcategory
                  </label>
                  <select
                    id="po-pick-sub"
                    className="form-input"
                    value={pickSubcategory}
                    disabled={subCategories.length === 0}
                    onChange={(e) => {
                      setPickSubcategory(e.target.value)
                      setError(null)
                    }}
                  >
                    <option value="">{subCategories.length === 0 ? 'None' : 'All'}</option>
                    {subCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="form-label" htmlFor="po-pick-search">
                    Items code
                  </label>
                  {/* form-input on the wrapper rather than a hand-set height:
                      it is the same box as every other field and lines up with
                      them without a magic number. */}
                  <div className="form-input flex items-center gap-2">
                    <Search size={14} className="text-muted-foreground shrink-0" />
                    <input
                      id="po-pick-search"
                      className="bg-transparent border-0 outline-none text-sm flex-1 min-w-0 text-foreground placeholder:text-muted-foreground"
                      placeholder="Code"
                      value={pickSearch}
                      onChange={(e) => onCodeTyped(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          onCodeEnter()
                        }
                      }}
                    />
                  </div>
                </div>

                <div>
                  <label className="form-label" htmlFor="po-pick-item">
                    Items
                  </label>
                  <select
                    id="po-pick-item"
                    className="form-input"
                    value={pickItem}
                    onChange={(e) => selectItem(e.target.value)}
                  >
                    <option value="">
                      {visibleItems.length === 0 ? 'Nothing matches' : 'Select...'}
                    </option>
                    {/* The name alone. The code sits in the box to the left and
                        again in the table below, and repeating it here only
                        made the option too long to read. */}
                    {visibleItems.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="form-label" htmlFor="po-pick-style">
                    Style no.
                  </label>
                  {/* The style master, not a typed box. "SH-1042" and
                      "SH1042" typed into different orders would stop the
                      material ever reconciling against what was produced. */}
                  <select
                    id="po-pick-style"
                    className="form-input"
                    value={pickStyleId}
                    onChange={(e) => setPickStyleId(e.target.value)}
                  >
                    <option value="">None</option>
                    {styles.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.code ? `${st.code} — ${st.name}` : st.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mt-2">
                <div>
                  <label className="form-label" htmlFor="po-pick-qty">
                    Quantity
                  </label>
                  <input
                    id="po-pick-qty"
                    ref={qtyRef}
                    type="number"
                    step="0.001"
                    min={0}
                    className="form-input text-right"
                    placeholder="0"
                    value={pickQty}
                    onChange={(e) => setPickQty(e.target.value)}
                  />
                </div>

                <div>
                  <label className="form-label" htmlFor="po-pick-rate">
                    Rate
                  </label>
                  <input
                    id="po-pick-rate"
                    type="number"
                    step="0.01"
                    min={0}
                    className="form-input text-right"
                    placeholder="0.00"
                    value={pickRate}
                    onChange={(e) => setPickRate(e.target.value)}
                  />
                </div>

                <div>
                  <label className="form-label" htmlFor="po-pick-disc">
                    Discount
                  </label>
                  {/* Percent or rupees, as the old form allowed. A rupee
                      figure is converted to the equivalent percentage when the
                      line is added, because that is the only shape the line
                      can be stored in — the arithmetic is identical either
                      way, so nothing is lost. */}
                  <div className="flex gap-1.5">
                    <input
                      id="po-pick-disc"
                      type="number"
                      step="0.01"
                      min={0}
                      className="form-input text-right flex-1 min-w-0"
                      placeholder="0"
                      disabled={poType !== 'ITEM_LEVEL'}
                      value={poType === 'ITEM_LEVEL' ? pickDiscount : ''}
                      onChange={(e) => setPickDiscount(e.target.value)}
                    />
                    <select
                      className="form-input w-16 shrink-0"
                      aria-label="Discount in percent or rupees"
                      disabled={poType !== 'ITEM_LEVEL'}
                      value={pickDiscountUnit}
                      onChange={(e) => setPickDiscountUnit(e.target.value as '%' | 'INR')}
                    >
                      <option value="%">%</option>
                      <option value="INR">₹</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="form-label" htmlFor="po-pick-tax">
                    Tax value
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      id="po-pick-tax"
                      type="number"
                      step="0.01"
                      min={0}
                      max={100}
                      className="form-input text-right flex-1 min-w-0"
                      placeholder="0"
                      disabled={pickTaxExempt || taxMode === 'NONE'}
                      value={pickTaxExempt || taxMode === 'NONE' ? '' : pickTaxPct}
                      onChange={(e) => setPickTaxPct(e.target.value)}
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                  <label className="flex items-center gap-2 mt-1.5 text-xs text-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pickTaxExempt}
                      disabled={taxMode === 'NONE'}
                      onChange={(e) => setPickTaxExempt(e.target.checked)}
                    />
                    Is tax exempt
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end mt-2">
                <div className="md:col-span-6">
                  <label className="form-label" htmlFor="po-pick-desc">
                    Description
                  </label>
                  <input
                    id="po-pick-desc"
                    className="form-input"
                    placeholder="Printed under the item on the order"
                    value={pickDescription}
                    onChange={(e) => setPickDescription(e.target.value)}
                  />
                </div>

                {/* Worked out, not typed. Shown because the buyer checks these
                    two against the quotation before pressing Add. */}
                <div className="md:col-span-2">
                  <span className="form-label block">Net price</span>
                  <p className="text-sm tabular-nums text-foreground py-2">{inr(draft.netPrice)}</p>
                </div>

                <div className="md:col-span-2">
                  <span className="form-label block">Amount</span>
                  <p className="text-sm font-medium tabular-nums text-foreground py-2">
                    {inr(draft.amount)}
                  </p>
                </div>

                <div className="md:col-span-2">
                  <button
                    type="button"
                    className="btn-primary w-full justify-center"
                    onClick={addLine}
                    disabled={!pickItem || alreadyOnOrder}
                  >
                    <Plus size={15} /> Add
                  </button>
                </div>
              </div>

              {pickHint && <p className="text-xs text-amber-400 mt-2.5">{pickHint}</p>}
              <div className="mt-2.5">
                <NotBuiltNote>
                  Purchase indents are not built yet, so items come from the item list rather than
                  from an indent.
                </NotBuiltNote>
              </div>
            </div>
          </Section>

          {/* 3 — What is on the order so far. Every figure stays editable, so
              a slip is corrected in place rather than by removing the line and
              entering it again. */}
          <Section
            icon={ListChecks}
            title="Items added"
            hint={lines.length ? `${lines.length} on this order` : undefined}
          >
            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground px-1 py-2">
                Nothing on this order yet. Pick an item above, enter a quantity and rate, and press
                Add.
              </p>
            ) : (
              <div className="overflow-x-auto border border-border rounded-lg">
                <table className="w-full text-sm min-w-[1040px]">
                  <thead>
                    <tr className="border-b border-border bg-secondary/40">
                      {['Item code', 'Item', 'Description', 'Style no.', 'Qty', 'Rate', 'Disc %', 'Tax %', 'Amount', ''].map(
                        (h, i) => (
                          <th
                            key={h || i}
                            className={`text-[10px] uppercase tracking-wider text-muted-foreground py-2 px-3 ${
                              ['Qty', 'Rate', 'Disc %', 'Tax %', 'Amount'].includes(h)
                                ? 'text-right'
                                : 'text-left'
                            }`}
                          >
                            {h}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, i) => {
                      const item = itemById.get(line.itemId)
                      return (
                        <tr
                          key={`${line.itemId}-${i}`}
                          className="border-b border-border/50 last:border-0"
                        >
                          <td className="py-2 px-3 font-mono text-xs text-teal-400 whitespace-nowrap">
                            {item?.code ?? '—'}
                          </td>
                          <td className="py-2 px-3 min-w-[160px]">
                            <div className="font-medium text-foreground">{item?.name ?? 'Item'}</div>
                            {item?.hsnCode && (
                              <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                                HSN {item.hsnCode}
                              </p>
                            )}
                          </td>
                          <td className="py-2 px-3 min-w-[160px]">
                            <input
                              className="form-input h-8"
                              placeholder="Optional"
                              value={(line.description as string) ?? ''}
                              onChange={(e) => setLine(i, { description: e.target.value })}
                              aria-label={`Line ${i + 1} description`}
                            />
                          </td>
                          <td className="py-2 px-3 w-40">
                            <select
                              className="form-input h-9"
                              value={(line.styleId as string) ?? ''}
                              onChange={(e) => setLine(i, { styleId: e.target.value })}
                              aria-label={`Line ${i + 1} style`}
                            >
                              <option value="">None</option>
                              {styles.map((st) => (
                                <option key={st.id} value={st.id}>
                                  {st.code ?? st.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-3 w-24">
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
                          <td className="py-2 px-3 w-24">
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
                              disabled={poType !== 'ITEM_LEVEL'}
                              value={poType === 'ITEM_LEVEL' ? String(line.discount) : ''}
                              onChange={(e) => setLine(i, { discount: e.target.value })}
                              aria-label={`Line ${i + 1} discount percent`}
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
                              aria-label={`Line ${i + 1} tax percent`}
                            />
                          </td>
                          <td className="py-2 px-3 text-right font-medium tabular-nums w-28">
                            {inr(totals.lineAmounts[i] ?? 0)}
                          </td>
                          <td className="py-2 px-3 w-12">
                            <button
                              type="button"
                              onClick={() => setLines((p) => p.filter((_, x) => x !== i))}
                              className="btn-ghost p-1 text-muted-foreground hover:text-red-400"
                              aria-label={`Remove ${item?.name ?? 'line'}`}
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
            )}
          </Section>

          {/* 4 — Where it goes, what is attached, and what it comes to.

              One row, two boxes: the delivery and its files on the left, the
              calculation on the right — the arrangement the form has always
              had, and the one the clerk checks left to right before saving. */}
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_460px] gap-3 items-start">
            <Section icon={Truck} title="Attachments and deliver to">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-foreground">Attachments</h4>

                  {/* One box whether or not the order exists yet. On a new
                      order the files are held and go up the moment it is saved,
                      so nobody has to save, reopen and come back for them. */}
                  <div className="space-y-2">
                    <label
                      className={`flex items-center justify-between gap-2 rounded-lg border border-border bg-background/40 px-3 py-2 ${
                        uploading || fileCount >= MAX_FILES
                          ? 'opacity-70 cursor-not-allowed'
                          : 'cursor-pointer hover:border-teal-500/40'
                      }`}
                    >
                      <span className="flex items-center gap-2 text-sm text-foreground">
                        {uploading ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Paperclip size={14} />
                        )}
                        {uploading ? 'Sending...' : 'Choose files'}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {fileCount}/{MAX_FILES} · {MAX_FILE_MB}MB each
                      </span>
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        disabled={uploading || fileCount >= MAX_FILES}
                        onChange={(e) => {
                          chooseFiles(e.target.files)
                          e.target.value = ''
                        }}
                      />
                    </label>

                    {fileCount === 0 ? (
                      <p className="text-xs text-muted-foreground">Nothing attached yet.</p>
                    ) : (
                      <ul className="space-y-1">
                        {attachments.map((f) => (
                          <li
                            key={f.id}
                            className="flex items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-1.5"
                          >
                            <Paperclip size={13} className="text-muted-foreground shrink-0" />
                            <button
                              type="button"
                              className="text-sm text-primary underline truncate text-left flex-1 min-w-0"
                              onClick={() => void openFile(f.id)}
                              title={`Open ${f.fileName}`}
                            >
                              {f.fileName}
                            </button>
                            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                              {(f.sizeBytes / 1024).toFixed(0)} KB
                            </span>
                            <button
                              type="button"
                              className="btn-ghost p-1 text-muted-foreground hover:text-red-400"
                              onClick={() => void removeFile(f)}
                              aria-label={`Remove ${f.fileName}`}
                            >
                              <Trash2 size={13} />
                            </button>
                          </li>
                        ))}

                        {/* Chosen but not yet sent. Marked so nobody believes a
                            file is safely filed before the order is saved. */}
                        {pendingFiles.map((f, i) => (
                          <li
                            key={`pending-${f.name}-${i}`}
                            className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-background/40 px-3 py-1.5"
                          >
                            <Paperclip size={13} className="text-muted-foreground shrink-0" />
                            <span className="text-sm text-foreground truncate flex-1 min-w-0">
                              {f.name}
                            </span>
                            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                              {(f.size / 1024).toFixed(0)} KB · on save
                            </span>
                            <button
                              type="button"
                              className="btn-ghost p-1 text-muted-foreground hover:text-red-400"
                              onClick={() =>
                                setPendingFiles((prev) => prev.filter((_, x) => x !== i))
                              }
                              aria-label={`Remove ${f.name}`}
                            >
                              <Trash2 size={13} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-foreground">Deliver to</h4>
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                      <input
                        type="radio"
                        name="po-deliver-to"
                        checked={deliverTo === 'ORGANIZATION'}
                        onChange={() => setDeliverTo('ORGANIZATION')}
                      />
                      Organization
                    </label>
                    <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                      <input
                        type="radio"
                        name="po-deliver-to"
                        checked={deliverTo === 'CUSTOMER'}
                        onChange={() => setDeliverTo('CUSTOMER')}
                      />
                      Customer
                    </label>
                  </div>

                  {deliverTo === 'CUSTOMER' ? (
                    <>
                      <select
                        className="form-input"
                        value={deliveryCustomerId}
                        onChange={(e) => setDeliveryCustomerId(e.target.value)}
                        aria-label="Deliver to customer"
                      >
                        <option value="">Choose customer</option>
                        {customers.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code ? `${c.code} — ${c.name}` : c.name}
                          </option>
                        ))}
                      </select>

                      {deliveryCustomer && (
                        <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
                          <p className="text-sm font-medium text-foreground">
                            {deliveryCustomer.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {customerAddress || 'No address on this customer.'}
                          </p>
                          {/* The tax follows the goods, so a customer in another
                              state changes what the supplier may charge. Said
                              here rather than discovered on their bill. */}
                          {customerStateCode && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Delivered in state {customerStateCode} —{' '}
                              {supplier
                                ? taxMode === 'CGST_SGST'
                                  ? 'same state as the supplier, so CGST + SGST'
                                  : 'a different state from the supplier, so IGST'
                                : 'choose a supplier to see the tax split'}
                            </p>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    /* Shown, not repeated. An order has one destination, so a
                       second dropdown for it here would only mirror the Location
                       field above — change one and the other moves, which reads
                       as two settings that disagree. */
                    <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
                      <p className="text-sm font-medium text-foreground">
                        {destination?.name ?? company?.name ?? 'Your company'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {destination?.address ||
                          orgAddress ||
                          'Address not set — add it in Settings → Company.'}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Somewhere else? Change{' '}
                        <button
                          type="button"
                          className="text-primary underline"
                          onClick={() => document.getElementById('po-location')?.focus()}
                        >
                          Location
                        </button>{' '}
                        above.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </Section>


            {/* The calculation, beside the delivery box as the old ERP had it.

                Every row it had, in its order. The five named charge rows and
                Other charges are switched off, and that is not a design
                choice: a purchase *order* has no columns to keep them in. In
                this database charges hang off the *bill*
                (`PurchaseInvoiceCharge` against a `ChargeType`), so a box here
                that accepted a figure would show it in the Total and then drop
                it on save — the clerk would send a supplier an order for one
                amount and find another on the system. Putting them on the
                order needs a migration; see the note under the box. */}
            <Section icon={Calculator} title="Totals">
              <div className="space-y-1.5 text-sm">
                {/* Where the discount sits follows the dropdown at the top of
                    the items box. On an item-level order this is the sum of
                    the per-line discounts and cannot be typed into; on an
                    order-level order it is the one figure taken off the whole
                    order, and the per-line boxes are the ones switched off. */}
                {poType === 'ORDER_LEVEL' ? (
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="po-discount" className="text-muted-foreground">
                      Total discount
                    </label>
                    <input
                      id="po-discount"
                      type="number"
                      step="0.01"
                      min={0}
                      className="form-input h-8 w-28 text-right"
                      placeholder="0.00"
                      value={discountAmount}
                      onChange={(e) => setDiscountAmount(e.target.value)}
                    />
                  </div>
                ) : (
                  <Row label="Total discount" value={totals.totalDiscount} />
                )}

                <Row label="Gross total" value={totals.grossTotal} />

                {/* One row per charge the mill uses on purchases, taken from
                    the charge master rather than written into this form. Add a
                    charge there and a row appears here; change its GST rate
                    there and this follows. */}
                {chargeTypes.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-1">
                    No purchase charges are set up yet — add them under{' '}
                    <a
                      href="/masters/charges"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline"
                    >
                      Masters → Charges
                    </a>
                    .
                  </p>
                ) : (
                  <div className="space-y-1.5 pt-0.5">
                    {totals.chargeRows.map((c) => (
                      <div key={c.chargeTypeId} className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">
                          {c.name} @{c.gstRate}%
                        </span>
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          className="form-input h-8 w-28 text-right"
                          placeholder="0.00"
                          value={charges[c.chargeTypeId] ?? ''}
                          onChange={(e) =>
                            setCharges((prev) => ({ ...prev, [c.chargeTypeId]: e.target.value }))
                          }
                          aria-label={`${c.name} amount`}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {taxMode === 'CGST_SGST' && (
                  <>
                    <Row label="SGST" value={totals.tax / 2} />
                    <Row label="CGST" value={totals.tax / 2} />
                  </>
                )}
                {/* Not SGST + CGST when the goods cross a state line. The
                    split follows the place of supply, and showing two halves
                    of a tax the supplier cannot charge would misstate the
                    order, so this row says what it really is. */}
                {taxMode === 'IGST' && <Row label="IGST" value={totals.tax} />}
                {taxMode === 'NONE' && (
                  <p className="text-xs text-muted-foreground py-1">
                    No GST — this supplier is not registered.
                  </p>
                )}
                {taxMode === null && (
                  <>
                    <Row label="SGST" value={0} />
                    <Row label="CGST" value={0} />
                  </>
                )}

                <Row label="Total tax" value={totals.tax} />

                {/* Carries no GST of its own and is added after tax, which is
                    how the mill's old system had it. */}
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="po-other-charges" className="text-muted-foreground">
                    Other charges
                  </label>
                  <input
                    id="po-other-charges"
                    type="number"
                    step="0.01"
                    min={0}
                    className="form-input h-8 w-28 text-right"
                    placeholder="0.00"
                    value={otherCharges}
                    onChange={(e) => setOtherCharges(e.target.value)}
                  />
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <span className="font-semibold text-foreground">Total</span>
                  <span className="font-semibold text-foreground tabular-nums text-lg">
                    ₹{inr(totals.total)}
                  </span>
                </div>

                {taxMode === null && (
                  <p className="text-xs text-muted-foreground pt-1">
                    Choose a supplier to see whether the tax splits into SGST + CGST or is IGST.
                  </p>
                )}
              </div>
            </Section>
          </div>

          {/* 5 — What the order says, and how it goes out. Template and email
              share one row: neither does anything yet, so a column each was
              height spent on two switched-off controls. */}
          <Section icon={ScrollText} title="Terms, notes and sending">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-foreground">Terms and conditions</h4>
                <textarea
                  rows={3}
                  className="form-input"
                  placeholder="Leave blank to use the terms set in Settings → Documents"
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  aria-label="Terms and conditions"
                />
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-foreground">Notes</h4>
                <textarea
                  rows={3}
                  className="form-input"
                  placeholder="Printed on the order the supplier receives"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  aria-label="Notes"
                />
              </div>
            </div>

            <div className="mt-3 space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* A real link, not a greyed box. The wording, the title and
                    which blocks print are all editable — under Settings →
                    Documents, per document type. Showing this as "not built"
                    was wrong: it is built, it just does not live here. */}
                <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/40 px-3 py-2">
                  <span className="text-sm text-foreground">Template: Standard</span>
                  <a
                    href="/settings/documents"
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline"
                  >
                    Edit
                  </a>
                </div>
                <Faded>
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-2">
                    <input type="checkbox" checked readOnly />
                    <span className="text-sm text-foreground truncate">
                      {company?.email ?? 'accounts@example.com'}
                    </span>
                  </div>
                </Faded>
              </div>
              <NotBuiltNote>
                Emailing the order is not built yet — print it and send it yourself. There is one
                template per document type, so there is nothing to choose here; Edit opens the
                wording and the printed blocks in Settings.
              </NotBuiltNote>
            </div>
          </Section>
        </div>

        {/* Footer — stays put, so Save never has to be hunted for at the bottom of a long form */}
        <div className="shrink-0 flex flex-wrap items-center justify-end gap-3 px-4 py-3 border-t border-border">
          {incomplete && (
            <p className="text-xs text-muted-foreground mr-auto">
              {!supplierId ? 'Choose a supplier' : 'Add at least one item'} to save this order.
            </p>
          )}
          <button type="button" onClick={onClose} className="btn-secondary" disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save('draft')}
            className="btn-secondary"
            disabled={busy || incomplete}
          >
            {saving === 'draft' && <Loader2 size={15} className="animate-spin" />}
            Save as draft
          </button>
          <button
            type="button"
            onClick={() => void save('print')}
            className="btn-secondary"
            disabled={busy || incomplete}
          >
            {saving === 'print' ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Printer size={15} />
            )}
            Save and print
          </button>
          <button
            type="button"
            onClick={() => void save('send')}
            className="btn-primary"
            disabled={busy || incomplete}
          >
            {saving === 'send' && <Loader2 size={15} className="animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
