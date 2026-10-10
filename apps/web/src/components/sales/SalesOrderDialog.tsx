'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Calculator,
  CheckCircle2,
  FileText,
  Handshake,
  Hash,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Package,
  Paperclip,
  Plus,
  Receipt,
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
import { AttachmentsBox, type AttachmentsBoxHandle } from '@/components/purchase/AttachmentsBox'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { SuggestInput } from '@/components/ui/SuggestInput'
import { StepInput } from '@/components/ui/StepInput'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { SizeQtyGrid, sumSizes, type SizeOption } from './SizeQtyGrid'
import {
  CustomerPanel,
  billingAddressOf,
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
  imageUrl: string | null
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
  colors: string[] | null
  fabricType: string | null
  imageUrl: string | null
}

interface SizeGroupOption {
  id: string
  name: string
  gender: string | null
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

interface ChargeTypeOption {
  id: string
  name: string
  defaultGstRate: string | number
  isActive: boolean
  applyOnSale: boolean
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
  /** The style number as typed, or as filled in from the item. */
  styleCode: string
  itemId: string
  /**
   * The size run picked on the line, for a garment whose style has none.
   * A style with its own run always uses that one.
   */
  sizeGroupId: string
  /** Pieces by size id. */
  sizes: Record<string, string>
  /** Pieces, for a line with no size run. */
  qty: string
  unitPrice: string
  discount: string
  /** Typed only for an item that is not one colour of a style. */
  color: string
  gender: string
  fabric: string
  printName: string
  description: string
  taxExempt: boolean
}

interface ChargeDraft {
  key: string
  chargeTypeId: string
  amount: string
  gstRate: string
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
  billingAddress: string | null
  reference: string | null
  placeOfSupplyCode: string | null
  salesperson: string | null
  brokerId: string | null
  brokeragePercent: string | number | null
  discountAmount: string | number
  otherCharges: string | number
  isJobWork: boolean
  notes: string | null
  terms: string | null
  charges: Array<{ chargeTypeId: string; amount: string | number; gstRate: string | number }>
  lines: Array<{
    id: string
    itemId: string
    styleCode: string | null
    color: string | null
    gender: string | null
    fabric: string | null
    printName: string | null
    description: string | null
    taxExempt: boolean
    totalQty: string | number
    unitPrice: string | number
    discount: string | number
    sizes: Array<{ sizeId: string; qty: string | number }>
  }>
}

type LastRates = Record<string, { unitPrice: number; soNumber: string; orderDate: string }>

const GENDERS: Array<[string, string]> = [
  ['MALE', "Men's"],
  ['FEMALE', "Women's"],
  ['UNISEX', 'Unisex'],
]

let lineKey = 0
const blankLine = (): LineDraft => ({
  key: `l${++lineKey}`,
  categoryId: '',
  subcategoryId: '',
  styleId: '',
  styleCode: '',
  itemId: '',
  sizeGroupId: '',
  sizes: {},
  qty: '',
  unitPrice: '',
  discount: '',
  color: '',
  gender: '',
  fabric: '',
  printName: '',
  description: '',
  taxExempt: false,
})
const blankCharge = (): ChargeDraft => ({ key: `c${++lineKey}`, chargeTypeId: '', amount: '', gstRate: '' })

const today = () => new Date().toISOString().slice(0, 10)
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '')
const round2 = (n: number) => Math.round(n * 100) / 100
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num = (v: string | number | null | undefined) => (v == null || v === '' ? '' : String(Number(v)))

