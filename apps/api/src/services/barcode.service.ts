import type { Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'

/*
 * Retail barcodes: one EAN-13 per finished item (style and colour) and size.
 *
 * Built from the company's GS1 India prefix — the prefix, then the next item
 * reference, then the check digit — so every number is valid at any retailer
 * or marketplace. A number once given is never given again, even if the size
 * or colour it was for goes away.
 *
 * Until the company has a GS1 prefix, sizes get store barcodes: 200, then the
 * next number, then the check digit. GS1 keeps numbers starting with 2 for a
 * company's own use, so they scan at its own counter and never clash with a
 * real one — but outside shops and marketplaces need GS1 numbers. Once the
 * prefix is entered, `storeToGs1` changes every store barcode to a GS1 one.
 */

/** A GS1 company prefix: 7 to 10 digits. GS1 India's start 890. */
export const GS1_PREFIX = /^\d{7,10}$/

/** Store barcodes, for use inside the company only, start with this. */
export const STORE_PREFIX = '200'

/** A store barcode rather than a GS1 one: GS1 never gives a prefix starting with 2. */
export const isStoreEan = (ean: string) => ean.startsWith('2')

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

/** The company row, held until the transaction ends, so two people never get the same number. */
async function lockCompany(tx: Prisma.TransactionClient) {
  const [company] = await tx.$queryRaw<Array<{ id: string; gs1Prefix: string | null; gs1NextRef: number }>>`
    SELECT id, "gs1Prefix", "gs1NextRef" FROM ld_erp.company ORDER BY id LIMIT 1 FOR UPDATE`
  return company
}

/** The number after the highest store barcode given so far. */
async function nextStoreRef(tx: Prisma.TransactionClient): Promise<number> {
  const [top] = await tx.$queryRaw<Array<{ ean: string | null }>>`
    SELECT max(ean) AS ean FROM ld_erp.retail_barcodes WHERE ean LIKE ${STORE_PREFIX + '%'} AND length(ean) = 13`
  return top?.ean ? Number(top.ean.slice(STORE_PREFIX.length, 12)) + 1 : 1
}

/** The next free number under this prefix from `ref` on, skipping any typed in by hand. */
async function nextFree(tx: Prisma.TransactionClient, prefix: string, ref: number): Promise<{ ean: string; ref: number }> {
  let ean = makeEan13(prefix, ref++)
  while (await tx.retailBarcode.findUnique({ where: { ean }, select: { id: true } })) ean = makeEan13(prefix, ref++)
  return { ean, ref }
}

/**
 * The barcodes of these style-colour-sizes, with new ones given to any that
 * have none — numbered on from the company's last, with the company row held
 * so two people printing at once never get the same number. Without a GS1
 * prefix in Settings → Company, they get store barcodes.
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

  const company = await lockCompany(tx)
  if (!company) return out
  const gs1 = company.gs1Prefix && GS1_PREFIX.test(company.gs1Prefix) ? company.gs1Prefix : null
  const prefix = gs1 ?? STORE_PREFIX

  let ref = gs1 ? company.gs1NextRef : await nextStoreRef(tx)
  for (const s of missing) {
    const next = await nextFree(tx, prefix, ref)
    ref = next.ref
    await tx.retailBarcode.create({ data: { itemId: s.itemId, sizeId: s.sizeId, ean: next.ean, createdById: userId } })
    out.set(skuKey(s.itemId, s.sizeId), { ean: next.ean, mrp: null })
  }
  if (gs1) await tx.company.update({ where: { id: company.id }, data: { gs1NextRef: ref } })
  return out
}

/**
 * Every store barcode changed to a GS1 one, oldest first, once the company has
 * its GS1 prefix. The MRPs stay; tags already printed carry the old number and
 * need printing again. Returns how many were changed.
 */
export async function storeToGs1(tx: Prisma.TransactionClient): Promise<number> {
  const company = await lockCompany(tx)
  if (!company?.gs1Prefix || !GS1_PREFIX.test(company.gs1Prefix)) {
    throw new AppError('Enter the GS1 company prefix in Settings → Company and save it first.', 400, 'NO_GS1_PREFIX')
  }
  const store = await tx.retailBarcode.findMany({
    where: { ean: { startsWith: '2' } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { ean: 'asc' }],
  })
  let ref = company.gs1NextRef
  for (const b of store) {
    const next = await nextFree(tx, company.gs1Prefix, ref)
    ref = next.ref
    await tx.retailBarcode.update({ where: { id: b.id }, data: { ean: next.ean } })
  }
  await tx.company.update({ where: { id: company.id }, data: { gs1NextRef: ref } })
  return store.length
}
