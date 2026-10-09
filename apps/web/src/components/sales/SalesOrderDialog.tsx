'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Calculator,
  FileText,
  Loader2,
  Plus,
  Save,
  Send,
  ShoppingBag,
  Shirt,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { fetchEveryPage } from '@/lib/export'
import { formatDate, formatRupees } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { SizeQtyGrid, sumSizes, type SizeOption } from './SizeQtyGrid'
import {
  CustomerPanel,
  deliveryAddressOf,
  taxModeWords,
  type CustomerContext,
  type CustomerOption,
} from './CustomerPanel'

interface ItemOption {
  id: string
  code: string
  name: string
  color: string | null
  styleId: string | null
  style: { id: string; code: string; name: string } | null
  hsnCode: string | null
  /** The rate the item's HSN code carries, sent here by the items list. */
  taxRate: { rate: string | number } | null
  hsn: { gstRate: string | number; priceLimit: string | number | null; rateAbove: string | number | null } | null
}

interface StyleOption {
  id: string
  sizeGroupId: string | null
}

interface SizeGroupOption {
  id: string
  name: string
  sizes: Array<SizeOption & { sequence: number }>
}

interface BrandOption {
  id: string
  name: string
  type: string
}

interface BrokerOption {
  id: string
  name: string
  brokeragePercent: string | number | null
}

/** One line as it is being typed: strings, because that is what boxes hold. */
interface LineDraft {
  key: string
  itemId: string
  /** Pieces by size id, for an item whose style has a size run. */
  sizes: Record<string, string>
  /** Pieces, for an item with no size run. */
  qty: string
  unitPrice: string
  discount: string
}

/** A saved order as the detail returns it — what the form reopens from. */
interface SavedOrder {
  id: string
  soNumber: string
  status: string
  sentForApprovalAt: string | null
  customerId: string
  brandId: string
  orderDate: string
  deliveryDate: string | null
  customerPORef: string | null
  customerPODate: string | null
  deliveryAddress: string | null
  salesperson: string | null
  brokerId: string | null
  brokeragePercent: string | number | null
  discountAmount: string | number
  isJobWork: boolean
  notes: string | null
  lines: Array<{
    itemId: string
    totalQty: string | number
    unitPrice: string | number
    discount: string | number
    sizes: Array<{ sizeId: string; qty: string | number }>
  }>
}

type LastRates = Record<string, { unitPrice: number; soNumber: string; orderDate: string }>

let lineKey = 0
const blankLine = (): LineDraft => ({
  key: `l${++lineKey}`,
  itemId: '',
  sizes: {},
  qty: '',
  unitPrice: '',
  discount: '',
})

