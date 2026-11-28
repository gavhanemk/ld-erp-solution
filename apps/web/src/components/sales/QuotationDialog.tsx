'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Calculator, Copy, FileText, Hash, Loader2, Lock, Package, Pencil, Plus, Save, Send, StickyNote, Tag, Trash2, User, X } from 'lucide-react'
import { loadInHouseBrands, otherBrandLines, suggestedBrand, type OwnBrand } from '@/components/sales/brand'
import { api, ApiError, apiErrorMessage, can } from '@/lib/api'
import { fetchEveryPage } from '@/lib/export'
import { formatRupees } from '@/lib/utils'
import { useEscape } from '@/lib/useEscape'
import { useDialogFocus } from '@/lib/keys'
import { Section } from '@/components/purchase/Section'
import { MasterFormDialog } from '@/components/masters/MasterFormDialog'
import { BomFormDialog, type Bom } from '@/components/masters/BomFormDialog'
import { BRAND_LABEL, styleFormFields } from '@/components/masters/styleFormFields'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import type { CustomerContext, CustomerOption } from './CustomerPanel'
import { orderTotals } from './orderTotals'
import { SaleCharges, chargeDraftsOf, chargesToPrice, chargesToSave, type SaleChargeDraft, type SaleChargeType } from './SaleCharges'
import { SizeQtyGrid, type SizeOption } from './SizeQtyGrid'

interface ItemOption {
  id: string
  code: string
  name: string
  color: string | null
  /** The style the item is one colour of; its size run is the one the server holds the sizes to. */
  styleId: string | null
  style: { code: string } | null
  taxRate: { rate: string | number } | null
  hsn: { gstRate: string | number; priceLimit: string | number | null; rateAbove: string | number | null } | null
}

/** A BOM's cost and selling price per piece, as the styles list sends it. */
interface StyleBom {
  id: string
  status: string
  color: string | null
  version: string
  cost: number | null
  price: number | null
}

interface StyleOption {
  id: string
  code: string
  name: string
  brandType: keyof typeof BRAND_LABEL
  category: string | null
  /** The style's own size run: its lines are quoted size by size in it. */
  sizeGroupId: string | null
  colors: string[]
  items: Array<{ id: string; color: string | null }>
  boms: StyleBom[]
}

/** A size run from Masters → Size Runs, with its sizes. */
interface SizeGroupOption {
  id: string
  name: string
  isActive?: boolean
  sizes: Array<SizeOption & { sequence: number }>
}

interface LineDraft {
  key: string
  itemId: string
  styleCode: string
  color: string
  description: string
  /** Pieces, for a line with no size run. With one, the pieces are what the sizes add up to. */
  qty: string
  /** The size run picked on the line, for a garment whose style has none. */
  sizeGroupId: string
  /** Pieces by size id. */
  sizes: Record<string, string>
  unitPrice: string
  discount: string
  /** The rate is the BOM's price, so it follows the style and colour until typed over. */
  rateFromBom: boolean
}

interface SavedQuote {
  id: string
  quoteNumber: string
  status: string
  customerId: string
  brandId: string
  quoteDate: string
  validUntil: string | null
  isJobWork: boolean
  customerRef: string | null
  salesperson: string | null
  discountAmount: string | number
  terms: string | null
  notes: string | null
  lines: Array<{
    itemId: string
    styleCode: string | null
    color: string | null
    description: string | null
    qty: string | number
    unitPrice: string | number
    discount: string | number
    /** Size by size; none on a line quoted by the piece only (and on quotations saved before sizes). */
    sizes?: Array<{ sizeId: string; qty: string | number }>
  }>
  charges?: Array<{ chargeTypeId: string; amount: string | number; taxTreatment?: 'INCLUSIVE' | 'EXCLUSIVE' | 'NON_TAXABLE' | null }>
}

let lineKey = 0
const blank = (): LineDraft => ({ key: `q${++lineKey}`, itemId: '', styleCode: '', color: '', description: '', qty: '', sizeGroupId: '', sizes: {}, unitPrice: '', discount: '', rateFromBom: true })
const today = () => new Date().toISOString().slice(0, 10)
const inDays = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '')
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()

/**
 * The BOM a line prices from, chosen as the server chooses it: the BOM for
 * that colour, else the one for all colours, approved ahead of draft.
 */
function pickBom(boms: StyleBom[], color: string): StyleBom | null {
  const sorted = [...boms].sort((a, b) => (a.status === 'APPROVED' ? 0 : 1) - (b.status === 'APPROVED' ? 0 : 1))
  return (color.trim() ? sorted.find((b) => same(b.color, color)) : undefined) ?? sorted.find((b) => !b.color?.trim()) ?? null
}

/**
 * The colour a newly picked style starts in: its only colour; else, when its
 * BOMs are made per colour with none for all colours, the colour of the BOM
 * with a price (or the first BOM), so the rate can fill in straight away.
 */
function startColour(st: StyleOption | null) {
  if (!st) return ''
  if (st.colors.length === 1) return st.colors[0]
  if (st.boms.some((b) => !b.color?.trim())) return ''
  const b = st.boms.find((x) => x.price != null && x.color) ?? st.boms.find((x) => x.color)
  return b?.color ?? ''
}

/**
 * A line's own size run: the run of the style its item is one colour of (the
 * server holds the sizes to that one, as on an order), else the run of the
 * style picked on the line. Null when neither has one: a run may then be
 * picked on the line, or the line stays pieces only.
 */
function styleRunIn(list: StyleOption[], item: Pick<ItemOption, 'styleId'> | undefined, styleCode: string): string | null {
  const own = item?.styleId ? list.find((x) => x.id === item.styleId) : undefined
  const picked = styleCode.trim() ? list.find((x) => same(x.code, styleCode)) : undefined
  return own?.sizeGroupId || picked?.sizeGroupId || null
}

/** What the style dropdown says under each style: its BOM price, or why there is none. */
function bomNote(st: StyleOption) {
  const priced = st.boms.filter((b) => b.price != null)
  if (priced.length) {
    const prices = [...new Set(priced.map((b) => b.price as number))]
    return `BOM price ₹${prices.length === 1 ? inr(prices[0]) : `${inr(Math.min(...prices))}–${inr(Math.max(...prices))}`}`
  }
  if (st.boms.some((b) => b.cost != null)) return 'BOM costed, no selling price yet'
  return 'No BOM yet'
}

