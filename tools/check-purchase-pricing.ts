/**
 * Checks the one purchase pricing calculation (packages/shared priceDocument)
 * against worked examples. Pure arithmetic, no database.
 *
 *     npx tsx tools/check-purchase-pricing.ts
 */
import assert from 'node:assert/strict'
import { priceDocument } from '../packages/shared/src/index'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`ok  ${name}`)
}

const fabric = { qty: 1000, rate: 12, gstRate: 5 }

check('1. one item at 5%, no charges (the user’s ₹12,600)', () => {
  const r = priceDocument({ lines: [fabric], split: 'CGST_SGST' })
  assert.equal(r.goodsTaxable, 12000)
  assert.equal(r.cgst, 300)
  assert.equal(r.sgst, 300)
  assert.equal(r.tax, 600)
  assert.equal(r.total, 12600)
})

check('2. freight ₹1,200 as on the supplier’s bill, GST included: ₹13,800 (how orders and bills send it)', () => {
  const r = priceDocument({ lines: [fabric], charges: [{ key: 'freight', amount: 1200, gstRate: 0 }], split: 'CGST_SGST' })
  assert.equal(r.goodsTaxable, 12000)
  assert.equal(r.goodsTax, 600)
  assert.equal(r.chargeTax, 0)
  assert.equal(r.cgst, 300)
  assert.equal(r.sgst, 300)
  assert.equal(r.total, 13800)
  // Only the goods' rate carries tax; the freight sits apart at 0%.
  assert.deepEqual(r.byRate.filter((b) => b.tax > 0).map((b) => [b.gstRate, b.taxable, b.tax]), [[5, 12000, 600]])
})

check('2a. a charge saved before at the goods’ 5% still prices as it was: ₹13,860', () => {
  const r = priceDocument({ lines: [fabric], charges: [{ key: 'freight', amount: 1200, gstRate: 5 }], split: 'CGST_SGST' })
  assert.equal(r.taxable, 13200)
  assert.equal(r.chargeTax, 60)
  assert.equal(r.total, 13860)
})

check('2b. a charge saved before at 18% still prices as it was: ₹14,016', () => {
  const r = priceDocument({ lines: [fabric], charges: [{ key: 'freight', amount: 1200, gstRate: 18 }], split: 'CGST_SGST' })
  assert.equal(r.goodsTax, 600)
  assert.equal(r.chargeTax, 216)
  assert.equal(r.cgst, 408)
  assert.equal(r.total, 14016)
  assert.deepEqual(r.byRate.map((b) => [b.gstRate, b.taxable, b.tax]), [[5, 12000, 600], [18, 1200, 216]])
})

check('3. a charge at 0% adds its amount and no tax', () => {
  const r = priceDocument({ lines: [fabric], charges: [{ key: 'c', amount: 1200, gstRate: 0 }], split: 'CGST_SGST' })
  assert.equal(r.tax, 600)
  assert.equal(r.total, 13800)
})

check('4. two items at different rates keep their own rates', () => {
  const r = priceDocument({ lines: [fabric, { qty: 1000, rate: 1, gstRate: 18 }], split: 'CGST_SGST' })
  assert.equal(r.lines[0].tax, 600)
  assert.equal(r.lines[1].tax, 180)
  assert.equal(r.tax, 780)
  assert.equal(r.total, 13780)
  assert.deepEqual(r.byRate.map((b) => b.gstRate), [5, 18])
})

check('5. a line discount comes off before tax', () => {
  const r = priceDocument({ lines: [{ ...fabric, discountPct: 10 }], split: 'CGST_SGST' })
  assert.equal(r.lineDiscount, 1200)
  assert.equal(r.goodsTaxable, 10800)
  assert.equal(r.tax, 540)
  assert.equal(r.total, 11340)
})

check('6. an order discount is shared by value and adds up to the paisa', () => {
  const r = priceDocument({
    lines: [fabric, { qty: 1000, rate: 1, gstRate: 18 }],
    orderDiscount: 1000,
    split: 'CGST_SGST',
  })
  assert.equal(r.orderDiscount, 1000)
  assert.equal(Math.round((r.lines[0].orderDiscount + r.lines[1].orderDiscount) * 100), 100000)
  assert.equal(r.lines[0].orderDiscount, 923.08)
  assert.equal(r.lines[1].orderDiscount, 76.92)
  assert.equal(r.goodsTaxable, 12000)
  assert.equal(r.totalDiscount, 1000)
})

