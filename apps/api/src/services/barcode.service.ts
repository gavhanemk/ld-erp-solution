import type { Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'

/*
 * Retail barcodes: one EAN-13 per finished item (style and colour) and size.
 *
 * Built from the company's GS1 India prefix — the prefix, then the next item
 * reference, then the check digit — so every number is valid at any retailer
 * or marketplace. A number once given is never given again, even if the size
 * or colour it was for goes away.
 */

/** A GS1 company prefix: 7 to 10 digits. GS1 India's start 890. */
export const GS1_PREFIX = /^\d{7,10}$/

/** The EAN-13 check digit for the first twelve digits. */
export function eanCheckDigit(d12: string): number {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10
}

/** Thirteen digits whose last is the right check digit. */
export const isEan13 = (s: string) => /^\d{13}$/.test(s) && eanCheckDigit(s.slice(0, 12)) === Number(s[12])

/** The prefix, item reference `ref` and check digit, as thirteen digits. */
export function makeEan13(prefix: string, ref: number): string {
  const room = 12 - prefix.length
  const r = String(ref).padStart(room, '0')
  if (r.length > room) {
    throw new AppError(`Every item number under the GS1 prefix ${prefix} has been given out. Ask GS1 India for another prefix.`, 400, 'GS1_FULL')
  }
  return prefix + r + eanCheckDigit(prefix + r)
}

export const skuKey = (itemId: string, sizeId: string | null) => `${itemId}|${sizeId ?? ''}`

/**
 * The barcodes of these style-colour-sizes, with new ones given to any that
 * have none — numbered on from the company's last, with the company row held
 * so two people printing at once never get the same number. Without a GS1
 * prefix in Settings → Company, nothing is given and the labels print without.
 */
export async function barcodesFor(
  tx: Prisma.TransactionClient,
  skus: Array<{ itemId: string; sizeId: string | null }>,
  userId: string | null,
): Promise<Map<string, { ean: string; mrp: number | null }>> {
  const wanted = [...new Map(skus.map((s) => [skuKey(s.itemId, s.sizeId), s])).values()]
  const out = new Map<string, { ean: string; mrp: number | null }>()
  if (!wanted.length) return out
  const have = await tx.retailBarcode.findMany({
    where: { OR: wanted.map((s) => ({ itemId: s.itemId, sizeId: s.sizeId })) },
    select: { itemId: true, sizeId: true, ean: true, mrp: true },
  })
  for (const b of have) out.set(skuKey(b.itemId, b.sizeId), { ean: b.ean, mrp: b.mrp == null ? null : Number(b.mrp) })
  const missing = wanted.filter((s) => !out.has(skuKey(s.itemId, s.sizeId)))
  if (!missing.length) return out

  const [company] = await tx.$queryRaw<Array<{ id: string; gs1Prefix: string | null; gs1NextRef: number }>>`
    SELECT id, "gs1Prefix", "gs1NextRef" FROM ld_erp.company ORDER BY id LIMIT 1 FOR UPDATE`
  if (!company?.gs1Prefix || !GS1_PREFIX.test(company.gs1Prefix)) return out

  let ref = company.gs1NextRef
  for (const s of missing) {
    // Skip any number already typed in by hand from the GS1 portal.
    let ean = makeEan13(company.gs1Prefix, ref++)
    while (await tx.retailBarcode.findUnique({ where: { ean }, select: { id: true } })) ean = makeEan13(company.gs1Prefix, ref++)
    await tx.retailBarcode.create({ data: { itemId: s.itemId, sizeId: s.sizeId, ean, createdById: userId } })
    out.set(skuKey(s.itemId, s.sizeId), { ean, mrp: null })
  }
  await tx.company.update({ where: { id: company.id }, data: { gs1NextRef: ref } })
  return out
}