function Field({
  label,
  icon: Icon,
  htmlFor,
  required,
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
          <Icon size={14} className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2" />
          {children}
        </div>
      ) : (
        children
      )}
      {help && <p className="text-muted-foreground mt-1 text-[11px] leading-snug">{help}</p>}
    </div>
  )
}

/** A small label over a box, as under a line on the order form. */
function Mini({ label, className = '', children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="text-muted-foreground mb-0.5 block text-[10px] font-semibold uppercase tracking-wider">{label}</span>
      {children}
    </label>
  )
}

/**
 * A quotation: the price offered before the customer orders.
 *
 * Laid out like the order form, shorter: who it is for and how long it holds,
 * then the garments. Each line starts from the style, because that is where
 * the BOM is: picking the style and colour fills the rate with the selling
 * price set on the BOM's Pricing step, and the item to bill with the
 * finished-goods item linked to that style. Where the style has a BOM the
 * rate is the BOM's and is changed only there: "Change price on BOM" opens the
 * BOM on its Pricing step over this form, and the saved price comes back into
 * every line that uses it. A buyer's own deal is the line's discount. Only a
 * style with no BOM yet takes a typed rate. The margin over cost shows under
 * the rate. A
 * style not in the master yet is added from the dropdown without leaving the
 * form. GST is shown as the order will charge it. Saved as a draft, or saved
 * and marked sent once it has gone to the buyer.
 */
