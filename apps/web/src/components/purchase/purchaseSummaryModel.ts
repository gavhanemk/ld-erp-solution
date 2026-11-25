import type { GstSplit, PriceResult } from '@ld-erp/shared'

/**
 * What the purchase summary shows, grouped the way the user asked for it on
 * 25 Nov 2026: the items and their GST, each additional charge and its GST,
 * the tax, and what the order comes to — every figure read from the one
 * calculation (priceDocument), so the groups always add up to the total.
 */
export interface SummaryModel {
  items: { value: number; discount: number; taxable: number; gst: number; rateText: string }
  charges: Array<{ name: string; amount: number; gst: number; rateText: string }>
  chargeTotal: number
  chargeGst: number
  totalGst: number
  cgst: number
  sgst: number
  igst: number
  untaxedExtra: number
  roundOff: number
  grandTotal: number
  /** Item by item, for the breakdown. */
  itemRows: Array<{ name: string; taxable: number; gst: number; rateText: string }>
}

const rates = (list: number[]) =>
  [...new Set(list.filter((r) => r > 0))].sort((a, b) => a - b).map((r) => `${r}%`).join(' / ')

export function summaryModel(
  result: PriceResult,
  split: GstSplit | null,
  names: { itemNames: string[]; chargeNames: string[] }
): SummaryModel {
  const none = split === 'NONE'
  const itemRows = result.lines.map((l, i) => ({
    name: names.itemNames[i] ?? `Line ${i + 1}`,
    taxable: l.taxable,
    gst: none ? 0 : l.tax,
    rateText: none || !(l.gstRate > 0) ? 'No GST' : `${l.gstRate}%`,
  }))
  const charges = result.charges.map((c, i) => {
    const taxed = !none && c.tax > 0
    return {
      name: names.chargeNames[i] ?? `Charge ${i + 1}`,
      amount: c.amount,
      gst: taxed ? c.tax : 0,
      rateText: taxed ? rates(c.parts.map((p) => p.gstRate)) || `${c.gstRate}%` : 'No GST',
    }
  })
  return {
    items: {
      value: result.gross,
      discount: result.totalDiscount,
      taxable: result.goodsTaxable,
      gst: none ? 0 : result.goodsTax,
      rateText: none ? 'No GST' : rates(result.lines.filter((l) => l.taxable > 0).map((l) => l.gstRate)) || 'No GST',
    },
    charges,
    chargeTotal: result.chargeTotal,
    chargeGst: none ? 0 : result.chargeTax,
    totalGst: none ? 0 : result.tax,
    cgst: result.cgst,
    sgst: result.sgst,
    igst: result.igst,
    untaxedExtra: result.untaxedExtra,
    roundOff: result.roundOff,
    grandTotal: result.total,
    itemRows,
  }
}
