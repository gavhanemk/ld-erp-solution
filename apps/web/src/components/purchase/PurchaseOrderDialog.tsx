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

export interface PoLine {
  itemId: string
  description?: string | null
  qty: number | string
  unitRate: number | string
  discount: number | string
  gstRate: number | string
  /** Priced by the API. Absent on a line the form is still building. */
  amount?: number | string
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
  const [company, setCompany] = useState<CompanyLite | null>(null)

  // Header
  const [supplierId, setSupplierId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [enquiryNo, setEnquiryNo] = useState('')
  const [enquiryDate, setEnquiryDate] = useState('')
  const [reference, setReference] = useState('')
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
  const [pickQty, setPickQty] = useState('')

  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Files chosen on a new order, held here until it has a number to hang them
  // on. They go up the moment it is saved.
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)

  const [saving, setSaving] = useState<'draft' | 'send' | null>(null)
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
    setWarehouseId(record?.deliveryWarehouseId ?? '')
    setEnquiryNo(record?.enquiryNo ?? '')
    setEnquiryDate(record?.enquiryDate?.slice(0, 10) ?? '')
    setReference(record?.reference ?? '')
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
    setPickQty('')
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
      // The company block under "deliver to" is our own address. Settings is
      // the only place that serves it and a purchase clerk may not be allowed
      // in there, so the address is treated as a nicety, not a requirement.
      api.get<{ success: boolean; data: CompanyLite }>('/settings/company').catch(() => null),
    ]).then(([s, i, w, cust, c, co]) => {
      if (cancelled) return
      setSuppliers((s as Paginated<Option>).data)
      setItems((i as Paginated<Option>).data)
      setWarehouses((w as Paginated<Option>).data)
      setCustomers((cust as Paginated<Option>).data)
      setCategories(c ? (c as Paginated<Option>).data : [])
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

    return { lineAmounts, subtotal, discount, taxable, tax, roundOff: total - beforeRound, total }
  }, [lines, discountAmount, taxMode])

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

    setLines((prev) => [
      ...prev,
      {
        itemId: item.id,
        description: '',
        qty: pickQty,
        unitRate: item.standardRate != null ? String(item.standardRate) : '',
        discount: '0',
        gstRate: item.taxRate ? String(item.taxRate.rate) : '',
      },
    ])

    // The category filters stay put: the next line is usually from the same
    // place, and clearing them would make the clerk choose twice.
    setPickItem('')
    setPickQty('')
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
    deliveryWarehouseId: deliverTo === 'CUSTOMER' ? null : warehouseId || null,
    deliveryCustomerId: deliverTo === 'CUSTOMER' ? deliveryCustomerId || null : null,
    enquiryNo: enquiryNo.trim() || null,
    enquiryDate: enquiryDate || null,
    reference: reference.trim() || null,
    // `remark` is deliberately not sent. The form no longer asks for it, and
    // omitting it leaves whatever an older order already carries untouched
    // rather than wiping it with a blank.
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
  })

  /**
   * `mode` decides what happens after the order is written.
   *
   * Saving a draft stops there. Saving the order marks it sent, which is a
   * second call on purpose — the order exists either way, so if marking it
   * sent fails the work is not lost, it is a draft waiting to be sent.
   */
  const save = async (mode: 'draft' | 'send') => {
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

      if (mode === 'send' && id) {
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
        className="glass-card w-full max-w-5xl h-full max-h-full flex flex-col overflow-hidden"
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
                {isEdit ? `Edit ${record?.poNumber}` : 'Add New Purchase Order'}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isEdit
                  ? 'Only a draft order can be changed'
                  : 'Create a new purchase order with all required details'}
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

          {/* 1 — Basic details */}
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

              {/* The supplier sits here rather than in a section of its own.
                  It is one field, and it belongs with the rest of what the
                  order is. */}
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
            </div>
          </Section>

          {/* 2 — Items */}
          <Section
            icon={Package}
            title="Items"
            hint={lines.length ? `${lines.length} on this order` : undefined}
          >
            <div className="space-y-3">
              <div className="rounded-lg border border-border bg-background/40 p-3">
                <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
                  <div className="md:col-span-3">
                    <label className="form-label" htmlFor="po-pick-search">
                      Item code
                    </label>
                    {/* form-input on the wrapper rather than a hand-set height:
                        it is the same box as every other field and lines up
                        with them without a magic number. */}
                    <div className="form-input flex items-center gap-2">
                      <Search size={14} className="text-muted-foreground shrink-0" />
                      <input
                        id="po-pick-search"
                        className="bg-transparent border-0 outline-none text-sm flex-1 min-w-0 text-foreground placeholder:text-muted-foreground"
                        placeholder="Code or name"
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

                  <div className="md:col-span-2">
                    <label className="form-label" htmlFor="po-pick-cat">
                      Category
                    </label>
                    <select
                      id="po-pick-cat"
                      className="form-input"
                      value={pickCategory}
                      onChange={(e) => {
                        // The item is not cleared here. It is dropped by the
                        // effect above, and only if it does not belong under
                        // the category just chosen — so narrowing to the
                        // category an item is already in keeps it.
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

                  <div className="md:col-span-2">
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
                      <option value="">
                        {subCategories.length === 0 ? 'None' : 'All'}
                      </option>
                      {subCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="md:col-span-3">
                    <label className="form-label" htmlFor="po-pick-item">
                      Item
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
                      {/* The name alone. The code sits in the box to the left
                          and again in the table below, and repeating it here
                          only made the option too long to read — "FAB-COT-002
                          — Cotton Po…" told you the code twice and the item
                          not at all. */}
                      {visibleItems.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="md:col-span-1">
                    <label className="form-label" htmlFor="po-pick-qty">
                      Qty
                    </label>
                    <input
                      id="po-pick-qty"
                      ref={qtyRef}
                      type="number"
                      step="0.001"
                      min={0}
                      className="form-input text-right"
                      value={pickQty}
                      onChange={(e) => setPickQty(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addLine()
                        }
                      }}
                    />
                  </div>

                  <div className="md:col-span-1">
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

                {pickHint ? (
                  <p className="text-xs text-amber-400 mt-2.5">{pickHint}</p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-2.5 flex items-start gap-1.5">
                    <Lock size={13} className="mt-0.5 shrink-0" />
                    Purchase indents are not built yet, so items are chosen from the item list
                    rather than pulled from an indent.
                  </p>
                )}
              </div>

              {lines.length === 0 ? (
                <p className="text-sm text-muted-foreground px-1 py-3">
                  Nothing on this order yet. Find an item above, type how much you want, and press
                  Add.
                </p>
              ) : (
                <div className="overflow-x-auto border border-border rounded-lg">
                  <table className="w-full text-sm min-w-[880px]">
                    <thead>
                      <tr className="border-b border-border bg-secondary/40">
                        {['Code', 'Item', 'Category', 'Qty', 'Rate', 'Disc %', 'GST %', 'Amount', ''].map(
                          (h, i) => (
                            <th
                              key={h || i}
                              className={`text-[10px] uppercase tracking-wider text-muted-foreground py-2 px-3 ${
                                ['Qty', 'Rate', 'Disc %', 'GST %', 'Amount'].includes(h)
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
                          <tr key={`${line.itemId}-${i}`} className="border-b border-border/50 last:border-0">
                            <td className="py-2 px-3 font-mono text-xs text-teal-400 whitespace-nowrap">
                              {item?.code ?? '—'}
                            </td>
                            <td className="py-2 px-3 min-w-[180px]">
                              <div className="font-medium text-foreground">{item?.name ?? 'Item'}</div>
                              <input
                                className="form-input h-8 mt-1"
                                placeholder="Describe it in your own words (optional)"
                                value={(line.description as string) ?? ''}
                                onChange={(e) => setLine(i, { description: e.target.value })}
                                aria-label={`Line ${i + 1} description`}
                              />
                              {item?.hsnCode && (
                                <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                                  HSN {item.hsnCode}
                                </p>
                              )}
                            </td>
                            <td className="py-2 px-3 text-xs text-muted-foreground whitespace-nowrap">
                              {item?.category?.name ?? '—'}
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

              {lines.length > 0 && (
                <div className="flex justify-end">
                  <div className="w-full sm:w-80 rounded-lg border border-border bg-background/40 p-4 space-y-2 text-sm">
                    <Row label="Subtotal" value={totals.subtotal} />
                    <div className="flex items-center justify-between gap-4">
                      <label htmlFor="po-discount" className="text-muted-foreground">
                        Discount on the order
                      </label>
                      <input
                        id="po-discount"
                        type="number"
                        step="0.01"
                        min={0}
                        className="form-input h-8 w-28 text-right"
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
                        ₹{inr(totals.total)}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Section>

          {/* 4 — Delivery and attachments. The dropzone became a single row:
              it cannot accept a file yet, so three lines and a dashed border
              were spending height to advertise something switched off. */}
          <Section icon={Truck} title="Delivery and attachments">
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
                    Our own address
                  </label>
                  <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                    <input
                      type="radio"
                      name="po-deliver-to"
                      checked={deliverTo === 'CUSTOMER'}
                      onChange={() => setDeliverTo('CUSTOMER')}
                    />
                    A customer
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
            onClick={() => void save('send')}
            className="btn-primary"
            disabled={busy || incomplete}
          >
            {saving === 'send' && <Loader2 size={15} className="animate-spin" />}
            {isEdit ? 'Save and send' : 'Save order'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
