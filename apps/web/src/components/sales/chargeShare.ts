/**
 * A charge billed with the goods — transport, freight, packing — is taxed at
 * the goods' rate (CGST Act s.15(2)(c); the business's answer of 19 Oct
 * 2026), shared across the goods' rates by their taxable value, the biggest
 * share taking any rounding paisa. With no goods to follow, it falls back on
 * the rate in Masters → Charges. The server's services/salesCharges.ts does
 * the same sums, step for step, so the form shows what is saved.
 */

const round2 = (n: number) => Math.round(n * 100) / 100

export interface GoodsAtRate {
  taxable: number
  gstRate: number
}

export function shareByRate(amount: number, goods: GoodsAtRate[], fallbackRate: number) {
  const byRate = new Map<number, number>()
  for (const g of goods) if (g.taxable > 0) byRate.set(g.gstRate, (byRate.get(g.gstRate) ?? 0) + g.taxable)
  const total = [...byRate.values()].reduce((s, v) => s + v, 0)
  if (!(total > 0)) return [{ amount, gstRate: fallbackRate }]
  const parts = [...byRate.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([gstRate, taxable]) => ({ gstRate, amount: round2((amount * taxable) / total) }))
  const drift = round2(amount - parts.reduce((s, p) => s + p.amount, 0))
  if (drift !== 0) parts[0].amount = round2(parts[0].amount + drift)
  return parts.filter((p) => p.amount !== 0)
}

/**
 * One charge priced: its shares by rate, each share's tax split and rounded
 * on its own as the server stores it. `intra` undefined is a form with no
 * customer yet: the tax is shown whole.
 */
export function priceCharge(amount: number, goods: GoodsAtRate[], fallbackRate: number, intra: boolean | undefined) {
  const parts = shareByRate(round2(amount), goods, fallbackRate).map((p) => {
    const raw = (p.amount * p.gstRate) / 100
    const cgst = intra ? round2(raw / 2) : 0
    const sgst = intra ? round2(raw / 2) : 0
    const igst = intra === false ? round2(raw) : 0
    return { ...p, cgst, sgst, igst, tax: intra === undefined ? round2(raw) : cgst + sgst + igst }
  })
  const sum = (k: 'cgst' | 'sgst' | 'igst' | 'tax') => round2(parts.reduce((s, p) => s + p[k], 0))
  return {
    parts,
    cgst: sum('cgst'),
    sgst: sum('sgst'),
    igst: sum('igst'),
    tax: sum('tax'),
    /** "5%", or "5% and 18%" when the goods carry two rates. */
    rateText: parts.map((p) => `${p.gstRate}%`).join(' and '),
  }
}
