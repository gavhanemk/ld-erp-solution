/**
 * A quotation's or a sales order's figures, from the one sales engine
 * (priceSale in @ld-erp/shared) the server prices them with on save, so the
 * total the form shows is the total saved — charges included, each with its
 * GST included in the figure, added on top, or none, as its row says.
 *
 * This file only turns the form's lines into the engine's: a job charge's
 * SAC rate, a garment's HSN price band, an item's own rate.
 */
import { priceSale, type ChargeTaxTreatment, type PricedSaleCharge, type SaleLineInput } from '@ld-erp/shared'

/** Job work is a service: SAC 9988, at 5% unless typed otherwise or set in the HSN master. */
export const JOB_WORK_SAC = '9988'
export const JOB_WORK_GST = 5

/** The rate a job charge's SAC carries in the HSN master — the code, else its longest listed heading. */
export function sacRateIn(index: Map<string, { gstRate: string | number }>, code: string | null | undefined): number {
  const digits = (code?.trim() || JOB_WORK_SAC).replace(/\s+/g, '')
  for (let len = digits.length; len >= 2; len--) {
    const hit = index.get(digits.slice(0, len))
    if (hit) return Number(hit.gstRate)
  }
  return JOB_WORK_GST
}

export interface TotalsLine {
  qty: number
  rate: number
  /** Percent, 0–100. */
  disc: number
  taxExempt: boolean
  /** Job work: the rate typed on the line ('' = the SAC's), and its SAC. */
  jobGst: string
  jobHsn: string
  /** The garment's HSN code as the master lists it, with its price threshold. */
  hsn?: { gstRate: string | number; priceLimit: string | number | null; rateAbove: string | number | null } | null
  /** The item's own rate, for a code the master does not list. */
  itemRate?: number | null
}

/** A charge as the form has it: its figure, how GST sits on it, and the rate it falls back on. */
export interface TotalsCharge {
  key: string
  amount: number
  treatment: ChargeTaxTreatment
  /** Taxed at the goods' rate (the usual case); false: at ownRate, a supply of its own. */
  followsGoodsRate: boolean
  /** The charge type's own rate: used when it does not follow the goods, or there are no goods yet. */
  ownRate: number
}

export function orderTotals(a: {
  lines: TotalsLine[]
  isJobWork: boolean
  hsnIndex: Map<string, { gstRate: string | number }>
  billDiscount: number
  /** Only charges with a type and an amount are priced. */
  charges: TotalsCharge[]
  /** Inside the state, across it, or not known yet (no customer). */
  intra: boolean | undefined
  otherCharges: number
  brokerPct: number
}) {
  const rateOf = (l: TotalsLine): Pick<SaleLineInput, 'rate' | 'band'> => {
    if (l.taxExempt) return { rate: 0 }
    if (a.isJobWork) return { rate: l.jobGst !== '' ? Number(l.jobGst) || 0 : sacRateIn(a.hsnIndex, l.jobHsn) }
    if (l.hsn) {
      const num = (v: string | number | null) => (v == null || v === '' ? null : Number(v))
      return { band: { gstRate: Number(l.hsn.gstRate), priceLimit: num(l.hsn.priceLimit), rateAbove: num(l.hsn.rateAbove) } }
    }
    return { rate: l.itemRate ?? null }
  }
  const r = priceSale({
    lines: a.lines.map((l) => ({ qty: l.qty, price: l.rate, discountPct: l.disc, ...rateOf(l) })),
    orderDiscount: a.billDiscount,
    charges: a.charges,
    otherCharges: a.otherCharges,
    intra: a.intra,
    brokeragePct: a.brokerPct,
  })
  return {
    lines: r.lines.map((l) => ({ gst: l.gstRate, gross: l.gross, amount: l.amount })),
    /** Each charge priced: its GST, its value without GST, what it adds to the bill. */
    charges: r.charges,
    chargeByKey: new Map<string, PricedSaleCharge>(r.charges.map((c) => [c.key, c])),
    gross: r.gross,
    lineDiscount: r.lineDiscount,
    subtotal: r.subtotal,
    discount: r.discount,
    /** The goods after every discount. */
    taxable: r.goodsTaxable,
    /** The charges GST is worked out on, without their GST. */
    chargeTaxable: r.chargeTaxable,
    /** The charges with no GST. */
    chargeUntaxed: r.chargeUntaxed,
    gstByRate: r.byRate,
    cgst: r.cgst,
    sgst: r.sgst,
    igst: r.igst,
    taxTotal: r.tax,
    other: r.otherCharges,
    roundOff: r.roundOff,
    total: r.total,
    brokerage: r.brokerage,
  }
}
