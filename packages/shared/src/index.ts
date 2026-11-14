// LD ERP Solution — Shared Types
// Used across web, mobile, and api packages

export type UserRole = 'Admin' | 'MD' | 'Accounts Manager' | 'Production Manager' | 'Store Manager' | 'HR Manager' | 'Sales'

export type SalesOrderStatus = 'DRAFT' | 'CONFIRMED' | 'IN_PRODUCTION' | 'PARTIALLY_DISPATCHED' | 'COMPLETED' | 'CANCELLED'
export type PurchaseOrderStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_RECEIVED' | 'COMPLETED' | 'CANCELLED'
export type MOStatus = 'DRAFT' | 'RELEASED' | 'CUTTING' | 'STITCHING' | 'FINISHING' | 'QC' | 'PACKING' | 'COMPLETED' | 'CLOSED'
export type BrandType = 'LD_COTTON_MILLS' | 'VHAGAR' | 'CUSTOM'
export type ItemType = 'RAW_MATERIAL' | 'SEMI_FINISHED' | 'FINISHED_GOOD' | 'CONSUMABLE' | 'PACKING_MATERIAL' | 'TRIM'
export type PaymentMode = 'CASH' | 'CHEQUE' | 'NEFT' | 'RTGS' | 'UPI' | 'PDC'

export interface User {
  id: string
  name: string
  email: string
  role: UserRole
  permissions: string[]
  avatarUrl?: string
}

export interface APIResponse<T = unknown> {
  success: boolean
  data?: T
  message?: string
  errors?: unknown[]
  pagination?: {
    page: number
    limit: number
    total: number
    pages: number
  }
}

export interface KPIData {
  activeOrders: number
  todayProduction: {
    achieved: number
    target: number
    efficiency: string
    rejection: number
  }
  pendingApprovals: number
  revenueMTD: number
  outstandingReceivable: number
  outstandingPayable: number
}

export interface SalesOrder {
  id: string
  soNumber: string
  customer: { id: string; name: string; type: string }
  brand: { id: string; name: string; type: BrandType }
  status: SalesOrderStatus
  totalAmount: number
  deliveryDate?: string
  isJobWork: boolean
  createdAt: string
  updatedAt: string
}

export interface ProductionEntry {
  id: string
  moId: string
  entryDate: string
  department: string
  lineNumber?: string
  target: number
  achieved: number
  rejection: number
  efficiency?: number
}

export interface Notification {
  id: string
  title: string
  message: string
  type: 'LOW_STOCK' | 'APPROVAL_PENDING' | 'PAYMENT_RECEIVED' | 'OVERDUE' | 'PRODUCTION_ALERT' | 'SYSTEM'
  isRead: boolean
  createdAt: string
}

