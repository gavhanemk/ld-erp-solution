import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * GST by HSN / SAC code — the one place a rate is looked up.
 *
 * The HSN master holds the rate each code carries. An item keeps its code as
 * plain text, so the rate is found by looking the text up here rather than
 * through a relation:
 *
 *   - the longest listed code the item's code starts with wins, the way GST
 *     headings work: an item coded 48191010 takes 4819's rate unless 48191010
 *     is listed itself;
 *   - an item whose code is not listed keeps the rate set on the item, so
 *     nothing changes for anybody until a code is added to the master.
 *
 * The CGST / SGST / IGST split is not decided here. That depends on the
 * supplier's or buyer's state, and the order, bill and note screens already
 * decide it; this only answers "what rate does this code carry".
 */

type Db = PrismaClient | Prisma.TransactionClient

export interface HsnEntry {
  id: string
  code: string
  description: string
  kind: 'GOODS' | 'SERVICES'
  gstRate: Prisma.Decimal | number | string
  priceLimit: Prisma.Decimal | number | string | null
  rateAbove: Prisma.Decimal | number | string | null
}

/** Every active code, keyed by its digits. */
export async function loadHsnIndex(db: Db): Promise<Map<string, HsnEntry>> {
  const rows = await db.hsnCode.findMany({
    where: { isActive: true },
    select: {
      id: true,
      code: true,
      description: true,
      kind: true,
      gstRate: true,
      priceLimit: true,
      rateAbove: true,
    },
  })
  return new Map(rows.map((r) => [r.code, r as HsnEntry]))
}

/** The listed code an item's code falls under: itself, else its longest listed heading. */
export function findHsn(index: Map<string, HsnEntry>, code: string | null | undefined): HsnEntry | null {
  const digits = (code ?? '').replace(/\s+/g, '')
  if (!digits) return null
  for (let len = digits.length; len >= 2; len--) {
    const hit = index.get(digits.slice(0, len))
    if (hit) return hit
  }
  return null
}

/**
 * The rate for one piece at a given price. Ready-made garments carry one rate
 * up to a price per piece and another above it; every other code has one.
 * Without a price the lower (usual) rate is given.
 */
export function gstRateFor(hsn: HsnEntry, unitPrice?: number | null): number {
  const base = Number(hsn.gstRate)
  if (hsn.priceLimit == null || hsn.rateAbove == null || unitPrice == null) return base
  return unitPrice > Number(hsn.priceLimit) ? Number(hsn.rateAbove) : base
}

/**
 * The rate split for a document: half CGST and half SGST within the state,
 * all IGST across states. The same rule the order and bill screens apply.
 */
export function splitGstRate(rate: number, isIntraState: boolean) {
  const half = Math.round((rate / 2) * 100) / 100
  return isIntraState ? { cgst: half, sgst: half, igst: 0 } : { cgst: 0, sgst: 0, igst: rate }
}

/**
 * Items as the screens receive them, with the rate their HSN code carries.
 *
 * Every form that fills GST in from an item reads `item.taxRate.rate` — the
 * order, the bill, the notes, the indent picker. So the HSN rate is sent in
 * that same field, and those screens pick it up without being changed. The
 * item's own rate is kept for codes the master does not list. `hsn` and
 * `taxRateSource` say where the figure came from, for screens that show it.
 */
export async function withHsnRates<T extends Record<string, unknown>>(
  db: Db,
  items: T[],
  index?: Map<string, HsnEntry>
): Promise<T[]> {
  if (!items.length) return items
  const hsnIndex = index ?? (await loadHsnIndex(db))
  if (!hsnIndex.size) {
    return items.map((it) => ({ ...it, hsn: null, taxRateSource: it.taxRate ? 'ITEM' : null }))
  }
  // Named the way the tax rate list in Settings names them, so a form showing
  // the rate's name reads the same whichever source it came from.
  const named = new Map(
    (await db.taxRate.findMany({ where: { isActive: true }, select: { id: true, name: true, rate: true } })).map(
      (t) => [Number(t.rate), t]
    )
  )
  return items.map((it) => {
    const hsn = findHsn(hsnIndex, it.hsnCode as string | null)
    if (!hsn) return { ...it, hsn: null, taxRateSource: it.taxRate ? 'ITEM' : null }
    const rate = gstRateFor(hsn)
    const match = named.get(rate)
    return {
      ...it,
      taxRate: {
        id: match?.id ?? `hsn:${hsn.id}`,
        name: match?.name ?? `GST ${rate}%`,
        rate: hsn.gstRate,
      },
      hsn: {
        code: hsn.code,
        description: hsn.description,
        kind: hsn.kind,
        gstRate: hsn.gstRate,
        priceLimit: hsn.priceLimit,
        rateAbove: hsn.rateAbove,
      },
      taxRateSource: 'HSN',
    }
  })
}
