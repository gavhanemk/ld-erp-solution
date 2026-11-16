// How finely a quantity may be counted, from its item's unit.
//
// A carton, a piece or a set only ever comes whole; metres, kilograms and rolls
// are measured out. The unit says which (UOM.decimalPlaces: 0 = whole numbers
// only, up to 3 = the stock columns' own precision), and an item may set its
// own (Item.decimalPlaces). The same rules are used on the screen, where they
// show a message beside the box, and in the API, where they refuse the save.

/** The most places after the point any quantity can hold (DECIMAL(10,3)). */
export const MAX_QTY_PLACES = 3

interface UnitLike {
  decimalPlaces?: number | null
}
export interface QtyItemLike {
  decimalPlaces?: number | null
  uom?: UnitLike | null
}

/** Places after the point this item's quantities may carry: the item's own, else its unit's, else 3. */
export function qtyPlaces(item: QtyItemLike | null | undefined): number {
  const own = item?.decimalPlaces
  const unit = item?.uom?.decimalPlaces
  const places = own ?? unit ?? MAX_QTY_PLACES
  return Math.min(MAX_QTY_PLACES, Math.max(0, Math.trunc(places)))
}

const EPS = 1e-9
const factor = (places: number) => 10 ** places

/** Whether `qty` needs no more places than allowed (2 fits 0 places; 2.5 does not). */
export function fitsPlaces(qty: number, places: number): boolean {
  if (!Number.isFinite(qty)) return false
  const scaled = qty * factor(places)
  return Math.abs(scaled - Math.round(scaled)) < EPS * Math.max(1, Math.abs(scaled))
}

/** Up to the next quantity that fits: 2.1 cartons to ask for becomes 3. */
export function roundUpToPlaces(qty: number, places: number): number {
  const f = factor(places)
  const scaled = qty * f
  const near = Math.round(scaled)
  return (Math.abs(scaled - near) < EPS * Math.max(1, Math.abs(scaled)) ? near : Math.ceil(scaled)) / f
}

/** Down to the last quantity that fits: 0.6 of a carton on the shelf gives 0 to issue. */
export function roundDownToPlaces(qty: number, places: number): number {
  const f = factor(places)
  const scaled = qty * f
  const near = Math.round(scaled)
  return (Math.abs(scaled - near) < EPS * Math.max(1, Math.abs(scaled)) ? near : Math.floor(scaled)) / f
}

/** The message beside a box whose quantity carries more places than its item allows. */
export function placesMessage(places: number): string {
  return places === 0
    ? 'Decimal quantities are not allowed for this item. Please enter a whole number.'
    : `This item takes at most ${places} ${places === 1 ? 'place' : 'places'} after the decimal point.`
}

/**
 * What is wrong with a typed quantity, or null when it is fine. Empty is left to
 * the form's own "required" rule; zero and negatives are refused unless allowed.
 */
export function qtyProblem(
  value: string | number | null | undefined,
  item: QtyItemLike | null | undefined,
  opts: { allowZero?: boolean } = {},
): string | null {
  if (value == null || String(value).trim() === '') return null
  const qty = Number(value)
  if (!Number.isFinite(qty)) return 'Enter a number.'
  if (qty < 0) return 'A quantity cannot be below zero.'
  if (qty === 0 && !opts.allowZero) return 'Enter a quantity above zero.'
  const places = qtyPlaces(item)
  return fitsPlaces(qty, places) ? null : placesMessage(places)
}

// ── Packs: an item bought in a box of 20 pcs, stocked in pcs ──

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** What a quantity in a pack comes to in the item's own unit: 2 boxes of 20 = 40 pcs. */
export function stockQtyOf(qty: number, factor: number | null | undefined): number {
  return round3(qty * (factor && factor > 0 ? factor : 1))
}

/**
 * How many packs to buy for what is needed in the item's own unit, rounded up
 * to how the pack is counted: 30 pcs in boxes of 20 is 2 boxes (40 pcs), never
 * 1.5. With no pack (factor 1) it is the quantity itself, up to its own places.
 */
export function packsFor(stockQty: number, factor: number | null | undefined, packPlaces = 0): number {
  const f = factor && factor > 0 ? factor : 1
  return roundUpToPlaces(round3(stockQty / f), packPlaces)
}

/** "2 box = 40 pcs" — a pack quantity with what it holds, for beside a box. */
export function packText(qty: number, packUnit: string, factor: number, stockUnit: string): string {
  const fmt = (n: number) => Number(n.toFixed(3)).toLocaleString('en-IN')
  return factor === 1 ? `${fmt(qty)} ${stockUnit}` : `${fmt(qty)} ${packUnit} = ${fmt(stockQtyOf(qty, factor))} ${stockUnit}`
}
