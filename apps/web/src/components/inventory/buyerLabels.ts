/*
 * Buyer stickers: what the setup window and the print sheet share — the
 * shapes the API hands over, and the one rule that builds a barcode from the
 * customer's pattern.
 */

export interface LabelProfile {
  brand: string
  marketedBy: string
  complaints: string
  tollFree: string
  email: string
  website: string
  barcodePattern: string
  refSource: 'PO' | 'FIXED' | 'NONE'
  refValue: string
  sizes: Record<string, { text: string; ref: string }>
}

export interface LabelLineInfo {
  article: string
  colour: string
  product: string
  mrp: number | null
  packQty: number
}

export interface LabelSize {
  sizeId: string
  code: string
  label: string
  /** Its place in the size run: the buyer's size number, 01 for the first. */
  position: number
  ordered: number
  packed: number
  text: string
  ref: string
}

export interface LabelLine {
  soLineId: string
  itemCode: string
  itemName: string
  style: string
  color: string
  sizeGroup: string | null
  info: LabelLineInfo
  sizes: LabelSize[]
}

export interface BuyerLabelData {
  mo: { id: string; moNumber: string }
  so: { id: string; soNumber: string; poRef: string | null }
  customer: { id: string; name: string }
  mfd: string
  profile: LabelProfile
  lines: LabelLine[]
}

/** The parts a pattern can use, in the words the setup window shows. */
export const PATTERN_PARTS: Array<{ token: string; means: string }> = [
  { token: '{size}', means: 'size number, 01, 02… in the size run' },
  { token: '{article}', means: 'article code' },
  { token: '{colour}', means: 'colour code' },
  { token: '{yy}', means: 'year made, 26' },
  { token: '{mm}', means: 'month made, 10' },
  { token: '{sizecode}', means: 'our size, 38 or L' },
]

/** One size's barcode: the customer's pattern with its parts filled in. */
export function buyerBarcode(pattern: string, p: { position: number; code: string; article: string; colour: string; mfd: Date }) {
  const parts: Record<string, string> = {
    size: String(p.position).padStart(2, '0'),
    sizecode: p.code,
    article: p.article,
    colour: p.colour,
    color: p.colour,
    yy: String(p.mfd.getFullYear()).slice(2),
    yyyy: String(p.mfd.getFullYear()),
    mm: String(p.mfd.getMonth() + 1).padStart(2, '0'),
  }
  return pattern.replace(/\{(\w+)\}/g, (whole, k: string) => parts[k.toLowerCase()] ?? whole)
}

/** Month and year of manufacture as the sticker prints it: 10/2026. */
export const mfdText = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`

/** Stickers wanted for a size: one per garment, or one per pack, of what is packed. */
export const defaultCount = (packed: number, packQty: number) => (packed > 0 ? Math.ceil(packed / Math.max(1, packQty)) : 0)

/** The counts in the print address: line~size~count, comma between. */
export const countsParam = (counts: Record<string, number>) =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}~${n}`)
    .join(',')

export const parseCounts = (raw: string | null): Record<string, number> =>
  Object.fromEntries(
    (raw ?? '')
      .split(',')
      .filter(Boolean)
      .map((part) => {
        const [line, size, n] = part.split('~')
        return [`${line}~${size}`, Math.max(0, Math.floor(Number(n) || 0))]
      }),
  )