/** Column widths of the line table, as on the purchase order form. */
const COL = {
  num: 'w-8',
  remove: 'w-8',
  category: 'w-40',
  item: 'w-64',
  style: 'w-32',
  colour: 'w-32',
  gender: 'w-24',
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

/** A small caption over a box inside a line's detail row. */
function Mini({ label, className = '', children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="text-muted-foreground mb-0.5 block text-[10px] font-semibold uppercase tracking-wider">{label}</span>
      {children}
    </label>
  )
}

/**
 * The sales order form: a new order, a draft not yet confirmed, or an
 * amendment to a confirmed order (`amend`), which keeps the old version.
 *
 * Laid out like the purchase order form and carrying what the mill's old
 * system did. Basic Details in five columns: order no., date, customer, type
 * and brand; then broker, brokerage, the buyer's PO and the salesperson; then
 * where it goes and when; then the bill-to address and a reference. The
 * customer is read back under them, with the place of supply.
 *
 * A line is found the way Purchase finds one, every box tied to the others:
 * category and sub-category narrow the items and styles, and picking an item
 * by code or name fills the rest. Under each line sit its sizes (the style's
 * run, or one picked for a garment with none), fabric, print name,
 * description and whether it is exempt from GST. Every number box steps with
 * the mouse wheel and the arrow keys, and none goes below nothing.
 *
 * Charges are picked from Masters → Charges, each with its own GST, as on the
 * purchase bill; other charges carry no tax. Files and terms sit beside the
 * totals. Saving is Save as draft, or Confirm order — a manager is involved
 * only when the customer is over their credit limit or blacklisted.
 *
 * GST is shown as the server will charge it, but the server works it out
 * again on save — this screen's figures are a preview, never the record.
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
  const [chargeTypes, setChargeTypes] = useState<ChargeTypeOption[]>([])
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
  const [reference, setReference] = useState('')
  const [brokerId, setBrokerId] = useState('')
  const [brokerPct, setBrokerPct] = useState('')
  const [salesperson, setSalesperson] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [billingAddress, setBillingAddress] = useState('')
  /** A state picked for this order, or '' for the customer's own. */
  const [placeOfSupply, setPlaceOfSupply] = useState('')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState('')
  const [billDiscount, setBillDiscount] = useState('')
  const [charges, setCharges] = useState<ChargeDraft[]>([])
  const [otherCharges, setOtherCharges] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([blankLine()])
  const filesRef = useRef<AttachmentsBoxHandle>(null)

  // Once somebody has changed one of these by hand, picking a different
  // customer no longer overwrites it.
  const [typeTouched, setTypeTouched] = useState(false)
  const [brokerTouched, setBrokerTouched] = useState(false)
  const [addressTouched, setAddressTouched] = useState(false)
  const [billingTouched, setBillingTouched] = useState(false)

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
  const groupById = useMemo(() => new Map(sizeGroups.map((g) => [g.id, g])), [sizeGroups])
  const sizesOfGroup = useMemo(
    () => new Map(sizeGroups.map((g) => [g.id, [...g.sizes].sort((a, b) => a.sequence - b.sequence)])),
    [sizeGroups]
  )
  /** Size runs that have sizes in them, to pick from on a line. */
  const runChoices = useMemo(() => sizeGroups.filter((g) => g.sizes.length > 0), [sizeGroups])
  const chargeTypeById = useMemo(() => new Map(chargeTypes.map((c) => [c.id, c])), [chargeTypes])

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
    setReference('')
    setBrokerId('')
    setBrokerPct('')
    setSalesperson('')
    setDeliveryAddress('')
    setBillingAddress('')
    setPlaceOfSupply('')
    setNotes('')
    setTerms('')
    setBillDiscount('')
    setCharges([])
    setOtherCharges('')
    setLines([blankLine()])
    setTypeTouched(false)
    setBrokerTouched(false)
    setAddressTouched(false)
    setBillingTouched(false)
    setContext(null)
    setLastRates({})
    setAmendReason('')
    setLoadingLists(true)

    void (async () => {
      try {
        const [c, b, br, it, cat, st, sg, ct, order] = await Promise.all([
          fetchEveryPage<CustomerOption>((p) => `/masters/customers?active=true&limit=200&page=${p}`),
          api.get<{ data: BrandOption[] }>('/masters/brands?active=true&limit=200'),
          fetchEveryPage<BrokerOption>((p) => `/masters/brokers?active=true&limit=200&page=${p}`),
          fetchEveryPage<ItemOption>(
            (p) => `/masters/items?type=FINISHED_GOOD&active=true&limit=200&page=${p}&sort=name&order=asc`
          ),
          fetchEveryPage<CategoryOption>((p) => `/masters/item-categories?limit=200&page=${p}`),
          fetchEveryPage<StyleOption>((p) => `/masters/styles?limit=200&page=${p}`),
          fetchEveryPage<SizeGroupOption>((p) => `/masters/size-groups?limit=200&page=${p}`),
          // The charge rows are the charge master's: a failure costs the
          // charges box, not the form.
          fetchEveryPage<ChargeTypeOption>((p) => `/masters/charge-types?limit=200&page=${p}`).catch(() => ({
            rows: [] as ChargeTypeOption[],
          })),
          orderId ? api.get<{ data: SavedOrder }>(`/sales/orders/${orderId}`) : Promise.resolve(null),
        ])
        if (!alive) return
        const itemMap = new Map(it.rows.map((i) => [i.id, i]))
        const styleMap = new Map(st.rows.map((s) => [s.id, s]))
        const groupOfSize = new Map(sg.rows.flatMap((g) => g.sizes.map((s) => [s.id, g.id] as const)))
        const customerList = [...c.rows].sort((x, y) => x.name.localeCompare(y.name))
        setCustomers(customerList)
        setBrands(b.data)
        setBrokers([...br.rows].sort((x, y) => x.name.localeCompare(y.name)))
        setItems(it.rows)
        setCategories([...cat.rows].sort((x, y) => x.name.localeCompare(y.name)))
        setStyles([...st.rows].sort((x, y) => x.code.localeCompare(y.code)))
        setSizeGroups(sg.rows)
        setChargeTypes(
          ct.rows.filter((x) => x.isActive && x.applyOnSale).sort((x, y) => x.name.localeCompare(y.name))
        )

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
          setReference(o.reference ?? '')
          setBrokerId(o.brokerId ?? '')
          setBrokerPct(o.brokeragePercent != null ? String(Number(o.brokeragePercent)) : '')
          setSalesperson(o.salesperson ?? '')
          setDeliveryAddress(o.deliveryAddress ?? '')
          const cust = customerList.find((x) => x.id === o.customerId)
          setBillingAddress(o.billingAddress ?? (cust ? billingAddressOf(cust) : ''))
          // Kept only when it is not simply the customer's own state.
          const own = cust ? cust.shippingStateCode || cust.billingStateCode || cust.gstin?.slice(0, 2) : null
          setPlaceOfSupply(o.placeOfSupplyCode && o.placeOfSupplyCode !== own ? o.placeOfSupplyCode : '')
          setNotes(o.notes ?? '')
          setTerms(o.terms ?? '')
          setBillDiscount(Number(o.discountAmount) > 0 ? String(Number(o.discountAmount)) : '')
          setOtherCharges(Number(o.otherCharges) > 0 ? String(Number(o.otherCharges)) : '')
          setCharges(
            (o.charges ?? []).map((x) => ({
              key: `c${++lineKey}`,
              chargeTypeId: x.chargeTypeId,
              amount: num(x.amount),
              gstRate: num(x.gstRate),
            }))
          )
          setLines(
            o.lines.length
              ? o.lines.map((l) => {
                  const item = itemMap.get(l.itemId)
                  const styleRun = item?.styleId ? styleMap.get(item.styleId)?.sizeGroupId : null
                  return {
                    ...blankLine(),
                    id: l.id,
                    ...filingOf(item, cat.rows),
                    styleId: item?.styleId ?? '',
                    styleCode: l.styleCode ?? (item?.styleId ? (styleMap.get(item.styleId)?.code ?? '') : ''),
                    itemId: l.itemId,
                    // A garment with no run of its own: the run its sizes came from.
                    sizeGroupId: !styleRun && l.sizes.length ? (groupOfSize.get(l.sizes[0].sizeId) ?? '') : '',
                    sizes: Object.fromEntries(l.sizes.map((s) => [s.sizeId, String(Number(s.qty))])),
                    qty: l.sizes.length ? '' : String(Number(l.totalQty)),
                    unitPrice: String(Number(l.unitPrice)),
                    discount: Number(l.discount) > 0 ? String(Number(l.discount)) : '',
                    color: item?.color ? '' : (l.color ?? ''),
                    gender: l.gender ?? '',
                    fabric: l.fabric ?? '',
                    printName: l.printName ?? '',
                    description: l.description ?? '',
                    taxExempt: l.taxExempt,
                  }
                })
              : [blankLine()]
          )
          // A saved draft's choices are its own: do not overwrite them.
          setTypeTouched(true)
          setBrokerTouched(true)
          setAddressTouched(true)
          setBillingTouched(true)
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

  // Each customer (or place of supply) picked: how they are taxed, their
  // credit, and their last rates.
  useEffect(() => {
    if (!open || !customerId) {
      setContext(null)
      setLastRates({})
      return
    }
    let alive = true
    setContextLoading(true)
    const qs = placeOfSupply ? `?state=${placeOfSupply}` : ''
    void Promise.all([
      api.get<{ data: CustomerContext }>(`/sales/customers/${customerId}/context${qs}`),
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
  }, [open, customerId, placeOfSupply])

  const customer = customers.find((c) => c.id === customerId) ?? null

  /**
   * A line's size run: its style's own when it has one (`fixed`), else the run
   * picked on the line, else none — and then the pieces are one figure.
   */
  const runOf = (line: LineDraft, item: ItemOption | undefined) => {
    const styleRun = item?.styleId ? styleById.get(item.styleId)?.sizeGroupId : null
    const groupId = styleRun || line.sizeGroupId || null
    const run = groupId ? sizesOfGroup.get(groupId) : null
    return { run: run && run.length ? (run as SizeOption[]) : null, fixed: !!styleRun, groupId }
  }

  const pickCustomer = (id: string) => {
    setCustomerId(id)
    setPlaceOfSupply('')
    const c = customers.find((x) => x.id === id)
    if (!c) return
    if (!typeTouched) setIsJobWork(c.type === 'JOB_WORK')
    if (!addressTouched) setDeliveryAddress(deliveryAddressOf(c))
    if (!billingTouched) setBillingAddress(billingAddressOf(c))
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

  const setLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  /** What a newly picked item brings to its line: gender from its size run, fabric from its style. */
  const defaultsFrom = (item: ItemOption | undefined, line: LineDraft): Partial<LineDraft> => {
    const style = item?.styleId ? styleById.get(item.styleId) : undefined
    const run = style?.sizeGroupId ? groupById.get(style.sizeGroupId) : undefined
    return {
      gender: line.gender || run?.gender || '',
      fabric: line.fabric || style?.fabricType || '',
    }
  }

  /** Picking the item by its code or its name fills the rest of the row from it. */
  const pickItem = (key: string, itemId: string) => {
    setError(null)
    const line = lines.find((l) => l.key === key)
    if (!line) return
    if (!itemId) {
      setLine(key, { itemId: '', sizes: {}, qty: '', sizeGroupId: '' })
      return
    }
    // The same garment on two rows is nearly always a slip, and makes the
    // order hard to check against the buyer's PO.
    if (lines.some((l) => l.key !== key && l.itemId === itemId)) {
      setError(`${itemById.get(itemId)?.code ?? 'That item'} is already on another row. Change the pieces there instead.`)
      return
    }
    const item = itemById.get(itemId)
    const before = itemById.get(line.itemId)
    // Another colour of the same style keeps the size run, so its sizes stay.
    const sameRun = !!before?.styleId && before.styleId === item?.styleId
    setLine(key, {
      itemId,
      ...filingOf(item),
      styleId: item?.styleId ?? '',
      // The item's own style when it has one; a typed one stays otherwise.
      styleCode: (item?.styleId ? styleById.get(item.styleId)?.code : null) ?? line.styleCode,
      ...defaultsFrom(item, line),
      ...(line.itemId !== itemId && !sameRun ? { sizes: {}, qty: '', sizeGroupId: '' } : {}),
    })
  }

  /** A narrower box keeps the item only if the item still fits it. */
  const narrow = (key: string, patch: Partial<LineDraft>) => {
    const line = lines.find((l) => l.key === key)
    if (!line) return
    const next = { ...line, ...patch }
    const keeps = !!line.itemId && itemsFor(next).some((it) => it.id === line.itemId)
    setLine(key, { ...patch, ...(keeps ? {} : { itemId: '', sizes: {}, qty: '', sizeGroupId: '' }) })
  }

  /**
   * The style number typed. One that is in the style master narrows the items
   * to that style, and with only one colour picks it; anything else is kept
   * as typed and narrows nothing.
   */
  const typeStyle = (key: string, styleCode: string) => {
    const line = lines.find((l) => l.key === key)
    if (!line) return
    const typed = styleCode.trim().toLowerCase()
    const styleId = (typed && styles.find((st) => st.code.toLowerCase() === typed)?.id) || ''
    const next = { ...line, styleCode, styleId }
    const choices = itemsFor(next)
    if (styleId && choices.length === 1 && !lines.some((l) => l.key !== key && l.itemId === choices[0].id)) {
      const item = choices[0]
      setLine(key, {
        styleCode,
        styleId,
        itemId: item.id,
        ...filingOf(item),
        ...defaultsFrom(item, line),
        ...(line.itemId !== item.id ? { sizes: {}, qty: '', sizeGroupId: '' } : {}),
      })
      return
    }
    // An item of a different style no longer fits once a known style is typed.
    narrow(key, { styleCode, styleId })
  }

  /** A size run picked on a line whose style has none. */
  const pickRun = (key: string, sizeGroupId: string) => {
    const line = lines.find((l) => l.key === key)
    if (!line) return
    const group = groupById.get(sizeGroupId)
    setLine(key, { sizeGroupId, sizes: {}, qty: '', gender: line.gender || group?.gender || '' })
  }

  // ── Figures, as the server will work them out ─────────────────────────
  const totals = useMemo(() => {
    const priced = lines.map((l) => {
      const item = itemById.get(l.itemId)
      const { run, fixed, groupId } = runOf(l, item)
      const qty = run ? sumSizes(l.sizes) : Number(l.qty) || 0
      const rate = Number(l.unitPrice) || 0
      const disc = Math.min(100, Math.max(0, Number(l.discount) || 0))
      return { line: l, item, run, fixed, groupId, qty, rate, disc, amount: round2(qty * rate * (1 - disc / 100)) }
    })
    const subtotal = round2(priced.reduce((s, p) => s + p.amount, 0))
    const discount = round2(Math.min(Number(billDiscount) || 0, subtotal))
    const taxable = round2(subtotal - discount)
    const factor = subtotal > 0 ? taxable / subtotal : 1

    let goodsTax = 0
    const withGst = priced.map((p) => {
      // Garments carry one rate up to a price per piece and another above it.
      let gst: number | null = null
      if (p.line.taxExempt) {
        gst = 0
      } else if (p.item?.hsn) {
        const perPiece = p.rate * (1 - p.disc / 100) * factor
        const { gstRate, priceLimit, rateAbove } = p.item.hsn
        gst =
          priceLimit != null && rateAbove != null && perPiece > Number(priceLimit) ? Number(rateAbove) : Number(gstRate)
      } else if (p.item?.taxRate) {
        gst = Number(p.item.taxRate.rate)
      }
      goodsTax += p.amount * factor * ((gst ?? 0) / 100)
      return { ...p, gst }
    })

    // Each charge at its own rate: the one typed, else the charge master's.
    const chargeRows = charges.map((c) => {
      const type = chargeTypeById.get(c.chargeTypeId)
      const amount = Number(c.amount) || 0
      const gstRate = c.gstRate !== '' ? Number(c.gstRate) || 0 : Number(type?.defaultGstRate ?? 0)
      return { ...c, type, value: amount, rate: gstRate, tax: (amount * gstRate) / 100 }
    })
    const chargeTotal = round2(chargeRows.reduce((s, c) => s + (c.type ? c.value : 0), 0))
    const chargeTax = chargeRows.reduce((s, c) => s + (c.type ? c.tax : 0), 0)

    const tax = goodsTax + chargeTax
    const intra = context?.placeOfSupply?.isIntraState
    const half = round2(tax / 2)
    const cgst = intra ? half : 0
    const sgst = intra ? half : 0
    const igst = intra === false ? round2(tax) : 0
    const taxTotal = intra === undefined ? round2(tax) : cgst + sgst + igst
    const other = round2(Number(otherCharges) || 0)
    const beforeRounding = taxable + chargeTotal + taxTotal + other
    const total = Math.round(beforeRounding)
    const pieces = priced.reduce((s, p) => s + p.qty, 0)
    const brokerage = round2((taxable * (Number(brokerPct) || 0)) / 100)

    return {
      lines: withGst,
      subtotal,
      discount,
      taxable,
      chargeRows,
      chargeTotal,
      cgst,
      sgst,
      igst,
      taxTotal,
      other,
      roundOff: round2(total - beforeRounding),
      total,
      pieces,
      brokerage,
    }
    // runOf reads the maps listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, itemById, styleById, sizesOfGroup, billDiscount, brokerPct, context, charges, chargeTypeById, otherCharges])

  // ── What still stops a save ────────────────────────────────────────────
  const filled = totals.lines.filter((p) => p.line.itemId)
  const unfinished = filled.filter((p) => p.qty <= 0 || p.line.unitPrice.trim() === '')
  const noGst = filled.filter((p) => p.gst === null)
  const chargeNoType = totals.chargeRows.find((c) => !c.type && c.value > 0)
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
              ? `${noGst[0].item?.code} has no HSN code or GST rate. Set one on the item in Masters, or tick Tax exempt.`
              : chargeNoType
                ? 'Pick which charge the amount in the totals is for.'
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
      reference: reference.trim() || null,
      deliveryAddress: deliveryAddress.trim() || null,
      billingAddress: billingAddress.trim() || null,
      placeOfSupplyCode: placeOfSupply || null,
      salesperson: salesperson.trim() || null,
      brokerId: brokerId || null,
      brokeragePercent: brokerId ? Number(brokerPct) || 0 : 0,
      discountAmount: Number(billDiscount) || 0,
      notes: notes.trim() || null,
      terms: terms.trim() || null,
      charges: totals.chargeRows
        .filter((c) => c.type && c.value > 0)
        .map((c) => ({ chargeTypeId: c.chargeTypeId, amount: c.value, gstRate: c.gstRate !== '' ? c.rate : null })),
      otherCharges: totals.other,
      confirm,
      creditReleaseReason: creditReleaseReason ?? null,
      // Rows with no item picked are a blank row, not a line.
      lines: filled.map((p) => ({
        // On an amendment each saved line keeps its id, so it stays the same
        // line from one version to the next.
        ...(amend && p.line.id ? { id: p.line.id } : {}),
        itemId: p.line.itemId,
        styleCode: p.line.styleCode.trim() || null,
        color: p.item?.color || p.line.color.trim() || null,
        gender: p.line.gender || null,
        fabric: p.line.fabric.trim() || null,
        printName: p.line.printName.trim() || null,
        description: p.line.description.trim() || null,
        taxExempt: p.line.taxExempt,
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
          ? await api.post<{ message?: string; data: { id: string } }>(`/sales/orders/${saved.id}/amend`, {
              ...body,
              confirm: undefined,
              creditReleaseReason: undefined,
              reason: amendReason.trim(),
            })
          : saved
            ? await api.patch<{ message?: string; data: { id: string } }>(`/sales/orders/${saved.id}`, body)
            : await api.post<{ message?: string; data: { id: string } }>('/sales/orders', body)
      // Files chosen before the order existed go now it has an id. A file
      // that fails does not undo the order: it is named instead.
      const { failed } = (await filesRef.current?.uploadPending(res.data.id)) ?? { failed: [] }
      const base = res.message ?? (confirm ? 'Order confirmed.' : 'Order saved as a draft.')
      onSaved(
        failed.length
          ? `${base} ${failed.length === 1 ? 'A file' : `${failed.length} files`} did not attach: ${failed.join(', ')}.`
          : base
      )
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
  const setCharge = (key: string, patch: Partial<ChargeDraft>) =>
    setCharges((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)))

  /** The boxes of one row, shared by the table and the phone cards. */
  const boxes = (p: (typeof totals.lines)[number], i: number, compact: boolean) => {
    const line = p.line
    const subs = subCategoriesOf(line.categoryId)
    const choices = itemsFor(line)
    const c = compact ? cell : 'form-input'
    const style = p.item?.styleId ? styleById.get(p.item.styleId) : undefined
    // The other colours of this style, each its own item.
    const siblings = p.item?.color && p.item.styleId ? items.filter((it) => it.styleId === p.item!.styleId && it.color) : []
    const sketch = p.item?.imageUrl || style?.imageUrl || null
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
        <input
          className={`${c} font-mono`}
          value={line.styleCode}
          maxLength={50}
          placeholder="Style no."
          title={line.styleId ? styleById.get(line.styleId)?.name : undefined}
          onChange={(e) => typeStyle(line.key, e.target.value)}
          // An item that belongs to a style keeps that style's number: an
          // unknown code typed over it goes back when the box is left.
          onBlur={() => {
            const own = style?.code
            if (own && line.styleCode.trim().toLowerCase() !== own.toLowerCase()) setLine(line.key, { styleCode: own })
          }}
          aria-label={`Row ${i + 1} style number`}
        />
      ),
      // An item that is one colour of a style switches to another colour's
      // item; a garment with no colour of its own takes one typed here.
      colour: !line.itemId ? (
        <input className={c} disabled placeholder="Colour" aria-label={`Row ${i + 1} colour`} />
      ) : p.item?.color ? (
        siblings.length > 1 ? (
          <SmartSelect
            className={c}
            value={line.itemId}
            onChange={(e) => pickItem(line.key, e.target.value)}
            aria-label={`Row ${i + 1} colour`}
          >
            {siblings.map((it) => (
              <option key={it.id} value={it.id} data-sub={it.code}>
                {it.color}
              </option>
            ))}
          </SmartSelect>
        ) : (
          <div className={`${c} flex items-center truncate`} title={p.item.color}>
            {p.item.color}
          </div>
        )
      ) : (
        <SuggestInput
          className={c}
          value={line.color}
          maxLength={50}
          placeholder="Colour"
          suggestions={(style?.colors ?? []).map((v) => ({ value: v }))}
          onValueChange={(v) => setLine(line.key, { color: v })}
          aria-label={`Row ${i + 1} colour`}
        />
      ),
      gender: (
        <SmartSelect
          className={c}
          value={line.gender}
          disabled={!line.itemId}
          onChange={(e) => setLine(line.key, { gender: e.target.value })}
          aria-label={`Row ${i + 1} gender`}
        >
          <option value="">Gender</option>
          {GENDERS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </SmartSelect>
      ),
      pieces: p.run ? (
        // With a size run the pieces are what the sizes add up to.
        <div
          className={`flex h-8 items-center justify-end text-xs font-semibold tabular-nums ${
            line.itemId && p.qty <= 0 ? 'warn-text' : 'text-foreground'
          }`}
          title="The sizes add up to this"
        >
          {p.qty ? p.qty.toLocaleString('en-IN') : '0'}
        </div>
      ) : (
        <StepInput
          className={`${c} text-right tabular-nums ${line.itemId && p.qty <= 0 ? 'border-destructive/50' : ''}`}
          value={line.qty}
          placeholder="0"
          disabled={!line.itemId}
          aria-label={`Row ${i + 1} pieces`}
          onValueChange={(v) => setLine(line.key, { qty: v })}
        />
      ),
      rate: (
        <StepInput
          decimals
          className={`${c} text-right tabular-nums ${line.itemId && line.unitPrice.trim() === '' ? 'border-destructive/50' : ''}`}
          value={line.unitPrice}
          placeholder="0.00"
          aria-label={`Row ${i + 1} ${rateLabel}`}
          onValueChange={(v) => setLine(line.key, { unitPrice: v })}
        />
      ),
      discount: (
        <StepInput
          decimals
          max={100}
          className={`${c} text-right tabular-nums`}
          value={line.discount}
          placeholder="0"
          aria-label={`Row ${i + 1} discount percent`}
          onValueChange={(v) => setLine(line.key, { discount: v })}
        />
      ),
      // The size run: the style's own, or one picked here.
      runPicker: p.fixed ? (
        <span className="text-muted-foreground text-[11px]">{groupById.get(p.groupId ?? '')?.name}</span>
      ) : (
        <SmartSelect
          className={`${cell} w-48`}
          value={line.sizeGroupId}
          onChange={(e) => pickRun(line.key, e.target.value)}
          aria-label={`Row ${i + 1} size run`}
        >
          <option value="">No sizes (pieces only)</option>
          {runChoices.map((g) => (
            <option key={g.id} value={g.id} data-sub={g.sizes.map((s) => s.code).join(' ')}>
              {g.name}
            </option>
          ))}
        </SmartSelect>
      ),
      fabric: (
        <SuggestInput
          className={cell}
          value={line.fabric}
          maxLength={80}
          placeholder="Cotton poplin"
          suggestions={[...new Set(styles.map((s) => s.fabricType).filter((f): f is string => !!f))].map((v) => ({ value: v }))}
          onValueChange={(v) => setLine(line.key, { fabric: v })}
          aria-label={`Row ${i + 1} fabric`}
        />
      ),
      printName: (
        <input
          className={cell}
          value={line.printName}
          maxLength={80}
          placeholder="As the buyer calls it"
          onChange={(e) => setLine(line.key, { printName: e.target.value })}
          aria-label={`Row ${i + 1} print name`}
        />
      ),
      description: (
        <input
          className={cell}
          value={line.description}
          maxLength={500}
          placeholder="Anything else about this line: labels, packing, wash"
          onChange={(e) => setLine(line.key, { description: e.target.value })}
          aria-label={`Row ${i + 1} description`}
        />
      ),
      exempt: (
        <label className="flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs">
          <input
            type="checkbox"
            className="accent-primary h-3.5 w-3.5"
            checked={line.taxExempt}
            onChange={(e) => setLine(line.key, { taxExempt: e.target.checked })}
          />
          Tax exempt
        </label>
      ),
      sketch: sketch ? (
        <a href={sketch} target="_blank" rel="noreferrer" title="Open the sketch" className="shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sketch} alt="" className="border-border h-12 w-12 rounded-md border object-cover" />
        </a>
      ) : (
        <div
          className="border-border text-muted-foreground flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-dashed"
          title="No sketch on the style or item yet"
        >
          <ImageIcon size={16} />
        </div>
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
              {/* 1 — Who the order is from, what it answers to, where it goes. */}
              <Section icon={FileText} title="Basic Details">
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
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
                  <Field label="Customer" icon={User} htmlFor="so-customer" required>
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
                  <Field
                    label="Order type"
                    icon={Package}
                    htmlFor="so-type"
                    help={isJobWork ? 'The customer sends their fabric; we bill the job charge.' : undefined}
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
                      <option value="job">Job work (customer&apos;s fabric)</option>
                    </SmartSelect>
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
                    <StepInput
                      id="so-brokerage"
                      decimals
                      max={100}
                      className="form-input text-right tabular-nums"
                      value={brokerId ? brokerPct : ''}
                      disabled={!brokerId}
                      placeholder={brokerId ? '0' : '—'}
                      onValueChange={(v) => {
                        setBrokerTouched(true)
                        setBrokerPct(v)
                      }}
                    />
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

                  <Field label="Ship to (deliver to)" icon={MapPin} htmlFor="so-address" className="sm:col-span-2 lg:col-span-4">
                    <input
                      id="so-address"
                      className="form-input pl-9"
                      value={deliveryAddress}
                      maxLength={500}
                      placeholder="From the customer's shipping address; change it for this order only"
                      onChange={(e) => {
                        setAddressTouched(true)
                        setDeliveryAddress(e.target.value)
                      }}
                    />
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

                  <Field label="Bill to" icon={Receipt} htmlFor="so-billing" className="sm:col-span-2 lg:col-span-4">
                    <input
                      id="so-billing"
                      className="form-input pl-9"
                      value={billingAddress}
                      maxLength={500}
                      placeholder="From the customer's billing address; change it for this order only"
                      onChange={(e) => {
                        setBillingTouched(true)
                        setBillingAddress(e.target.value)
                      }}
                    />
                  </Field>
                  <Field label="Reference" icon={Hash} htmlFor="so-reference">
                    <input
                      id="so-reference"
                      className="form-input pl-9"
                      value={reference}
                      maxLength={80}
                      placeholder="Optional"
                      onChange={(e) => setReference(e.target.value)}
                    />
                  </Field>
                </div>

                {customer && (
                  <div className="mt-3">
                    <CustomerPanel
                      customer={customer}
                      context={context}
                      loading={contextLoading}
                      orderValue={totals.total}
                      placeOfSupply={placeOfSupply}
                      onPlaceOfSupply={setPlaceOfSupply}
                    />
                  </div>
                )}
              </Section>

              {/* 2 — The lines, entered where they are shown, as on the
                purchase order. Under each picked line: its sizes, fabric,
                print name, description and tax exemption. */}
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
                  <table className="w-full min-w-[1240px] table-fixed border-collapse text-sm">
                    <thead>
                      <tr className="bg-secondary">
                        {[
                          ['#', `${COL.num} sticky left-0 z-20 bg-secondary`, 'left'],
                          ['', `${COL.remove} sticky left-8 z-20 bg-secondary`, 'left'],
                          ['Category', COL.category, 'left'],
                          ['Item', `${COL.item} border-border border-r`, 'left'],
                          ['Style no.', COL.style, 'left'],
                          ['Colour', COL.colour, 'left'],
                          ['Gender', COL.gender, 'left'],
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
                        const f = boxes(p, i, true)
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
                              <td className={COL.colour}>{f.colour}</td>
                              <td className={COL.gender}>{f.gender}</td>
                              <td className={COL.qty}>{f.pieces}</td>
                              <td className={COL.rate}>
                                {f.rate}
                                {lastRateHint(p.line.itemId)}
                              </td>
                              <td className={COL.discount}>{f.discount}</td>
                              <td className={COL.tax}>
                                <div className="flex h-8 items-center justify-end text-xs tabular-nums">
                                  {p.line.taxExempt ? (
                                    <span className="text-muted-foreground" title="Tax exempt">
                                      Nil
                                    </span>
                                  ) : p.gst != null ? (
                                    `${p.gst}%`
                                  ) : p.line.itemId ? (
                                    <span className="warn-text">none</span>
                                  ) : (
                                    '—'
                                  )}
                                </div>
                              </td>
                              <td className={COL.amount}>
                                <div className="text-foreground flex h-8 items-center justify-end text-xs font-semibold tabular-nums">
                                  {p.amount ? inr(p.amount) : '—'}
                                </div>
                              </td>
                            </tr>
                            {/* The rest of the line, under it: sizes first, then
                              what the old system's columns held. */}
                            {p.line.itemId && (
                              <tr className={zebra}>
                                <td className="sticky left-0 z-10 bg-inherit" />
                                <td className="sticky left-8 z-10 bg-inherit" />
                                <td colSpan={10} className="px-2 pb-2.5 pt-0">
                                  <div className="border-border bg-secondary/40 space-y-2 rounded-lg border px-3 py-2">
                                    <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                                      <Mini label="Size run">{f.runPicker}</Mini>
                                      {p.run && (
                                        <>
                                          <SizeQtyGrid
                                            sizes={p.run}
                                            values={p.line.sizes}
                                            name={`Row ${i + 1}`}
                                            onChange={(sizeId, v) =>
                                              setLine(p.line.key, { sizes: { ...p.line.sizes, [sizeId]: v } })
                                            }
                                          />
                                          <span className="text-foreground ml-auto self-center text-xs font-semibold tabular-nums">
                                            = {p.qty.toLocaleString('en-IN')} pcs
                                          </span>
                                        </>
                                      )}
                                    </div>
                                    <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                                      <Mini label="Fabric" className="w-44">
                                        {f.fabric}
                                      </Mini>
                                      <Mini label="Print name" className="w-40">
                                        {f.printName}
                                      </Mini>
                                      <Mini label="Description" className="min-w-[14rem] flex-1">
                                        {f.description}
                                      </Mini>
                                      {f.exempt}
                                      {f.sketch}
                                    </div>
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

                {/* On a phone, a card per line. */}
                <div className="space-y-3 sm:hidden">
                  {totals.lines.map((p, i) => {
                    const f = boxes(p, i, false)
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
                        {p.line.itemId && (
                          <>
                            <div className="grid grid-cols-2 gap-2">
                              {f.colour}
                              {f.gender}
                            </div>
                            <Mini label="Size run">{f.runPicker}</Mini>
                            {p.run ? (
                              <SizeQtyGrid
                                layout="grid"
                                sizes={p.run}
                                values={p.line.sizes}
                                name={`Row ${i + 1}`}
                                onChange={(sizeId, v) => setLine(p.line.key, { sizes: { ...p.line.sizes, [sizeId]: v } })}
                              />
                            ) : (
                              <Mini label="Pieces">{f.pieces}</Mini>
                            )}
                          </>
                        )}
                        <div className="grid grid-cols-2 gap-2">
                          <Mini label={`${rateLabel} ₹/pc`}>
                            {f.rate}
                            {lastRateHint(p.line.itemId)}
                          </Mini>
                          <Mini label="Disc %">{f.discount}</Mini>
                        </div>
                        {p.line.itemId && (
                          <>
                            <div className="grid grid-cols-2 gap-2">
                              <Mini label="Fabric">{f.fabric}</Mini>
                              <Mini label="Print name">{f.printName}</Mini>
                            </div>
                            <Mini label="Description">{f.description}</Mini>
                            <div className="flex items-center justify-between">
                              {f.exempt}
                              {f.sketch}
                            </div>
                          </>
                        )}
                        <div className="border-border flex items-center justify-between border-t pt-2 text-xs">
                          <span className="text-muted-foreground tabular-nums">
                            {p.qty.toLocaleString('en-IN')} pcs
                            {p.line.taxExempt ? ' · Tax exempt' : p.gst != null ? ` · GST ${p.gst}%` : ''}
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

              {/* 3 — Notes, terms and files beside the figures. */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_440px]">
                <div className="space-y-3">
                  <Section icon={StickyNote} title="Notes and terms">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <label className="block">
                        <span className="form-label">Notes (printed on the order)</span>
                        <textarea
                          className="form-input min-h-[6rem]"
                          rows={4}
                          maxLength={1000}
                          value={notes}
                          placeholder="Packing instructions, labels, special checks"
                          onChange={(e) => setNotes(e.target.value)}
                        />
                      </label>
                      <label className="block">
                        <span className="form-label">Terms and conditions</span>
                        <textarea
                          className="form-input min-h-[6rem]"
                          rows={4}
                          maxLength={2000}
                          value={terms}
                          placeholder="Leave empty to print the standard terms"
                          onChange={(e) => setTerms(e.target.value)}
                        />
                      </label>
                    </div>
                    <p className="text-muted-foreground mt-2 text-[11px]">
                      Printed on the Sales Order template.{' '}
                      <a href="/settings/documents" target="_blank" rel="noreferrer" className="text-primary underline">
                        Edit the template and the standard terms
                      </a>
                      .
                    </p>
                  </Section>
                  <Section icon={Paperclip} title="Attachments">
                    <AttachmentsBox
                      ref={filesRef}
                      basePath="/sales/orders"
                      linkBasePath="/sales/order-attachments"
                      recordId={saved?.id}
                      onError={setError}
                    />
                  </Section>
                </div>

                <Section icon={Calculator} title="Totals">
                  <div className="space-y-1.5 text-sm">
                    <TotalRow label={`Value of ${totals.pieces.toLocaleString('en-IN')} pcs`} value={inr(totals.subtotal)} />
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="so-bill-discount" className="text-muted-foreground">
                        Discount on the whole order (₹)
                      </label>
                      <StepInput
                        id="so-bill-discount"
                        decimals
                        className="form-input h-8 w-28 text-right tabular-nums"
                        value={billDiscount}
                        placeholder="0.00"
                        onValueChange={setBillDiscount}
                      />
                    </div>
                    <TotalRow label="Gross total" value={inr(totals.taxable)} />

                    {/* Charges picked from the charge master, as on the purchase
                      bill: the charge, its amount, and its GST. */}
                    {chargeTypes.length === 0 ? (
                      <p className="text-muted-foreground py-1 text-xs">
                        No sales charges set up yet. Add them under{' '}
                        <a href="/masters/charges" target="_blank" rel="noreferrer" className="text-primary underline">
                          Masters → Charges
                        </a>{' '}
                        with &quot;On sales&quot; ticked.
                      </p>
                    ) : (
                      <div className="space-y-1.5 py-0.5">
                        {totals.chargeRows.map((c, i) => {
                          const taken = new Set(charges.filter((x) => x.key !== c.key).map((x) => x.chargeTypeId))
                          return (
                            <div key={c.key} className="flex items-center gap-1.5">
                              <SmartSelect
                                className="form-input h-8 min-w-0 flex-1 text-xs"
                                value={c.chargeTypeId}
                                onChange={(e) => setCharge(c.key, { chargeTypeId: e.target.value, gstRate: '' })}
                                aria-label={`Charge ${i + 1}`}
                              >
                                <option value="">Charge…</option>
                                {chargeTypes
                                  .filter((ct) => !taken.has(ct.id))
                                  .map((ct) => (
                                    <option key={ct.id} value={ct.id}>
                                      {ct.name} @ {Number(ct.defaultGstRate)}%
                                    </option>
                                  ))}
                              </SmartSelect>
                              <StepInput
                                decimals
                                className="form-input h-8 w-24 shrink-0 text-right text-xs tabular-nums"
                                placeholder="Amount"
                                value={c.amount}
                                onValueChange={(v) => setCharge(c.key, { amount: v })}
                                aria-label={`Charge ${i + 1} amount`}
                              />
                              <StepInput
                                decimals
                                max={100}
                                className="form-input h-8 w-14 shrink-0 text-right text-xs tabular-nums"
                                placeholder={c.type ? String(Number(c.type.defaultGstRate)) : 'GST%'}
                                value={c.gstRate}
                                onValueChange={(v) => setCharge(c.key, { gstRate: v })}
                                aria-label={`Charge ${i + 1} GST rate`}
                                title="GST % on this charge"
                              />
                              <button
                                type="button"
                                onClick={() => setCharges((cs) => cs.filter((x) => x.key !== c.key))}
                                className="btn-ghost text-muted-foreground hover:text-destructive shrink-0 p-1"
                                aria-label={`Remove charge ${i + 1}`}
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          )
                        })}
                        {charges.length < chargeTypes.length && (
                          <button
                            type="button"
                            onClick={() => setCharges((cs) => [...cs, blankCharge()])}
                            className="text-muted-foreground hover:text-primary flex items-center gap-1 text-xs transition-colors"
                          >
                            <Plus size={12} /> Add charge
                          </button>
                        )}
                      </div>
                    )}

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
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="so-other" className="text-muted-foreground">
                        Other charges (no GST)
                      </label>
                      <StepInput
                        id="so-other"
                        decimals
                        className="form-input h-8 w-28 text-right tabular-nums"
                        value={otherCharges}
                        placeholder="0.00"
                        onValueChange={setOtherCharges}
                      />
                    </div>
                    {Math.abs(totals.roundOff) >= 0.005 && <TotalRow label="Rounding" value={inr(totals.roundOff)} quiet />}
                    <div className="border-primary/20 bg-primary/5 mt-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                      <span className="text-foreground font-semibold">Net total</span>
                      <span className="text-foreground whitespace-nowrap text-lg font-semibold tabular-nums">
                        {formatRupees(totals.total)}
                      </span>
                    </div>
                    {brokerId && Number(brokerPct) > 0 && (
                      <p className="text-muted-foreground pt-1 text-xs">
                        Brokerage {Number(brokerPct)}% · {formatRupees(totals.brokerage)} on the gross total. Internal:
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