export function QuotationDialog({
  open,
  quoteId,
  onClose,
  onSaved,
}: {
  open: boolean
  quoteId: string | null
  onClose: () => void
  onSaved: (message: string, id: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [items, setItems] = useState<ItemOption[]>([])
  const [styles, setStyles] = useState<StyleOption[]>([])
  // The size runs, for a line's sizes: its style's own, or one picked on the line.
  const [sizeGroups, setSizeGroups] = useState<SizeGroupOption[]>([])
  const [newStyle, setNewStyle] = useState<{ key: string; typed: string } | null>(null)
  // The BOM opened over the form to change its price, and the one being fetched.
  const [bomEdit, setBomEdit] = useState<Bom | null>(null)
  const [bomLoading, setBomLoading] = useState<string | null>(null)
  const [saved, setSaved] = useState<SavedQuote | null>(null)
  const [customerId, setCustomerId] = useState('')
  // The own brand the quotation (and the order it becomes) is under.
  const [brands, setBrands] = useState<OwnBrand[]>([])
  const [brandId, setBrandId] = useState('')
  /** Picked by hand, or from the saved quotation: no longer follows the styles. */
  const [brandPicked, setBrandPicked] = useState(false)
  const [quoteDate, setQuoteDate] = useState(today())
  const [validUntil, setValidUntil] = useState(inDays(15))
  const [isJobWork, setIsJobWork] = useState(false)
  const [customerRef, setCustomerRef] = useState('')
  const [salesperson, setSalesperson] = useState('')
  const [billDiscount, setBillDiscount] = useState('')
  const [terms, setTerms] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([blank()])
  // Transport, freight, packing: the same charges box and pricing as the order.
  const [chargeTypes, setChargeTypes] = useState<SaleChargeType[]>([])
  const [charges, setCharges] = useState<SaleChargeDraft[]>([])
  // For the SAC rate of a job-work quotation's lines, as the server reads it.
  const [hsnIndex, setHsnIndex] = useState<Map<string, { gstRate: string | number }>>(new Map())
  // How the customer is taxed: CGST + SGST within the state, IGST across.
  const [context, setContext] = useState<CustomerContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState<'draft' | 'send' | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Save was pressed with something still missing: the note under the form says what, in red. */
  const [tried, setTried] = useState(false)

  // Escape closes this window only — not the ones behind it.
  useEscape(() => {
    if (!saving && !bomEdit && !newStyle) onClose()
  }, open)
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])
  // Tab goes round inside the form, and focus goes back to the button that opened it.
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, open)

  useEffect(() => {
    if (!open) return
    let alive = true
    setError(null)
    setTried(false)
    setSaved(null)
    setCustomerId('')
    setBrandId('')
    setBrandPicked(false)
    setQuoteDate(today())
    setValidUntil(inDays(15))
    setIsJobWork(false)
    setCustomerRef('')
    setSalesperson('')
    setBillDiscount('')
    setTerms('')
    setNotes('')
    setLines([blank()])
    setCharges([])
    setLoading(true)
    void (async () => {
      try {
        const [c, it, st, sg, q, ct, hsn, ownBrands] = await Promise.all([
          fetchEveryPage<CustomerOption>((p) => `/masters/customers?active=true&limit=200&page=${p}`),
          fetchEveryPage<ItemOption>((p) => `/masters/items?type=FINISHED_GOOD&active=true&limit=200&page=${p}&sort=name&order=asc`),
          api.get<{ data: StyleOption[] }>('/sales/quotations/styles'),
          // As the order form reads them: a quotation's sizes are the order's.
          fetchEveryPage<SizeGroupOption>((p) => `/masters/size-groups?limit=200&page=${p}`),
          quoteId ? api.get<{ data: SavedQuote }>(`/sales/quotations/${quoteId}`) : Promise.resolve(null),
          // A failure costs the charges box, not the form.
          fetchEveryPage<SaleChargeType>((p) => `/masters/charge-types?limit=200&page=${p}`).catch(() => ({ rows: [] as SaleChargeType[] })),
          fetchEveryPage<{ code: string; gstRate: string | number; isActive?: boolean }>((p) => `/masters/hsn-codes?limit=200&page=${p}`).catch(() => ({
            rows: [] as Array<{ code: string; gstRate: string | number; isActive?: boolean }>,
          })),
          loadInHouseBrands().catch(() => [] as OwnBrand[]),
        ])
        if (!alive) return
        setCustomers([...c.rows].sort((x, y) => x.name.localeCompare(y.name)))
        setBrands(ownBrands)
        setItems(it.rows)
        setStyles(st.data)
        setSizeGroups(sg.rows)
        setChargeTypes(ct.rows.filter((x) => x.isActive && x.applyOnSale).sort((x, y) => x.name.localeCompare(y.name)))
        setHsnIndex(new Map(hsn.rows.filter((h) => h.isActive !== false).map((h) => [h.code.replace(/\s+/g, ''), h])))
        if (q) {
          const s = q.data
          setSaved(s)
          setCustomerId(s.customerId)
          setBrandId(s.brandId)
          setBrandPicked(true)
          setQuoteDate(day(s.quoteDate))
          setValidUntil(day(s.validUntil))
          setIsJobWork(s.isJobWork)
          setCustomerRef(s.customerRef ?? '')
          setSalesperson(s.salesperson ?? '')
          setBillDiscount(Number(s.discountAmount) > 0 ? String(Number(s.discountAmount)) : '')
          setTerms(s.terms ?? '')
          setNotes(s.notes ?? '')
          setCharges(chargeDraftsOf(s.charges))
          const itemMap = new Map(it.rows.map((i) => [i.id, i]))
          const groupOfSize = new Map(sg.rows.flatMap((g) => g.sizes.map((z) => [z.id, g.id] as const)))
          setLines(
            s.lines.map((l) => {
              const sizes = l.sizes ?? []
              const hasRun = !!styleRunIn(st.data, itemMap.get(l.itemId), l.styleCode ?? '')
              return {
                key: `q${++lineKey}`,
                itemId: l.itemId,
                styleCode: l.styleCode ?? '',
                color: l.color ?? '',
                description: l.description ?? '',
                // Kept as saved even with sizes: should the run be gone, the pieces still stand.
                qty: String(Number(l.qty)),
                // A garment with no run of its own: the run its sizes came from.
                sizeGroupId: !hasRun && sizes.length ? (groupOfSize.get(sizes[0].sizeId) ?? '') : '',
                sizes: Object.fromEntries(sizes.map((z) => [z.sizeId, String(Number(z.qty))])),
                unitPrice: String(Number(l.unitPrice)),
                discount: Number(l.discount) > 0 ? String(Number(l.discount)) : '',
                rateFromBom: false,
              }
            })
          )
        }
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err.message : 'Could not load the customers and items.')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, quoteId])

  // The customer picked: whether the quotation is CGST + SGST or IGST, as the server will price it.
  useEffect(() => {
    if (!open || !customerId) {
      setContext(null)
      return
    }
    let alive = true
    api
      .get<{ data: CustomerContext }>(`/sales/customers/${customerId}/context`)
      .then((res) => {
        if (alive) setContext(res.data)
      })
      // Without it the GST shows as one figure; the server still splits it on save.
      .catch(() => {
        if (alive) setContext(null)
      })
    return () => {
      alive = false
    }
  }, [open, customerId])

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const chargeTypeById = useMemo(() => new Map(chargeTypes.map((c) => [c.id, c])), [chargeTypes])

  const styleByCode = useMemo(() => new Map(styles.map((st) => [st.code.toLowerCase(), st])), [styles])
  /** Whose style each garment is (LD Cotton Mills or VHAGAR), for the brand it is suggested under. */
  const lineBrandTypes = useMemo(
    () =>
      lines
        .filter((l) => l.itemId || l.styleCode.trim())
        .map((l) => {
          const typed = l.styleCode.trim().toLowerCase()
          const style = typed ? styleByCode.get(typed) : styles.find((x) => x.items.some((i) => i.id === l.itemId))
          return style?.brandType ?? null
        }),
    [lines, styleByCode, styles]
  )
  // Until someone picks a brand, it follows the garments: VHAGAR styles, VHAGAR.
  useEffect(() => {
    if (brandPicked || !brands.length) return
    const next = suggestedBrand(brands, lineBrandTypes, isJobWork)
    if (next && next !== brandId) setBrandId(next)
  }, [brandPicked, brands, lineBrandTypes, isJobWork, brandId])
  const brand = brands.find((b) => b.id === brandId)
  const otherBrand = otherBrandLines(brand, lineBrandTypes)

  const setLine = (key: string, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  /** A copy of a line, put just under it, its sizes too. */
  const copyLine = (key: string) =>
    setLines((ls) => {
      const at = ls.findIndex((l) => l.key === key)
      return at < 0 ? ls : [...ls.slice(0, at + 1), { ...ls[at], key: blank().key, sizes: { ...ls[at].sizes } }, ...ls.slice(at + 1)]
    })

  // ── Sizes ──────────────────────────────────────────────────────────────
  const groupById = useMemo(() => new Map(sizeGroups.map((g) => [g.id, g])), [sizeGroups])
  const sizesOfGroup = useMemo(() => new Map(sizeGroups.map((g) => [g.id, [...g.sizes].sort((a, b) => a.sequence - b.sequence)])), [sizeGroups])
  const sizeCodeById = useMemo(() => new Map(sizeGroups.flatMap((g) => g.sizes.map((z) => [z.id, z.code] as const))), [sizeGroups])
  /** Size runs that have sizes in them, to pick from on a line. */
  const runChoices = useMemo(() => sizeGroups.filter((g) => g.sizes.length > 0 && g.isActive !== false), [sizeGroups])

  /**
   * A line's size run: its style's own when it has one (`fixed`), else the
   * run picked on the line, else none — and then the pieces are one figure.
   */
  const runOf = (line: LineDraft) => {
    const styleRun = styleRunIn(styles, itemById.get(line.itemId), line.styleCode)
    const groupId = styleRun || line.sizeGroupId || null
    const run = groupId ? sizesOfGroup.get(groupId) : null
    return { run: run && run.length ? (run as SizeOption[]) : null, fixed: !!styleRun, groupId }
  }

  /** The item billed as, changed by hand: a garment of another size run starts its sizes afresh. */
  const pickItem = (key: string, itemId: string) =>
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l
        const next = { ...l, itemId }
        return styleRunIn(styles, itemById.get(l.itemId), l.styleCode) === styleRunIn(styles, itemById.get(itemId), l.styleCode) ? next : { ...next, sizes: {}, sizeGroupId: '' }
      })
    )

  /** A size run picked on a line whose style has none. */
  const pickRun = (key: string, sizeGroupId: string) => setLine(key, { sizeGroupId, sizes: {} })

  /**
   * A style or colour picked: the item to bill is the one linked to that
   * style (in that colour, else any colour), else the item another line of
   * the same style already bills as, else whatever the line had. The rate
   * becomes the BOM's selling price unless it has been typed over.
   */
  const pickStyle = (key: string, styleCode: string, color: string, list = styles) => {
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l
        const st = list.find((x) => x.code === styleCode) ?? null
        const colour = color
        const linked = st ? (st.items.find((i) => same(i.color, colour)) ?? st.items.find((i) => !i.color) ?? (st.items.length === 1 ? st.items[0] : undefined)) : undefined
        const sibling = ls.find((o) => o.key !== key && o.itemId && same(o.styleCode, styleCode))
        const bom = st ? pickBom(st.boms, colour) : null
        // Without a linked item, the item whose name carries the style's
        // garment type ("Trouser" → Men's Cotton Trouser) when only one does.
        // The item already on the line stays only while it is that garment,
        // so a trouser style is never left billed as a shirt.
        const garment = st?.category?.trim().toLowerCase() ?? ''
        const fits = (id: string) => !garment || (itemById.get(id)?.name.toLowerCase().includes(garment) ?? false)
        const byType = garment ? items.filter((i) => i.name.toLowerCase().includes(garment)) : []
        const kept = l.itemId && (same(l.styleCode, styleCode) || fits(l.itemId)) ? l.itemId : ''
        const itemId = linked?.id ?? sibling?.itemId ?? (kept || (byType.length === 1 ? byType[0].id : ''))
        const next: LineDraft = { ...l, styleCode, color: colour, itemId }
        // Another colour of the same style keeps its sizes; a style made in
        // another size run starts them afresh.
        if (styleRunIn(list, itemById.get(l.itemId), l.styleCode) !== styleRunIn(list, itemById.get(itemId), styleCode)) {
          next.sizes = {}
          next.sizeGroupId = ''
        }
        // A style with a BOM takes the BOM's price, whatever was there; one
        // without keeps a typed rate, but not a price left from another BOM.
        const moved = !same(l.styleCode, styleCode) || !same(l.color, colour)
        if (bom) {
          if (moved || l.rateFromBom || !l.unitPrice.trim()) {
            next.unitPrice = bom.price != null ? String(bom.price) : ''
            next.rateFromBom = true
          }
        } else if (l.rateFromBom) {
          next.unitPrice = ''
          next.rateFromBom = false
        }
        return next
      })
    )
  }

  /** Opens the BOM over the form, on its Pricing step. */
  const openBom = async (bomId: string) => {
    setBomLoading(bomId)
    setError(null)
    try {
      setBomEdit((await api.get<{ data: Bom }>(`/masters/bom/${bomId}`)).data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the BOM.')
    } finally {
      setBomLoading(null)
    }
  }

  /** A BOM saved over the form: its price goes into every line priced from it. */
  const bomSaved = async (bomId: string) => {
    try {
      const fresh = (await api.get<{ data: StyleOption[] }>('/sales/quotations/styles')).data
      setStyles(fresh)
      setLines((ls) =>
        ls.map((l) => {
          const st = fresh.find((x) => same(x.code, l.styleCode))
          const b = st ? pickBom(st.boms, l.color) : null
          return b?.id === bomId ? { ...l, unitPrice: b.price != null ? String(b.price) : '', rateFromBom: true } : l
        })
      )
    } catch {
      setError('The BOM was saved, but its new price could not be read back. Close and reopen the quotation.')
    }
  }

  const totals = useMemo(() => {
    const priced = lines.map((l) => {
      const item = itemById.get(l.itemId)
      const { run, fixed, groupId } = runOf(l)
      // With a size run the pieces are what its sizes add up to; a size no
      // longer in the run is neither counted nor sent, and is named below the line.
      const qty = run ? run.reduce((s, z) => s + (Number(l.sizes[z.id]) || 0), 0) : Number(l.qty) || 0
      const dropped = run ? Object.entries(l.sizes).filter(([id, v]) => (Number(v) || 0) > 0 && !run.some((z) => z.id === id)) : []
      const rate = Number(l.unitPrice) || 0
      const disc = Math.min(100, Number(l.discount) || 0)
      const style = l.styleCode.trim() ? (styleByCode.get(l.styleCode.trim().toLowerCase()) ?? null) : null
      return { l, item, style, run, fixed, groupId, dropped, qty, rate, disc, bom: style ? pickBom(style.boms, l.color) : null }
    })
    // The same engine the server prices the quotation with, and the order
    // made from it: discounts, each line's GST, each charge as its row says.
    const t = orderTotals({
      lines: priced.map((p) => ({
        qty: p.qty,
        rate: p.rate,
        disc: p.disc,
        taxExempt: false,
        jobGst: '',
        jobHsn: '',
        hsn: p.item?.hsn ?? null,
        itemRate: p.item?.taxRate ? Number(p.item.taxRate.rate) : null,
      })),
      isJobWork,
      hsnIndex,
      billDiscount: Number(billDiscount) || 0,
      charges: chargesToPrice(charges, chargeTypeById),
      intra: context?.placeOfSupply?.isIntraState,
      otherCharges: 0,
      brokerPct: 0,
    })
    const withGst = priced.map((p, i) => {
      const net = p.rate * (1 - p.disc / 100)
      const margin = p.bom?.cost != null && net > 0 ? Math.round(((net - p.bom.cost) / net) * 1000) / 10 : null
      return { ...p, amount: t.lines[i].amount, gst: p.item ? t.lines[i].gst : null, margin }
    })
    return { ...t, lines: withGst, pieces: priced.reduce((s, p) => s + p.qty, 0) }
    // runOf reads the styles, items and size runs listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, itemById, billDiscount, styleByCode, styles, sizesOfGroup, isJobWork, hsnIndex, charges, chargeTypeById, context])

  const filled = totals.lines.filter((p) => p.l.itemId || p.l.styleCode.trim())
  const noItem = filled.find((p) => !p.l.itemId)
  const noPrice = filled.find((p) => p.bom && !p.l.unitPrice.trim())
  const noSizes = filled.find((p) => p.run && p.qty <= 0)
  const unfinished = filled.find((p) => p.qty <= 0 || p.l.unitPrice.trim() === '')
  const chargeNoType = charges.find((c) => !chargeTypeById.get(c.chargeTypeId) && !c.config && (Number(c.amount) || 0) > 0)
  /** What still stops a save, and the line it is on (scrolled to when Save is pressed). */
  const problem: { text: string; lineKey?: string } | null = !customerId
    ? { text: 'Choose the customer.' }
    : filled.length === 0
      ? { text: 'Add at least one garment.' }
      : noItem
        ? { text: `Choose the item ${noItem.l.styleCode || 'each line'} is billed as — it carries the HSN code and GST.`, lineKey: noItem.l.key }
        : noPrice
          ? { text: `${noPrice.l.styleCode} has no selling price on its BOM yet. Use "Set price on BOM" under its rate.`, lineKey: noPrice.l.key }
          : noSizes
            ? { text: `${noSizes.l.styleCode || noSizes.item?.code || 'A line'}: type its pieces size by size, under the line.`, lineKey: noSizes.l.key }
            : unfinished
              ? { text: 'Every line needs pieces and a rate.', lineKey: unfinished.l.key }
              : validUntil && validUntil < quoteDate
                ? { text: 'It cannot expire before it is made.' }
                : chargeNoType
                  ? { text: 'Pick which charge the amount in the totals is for.' }
                  : null
  const blocker = problem?.text ?? null

  const save = async (send: boolean) => {
    // Save stays pressable: pressed too early, it says what is missing and goes to it.
    if (problem) {
      setTried(true)
      if (problem.lineKey) {
        const row = dialogRef.current?.querySelector<HTMLElement>(`[data-qt-line="${problem.lineKey}"]`)
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        // Straight into the first size box when it is the sizes that are missing.
        if (noSizes && problem.lineKey === noSizes.l.key) row?.parentElement?.querySelector<HTMLInputElement>(`[data-qt-sizes="${problem.lineKey}"] input`)?.focus({ preventScroll: true })
      }
      return
    }
    setSaving(send ? 'send' : 'draft')
    setError(null)
    const body = {
      customerId,
      brandId: brandId || null,
      quoteDate,
      validUntil: validUntil || null,
      isJobWork,
      customerRef: customerRef.trim() || null,
      salesperson: salesperson.trim() || null,
      discountAmount: Number(billDiscount) || 0,
      terms: terms.trim() || null,
      notes: notes.trim() || null,
      send,
      lines: filled.map((p) => ({
        itemId: p.l.itemId,
        styleCode: p.l.styleCode.trim() || null,
        color: p.l.color.trim() || null,
        description: p.l.description.trim() || null,
        qty: p.qty,
        unitPrice: p.rate,
        discount: p.disc,
        // Size by size when the line has a run: they add up to qty, as the server checks.
        sizes: p.run ? p.run.map((z) => ({ sizeId: z.id, qty: Number(p.l.sizes[z.id]) || 0 })).filter((z) => z.qty > 0) : undefined,
      })),
      charges: chargesToSave(charges, chargeTypeById),
    }
    try {
      const res = saved
        ? await api.patch<{ message?: string; data: { id: string } }>(`/sales/quotations/${saved.id}`, body)
        : await api.post<{ message?: string; data: { id: string } }>('/sales/quotations', body)
      onSaved(res.message ?? 'Quotation saved.', res.data.id)
      onClose()
    } catch (err) {
      // A refused size or total names itself, not just "Validation error".
      setError(apiErrorMessage(err, 'Could not save the quotation.'))
    } finally {
      setSaving(null)
    }
  }

  const canPrice = can('masters', 'approve')

  if (!open || !mounted) return null
  const cell = 'form-input h-8 px-2 text-xs'
  const busy = saving !== null || loading

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div ref={dialogRef} className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="qt-title">
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <FileText size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="qt-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                Quotation
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">{saved ? `${saved.quoteNumber} — can be changed until it is won or lost` : 'A price offered before the customer orders'}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {(!saved || saved.status === 'DRAFT') && (
              <button type="button" className="btn-primary hidden md:inline-flex" onClick={() => void save(true)} disabled={busy}>
                {saving === 'send' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Save &amp; mark sent
              </button>
            )}
            <button onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={saving !== null}>
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
              <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}
          {loading ? (
            <div className="skeleton h-72 w-full rounded-xl" />
          ) : (
            <>
              <Section icon={FileText} title="Basic Details">
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                  <Field label="Quotation no." icon={Hash}>
                    <div className="form-input text-muted-foreground pl-9 font-mono">{saved?.quoteNumber ?? 'Given when saved'}</div>
                  </Field>
                  <Field label="Date" htmlFor="qt-date" required>
                    <input id="qt-date" type="date" className="form-input" value={quoteDate} onChange={(e) => setQuoteDate(e.target.value || today())} />
                  </Field>
                  <Field label="Customer" icon={User} htmlFor="qt-customer" required>
                    <SmartSelect id="qt-customer" className="form-input pl-9" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                      <option value="">Choose a customer</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id} data-sub={c.billingCity ?? undefined}>
                          {c.code ? `${c.code} — ${c.name}` : c.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </Field>
                  <Field
                    label="Brand"
                    icon={Tag}
                    htmlFor="qt-brand"
                    required
                    help={
                      otherBrand > 0 ? (
                        <span className="warn-text">
                          {otherBrand} {otherBrand === 1 ? 'garment is' : 'garments are'} another brand&apos;s style
                        </span>
                      ) : brandPicked ? undefined : (
                        'Follows the styles until you pick one'
                      )
                    }
                  >
                    <SmartSelect
                      id="qt-brand"
                      className="form-input pl-9"
                      value={brandId}
                      onChange={(e) => {
                        setBrandId(e.target.value)
                        setBrandPicked(true)
                      }}
                    >
                      {!brandId && <option value="">Choose the brand</option>}
                      {brands.map((b) => (
                        <option key={b.id} value={b.id} data-sub={b.type === 'VHAGAR' ? 'VHAGAR' : 'LD Cotton Mills'}>
                          {b.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </Field>
                  <Field label="Type" htmlFor="qt-type">
                    <SmartSelect id="qt-type" className="form-input" value={isJobWork ? 'job' : 'own'} onChange={(e) => setIsJobWork(e.target.value === 'job')}>
                      <option value="own">Own order</option>
                      <option value="job">Job work (customer&apos;s fabric)</option>
                    </SmartSelect>
                  </Field>
                  <Field label="Valid until" htmlFor="qt-valid">
                    <input id="qt-valid" type="date" className="form-input" value={validUntil} min={quoteDate} onChange={(e) => setValidUntil(e.target.value)} />
                  </Field>
                  <Field label="Buyer's reference" htmlFor="qt-ref" className="sm:col-span-2">
                    <input id="qt-ref" className="form-input" maxLength={80} value={customerRef} placeholder="Their enquiry, email or tech pack" onChange={(e) => setCustomerRef(e.target.value)} />
                  </Field>
                  <Field label="Salesperson" htmlFor="qt-sp" className="sm:col-span-2">
                    <input id="qt-sp" className="form-input" maxLength={120} value={salesperson} onChange={(e) => setSalesperson(e.target.value)} />
                  </Field>
                </div>
              </Section>

              <Section icon={Package} title="Garments and rates" actions={<span className="text-muted-foreground text-xs tabular-nums">{totals.pieces.toLocaleString('en-IN')} pcs</span>}>
                <p className="text-muted-foreground mb-2.5 text-xs">
                  Pick the style and colour, and the rate comes from the selling price on its BOM. To change that price, use <b className="text-foreground font-medium">Change price on BOM</b> under the rate. For one buyer&apos;s special deal, give a discount in Disc %.
                </p>
                <div className="border-border overflow-x-auto rounded-lg border">
                  <table className="w-full min-w-[1080px] table-fixed border-collapse text-sm">
                    <thead>
                      <tr className="bg-secondary">
                        {[
                          ['', 'w-16'],
                          ['Style', 'w-72'],
                          ['Colour', 'w-32'],
                          ['Item billed as', 'w-56'],
                          ['Pieces', 'w-24 text-right'],
                          ['Rate ₹/pc', 'w-40 text-right'],
                          ['Disc %', 'w-20 text-right'],
                          ['GST', 'w-14 text-right'],
                          ['Amount', 'w-28 text-right'],
                        ].map(([label, cls], i) => (
                          <th key={i} className={`${cls} border-border text-muted-foreground border-b px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${cls.includes('right') ? '' : 'text-left'}`}>
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody data-grid>
                      {totals.lines.map((p, i) => {
                        const st = p.style
                        const bomPrice = p.bom?.price ?? null
                        const offBom = bomPrice != null && Math.abs(p.rate - bomPrice) >= 0.005
                        const zebra = i % 2 ? 'zebra-row' : 'bg-card'
                        const picked = !!(p.l.itemId || p.l.styleCode.trim())
                        return (
                          <Fragment key={p.l.key}>
                            <tr data-grid-row data-qt-line={p.l.key} className={`${zebra} [&>td]:px-2 [&>td]:py-1.5 [&>td]:align-top`}>
                              <td>
                                <div className="flex items-center">
                                  <button type="button" className="btn-ghost text-muted-foreground hover:text-destructive p-1" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== p.l.key) : [blank()]))} aria-label={`Remove row ${i + 1}`} aria-keyshortcuts="Alt+Delete" data-grid-remove>
                                    <Trash2 size={13} />
                                  </button>
                                  <button type="button" className="btn-ghost text-muted-foreground hover:text-primary p-1" onClick={() => copyLine(p.l.key)} aria-label={`Copy row ${i + 1}`} title="Copy this line (Alt+C)" aria-keyshortcuts="Alt+C" data-grid-copy>
                                    <Copy size={13} />
                                  </button>
                                </div>
                              </td>
                              <td>
                                <SmartSelect
                                  className={cell}
                                  value={p.l.styleCode}
                                  onChange={(e) => pickStyle(p.l.key, e.target.value, startColour(styles.find((x) => x.code === e.target.value) ?? null))}
                                  onCreate={can('masters', 'create') ? (typed) => setNewStyle({ key: p.l.key, typed }) : undefined}
                                  createNoun="style"
                                  aria-label={`Row ${i + 1} style`}
                                >
                                  <option value="">Choose a style</option>
                                  {p.l.styleCode && !st && <option value={p.l.styleCode}>{p.l.styleCode} (not in the style master)</option>}
                                  {(['LD_COTTON_MILLS', 'VHAGAR', 'CUSTOM'] as const).map((bt) => {
                                    const group = styles.filter((x) => x.brandType === bt)
                                    return group.length ? (
                                      <optgroup key={bt} label={BRAND_LABEL[bt]}>
                                        {group.map((x) => (
                                          <option key={x.id} value={x.code} data-sub={bomNote(x)}>
                                            {x.code} — {x.name}
                                          </option>
                                        ))}
                                      </optgroup>
                                    ) : null
                                  })}
                                </SmartSelect>
                                <input className={`${cell} mt-1`} maxLength={500} value={p.l.description} placeholder="Description (optional)" onChange={(e) => setLine(p.l.key, { description: e.target.value })} />
                              </td>
                              <td>
                                {st && st.colors.length > 0 ? (
                                  <SmartSelect className={cell} value={p.l.color} onChange={(e) => pickStyle(p.l.key, p.l.styleCode, e.target.value)} aria-label={`Row ${i + 1} colour`}>
                                    <option value="">Any colour</option>
                                    {p.l.color && !st.colors.some((c) => same(c, p.l.color)) && <option value={p.l.color}>{p.l.color}</option>}
                                    {st.colors.map((c) => {
                                      const b = pickBom(st.boms, c)
                                      return (
                                        <option key={c} value={c} data-sub={b?.price != null ? `₹${inr(b.price)}` : undefined}>
                                          {c}
                                        </option>
                                      )
                                    })}
                                  </SmartSelect>
                                ) : (
                                  <input className={cell} maxLength={50} value={p.l.color} placeholder="Colour" onChange={(e) => setLine(p.l.key, { color: e.target.value })} />
                                )}
                              </td>
                              <td>
                                <SmartSelect className={cell} value={p.l.itemId} onChange={(e) => pickItem(p.l.key, e.target.value)} aria-label={`Row ${i + 1} item billed as`}>
                                  <option value="">Choose the item</option>
                                  {(() => {
                                    // The style's own garment type first: a trouser style lists the trousers on top.
                                    const garment = st?.category?.trim() ?? ''
                                    const opt = (it: ItemOption) => (
                                      <option key={it.id} value={it.id} data-sub={it.code}>
                                        {it.name}
                                        {it.color ? ` (${it.color})` : ''}
                                      </option>
                                    )
                                    const match = garment ? items.filter((it) => it.name.toLowerCase().includes(garment.toLowerCase())) : []
                                    if (!match.length) return items.map(opt)
                                    return (
                                      <>
                                        <optgroup label={garment}>{match.map(opt)}</optgroup>
                                        <optgroup label="Other items">{items.filter((it) => !match.includes(it)).map(opt)}</optgroup>
                                      </>
                                    )
                                  })()}
                                </SmartSelect>
                              </td>
                              <td>
                                {p.run ? (
                                  // With a size run the pieces are what the sizes under the line add up to.
                                  <div className={`flex h-8 items-center justify-end text-xs font-semibold tabular-nums ${p.qty <= 0 ? 'warn-text' : 'text-foreground'}`} title="The sizes under this line add up to this" aria-label={`Row ${i + 1} pieces, the sizes added up`}>
                                    {p.qty.toLocaleString('en-IN')}
                                  </div>
                                ) : (
                                  <StepInput className={`${cell} text-right tabular-nums`} value={p.l.qty} placeholder="0" onValueChange={(v) => setLine(p.l.key, { qty: v })} aria-label={`Row ${i + 1} pieces`} />
                                )}
                              </td>
                              <td>
                                {p.bom ? (
                                  // Priced on the BOM: shown here, changed there.
                                  <div className={`${cell} bg-secondary/60 text-foreground flex items-center justify-end gap-1.5 tabular-nums`} title="This rate comes from the BOM. Change it on the BOM." aria-label={`Row ${i + 1} rate, from the BOM`}>
                                    <Lock size={11} className="text-muted-foreground shrink-0" />
                                    {p.l.unitPrice.trim() ? inr(p.rate) : '—'}
                                  </div>
                                ) : (
                                  <StepInput decimals className={`${cell} text-right tabular-nums`} value={p.l.unitPrice} placeholder="0.00" onValueChange={(v) => setLine(p.l.key, { unitPrice: v, rateFromBom: false })} aria-label={`Row ${i + 1} rate`} />
                                )}
                                <div className="mt-0.5 space-y-0.5 text-right text-[10px] leading-snug">
                                  {!st ? null : !p.bom ? (
                                    <span className="text-muted-foreground">
                                      {st.boms.length ? `BOM is for ${[...new Set(st.boms.map((b) => b.color).filter(Boolean))].join(', ')} — pick the colour` : 'No BOM for this style yet — type the rate'}
                                    </span>
                                  ) : (
                                    <>
                                      {bomPrice == null ? (
                                        <div className="warn-text">No selling price on the BOM yet{p.bom.cost != null ? ` · cost ₹${inr(p.bom.cost)}` : ''}</div>
                                      ) : offBom ? (
                                        <button type="button" className="text-primary block w-full text-right hover:underline" onClick={() => setLine(p.l.key, { unitPrice: String(bomPrice), rateFromBom: true })} title="This quotation was saved at an older price. Take the BOM's price now.">
                                          BOM price now ₹{inr(bomPrice)} · use it
                                        </button>
                                      ) : (
                                        p.margin != null && (
                                          <div className={p.margin < 0 ? 'text-destructive font-medium' : p.margin < 10 ? 'warn-text' : 'text-muted-foreground'}>
                                            cost ₹{inr(p.bom.cost ?? 0)} · {p.margin}% margin{p.bom.status === 'DRAFT' ? ' · draft BOM' : ''}
                                          </div>
                                        )
                                      )}
                                      {canPrice ? (
                                        <button type="button" className="text-primary inline-flex items-center gap-1 font-medium hover:underline disabled:opacity-50" onClick={() => void openBom(p.bom!.id)} disabled={bomLoading !== null}>
                                          {bomLoading === p.bom.id ? <Loader2 size={10} className="animate-spin" /> : <Pencil size={10} />}
                                          {bomPrice == null ? 'Set price on BOM' : 'Change price on BOM'}
                                        </button>
                                      ) : (
                                        <div className="text-muted-foreground">Priced on the BOM by a manager</div>
                                      )}
                                    </>
                                  )}
                                </div>
                              </td>
                              <td>
                                <StepInput decimals max={100} className={`${cell} text-right tabular-nums`} value={p.l.discount} placeholder="0" onValueChange={(v) => setLine(p.l.key, { discount: v })} aria-label={`Row ${i + 1} discount`} />
                              </td>
                              <td className="text-right text-xs tabular-nums">{p.gst != null ? `${p.gst}%` : p.l.itemId ? <span className="warn-text">none</span> : '—'}</td>
                              <td className="text-foreground text-right text-xs font-semibold tabular-nums">{p.amount ? inr(p.amount) : '—'}</td>
                            </tr>
                            {/* Under the line, its pieces size by size: the style's own
                              size run, or one picked here for a garment with none. */}
                            {picked && (
                              <tr data-grid-row="sizes" className={zebra}>
                                <td />
                                <td colSpan={8} className="px-2 pb-2.5 pt-0">
                                  <div data-qt-sizes={p.l.key} className="border-border bg-secondary/40 flex flex-wrap items-end gap-x-4 gap-y-2 rounded-lg border px-3 py-2">
                                    <Mini label="Size run">
                                      {p.fixed ? (
                                        <span className="text-muted-foreground flex h-8 items-center text-[11px]">{groupById.get(p.groupId ?? '')?.name ?? 'The style’s own'}</span>
                                      ) : (
                                        <SmartSelect className={`${cell} w-48`} value={p.l.sizeGroupId} onChange={(e) => pickRun(p.l.key, e.target.value)} aria-label={`Row ${i + 1} size run`}>
                                          <option value="">No sizes (pieces only)</option>
                                          {[
                                            ...runChoices,
                                            ...(p.l.sizeGroupId && !runChoices.some((g) => g.id === p.l.sizeGroupId) && groupById.get(p.l.sizeGroupId) ? [groupById.get(p.l.sizeGroupId)!] : []),
                                          ].map((g) => (
                                            <option key={g.id} value={g.id} data-sub={g.sizes.map((z) => z.code).join(' ')}>
                                              {g.name}
                                            </option>
                                          ))}
                                        </SmartSelect>
                                      )}
                                    </Mini>
                                    {p.run ? (
                                      <>
                                        <SizeQtyGrid sizes={p.run} values={p.l.sizes} name={`Row ${i + 1}`} onChange={(sizeId, v) => setLine(p.l.key, { sizes: { ...p.l.sizes, [sizeId]: v } })} />
                                        <span className={`ml-auto self-center text-xs font-semibold tabular-nums ${p.qty <= 0 ? 'warn-text' : 'text-foreground'}`}>
                                          {p.qty > 0 ? `= ${p.qty.toLocaleString('en-IN')} pcs` : 'Type the pieces under each size'}
                                        </span>
                                      </>
                                    ) : null}
                                    {p.dropped.length > 0 && (
                                      <span className="warn-text basis-full text-[11px]">
                                        Size{p.dropped.length > 1 ? 's' : ''} {p.dropped.map(([id, v]) => `${sizeCodeById.get(id) ?? '?'} (${Number(v)} pcs)`).join(', ')} no longer in this
                                        style&apos;s size run: not counted. Move the pieces to a size in the run.
                                      </span>
                                    )}
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
                <button type="button" className="btn-secondary mt-3 h-8 px-3 text-xs" onClick={() => setLines((ls) => [...ls, blank()])} data-grid-add aria-keyshortcuts="Alt+A" title="Add item row (Alt+A)">
                  <Plus size={14} /> Add item row
                </button>
                {/* The full style form, the same as Masters → Styles, over
                  this quotation. Saved, the style is picked on the line that
                  asked for it; nothing typed here is lost. */}
                <MasterFormDialog<{ id: string; code: string }>
                  open={newStyle !== null}
                  onClose={() => setNewStyle(null)}
                  onSaved={() => {}}
                  onCreated={(row) => {
                    const key = newStyle?.key
                    void api
                      .get<{ data: StyleOption[] }>('/sales/quotations/styles')
                      .then((res) => {
                        setStyles(res.data)
                        if (key) pickStyle(key, row.code, startColour(res.data.find((x) => x.code === row.code) ?? null), res.data)
                      })
                      .catch(() => {})
                  }}
                  resource="styles"
                  fields={styleFormFields}
                  initialValues={{
                    // The code is made by the system now, so what was searched
                    // for becomes the name — unless it was a code nobody has.
                    ...(newStyle?.typed && !/^[A-Za-z0-9]+(-[A-Za-z0-9]+)+$/.test(newStyle.typed.trim()) ? { name: newStyle.typed.trim() } : {}),
                    isActive: true,
                  }}
                  title="Style"
                  columns={4}
                  wide
                  stacked
                />
              </Section>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_400px]">
                <Section icon={StickyNote} title="Terms and notes">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label className="block">
                      <span className="form-label">Terms (printed)</span>
                      <textarea className="form-input min-h-[6rem]" rows={4} maxLength={2000} value={terms} placeholder="Leave empty to print the standard terms" onChange={(e) => setTerms(e.target.value)} />
                    </label>
                    <label className="block">
                      <span className="form-label">Notes (printed)</span>
                      <textarea className="form-input min-h-[6rem]" rows={4} maxLength={1000} value={notes} placeholder="Delivery lead time, MOQ, packing" onChange={(e) => setNotes(e.target.value)} />
                    </label>
                  </div>
                </Section>
                <Section icon={Calculator} title="Totals">
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Value</span>
                      <span className="tabular-nums">{inr(totals.subtotal)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Discount on the whole (₹)</span>
                      <StepInput decimals className="form-input h-8 w-28 text-right tabular-nums" value={billDiscount} placeholder="0.00" onValueChange={setBillDiscount} />
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{charges.length ? 'Taxable value of the goods' : 'Taxable value'}</span>
                      <span className="tabular-nums">{inr(totals.taxable)}</span>
                    </div>
                    {/* Charges from Masters → Charges, each with how GST sits on its
                      figure — the same box the order uses, carried over to it. */}
                    <SaleCharges types={chargeTypes} rows={charges} priced={totals.chargeByKey} onChange={setCharges} idPrefix="Quotation charge" />
                    {totals.chargeTaxable > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Taxable value with the charges</span>
                        <span className="tabular-nums">{inr(totals.taxable + totals.chargeTaxable)}</span>
                      </div>
                    )}
                    {(context?.placeOfSupply
                      ? context.placeOfSupply.isIntraState
                        ? [
                            ['CGST', totals.cgst],
                            ['SGST', totals.sgst],
                          ]
                        : [['IGST', totals.igst]]
                      : [['GST', totals.taxTotal]]
                    ).map(([label, value]) => (
                      <div key={label} className="flex justify-between">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="tabular-nums">{inr(Number(value))}</span>
                      </div>
                    ))}
                    {Math.abs(totals.roundOff) >= 0.005 && (
                      <div className="text-muted-foreground flex justify-between text-xs">
                        <span>Rounding</span>
                        <span className="tabular-nums">{inr(totals.roundOff)}</span>
                      </div>
                    )}
                    <div className="border-primary/20 bg-primary/5 mt-2 flex items-center justify-between rounded-lg border px-3 py-2.5">
                      <span className="text-foreground font-semibold">Quoted total</span>
                      <span className="text-foreground text-lg font-semibold tabular-nums">{formatRupees(totals.total)}</span>
                    </div>
                    {!context?.placeOfSupply && (
                      <p className="text-muted-foreground text-xs">GST is split CGST + SGST or IGST by the customer&apos;s state when saved.</p>
                    )}
                  </div>
                </Section>
              </div>
            </>
          )}
        </div>

        {/* The BOM, opened on its Pricing step over this form. Saved, its
          price comes back into the lines; closed, nothing here is lost. */}
        {bomEdit &&
          createPortal(
            <BomFormDialog
              open
              stacked
              startStep={3}
              record={bomEdit}
              onClose={() => setBomEdit(null)}
              onSaved={() => void bomSaved(bomEdit.id)}
            />,
            document.body
          )}

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3.5">
          {blocker && !loading && (
            <p className={`${tried ? 'text-destructive font-medium' : 'warn-text'} mr-auto flex max-w-xl basis-full items-start gap-1.5 text-xs sm:basis-auto`} role={tried ? 'alert' : undefined}>
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>{blocker}</span>
            </p>
          )}
          <button type="button" onClick={onClose} className="btn-secondary hidden sm:inline-flex" disabled={saving !== null}>
            Cancel
          </button>
          <button type="button" className={saved && saved.status !== 'DRAFT' ? 'btn-primary' : 'btn-secondary'} onClick={() => void save(false)} disabled={busy} data-hotkey="save" aria-keyshortcuts="Control+S Meta+S" title={saved && saved.status !== 'DRAFT' ? 'Save (Ctrl+S)' : 'Save as draft (Ctrl+S)'}>
            {saving === 'draft' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {saved && saved.status !== 'DRAFT' ? 'Save' : 'Save as draft'}
          </button>
          {(!saved || saved.status === 'DRAFT') && (
            <button type="button" className="btn-primary" onClick={() => void save(true)} disabled={busy}>
              {saving === 'send' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Save &amp; mark sent
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
