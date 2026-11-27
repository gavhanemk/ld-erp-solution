import { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * Fabric by design number and colour (the user's decisions, 27 Nov 2026).
 *
 * A fabric item is set up in the Items master one design and colour each: an
 * item filed under a Fabric category is asked its Design No. and Colour there,
 * and every purchase order that picks it shows them, pre-filled. Stock, issues
 * and reports keep it apart because it is an item of its own — nothing else
 * has to ask. Two fabric items may share a name when their design or colour
 * differs ("Cotton Twill" in D.No 1164 and D.No 1165).
 *
 * The brand is not part of a fabric item. The purchase order's brand is a
 * purchase and accounting reference only; brand on stock comes later, with
 * the multi-brand allocation that earmarks stock to a brand.
 */

type Tx = Prisma.TransactionClient

const FABRIC = /fabric/i

/** Whether a category (or the one above it) is a Fabric category. */
export const isFabricCategory = (c: { name: string; parent?: { name: string } | null } | null | undefined) =>
  !!c && (FABRIC.test(c.name) || FABRIC.test(c.parent?.name ?? ''))

/** A design number exactly as typed — "120" stays "120" — with only stray spaces taken out. */
export function cleanDesignNo(v: unknown): string | null {
  const t = String(v ?? '').trim().replace(/\s+/g, ' ')
  return t || null
}

export function cleanColour(v: unknown): string | null {
  const t = String(v ?? '').trim().replace(/\s+/g, ' ')
  return t || null
}

/** The in-house brand a purchase is for, checked: one of the mill's own, and in use. A reference on the order only. */
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
