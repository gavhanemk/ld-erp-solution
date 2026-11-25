/**
 * Checks the purchase summary's figures — what the order and bill screens show
 * under Items, Additional charges and Tax — against the user's own worked
 * example (25 Nov 2026). Pure, no database.
 *
 *     npx tsx tools/check-purchase-summary.ts
 */
import assert from 'node:assert/strict'
import { priceDocument } from '../packages/shared/src/index'
import { summaryModel } from '../apps/web/src/components/purchase/purchaseSummaryModel'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`ok  ${name}`)
}

const manual = (rate: number) => ({
  version: 1 as const, name: 'Freight Charges', treatment: 'EXCLUSIVE' as const, followsGoodsRate: false,
  ownRate: rate, hsnCodeId: null, hsnCode: null, taxCategory: 'TAXABLE' as const, amountMode: 'FIXED' as const,
  inputAmount: 1000, basis: 'GOODS_AFTER_DISCOUNT' as const,
})

const example = priceDocument({
  lines: [{ qty: 1000, rate: 12, gstRate: 12 }],
  charges: [{ key: 'freight', amount: 1000, gstRate: 18, config: manual(18) }],
  split: 'CGST_SGST',
})

check("1. the user's example: item ₹12,000 + GST ₹1,440, freight ₹1,000 + GST ₹180, total GST ₹1,620, grand total ₹14,620", () => {
  const m = summaryModel(example, 'CGST_SGST', { itemNames: ['Carton'], chargeNames: ['Freight Charges'] })
  assert.equal(m.items.value, 12000)
  assert.equal(m.items.taxable, 12000)
  assert.equal(m.items.gst, 1440)
  assert.equal(m.items.rateText, '12%')
  assert.deepEqual(m.charges.map((c) => [c.name, c.amount, c.rateText, c.gst]), [['Freight Charges', 1000, '18%', 180]])
  assert.equal(m.chargeTotal, 1000)
  assert.equal(m.chargeGst, 180)
  assert.equal(m.totalGst, 1620)
  assert.deepEqual([m.cgst, m.sgst, m.igst], [810, 810, 0])
  assert.equal(m.grandTotal, 14620)
})

check('2. a discount shows the item value, the discount and the taxable amount apart', () => {
  const r = priceDocument({ lines: [{ qty: 1000, rate: 12, gstRate: 12, discountPct: 10 }], split: 'IGST' })
  const m = summaryModel(r, 'IGST', { itemNames: ['Carton'], chargeNames: [] })
  assert.deepEqual([m.items.value, m.items.discount, m.items.taxable, m.items.gst], [12000, 1200, 10800, 1296])
  assert.deepEqual([m.cgst, m.sgst, m.igst], [0, 0, 1296])
})

check('3. items at two rates: the rate reads "5% / 12%", and each line is in the breakdown', () => {
  const r = priceDocument({ lines: [{ qty: 100, rate: 10, gstRate: 5 }, { qty: 100, rate: 20, gstRate: 12 }], split: 'IGST' })
  const m = summaryModel(r, 'IGST', { itemNames: ['Thread', 'Button'], chargeNames: [] })
  assert.equal(m.items.rateText, '5% / 12%')
  assert.equal(m.items.gst, 50 + 240)
  assert.deepEqual(m.itemRows.map((l) => [l.name, l.taxable, l.rateText, l.gst]), [['Thread', 1000, '5%', 50], ['Button', 2000, '12%', 240]])
})

check('4. a charge with no GST reads "No GST" and adds nothing to the tax', () => {
  const r = priceDocument({ lines: [{ qty: 1, rate: 1000, gstRate: 5 }], charges: [{ key: 'x', amount: 200, gstRate: 0, config: { ...manual(0), treatment: 'NON_TAXABLE' as const, taxCategory: 'EXEMPT' as const } }], split: 'IGST' })
  const m = summaryModel(r, 'IGST', { itemNames: ['Fabric'], chargeNames: ['Loading'] })
  assert.deepEqual(m.charges.map((c) => [c.name, c.amount, c.rateText, c.gst]), [['Loading', 200, 'No GST', 0]])
  assert.equal(m.totalGst, 50)
  assert.equal(m.grandTotal, 1250)
})

check('5. an unregistered supplier: no GST anywhere, grand total is items + charges', () => {
  const r = priceDocument({ lines: [{ qty: 1000, rate: 12, gstRate: 12 }], charges: [{ key: 'freight', amount: 1000, gstRate: 18, config: manual(18) }], split: 'NONE' })
  const m = summaryModel(r, 'NONE', { itemNames: ['Carton'], chargeNames: ['Freight Charges'] })
  assert.deepEqual([m.items.gst, m.chargeGst, m.totalGst, m.grandTotal], [0, 0, 0, 13000])
})

check('6. the groups add up to the grand total, rounding included', () => {
  const r = priceDocument({ lines: [{ qty: 3, rate: 33.33, gstRate: 12 }], charges: [{ key: 'f', amount: 10.5, gstRate: 18, config: manual(18) }], split: 'CGST_SGST' })
  const m = summaryModel(r, 'CGST_SGST', { itemNames: ['A'], chargeNames: ['F'] })
  const sum = Math.round((m.items.taxable + m.chargeTotal + m.totalGst + m.untaxedExtra + m.roundOff) * 100) / 100
  assert.equal(sum, m.grandTotal)
})

console.log(`\n${passed} passed`)
