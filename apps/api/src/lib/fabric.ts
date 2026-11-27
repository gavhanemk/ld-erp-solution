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

const THREAD = /thread/i

/**
 * Whether a category (or the one above it) is a Thread category (27 Nov
 * 2026). Thread is set up one colour per item, like fabric, but has no
 * design number.
 */
export const isThreadCategory = (c: { name: string; parent?: { name: string } | null } | null | undefined) =>
  !!c && (THREAD.test(c.name) || THREAD.test(c.parent?.name ?? ''))

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

/**
 * The item fields every screen needs to tell same-name fabric and thread
 * apart (27 Nov 2026) — three "Cotton Twill" items differ only by these.
 * Spread into an item select: `{ id: true, code: true, name: true, ...ITEM_SHADE }`.
 * `styleId` is there so a finished good, whose colour is already in its name,
 * is left alone. Raw SQL selects the same:
 * `i."designNo", CASE WHEN i."styleId" IS NULL THEN i.color END AS colour`.
 */
export const ITEM_SHADE = { designNo: true, color: true, styleId: true } as const

/**
 * "Design No: 120 · Colour: Navy"; a thread "Colour: White"; '' for anything
 * else. Exactly as typed in the Items master. The same words as the web's
 * itemShade (apps/web/src/lib/items.ts), for reports, exports and trace text.
 */
export function itemShadeText(i: { designNo?: string | null; color?: string | null; styleId?: string | null } | null | undefined): string {
  if (!i || i.styleId) return ''
  return [i.designNo ? `Design No: ${i.designNo}` : null, i.color ? `Colour: ${i.color}` : null].filter(Boolean).join(' · ')
}
