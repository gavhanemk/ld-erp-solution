import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { barcodesFor, isEan13, skuKey } from '../services/barcode.service'

/*
 * A style's retail barcodes: every colour and size of it, its EAN-13 and the
 * MRP a size carries when it differs from the style's.
 */

const router = Router()
const MODULE = 'masters'

/** Every colour (finished item) and size of the style, as rows. */
async function skusOf(styleId: string) {
  const style = await prisma.style.findUnique({
    where: { id: styleId },
    select: {
      id: true,
      code: true,
      name: true,
      mrp: true,
      sizeGroup: { select: { sizes: { select: { id: true, code: true, sequence: true }, orderBy: { sequence: 'asc' } } } },
    },
  })
  if (!style) throw new AppError('That style does not exist', 404, 'NOT_FOUND')
  const items = await prisma.item.findMany({
    where: { styleId, type: 'FINISHED_GOOD', isActive: true },
    select: { id: true, code: true, color: true },
    orderBy: [{ color: 'asc' }, { code: 'asc' }],
  })
  const sizes = style.sizeGroup?.sizes.length ? style.sizeGroup.sizes : [{ id: null as string | null, code: '', sequence: 0 }]
  const skus = items.flatMap((i) => sizes.map((s) => ({ itemId: i.id, itemCode: i.code, color: i.color ?? '', sizeId: s.id, size: s.code })))
  return { style, skus }
}

router.get('/styles/:styleId/barcodes', requirePermission(MODULE, 'view'), async (req, res) => {
  const { style, skus } = await skusOf(req.params.styleId)
  const company = await prisma.company.findFirst({ select: { gs1Prefix: true } })
  const have = await prisma.retailBarcode.findMany({
    where: { itemId: { in: [...new Set(skus.map((s) => s.itemId))] } },
    select: { id: true, itemId: true, sizeId: true, ean: true, mrp: true },
  })
  const byKey = new Map(have.map((b) => [skuKey(b.itemId, b.sizeId), b]))
  res.json({
    success: true,
    data: {
      style: { code: style.code, name: style.name, mrp: style.mrp == null ? null : Number(style.mrp) },
      prefix: company?.gs1Prefix ?? null,
      rows: skus.map((s) => {
        const b = byKey.get(skuKey(s.itemId, s.sizeId))
        return { ...s, ean: b?.ean ?? null, mrp: b?.mrp == null ? null : Number(b.mrp) }
      }),
    },
  })
})

/** Barcodes for every colour and size of the style that has none yet. */
router.post('/styles/:styleId/barcodes/assign', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { style, skus } = await skusOf(req.params.styleId)
  const company = await prisma.company.findFirst({ select: { gs1Prefix: true } })
  if (!company?.gs1Prefix) throw new AppError('Enter the GS1 company prefix in Settings → Company first.', 400, 'NO_GS1_PREFIX')
  const before = await prisma.retailBarcode.count({ where: { itemId: { in: skus.map((s) => s.itemId) } } })
  await prisma.$transaction((tx) => barcodesFor(tx, skus, req.user?.id ?? null), { timeout: 60_000 })
  const after = await prisma.retailBarcode.count({ where: { itemId: { in: skus.map((s) => s.itemId) } } })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'RetailBarcode', entityId: style.id, after: { style: style.code, given: after - before } })
  res.json({ success: true, message: after > before ? `${after - before} barcodes given to ${style.code}.` : `Every size of ${style.code} already has a barcode.` })
})

const editSchema = z.object({
  itemId: z.string().min(1),
  sizeId: z.string().min(1).nullable(),
  // A number from the GS1 portal, typed in by hand.
  ean: z
    .string()
    .trim()
    .refine((v) => v === '' || isEan13(v), 'That is not a valid EAN-13: 13 digits, the last a check digit')
    .optional()
    .nullable(),
  mrp: z.number().min(0).max(9_999_999).nullable().optional(),
})

/** A size's own MRP, or a barcode typed in from the GS1 portal. */
router.patch('/barcodes', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = editSchema.parse(req.body)
  const row = await prisma.$transaction(async (tx) => {
    const had = await tx.retailBarcode.findFirst({ where: { itemId: data.itemId, sizeId: data.sizeId } })
    if (data.ean) {
      const taken = await tx.retailBarcode.findUnique({ where: { ean: data.ean }, select: { id: true } })
      if (taken && taken.id !== had?.id) throw new AppError(`${data.ean} is already another size's barcode.`, 400, 'EAN_TAKEN')
    }
    if (had) {
      return tx.retailBarcode.update({
        where: { id: had.id },
        data: { ...(data.ean ? { ean: data.ean } : {}), ...(data.mrp !== undefined ? { mrp: data.mrp } : {}) },
      })
    }
    if (!data.ean) {
      // No number typed: give the next one, then set the MRP on it.
      const got = await barcodesFor(tx, [{ itemId: data.itemId, sizeId: data.sizeId }], req.user?.id ?? null)
      const b = got.get(skuKey(data.itemId, data.sizeId))
      if (!b) throw new AppError('Enter the GS1 company prefix in Settings → Company first, or type the barcode in.', 400, 'NO_GS1_PREFIX')
      return tx.retailBarcode.update({ where: { ean: b.ean }, data: { mrp: data.mrp ?? null } })
    }
    return tx.retailBarcode.create({ data: { itemId: data.itemId, sizeId: data.sizeId, ean: data.ean, mrp: data.mrp ?? null, createdById: req.user?.id ?? null } })
  })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'RetailBarcode', entityId: row.id, after: row })
  res.json({ success: true, data: { ean: row.ean, mrp: row.mrp == null ? null : Number(row.mrp) } })
})

export default router
