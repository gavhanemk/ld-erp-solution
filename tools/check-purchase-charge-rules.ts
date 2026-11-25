/**
 * Checks how a purchase charge's GST is described on the order and bill
 * screens, and which tax changes the "Change tax" window accepts. Pure, no
 * database.
 *
 *     npx tsx tools/check-purchase-charge-rules.ts
 */
import assert from 'node:assert/strict'
import type { ChargeTaxSnapshot } from '../packages/shared/src/index'
import {
  chargeGstLabel,
  configFromDraft,
  draftFromConfig,
  taxDraftProblem,
  type ChargeTaxDraft,
} from '../apps/web/src/components/purchase/chargeRules'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`ok  ${name}`)
}

const base: ChargeTaxSnapshot = {
  version: 1,
  name: 'Transport Charges',
  treatment: 'EXCLUSIVE',
  followsGoodsRate: false,
  ownRate: 5,
  hsnCodeId: null,
  hsnCode: null,
  taxCategory: 'TAXABLE',
  amountMode: 'FIXED',
  inputAmount: 1200,
  basis: 'GOODS_AFTER_DISCOUNT',
}
const part = (gstRate: number, tax: number) => ({ gstRate, amount: 0, net: 0, cgst: 0, sgst: 0, igst: tax, tax })
const at5 = { gstRate: 5, parts: [part(5, 60)], tax: 60 }

check('1. a manual rate from the master reads "5% · Masters → Charges"', () => {
  assert.deepEqual(chargeGstLabel(base, at5, 'IGST'), { rate: '5%', source: 'Masters → Charges', changed: false })
})

check('2. a charge that follows the goods reads "18% · follows the goods"', () => {
  const l = chargeGstLabel({ ...base, followsGoodsRate: true }, { gstRate: 18, parts: [part(18, 216)], tax: 216 }, 'IGST')
  assert.equal(l.rate, '18%')
  assert.equal(l.source, 'follows the goods')
  assert.equal(l.changed, false)
})

check('3. goods at two rates: the charge reads "5% / 18%"', () => {
  const l = chargeGstLabel({ ...base, followsGoodsRate: true }, { gstRate: 11.5, parts: [part(18, 108), part(5, 30)], tax: 138 }, 'IGST')
  assert.equal(l.rate, '5% / 18%')
})

check('4. a charge taken by its SAC names the code', () => {
  const l = chargeGstLabel({ ...base, hsnCodeId: 'h1', hsnCode: '996511', ownRate: 12 }, { gstRate: 12, parts: [part(12, 144)], tax: 144 }, 'IGST')
  assert.equal(l.rate, '12%')
  assert.equal(l.source, 'HSN / SAC 996511')
})

check('5. a charge with no GST reads "No GST", from either switch', () => {
  assert.deepEqual(chargeGstLabel({ ...base, treatment: 'NON_TAXABLE', ownRate: 0 }, { gstRate: 0, parts: [], tax: 0 }, 'IGST'), { rate: 'No GST', source: '', changed: false })
  assert.deepEqual(chargeGstLabel({ ...base, gstApplicable: false }, { gstRate: 0, parts: [], tax: 0 }, 'IGST'), { rate: 'No GST', source: '', changed: false })
})

check('6. a tax changed on the document says so, with its reason', () => {
  const l = chargeGstLabel({ ...base, overrideReason: 'GTA under RCM' }, at5, 'IGST')
  assert.deepEqual(l, { rate: '5%', source: 'Changed: GTA under RCM', changed: true })
})

check('7. an unregistered supplier: no GST on any charge, whatever the master says', () => {
  assert.deepEqual(chargeGstLabel(base, { gstRate: 0, parts: [], tax: 0 }, 'NONE'), { rate: 'No GST', source: 'No GST — supplier not registered', changed: false })
})

check('8. no supplier picked yet: the charge still shows its rate', () => {
  assert.equal(chargeGstLabel(base, at5, null).rate, '5%')
})

check('8a. nothing priced yet (no amount typed): the rate the charge will take', () => {
  assert.equal(chargeGstLabel(base, { gstRate: 0, parts: [], tax: 0 }, 'IGST').rate, '5%')
  assert.equal(chargeGstLabel(base, undefined, 'IGST').rate, '5%')
})

