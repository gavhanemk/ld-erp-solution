'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Calculator,
  CheckCircle2,
  FileText,
  Handshake,
  Hash,
  Loader2,
  MapPin,
  Package,
  Plus,
  Save,
  Send,
  ShieldAlert,
  ShoppingBag,
  StickyNote,
  Tag,
  Trash2,
  User,
  UserRound,
  X,
} from 'lucide-react'
import { api, ApiError, can, currentUser } from '@/lib/api'
import { fetchEveryPage } from '@/lib/export'
import { formatDate, formatRupees } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
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
  categoryId: string | null
  styleId: string | null
  style: { id: string; code: string; name: string } | null
  hsnCode: string | null
  /** The rate the item's HSN code carries, sent here by the items list. */
  taxRate: { rate: string | number } | null
  hsn: { gstRate: string | number; priceLimit: string | number | null; rateAbove: string | number | null } | null
}

interface CategoryOption {
  id: string
  name: string
  parentId: string | null
}

interface StyleOption {
  id: string
  code: string
  name: string
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
  /** The saved line this is, on an amendment; none for a line added now. */
  id?: string
  /** What the row is narrowed by. Filled from the item once one is picked. */
  categoryId: string
  subcategoryId: string
  styleId: string
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
  version: number
  createdById: string
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
    id: string
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
  categoryId: '',
  subcategoryId: '',
  styleId: '',
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

/** Column widths of the line table, as on the purchase order form. */
const COL = {
  num: 'w-8',
  remove: 'w-8',
  category: 'w-40',
  item: 'w-64',
  style: 'w-32',
  colour: 'w-24',
  qty: 'w-20',
  rate: 'w-28',
  discount: 'w-16',
  tax: 'w-14',
  amount: 'w-28',
} as const

function TotalRow({ label, value, quiet = false }: { label: string; value: string; quiet?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${quiet ? 'text-muted-foreground' : 'text-foreground'}`}>{value}</span>
    </div>
  )
}

/** A label and a control with its icon drawn inside, as on the purchase order form. */
function Field({
  label,
  icon: Icon,
  htmlFor,
  required = false,
  className = '',
  help,
  children,
}: {
  label: string
  icon?: React.ElementType
  htmlFor?: string
  required?: boolean
  className?: string
  help?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label className="form-label" htmlFor={htmlFor}>
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {Icon ? (
        <div className="relative">
          <Icon
            size={14}
            className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2"
          />
          {children}
        </div>
      ) : (
        children
      )}
      {help && <p className="text-muted-foreground mt-1 text-[11px] leading-snug">{help}</p>}
    </div>
  )
}

/**
 * The sales order form: a new order, a draft not yet confirmed, or an
 * amendment to a confirmed order (`amend`), which keeps the old version.
 *
 * Laid out like the purchase order form, so somebody who knows one knows the
 * other: Basic Details in four short columns with the customer read back under
 * them, then the Item Details table, then notes beside the totals.
 *
 * A line is found the way Purchase finds one, every box tied to the others:
 * category and sub-category narrow the items and styles on offer, a style
 * narrows to its colours, and picking an item by its code or its name fills
 * the category, sub-category and style in from the item. A garment's sizes
 * open in a slim row under its line, one box per size of its style's run.
 *
 * Saving is the standard ERP two: Save as draft, or Confirm order. Nobody's
 * approval is needed — unless the customer is over their credit limit or
 * blacklisted, when the order goes on credit hold for a manager (or, for the
 * Admin or an approver confirming someone else's draft, is released with a
 * reason on the spot).
 *
 * What it does not do, by design:
 *   - the rate is never filled in: it is typed, with the customer's last rate
 *     for that item shown underneath (as on purchase orders);
 *   - GST is shown as the server will charge it, from each item's HSN code at
 *     the price per piece, but the server works it out again on save — this
 *     screen's figures are a preview, never the record.
 */
export function SalesOrderDialog({
  open,
  orderId,
  amend = false,
  onClose,
  onSaved,
}: {
  open: boolean
  /** A draft to change or an order to amend, or null for a new order. */
  orderId: string | null
  /** Amend a confirmed order rather than edit a draft. */
  amend?: boolean
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
  const [categories, setCategories] = useState<CategoryOption[]>([])
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

  const [saving, setSaving] = useState<'draft' | 'confirm' | 'amend' | null>(null)
  /** Set when confirming needs a reason to release a credit hold: what to show. */
  const [releaseAsk, setReleaseAsk] = useState<string | null>(null)
  /** Why a confirmed order is changing. Kept with the version it replaces. */
  const [amendReason, setAmendReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Escape closes, and the page behind does not scroll while the form is up.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving && !releaseAsk) onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose, saving, releaseAsk])

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const styleById = useMemo(() => new Map(styles.map((s) => [s.id, s])), [styles])
  const sizesOfGroup = useMemo(
    () => new Map(sizeGroups.map((g) => [g.id, [...g.sizes].sort((a, b) => a.sequence - b.sequence)])),
    [sizeGroups]
  )

  /** Where an item is filed: its category, or a sub-category and the parent above it. */
  const filingOf = (item: ItemOption | undefined, cats: CategoryOption[] = categories) => {
    const cat = cats.find((c) => c.id === item?.categoryId)
    if (!cat) return { categoryId: '', subcategoryId: '' }
    return cat.parentId ? { categoryId: cat.parentId, subcategoryId: cat.id } : { categoryId: cat.id, subcategoryId: '' }
  }

  /*
   * Opening: a clean form, the lists, and — for a draft or an amendment — the
   * order itself. Everything is fetched fresh each time, so a customer or item
   * added a minute ago in Masters is there to pick.
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
    setAmendReason('')
    setLoadingLists(true)

    void (async () => {
      try {
        const [c, b, br, it, cat, st, sg, order] = await Promise.all([
          fetchEveryPage<CustomerOption>((p) => `/masters/customers?active=true&limit=200&page=${p}`),
          api.get<{ data: BrandOption[] }>('/masters/brands?active=true&limit=200'),
          fetchEveryPage<BrokerOption>((p) => `/masters/brokers?active=true&limit=200&page=${p}`),
          fetchEveryPage<ItemOption>(
            (p) => `/masters/items?type=FINISHED_GOOD&active=true&limit=200&page=${p}&sort=name&order=asc`
          ),
          fetchEveryPage<CategoryOption>((p) => `/masters/item-categories?limit=200&page=${p}`),
          fetchEveryPage<StyleOption>((p) => `/masters/styles?limit=200&page=${p}`),
          fetchEveryPage<SizeGroupOption>((p) => `/masters/size-groups?limit=200&page=${p}`),
          orderId ? api.get<{ data: SavedOrder }>(`/sales/orders/${orderId}`) : Promise.resolve(null),
        ])
        if (!alive) return
        const itemMap = new Map(it.rows.map((i) => [i.id, i]))
        setCustomers([...c.rows].sort((x, y) => x.name.localeCompare(y.name)))
        setBrands(b.data)
        setBrokers([...br.rows].sort((x, y) => x.name.localeCompare(y.name)))
        setItems(it.rows)
        setCategories([...cat.rows].sort((x, y) => x.name.localeCompare(y.name)))
        setStyles([...st.rows].sort((x, y) => x.code.localeCompare(y.code)))
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
              ? o.lines.map((l) => {
                  const item = itemMap.get(l.itemId)
                  return {
                    key: `l${++lineKey}`,
                    id: l.id,
                    ...filingOf(item, cat.rows),
                    styleId: item?.styleId ?? '',
                    itemId: l.itemId,
                    sizes: Object.fromEntries(l.sizes.map((s) => [s.sizeId, String(Number(s.qty))])),
                    qty: l.sizes.length ? '' : String(Number(l.totalQty)),
                    unitPrice: String(Number(l.unitPrice)),
                    discount: Number(l.discount) > 0 ? String(Number(l.discount)) : '',
                  }
                })
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
    // filingOf reads only its arguments here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** An item's size run, or null when its style has none and pieces are typed as one figure. */
  const sizesFor = (item: ItemOption | undefined): SizeOption[] | null => {
    const groupId = item?.styleId ? styleById.get(item.styleId)?.sizeGroupId : null
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

  // ── Finding a line's item: every box tied to the others ───────────────
  const topCategories = useMemo(() => categories.filter((c) => !c.parentId), [categories])
  const subCategoriesOf = (categoryId: string) => (categoryId ? categories.filter((c) => c.parentId === categoryId) : [])

  /** The items a row's category and sub-category allow, before its style narrows them. */
  const itemsInFiling = (line: Pick<LineDraft, 'categoryId' | 'subcategoryId'>) => {
    const children = new Set(subCategoriesOf(line.categoryId).map((c) => c.id))
    return items.filter((it) => {
      if (line.subcategoryId) return it.categoryId === line.subcategoryId
      if (line.categoryId) return it.categoryId === line.categoryId || children.has(it.categoryId ?? '')
      return true
    })
  }

  /** The items one row may choose from: its filing, then its style. */
  const itemsFor = (line: LineDraft) =>
    itemsInFiling(line).filter((it) => !line.styleId || it.styleId === line.styleId)

  /** The styles with an item in the row's filing — a style with nothing to sell is not offered. */
  const stylesFor = (line: LineDraft) => {
    const ids = new Set(itemsInFiling(line).map((it) => it.styleId).filter(Boolean))
    return styles.filter((s) => ids.has(s.id))
  }

  const setLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  /** Picking the item by its code or its name fills the rest of the row from it. */
  const pickItem = (key: string, itemId: string) => {
    setError(null)
    const line = lines.find((l) => l.key === key)
    if (!line) return
    if (!itemId) {
      setLine(key, { itemId: '', sizes: {}, qty: '' })
      return
    }
    // The same garment on two rows is nearly always a slip, and makes the
    // order hard to check against the buyer's PO.
    if (lines.some((l) => l.key !== key && l.itemId === itemId)) {
      setError(`${itemById.get(itemId)?.code ?? 'That item'} is already on another row. Change the pieces there instead.`)
      return
    }
    const item = itemById.get(itemId)
    setLine(key, {
      itemId,
      ...filingOf(item),
      styleId: item?.styleId ?? '',
      // A different garment has a different size run, so its sizes start again.
      ...(line.itemId !== itemId ? { sizes: {}, qty: '' } : {}),
    })
  }

  /** A narrower box keeps the item only if the item still fits it. */
  const narrow = (key: string, patch: Partial<LineDraft>) => {
    const line = lines.find((l) => l.key === key)
    if (!line) return
    const next = { ...line, ...patch }
    const keeps = !!line.itemId && itemsFor(next).some((it) => it.id === line.itemId)
    setLine(key, { ...patch, ...(keeps ? {} : { itemId: '', sizes: {}, qty: '' }) })
  }

  /** A style picked: its one colour is picked with it; with several, the colours are offered. */
  const pickStyle = (key: string, styleId: string) => {
    const line = lines.find((l) => l.key === key)
    if (!line) return
    const next = { ...line, styleId }
    const choices = itemsFor(next)
    if (styleId && choices.length === 1 && !lines.some((l) => l.key !== key && l.itemId === choices[0].id)) {
      const item = choices[0]
      setLine(key, {
        styleId,
        itemId: item.id,
        ...filingOf(item),
        ...(line.itemId !== item.id ? { sizes: {}, qty: '' } : {}),
      })
      return
    }
    narrow(key, { styleId })
  }

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
  }, [lines, itemById, styleById, sizesOfGroup, billDiscount, brokerPct, context])

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
                .map(
                  (p) =>
                    `${p.item?.code ?? 'an item'} (${[p.qty <= 0 && 'pieces', p.line.unitPrice.trim() === '' && 'rate']
                      .filter(Boolean)
                      .join(' and ')})`
                )
                .join(', ')}${unfinished.length > 3 ? ` and ${unfinished.length - 3} more` : ''}.`
            : noGst.length
              ? `${noGst[0].item?.code} has no HSN code or GST rate. Set one on the item in Masters first.`
              : amend && amendReason.trim().length < 5
                ? 'Say why the order is changing, in a few words, to save the amendment.'
                : null

  const busy = saving !== null || loadingLists

  /*
   * Over the credit limit, or blacklisted, with this order on top: worked out
   * from what the server sent about the customer, so it follows the total as
   * lines are typed. Only then is a manager involved at all.
   */
  const me = currentUser() as { id?: string; role?: string } | null
  const credit = context?.credit
  const creditHeld =
    !!credit &&
    (credit.isBlacklisted || (credit.limit != null && credit.unpaid + credit.openOrders + totals.total > credit.limit))
  // The same rule as the server: the Admin, or an approver who did not raise it.
  const mayRelease = me?.role === 'Admin' || (can('sales', 'approve') && !!saved && saved.createdById !== me?.id)

  const save = async (confirm: boolean, creditReleaseReason?: string) => {
    if (blocker) return
    // Releasing a hold needs a reason; ask before anything is sent.
    if (confirm && !amend && creditHeld && mayRelease && !creditReleaseReason) {
      setReleaseAsk(
        credit?.isBlacklisted
          ? 'This customer is blacklisted. Confirming anyway releases the hold; your reason is kept on the order.'
          : 'This order takes the customer over their credit limit. Confirming anyway releases the hold; your reason is kept on the order.'
      )
      return
    }
    setSaving(amend ? 'amend' : confirm ? 'confirm' : 'draft')
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
      confirm,
      creditReleaseReason: creditReleaseReason ?? null,
      // Rows with no item picked are a blank row, not a line.
      lines: filled.map((p) => ({
        // On an amendment each saved line keeps its id, so it stays the same
        // line from one version to the next.
        ...(amend && p.line.id ? { id: p.line.id } : {}),
        itemId: p.line.itemId,
        totalQty: p.qty,
        unitPrice: p.rate,
        discount: p.disc,
        sizes: p.run
          ? p.run.map((s) => ({ sizeId: s.id, qty: Number(p.line.sizes[s.id]) || 0 })).filter((s) => s.qty > 0)
          : undefined,
      })),
    }
    try {
      const res =
        saved && amend
          ? await api.post<{ message?: string }>(`/sales/orders/${saved.id}/amend`, {
              ...body,
              confirm: undefined,
              creditReleaseReason: undefined,
              reason: amendReason.trim(),
            })
          : saved
            ? await api.patch<{ message?: string }>(`/sales/orders/${saved.id}`, body)
            : await api.post<{ message?: string }>('/sales/orders', body)
      onSaved(res.message ?? (confirm ? 'Order confirmed.' : 'Order saved as a draft.'))
      onClose()
    } catch (err) {
      // The server found the hold this screen did not (the customer's figures
      // moved since they were fetched): ask for the reason rather than fail.
      if (err instanceof ApiError && err.code === 'CREDIT_HOLD' && mayRelease) {
        setReleaseAsk(err.message)
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not save the order.')
      }
    } finally {
      setSaving(null)
    }
  }

  if (!open || !mounted) return null

  const rateLabel = isJobWork ? 'Job charge' : 'Rate'
  const taxMode = taxModeWords(context)
  const cell = 'form-input h-8 px-2 text-xs'

  const lastRateHint = (itemId: string) => {
    const r = lastRates[itemId]
    if (!r) return null
    return (
      <span
        className="text-muted-foreground mt-0.5 block text-right text-[10px] leading-tight"
        title={`On ${r.soNumber}, ${formatDate(r.orderDate)}`}
      >
        Last ₹{inr(r.unitPrice)}
      </span>
    )
  }

  const removeLine = (key: string) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : [blankLine()]))

  /** The four linked boxes that find a row's item, shared by the table and the phone cards. */
  const finders = (p: (typeof totals.lines)[number], i: number, compact: boolean) => {
    const line = p.line
    const subs = subCategoriesOf(line.categoryId)
    const choices = itemsFor(line)
    const styleChoices = stylesFor(line)
    const c = compact ? cell : 'form-input'
    return {
      category: (
        <SmartSelect
          className={c}
          value={line.categoryId}
          onChange={(e) => narrow(line.key, { categoryId: e.target.value, subcategoryId: '' })}
          aria-label={`Row ${i + 1} category`}
        >
          <option value="">All categories</option>
          {topCategories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}
            </option>
          ))}
        </SmartSelect>
      ),
      subcategory: (
        <SmartSelect
          className={c}
          value={line.subcategoryId}
          disabled={subs.length === 0}
          onChange={(e) => narrow(line.key, { subcategoryId: e.target.value })}
          aria-label={`Row ${i + 1} sub-category`}
        >
          <option value="">{subs.length === 0 ? 'No sub-category' : 'All sub-categories'}</option>
          {subs.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}
            </option>
          ))}
        </SmartSelect>
      ),
      code: (
        <SmartSelect
          className={`${c} font-mono`}
          value={line.itemId}
          onChange={(e) => pickItem(line.key, e.target.value)}
          aria-label={`Row ${i + 1} item code`}
        >
          <option value="">Item code</option>
          {choices.map((it) => (
            <option key={it.id} value={it.id} data-sub={it.name}>
              {it.code}
            </option>
          ))}
        </SmartSelect>
      ),
      name: (
        <SmartSelect
          className={c}
          value={line.itemId}
          onChange={(e) => pickItem(line.key, e.target.value)}
          aria-label={`Row ${i + 1} item name`}
        >
          <option value="">{choices.length === 0 ? 'Nothing matches' : 'Item name'}</option>
          {choices.map((it) => (
            <option key={it.id} value={it.id} data-sub={it.code}>
              {it.name}
              {it.color ? ` (${it.color})` : ''}
            </option>
          ))}
        </SmartSelect>
      ),
      style: (
        <SmartSelect
          className={`${c} font-mono`}
          value={line.styleId}
          onChange={(e) => pickStyle(line.key, e.target.value)}
          aria-label={`Row ${i + 1} style number`}
        >
          <option value="">All styles</option>
          {styleChoices.map((st) => (
            <option key={st.id} value={st.id} data-sub={st.name}>
              {st.code}
            </option>
          ))}
        </SmartSelect>
      ),
    }
  }

  const primary = amend ? (
    <button type="button" className="btn-primary" onClick={() => void save(false)} disabled={busy || !!blocker}>
      {saving === 'amend' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
      Save amendment
    </button>
  ) : creditHeld && !mayRelease ? (
    <button
      type="button"
      className="btn-primary"
      onClick={() => void save(true)}
      disabled={busy || !!blocker}
      title="Over the credit limit: a manager has to OK it in Pending Approvals"
    >
      {saving === 'confirm' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
      Send to manager
    </button>
  ) : (
    <button type="button" className="btn-primary" onClick={() => void save(true)} disabled={busy || !!blocker}>
      {saving === 'confirm' ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
      Confirm order
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
                {saved && amend
                  ? `Amending ${saved.soNumber} · version ${saved.version} is kept in its history`
                  : saved
                    ? `${saved.soNumber} — a draft can be changed until it is confirmed`
                    : 'New order from a customer'}
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
              {/* 1 — Who the order is from and what it answers to. Four short
                columns, as on the purchase order, and the customer read back
                underneath once one is picked. */}
              <Section icon={FileText} title="Basic Details">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-4 gap-y-3 md:grid-cols-4">
                  <Field label="Customer" icon={User} htmlFor="so-customer" required className="md:col-span-2">
                    <SmartSelect
                      id="so-customer"
                      className="form-input pl-9"
                      value={customerId}
                      onChange={(e) => pickCustomer(e.target.value)}
                      disabled={amend}
                      title={amend ? 'The customer cannot change on an amendment' : undefined}
                    >
                      <option value="">Choose a customer</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id} data-sub={c.billingCity ?? undefined}>
                          {c.code ? `${c.code} — ${c.name}` : c.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </Field>
                  <Field label="Order no." icon={Hash} htmlFor="so-number">
                    <input
                      id="so-number"
                      className="form-input pl-9 font-mono"
                      value={saved?.soNumber ?? ''}
                      placeholder="Given when saved"
                      readOnly
                    />
                  </Field>
                  <Field label="Order date" htmlFor="so-date" required>
                    <input
                      id="so-date"
                      type="date"
                      className="form-input"
                      value={orderDate}
                      onChange={(e) => setOrderDate(e.target.value || today())}
                    />
                  </Field>

                  <Field label="Brand" icon={Tag} htmlFor="so-brand" required>
                    <SmartSelect id="so-brand" className="form-input pl-9" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                      <option value="">Choose a brand</option>
                      {brands.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </Field>
                  <Field
                    label="Order type"
                    icon={Package}
                    htmlFor="so-type"
                    help={isJobWork ? 'The customer sends their fabric; we bill the job charge only.' : 'We buy the fabric and sell the garments.'}
                  >
                    <SmartSelect
                      id="so-type"
                      className="form-input pl-9"
                      value={isJobWork ? 'job' : 'own'}
                      onChange={(e) => {
                        setIsJobWork(e.target.value === 'job')
                        setTypeTouched(true)
                      }}
                    >
                      <option value="own">Own order</option>
                      <option value="job">Job work</option>
                    </SmartSelect>
                  </Field>
                  <Field label="Buyer PO no." icon={FileText} htmlFor="so-po">
                    <input
                      id="so-po"
                      className="form-input pl-9"
                      value={poRef}
                      maxLength={60}
                      placeholder="As on the buyer's PO"
                      onChange={(e) => setPoRef(e.target.value)}
                    />
                  </Field>
                  <Field label="Buyer PO date" htmlFor="so-po-date">
                    <input id="so-po-date" type="date" className="form-input" value={poDate} onChange={(e) => setPoDate(e.target.value)} />
                  </Field>

                  <Field label="Delivery date" htmlFor="so-delivery">
                    <input
                      id="so-delivery"
                      type="date"
                      className="form-input"
                      value={deliveryDate}
                      min={orderDate || undefined}
                      onChange={(e) => setDeliveryDate(e.target.value)}
                    />
                  </Field>
                  <Field label="Broker" icon={Handshake} htmlFor="so-broker">
                    <SmartSelect id="so-broker" className="form-input pl-9" value={brokerId} onChange={(e) => pickBroker(e.target.value)}>
                      <option value="">Direct (no broker)</option>
                      {brokers.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </Field>
                  <Field label="Brokerage %" htmlFor="so-brokerage">
                    <input
                      id="so-brokerage"
                      className="form-input text-right tabular-nums"
                      inputMode="decimal"
                      value={brokerId ? brokerPct : ''}
                      disabled={!brokerId}
                      placeholder={brokerId ? '0' : '—'}
                      onChange={(e) => {
                        setBrokerTouched(true)
                        setBrokerPct(e.target.value.replace(/[^\d.]/g, ''))
                      }}
                    />
                  </Field>
                  <Field label="Salesperson" icon={UserRound} htmlFor="so-salesperson">
                    <input
                      id="so-salesperson"
                      className="form-input pl-9"
                      value={salesperson}
                      maxLength={120}
                      placeholder="Who took the order"
                      onChange={(e) => setSalesperson(e.target.value)}
                    />
                  </Field>

                  <Field label="Deliver to" icon={MapPin} htmlFor="so-address" className="md:col-span-4">
                    <input
                      id="so-address"
                      className="form-input pl-9"
                      value={deliveryAddress}
                      maxLength={500}
                      placeholder="Taken from the customer; change it for this order only"
                      onChange={(e) => {
                        setAddressTouched(true)
                        setDeliveryAddress(e.target.value)
                      }}
                    />
                  </Field>
                </div>

                {customer && (
                  <div className="mt-3">
                    <CustomerPanel customer={customer} context={context} loading={contextLoading} orderValue={totals.total} />
                  </div>
                )}
              </Section>

              {/* 2 — The lines, entered where they are shown, as on the
                purchase order. Category and sub-category first, then the item
                by code or name, then its style; any of them fills or narrows
                the others. A garment's sizes open in a row under it. */}
              <Section
                icon={Package}
                title="Item Details"
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

                {/* At a desk, one table. */}
                <div className="border-border bg-card hidden overflow-x-auto rounded-lg border sm:block">
                  <table className="w-full min-w-[1080px] table-fixed border-collapse text-sm">
                    <thead>
                      <tr className="bg-secondary">
                        {[
                          ['#', `${COL.num} sticky left-0 z-20 bg-secondary`, 'left'],
                          ['', `${COL.remove} sticky left-8 z-20 bg-secondary`, 'left'],
                          ['Category', COL.category, 'left'],
                          ['Item', `${COL.item} border-border border-r`, 'left'],
                          ['Style no.', COL.style, 'left'],
                          ['Colour', COL.colour, 'left'],
                          ['Pieces', COL.qty, 'right'],
                          [`${rateLabel} ₹/pc`, COL.rate, 'right'],
                          ['Disc %', COL.discount, 'right'],
                          ['GST', COL.tax, 'right'],
                          ['Amount', COL.amount, 'right'],
                        ].map(([label, width, align], i) => (
                          <th
                            key={`${label}-${i}`}
                            className={`${width} border-border text-muted-foreground border-b px-2 py-1.5 align-bottom text-[10px] font-semibold uppercase tracking-wider ${
                              align === 'right' ? 'text-right' : 'text-left'
                            }`}
                          >
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {totals.lines.map((p, i) => {
                        const f = finders(p, i, true)
                        const needsQty = !!p.line.itemId && p.qty <= 0
                        const needsRate = !!p.line.itemId && p.line.unitPrice.trim() === ''
                        const zebra = i % 2 === 1 ? 'zebra-row' : 'bg-card'
                        return (
                          <Fragment key={p.line.key}>
                            <tr className={`${zebra} [&>td]:px-2 [&>td]:py-1.5 [&>td]:align-top`}>
                              <td className={`${COL.num} sticky left-0 z-10 bg-inherit`}>
                                <div className="text-muted-foreground flex h-8 items-center justify-center text-xs tabular-nums">
                                  {i + 1}
                                </div>
                              </td>
                              <td className={`${COL.remove} sticky left-8 z-10 bg-inherit`}>
                                <div className="flex h-8 items-center">
                                  <button
                                    type="button"
                                    onClick={() => removeLine(p.line.key)}
                                    className="btn-ghost text-muted-foreground hover:text-destructive p-1"
                                    aria-label={`Remove row ${i + 1}`}
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              </td>
                              <td className={COL.category}>
                                <div className="space-y-1">
                                  {f.category}
                                  {f.subcategory}
                                </div>
                              </td>
                              <td className={`${COL.item} border-border border-r`}>
                                <div className="space-y-1">
                                  {f.code}
                                  {f.name}
                                </div>
                                {p.item?.hsnCode && (
                                  <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">HSN {p.item.hsnCode}</p>
                                )}
                              </td>
                              <td className={COL.style}>{f.style}</td>
                              <td className={COL.colour}>
                                <div className="text-foreground flex h-8 items-center truncate text-xs">
                                  {p.item?.color || <span className="text-muted-foreground">—</span>}
                                </div>
                              </td>
                              <td className={COL.qty}>
                                {p.run ? (
                                  // With a size run the pieces are what the sizes add up to.
                                  <div
                                    className={`flex h-8 items-center justify-end text-xs font-semibold tabular-nums ${
                                      needsQty ? 'warn-text' : 'text-foreground'
                                    }`}
                                    title="The sizes below add up to this"
                                  >
                                    {p.qty ? p.qty.toLocaleString('en-IN') : '0'}
                                  </div>
                                ) : (
                                  <input
                                    className={`${cell} text-right tabular-nums ${needsQty ? 'border-destructive/50' : ''}`}
                                    inputMode="numeric"
                                    value={p.line.qty}
                                    placeholder="0"
                                    disabled={!p.line.itemId}
                                    aria-label={`Row ${i + 1} pieces`}
                                    onChange={(e) => setLine(p.line.key, { qty: e.target.value.replace(/[^\d]/g, '') })}
                                  />
                                )}
                              </td>
                              <td className={COL.rate}>
                                <input
                                  className={`${cell} text-right tabular-nums ${needsRate ? 'border-destructive/50' : ''}`}
                                  inputMode="decimal"
                                  value={p.line.unitPrice}
                                  placeholder="0.00"
                                  aria-label={`Row ${i + 1} ${rateLabel}`}
                                  onChange={(e) => setLine(p.line.key, { unitPrice: e.target.value.replace(/[^\d.]/g, '') })}
                                />
                                {lastRateHint(p.line.itemId)}
                              </td>
                              <td className={COL.discount}>
                                <input
                                  className={`${cell} text-right tabular-nums`}
                                  inputMode="decimal"
                                  value={p.line.discount}
                                  placeholder="0"
                                  aria-label={`Row ${i + 1} discount percent`}
                                  onChange={(e) => setLine(p.line.key, { discount: e.target.value.replace(/[^\d.]/g, '') })}
                                />
                              </td>
                              <td className={COL.tax}>
                                <div className="flex h-8 items-center justify-end text-xs tabular-nums">
                                  {p.gst != null ? `${p.gst}%` : p.line.itemId ? <span className="warn-text">none</span> : '—'}
                                </div>
                              </td>
                              <td className={COL.amount}>
                                <div className="text-foreground flex h-8 items-center justify-end text-xs font-semibold tabular-nums">
                                  {p.amount ? inr(p.amount) : '—'}
                                </div>
                              </td>
                            </tr>
                            {/* The garment's sizes, in a slim row of their own under
                              it. They differ from style to style, so they cannot be
                              columns of the table. */}
                            {p.run && (
                              <tr className={zebra}>
                                <td className="sticky left-0 z-10 bg-inherit" />
                                <td className="sticky left-8 z-10 bg-inherit" />
                                <td colSpan={9} className="px-2 pb-2.5 pt-0">
                                  <div className="border-border bg-secondary/40 flex flex-wrap items-end gap-x-4 gap-y-2 rounded-lg border px-3 py-2">
                                    <span className="text-muted-foreground self-center text-[10px] font-semibold uppercase tracking-wider">
                                      Pieces by size
                                    </span>
                                    <SizeQtyGrid
                                      sizes={p.run}
                                      values={p.line.sizes}
                                      name={`Row ${i + 1}`}
                                      onChange={(sizeId, v) => setLine(p.line.key, { sizes: { ...p.line.sizes, [sizeId]: v } })}
                                    />
                                    <span className="text-foreground ml-auto self-center text-xs font-semibold tabular-nums">
                                      = {p.qty.toLocaleString('en-IN')} pcs
                                    </span>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* On a phone, a card per line: the four linked boxes, the sizes
                  three to a row, then the price. */}
                <div className="space-y-3 sm:hidden">
                  {totals.lines.map((p, i) => {
                    const f = finders(p, i, false)
                    return (
                      <div key={p.line.key} className="border-border bg-card space-y-2.5 rounded-lg border p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground text-xs font-semibold">Row {i + 1}</span>
                          <button
                            type="button"
                            className="btn-ghost p-1.5"
                            onClick={() => removeLine(p.line.key)}
                            aria-label={`Remove row ${i + 1}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {f.category}
                          {f.subcategory}
                          {f.code}
                          {f.style}
                        </div>
                        {f.name}
                        {p.item && (
                          <p className="text-muted-foreground text-[11px]">
                            {p.item.color ? `${p.item.color} · ` : ''}
                            {p.item.hsnCode ? `HSN ${p.item.hsnCode}` : ''}
                          </p>
                        )}
                        {p.line.itemId &&
                          (p.run ? (
                            <SizeQtyGrid
                              layout="grid"
                              sizes={p.run}
                              values={p.line.sizes}
                              name={`Row ${i + 1}`}
                              onChange={(sizeId, v) => setLine(p.line.key, { sizes: { ...p.line.sizes, [sizeId]: v } })}
                            />
                          ) : (
                            <input
                              className="form-input text-right tabular-nums"
                              inputMode="numeric"
                              value={p.line.qty}
                              placeholder="Pieces"
                              aria-label={`Row ${i + 1} pieces`}
                              onChange={(e) => setLine(p.line.key, { qty: e.target.value.replace(/[^\d]/g, '') })}
                            />
                          ))}
                        <div className="grid grid-cols-2 gap-2">
                          <label>
                            <span className="form-label">{rateLabel} ₹/pc</span>
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
                    )
                  })}
                </div>

                <button
                  type="button"
                  className="btn-secondary mt-3 h-8 px-3 text-xs"
                  onClick={() => setLines((ls) => [...ls, blankLine()])}
                >
                  <Plus size={14} /> Add item row
                </button>
              </Section>

              {/* 3 — Notes beside the figures, as on the purchase order. */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_420px]">
                <Section icon={StickyNote} title="Notes">
                  <label className="block">
                    <span className="form-label">Notes for production</span>
                    <textarea
                      className="form-input min-h-[6rem]"
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
                        not printed.
                      </p>
                    )}
                    {!taxMode && (
                      <p className="text-muted-foreground pt-1 text-xs">
                        Choose a customer to see whether the tax splits into CGST + SGST or is IGST.
                      </p>
                    )}
                  </div>
                </Section>
              </div>
            </>
          )}
        </div>

        {/* Footer — stays put, so Save never has to be hunted for. */}
        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3.5">
          {blocker && !loadingLists ? (
            <p className="warn-text mr-auto flex max-w-xl basis-full items-start gap-1.5 text-xs sm:basis-auto">
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>{blocker}</span>
            </p>
          ) : creditHeld && !amend ? (
            <p className="warn-text mr-auto flex max-w-xl basis-full items-start gap-1.5 text-xs sm:basis-auto">
              <ShieldAlert size={13} className="mt-px shrink-0" />
              <span>
                {credit?.isBlacklisted ? 'This customer is blacklisted' : 'Over the credit limit'}:{' '}
                {mayRelease ? 'confirming asks for a reason to release the hold.' : 'it goes to a manager to OK before it is confirmed.'}
              </span>
            </p>
          ) : null}
          {amend && (
            <input
              className="form-input h-9 min-w-0 basis-full sm:max-w-sm sm:basis-auto"
              value={amendReason}
              maxLength={500}
              placeholder="Why it is changing, e.g. buyer added 200 pcs"
              aria-label="Reason for the amendment"
              onChange={(e) => setAmendReason(e.target.value)}
            />
          )}
          <button type="button" onClick={onClose} className="btn-secondary hidden sm:inline-flex" disabled={saving !== null}>
            Cancel
          </button>
          {!amend && (
            <button type="button" className="btn-secondary" onClick={() => void save(false)} disabled={busy || !!blocker}>
              {saving === 'draft' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              <span className="sm:hidden">Draft</span>
              <span className="hidden sm:inline">Save as draft</span>
            </button>
          )}
          {primary}
        </div>
      </div>
      {releaseAsk && (
        <ReasonDialog
          title="Release the credit hold?"
          description={releaseAsk}
          confirmLabel="Release and confirm"
          placeholder="Payment of ₹2 L promised by Friday"
          busy={saving !== null}
          onCancel={() => setReleaseAsk(null)}
          onConfirm={(reason) => {
            setReleaseAsk(null)
            void save(true, reason)
          }}
        />
      )}
    </div>,
    document.body
  )
}
