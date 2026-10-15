/**
 * A sales order's figures, worked out the way the server works them out
 * (prepareOrder and the charges' pricing): the same steps in the same order,
 * rounded at the same points, so the total the form shows is the total saved.
 * Kept apart from the form so it can be checked against the server.
 *
 *   gross (pieces × rate) − line discounts = value; − the order's discount =
 *   taxable value of the goods, spread back across the lines for their GST;
 *   + charges, each taxed at its own rate; + GST; + other charges (no GST);
 *   rounded to the rupee.
 */

/** Job work is a service: SAC 9988, at 5% unless typed otherwise or set in the HSN master. */
export const JOB_WORK_SAC = '9988'
export const JOB_WORK_GST = 5

const round2 = (n: number) => Math.round(n * 100) / 100

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

export function orderTotals(a: {
  lines: TotalsLine[]
  isJobWork: boolean
  hsnIndex: Map<string, { gstRate: string | number }>
  billDiscount: number
  /** Only charges with a type and an amount are priced. */
  charges: Array<{ amount: number; gstRate: number }>
  /** Inside the state, across it, or not known yet (no customer). */
  intra: boolean | undefined
  otherCharges: number
  brokerPct: number
}) {
  const priced = a.lines.map((l) => {
    const disc = Math.min(100, Math.max(0, l.disc || 0))
    const gross = l.qty * l.rate
    const raw = gross * (1 - disc / 100)
    return { ...l, disc, gross, raw, amount: round2(raw) }
  })
  const gross = round2(priced.reduce((s, p) => s + p.gross, 0))
  const subtotal = round2(priced.reduce((s, p) => s + p.raw, 0))
  const lineDiscount = round2(gross - subtotal)
  const discount = round2(Math.min(a.billDiscount || 0, subtotal))
  const taxable = round2(subtotal - discount)
  const factor = subtotal > 0 ? taxable / subtotal : 1

  const byRate = new Map<number, { taxable: number; tax: number }>()
  const addRate = (rate: number, base: number, tax: number) => {
    const r = byRate.get(rate) ?? { taxable: 0, tax: 0 }
    r.taxable += base
    r.tax += tax
    byRate.set(rate, r)
  }

  let goodsTax = 0
  const lines = priced.map((p) => {
    // Garments carry one rate up to a price per piece and another above it.
    let gst: number | null = null
    if (p.taxExempt) gst = 0
    else if (a.isJobWork) gst = p.jobGst !== '' ? Number(p.jobGst) || 0 : sacRateIn(a.hsnIndex, p.jobHsn)
    else if (p.hsn) {
      const perPiece = p.rate * (1 - p.disc / 100) * factor
      const { gstRate, priceLimit, rateAbove } = p.hsn
      gst = priceLimit != null && rateAbove != null && perPiece > Number(priceLimit) ? Number(rateAbove) : Number(gstRate)
    } else if (p.itemRate != null) gst = p.itemRate
    const base = p.raw * factor
    const tax = base * ((gst ?? 0) / 100)
    goodsTax += tax
    if (gst != null && base > 0) addRate(gst, base, tax)
    return { gst, gross: p.gross, amount: p.amount }
  })

  // Each charge's tax split and rounded on its own, as each one is stored.
  const charges = a.charges.map((c) => {
    const amount = round2(c.amount || 0)
    const raw = (amount * c.gstRate) / 100
    const cgst = a.intra ? round2(raw / 2) : 0
    const sgst = a.intra ? round2(raw / 2) : 0
    const igst = a.intra === false ? round2(raw) : 0
    const tax = a.intra === undefined ? round2(raw) : cgst + sgst + igst
    return { amount, rate: c.gstRate, cgst, sgst, igst, tax }
  })
  const priceable = charges.filter((c) => c.amount > 0)
  const chargeTotal = round2(priceable.reduce((s, c) => s + c.amount, 0))
  for (const c of priceable) addRate(c.rate, c.amount, c.tax)

  const cgst = a.intra ? round2(goodsTax / 2 + priceable.reduce((s, c) => s + c.cgst, 0)) : 0
  const sgst = a.intra ? round2(goodsTax / 2 + priceable.reduce((s, c) => s + c.sgst, 0)) : 0
  const igst = a.intra === false ? round2(goodsTax + priceable.reduce((s, c) => s + c.igst, 0)) : 0
  const taxTotal = a.intra === undefined ? round2(goodsTax + priceable.reduce((s, c) => s + c.tax, 0)) : round2(cgst + sgst + igst)
  const other = round2(a.otherCharges || 0)
  const beforeRounding = taxable + chargeTotal + taxTotal + other
  const total = Math.round(beforeRounding)

  return {
    lines,
    charges,
    gross,
    lineDiscount,
    subtotal,
    discount,
    taxable,
    chargeTotal,
    gstByRate: [...byRate.entries()]
      .map(([rate, r]) => ({ rate, taxable: round2(r.taxable), tax: round2(r.tax) }))
      .filter((r) => r.taxable > 0)
      .sort((x, y) => x.rate - y.rate),
    cgst,
    sgst,
    igst,
    taxTotal,
    other,
    roundOff: round2(total - beforeRounding),
    total,
    brokerage: round2((taxable * (a.brokerPct || 0)) / 100),
  }
}
