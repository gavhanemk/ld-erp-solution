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
  /** The style number as it was typed. */
  styleNo?: string | null
  /** The master style that text turned out to be, when it matched one. */
  styleId?: string | null
  qty: number | string
  unitRate: number | string
  discount: number | string
  gstRate: number | string
  /** Priced by the API. Absent on a line the form is still building. */
  amount?: number | string
  /**
   * Whether `discount` is a percentage or a number of rupees.
   *
   * Browser only. A stored line keeps a percentage, so a rupee figure is
   * converted on save — against the quantity and rate *as they are then*,
   * which is why what was typed is kept rather than converted on entry. Change
   * the quantity after typing ₹200 off and it is still ₹200.
   */
  discountUnit?: '%' | 'INR'
  /*
   * The four below never leave the browser. They are how one row remembers
   * what it is in the middle of choosing: which category is narrowing its item
   * dropdown, and what has been typed into its code box before it matches
   * anything. Stripped in `payload`.
   */
  categoryId?: string
  subcategoryId?: string
  codeText?: string
  /** Sent back by the API on a saved line, so the row can reopen showing it. */
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

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const inr = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** One boxed group. Every section is the same shape so the form reads as a list of steps. */
/**
 * One width per column of the item table, read by both the header and the rows.
 *
 * The table is `w-full table-fixed`, so it always fills the box it is in and
 * the header row's widths are what decide the layout. A row cell that quietly
 * disagreed with its header would be a trap for whoever edits this next, so
 * both sides read from here.
 *
 * Item and Description are blank on purpose. Under a fixed layout the columns
 * that declare no width of their own share out whatever is left over, so those
 * two stretch to fill a wide screen instead of leaving a band of white space
 * to the right of Amount. They are also the two that earn it: a free-typed
 * description and a full item name are the only cells holding a sentence, the
 * rest being a figure or a short code that gains nothing from being wider.
 *
 * The table's `min-w` below is the sum of the fixed widths plus a workable
 * share for those two, so a narrow screen scrolls sideways rather than
 * crushing thirteen columns into whatever it has.
 */
