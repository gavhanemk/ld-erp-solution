/**
 * Checks looksLikeSameName (apps/web/src/lib/similarName.ts) against worked
 * examples. Pure logic, no database, no server.
 *
 *     npx tsx tools/check-similar-name.ts
 */
import assert from 'node:assert/strict'
import { looksLikeSameName } from '../apps/web/src/lib/similarName'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`ok  ${name}`)
}

check('the reported case: a typo gets flagged', () => {
  assert.equal(looksLikeSameName('Lio Linene', 'lio linen'), true)
})

check('a dropped letter in the middle of a word gets flagged', () => {
  assert.equal(looksLikeSameName('Nylon Zipper 6" Grey', 'Nylon Ziper 6" Grey'), true)
})

check('a missing letter in a colour gets flagged', () => {
  assert.equal(looksLikeSameName('Polyester Button 18L — White', 'Polyester Button 18L — Wite'), true)
})

check('Gray and Grey are flagged — a common real duplicate', () => {
  assert.equal(looksLikeSameName('Cotton Twill — Gray', 'Cotton Twill — Grey'), true)
})

check('two counts of the same fabric are not flagged — chosen on purpose', () => {
  assert.equal(looksLikeSameName('Cotton Poplin 40s', 'Cotton Poplin 60s'), false)
})

check('two sleeve lengths are not flagged — a real variant, not a typo', () => {
  assert.equal(looksLikeSameName('Formal Shirt - Full Sleeve', 'Formal Shirt - Half Sleeve'), false)
})

check('two different colours of a similar length are not flagged', () => {
  assert.equal(looksLikeSameName('Formal Shirt - Sky Blue', 'Formal Shirt - Navy Blue'), false)
})

check('plainly different colours are not flagged', () => {
  assert.equal(looksLikeSameName('Cream', 'Green'), false)
})

check('close but different colours are not flagged (right at the edge)', () => {
  assert.equal(looksLikeSameName('Grey Stripe', 'Green Stripe'), false)
})

check('a different word count is not flagged — an extra word was chosen on purpose', () => {
  assert.equal(looksLikeSameName('Lio Linen', 'Lio Linen Fabric'), false)
})

check('two unrelated short words are not flagged', () => {
  assert.equal(looksLikeSameName('Thread', 'Yarn'), false)
})

check('a typo in a one-word name is flagged', () => {
  assert.equal(looksLikeSameName('Thread', 'Thred'), true)
})

check('the exact same name, case and spacing aside, is flagged', () => {
  assert.equal(looksLikeSameName('Cotton Twill  2/60s', 'cotton twill 2/60s'), true)
})

check('sizes are never flagged, however close the letters', () => {
  assert.equal(looksLikeSameName('Shirt S', 'Shirt M'), false)
})

console.log(`\n${passed} checks passed`)
