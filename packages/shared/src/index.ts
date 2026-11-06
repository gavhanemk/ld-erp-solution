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

export interface PriceChargeInput {
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

  // The order-level discount is spread over the lines by value, and any paisa
  // left over by rounding goes on the biggest line, so the shares add up to
  // exactly the discount taken.
  const orderDiscount = Math.min(Math.max(0, toPaise(input.orderDiscount ?? 0)), valueTotal)
  const share = value.map((v) => (valueTotal > 0 ? Math.round((orderDiscount * v) / valueTotal) : 0))
  const shared = share.reduce((s, v) => s + v, 0)
  if (shared !== orderDiscount && value.length) {
    const biggest = value.indexOf(Math.max(...value))
    share[biggest] += orderDiscount - shared
  }

  const lineTax = value.map((v, i) => taxOn(v - share[i], Number(input.lines[i].gstRate) || 0, split))

  // ── Charges ──────────────────────────────────────────────────────────────
  const charges = (input.charges ?? []).map((c) => {
    const amount = Math.max(0, toPaise(c.amount))
    return { key: c.key, amount, ...taxOn(amount, Number(c.gstRate) || 0, split) }
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
    if (c.amount === 0) return
    const b = bucket(c.gstRate)
    b.charges += c.amount
    b.cgst += c.cgst
    b.sgst += c.sgst
    b.igst += c.igst
    b.tax += c.tax
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
