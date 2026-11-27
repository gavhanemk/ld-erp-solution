import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * Which of our own brands a document is under, worked out from the brands
 * themselves — never from a brand's type, so Stich Code (or any brand added
 * later) is told apart from LD Cotton Mills exactly as VHAGAR is.
 *
 * One rule runs through it: one document, one brand. A sales order, a
 * quotation and a direct manufacturing order each carry exactly one of our
 * own brands, and none of their lines may be a style of another of ours.
 * Styles of a customer's brand, or with no brand, go under any.
 */

type Tx = Prisma.TransactionClient

interface BrandRef {
  id: string
  name: string
}

/**
 * The own brand B2B and job work are booked under, and the one a document
 * falls back to when its styles do not say: the brand marked default in
 * Masters → In House Brands (LD Cotton Mills). Failing that, the oldest
 * active own brand.
 */
export async function defaultBrand(tx: Tx): Promise<BrandRef> {
  const marked = await tx.brand.findFirst({
    where: { isDefault: true, isActive: true, type: { not: 'CUSTOM' } },
    select: { id: true, name: true },
  })
  if (marked) return marked
  const oldest = await tx.brand.findFirst({
    where: { isActive: true, type: { not: 'CUSTOM' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  })
  if (!oldest) throw new AppError('No brand of your own is set up. Add one in Masters → In House Brands.', 400, 'NO_BRAND')
  return oldest
}

/** Which of our own brands each style belongs to. Styles of a customer's brand, or with none, are left out. */
export async function ownBrandOfStyles(
  tx: Tx,
  styleIds: Array<string | null | undefined>,
): Promise<Map<string, { brandId: string; name: string; isActive: boolean; code: string }>> {
  const ids = [...new Set(styleIds.filter((s): s is string => Boolean(s)))]
  if (!ids.length) return new Map()
  const rows = await tx.style.findMany({
    where: { id: { in: ids }, brand: { type: { not: 'CUSTOM' } } },
    select: { id: true, code: true, brandId: true, brand: { select: { name: true, isActive: true } } },
  })
  return new Map(
    rows.flatMap((r) => (r.brandId && r.brand ? [[r.id, { brandId: r.brandId, name: r.brand.name, isActive: r.brand.isActive, code: r.code }] as const] : [])),
  )
}

/**
 * The brand a document is suggested under when its form sends none: the one
 * own brand every line's style belongs to; otherwise — a mix, a customer's
 * label, a garment with no style, job work — the default brand.
 */
export async function suggestedBrandId(tx: Tx, styleIds: Array<string | null | undefined>, isJobWork: boolean): Promise<string> {
  const fallback = await defaultBrand(tx)
  if (isJobWork || !styleIds.length) return fallback.id
  const owners = await ownBrandOfStyles(tx, styleIds)
  const brands = styleIds.map((s) => (s ? owners.get(s) : undefined))
  const first = brands[0]
  if (first?.isActive && brands.every((b) => b?.brandId === first.brandId)) return first.brandId
  return fallback.id
}

/**
 * One brand per document: refuses a line whose style belongs to another of
 * our own brands than the document's.
 */
export async function assertOneBrand(
  tx: Tx,
  brand: BrandRef,
  lines: Array<{ styleId: string | null | undefined; label: string }>,
  what: string,
): Promise<void> {
  const owners = await ownBrandOfStyles(
    tx,
    lines.map((l) => l.styleId),
  )
  for (const l of lines) {
    const owner = l.styleId ? owners.get(l.styleId) : undefined
    if (owner && owner.brandId !== brand.id) {
      throw new AppError(
        `${l.label} (${owner.code}) is a ${owner.name} style, and this ${what} is for ${brand.name}. One ${what} carries one brand: put ${owner.name}'s styles on a ${what} of their own.`,
        400,
        'BRAND_MIX',
      )
    }
  }
}

/** Job work is booked under the default brand: LD Cotton Mills does it for the customer. */
export async function assertJobWorkBrand(tx: Tx, brand: BrandRef, isJobWork: boolean | null | undefined, what: string): Promise<void> {
  if (!isJobWork) return
  const fallback = await defaultBrand(tx)
  if (fallback.id !== brand.id) {
    throw new AppError(`Job work is booked under ${fallback.name}, not ${brand.name}. Pick ${fallback.name} for this ${what}.`, 400, 'JOB_WORK_BRAND')
  }
}
