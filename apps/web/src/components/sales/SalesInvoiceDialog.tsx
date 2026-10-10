'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Calculator,
  CalendarDays,
  FileText,
  Hash,
  Info,
  Loader2,
  MapPin,
  Package,
  Plus,
  Receipt,
  ReceiptText,
  StickyNote,
  Trash2,
  Truck,
  X,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { fetchEveryPage } from '@/lib/export'
import { formatDate, formatRupees } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { lineDetails } from './OrderLinesView'

interface Prepared {
  challan: {
    id: string
    dcNumber: string
    dcDate: string
    deliveryAddress: string | null
    transporter: string | null
    vehicleNumber: string | null
    lrNumber: string | null
    eWayBillNumber: string | null
    cartons: number | null
  }
  order: {
    id: string
    soNumber: string
    orderDate: string
    customerPORef: string | null
    customerPODate: string | null
    isJobWork: boolean
    placeOfSupplyCode: string | null
    placeOfSupplyState: string | null
    billingAddress: string | null
    deliveryAddress: string | null
    terms: string | null
    subtotal: number
    discountAmount: number
    brokeragePercent: number | null
  }
  customer: { id: string; name: string; gstin: string | null; creditDays: number; billingAddress: string }
  isIntraState: boolean | null
  placeOfSupplyProblem: string | null
  lines: Array<{
    soLineId: string
    item: { id: string; code: string; name: string; color: string | null; hsnCode: string | null } | null
    styleCode: string | null
    color: string | null
    gender: string | null
    fabric: string | null
    printName: string | null
    description: string | null
    hsnCode: string | null
    taxExempt: boolean
    qty: number
    unitPrice: number
    discount: number
    gstRate: number
    sizes: Array<{ code: string; qty: number }>
  }>
  charges: Array<{ chargeTypeId: string; name: string; amount: number; gstRate: number }>
  otherCharges: number
  defaults: { invoiceDate: string; dueDate: string }
}

interface ChargeTypeOption {
  id: string
  name: string
  defaultGstRate: string | number
  isActive: boolean
  applyOnSale: boolean
}

interface ChargeDraft {
  key: string
  chargeTypeId: string
  amount: string
  gstRate: string
}

let chargeKey = 0
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '')
const round2 = (n: number) => Math.round(n * 100) / 100
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pcs = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
/** The value above which goods need an e-way bill to travel. Shown, not enforced. */
const EWAY_LIMIT = 50_000

