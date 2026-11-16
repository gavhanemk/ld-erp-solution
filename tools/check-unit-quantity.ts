// No database access. Run: pnpm --filter api exec tsx ../../tools/check-unit-quantity.ts
import assert from 'node:assert/strict'
import { fitsPlaces, packsFor, packText, placesMessage, qtyPlaces, qtyProblem, roundDownToPlaces, roundUpToPlaces, stockQtyOf } from '../packages/shared/src/quantity'

let passed = 0
const eq = (got: unknown, want: unknown, what: string) => {
  assert.deepEqual(got, want, what)
  passed++
}

const box = { uom: { decimalPlaces: 0 } }
const mtr = { uom: { decimalPlaces: 3 } }
const wholeRoll = { decimalPlaces: 0, uom: { decimalPlaces: 3 } } // an item stricter than its unit
const halfPcs = { decimalPlaces: 1, uom: { decimalPlaces: 0 } } // an item looser than its unit

// Which places apply.
eq(qtyPlaces(box), 0, 'box: whole')
eq(qtyPlaces(mtr), 3, 'metre: 3 places')
eq(qtyPlaces(wholeRoll), 0, 'item overrides its unit (stricter)')
eq(qtyPlaces(halfPcs), 1, 'item overrides its unit (looser)')
eq(qtyPlaces({ uom: null }), 3, 'no unit known: the columns\' 3')
eq(qtyPlaces(undefined), 3, 'nothing known: 3')
eq(qtyPlaces({ decimalPlaces: 9 }), 3, 'never more than 3')

// Fits.
for (const q of [0, 1, 2, 10, 100, 9999999]) eq(fitsPlaces(q, 0), true, `${q} is whole`)
for (const q of [0.5, 2.1, 2.5, 0.6, 1.001]) eq(fitsPlaces(q, 0), false, `${q} is not whole`)
eq(fitsPlaces(1.25, 2), true, '1.25 fits 2 places')
eq(fitsPlaces(1.255, 2), false, '1.255 does not fit 2 places')
eq(fitsPlaces(0.1 + 0.2, 1), true, '0.1 + 0.2 counts as 0.3 (no float noise)')
eq(fitsPlaces(2.35, 3), true, '2.35 kg')
eq(fitsPlaces(NaN, 3), false, 'NaN never fits')

// Rounding: up for what to ask or buy, down for what can be issued.
eq(roundUpToPlaces(2.1, 0), 3, '2.1 cartons to ask for becomes 3')
eq(roundUpToPlaces(3, 0), 3, 'a whole number stays')
eq(roundUpToPlaces(4.0000000001, 0), 4, 'float noise does not add a carton')
eq(roundUpToPlaces(1.2341, 3), 1.235, 'metres: up to 3 places')
eq(roundDownToPlaces(0.6, 0), 0, '0.6 of a carton gives 0 to issue')
eq(roundDownToPlaces(2.9999999999, 0), 3, 'float noise does not lose a carton')
eq(roundDownToPlaces(7.5, 0), 7, '7.5 on the shelf gives 7')

// The message beside the box.
eq(qtyProblem('2.5', box), placesMessage(0), '2.5 cartons: the spec\'s message')
eq(placesMessage(0), 'Decimal quantities are not allowed for this item. Please enter a whole number.', 'wording')
eq(qtyProblem('3', box), null, '3 cartons: fine')
eq(qtyProblem('2.5', mtr), null, '2.5 metres: fine')
eq(qtyProblem('1.2345', mtr), placesMessage(3), 'more than 3 places')
eq(qtyProblem('', box), null, 'empty is left to "required"')
eq(qtyProblem('0', box), 'Enter a quantity above zero.', 'zero refused')
eq(qtyProblem('0', box, { allowZero: true }), null, 'zero allowed where it means "none" (e.g. rejected)')
eq(qtyProblem('-1', mtr), 'A quantity cannot be below zero.', 'negative refused')
eq(qtyProblem('abc', mtr), 'Enter a number.', 'not a number')

// Packs: bought in a box of 20 pcs, stocked in pcs.
eq(stockQtyOf(2, 20), 40, '2 boxes of 20 = 40 pcs')
eq(stockQtyOf(3, null), 3, 'no pack: the quantity itself')
eq(packsFor(30, 20), 2, '30 pcs needed in boxes of 20: 2 boxes, not 1.5')
eq(packsFor(40, 20), 2, '40 pcs: exactly 2 boxes')
eq(packsFor(41, 20), 3, '41 pcs: 3 boxes')
eq(packsFor(1000, 144), 7, '1000 buttons in gross of 144: 7 gross')
eq(packsFor(30, 1, 3), 30, 'no pack, metres: as needed')
eq(packsFor(12.5, 1, 3), 12.5, 'no pack, 12.5 metres stays')
eq(packText(2, 'box', 20, 'pcs'), '2 box = 40 pcs', 'beside the box')
eq(packText(5, 'pcs', 1, 'pcs'), '5 pcs', 'no pack: just the quantity')

console.log(`PASS ${passed} unit quantity rules`)
