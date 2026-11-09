import type { ChargeTaxTreatment } from '@ld-erp/shared'
import { money } from './StoreSheet'

/**
 * A sales charge in a print's totals: its name with the figure agreed and how
 * GST sits on it, and beside it its value without GST — so the rows above the
 * total add up (goods + charges + CGST/SGST or IGST + other + rounding), the
 * GST inside an included charge counted once, in the GST rows.
 *
 *   Transport Charges (₹1,200.00 incl. GST 5%)    1,142.86
 *   Packing Charges (+ GST 5%)                       500.00
 *   Loading (no GST)                                 300.00
 *
 * A charge saved before charges said how GST sits on them had it added on top.
 */
export function saleChargeRow(ch: {
  amount: string | number
  netAmount?: string | number | null
  gstRate: string | number
  taxTreatment?: ChargeTaxTreatment | null
  chargeType: { name: string }
}): [string, string] {
  const name = ch.chargeType.name
  const net = ch.netAmount != null ? Number(ch.netAmount) : Number(ch.amount)
  const rate = Number(ch.gstRate)
  const treatment = ch.taxTreatment ?? 'EXCLUSIVE'
  const label =
    treatment === 'NON_TAXABLE'
      ? `${name} (no GST)`
      : treatment === 'INCLUSIVE'
        ? `${name} (₹${money(ch.amount)} incl. GST ${rate}%)`
        : `${name} (+ GST ${rate}%)`
  return [label, money(net)]
}
