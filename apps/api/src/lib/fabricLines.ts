import { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * A fabric's own stock lines (the user's decision, 27 Nov 2026).
 *
 * Fabric is bought by design number and colour, for one of the mill's own
 * brands, and has to be stocked, issued and costed that way. Rather than
 * teach every stock screen a design, a colour and a brand, each combination
 * is an item of its own under the fabric — "Cotton Twill · D.No 1164 · Navy ·
 * LD Cotton Mills" — made the first time a purchase order row names it and
 * reused after. Stock is kept per item already, so from there on the goods
 * receipt, the stores, issues, transfers, counts and every report keep it
 * apart with nothing typed again.
 *
 * Only for items filed under a Fabric category. Any other item ignores a
 * design or colour sent with it, and is never split by brand.
 */

type Tx = Prisma.TransactionClient

const FABRIC = /fabric/i

/** Whether an item is filed under a Fabric category (or a sub-category of one). */
export const isFabricCategory = (c: { name: string; parent?: { name: string } | null } | null | undefined) =>
  !!c && (FABRIC.test(c.name) || FABRIC.test(c.parent?.name ?? ''))

/** "D.NO. 1164", "DN.NO.1164", "Design No 1164" and "1164" are one design: 1164. */
export function cleanDesignNo(v: string | null | undefined): string | null {
  const t = (v ?? '')
    .trim()
    .replace(/^(design\s*no|d\.?\s*n\.?\s*o|dn\.?\s*no|d\.?\s*no|design|d)\s*[.:#\-]*\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t || null
}

export function cleanColour(v: string | null | undefined): string | null {
  const t = (v ?? '').trim().replace(/\s+/g, ' ')
  return t || null
}

/** The in-house brand a purchase is for, checked: one of the mill's own, and in use. */
export async function assertInHouseBrand(tx: Tx, brandId: string | null | undefined) {
  if (!brandId) return null
  const b = await tx.brand.findUnique({ where: { id: brandId }, select: { id: true, name: true, type: true, isActive: true } })
  if (!b) throw new AppError('That brand no longer exists.', 400, 'BAD_BRAND')
  if (b.type !== 'LD_COTTON_MILLS' && b.type !== 'VHAGAR') {
    throw new AppError(`${b.name} is a customer's brand. A purchase is tagged to one of our In House Brands.`, 400, 'NOT_IN_HOUSE_BRAND')
  }
  if (!b.isActive) throw new AppError(`${b.name} is switched off in Masters → In House Brands.`, 400, 'BRAND_INACTIVE')
  return b
}

export interface FabricLineWanted {
  itemId: string
  /** Undefined: keep what the item already says. Null or blank: none. */
  designNo?: string | null
  color?: string | null
}

/**
 * The item each line should be stocked under: the fabric's own line for its
 * design, colour and the order's brand (made if new), or the item itself.
 */
export async function fabricLineItems(tx: Tx, lines: FabricLineWanted[], brandId: string | null): Promise<string[]> {
  const ids = [...new Set(lines.map((l) => l.itemId))]
  const found = await tx.item.findMany({
    where: { id: { in: ids } },
    select: { id: true, parentItemId: true, designNo: true, color: true, category: { select: { name: true, parent: { select: { name: true } } } } },
  })
  const byId = new Map(found.map((i) => [i.id, i]))
  const brand = brandId ? await tx.brand.findUnique({ where: { id: brandId }, select: { id: true, name: true } }) : null

  const out: string[] = []
  for (const l of lines) {
    const item = byId.get(l.itemId)
    if (!item) {
      out.push(l.itemId)
      continue
    }
    const baseId = item.parentItemId ?? item.id
    if (!isFabricCategory(item.category)) {
      out.push(l.itemId)
      continue
    }
    const designNo = l.designNo === undefined ? item.designNo : cleanDesignNo(l.designNo)
    const color = l.color === undefined ? (item.parentItemId ? item.color : null) : cleanColour(l.color)
    out.push(await fabricLine(tx, baseId, { designNo, color, brand }))
  }
  return out
}

/** Finds or makes the stock line for one fabric + design + colour + brand. */
async function fabricLine(
  tx: Tx,
  baseId: string,
  { designNo, color, brand }: { designNo: string | null; color: string | null; brand: { id: string; name: string } | null },
): Promise<string> {
  // Nothing to tell it apart: the fabric itself.
  if (!designNo && !color && !brand) return baseId

  const existing = async () => {
    const rows = await tx.$queryRaw<Array<{ id: string; isActive: boolean }>>`
      SELECT id, "isActive" FROM ld_erp.items
      WHERE "parentItemId" = ${baseId}
        AND COALESCE(lower(btrim("designNo")), '') = ${(designNo ?? '').toLowerCase()}
        AND COALESCE(lower(btrim(color)), '') = ${(color ?? '').toLowerCase()}
        AND COALESCE("brandId", '') = ${brand?.id ?? ''}
      LIMIT 1`
    return rows[0] ?? null
  }
  const hit = await existing()
  if (hit) {
    if (!hit.isActive) await tx.item.update({ where: { id: hit.id }, data: { isActive: true } })
    return hit.id
  }

  const base = await tx.item.findUniqueOrThrow({ where: { id: baseId }, include: { buyUnits: true } })
  // FAB-001-01, -02 … in the order they are first bought.
  const taken = await tx.item.count({ where: { parentItemId: baseId } })
  let n = taken + 1
  let code = `${base.code}-${String(n).padStart(2, '0')}`
  while (await tx.item.findUnique({ where: { code }, select: { id: true } })) {
    n += 1
    code = `${base.code}-${String(n).padStart(2, '0')}`
  }
  const name = [base.name, designNo ? `D.No ${designNo}` : null, color, brand?.name].filter(Boolean).join(' · ')

  // A savepoint, so a clash with an order making the same line at the same
  // moment can be undone without aborting the whole order's transaction.
  await tx.$executeRawUnsafe('SAVEPOINT fabric_line')
  try {
    const made = await tx.item.create({
      data: {
        code,
        name,
        description: base.description,
        type: base.type,
        categoryId: base.categoryId,
        uomId: base.uomId,
        departmentId: base.departmentId,
        hsnCode: base.hsnCode,
        standardRate: base.standardRate,
        taxRateId: base.taxRateId,
        tdsSectionId: base.tdsSectionId,
        imageUrl: base.imageUrl,
        decimalPlaces: base.decimalPlaces,
        parentItemId: base.id,
        designNo,
        color,
        brandId: brand?.id ?? null,
        // The packs it is bought in are the fabric's.
        buyUnits: { create: base.buyUnits.map((u) => ({ uomId: u.uomId, factor: u.factor, isDefault: u.isDefault })) },
      },
      select: { id: true },
    })
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT fabric_line')
    return made.id
  } catch (e) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT fabric_line')
    // Another order made the same line a moment ago.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const again = await existing()
      if (again) return again.id
    }
    throw e
  }
}

/**
 * A manufacturing order draws only its own brand's fabric, or common fabric
 * (the user's rule, 27 Nov 2026). Another brand's is moved across by a stock
 * transfer first, so each brand's costing stays its own.
 */
export async function assertFabricForMoBrand(tx: Tx, moId: string | null | undefined, itemIds: string[]) {
  if (!moId || !itemIds.length) return
  const mo = await tx.manufacturingOrder.findUnique({ where: { id: moId }, select: { moNumber: true, brandId: true, brand: { select: { name: true } } } })
  if (!mo) return
  const wrong = await tx.item.findFirst({
    where: { id: { in: itemIds }, brandId: { not: null }, NOT: { brandId: mo.brandId } },
    select: { name: true, brand: { select: { name: true } } },
  })
  if (wrong) {
    throw new AppError(
      `${wrong.name} is ${wrong.brand?.name ?? 'another brand'}'s fabric, and ${mo.moNumber} is for ${mo.brand?.name ?? 'another brand'}. Use ${mo.brand?.name ?? 'its own brand'}'s or common fabric, or transfer this fabric to ${mo.brand?.name ?? 'that brand'} first.`,
      409,
      'OTHER_BRAND_FABRIC',
    )
  }
}