const COL = {
  code: 'w-32',
  item: '',
  category: 'w-36',
  subcategory: 'w-36',
  style: 'w-32',
  description: '',
  qty: 'w-20',
  rate: 'w-24',
  discount: 'w-32',
  tax: 'w-20',
  netPrice: 'w-28',
  amount: 'w-36',
  remove: 'w-10',
} as const

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
  /// The date on the order. Asked for now, so a back-dated order lands in the
  /// right month rather than always taking today.
  const [poDate, setPoDate] = useState('')
  /// The next number, previewed. Read-only: it is allocated by the server when
  /// the order is written, because two people filling this form at once must
  /// not be shown the same number as though it were theirs.
  const [nextPoNumber, setNextPoNumber] = useState('')
  const [reference, setReference] = useState('')
  /// Internal. Unlike `notes` it is not printed on the supplier's copy, which
  /// is the whole reason the two are separate fields.
  const [remark, setRemark] = useState('')
  const [deliverTo, setDeliverTo] = useState<'ORGANIZATION' | 'CUSTOMER'>('ORGANIZATION')
  const [deliveryCustomerId, setDeliveryCustomerId] = useState('')
  const [discountAmount, setDiscountAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState('')

  /*
   * What has been typed against each kind of charge, keyed by charge type id.
   *
   * A map rather than a list because the rows are the charge master's rows —
   * the form does not decide which charges exist, Masters → Charges does.
   */
  const [charges, setCharges] = useState<Record<string, string>>({})
  const [otherCharges, setOtherCharges] = useState('')

  /*
   * The order's lines. Each carries its own item, its own category narrowing
   * and its own figures, because the table is where a line is both entered and
   * corrected now.
   */
  const [lines, setLines] = useState<PoLine[]>([])
  // Nothing about the item picker is held here any more — see `blankLine`.
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Files chosen on a new order, held here until it has a number to hang them
  // on. They go up the moment it is saved.
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)

  const [saving, setSaving] = useState<'draft' | 'send' | 'print' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const firstFieldRef = useRef<HTMLSelectElement | null>(null)

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
    setPoDate(record?.poDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10))
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
      record?.lines?.length
        ? record.lines.map((l) => {
            const cat = categories.find((c) => c.id === l.item?.category?.id)
            return {
              itemId: l.itemId,
              codeText: l.item?.code ?? '',
              // Reopened at the level the item is actually filed under, so the
              // two dropdowns agree with the item beside them.
              categoryId: cat?.parentId ?? cat?.id ?? '',
              subcategoryId: cat?.parentId ? cat.id : '',
              description: l.description ?? '',
              // Falls back to the linked style's code for lines written before
              // this column existed, so an older order reopens showing its
              // style rather than an empty box.
              styleNo: l.styleNo ?? l.style?.code ?? '',
              styleId: l.styleId ?? '',
              qty: String(l.qty),
              unitRate: String(l.unitRate),
              // A stored line holds a percentage, so it reopens as one.
              discount: String(l.discount ?? 0),
              discountUnit: '%' as const,
              gstRate: String(l.gstRate ?? ''),
            }
          })
        : // Always one row to type into. An empty table has nowhere to start.
          [blankLine()],
    )
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
      /*
       * What the next purchase order number will be, for the read-only box.
       *
       * Settings is the only place that knows, and a purchase clerk may not be
       * allowed in there — so a refusal costs the preview, not the form. The
       * real number is allocated by the server on save either way.
       */
      api
        .get<{ success: boolean; data: { docType: string; nextNumber: string }[] }>(
          '/settings/number-series',
        )
        .catch(() => null),
    ]).then(([s, i, w, cust, c, st, ct, co, ns]) => {
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
      setNextPoNumber(ns?.data.find((x) => x.docType === 'PO')?.nextNumber ?? '')
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

  /**
   * Everything about finding an item now lives on the row it belongs to.
   *
   * There used to be a form above the table holding a category, a subcategory,
   * a code box and an item dropdown, and then the same item appeared again as
   * a row below it. Two sets of controls for one line, and roughly 180px of
   * height spent saying the same thing twice. The row is the only place now.
   */
  const topCategories = useMemo(() => categories.filter((c) => !c.parentId), [categories])

  /** The children of one category, for that row's second dropdown. */
  const subCategoriesOf = (categoryId?: string | null) =>
    categoryId ? categories.filter((c) => c.parentId === categoryId) : []

  /**
   * The items one row may choose from, narrowed by whichever category level
   * that row has picked. Narrowing is per row on purpose: a fabric line and a
   * button line sit on the same order and were never looking at the same list.
   */
  const itemsFor = (line: PoLine) => {
    const childIds = new Set(subCategoriesOf(line.categoryId).map((c) => c.id))
    const inCategory = items.filter((it) => {
      if (line.subcategoryId) return it.categoryId === line.subcategoryId
      if (line.categoryId) {
        return it.categoryId === line.categoryId || childIds.has(it.categoryId ?? '')
      }
      return true
    })

    /*
     * A half-typed code narrows the list as well.
     *
     * Only while the row has no item yet. Once one is chosen the code box
     * holds that item's exact code, and narrowing by it would leave the Item
     * dropdown with a single option — so changing your mind about the item
     * would mean clearing the code box first.
     */
    const typed = (line.codeText ?? '').trim().toLowerCase()
    if (line.itemId || !typed) return inCategory

    return inCategory.filter(
      (it) =>
        (it.code ?? '').toLowerCase().includes(typed) || it.name.toLowerCase().includes(typed),
    )
  }

  /** A fresh, empty row. The table always has at least one. */
  const blankLine = (): PoLine => ({
    itemId: '',
    codeText: '',
    categoryId: '',
    subcategoryId: '',
    description: '',
    styleNo: '',
    styleId: '',
    qty: '',
    unitRate: '',
    discount: '0',
    discountUnit: '%',
    gstRate: '',
  })

  /** Rows that have an item on them. A blank row is not part of the order. */
  const activeLines = lines.filter((l) => l.itemId)

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
  const lineDiscountOf = (l: PoLine) => {
    if (poType !== 'ITEM_LEVEL') return 0
    const typed = num(l.discount)
    if ((l.discountUnit ?? '%') === '%') return Math.min(typed, 100)
    // Rupees. Capped at the line's own value, so a discount cannot take a line
    // below nothing.
    const gross = num(l.qty) * num(l.unitRate)
    return gross > 0 ? Math.min((typed / gross) * 100, 100) : 0
  }
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

  /** One row's own figures, worked out for the row it is shown in. */
  const priceOf = (l: PoLine) => {
    const qty = num(l.qty)
    const gross = qty * num(l.unitRate)
    const amount = gross * (1 - lineDiscountOf(l) / 100)
    return { gross, amount, netPrice: qty > 0 ? amount / qty : 0 }
  }

  /**
   * Rows that carry an item but are not finished.
   *
   * Checked at save rather than as you type, so a buyer can put every item on
   * the order first and work down the columns afterwards — which is how a
   * quotation is read. Each row is named and its empty cell is outlined, so on
   * a long order "which one" is never a hunt.
   */
  const unfinished = activeLines
    .map((l) => ({
      name: itemById.get(l.itemId)?.name ?? 'A line',
      noQty: num(l.qty) <= 0,
      noRate: String(l.unitRate).trim() === '',
    }))
    .filter((r) => r.noQty || r.noRate)

  if (!open || !mounted) return null

  const setLine = (index: number, patch: Partial<PoLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  /**
   * Puts an item on one row.
   *
   * The master's rate and GST are offered rather than imposed: the rate on
   * file is the one agreed last time and usually right, but a quoted price is
   * often not the standard one and an item never bought before has nothing on
   * file at all. Only filled when the cell is still empty, so a figure already
   * typed is never overwritten by changing the item.
   *
   * The category cells follow the item to wherever it is actually filed,
   * otherwise the row sits there contradicting itself — "Category: Fabric,
   * Item: BOPP Tape" when the tape is plainly under Packing Material.
   */
  const pickItemFor = (index: number, itemId: string) => {
    setError(null)

    if (!itemId) {
      setLine(index, { itemId: '', codeText: '' })
      return
    }

    // The same item twice makes the order hard to check against the bill that
    // follows, and is nearly always a slip.
    if (lines.some((l, i) => i !== index && l.itemId === itemId)) {
      const clash = itemById.get(itemId)
      setError(
        `${clash?.name ?? 'That item'} is already on another row. Change the quantity there instead of adding it twice.`,
      )
      return
    }

    const item = itemById.get(itemId)
    const cat = categories.find((c) => c.id === item?.categoryId)
    const line = lines[index]

    setLine(index, {
      itemId,
      codeText: item?.code ?? '',
      ...(cat
        ? cat.parentId
          ? { categoryId: cat.parentId, subcategoryId: cat.id }
          : { categoryId: cat.id, subcategoryId: '' }
        : {}),
      ...(item?.standardRate != null && String(line.unitRate).trim() === ''
        ? { unitRate: String(item.standardRate) }
        : {}),
      ...(item?.taxRate && String(line.gstRate).trim() === ''
        ? { gstRate: String(item.taxRate.rate) }
        : {}),
    })
  }

  /**
   * The code cell resolves an item rather than merely narrowing the list.
   *
   * Every item has one unique code and that code is its identity — it is what
   * is quoted on the phone and written on the rack. Typing one in full picks
   * that item outright. Anything shorter is left alone, because it is a code
   * half remembered, not a mistake.
   */
  const typeCodeFor = (index: number, raw: string) => {
    setLine(index, { codeText: raw })
    setError(null)

    const typed = raw.trim().toLowerCase()
    if (!typed) return

    const exact = items.find((i) => (i.code ?? '').toLowerCase() === typed)
    if (exact) pickItemFor(index, exact.id)
  }

  /**
   * The style cell keeps what was typed and links it when it can.
   *
   * `styleNo` is always whatever is in the box. `styleId` is set only on an
   * exact match against a style's code, and cleared the moment the text stops
   * matching — a stale link to the style the text used to be would quietly
   * reconcile this material against the wrong garment.
   */
  const typeStyleFor = (index: number, raw: string) => {
    const typed = raw.trim().toLowerCase()
    const match = typed ? styles.find((st) => (st.code ?? '').toLowerCase() === typed) : undefined
    setLine(index, { styleNo: raw, styleId: match?.id ?? '' })
  }

  const addRow = () => {
    setLines((prev) => [...prev, blankLine()])
    setError(null)
  }

  /**
   * Removing the last row leaves a blank one behind rather than an empty
   * table: there is nowhere to start typing otherwise, and "add a row" would
   * be a second thing to discover before any work could be done.
   */
  const removeRow = (index: number) =>
    setLines((prev) => {
      const left = prev.filter((_, i) => i !== index)
      return left.length ? left : [blankLine()]
    })

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
    poDate: poDate || undefined,
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
    /*
     * Only rows that have an item, and only the fields the API knows about.
     * The category narrowing and the code box are how a row found its item;
     * they are not part of the order and are dropped here.
     */
    lines: activeLines.map((l) => ({
      itemId: l.itemId,
      description: (l.description as string)?.trim() || null,
      styleNo: (l.styleNo as string)?.trim() || null,
      styleId: (l.styleId as string) || null,
      qty: num(l.qty),
      unitRate: num(l.unitRate),
      // A percentage whichever unit it was typed in — see `lineDiscountOf`.
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

  const incomplete = !supplierId || activeLines.length === 0 || unfinished.length > 0
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

          {/* 1 — What the order is and who it is to.

              Six fields, two rows of three, in the order the mill reads them:
              where it is going and which order this is, then who it is from
              and what to quote back. The supplier sits in here rather than in
              a box of its own — it is one dropdown, and a box to itself left a
              column of empty space beside it. */}
          <Section icon={FileText} title="Basic details">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
                <label className="form-label" htmlFor="po-number">
                  Purchase order
                </label>
                {/* Read-only on purpose. The number comes from the counter in
                    Settings → Company when the order is written, so that two
                    clerks filling this form at the same moment cannot both be
                    handed the same one. What is shown on a new order is a
                    preview of what is next, not a reservation. */}
                <input
                  id="po-number"
                  className="form-input font-mono"
                  value={isEdit ? (record?.poNumber ?? '') : nextPoNumber}
                  readOnly
                  placeholder="Allocated on save"
                  aria-describedby={isEdit ? undefined : 'po-number-note'}
                />
                {!isEdit && (
                  <p id="po-number-note" className="text-xs text-muted-foreground mt-1">
                    Allocated when you save.
                  </p>
                )}
              </div>

              <div>
                <label className="form-label" htmlFor="po-date">
                  Date
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
                  <p className="text-xs text-muted-foreground mt-1">
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

              <div>
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

          {/* 2 — The order's lines, entered where they are shown.

              One table, not a form above a table. Every field a line has is a
              column in it, and a row is typed left to right; "+ Add item row"
              puts a fresh one underneath. There used to be two sets of the
              same ten controls — one to enter a line, one to correct it — and
              about 180px of height spent saying everything twice.

              There are thirteen columns, so the table scrolls sideways and the
              two that say *which* line this is stay pinned to the left edge.
              Scrolled to the far right you can still see you are on the poplin
              and not the buttons. */}
          <Section icon={Package} title="Items" hint={`${activeLines.length} on this order`}>
            {/* Lost when this section was rebuilt as one table, which left the
                discount mode stuck on whatever the order opened with and no
                way to change it. It belongs above the grid: it decides which
                discount cells are live, so it is chosen before any figure is
                typed into them. */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
              <p className="text-xs text-muted-foreground">
                {poType === 'ITEM_LEVEL'
                  ? 'A discount per line, in the Discount column — percent or rupees.'
                  : poType === 'ORDER_LEVEL'
                    ? 'One discount off the whole order, entered as Total discount on the right. The per-line Discount cells are switched off.'
                    : 'No discount on this order. Both the per-line cells and the order-level box are switched off.'}
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <label
                  htmlFor="po-type"
                  className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  Purchase order type
                </label>
                <select
                  id="po-type"
                  className="form-input h-8 w-auto px-2 text-xs"
                  value={poType}
                  onChange={(e) => setPoType(e.target.value as PoType)}
                >
                  <option value="ITEM_LEVEL">With discount at item level</option>
                  <option value="ORDER_LEVEL">With discount at order level</option>
                  <option value="NONE">Without discount</option>
                </select>
              </div>
            </div>

            {/* One list for every row — unlike items, styles are not narrowed
                by anything, so there is no reason to repeat it per row. */}
            <datalist id="po-style-codes">
              {styles.map((st) => (
                <option key={st.id} value={st.code ?? st.name} label={st.name} />
              ))}
            </datalist>

            <div className="overflow-x-auto border border-border rounded-lg bg-card">
              <table className="w-full table-fixed min-w-[1590px] text-sm border-collapse">
                <thead>
                  <tr className="bg-secondary">
                    {[
                      ['Item code', `${COL.code} sticky left-0 z-20 bg-secondary`, 'left'],
                      ['Item', `${COL.item} sticky left-32 z-20 bg-secondary`, 'left'],
                      ['Category', COL.category, 'left'],
                      ['Subcategory', COL.subcategory, 'left'],
                      ['Style no.', COL.style, 'left'],
                      ['Description', COL.description, 'left'],
                      ['Qty', COL.qty, 'right'],
                      ['Rate', COL.rate, 'right'],
                      ['Discount', COL.discount, 'right'],
                      ['Tax %', COL.tax, 'right'],
                      ['Net price', COL.netPrice, 'right'],
                      ['Amount', COL.amount, 'right'],
                      ['', COL.remove, 'left'],
                    ].map(([label, width, align], i) => (
                      <th
                        key={label || i}
                        className={`${width} border-b border-border px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground align-bottom ${
                          align === 'right' ? 'text-right' : 'text-left'
                        }`}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => {
                    const item = itemById.get(line.itemId)

                    /*
                     * Where this row's item is actually filed, used when the
                     * row has not narrowed anything itself.
                     *
                     * Worked out here rather than stored on the line, because
                     * the category list arrives from the server after the form
                     * has already been filled from the record — an order
                     * opened for editing in that first moment would have shown
                     * "All / None" beside an item that is plainly under Fabric.
                     * Derived, it is right whenever the list arrives.
                     */
                    const filed = categories.find((c) => c.id === item?.categoryId)
                    const view = {
                      ...line,
                      categoryId: line.categoryId || filed?.parentId || filed?.id || '',
                      subcategoryId: line.subcategoryId || (filed?.parentId ? filed.id : ''),
                    }

                    const subs = subCategoriesOf(view.categoryId)
                    const choices = itemsFor(view)
                    const money = priceOf(line)
                    // Outlined only once the row has an item — a blank row is
                    // not unfinished, it is just empty.
                    const needsQty = Boolean(line.itemId) && num(line.qty) <= 0
                    const needsRate = Boolean(line.itemId) && String(line.unitRate).trim() === ''
                    const cell = 'form-input h-8 px-2 text-xs'

                    return (
                      <tr
                        key={i}
                        className="bg-card border-b border-border/50 last:border-0 [&>td]:align-top [&>td]:px-2 [&>td]:py-1.5"
                      >
                        <td className={`${COL.code} sticky left-0 z-10 bg-card`}>
                          {/* A real combobox, using the browser's own: type a
                              code and the list narrows, or open it and pick
                              one. `datalist` rather than a hand-built dropdown
                              because it needs no package, it keeps the cell a
                              plain text box for anyone who already knows the
                              code by heart, and it cannot be scrolled out of
                              the table the way an absolutely positioned menu
                              inside a sideways-scrolling grid can.

                              One list per row, because each row narrows its
                              items by its own category. */}
                          <input
                            className={`${cell} font-mono`}
                            list={`po-codes-${i}`}
                            placeholder="Code"
                            value={line.codeText ?? ''}
                            onChange={(e) => typeCodeFor(i, e.target.value)}
                            aria-label={`Row ${i + 1} item code`}
                          />
                          <datalist id={`po-codes-${i}`}>
                            {choices.map((it) => (
                              <option key={it.id} value={it.code ?? ''} label={it.name} />
                            ))}
                          </datalist>
                        </td>

                        <td className={`${COL.item} sticky left-32 z-10 bg-card border-r border-border`}>
                          <select
                            className={cell}
                            value={line.itemId}
                            onChange={(e) => pickItemFor(i, e.target.value)}
                            aria-label={`Row ${i + 1} item`}
                          >
                            <option value="">
                              {choices.length === 0 ? 'Nothing matches' : 'Choose an item...'}
                            </option>
                            {choices.map((it) => (
                              <option key={it.id} value={it.id}>
                                {it.name}
                              </option>
                            ))}
                          </select>
                          {item?.hsnCode && (
                            <p className="text-[10px] text-muted-foreground font-mono mt-0.5">
                              HSN {item.hsnCode}
                            </p>
                          )}
                        </td>

                        <td className={COL.category}>
                          <select
                            className={cell}
                            value={view.categoryId}
                            onChange={(e) =>
                              // Clearing the subcategory with it: the one
                              // chosen a moment ago belongs to the category
                              // just replaced.
                              setLine(i, { categoryId: e.target.value, subcategoryId: '' })
                            }
                            aria-label={`Row ${i + 1} category`}
                          >
                            <option value="">All</option>
                            {topCategories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td className={COL.subcategory}>
                          <select
                            className={cell}
                            value={view.subcategoryId}
                            disabled={subs.length === 0}
                            onChange={(e) => setLine(i, { subcategoryId: e.target.value })}
                            aria-label={`Row ${i + 1} subcategory`}
                          >
                            <option value="">{subs.length === 0 ? 'None' : 'All'}</option>
                            {subs.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td className={COL.style}>
                          {/* Typed, not chosen from a list — material is often
                              bought before the style has been set up, so a
                              dropdown of existing styles could not hold what
                              the buyer needs to write.

                              The master's codes are still offered as
                              suggestions, and picking one links the line to
                              that style so it reconciles against production.
                              Type something the master has never heard of and
                              the text is kept anyway. */}
                          <input
                            className={cell}
                            list="po-style-codes"
                            placeholder="Style"
                            value={(line.styleNo as string) ?? ''}
                            onChange={(e) => typeStyleFor(i, e.target.value)}
                            aria-label={`Row ${i + 1} style number`}
                          />
                          {/* Shown only when the text matched nothing, so the
                              buyer knows this order will not tie back to a
                              style — not an error, just a fact about it. */}
                          {line.styleNo && !line.styleId && (
                            <p className="text-[10px] text-muted-foreground mt-0.5">Not in master</p>
                          )}
                        </td>

                        <td className={COL.description}>
                          <input
                            className={cell}
                            placeholder="Optional"
                            value={(line.description as string) ?? ''}
                            onChange={(e) => setLine(i, { description: e.target.value })}
                            aria-label={`Row ${i + 1} description`}
                          />
                        </td>

                        <td className={COL.qty}>
                          <input
                            type="number"
                            step="0.001"
                            min={0}
                            className={`${cell} text-right ${needsQty ? 'border-amber-500/70' : ''}`}
                            placeholder="0"
                            value={String(line.qty)}
                            onChange={(e) => setLine(i, { qty: e.target.value })}
                            aria-label={`Row ${i + 1} quantity`}
                          />
                          {item?.uom?.symbol && (
                            <p className="text-[10px] text-muted-foreground text-right mt-0.5">
                              {item.uom.symbol}
                            </p>
                          )}
                        </td>

                        <td className={COL.rate}>
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            className={`${cell} text-right ${needsRate ? 'border-amber-500/70' : ''}`}
                            placeholder="0.00"
                            value={String(line.unitRate)}
                            onChange={(e) => setLine(i, { unitRate: e.target.value })}
                            aria-label={`Row ${i + 1} rate`}
                          />
                        </td>

                        <td className={COL.discount}>
                          {/* Percent or rupees, as the mill's old form
                              allowed. Both sit in the cell, so which one this
                              figure is can never be in doubt. */}
                          <div className="flex items-stretch gap-1">
                            <input
                              type="number"
                              step="0.01"
                              min={0}
                              max={(line.discountUnit ?? '%') === '%' ? 100 : undefined}
                              className={`${cell} text-right flex-1 min-w-0`}
                              placeholder="0"
                              disabled={poType !== 'ITEM_LEVEL'}
                              value={poType === 'ITEM_LEVEL' ? String(line.discount) : ''}
                              onChange={(e) => setLine(i, { discount: e.target.value })}
                              aria-label={`Row ${i + 1} discount`}
                            />
                            <select
                              className={`${cell} w-11 shrink-0 px-1`}
                              disabled={poType !== 'ITEM_LEVEL'}
                              value={line.discountUnit ?? '%'}
                              onChange={(e) =>
                                setLine(i, { discountUnit: e.target.value as '%' | 'INR' })
                              }
                              aria-label={`Row ${i + 1} discount in percent or rupees`}
                            >
                              <option value="%">%</option>
                              <option value="INR">₹</option>
                            </select>
                          </div>
                        </td>

                        <td className={COL.tax}>
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            max={100}
                            className={`${cell} text-right`}
                            placeholder="0"
                            disabled={taxMode === 'NONE'}
                            value={taxMode === 'NONE' ? '' : String(line.gstRate)}
                            onChange={(e) => setLine(i, { gstRate: e.target.value })}
                            aria-label={`Row ${i + 1} tax percent`}
                          />
                          {/* The old form's "Is tax exempt". It is the same
                              thing as a rate of nothing, so it sets the box
                              above rather than being a second field that can
                              disagree with it. */}
                          <label className="flex items-center justify-end gap-1 mt-0.5 text-[10px] text-muted-foreground cursor-pointer">
                            <input
                              type="checkbox"
                              className="scale-75"
                              disabled={taxMode === 'NONE'}
                              checked={num(line.gstRate) === 0}
                              onChange={(e) =>
                                setLine(i, {
                                  gstRate: e.target.checked
                                    ? '0'
                                    : item?.taxRate
                                      ? String(item.taxRate.rate)
                                      : '',
                                })
                              }
                            />
                            Exempt
                          </label>
                        </td>

                        <td className={COL.netPrice}>
                          <div className="h-8 flex items-center justify-end tabular-nums text-xs text-muted-foreground whitespace-nowrap">
                            {inr(money.netPrice)}
                          </div>
                        </td>

                        <td className={COL.amount}>
                          <div className="h-8 flex items-center justify-end tabular-nums font-medium whitespace-nowrap">
                            {inr(totals.lineAmounts[i] ?? 0)}
                          </div>
                        </td>

                        <td className={COL.remove}>
                          <div className="h-8 flex items-center">
                            <button
                              type="button"
                              onClick={() => removeRow(i)}
                              className="btn-ghost p-1 text-muted-foreground hover:text-red-400"
                              aria-label={`Remove row ${i + 1}`}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 mt-2">
              <button type="button" onClick={addRow} className="btn-secondary">
                <Plus size={15} /> Add item row
              </button>
              <NotBuiltNote>
                Purchase indents are not built yet, so items come from the item list rather than
                from an indent.
              </NotBuiltNote>
            </div>
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
            <p className="text-xs text-amber-400 mr-auto max-w-xl">
              {!supplierId
                ? 'Choose a supplier to save this order.'
                : activeLines.length === 0
                  ? 'Add at least one item to save this order.'
                  : /* Named, with the empty cell outlined in the table, so a
                       long order does not have to be read twice to find it. */
                    `Still to fill in: ${unfinished
                      .slice(0, 3)
                      .map(
                        (r) =>
                          `${r.name} (${[r.noQty && 'quantity', r.noRate && 'rate']
                            .filter(Boolean)
                            .join(' and ')})`,
                      )
                      .join(', ')}${
                      unfinished.length > 3 ? ` and ${unfinished.length - 3} more` : ''
                    }.`}
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
