/**
 * A purchase line as the supplier sees it. Every purchase line stores its
 * quantity in the item's own unit (40 pcs) and, when it was bought in a pack,
 * that pack and what one holds (box, 20); its rate is per the pack. These read
 * a stored line back in its pack, for prints and lists: "2 box", "= 40 pcs",
 * "₹99 / box".
 */
interface StoredLine {
  qty: string | number
  uomFactor?: string | number | null
  uom?: { symbol: string } | null
  item?: { uom?: { symbol: string } | null } | null
}

const round3 = (n: number) => Math.round(n * 1000) / 1000
const fmt = (n: number) => Number(n.toFixed(3)).toLocaleString('en-IN')

/** What one of the line's pack holds; 1 when it is in the item's own unit. */
export const packFactor = (l: Pick<StoredLine, 'uomFactor' | 'uom'>) => (l.uom ? Number(l.uomFactor ?? 1) || 1 : 1)

/** The line in the unit it was bought in: { qty: 2, unit: 'box', pieces: '40 pcs' }. */
export function inPack(l: StoredLine): { qty: number; unit: string; pieces: string | null } {
  const own = l.item?.uom?.symbol ?? ''
  const f = packFactor(l)
  if (f === 1 || !l.uom) return { qty: Number(l.qty), unit: own, pieces: null }
  return { qty: round3(Number(l.qty) / f), unit: l.uom.symbol, pieces: `${fmt(Number(l.qty))} ${own}` }
}

/** "₹99 / box" — what a line's rate is per, for a line bought in a pack; null otherwise. */
export const ratePer = (l: Pick<StoredLine, 'uomFactor' | 'uom'>) => (packFactor(l) !== 1 && l.uom ? `/ ${l.uom.symbol}` : null)

/** A stored line's value at its rate per pack: 10 pcs at ₹99 a box of 20 is ₹49.50. */
export const valueAt = (l: StoredLine, rate: string | number) => (Number(l.qty) / packFactor(l)) * Number(rate)