const today = () => new Date().toISOString().slice(0, 10)
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '')
const round2 = (n: number) => Math.round(n * 100) / 100
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function TotalRow({ label, value, quiet = false }: { label: string; value: string; quiet?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${quiet ? 'text-muted-foreground' : 'text-foreground'}`}>{value}</span>
    </div>
  )
}

/**
 * The sales order form: a new order, or a draft not yet sent for approval.
 *
 * Built on the purchase order form's shell — the full-height card that stops
 * at the sidebar, a header and footer that stay put, sections in between —
 * so somebody who knows one form knows the other.
 *
 * What it does not do, by design:
 *   - the rate is never filled in: it is typed, with the customer's last rate
 *     for that item shown underneath (as on purchase orders);
 *   - GST is shown as the server will charge it, from each item's HSN code at
 *     the price per piece, but the server works it out again on save — this
 *     screen's figures are a preview, never the record;
 *   - a customer over their credit limit is not refused. The panel says so,
 *     and a manager releases the order when approving it.
 */
export function SalesOrderDialog({
  open,
  orderId,
  onClose,
  onSaved,
}: {
  open: boolean
  /** A draft to change, or null for a new order. */
  orderId: string | null
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // ── The lists the form picks from ─────────────────────────────────────
  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [brands, setBrands] = useState<BrandOption[]>([])
  const [brokers, setBrokers] = useState<BrokerOption[]>([])
  const [items, setItems] = useState<ItemOption[]>([])
  const [styles, setStyles] = useState<StyleOption[]>([])
  const [sizeGroups, setSizeGroups] = useState<SizeGroupOption[]>([])
  const [loadingLists, setLoadingLists] = useState(false)

  // ── The order ──────────────────────────────────────────────────────────
  const [saved, setSaved] = useState<SavedOrder | null>(null)
  const [isJobWork, setIsJobWork] = useState(false)
  const [customerId, setCustomerId] = useState('')
  const [brandId, setBrandId] = useState('')
  const [orderDate, setOrderDate] = useState(today())
  const [deliveryDate, setDeliveryDate] = useState('')
  const [poRef, setPoRef] = useState('')
  const [poDate, setPoDate] = useState('')
  const [brokerId, setBrokerId] = useState('')
  const [brokerPct, setBrokerPct] = useState('')
  const [salesperson, setSalesperson] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [notes, setNotes] = useState('')
  const [billDiscount, setBillDiscount] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([blankLine()])

  // Once somebody has changed one of these by hand, picking a different
  // customer no longer overwrites it.
  const [typeTouched, setTypeTouched] = useState(false)
  const [brokerTouched, setBrokerTouched] = useState(false)
  const [addressTouched, setAddressTouched] = useState(false)

  const [context, setContext] = useState<CustomerContext | null>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [lastRates, setLastRates] = useState<LastRates>({})

  const [saving, setSaving] = useState<'draft' | 'send' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Escape closes, and the page behind does not scroll while the form is up.
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

  /*
   * Opening: a clean form, the lists, and — for a draft — the order itself.
   * Everything is fetched fresh each time, so a customer added a minute ago in
   * Masters is there to pick.
   */
  useEffect(() => {
    if (!open) return
    let alive = true
    setError(null)
    setSaved(null)
    setIsJobWork(false)
    setCustomerId('')
    setBrandId('')
    setOrderDate(today())
    setDeliveryDate('')
    setPoRef('')
    setPoDate('')
    setBrokerId('')
    setBrokerPct('')
    setSalesperson('')
    setDeliveryAddress('')
    setNotes('')
    setBillDiscount('')
    setLines([blankLine()])
    setTypeTouched(false)
    setBrokerTouched(false)
    setAddressTouched(false)
    setContext(null)
    setLastRates({})
    setLoadingLists(true)

    void (async () => {
      try {
        const [c, b, br, it, st, sg, order] = await Promise.all([
          fetchEveryPage<CustomerOption>((p) => `/masters/customers?active=true&limit=200&page=${p}`),
          api.get<{ data: BrandOption[] }>('/masters/brands?active=true&limit=200'),
          fetchEveryPage<BrokerOption>((p) => `/masters/brokers?active=true&limit=200&page=${p}`),
          fetchEveryPage<ItemOption>(
            (p) => `/masters/items?type=FINISHED_GOOD&active=true&limit=200&page=${p}&sort=name&order=asc`
          ),
          fetchEveryPage<StyleOption>((p) => `/masters/styles?limit=200&page=${p}`),
          fetchEveryPage<SizeGroupOption>((p) => `/masters/size-groups?limit=200&page=${p}`),
          orderId ? api.get<{ data: SavedOrder }>(`/sales/orders/${orderId}`) : Promise.resolve(null),
        ])
        if (!alive) return
        setCustomers([...c.rows].sort((x, y) => x.name.localeCompare(y.name)))
        setBrands(b.data)
        setBrokers([...br.rows].sort((x, y) => x.name.localeCompare(y.name)))
        setItems(it.rows)
        setStyles(st.rows)
        setSizeGroups(sg.rows)

        if (order) {
          const o = order.data
          setSaved(o)
          setIsJobWork(o.isJobWork)
          setCustomerId(o.customerId)
          setBrandId(o.brandId)
          setOrderDate(day(o.orderDate))
          setDeliveryDate(day(o.deliveryDate))
          setPoRef(o.customerPORef ?? '')
          setPoDate(day(o.customerPODate))
          setBrokerId(o.brokerId ?? '')
          setBrokerPct(o.brokeragePercent != null ? String(Number(o.brokeragePercent)) : '')
          setSalesperson(o.salesperson ?? '')
          setDeliveryAddress(o.deliveryAddress ?? '')
          setNotes(o.notes ?? '')
          setBillDiscount(Number(o.discountAmount) > 0 ? String(Number(o.discountAmount)) : '')
          setLines(
            o.lines.length
              ? o.lines.map((l) => ({
                  key: `l${++lineKey}`,
                  itemId: l.itemId,
                  sizes: Object.fromEntries(l.sizes.map((s) => [s.sizeId, String(Number(s.qty))])),
                  qty: l.sizes.length ? '' : String(Number(l.totalQty)),
                  unitPrice: String(Number(l.unitPrice)),
                  discount: Number(l.discount) > 0 ? String(Number(l.discount)) : '',
                }))
              : [blankLine()]
          )
          // A saved draft's choices are its own: do not overwrite them.
          setTypeTouched(true)
          setBrokerTouched(true)
          setAddressTouched(true)
        } else {
          // One brand of our own to begin with, the commonest case.
          const own = b.data.find((x) => x.type === 'LD_COTTON_MILLS') ?? b.data[0]
          if (own) setBrandId(own.id)
        }
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err.message : 'Could not load the customers, items and sizes.')
      } finally {
        if (alive) setLoadingLists(false)
      }
    })()

    return () => {
      alive = false
    }
  }, [open, orderId])

  // Each customer picked: how they are taxed, their credit, and their last rates.
  useEffect(() => {
    if (!open || !customerId) {
      setContext(null)
      setLastRates({})
      return
    }
    let alive = true
    setContextLoading(true)
    void Promise.all([
      api.get<{ data: CustomerContext }>(`/sales/customers/${customerId}/context`),
      api.get<{ data: LastRates }>(`/sales/customers/${customerId}/last-rates`).catch(() => ({ data: {} })),
    ])
      .then(([ctx, rates]) => {
        if (!alive) return
        setContext(ctx.data)
        setLastRates(rates.data)
      })
      .catch((err) => {
        if (alive) setError(err instanceof ApiError ? err.message : 'Could not check the customer.')
      })
      .finally(() => {
        if (alive) setContextLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, customerId])

  const customer = customers.find((c) => c.id === customerId) ?? null
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const sizeGroupOfStyle = useMemo(() => new Map(styles.map((s) => [s.id, s.sizeGroupId])), [styles])
  const sizesOfGroup = useMemo(
    () => new Map(sizeGroups.map((g) => [g.id, [...g.sizes].sort((a, b) => a.sequence - b.sequence)])),
    [sizeGroups]
  )

  /** An item's size run, or null when its style has none and pieces are typed as one figure. */
  const sizesFor = (item: ItemOption | undefined): SizeOption[] | null => {
    const groupId = item?.styleId ? sizeGroupOfStyle.get(item.styleId) : null
    const run = groupId ? sizesOfGroup.get(groupId) : null
    return run && run.length ? run : null
  }

  const pickCustomer = (id: string) => {
    setCustomerId(id)
    const c = customers.find((x) => x.id === id)
    if (!c) return
    if (!typeTouched) setIsJobWork(c.type === 'JOB_WORK')
    if (!addressTouched) setDeliveryAddress(deliveryAddressOf(c))
    if (!brokerTouched) {
      // The same order the server falls back in: the broker's own rate, then
      // the rate agreed with the customer.
      const broker = brokers.find((b) => b.id === c.brokerId)
      setBrokerId(c.brokerId ?? '')
      const pct = broker?.brokeragePercent ?? c.brokeragePercent
      setBrokerPct(pct != null ? String(Number(pct)) : '')
    }
  }

  const pickBroker = (id: string) => {
    setBrokerTouched(true)
    setBrokerId(id)
    const broker = brokers.find((b) => b.id === id)
    setBrokerPct(broker?.brokeragePercent != null ? String(Number(broker.brokeragePercent)) : id ? '' : '0')
  }

  const setLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const pickItem = (key: string, itemId: string) =>
    // A different item has a different size run, so the sizes start again.
    setLine(key, { itemId, sizes: {}, qty: '' })

  // ── Figures, as the server will work them out ─────────────────────────
  const totals = useMemo(() => {
    const priced = lines.map((l) => {
      const item = itemById.get(l.itemId)
      const run = sizesFor(item)
      const qty = run ? sumSizes(l.sizes) : Number(l.qty) || 0
      const rate = Number(l.unitPrice) || 0
      const disc = Math.min(100, Math.max(0, Number(l.discount) || 0))
      return { line: l, item, run, qty, rate, disc, amount: round2(qty * rate * (1 - disc / 100)) }
    })
    const subtotal = round2(priced.reduce((s, p) => s + p.amount, 0))
    const discount = round2(Math.min(Number(billDiscount) || 0, subtotal))
    const taxable = round2(subtotal - discount)
    const factor = subtotal > 0 ? taxable / subtotal : 1

    let tax = 0
    const withGst = priced.map((p) => {
      // Garments carry one rate up to a price per piece and another above it.
      let gst: number | null = null
      if (p.item?.hsn) {
        const perPiece = p.rate * (1 - p.disc / 100) * factor
        const { gstRate, priceLimit, rateAbove } = p.item.hsn
        gst =
          priceLimit != null && rateAbove != null && perPiece > Number(priceLimit) ? Number(rateAbove) : Number(gstRate)
      } else if (p.item?.taxRate) {
        gst = Number(p.item.taxRate.rate)
      }
      tax += p.amount * factor * ((gst ?? 0) / 100)
      return { ...p, gst }
    })

    const intra = context?.placeOfSupply?.isIntraState
    const half = round2(tax / 2)
    const cgst = intra ? half : 0
    const sgst = intra ? half : 0
    const igst = intra === false ? round2(tax) : 0
    const taxTotal = intra === undefined ? round2(tax) : cgst + sgst + igst
    const beforeRounding = taxable + taxTotal
    const total = Math.round(beforeRounding)
    const pieces = priced.reduce((s, p) => s + p.qty, 0)
    const brokerage = round2((taxable * (Number(brokerPct) || 0)) / 100)

    return {
      lines: withGst,
      subtotal,
      discount,
      taxable,
      cgst,
      sgst,
      igst,
      taxTotal,
      roundOff: round2(total - beforeRounding),
      total,
      pieces,
      brokerage,
    }
    // sizesFor reads the two maps below; listing them is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, itemById, sizeGroupOfStyle, sizesOfGroup, billDiscount, brokerPct, context])

  // ── What still stops a save ────────────────────────────────────────────
  const filled = totals.lines.filter((p) => p.line.itemId)
  const unfinished = filled.filter((p) => p.qty <= 0 || p.line.unitPrice.trim() === '')
  const noGst = filled.filter((p) => p.gst === null)
  const blocker = !customerId
    ? 'Choose a customer to save this order.'
    : !brandId
      ? 'Choose a brand.'
      : context?.placeOfSupplyProblem
        ? context.placeOfSupplyProblem
        : filled.length === 0
          ? 'Add at least one item.'
          : unfinished.length
            ? `Still to fill in: ${unfinished
                .slice(0, 3)
                .map((p) => `${p.item?.code ?? 'an item'} (${[p.qty <= 0 && 'pieces', p.line.unitPrice.trim() === '' && 'rate'].filter(Boolean).join(' and ')})`)
                .join(', ')}${unfinished.length > 3 ? ` and ${unfinished.length - 3} more` : ''}.`
            : noGst.length
              ? `${noGst[0].item?.code} has no HSN code or GST rate. Set one on the item in Masters first.`
              : null

  const busy = saving !== null || loadingLists

  const save = async (send: boolean) => {
    if (blocker) return
    setSaving(send ? 'send' : 'draft')
    setError(null)
    const body = {
      customerId,
      brandId,
      isJobWork,
      orderDate,
      deliveryDate: deliveryDate || null,
      customerPORef: poRef.trim() || null,
      customerPODate: poDate || null,
      deliveryAddress: deliveryAddress.trim() || null,
      salesperson: salesperson.trim() || null,
      brokerId: brokerId || null,
      brokeragePercent: brokerId ? Number(brokerPct) || 0 : 0,
      discountAmount: Number(billDiscount) || 0,
      notes: notes.trim() || null,
      sendForApproval: send,
      // Rows with no item picked are a blank row, not a line.
      lines: filled.map((p) => ({
        itemId: p.line.itemId,
        totalQty: p.qty,
        unitPrice: p.rate,
        discount: p.disc,
        sizes: p.run
          ? p.run
              .map((s) => ({ sizeId: s.id, qty: Number(p.line.sizes[s.id]) || 0 }))
              .filter((s) => s.qty > 0)
          : undefined,
      })),
    }
    try {
      const res = saved
        ? await api.patch<{ message?: string }>(`/sales/orders/${saved.id}`, body)
        : await api.post<{ message?: string }>('/sales/orders', body)
      onSaved(res.message ?? (send ? 'Order saved and sent for approval.' : 'Order saved as a draft.'))
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the order.')
    } finally {
      setSaving(null)
    }
  }

  if (!open || !mounted) return null

  const rateLabel = isJobWork ? 'Job charge ₹/pc' : 'Rate ₹/pc'
  const taxMode = taxModeWords(context)

  const lastRateHint = (itemId: string) => {
    const r = lastRates[itemId]
    if (!r) return null
    return (
      <span className="text-muted-foreground block text-[10px] leading-tight" title={`On ${r.soNumber}, ${formatDate(r.orderDate)}`}>
        Last ₹{inr(r.unitPrice)} · {r.soNumber}
      </span>
    )
  }

  const itemLabel = (i: ItemOption) => `${i.code} — ${i.name}${i.color ? ` (${i.color})` : ''}`

  const primary = (
    <button type="button" className="btn-primary" onClick={() => void save(true)} disabled={busy || !!blocker}>
      {saving === 'send' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
      <span className="sm:hidden">Send</span>
      <span className="hidden sm:inline">Send for approval</span>
    </button>
  )

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div
        className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="so-dialog-title"
      >
        {/* Header — stays put while the body scrolls. */}
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <ShoppingBag size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="so-dialog-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                Sales Order
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {saved
                  ? `${saved.soNumber} — a draft can be changed until it is sent for approval`
                  : 'New order from a customer · the number is given when you save'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden md:block">{primary}</div>
            <button onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={saving !== null}>
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body — the only part that scrolls. */}
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
              <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}

          {loadingLists ? (
            <div className="space-y-3">
              <div className="skeleton h-40 w-full rounded-xl" />
              <div className="skeleton h-56 w-full rounded-xl" />
            </div>
          ) : (
            <>
              <Section
                icon={FileText}
                title="Order details"
                actions={
                  <div role="radiogroup" aria-label="Order type" className="bg-secondary flex gap-1 rounded-lg p-1">
                    {[
                      { job: false, label: 'Own order' },
                      { job: true, label: 'Job work' },
                    ].map((t) => (
                      <button
                        key={t.label}
                        type="button"
                        role="radio"
                        aria-checked={isJobWork === t.job}
                        onClick={() => {
                          setIsJobWork(t.job)
                          setTypeTouched(true)
                        }}
                        className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                          isJobWork === t.job ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                }
              >
                <p className="text-muted-foreground mb-3 text-xs">
                  {isJobWork
                    ? 'Job work: the customer sends their own fabric against this order, and we bill only our job charge. Their fabric is never bought.'
                    : 'Own order: we buy the fabric and trims, and sell the garments. Anything short when production plans it becomes a purchase.'}
                </p>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <label className="min-w-0 md:col-span-2">
                    <span className="form-label">Customer</span>
                    <SmartSelect className="form-input" value={customerId} onChange={(e) => pickCustomer(e.target.value)}>
                      <option value="">Choose a customer</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.billingCity ? `, ${c.billingCity}` : ''}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  <label className="min-w-0">
                    <span className="form-label">Brand</span>
                    <SmartSelect className="form-input" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                      <option value="">Choose a brand</option>
                      {brands.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>

                  {customer && (
                    <div className="md:col-span-3">
                      <CustomerPanel customer={customer} context={context} loading={contextLoading} orderValue={totals.total} />
                    </div>
                  )}

                  <label className="min-w-0">
                    <span className="form-label">Buyer PO number</span>
                    <input
                      className="form-input"
                      value={poRef}
                      maxLength={60}
                      placeholder="As printed on the buyer's PO"
                      onChange={(e) => setPoRef(e.target.value)}
                    />
                  </label>
                  <label className="min-w-0">
                    <span className="form-label">Buyer PO date</span>
                    <input type="date" className="form-input" value={poDate} onChange={(e) => setPoDate(e.target.value)} />
                  </label>
                  <label className="min-w-0">
                    <span className="form-label">Order date</span>
                    <input
                      type="date"
                      className="form-input"
                      value={orderDate}
                      onChange={(e) => setOrderDate(e.target.value || today())}
                    />
                  </label>
                  <label className="min-w-0">
                    <span className="form-label">Delivery date</span>
                    <input
                      type="date"
                      className="form-input"
                      value={deliveryDate}
                      min={orderDate || undefined}
                      onChange={(e) => setDeliveryDate(e.target.value)}
                    />
                  </label>
                  <div className="min-w-0">
                    <span className="form-label">Broker and brokerage %</span>
                    <div className="flex gap-2">
                      <SmartSelect
                        className="form-input min-w-0 flex-1"
                        value={brokerId}
                        onChange={(e) => pickBroker(e.target.value)}
                        aria-label="Broker"
                      >
                        <option value="">Direct (no broker)</option>
                        {brokers.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </SmartSelect>
                      <input
                        className="form-input w-20 text-right tabular-nums"
                        inputMode="decimal"
                        value={brokerId ? brokerPct : ''}
                        disabled={!brokerId}
                        placeholder="%"
                        aria-label="Brokerage percent"
                        onChange={(e) => {
                          setBrokerTouched(true)
                          setBrokerPct(e.target.value.replace(/[^\d.]/g, ''))
                        }}
                      />
                    </div>
                  </div>
                  <label className="min-w-0">
                    <span className="form-label">Salesperson</span>
                    <input
                      className="form-input"
                      value={salesperson}
                      maxLength={120}
                      placeholder="Who took the order"
                      onChange={(e) => setSalesperson(e.target.value)}
                    />
                  </label>
                  <label className="min-w-0 md:col-span-3">
                    <span className="form-label">Delivery address</span>
                    <textarea
                      className="form-input min-h-[3.5rem]"
                      rows={2}
                      maxLength={500}
                      value={deliveryAddress}
                      placeholder="Taken from the customer; change it for this order only"
                      onChange={(e) => {
                        setAddressTouched(true)
                        setDeliveryAddress(e.target.value)
                      }}
                    />
                  </label>
                </div>
              </Section>

              <Section
                icon={Shirt}
                title="Order lines"
                actions={
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {totals.pieces.toLocaleString('en-IN')} pcs
                  </span>
                }
              >
                {items.length === 0 && (
                  <p className="warn-text mb-3 flex items-start gap-1.5 text-xs">
                    <AlertCircle size={13} className="mt-px shrink-0" />
                    No finished-goods items yet. Add each style and colour as an item in Masters → Items first.
                  </p>
                )}

                {/* At a desk, a table: one row per style and colour. */}
                <div className="hidden overflow-x-auto sm:block">
                  <table className="line-table w-full min-w-[920px]">
                    <thead>
                      <tr>
                        <th className="w-8 text-left">#</th>
                        <th className="w-[17rem] text-left">Item (style and colour)</th>
                        <th className="text-left">Pieces by size</th>
                        <th className="w-16 text-right">Total</th>
                        <th className="w-32 text-right">{rateLabel}</th>
                        <th className="w-20 text-right">Disc %</th>
                        <th className="w-14 text-right">GST</th>
                        <th className="w-28 text-right">Amount</th>
                        <th className="w-9" />
                      </tr>
                    </thead>
                    <tbody>
                      {totals.lines.map((p, i) => {
                        const missingQty = !!p.line.itemId && p.qty <= 0
                        const missingRate = !!p.line.itemId && p.line.unitPrice.trim() === ''
                        return (
                          <tr key={p.line.key} className="align-top">
                            <td className="text-muted-foreground pt-3 text-xs">{i + 1}</td>
                            <td className="py-1.5">
                              <SmartSelect
                                className="form-input h-8 text-xs"
                                value={p.line.itemId}
                                onChange={(e) => pickItem(p.line.key, e.target.value)}
                                aria-label={`Line ${i + 1} item`}
                              >
                                <option value="">Choose an item</option>
                                {items.map((it) => (
                                  <option key={it.id} value={it.id}>
                                    {itemLabel(it)}
                                  </option>
                                ))}
                              </SmartSelect>
                              {p.item?.hsnCode && (
                                <span className="text-muted-foreground mt-0.5 block text-[10px]">HSN {p.item.hsnCode}</span>
                              )}
                            </td>
                            <td className="py-1.5">
                              {!p.line.itemId ? (
                                <span className="text-muted-foreground text-xs">Pick the item first</span>
                              ) : p.run ? (
                                <div className={missingQty ? 'border-destructive/50 rounded-lg border p-1' : ''}>
                                  <SizeQtyGrid
                                    sizes={p.run}
                                    values={p.line.sizes}
                                    name={`Line ${i + 1}`}
                                    onChange={(sizeId, v) =>
                                      setLine(p.line.key, { sizes: { ...p.line.sizes, [sizeId]: v } })
                                    }
                                  />
                                </div>
                              ) : (
                                <input
                                  className={`form-input h-8 w-28 text-right text-xs tabular-nums ${missingQty ? 'border-destructive/50' : ''}`}
                                  inputMode="numeric"
                                  value={p.line.qty}
                                  placeholder="Pieces"
                                  aria-label={`Line ${i + 1} pieces`}
                                  title="This item's style has no size run, so the pieces are typed as one figure"
                                  onChange={(e) => setLine(p.line.key, { qty: e.target.value.replace(/[^\d]/g, '') })}
                                />
                              )}
                            </td>
                            <td className="pt-3 text-right text-xs font-semibold tabular-nums">
                              {p.qty ? p.qty.toLocaleString('en-IN') : '—'}
                            </td>
                            <td className="py-1.5 text-right">
                              <input
                                className={`form-input h-8 text-right text-xs tabular-nums ${missingRate ? 'border-destructive/50' : ''}`}
                                inputMode="decimal"
                                value={p.line.unitPrice}
                                placeholder="0.00"
                                aria-label={`Line ${i + 1} ${rateLabel}`}
                                onChange={(e) => setLine(p.line.key, { unitPrice: e.target.value.replace(/[^\d.]/g, '') })}
                              />
                              {lastRateHint(p.line.itemId)}
                            </td>
                            <td className="py-1.5">
                              <input
                                className="form-input h-8 text-right text-xs tabular-nums"
                                inputMode="decimal"
                                value={p.line.discount}
                                placeholder="0"
                                aria-label={`Line ${i + 1} discount percent`}
                                onChange={(e) => setLine(p.line.key, { discount: e.target.value.replace(/[^\d.]/g, '') })}
                              />
                            </td>
                            <td className="pt-3 text-right text-xs tabular-nums">
                              {p.gst != null ? `${p.gst}%` : p.line.itemId ? <span className="warn-text">none</span> : '—'}
                            </td>
                            <td className="pt-3 text-right text-xs font-semibold tabular-nums">
                              {p.amount ? inr(p.amount) : '—'}
                            </td>
                            <td className="pt-1.5 text-right">
                              <button
                                type="button"
                                className="btn-ghost p-1.5"
                                onClick={() =>
                                  setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== p.line.key) : [blankLine()]))
                                }
                                aria-label={`Remove line ${i + 1}`}
                                title="Remove this line"
                              >
                                <Trash2 size={14} />
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* On a phone, a card per line, the sizes three to a row. */}
                <div className="space-y-3 sm:hidden">
                  {totals.lines.map((p, i) => (
                    <div key={p.line.key} className="border-border bg-card space-y-2.5 rounded-lg border p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground text-xs font-semibold">Line {i + 1}</span>
                        <button
                          type="button"
                          className="btn-ghost p-1.5"
                          onClick={() =>
                            setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== p.line.key) : [blankLine()]))
                          }
                          aria-label={`Remove line ${i + 1}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <SmartSelect
                        className="form-input"
                        value={p.line.itemId}
                        onChange={(e) => pickItem(p.line.key, e.target.value)}
                        aria-label={`Line ${i + 1} item`}
                      >
                        <option value="">Choose an item</option>
                        {items.map((it) => (
                          <option key={it.id} value={it.id}>
                            {itemLabel(it)}
                          </option>
                        ))}
                      </SmartSelect>
                      {p.line.itemId &&
                        (p.run ? (
                          <SizeQtyGrid
                            layout="grid"
                            sizes={p.run}
                            values={p.line.sizes}
                            name={`Line ${i + 1}`}
                            onChange={(sizeId, v) => setLine(p.line.key, { sizes: { ...p.line.sizes, [sizeId]: v } })}
                          />
                        ) : (
                          <input
                            className="form-input text-right tabular-nums"
                            inputMode="numeric"
                            value={p.line.qty}
                            placeholder="Pieces"
                            aria-label={`Line ${i + 1} pieces`}
                            onChange={(e) => setLine(p.line.key, { qty: e.target.value.replace(/[^\d]/g, '') })}
                          />
                        ))}
                      <div className="grid grid-cols-2 gap-2">
                        <label>
                          <span className="form-label">{rateLabel}</span>
                          <input
                            className="form-input text-right tabular-nums"
                            inputMode="decimal"
                            value={p.line.unitPrice}
                            placeholder="0.00"
                            onChange={(e) => setLine(p.line.key, { unitPrice: e.target.value.replace(/[^\d.]/g, '') })}
                          />
                          {lastRateHint(p.line.itemId)}
                        </label>
                        <label>
                          <span className="form-label">Disc %</span>
                          <input
                            className="form-input text-right tabular-nums"
                            inputMode="decimal"
                            value={p.line.discount}
                            placeholder="0"
                            onChange={(e) => setLine(p.line.key, { discount: e.target.value.replace(/[^\d.]/g, '') })}
                          />
                        </label>
                      </div>
                      <div className="border-border flex items-center justify-between border-t pt-2 text-xs">
                        <span className="text-muted-foreground tabular-nums">
                          {p.qty.toLocaleString('en-IN')} pcs{p.gst != null ? ` · GST ${p.gst}%` : ''}
                        </span>
                        <span className="text-foreground font-semibold tabular-nums">₹{inr(p.amount)}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <button type="button" className="btn-secondary mt-3" onClick={() => setLines((ls) => [...ls, blankLine()])}>
                  <Plus size={15} /> Add line
                </button>
              </Section>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_420px]">
                <Section icon={StickyNote} title="Notes">
                  <label className="block">
                    <span className="form-label">Notes for production</span>
                    <textarea
                      className="form-input min-h-[5rem]"
                      rows={4}
                      maxLength={1000}
                      value={notes}
                      placeholder="Packing instructions, labels, special checks"
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </label>
                </Section>

                <Section icon={Calculator} title="Totals">
                  <div className="space-y-1.5 text-sm">
                    <TotalRow label={`Value of ${totals.pieces.toLocaleString('en-IN')} pcs`} value={inr(totals.subtotal)} />
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="so-bill-discount" className="text-muted-foreground">
                        Discount on the whole order (₹)
                      </label>
                      <input
                        id="so-bill-discount"
                        className="form-input h-8 w-28 text-right tabular-nums"
                        inputMode="decimal"
                        value={billDiscount}
                        placeholder="0.00"
                        onChange={(e) => setBillDiscount(e.target.value.replace(/[^\d.]/g, ''))}
                      />
                    </div>
                    <TotalRow label="Value before GST" value={inr(totals.taxable)} />
                    {context?.placeOfSupply ? (
                      context.placeOfSupply.isIntraState ? (
                        <>
                          <TotalRow label="CGST" value={inr(totals.cgst)} />
                          <TotalRow label="SGST" value={inr(totals.sgst)} />
                        </>
                      ) : (
                        <TotalRow label="IGST" value={inr(totals.igst)} />
                      )
                    ) : (
                      <TotalRow label="GST" value={inr(totals.taxTotal)} />
                    )}
                    {Math.abs(totals.roundOff) >= 0.005 && <TotalRow label="Rounding" value={inr(totals.roundOff)} quiet />}
                    <div className="border-primary/20 bg-primary/5 mt-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                      <span className="text-foreground font-semibold">Order total</span>
                      <span className="text-foreground whitespace-nowrap text-lg font-semibold tabular-nums">
                        {formatRupees(totals.total)}
                      </span>
                    </div>
                    {brokerId && Number(brokerPct) > 0 && (
                      <p className="text-muted-foreground pt-1 text-xs">
                        Brokerage {Number(brokerPct)}% · {formatRupees(totals.brokerage)} on the value before GST. Internal:
                        not printed on the order or the invoice.
                      </p>
                    )}
                    {!taxMode && (
                      <p className="text-muted-foreground pt-1 text-xs">
                        Choose a customer to see whether the tax splits into CGST + SGST or is IGST.
                      </p>
                    )}
                    <p className="text-muted-foreground pt-1 text-xs">
                      GST is worked out again by the server when you save, from each item&apos;s HSN code.
                    </p>
                  </div>
                </Section>
              </div>
            </>
          )}
        </div>

        {/* Footer — stays put, so Save never has to be hunted for. */}
        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3.5">
          {blocker && !loadingLists && (
            <p className="warn-text mr-auto flex max-w-xl basis-full items-start gap-1.5 text-xs sm:basis-auto">
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>{blocker}</span>
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
          {primary}
        </div>
      </div>
    </div>,
    document.body
  )
}