const good: ChargeTaxDraft = { mode: 'MANUAL', hsnCodeId: null, ownRate: 5, treatment: 'EXCLUSIVE', taxCategory: 'TAXABLE', reason: 'Supplier bills freight' }

check('9. the window refuses what the server would refuse', () => {
  assert.equal(taxDraftProblem({ ...good, reason: 'ab' }), 'Say why the tax is being changed (5 letters or more).')
  assert.equal(taxDraftProblem({ ...good, reason: '   abcd   ' }), 'Say why the tax is being changed (5 letters or more).')
  assert.equal(taxDraftProblem({ ...good, taxCategory: 'UNSPECIFIED' }), 'Choose a tax classification.')
  assert.equal(taxDraftProblem({ ...good, mode: 'NONE', taxCategory: 'TAXABLE' }), 'A charge without GST is exempt, nil-rated or non-GST — not taxable.')
  assert.equal(taxDraftProblem({ ...good, mode: 'HSN', hsnCodeId: null }), 'Pick an HSN / SAC code.')
  assert.equal(taxDraftProblem(good), null)
})

const sac = [{ id: 'h1', code: '996511', description: 'GTA', gstRate: '12' }]

check('10. a draft becomes the configuration the server builds', () => {
  const inherit = configFromDraft(base, { ...good, mode: 'INHERIT' }, sac)
  assert.equal(inherit.followsGoodsRate, true)
  assert.equal(inherit.hsnCodeId, null)
  assert.equal(inherit.overrideReason, 'Supplier bills freight')
  const hsn = configFromDraft(base, { ...good, mode: 'HSN', hsnCodeId: 'h1' }, sac)
  assert.equal(hsn.ownRate, 12)
  assert.equal(hsn.hsnCode, '996511')
  assert.equal(hsn.followsGoodsRate, false)
  const none = configFromDraft(base, { ...good, mode: 'NONE', taxCategory: 'EXEMPT' }, sac)
  assert.equal(none.treatment, 'NON_TAXABLE')
  assert.equal(none.ownRate, 0)
  assert.equal(none.gstApplicable, true)
})

check('11. a configuration reads back as the draft that would make it', () => {
  assert.equal(draftFromConfig({ ...base, followsGoodsRate: true }).mode, 'INHERIT')
  assert.equal(draftFromConfig({ ...base, hsnCodeId: 'h1' }).mode, 'HSN')
  assert.equal(draftFromConfig({ ...base, treatment: 'NON_TAXABLE' }).mode, 'NONE')
  assert.equal(draftFromConfig({ ...base, gstApplicable: false }).mode, 'NONE')
  assert.equal(draftFromConfig(base).mode, 'MANUAL')
  // A fresh reason every time the window opens: never the last one carried over.
  assert.equal(draftFromConfig({ ...base, overrideReason: 'old' }).reason, '')
})

check('12. a rate priced from what was saved does not claim the master', () => {
  // A reopened order keeps the rate it was saved at, whatever the master says now.
  assert.equal(chargeGstLabel(base, at5, 'IGST', { savedAs: 'as saved on this order' }).source, 'as saved on this order')
  // Following the goods, a code, or a change made here still say what they are.
  assert.equal(chargeGstLabel({ ...base, followsGoodsRate: true }, { gstRate: 18, parts: [part(18, 216)], tax: 216 }, 'IGST', { savedAs: 'as saved on this order' }).source, 'follows the goods')
  assert.equal(chargeGstLabel({ ...base, hsnCodeId: 'h1', hsnCode: '996511' }, at5, 'IGST', { savedAs: 'as saved on this order' }).source, 'HSN / SAC 996511')
  assert.equal(chargeGstLabel({ ...base, overrideReason: 'GTA under RCM' }, at5, 'IGST', { savedAs: 'as saved on this order' }).source, 'Changed: GTA under RCM')
})

check('13. a charge typed with its GST included says so', () => {
  assert.equal(chargeGstLabel({ ...base, treatment: 'INCLUSIVE' }, at5, 'IGST').source, 'Masters → Charges · GST included')
  assert.equal(chargeGstLabel({ ...base, treatment: 'INCLUSIVE', overrideReason: 'Bill shows GST inside' }, at5, 'IGST').source, 'Changed: Bill shows GST inside · GST included')
})

console.log(`\n${passed} passed`)