function Field({
  label,
  icon: Icon,
  htmlFor,
  className = '',
  children,
}: {
  label: string
  icon?: React.ElementType
  htmlFor?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label className="form-label" htmlFor={htmlFor}>
        {label}
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

function TotalRow({ label, value, quiet = false }: { label: string; value: string; quiet?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${quiet ? 'text-muted-foreground' : 'text-foreground'}`}>{value}</span>
    </div>
  )
}

/**
 * The tax invoice for one dispatched challan.
 *
 * Laid out like the other Sales forms. Nothing on the lines is typed: the
 * pieces are what the challan sent, and the rate, discount and GST rate are
 * what the order agreed — to bill at another rate, amend the order first.
 * The order's discount on the whole bill is shared out by this invoice's
 * share of the goods. What is typed is what an invoice carries beyond the
 * goods: its dates, the addresses, the transport and e-way bill, the charges
 * (offered as whatever of the order's no earlier invoice billed), other
 * charges, notes and terms.
 *
 * An invoice is final when saved — there is no draft. A wrong one is
 * cancelled from the list, with a reason, and the challan billed again.
 */
export function SalesInvoiceDialog({
  dcId,
  onClose,
  onSaved,
}: {
  /** The challan to bill; null keeps the form closed. */
  dcId: string | null
  onClose: () => void
  onSaved: (message: string, invoiceId: string) => void
}) {
  const open = !!dcId
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [prep, setPrep] = useState<Prepared | null>(null)
  const [chargeTypes, setChargeTypes] = useState<ChargeTypeOption[]>([])
  const [loading, setLoading] = useState(false)
  const [invoiceDate, setInvoiceDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [billingAddress, setBillingAddress] = useState('')
  const [shippingAddress, setShippingAddress] = useState('')
  const [transporter, setTransporter] = useState('')
  const [vehicleNumber, setVehicleNumber] = useState('')
  const [lrNumber, setLrNumber] = useState('')
  const [eWayBillNumber, setEWayBillNumber] = useState('')
  const [eWayBillDate, setEWayBillDate] = useState('')
  const [charges, setCharges] = useState<ChargeDraft[]>([])
  const [otherCharges, setOtherCharges] = useState('')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState('')
  const [saving, setSaving] = useState(false)
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
    if (!dcId) return
    let alive = true
    setError(null)
    setPrep(null)
    setLoading(true)
    void (async () => {
      try {
        const [p, ct] = await Promise.all([
          api.get<{ data: Prepared }>(`/sales/invoices/prepare?dcId=${dcId}`),
          fetchEveryPage<ChargeTypeOption>((pg) => `/masters/charge-types?limit=200&page=${pg}`).catch(() => ({
            rows: [] as ChargeTypeOption[],
          })),
        ])
        if (!alive) return
        const d = p.data
        setPrep(d)
        setChargeTypes(ct.rows.filter((x) => x.isActive && x.applyOnSale).sort((a, b) => a.name.localeCompare(b.name)))
        setInvoiceDate(day(d.defaults.invoiceDate))
        setDueDate(day(d.defaults.dueDate))
        setBillingAddress(d.order.billingAddress || d.customer.billingAddress)
        setShippingAddress(d.challan.deliveryAddress || d.order.deliveryAddress || '')
        setTransporter(d.challan.transporter ?? '')
        setVehicleNumber(d.challan.vehicleNumber ?? '')
        setLrNumber(d.challan.lrNumber ?? '')
        setEWayBillNumber(d.challan.eWayBillNumber ?? '')
        setEWayBillDate('')
        setCharges(
          d.charges.map((c) => ({
            key: `c${++chargeKey}`,
            chargeTypeId: c.chargeTypeId,
            amount: String(c.amount),
            gstRate: String(c.gstRate),
          }))
        )
        setOtherCharges(d.otherCharges > 0 ? String(d.otherCharges) : '')
        setNotes('')
        setTerms(d.order.terms ?? '')
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err.message : 'Could not open the challan.')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [dcId])

  /** A due date that follows the invoice date by the customer's credit days. */
  const pickInvoiceDate = (v: string) => {
    setInvoiceDate(v)
    if (prep && v) {
      const d = new Date(v)
      d.setDate(d.getDate() + (prep.customer.creditDays ?? 0))
      setDueDate(d.toISOString().slice(0, 10))
    }
  }

  const chargeTypeById = useMemo(() => new Map(chargeTypes.map((c) => [c.id, c])), [chargeTypes])

  // ── The same sums the server does; the server's are the record ─────────
  const totals = useMemo(() => {
    if (!prep) return null
    const intra = prep.isIntraState
    const split = (tax: number) =>
      intra ? { cgst: round2(tax / 2), sgst: round2(tax / 2), igst: 0 } : { cgst: 0, sgst: 0, igst: round2(tax) }
    const gross = prep.lines.map((l) => round2(l.qty * l.unitPrice * (1 - l.discount / 100)))
    const subtotal = round2(gross.reduce((s, n) => s + n, 0))
    const discount =
      prep.order.subtotal > 0 ? round2(Math.min(subtotal, (prep.order.discountAmount * subtotal) / prep.order.subtotal)) : 0
    const taxable = round2(subtotal - discount)
    const factor = subtotal > 0 ? taxable / subtotal : 1
    const lines = prep.lines.map((l, i) => {
      const value = round2(gross[i] * factor)
      const t = split((value * l.gstRate) / 100)
      return { ...l, gross: gross[i], value, tax: t.cgst + t.sgst + t.igst, ...t }
    })
    const chargeRows = charges.map((c) => {
      const type = chargeTypeById.get(c.chargeTypeId)
      const amount = Number(c.amount) || 0
      const rate = c.gstRate !== '' ? Number(c.gstRate) || 0 : Number(type?.defaultGstRate ?? 0)
      const t = split((amount * rate) / 100)
      return { ...c, type, value: amount, rate, ...t }
    })
    const live = chargeRows.filter((c) => c.type && c.value > 0)
    const chargeTotal = round2(live.reduce((s, c) => s + c.value, 0))
    const sum = (k: 'cgst' | 'sgst' | 'igst') =>
      round2(lines.reduce((s, l) => s + l[k], 0) + live.reduce((s, c) => s + c[k], 0))
    const cgst = sum('cgst')
    const sgst = sum('sgst')
    const igst = sum('igst')
    const other = round2(Number(otherCharges) || 0)
    const before = taxable + chargeTotal + cgst + sgst + igst + other
    const total = Math.round(before)
    return {
      lines,
      subtotal,
      discount,
      taxable,
      chargeRows,
      chargeTotal,
      cgst,
      sgst,
      igst,
      other,
      roundOff: round2(total - before),
      total,
      pieces: prep.lines.reduce((s, l) => s + l.qty, 0),
    }
  }, [prep, charges, chargeTypeById, otherCharges])

  const chargeNoType = totals?.chargeRows.find((c) => !c.type && c.value > 0)
  const blocker = !prep
    ? null
    : prep.placeOfSupplyProblem
      ? prep.placeOfSupplyProblem
      : !invoiceDate
        ? 'Give the invoice a date.'
        : dueDate && dueDate < invoiceDate
          ? 'The due date cannot be before the invoice date.'
          : chargeNoType
            ? 'Pick which charge the amount in the totals is for.'
            : null

  const save = async () => {
    if (!prep || !totals || blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string; data: { id: string; invoiceNumber: string } }>('/sales/invoices', {
        dcId: prep.challan.id,
        invoiceDate,
        dueDate: dueDate || null,
        billingAddress: billingAddress.trim() || null,
        shippingAddress: shippingAddress.trim() || null,
        transporter: transporter.trim() || null,
        vehicleNumber: vehicleNumber.trim().toUpperCase() || null,
        lrNumber: lrNumber.trim() || null,
        eWayBillNumber: eWayBillNumber.trim() || null,
        eWayBillDate: eWayBillDate || null,
        charges: totals.chargeRows
          .filter((c) => c.type && c.value > 0)
          .map((c) => ({ chargeTypeId: c.chargeTypeId, amount: c.value, gstRate: c.gstRate !== '' ? c.rate : null })),
        otherCharges: totals.other,
        notes: notes.trim() || null,
        terms: terms.trim() || null,
      })
      onSaved(res.message ?? `${res.data.invoiceNumber} raised.`, res.data.id)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not raise the invoice.')
    } finally {
      setSaving(false)
    }
  }

  if (!open || !mounted) return null

  const o = prep?.order
  const taxLabel = prep?.isIntraState ? 'CGST + SGST' : prep?.isIntraState === false ? 'IGST' : 'GST'
  const setCharge = (key: string, patch: Partial<ChargeDraft>) =>
    setCharges((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)))

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="inv-title">
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <ReceiptText size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="inv-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                Tax Invoice
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {prep ? `Billing ${prep.challan.dcNumber} · ${prep.customer.name}` : 'For goods dispatched on a challan'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className="btn-primary hidden md:inline-flex" onClick={() => void save()} disabled={saving || loading || !!blocker || !prep}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <ReceiptText size={15} />} Save invoice
            </button>
            <button onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={saving}>
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
          {loading || !prep || !o || !totals ? (
            !error && <div className="skeleton h-72 w-full rounded-xl" />
          ) : (
            <>
              <Section icon={FileText} title="Basic Details">
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                  <Field label="Invoice no." icon={Hash}>
                    <div className="form-input text-muted-foreground pl-9 font-mono">Given when saved</div>
                  </Field>
                  <Field label="Invoice date" htmlFor="inv-date">
                    <input id="inv-date" type="date" className="form-input" value={invoiceDate} min={day(o.orderDate)} onChange={(e) => pickInvoiceDate(e.target.value)} />
                  </Field>
                  <Field label={`Due date (${prep.customer.creditDays} days' credit)`} htmlFor="inv-due">
                    <input id="inv-due" type="date" className="form-input" value={dueDate} min={invoiceDate || undefined} onChange={(e) => setDueDate(e.target.value)} />
                  </Field>
                  <Field label="Sales order" icon={Hash}>
                    <div className="form-input pl-9 font-mono" title={`Ordered ${formatDate(o.orderDate)}`}>
                      {o.soNumber}
                    </div>
                  </Field>
                  <Field label="Delivery challan" icon={Truck}>
                    <div className="form-input pl-9 font-mono" title={`Dispatched ${formatDate(prep.challan.dcDate)}`}>
                      {prep.challan.dcNumber}
                    </div>
                  </Field>

                  <Field label="Bill to" icon={Receipt} htmlFor="inv-bill" className="sm:col-span-2 lg:col-span-5">
                    <input id="inv-bill" className="form-input pl-9" maxLength={500} value={billingAddress} onChange={(e) => setBillingAddress(e.target.value)} />
                  </Field>
                  <Field label="Ship to" icon={MapPin} htmlFor="inv-ship" className="sm:col-span-2 lg:col-span-5">
                    <input id="inv-ship" className="form-input pl-9" maxLength={500} value={shippingAddress} onChange={(e) => setShippingAddress(e.target.value)} />
                  </Field>
                </div>
                <div className="border-border bg-secondary/30 mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border px-3 py-2 text-xs">
                  <span className="text-foreground font-medium">{prep.customer.name}</span>
                  <span className="text-muted-foreground">
                    {prep.customer.gstin ? (
                      <>
                        GSTIN <span className="font-mono">{prep.customer.gstin}</span>
                      </>
                    ) : (
                      'Not registered for GST'
                    )}
                  </span>
                  {o.placeOfSupplyCode && (
                    <span className="badge-info">
                      Place of supply {o.placeOfSupplyCode} {o.placeOfSupplyState} · {taxLabel}
                    </span>
                  )}
                  {o.customerPORef && (
                    <span className="text-muted-foreground">
                      Buyer PO {o.customerPORef}
                      {o.customerPODate ? `, ${formatDate(o.customerPODate)}` : ''}
                    </span>
                  )}
                  {o.isJobWork && <span className="badge-purple">Job work · job charges only</span>}
                </div>
              </Section>

              <Section icon={Truck} title="Transport and e-way bill">
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                  <Field label="Transporter" htmlFor="inv-transporter">
                    <input id="inv-transporter" className="form-input" maxLength={120} value={transporter} onChange={(e) => setTransporter(e.target.value)} />
                  </Field>
                  <Field label="Vehicle no." htmlFor="inv-vehicle">
                    <input id="inv-vehicle" className="form-input font-mono uppercase" maxLength={30} value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} />
                  </Field>
                  <Field label="LR no." htmlFor="inv-lr">
                    <input id="inv-lr" className="form-input font-mono" maxLength={60} value={lrNumber} onChange={(e) => setLrNumber(e.target.value)} />
                  </Field>
                  <Field label="E-way bill no." htmlFor="inv-ewb">
                    <input id="inv-ewb" className="form-input font-mono" maxLength={30} value={eWayBillNumber} onChange={(e) => setEWayBillNumber(e.target.value)} />
                  </Field>
                  <Field label="E-way bill date" icon={CalendarDays} htmlFor="inv-ewb-date">
                    <input id="inv-ewb-date" type="date" className="form-input pl-9" value={eWayBillDate} onChange={(e) => setEWayBillDate(e.target.value)} />
                  </Field>
                </div>
                <p className={`mt-2 flex items-start gap-1.5 text-xs ${totals.total > EWAY_LIMIT && !eWayBillNumber.trim() ? 'warn-text' : 'text-muted-foreground'}`}>
                  <Info size={13} className="mt-px shrink-0" />
                  {totals.total > EWAY_LIMIT
                    ? `Worth ${formatRupees(totals.total)}: above ₹50,000, so the goods need an e-way bill. Its number goes onto the challan too.`
                    : 'Under ₹50,000: no e-way bill needed.'}
                </p>
              </Section>

              <Section
                icon={Package}
                title="Items"
                actions={<span className="text-muted-foreground text-xs tabular-nums">{pcs(totals.pieces)} pcs</span>}
              >
                <p className="text-muted-foreground mb-2 text-xs">
                  The pieces the challan sent, at the order&apos;s rates. To bill at another rate, amend the order first.
                </p>
                <div className="border-border overflow-x-auto rounded-lg border">
                  <table className="data-table w-full min-w-[920px]">
                    <thead>
                      <tr className="bg-secondary">
                        <th>Item</th>
                        <th>HSN</th>
                        <th style={{ textAlign: 'right' }}>Pieces</th>
                        <th style={{ textAlign: 'right' }}>Rate</th>
                        <th style={{ textAlign: 'right' }}>Disc</th>
                        <th style={{ textAlign: 'right' }}>Taxable</th>
                        <th style={{ textAlign: 'right' }}>GST</th>
                        <th style={{ textAlign: 'right' }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {totals.lines.map((l) => (
                        <tr key={l.soLineId}>
                          <td>
                            <div className="text-foreground text-sm font-medium">
                              {l.item?.name}
                              {(l.color || l.item?.color) && <span className="text-muted-foreground font-normal"> · {l.color || l.item?.color}</span>}
                            </div>
                            <div className="text-muted-foreground text-[11px]">
                              <span className="font-mono">{l.item?.code}</span>
                              {l.styleCode ? ` · Style ${l.styleCode}` : ''}
                              {lineDetails(l) ? ` · ${lineDetails(l)}` : ''}
                            </div>
                            {l.sizes.length > 0 && (
                              <div className="text-muted-foreground text-[11px] tabular-nums">{l.sizes.map((s) => `${s.code} ${pcs(s.qty)}`).join(' · ')}</div>
                            )}
                          </td>
                          <td className="font-mono text-xs">{l.hsnCode ?? '—'}</td>
                          <td className="text-right tabular-nums">{pcs(l.qty)}</td>
                          <td className="text-right tabular-nums">{inr(l.unitPrice)}</td>
                          <td className="text-right text-xs tabular-nums">{l.discount > 0 ? `${l.discount}%` : '—'}</td>
                          <td className="text-right tabular-nums">{inr(l.value)}</td>
                          <td className="text-right text-xs tabular-nums">
                            {l.taxExempt ? 'Nil' : `${l.gstRate}%`}
                            {l.tax > 0 && <div className="text-muted-foreground text-[11px]">{inr(l.tax)}</div>}
                          </td>
                          <td className="text-right font-semibold tabular-nums">{inr(l.value + l.tax)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_440px]">
                <Section icon={StickyNote} title="Notes and terms">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label className="block">
                      <span className="form-label">Notes (printed on the invoice)</span>
                      <textarea className="form-input min-h-[6rem]" rows={4} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
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
                </Section>

                <Section icon={Calculator} title="Totals">
                  <div className="space-y-1.5 text-sm">
                    <TotalRow label={`Value of ${pcs(totals.pieces)} pcs`} value={inr(totals.subtotal)} />
                    {totals.discount > 0 && (
                      <TotalRow label="This invoice's share of the order discount" value={`− ${inr(totals.discount)}`} />
                    )}
                    <TotalRow label="Taxable value" value={inr(totals.taxable)} />

                    {chargeTypes.length > 0 && (
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
                            onClick={() => setCharges((cs) => [...cs, { key: `c${++chargeKey}`, chargeTypeId: '', amount: '', gstRate: '' }])}
                            className="text-muted-foreground hover:text-primary flex items-center gap-1 text-xs transition-colors"
                          >
                            <Plus size={12} /> Add charge
                          </button>
                        )}
                      </div>
                    )}

                    {prep.isIntraState ? (
                      <>
                        <TotalRow label="CGST" value={inr(totals.cgst)} />
                        <TotalRow label="SGST" value={inr(totals.sgst)} />
                      </>
                    ) : (
                      <TotalRow label="IGST" value={inr(totals.igst)} />
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="inv-other" className="text-muted-foreground">
                        Other charges (no GST)
                      </label>
                      <StepInput
                        id="inv-other"
                        decimals
                        className="form-input h-8 w-28 text-right tabular-nums"
                        value={otherCharges}
                        placeholder="0.00"
                        onValueChange={setOtherCharges}
                      />
                    </div>
                    {Math.abs(totals.roundOff) >= 0.005 && <TotalRow label="Rounding" value={inr(totals.roundOff)} quiet />}
                    <div className="border-primary/20 bg-primary/5 mt-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                      <span className="text-foreground font-semibold">Invoice total</span>
                      <span className="text-foreground whitespace-nowrap text-lg font-semibold tabular-nums">{formatRupees(totals.total)}</span>
                    </div>
                    <p className="text-muted-foreground pt-1 text-xs">
                      Due {dueDate ? formatDate(dueDate) : '—'}. Charges are offered as whatever of the order&apos;s no earlier invoice
                      has billed.
                    </p>
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
          <button type="button" onClick={onClose} className="btn-secondary hidden sm:inline-flex" disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || loading || !!blocker || !prep}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <ReceiptText size={15} />} Save invoice
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
