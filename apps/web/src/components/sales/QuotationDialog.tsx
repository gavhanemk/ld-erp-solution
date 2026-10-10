'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Calculator, FileText, Hash, Loader2, Package, Plus, Save, Send, StickyNote, Tag, Trash2, User, X } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { fetchEveryPage } from '@/lib/export'
import { formatRupees } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { MasterFormDialog } from '@/components/masters/MasterFormDialog'
import { BRAND_LABEL, styleFormFields } from '@/components/masters/styleFormFields'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import type { CustomerOption } from './CustomerPanel'

interface ItemOption {
  id: string
  code: string
  name: string
  color: string | null
  style: { code: string } | null
  taxRate: { rate: string | number } | null
  hsn: { gstRate: string | number; priceLimit: string | number | null; rateAbove: string | number | null } | null
}

/** A BOM's cost and selling price per piece, as the styles list sends it. */
interface StyleBom {
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
  colors: string[]
  items: Array<{ id: string; color: string | null }>
  boms: StyleBom[]
}

interface LineDraft {
  key: string
  itemId: string
  styleCode: string
  color: string
  description: string
  qty: string
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
  lines: Array<{ itemId: string; styleCode: string | null; color: string | null; description: string | null; qty: string | number; unitPrice: string | number; discount: string | number }>
}

let lineKey = 0
const blank = (): LineDraft => ({ key: `q${++lineKey}`, itemId: '', styleCode: '', color: '', description: '', qty: '', unitPrice: '', discount: '', rateFromBom: true })
const today = () => new Date().toISOString().slice(0, 10)
const inDays = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '')
const round2 = (n: number) => Math.round(n * 100) / 100
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

function Field({ label, icon: Icon, htmlFor, required, className = '', children }: { label: string; icon?: React.ElementType; htmlFor?: string; required?: boolean; className?: string; children: React.ReactNode }) {
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
    </div>
  )
}