// Indian number formatting
export const formatINR = (amount: number): string => {
  if (amount >= 10000000) return `₹${(amount / 10000000).toFixed(2)} Cr`
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(2)} L`
  if (amount >= 1000) return `₹${(amount / 1000).toFixed(1)}K`
  return `₹${amount.toLocaleString('en-IN')}`
}

export const MODULES = [
  'dashboard', 'masters', 'sales', 'purchase', 'inventory',
  'production', 'accounts', 'hr', 'vhagar', 'maintenance', 'ai', 'settings', 'admin'
] as const

export type Module = typeof MODULES[number]

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export'] as const
export type Action = typeof ACTIONS[number]

// ─────────────────────────────────────────────────────────────────────────────
// Purchase pricing — one calculation for the purchase order and the purchase
// bill, on the screen and on the server.
//
// The form, the API, the print and the bill each used to do their own sums,
// rounding at different steps, so the screen and the saved document could
// disagree by a rupee and nobody could say which was right. Every figure now
// comes from priceDocument(): the form calls it as you type, the server calls
// it again on save and stores what it returns, and the print shows what was
// stored.
//
// It works in whole paise, so 0.1 + 0.2 never becomes 0.30000000000000004 on
// an invoice. Kept in this one file on purpose: the API loads this package
// from source at run time, and a single file needs no import resolution.
//
// Each charge carries a GST rate. Purchase orders and bills send every charge
// at 0%: freight, transport and the rest are typed as the final figure on the
// supplier's bill, GST already inside it, and are added to the total as they
// are. A rate above 0 is still priced correctly, for documents saved before.
// ─────────────────────────────────────────────────────────────────────────────

/** How GST is split: within the state, across states, or none at all. */
export type GstSplit = 'CGST_SGST' | 'IGST' | 'NONE'

export interface PriceLineInput {
  qty: number
  rate: number
  /** Percent off qty × rate, 0 to 100. */
  discountPct?: number
  /** GST % on this line; 0 for an exempt item. */
  gstRate: number
}

/** Classification is independent of whether the entered price includes GST. */
export type ChargeTaxCategory = 'TAXABLE' | 'EXEMPT' | 'NIL_RATED' | 'NON_GST' | 'UNSPECIFIED'
export type ChargeAmountMode = 'FIXED' | 'PERCENT'
export interface ChargeTaxSnapshot {
  version: 1
  name: string
  treatment: ChargeTaxTreatment
  followsGoodsRate: boolean
  ownRate: number
  hsnCodeId: string | null
  hsnCode: string | null
  taxCategory: ChargeTaxCategory
  amountMode: ChargeAmountMode
  inputAmount: number
  basis: 'GOODS_AFTER_DISCOUNT'
  overrideReason?: string
  parts?: SaleChargePart[]
}
/** Read only a version we understand; old records are deliberately not inferred. */
export function chargeSnapshot(value: unknown): ChargeTaxSnapshot | null {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return null
  return value as ChargeTaxSnapshot
}

export interface PriceChargeInput {
  config?: ChargeTaxSnapshot
  /** The charge type id, or any key the caller wants back. */
  key: string
  amount: number
  /** GST % on this charge, as chosen on the document. */
  gstRate: number
}

export interface PriceInput {
  lines: PriceLineInput[]
  /** Rupees off the goods as a whole, before tax. Capped at the goods' value. */
  orderDiscount?: number
  charges?: PriceChargeInput[]
  /**
   * An amount added after tax with no GST. Only purchase orders saved before
   * charges carried their own GST have one; nothing new should send it.
   */
  untaxedExtra?: number
  split: GstSplit
  /**
   * Reverse charge: GST is worked out and recorded, but it is ours to pay to
   * the government, so it is not added to what the supplier is paid.
   */
  reverseCharge?: boolean
}

export interface PricedTax {
  /** The rate actually applied: 0 whenever the split is NONE. */
  gstRate: number
  cgst: number
  sgst: number
  igst: number
  tax: number
}

export interface PricedLine extends PricedTax {
  /** qty × rate. */
  gross: number
  /** This line's own discount. */
  discount: number
  /** This line's share of the order-level discount. */
  orderDiscount: number
  /** What GST is worked out on. */
  taxable: number
  /** taxable + tax. */
  amount: number
}

export interface PricedCharge extends PricedTax {
  enteredAmount: number
  payable: number
  parts: SaleChargePart[]
  taxSnapshot?: ChargeTaxSnapshot
  key: string
  amount: number
}

export interface TaxByRate extends PricedTax {
  /** Goods and charges at this rate together. */
  taxable: number
  goodsTaxable: number
  chargeTaxable: number
}

export interface PriceResult {
  lines: PricedLine[]
  charges: PricedCharge[]
  /** Σ qty × rate. */
  gross: number
  /** Σ per-line discounts. */
  lineDiscount: number
  /** The order-level discount actually taken. */
  orderDiscount: number
  /** Every discount on the document. */
  totalDiscount: number
  /** Goods after every discount. */
  goodsTaxable: number
  chargeTotal: number
  /** Goods + charges: everything GST is worked out on. */
  taxable: number
  goodsTax: number
  chargeTax: number
  cgst: number
  sgst: number
  igst: number
  tax: number
  /** Tax by rate, lowest rate first — the "where does the GST come from" view. */
  byRate: TaxByRate[]
  untaxedExtra: number
  beforeRound: number
  roundOff: number
  /** Rounded to the rupee. Under reverse charge it leaves the GST out. */
  total: number
}

const toPaise = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100)
const toRupees = (p: number) => p / 100
/** Paise at a % rate, half up. */
const percentOf = (paise: number, rate: number) => Math.round((paise * rate) / 100)
const clampPct = (n: number | undefined) => Math.min(100, Math.max(0, Number.isFinite(n) ? Number(n) : 0))

/**
 * Tax on one taxable value, in paise.
 *
 * Within the state CGST and SGST are each worked out at half the rate, as a
 * GST invoice shows them, so the two halves are always equal and always add
 * up to the tax shown.
 */
function taxOn(taxablePaise: number, rate: number, split: GstSplit) {
  if (split === 'NONE' || rate <= 0) return { gstRate: split === 'NONE' ? 0 : rate, cgst: 0, sgst: 0, igst: 0, tax: 0 }
  if (split === 'IGST') {
    const igst = percentOf(taxablePaise, rate)
    return { gstRate: rate, cgst: 0, sgst: 0, igst, tax: igst }
  }
  const half = percentOf(taxablePaise, rate / 2)
  return { gstRate: rate, cgst: half, sgst: half, igst: 0, tax: half * 2 }
}

export function priceDocument(input: PriceInput): PriceResult {
  const split = input.split

  // ── Goods ────────────────────────────────────────────────────────────────
  const gross = input.lines.map((l) => toPaise((Number(l.qty) || 0) * (Number(l.rate) || 0)))
  const ownDiscount = input.lines.map((l, i) => Math.min(gross[i], percentOf(gross[i], clampPct(l.discountPct))))
  const value = gross.map((g, i) => g - ownDiscount[i])
  const valueTotal = value.reduce((s, v) => s + v, 0)

  // Allocate the discount by value using whole paise and largest remainders.
  const orderDiscount = Math.min(Math.max(0, toPaise(input.orderDiscount ?? 0)), valueTotal)
  const share = allocatePaise(orderDiscount, value)

  const lineTax = value.map((v, i) => taxOn(v - share[i], Number(input.lines[i].gstRate) || 0, split))

  // ── Charges ──────────────────────────────────────────────────────────────
  const charges = (input.charges ?? []).map((c) => {
    const config = c.config
    const p = priceSaleCharge({ key: c.key, amount: c.amount,
      treatment: split === 'NONE' ? 'NON_TAXABLE' : config?.treatment ?? 'EXCLUSIVE',
      followsGoodsRate: config?.followsGoodsRate ?? false, ownRate: config?.ownRate ?? c.gstRate,
      amountMode: config?.amountMode, taxCategory: config?.taxCategory,
    }, value.map((v, i) => ({ taxable: toRupees(v - share[i]), gstRate: input.lines[i].gstRate })), split === 'CGST_SGST')
    return { key: c.key, amount: toPaise(p.net), gstRate: p.gstRate,
      cgst: toPaise(p.cgst), sgst: toPaise(p.sgst), igst: toPaise(p.igst), tax: toPaise(p.tax),
      enteredAmount: p.amount, payable: p.payable, parts: p.parts,
      taxSnapshot: config ? { ...config, inputAmount: c.amount, parts: p.parts } : undefined }

  })

  // ── Tax by rate ──────────────────────────────────────────────────────────
  const buckets = new Map<number, { goods: number; charges: number; cgst: number; sgst: number; igst: number; tax: number }>()
  const bucket = (rate: number) => {
    let b = buckets.get(rate)
    if (!b) buckets.set(rate, (b = { goods: 0, charges: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 }))
    return b
  }
  lineTax.forEach((t, i) => {
    const b = bucket(t.gstRate)
    b.goods += value[i] - share[i]
    b.cgst += t.cgst
    b.sgst += t.sgst
    b.igst += t.igst
    b.tax += t.tax
  })
  charges.forEach((c) => {
    const parts = c.parts.length ? c.parts : [{ gstRate: 0, net: toRupees(c.amount), cgst: 0, sgst: 0, igst: 0, tax: 0 }]
    for (const p of parts) {
      const b = bucket(p.gstRate)
      b.charges += toPaise(p.net)
      b.cgst += toPaise(p.cgst); b.sgst += toPaise(p.sgst); b.igst += toPaise(p.igst); b.tax += toPaise(p.tax)
    }
  })

  // ── Totals ───────────────────────────────────────────────────────────────
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0)
  const goodsTaxable = valueTotal - orderDiscount
  const chargeTotal = sum(charges.map((c) => c.amount))
  const goodsTax = sum(lineTax.map((t) => t.tax))
  const chargeTax = sum(charges.map((c) => c.tax))
  const cgst = sum(lineTax.map((t) => t.cgst)) + sum(charges.map((c) => c.cgst))
  const sgst = sum(lineTax.map((t) => t.sgst)) + sum(charges.map((c) => c.sgst))
  const igst = sum(lineTax.map((t) => t.igst)) + sum(charges.map((c) => c.igst))
  const tax = goodsTax + chargeTax
  const untaxedExtra = Math.max(0, toPaise(input.untaxedExtra ?? 0))
  const beforeRound = goodsTaxable + chargeTotal + (input.reverseCharge ? 0 : tax) + untaxedExtra
  const total = Math.round(beforeRound / 100) * 100

  return {
    lines: input.lines.map((_, i) => ({
      gross: toRupees(gross[i]),
      discount: toRupees(ownDiscount[i]),
      orderDiscount: toRupees(share[i]),
      taxable: toRupees(value[i] - share[i]),
      gstRate: lineTax[i].gstRate,
      cgst: toRupees(lineTax[i].cgst),
      sgst: toRupees(lineTax[i].sgst),
      igst: toRupees(lineTax[i].igst),
      tax: toRupees(lineTax[i].tax),
      amount: toRupees(value[i] - share[i] + lineTax[i].tax),
    })),
    charges: charges.map((c) => ({
      enteredAmount: c.enteredAmount, payable: c.payable, parts: c.parts, taxSnapshot: c.taxSnapshot,
      key: c.key,
      amount: toRupees(c.amount),
      gstRate: c.gstRate,
      cgst: toRupees(c.cgst),
      sgst: toRupees(c.sgst),
      igst: toRupees(c.igst),
      tax: toRupees(c.tax),
    })),
    gross: toRupees(sum(gross)),
    lineDiscount: toRupees(sum(ownDiscount)),
    orderDiscount: toRupees(orderDiscount),
    totalDiscount: toRupees(sum(ownDiscount) + orderDiscount),
    goodsTaxable: toRupees(goodsTaxable),
    chargeTotal: toRupees(chargeTotal),
    taxable: toRupees(goodsTaxable + chargeTotal),
    goodsTax: toRupees(goodsTax),
    chargeTax: toRupees(chargeTax),
    cgst: toRupees(cgst),
    sgst: toRupees(sgst),
    igst: toRupees(igst),
    tax: toRupees(tax),
    byRate: [...buckets.entries()]
      .filter(([, b]) => b.goods + b.charges > 0)
      .sort(([a], [b]) => a - b)
      .map(([rate, b]) => ({
        gstRate: rate,
        taxable: toRupees(b.goods + b.charges),
        goodsTaxable: toRupees(b.goods),
        chargeTaxable: toRupees(b.charges),
        cgst: toRupees(b.cgst),
        sgst: toRupees(b.sgst),
        igst: toRupees(b.igst),
        tax: toRupees(b.tax),
      })),
    untaxedExtra: toRupees(untaxedExtra),
    beforeRound: toRupees(beforeRound),
    roundOff: toRupees(total - beforeRound),
    total: toRupees(total),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales pricing — one calculation for the quotation, the sales order and the
// charges on a sales invoice, on the screen and on the server.
//
// The quotation form, the order form and the server each used to do their own
// sums. Every figure now comes from priceSale() (and priceSaleCharge() for an
// invoice's charges): the forms call it as you type, the server calls it again
// on save and stores what it returns, and the prints show what was stored.
// The goods are priced with the same steps and roundings the order always
// used, so no order already saved reads differently.
//
// A charge billed with the goods — transport, freight, packing — is part of
// what the goods are sold for (CGST Act s.15(2)(c)), so by default it is
// taxed at the goods' rate, shared across their rates by value; a charge type
// can instead be a supply of its own at its own rate. Separately, the figure
// typed for a charge is one of three things:
//
//   INCLUSIVE    the final figure, GST already inside it. The GST inside is
//                worked out (₹1,200 at 5% holds ₹57.14, value ₹1,142.86) and
//                reported, and nothing is added on top: the charge adds
//                exactly ₹1,200 to the bill.
//   EXCLUSIVE    the value before GST; its GST is added on top.
//   NON_TAXABLE  no GST at all, and outside the value GST is worked out on
//                (an expense recovered at cost, say). Not the same as
//                INCLUSIVE: an inclusive charge still carries GST that is
//                reported and paid; a non-taxable one carries none.
// ─────────────────────────────────────────────────────────────────────────────

/** How GST sits on a charge billed with a sale. */
export type ChargeTaxTreatment = 'INCLUSIVE' | 'EXCLUSIVE' | 'NON_TAXABLE'

export const CHARGE_TAX_TREATMENTS: readonly ChargeTaxTreatment[] = ['INCLUSIVE', 'EXCLUSIVE', 'NON_TAXABLE']

/** Each treatment as a form and a print name it. */
export const CHARGE_TAX_TREATMENT_LABEL: Record<ChargeTaxTreatment, string> = {
  INCLUSIVE: 'GST included',
  EXCLUSIVE: 'GST added on top',
  NON_TAXABLE: 'No GST',
}

/**
 * Where a purchase charge's GST rate comes from.
 *
 * A purchase charge (freight, transport, dyeing) is always typed as a figure
 * before GST, and its GST is always added on top — unlike a sales charge,
 * which can be typed either way (see `ChargeTaxTreatment` above). What is
 * chosen here is only where the rate itself comes from:
 *
 *   HSN     the rate carried by an HSN / SAC code picked for this charge.
 *   MANUAL  a rate typed by hand — the mill knows the rate and is not
 *           looking it up.
 *   NONE    no GST on this charge at all.
 *
 * Every purchase charge saved before 13 Nov 2026 is NONE: between 6 and
 * 13 Nov 2026 every purchase charge was taken as the supplier's GST-included
 * figure with nothing added on top, which came to the same total as NONE at
 * 0%, so nothing already saved changes.
 */
export type ChargeGstMode = 'HSN' | 'MANUAL' | 'NONE' | 'INHERIT'

export const CHARGE_GST_MODES: readonly ChargeGstMode[] = ['HSN', 'MANUAL', 'NONE', 'INHERIT']

export const CHARGE_GST_MODE_LABEL: Record<ChargeGstMode, string> = {
  INHERIT: 'Inherit from goods',
  HSN: 'By HSN / SAC code',
  MANUAL: 'A % I set',
  NONE: 'Not applicable',
}

const r2 = (n: number) => {
  const v = Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
  return v === 0 ? 0 : v
}

/** The goods a charge goes with: one line's taxable value and its GST rate. */
export interface SaleGoods {
  taxable: number
  gstRate: number
}

/** Largest remainders conserve paise without making small shares negative. */
export function allocatePaise(total: number, weights: number[]): number[] {
  const sum = weights.reduce((n, weight) => n + Math.max(0, weight), 0)
  if (!(sum > 0)) return weights.map(() => 0)
  const raw = weights.map(weight => total * Math.max(0, weight) / sum)
  const shares = raw.map(Math.floor)
  let remainder = total - shares.reduce((n, share) => n + share, 0)
  const order = raw.map((v, i) => ({ i, fraction: v - shares[i] })).sort((a, b) => b.fraction - a.fraction || a.i - b.i)
  for (const { i } of order) { if (remainder-- <= 0) break; shares[i]++ }
  return shares
}

/** Share the charge across goods rates by taxable value, conserving paise.
 * Legacy callers without goods retain the configured fallback rate.
 */
export function shareSaleCharge(amount: number, goods: SaleGoods[], fallbackRate: number): Array<{ amount: number; gstRate: number }> {
  const byRate = new Map<number, number>()
  for (const g of goods) if (g.taxable > 0) byRate.set(g.gstRate, (byRate.get(g.gstRate) ?? 0) + g.taxable)
  const total = [...byRate.values()].reduce((s, v) => s + v, 0)
  if (!(total > 0)) return [{ amount, gstRate: fallbackRate }]
  const entries = [...byRate.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
  const shares = allocatePaise(toPaise(amount), entries.map(([, value]) => value))
  return entries.map(([gstRate], i) => ({ gstRate, amount: toRupees(shares[i]) })).filter(p => p.amount > 0)
}

export interface SaleChargeInput {
  amountMode?: ChargeAmountMode
  taxCategory?: ChargeTaxCategory
  /** The charge type id, or any key the caller wants back. */
  key: string
  /** The figure typed. */
  amount: number
  treatment: ChargeTaxTreatment
  /** Taxed at the goods' rate (part of their value); false: at ownRate, a supply of its own. */
  followsGoodsRate: boolean
  /** The charge's own rate: used when it does not follow the goods, or there are no goods to follow. */
  ownRate: number
}

/** One rate's share of a charge. */
export interface SaleChargePart {
  gstRate: number
  /** The share of the figure typed. */
  amount: number
  /** The share without its GST. */
  net: number
  cgst: number
  sgst: number
  igst: number
  tax: number
}

export interface PricedSaleCharge {
  key: string
  treatment: ChargeTaxTreatment
  /** The figure typed. */
  amount: number
  /** Without its GST: what the income ledger takes and, unless NON_TAXABLE, what GST is worked out on. */
  net: number
  /** One rate, or the rate its shares come to together. */
  gstRate: number
  cgst: number
  sgst: number
  igst: number
  tax: number
  /** What it adds to the bill: net + tax. Exactly the figure typed when it includes GST. */
  payable: number
  parts: SaleChargePart[]
  /** "5%", or "5% and 18%" when the goods carry two rates. */
  rateText: string
}

/**
 * GST added on top of a share: worked out on it whole and split in halves
 * within the state, as the order has always done.
 */
function addedOn(amount: number, gstRate: number, intra: boolean | undefined): SaleChargePart {
  const t = taxOn(toPaise(amount), gstRate, intra ? 'CGST_SGST' : 'IGST')
  return { gstRate, amount, net: amount, cgst: intra === undefined ? 0 : toRupees(t.cgst),
    sgst: intra === undefined ? 0 : toRupees(t.sgst), igst: intra === undefined ? 0 : toRupees(t.igst), tax: toRupees(t.tax) }
}

/**
 * The GST inside a share that includes it: amount × rate ÷ (100 + rate).
 * Within the state each half is worked out on its own, so CGST and SGST are
 * always equal; any paisa that leaves stays in the value, so the value and its
 * GST always add back to exactly the figure typed.
 */
function includedIn(amount: number, gstRate: number, intra: boolean | undefined): SaleChargePart {
  if (!(gstRate > 0)) return { gstRate, amount, net: amount, cgst: 0, sgst: 0, igst: 0, tax: 0 }
  const inside = (rate: number) => r2((amount * rate) / (100 + gstRate))
  if (intra) {
    const half = inside(gstRate / 2)
    return { gstRate, amount, net: r2(amount - 2 * half), cgst: half, sgst: half, igst: 0, tax: r2(2 * half) }
  }
  const whole = inside(gstRate)
  return { gstRate, amount, net: r2(amount - whole), cgst: 0, sgst: 0, igst: intra === false ? whole : 0, tax: whole }
}

/**
 * One charge priced. `intra`: true within the state (CGST + SGST), false
 * across states (IGST), undefined while a form has no customer yet (the tax
 * shown whole).
 */
export function priceSaleCharge(c: SaleChargeInput, goods: SaleGoods[], intra: boolean | undefined): PricedSaleCharge {
  const basis = goods.reduce((sum, g) => sum + Math.max(0, g.taxable), 0)
  const amount = r2(Math.max(0, Number(c.amount) || 0) * (c.amountMode === 'PERCENT' ? basis / 100 : 1))
  const ownRate = Number(c.ownRate) || 0
  if (c.treatment === 'NON_TAXABLE' || (c.taxCategory && !['TAXABLE', 'UNSPECIFIED'].includes(c.taxCategory)) || amount === 0) {
    return { key: c.key, treatment: c.treatment, amount, net: amount, gstRate: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, payable: amount, parts: [], rateText: '' }
  }
  const shares = c.followsGoodsRate ? shareSaleCharge(amount, goods, ownRate) : [{ amount, gstRate: ownRate }]
  const parts = shares.map((p) => (c.treatment === 'INCLUSIVE' ? includedIn(p.amount, p.gstRate, intra) : addedOn(p.amount, p.gstRate, intra)))
  const sum = (k: 'net' | 'cgst' | 'sgst' | 'igst' | 'tax') => r2(parts.reduce((s, p) => s + p[k], 0))
  const net = sum('net')
  const tax = sum('tax')
  return {
    key: c.key,
    treatment: c.treatment,
    amount,
    net,
    gstRate: parts.length === 1 ? parts[0].gstRate : net > 0 ? r2((tax / net) * 100) : 0,
    cgst: sum('cgst'),
    sgst: sum('sgst'),
    igst: sum('igst'),
    tax,
    payable: r2(net + tax),
    parts,
    rateText: parts.map((p) => `${p.gstRate}%`).join(' and '),
  }
}

/** A garment's HSN rate: one rate up to a price per piece, another above it. */
export interface SaleRateBand {
  gstRate: number
  priceLimit: number | null
  rateAbove: number | null
}

export interface SaleLineInput {
  qty: number
  price: number
  /** Percent off qty × price, 0 to 100. */
  discountPct?: number
  /** A fixed GST rate (0 for an exempt line). */
  rate?: number | null
  /**
   * Or the HSN's price band, read at the price each piece is actually sold for
   * after every discount. Neither: the rate is not known yet.
   */
  band?: SaleRateBand | null
}

export interface SaleInput {
  lines: SaleLineInput[]
  /** Rupees off the goods as a whole, after the lines' own discounts; capped at their value. */
  orderDiscount?: number
  charges?: SaleChargeInput[]
  /** The "other charges" box: added after tax, carrying no GST. */
  otherCharges?: number
  intra: boolean | undefined
  /** Brokerage %, on the goods' taxable value. */
  brokeragePct?: number
}

export interface PricedSaleLine {
  /** Null while the rate is not known. */
  gstRate: number | null
  /** qty × price. */
  gross: number
  /** After the line's own discount. */
  amount: number
  /** After the order's discount too: what GST is worked out on. */
  taxable: number
  tax: number
}

export interface SaleResult {
  lines: PricedSaleLine[]
  charges: PricedSaleCharge[]
  /** Σ qty × price. */
  gross: number
  lineDiscount: number
  /** After the lines' own discounts. */
  subtotal: number
  /** The order's discount actually taken. */
  discount: number
  /** The goods after every discount: the document's taxable amount. */
  goodsTaxable: number
  goodsTax: number
  /** The charges GST is worked out on, without their GST. */
  chargeTaxable: number
  /** The charges with no GST. */
  chargeUntaxed: number
  /** Every charge without its GST. */
  chargeNet: number
  /** Everything GST is worked out on: the goods and the taxed charges. */
  taxable: number
  /** Where the GST comes from, lowest rate first. */
  byRate: Array<{ rate: number; taxable: number; tax: number }>
  cgst: number
  sgst: number
  igst: number
  tax: number
  otherCharges: number
  beforeRound: number
  roundOff: number
  /** Rounded to the rupee. */
  total: number
  brokerage: number
}

/**
 * A quotation or an order priced: line discounts, then the order's discount
 * spread across the lines by value; each line's GST at its rate (a garment's
 * at the price per piece it is sold for); the charges, each as its treatment
 * says; the "other charges" box; rounded to the rupee.
 */
export function priceSale(input: SaleInput): SaleResult {
  const intra = input.intra
  const priced = input.lines.map((l) => {
    const qty = Number(l.qty) || 0
    const price = Number(l.price) || 0
    const disc = Math.min(100, Math.max(0, Number(l.discountPct) || 0))
    const gross = qty * price
    return { l, price, disc, gross, raw: gross * (1 - disc / 100) }
  })
  const gross = r2(priced.reduce((s, p) => s + p.gross, 0))
  const subtotal = r2(priced.reduce((s, p) => s + p.raw, 0))
  const lineDiscount = r2(gross - subtotal)
  const discount = r2(Math.min(Math.max(0, Number(input.orderDiscount) || 0), subtotal))
  const goodsTaxable = r2(subtotal - discount)
  const factor = subtotal > 0 ? goodsTaxable / subtotal : 1

  const byRate = new Map<number, { taxable: number; tax: number }>()
  const addRate = (rate: number, base: number, tax: number) => {
    const r = byRate.get(rate) ?? { taxable: 0, tax: 0 }
    r.taxable += base
    r.tax += tax
    byRate.set(rate, r)
  }

  let goodsTax = 0
  const goods: SaleGoods[] = []
  const lines = priced.map((p) => {
    let rate: number | null = null
    const band = p.l.band
    if (band) {
      const perPiece = p.price * (1 - p.disc / 100) * factor
      rate = band.priceLimit != null && band.rateAbove != null && perPiece > Number(band.priceLimit) ? Number(band.rateAbove) : Number(band.gstRate)
    } else if (p.l.rate != null) rate = Number(p.l.rate)
    const base = p.raw * factor
    const tax = base * ((rate ?? 0) / 100)
    goodsTax += tax
    if (rate != null && base > 0) addRate(rate, base, tax)
    if (rate != null) goods.push({ taxable: base, gstRate: rate })
    return { gstRate: rate, gross: r2(p.gross), amount: r2(p.raw), taxable: r2(base), tax: r2(tax) }
  })

  const charges = (input.charges ?? []).map((c) => priceSaleCharge(c, goods, intra))
  for (const c of charges) for (const part of c.parts) addRate(part.gstRate, part.net, part.tax)
  const sumOf = (xs: number[]) => xs.reduce((s, v) => s + v, 0)
  const chargeTaxable = r2(sumOf(charges.filter((c) => c.treatment !== 'NON_TAXABLE').map((c) => c.net)))
  const chargeUntaxed = r2(sumOf(charges.filter((c) => c.treatment === 'NON_TAXABLE').map((c) => c.net)))
  const chargeNet = r2(chargeTaxable + chargeUntaxed)

  const cgst = intra ? r2(goodsTax / 2 + sumOf(charges.map((c) => c.cgst))) : 0
  const sgst = intra ? r2(goodsTax / 2 + sumOf(charges.map((c) => c.sgst))) : 0
  const igst = intra === false ? r2(goodsTax + sumOf(charges.map((c) => c.igst))) : 0
  const tax = intra === undefined ? r2(goodsTax + sumOf(charges.map((c) => c.tax))) : r2(cgst + sgst + igst)
  const otherCharges = r2(Math.max(0, Number(input.otherCharges) || 0))
  const beforeRound = goodsTaxable + chargeNet + tax + otherCharges
  const total = Math.round(beforeRound)

  return {
    lines,
    charges,
    gross,
    lineDiscount,
    subtotal,
    discount,
    goodsTaxable,
    goodsTax: r2(goodsTax),
    chargeTaxable,
    chargeUntaxed,
    chargeNet,
    taxable: r2(goodsTaxable + chargeTaxable),
    byRate: [...byRate.entries()]
      .map(([rate, r]) => ({ rate, taxable: r2(r.taxable), tax: r2(r.tax) }))
      .filter((r) => r.taxable > 0)
      .sort((x, y) => x.rate - y.rate),
    cgst,
    sgst,
    igst,
    tax,
    otherCharges,
    beforeRound: r2(beforeRound),
    roundOff: r2(total - beforeRound),
    total,
    brokerage: r2((goodsTaxable * (Number(input.brokeragePct) || 0)) / 100),
  }
}

/** The existing Extra Charges master, including its existing HSN relation. */
export interface ChargeMasterConfig {
  name: string
  defaultGstRate: number | string | null
  taxTreatment?: ChargeTaxTreatment
  followsGoodsRate?: boolean
  defaultGstMode?: ChargeGstMode
  defaultHsnCodeId?: string | null
  defaultHsnCode?: { code: string; gstRate?: number | string } | null
  salesHsnCodeId?: string | null
  salesHsnCode?: { code: string; gstRate: number | string } | null
  purchaseTaxTreatment?: ChargeTaxTreatment
  salesTaxCategory?: string
  purchaseTaxCategory?: string
}
export function chargeConfigOf(t: ChargeMasterConfig, side: 'sales' | 'purchase'): ChargeTaxSnapshot {
  const sale = side === 'sales'
  const hsn = sale ? t.salesHsnCode : t.defaultHsnCode
  const followsGoodsRate = sale ? t.followsGoodsRate === true : t.defaultGstMode === 'INHERIT'
  const modeNone = !sale && t.defaultGstMode === 'NONE'
  return { version: 1, name: t.name,
    treatment: modeNone ? 'NON_TAXABLE' : (sale ? t.taxTreatment : t.purchaseTaxTreatment) ?? 'EXCLUSIVE',
    followsGoodsRate, ownRate: modeNone ? 0 : Number(hsn?.gstRate ?? t.defaultGstRate),
    hsnCodeId: followsGoodsRate || modeNone ? null : (sale ? t.salesHsnCodeId : t.defaultHsnCodeId) ?? null,
    hsnCode: followsGoodsRate || modeNone ? null : hsn?.code ?? null,
    taxCategory: ((sale ? t.salesTaxCategory : t.purchaseTaxCategory) ?? 'UNSPECIFIED') as ChargeTaxCategory,
    amountMode: 'FIXED', inputAmount: 0, basis: 'GOODS_AFTER_DISCOUNT' }
}

/** Restore legacy rows from their saved rate, never from a changed master. */
export function savedChargeConfig(c: { taxSnapshot?: unknown; amount: unknown; gstRate: unknown; taxTreatment?: ChargeTaxTreatment | null; hsnCodeId?: string | null; chargeType?: { name: string } | null }): ChargeTaxSnapshot {
  return chargeSnapshot(c.taxSnapshot) ?? { version: 1, name: c.chargeType?.name ?? 'Charge',
    treatment: c.taxTreatment ?? 'EXCLUSIVE', followsGoodsRate: false, ownRate: Number(c.gstRate),
    hsnCodeId: c.hsnCodeId ?? null, hsnCode: null, taxCategory: 'UNSPECIFIED', amountMode: 'FIXED',
    inputAmount: Number(c.amount), basis: 'GOODS_AFTER_DISCOUNT' }
}
