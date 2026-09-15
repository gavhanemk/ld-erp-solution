'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
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
  Mail,
  ScrollText,
  MapPin,
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
  item?: {
    id: string
    code: string
    name: string
    hsnCode: string | null
    uom?: { symbol: string } | null
  }
}

export interface PurchaseOrder {
  id: string
  poNumber: string
  supplierId: string
  poDate: string
  deliveryDate: string | null
  deliveryWarehouseId: string | null
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
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Icon size={15} className="text-muted-foreground shrink-0" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {hint && <span className="text-xs text-muted-foreground ml-auto">{hint}</span>}
      </div>
      <div className="p-4">{children}</div>
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
function NotBuilt({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="pointer-events-none select-none opacity-50">{children}</div>
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground mt-1.5">
        <Lock size={13} className="mt-0.5 shrink-0" />
        {label}
      </p>
    </div>
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
  const [categories, setCategories] = useState<Option[]>([])
  const [company, setCompany] = useState<CompanyLite | null>(null)

  // Header
  const [supplierId, setSupplierId] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [poDate, setPoDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [deliveryDate, setDeliveryDate] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [enquiryNo, setEnquiryNo] = useState('')
  const [enquiryDate, setEnquiryDate] = useState('')
  const [reference, setReference] = useState('')
  const [remark, setRemark] = useState('')
  const [deliverTo, setDeliverTo] = useState<'ORGANIZATION' | 'CUSTOMER'>('ORGANIZATION')
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

  const [saving, setSaving] = useState<'draft' | 'send' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const firstFieldRef = useRef<HTMLSelectElement | null>(null)

  useEffect(() => {
    if (!open) return
    setSupplierId(record?.supplierId ?? '')
    setSupplierFilter('')
    setPoDate((record?.poDate ?? new Date().toISOString()).slice(0, 10))
    setDeliveryDate(record?.deliveryDate?.slice(0, 10) ?? '')
    setWarehouseId(record?.deliveryWarehouseId ?? '')
    setEnquiryNo(record?.enquiryNo ?? '')
    setEnquiryDate(record?.enquiryDate?.slice(0, 10) ?? '')
    setReference(record?.reference ?? '')
    setRemark(record?.remark ?? '')
    setDeliverTo('ORGANIZATION')
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
      masterResource<Option>('item-categories').list({ limit: 200, active: true }).catch(() => null),
      // The company block under "deliver to" is our own address. Settings is
      // the only place that serves it and a purchase clerk may not be allowed
      // in there, so the address is treated as a nicety, not a requirement.
      api.get<{ success: boolean; data: CompanyLite }>('/settings/company').catch(() => null),
    ]).then(([s, i, w, c, co]) => {
      if (cancelled) return
      setSuppliers((s as Paginated<Option>).data)
      setItems((i as Paginated<Option>).data)
      setWarehouses((w as Paginated<Option>).data)
      setCategories(c ? (c as Paginated<Option>).data : [])
      setCompany(co?.data ?? null)
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

  const visibleSuppliers = useMemo(() => {
    const q = supplierFilter.trim().toLowerCase()
    if (!q) return suppliers
    return suppliers.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.code ?? '').toLowerCase().includes(q),
    )
  }, [suppliers, supplierFilter])

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

  const taxMode = !supplier
    ? null
    : !supplier.gstin
      ? 'NONE'
      : (supplier.stateCode ?? supplier.gstin?.slice(0, 2)) === company?.stateCode
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

  if (!open) return null

  const setLine = (index: number, patch: Partial<PoLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  /**
   * Puts the chosen item on the order.
   *
   * Rate and GST come across from the item master rather than being typed —
   * a rate typed from memory is the mistake the business rules exist to stop.
   * Both stay editable, because a quoted price is often not the standard one.
   */
  const addLine = () => {
    const item = itemById.get(pickItem)
    if (!item || num(pickQty) <= 0) return

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

  const payload = () => ({
    supplierId,
    poDate,
    deliveryDate: deliveryDate || null,
    deliveryWarehouseId: warehouseId || null,
    enquiryNo: enquiryNo.trim() || null,
    enquiryDate: enquiryDate || null,
    reference: reference.trim() || null,
    remark: remark.trim() || null,
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

  const incomplete = !supplierId || lines.length === 0
  const busy = saving !== null
  const orgAddress = [company?.address, company?.city, company?.pincode].filter(Boolean).join(', ')
  // Where the goods are actually going: the chosen warehouse, or our own
  // address when none is picked.
  const destination = warehouses.find((w) => w.id === warehouseId) ?? null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3 sm:p-6">
      <div
        className="glass-card w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="po-dialog-title"
      >
        {/* Header — stays put while the body scrolls, so it is always clear what is being filled in */}
        <div className="shrink-0 flex items-start justify-between gap-4 px-6 py-4 border-b border-border">
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
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {error && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
              <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* 1 — Basic details */}
          <Section icon={FileText} title="Basic details">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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

              <div className="md:col-span-3">
                <label className="form-label" htmlFor="po-remark">
                  Remark
                </label>
                <input
                  id="po-remark"
                  className="form-input"
                  placeholder="Kept in our books — not printed on the supplier's copy"
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                />
              </div>
            </div>
          </Section>

          {/* 2 — Items */}
          <Section
            icon={Package}
            title="Items"
            hint={lines.length ? `${lines.length} on this order` : undefined}
          >
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-background/40 p-3">
                <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
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
                        onChange={(e) => setPickSearch(e.target.value)}
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
                        setPickCategory(e.target.value)
                        setPickSubcategory('')
                        setPickItem('')
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
                        setPickItem('')
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
                      onChange={(e) => setPickItem(e.target.value)}
                    >
                      <option value="">
                        {visibleItems.length === 0 ? 'Nothing matches' : 'Select...'}
                      </option>
                      {visibleItems.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.code ? `${it.code} — ${it.name}` : it.name}
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
                      disabled={!pickItem || num(pickQty) <= 0}
                    >
                      <Plus size={15} /> Add
                    </button>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground mt-2.5 flex items-start gap-1.5">
                  <Lock size={13} className="mt-0.5 shrink-0" />
                  Purchase indents are not built yet, so items are chosen from the item list rather
                  than pulled from an indent.
                </p>
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

          {/* 3 — Supplier */}
          <Section icon={Truck} title="Supplier">
            <div className="space-y-2">
              <div className="form-input flex items-center gap-2">
                <Search size={14} className="text-muted-foreground shrink-0" />
                <input
                  className="bg-transparent border-0 outline-none text-sm flex-1 min-w-0 text-foreground placeholder:text-muted-foreground"
                  placeholder="Narrow the list by name or code..."
                  value={supplierFilter}
                  onChange={(e) => setSupplierFilter(e.target.value)}
                  aria-label="Search suppliers"
                />
              </div>
              <select
                className="form-input"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                aria-label="Supplier"
              >
                <option value="">
                  {visibleSuppliers.length === 0 ? 'No supplier matches that' : 'Choose supplier'}
                </option>
                {visibleSuppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code ? `${s.code} — ${s.name}` : s.name}
                  </option>
                ))}
              </select>
              {supplier && (
                <p className="text-xs text-muted-foreground">
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
          </Section>

          {/* 4 — Delivery and attachments */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section icon={Paperclip} title="Attachments">
              <NotBuilt label="Attaching files is not built yet — nothing in the ERP can store one.">
                <div className="rounded-lg border border-dashed border-border p-4 text-center">
                  <Paperclip size={18} className="text-muted-foreground mx-auto" />
                  <p className="text-sm text-foreground mt-2">Choose files</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Up to 5 files, 5MB each
                  </p>
                </div>
              </NotBuilt>
            </Section>

            <Section icon={MapPin} title="Deliver to">
              <div className="space-y-3">
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
                  <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-not-allowed">
                    <input type="radio" name="po-deliver-to" disabled />
                    A customer
                  </label>
                </div>

                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Lock size={13} className="mt-0.5 shrink-0" />
                  Delivering straight to a customer is not built yet — an order has nowhere to keep
                  their address.
                </p>

                {/* Shown, not repeated. An order has one destination, so a
                    second dropdown for it here would only mirror the Location
                    field above — change one and the other moves, which reads
                    as two settings that disagree. */}
                <div className="rounded-lg border border-border bg-background/40 p-3">
                  <p className="text-sm font-medium text-foreground">
                    {destination?.name ?? company?.name ?? 'Your company'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {destination?.address ||
                      orgAddress ||
                      'Address not set — add it in Settings → Company.'}
                  </p>
                </div>

                <p className="text-xs text-muted-foreground">
                  To send the goods somewhere else, change{' '}
                  <button
                    type="button"
                    className="text-primary underline"
                    onClick={() => document.getElementById('po-location')?.focus()}
                  >
                    Location
                  </button>{' '}
                  at the top of this form.
                </p>
              </div>
            </Section>
          </div>

          {/* 5 — Terms and notes */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section icon={ScrollText} title="Terms and conditions">
              <textarea
                rows={4}
                className="form-input"
                placeholder="Leave blank to use the terms set in Settings → Documents"
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                aria-label="Terms and conditions"
              />
            </Section>

            <Section icon={FileText} title="Notes">
              <textarea
                rows={4}
                className="form-input"
                placeholder="Printed on the order the supplier receives"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-label="Notes"
              />
            </Section>
          </div>

          {/* 6 — Template and email */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section icon={FileText} title="Template">
              <NotBuilt label="Choosing or editing a template is not built yet. Orders print on the standard sheet.">
                <div className="flex items-center justify-between rounded-lg border border-border bg-background/40 px-3 py-2.5">
                  <span className="text-sm text-foreground">Standard</span>
                  <span className="text-xs text-muted-foreground">Edit</span>
                </div>
              </NotBuilt>
            </Section>

            <Section icon={Mail} title="Email to">
              <NotBuilt label="Sending the order by email is not built yet. Print it and send it yourself.">
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="checkbox" checked readOnly />
                  {company?.email ?? 'accounts@example.com'}
                </label>
              </NotBuilt>
            </Section>
          </div>
        </div>

        {/* Footer — stays put, so Save never has to be hunted for at the bottom of a long form */}
        <div className="shrink-0 flex flex-wrap items-center justify-end gap-3 px-6 py-4 border-t border-border">
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
    </div>
  )
}