check('6b. an order discount larger than the goods is capped', () => {
  const r = priceDocument({ lines: [fabric], orderDiscount: 99999, split: 'CGST_SGST' })
  assert.equal(r.orderDiscount, 12000)
  assert.equal(r.total, 0)
})

check('7/8. intra-state splits in halves, inter-state is one IGST', () => {
  const intra = priceDocument({ lines: [fabric], split: 'CGST_SGST' })
  const inter = priceDocument({ lines: [fabric], split: 'IGST' })
  assert.deepEqual([intra.cgst, intra.sgst, intra.igst], [300, 300, 0])
  assert.deepEqual([inter.cgst, inter.sgst, inter.igst], [0, 0, 600])
  assert.equal(inter.total, intra.total)
})

check('9. an exempt item carries no tax beside a taxed one', () => {
  const r = priceDocument({ lines: [{ qty: 10, rate: 100, gstRate: 0 }, fabric], split: 'CGST_SGST' })
  assert.equal(r.lines[0].tax, 0)
  assert.equal(r.tax, 600)
  assert.deepEqual(r.byRate.map((b) => [b.gstRate, b.taxable]), [[0, 1000], [5, 12000]])
})

check('unregistered supplier: no GST anywhere, rates shown as 0', () => {
  const r = priceDocument({ lines: [fabric], charges: [{ key: 'f', amount: 1200, gstRate: 18 }], split: 'NONE' })
  assert.equal(r.tax, 0)
  assert.equal(r.lines[0].gstRate, 0)
  assert.equal(r.charges[0].gstRate, 0)
  assert.equal(r.total, 13200)
})

check('reverse charge: GST recorded, not added to the total', () => {
  const r = priceDocument({ lines: [fabric], split: 'CGST_SGST', reverseCharge: true })
  assert.equal(r.tax, 600)
  assert.equal(r.total, 12000)
})

check('odd paise: CGST and SGST equal, and add up to the tax', () => {
  const r = priceDocument({ lines: [{ qty: 1, rate: 333.33, gstRate: 5 }], split: 'CGST_SGST' })
  assert.equal(r.cgst, r.sgst)
  assert.equal(Math.round((r.cgst + r.sgst) * 100), Math.round(r.tax * 100))
  assert.equal(r.cgst, 8.33)
})

check('no floating-point noise on awkward figures', () => {
  const r = priceDocument({ lines: [{ qty: 3, rate: 0.1, gstRate: 18 }, { qty: 7, rate: 0.2, gstRate: 18 }], split: 'IGST' })
  assert.equal(r.goodsTaxable, 1.7)
  // Tax is rounded per line, as on an invoice: 5 paise + 25 paise.
  assert.equal(r.igst, 0.3)
  assert.equal(String(r.taxable), '1.7')
})

check('rounding to the rupee, with the round-off shown', () => {
  const r = priceDocument({ lines: [{ qty: 1, rate: 100.4, gstRate: 0 }], split: 'CGST_SGST' })
  assert.equal(r.total, 100)
  assert.equal(r.roundOff, -0.4)
  const up = priceDocument({ lines: [{ qty: 1, rate: 100.5, gstRate: 0 }], split: 'CGST_SGST' })
  assert.equal(up.total, 101)
  assert.equal(up.roundOff, 0.5)
})

check('an old order’s untaxed extra is added after tax', () => {
  const r = priceDocument({ lines: [fabric], untaxedExtra: 50, split: 'CGST_SGST' })
  assert.equal(r.total, 12650)
})

check('IGST supplier, freight GST included: ₹13,800 with one IGST line', () => {
  const r = priceDocument({ lines: [fabric], charges: [{ key: 'freight', amount: 1200, gstRate: 0 }], split: 'IGST' })
  assert.deepEqual([r.cgst, r.sgst, r.igst], [0, 0, 600])
  assert.equal(r.total, 13800)
})

console.log(`\n${passed} checks passed`)