/**
 * A quotation: the price offered before the customer orders.
 *
 * Laid out like the order form, shorter: who it is for and how long it holds,
 * then the garments. Each line starts from the style, because that is where
 * the BOM is: picking the style and colour fills the rate with the selling
 * price set on the BOM's Pricing step, and the item to bill with the
 * finished-goods item linked to that style. The rate can be typed over for
 * this buyer; the margin it leaves over the BOM's cost is shown under it. A
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
  const [brands, setBrands] = useState<Array<{ id: string; name: string; type: string }>>([])
  const [items, setItems] = useState<ItemOption[]>([])
  const [styles, setStyles] = useState<StyleOption[]>([])
  const [newStyle, setNewStyle] = useState<{ key: string; typed: string } | null>(null)
  const [saved, setSaved] = useState<SavedQuote | null>(null)
  const [customerId, setCustomerId] = useState('')
  const [brandId, setBrandId] = useState('')
  const [quoteDate, setQuoteDate] = useState(today())
  const [validUntil, setValidUntil] = useState(inDays(15))
  const [isJobWork, setIsJobWork] = useState(false)
  const [customerRef, setCustomerRef] = useState('')
  const [salesperson, setSalesperson] = useState('')
  const [billDiscount, setBillDiscount] = useState('')
  const [terms, setTerms] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([blank()])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState<'draft' | 'send' | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  useEffect(() => {
    if (!open) return
    let alive = true
    setError(null)
    setSaved(null)
    setCustomerId('')
    setQuoteDate(today())
    setValidUntil(inDays(15))
    setIsJobWork(false)
    setCustomerRef('')
    setSalesperson('')
    setBillDiscount('')
    setTerms('')
    setNotes('')
    setLines([blank()])
    setLoading(true)
    void (async () => {
      try {
        const [c, b, it, st, q] = await Promise.all([
          fetchEveryPage<CustomerOption>((p) => `/masters/customers?active=true&limit=200&page=${p}`),
          api.get<{ data: Array<{ id: string; name: string; type: string }> }>('/masters/brands?active=true&limit=200'),
          fetchEveryPage<ItemOption>((p) => `/masters/items?type=FINISHED_GOOD&active=true&limit=200&page=${p}&sort=name&order=asc`),
          api.get<{ data: StyleOption[] }>('/sales/quotations/styles'),
          quoteId ? api.get<{ data: SavedQuote }>(`/sales/quotations/${quoteId}`) : Promise.resolve(null),
        ])
        if (!alive) return
        setCustomers([...c.rows].sort((x, y) => x.name.localeCompare(y.name)))
        setBrands(b.data)
        setItems(it.rows)
        setStyles(st.data)
        if (q) {
          const s = q.data
          setSaved(s)
          setCustomerId(s.customerId)
          setBrandId(s.brandId)
          setQuoteDate(day(s.quoteDate))
          setValidUntil(day(s.validUntil))
          setIsJobWork(s.isJobWork)
          setCustomerRef(s.customerRef ?? '')
          setSalesperson(s.salesperson ?? '')
          setBillDiscount(Number(s.discountAmount) > 0 ? String(Number(s.discountAmount)) : '')
          setTerms(s.terms ?? '')
          setNotes(s.notes ?? '')
          setLines(
            s.lines.map((l) => ({
              key: `q${++lineKey}`,
              itemId: l.itemId,
              styleCode: l.styleCode ?? '',
              color: l.color ?? '',
              description: l.description ?? '',
              qty: String(Number(l.qty)),
              unitPrice: String(Number(l.unitPrice)),
              discount: Number(l.discount) > 0 ? String(Number(l.discount)) : '',
              rateFromBom: false,
            }))
          )
        } else {
          setBrandId((b.data.find((x) => x.type === 'LD_COTTON_MILLS') ?? b.data[0])?.id ?? '')
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

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  const styleByCode = useMemo(() => new Map(styles.map((st) => [st.code.toLowerCase(), st])), [styles])

  const setLine = (key: string, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

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
        const next: LineDraft = { ...l, styleCode, color: colour, itemId: linked?.id ?? sibling?.itemId ?? l.itemId }
        if (l.rateFromBom || !l.unitPrice.trim()) {
          next.unitPrice = bom?.price != null ? String(bom.price) : l.rateFromBom ? '' : l.unitPrice
          next.rateFromBom = true
        }
        return next
      })
    )
  }

  const totals = useMemo(() => {
    const priced = lines.map((l) => {
      const item = itemById.get(l.itemId)
      const qty = Number(l.qty) || 0
      const rate = Number(l.unitPrice) || 0
      const disc = Math.min(100, Number(l.discount) || 0)
      const style = l.styleCode.trim() ? (styleByCode.get(l.styleCode.trim().toLowerCase()) ?? null) : null
      return { l, item, style, qty, rate, disc, amount: round2(qty * rate * (1 - disc / 100)), bom: style ? pickBom(style.boms, l.color) : null }
    })
    const subtotal = round2(priced.reduce((s, p) => s + p.amount, 0))
    const discount = round2(Math.min(Number(billDiscount) || 0, subtotal))
    const taxable = round2(subtotal - discount)
    const factor = subtotal > 0 ? taxable / subtotal : 1
    let tax = 0
    const withGst = priced.map((p) => {
      let gst: number | null = null
      if (p.item?.hsn) {
        const per = p.rate * (1 - p.disc / 100) * factor
        const { gstRate, priceLimit, rateAbove } = p.item.hsn
        gst = priceLimit != null && rateAbove != null && per > Number(priceLimit) ? Number(rateAbove) : Number(gstRate)
      } else if (p.item?.taxRate) gst = Number(p.item.taxRate.rate)
      tax += p.amount * factor * ((gst ?? 0) / 100)
      const net = p.rate * (1 - p.disc / 100)
      const margin = p.bom?.cost != null && net > 0 ? Math.round(((net - p.bom.cost) / net) * 1000) / 10 : null
      return { ...p, gst, margin }
    })
    return { lines: withGst, subtotal, discount, taxable, tax: round2(tax), total: Math.round(taxable + tax), pieces: priced.reduce((s, p) => s + p.qty, 0) }
  }, [lines, itemById, billDiscount, styleByCode])

  const filled = totals.lines.filter((p) => p.l.itemId || p.l.styleCode.trim())
  const noItem = filled.find((p) => !p.l.itemId)
  const blocker = !customerId
    ? 'Choose the customer.'
    : !brandId
      ? 'Choose a brand.'
      : filled.length === 0
        ? 'Add at least one garment.'
        : noItem
          ? `Choose the item ${noItem.l.styleCode || 'each line'} is billed as — it carries the HSN code and GST.`
          : filled.find((p) => p.qty <= 0 || p.l.unitPrice.trim() === '')
            ? 'Every line needs pieces and a rate.'
            : validUntil && validUntil < quoteDate
              ? 'It cannot expire before it is made.'
              : null

  const save = async (send: boolean) => {
    if (blocker) return
    setSaving(send ? 'send' : 'draft')
    setError(null)
    const body = {
      customerId,
      brandId,
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
      })),
    }
    try {
      const res = saved
        ? await api.patch<{ message?: string; data: { id: string } }>(`/sales/quotations/${saved.id}`, body)
        : await api.post<{ message?: string; data: { id: string } }>('/sales/quotations', body)
      onSaved(res.message ?? 'Quotation saved.', res.data.id)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the quotation.')
    } finally {
      setSaving(null)
    }
  }

  if (!open || !mounted) return null
  const cell = 'form-input h-8 px-2 text-xs'
  const busy = saving !== null || loading

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="qt-title">
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
              <button type="button" className="btn-primary hidden md:inline-flex" onClick={() => void save(true)} disabled={busy || !!blocker}>
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
                  <Field label="Type" htmlFor="qt-type">
                    <SmartSelect id="qt-type" className="form-input" value={isJobWork ? 'job' : 'own'} onChange={(e) => setIsJobWork(e.target.value === 'job')}>
                      <option value="own">Own order</option>
                      <option value="job">Job work (customer&apos;s fabric)</option>
                    </SmartSelect>
                  </Field>
                  <Field label="Brand" icon={Tag} htmlFor="qt-brand" required>
                    <SmartSelect id="qt-brand" className="form-input pl-9" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                      <option value="">Choose a brand</option>
                      {brands.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
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
                  Pick the style and colour, and the rate fills in from the selling price on its BOM (the BOM&apos;s Pricing step). Type over it to quote this buyer a different rate; the margin over the BOM cost shows under it.
                </p>
                <div className="border-border overflow-x-auto rounded-lg border">
                  <table className="w-full min-w-[1080px] table-fixed border-collapse text-sm">
                    <thead>
                      <tr className="bg-secondary">
                        {[
                          ['', 'w-8'],
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
                    <tbody>
                      {totals.lines.map((p, i) => {
                        const st = p.style
                        const bomPrice = p.bom?.price ?? null
                        const offBom = bomPrice != null && Math.abs(p.rate - bomPrice) >= 0.005
                        return (
                          <tr key={p.l.key} className={`${i % 2 ? 'zebra-row' : 'bg-card'} [&>td]:px-2 [&>td]:py-1.5 [&>td]:align-top`}>
                            <td>
                              <button type="button" className="btn-ghost text-muted-foreground hover:text-destructive p-1" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== p.l.key) : [blank()]))} aria-label={`Remove row ${i + 1}`}>
                                <Trash2 size={13} />
                              </button>
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
                              <SmartSelect className={cell} value={p.l.itemId} onChange={(e) => setLine(p.l.key, { itemId: e.target.value })} aria-label={`Row ${i + 1} item billed as`}>
                                <option value="">Choose the item</option>
                                {items.map((it) => (
                                  <option key={it.id} value={it.id} data-sub={it.code}>
                                    {it.name}
                                    {it.color ? ` (${it.color})` : ''}
                                  </option>
                                ))}
                              </SmartSelect>
                            </td>
                            <td>
                              <StepInput className={`${cell} text-right tabular-nums`} value={p.l.qty} placeholder="0" onValueChange={(v) => setLine(p.l.key, { qty: v })} aria-label={`Row ${i + 1} pieces`} />
                            </td>
                            <td>
                              <StepInput decimals className={`${cell} text-right tabular-nums`} value={p.l.unitPrice} placeholder="0.00" onValueChange={(v) => setLine(p.l.key, { unitPrice: v, rateFromBom: false })} aria-label={`Row ${i + 1} rate`} />
                              <div className="mt-0.5 text-right text-[10px] leading-snug">
                                {!st ? null : !p.bom ? (
                                  <span className="text-muted-foreground">
                                    {st.boms.length ? `BOM is for ${[...new Set(st.boms.map((b) => b.color).filter(Boolean))].join(', ')} — pick the colour` : 'No BOM for this style yet'}
                                  </span>
                                ) : bomPrice == null ? (
                                  <span className="warn-text" title="Set it on the BOM's Pricing step and it fills in here">
                                    BOM has no selling price yet
                                    {p.margin == null && p.bom.cost != null ? ` · cost ₹${inr(p.bom.cost)}` : ''}
                                  </span>
                                ) : offBom ? (
                                  <button type="button" className="text-primary hover:underline" onClick={() => setLine(p.l.key, { unitPrice: String(bomPrice), rateFromBom: true })} title="Go back to the BOM's selling price">
                                    BOM price ₹{inr(bomPrice)} · use it
                                  </button>
                                ) : (
                                  <span className="text-primary">BOM price{p.bom.status === 'DRAFT' ? ' (draft BOM)' : ''}</span>
                                )}
                                {p.margin != null && (
                                  <div className={p.margin < 0 ? 'text-destructive font-medium' : p.margin < 10 ? 'warn-text' : 'text-muted-foreground'}>
                                    cost ₹{inr(p.bom?.cost ?? 0)} · {p.margin}% margin
                                  </div>
                                )}
                              </div>
                            </td>
                            <td>
                              <StepInput decimals max={100} className={`${cell} text-right tabular-nums`} value={p.l.discount} placeholder="0" onValueChange={(v) => setLine(p.l.key, { discount: v })} aria-label={`Row ${i + 1} discount`} />
                            </td>
                            <td className="text-right text-xs tabular-nums">{p.gst != null ? `${p.gst}%` : p.l.itemId ? <span className="warn-text">none</span> : '—'}</td>
                            <td className="text-foreground text-right text-xs font-semibold tabular-nums">{p.amount ? inr(p.amount) : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <button type="button" className="btn-secondary mt-3 h-8 px-3 text-xs" onClick={() => setLines((ls) => [...ls, blank()])}>
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
                    ...(newStyle?.typed ? { code: newStyle.typed.toUpperCase() } : {}),
                    brandType: brands.find((x) => x.id === brandId)?.type === 'VHAGAR' ? 'VHAGAR' : 'LD_COTTON_MILLS',
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
                      <span className="text-muted-foreground">Taxable value</span>
                      <span className="tabular-nums">{inr(totals.taxable)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">GST</span>
                      <span className="tabular-nums">{inr(totals.tax)}</span>
                    </div>
                    <div className="border-primary/20 bg-primary/5 mt-2 flex items-center justify-between rounded-lg border px-3 py-2.5">
                      <span className="text-foreground font-semibold">Quoted total</span>
                      <span className="text-foreground text-lg font-semibold tabular-nums">{formatRupees(totals.total)}</span>
                    </div>
                    <p className="text-muted-foreground text-xs">GST is split CGST + SGST or IGST by the customer&apos;s state when saved.</p>
                  </div>
                </Section>
              </div>
            </>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3.5">
          {blocker && !loading && (
            <p className="warn-text mr-auto flex max-w-xl basis-full items-start gap-1.5 text-xs sm:basis-auto">
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>{blocker}</span>
            </p>
          )}
          <button type="button" onClick={onClose} className="btn-secondary hidden sm:inline-flex" disabled={saving !== null}>
            Cancel
          </button>
          <button type="button" className={saved && saved.status !== 'DRAFT' ? 'btn-primary' : 'btn-secondary'} onClick={() => void save(false)} disabled={busy || !!blocker}>
            {saving === 'draft' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {saved && saved.status !== 'DRAFT' ? 'Save' : 'Save as draft'}
          </button>
          {(!saved || saved.status === 'DRAFT') && (
            <button type="button" className="btn-primary" onClick={() => void save(true)} disabled={busy || !!blocker}>
              {saving === 'send' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Save &amp; mark sent
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
