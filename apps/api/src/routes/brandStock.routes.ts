import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { isAdmin, requirePermission, type AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { createOnce, requestIdOf } from '../lib/onceFor'
import { ITEM_SHADE } from '../lib/fabric'
import { approveReallocation, cancelReallocation, KIND_WORDS, raiseReallocation, rejectReallocation, reverseReallocation, shareFree } from '../services/brandStock.service'

/**
 * Inventory → Brand Stock: central stock earmarked for brands, moved between
 * them and released, as Stock Reallocations — and what each share holds.
 */
const router = Router()
const MODULE = 'inventory'

const id = (what: string) => z.string().trim().min(1, `Pick ${what}`)
const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(500) })

const raiseSchema = z.object({
  kind: z.enum(['EARMARK', 'MOVE', 'RELEASE']),
  warehouseId: id('the store'),
  fromBrandId: z.string().trim().min(1).optional().nullable(),
  toBrandId: z.string().trim().min(1).optional().nullable(),
  moId: z.string().trim().min(1).optional().nullable(),
  reason: z.string().trim().min(5, 'Say why, in a few words').max(500),
  lines: z
    .array(
      z.object({
        itemId: id('an item'),
        sizeId: z.string().trim().min(1).optional().nullable(),
        grade: z.enum(['A', 'B', 'R']).optional(),
        qty: z.number().positive('More than nothing').max(10_000_000),
        packageCodes: z.array(z.string().trim().min(1)).max(500).optional(),
        garmentCodes: z.array(z.string().trim().min(1)).max(5000).optional(),
      }),
    )
    .min(1, 'Add at least one item')
    .max(200),
})

const include = {
  warehouse: { select: { id: true, name: true } },
  fromBrand: { select: { id: true, name: true } },
  toBrand: { select: { id: true, name: true } },
  mo: { select: { id: true, moNumber: true } },
  mr: { select: { id: true, mrNumber: true } },
  dc: { select: { id: true, dcNumber: true } },
  requestedBy: { select: { id: true, name: true } },
  approvedBy: { select: { name: true } },
  rejectedBy: { select: { name: true } },
  reversedBy: { select: { name: true } },
  lines: {
    include: {
      item: { select: { id: true, code: true, name: true, ...ITEM_SHADE, uom: { select: { symbol: true } } } },
      size: { select: { code: true } },
    },
  },
} satisfies Prisma.StockReallocationInclude

type Doc = Prisma.StockReallocationGetPayload<{ include: typeof include }>
const shape = (d: Doc) => ({
  ...d,
  // An automatic one is made by an MO's issue or by a challan going out: say which.
  kindWords: d.kind === 'AUTO' && d.dc ? 'Automatic for a challan' : KIND_WORDS[d.kind],
  from: d.fromBrand?.name ?? 'Central stock',
  to: d.toBrand?.name ?? 'Central stock',
  value: Math.round(d.lines.reduce((t, l) => t + Number(l.qty) * Number(l.unitRate ?? 0), 0) * 100) / 100,
})

/**
 * GET /api/inventory/reallocations?status=&kind=&warehouseId=&brandId=&q=&page=&limit=
 *
 * status=CLOSED is refused, withdrawn or reversed; kind=MANUAL is what people
 * raised (earmarks, moves, releases), leaving out the automatic ones. q finds
 * the number, the reason, the MO, the challan or an item on it.
 */
router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))
  const q = String(req.query.q ?? '').trim()
  const status = String(req.query.status ?? '')
  const kind = String(req.query.kind ?? '')
  const where: Prisma.StockReallocationWhereInput = {
    ...(status === 'CLOSED' ? { status: { in: ['REJECTED', 'CANCELLED', 'REVERSED'] } } : status ? { status: status as never } : {}),
    ...(kind === 'MANUAL' ? { kind: { in: ['EARMARK', 'MOVE', 'RELEASE'] } } : kind ? { kind: kind as never } : {}),
    ...(req.query.warehouseId ? { warehouseId: String(req.query.warehouseId) } : {}),
    ...(req.query.brandId ? { OR: [{ fromBrandId: String(req.query.brandId) }, { toBrandId: String(req.query.brandId) }] } : {}),
    ...(q
      ? {
          AND: [
            {
              OR: [
                { number: { contains: q, mode: 'insensitive' } },
                { reason: { contains: q, mode: 'insensitive' } },
                { mo: { moNumber: { contains: q, mode: 'insensitive' } } },
                { dc: { dcNumber: { contains: q, mode: 'insensitive' } } },
                { lines: { some: { item: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] } } } },
              ],
            },
          ],
        }
      : {}),
  }
  const [rows, total, pending] = await Promise.all([
    prisma.stockReallocation.findMany({ where, include, orderBy: [{ createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
    prisma.stockReallocation.count({ where }),
    prisma.stockReallocation.count({ where: { status: 'PENDING' } }),
  ])
  res.json({ success: true, data: rows.map(shape), pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }, pending })
})

/**
 * GET /api/inventory/reallocations/shares?warehouseId=&itemId=&sizeId=&grade=
 * Each share of one balance — central stock and each brand's earmark — with
 * what is held on it and free, its value, and its stickers and tags: what the
 * form picks from.
 */
router.get('/shares', requirePermission(MODULE, 'view'), async (req, res) => {
  const warehouseId = String(req.query.warehouseId ?? '')
  const itemId = String(req.query.itemId ?? '')
  if (!warehouseId || !itemId) throw new AppError('Say which store and item', 400, 'MISSING')
  const sizeId = req.query.sizeId ? String(req.query.sizeId) : null
  const grade = req.query.grade ? String(req.query.grade) : 'A'
  const rows = await prisma.$queryRaw<Array<{ brandId: string | null; brand: string | null; qty: number; value: number }>>`
    SELECT s."brandId", b.name AS brand, SUM(s."inQty" - s."outQty")::float8 AS qty, SUM((s."inQty" - s."outQty") * COALESCE(s."unitRate", 0))::float8 AS value
    FROM ld_erp.stock_ledger s LEFT JOIN ld_erp.brands b ON b.id = s."brandId"
    WHERE s."itemId" = ${itemId} AND s."warehouseId" = ${warehouseId} AND s.ownership::text = 'OWNED'
      AND s."sizeId" IS NOT DISTINCT FROM ${sizeId}::text AND s.grade = ${grade}
    GROUP BY s."brandId", b.name`
  const shares = []
  for (const r of rows) {
    if (Math.abs(r.qty) < 0.0005) continue
    const f = await shareFree(prisma as unknown as Prisma.TransactionClient, { itemId, warehouseId, ownership: 'OWNED', sizeId, grade, brandId: r.brandId })
    const [stickers, tags] = await Promise.all([
      sizeId
        ? []
        : prisma.stockPackage.findMany({
            where: { itemId, warehouseId, ownership: 'OWNED', status: 'IN_STOCK', grade, brandId: r.brandId },
            select: { code: true, qty: true, lotNo: true, rack: true, parent: { select: { code: true } } },
            orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
          }),
      sizeId
        ? prisma.garment.findMany({ where: { itemId, sizeId, grade, warehouseId, ownership: 'OWNED', status: 'IN_STOCK', brandId: r.brandId, dcId: null }, select: { code: true }, orderBy: { code: 'asc' }, take: 2000 })
        : [],
    ])
    const onStickers = Math.round(stickers.reduce((t, p) => t + Number(p.qty), 0) * 1000) / 1000
    shares.push({
      brandId: r.brandId,
      share: r.brand ?? 'Central stock',
      qty: f.qty,
      held: f.held,
      free: f.free,
      value: Math.round(r.value * 100) / 100,
      avgRate: f.avgRate,
      loose: Math.round(Math.max(0, f.qty - onStickers) * 1000) / 1000,
      stickers: stickers.map((p) => ({ code: p.code, qty: Number(p.qty), lotNo: p.lotNo, rack: p.rack, onRoll: p.parent?.code ?? null })),
      tags: tags.map((g) => g.code),
    })
  }
  shares.sort((a, b) => (a.brandId === null ? -1 : b.brandId === null ? 1 : a.share.localeCompare(b.share)))
  res.json({ success: true, data: shares })
})

router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const doc = await prisma.stockReallocation.findUnique({ where: { id: req.params.id }, include })
  if (!doc) throw new AppError('That reallocation does not exist', 404, 'NOT_FOUND')
  // Its rows in the stock ledger: the out of one share and the in to the other, reversal included.
  const rows = await prisma.stockLedger.findMany({
    where: { referenceType: 'STOCK_REALLOCATION', referenceId: doc.id },
    select: { id: true, itemId: true, inQty: true, outQty: true, unitRate: true, transactionDate: true, notes: true, brand: { select: { name: true } } },
    orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }],
  })
  res.json({
    success: true,
    data: {
      ...shape(doc),
      rows: rows.map((r) => ({ ...r, share: r.brand?.name ?? 'Central stock', inQty: Number(r.inQty), outQty: Number(r.outQty), unitRate: Number(r.unitRate ?? 0) })),
    },
  })
})

/** POST /api/inventory/reallocations — raised, waiting for someone else to approve it. */
router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = raiseSchema.parse(req.body)
  const { doc, repeat } = await createOnce({
    requestId: requestIdOf(req.body),
    kind: 'STOCK_REALLOCATION',
    userId: req.user!.id,
    make: async (tx) => {
      const made = await raiseReallocation(tx, { ...data, fromBrandId: data.fromBrandId ?? null, toBrandId: data.toBrandId ?? null }, req.user!.id)
      return { id: made.id, number: made.number }
    },
    load: (docId) => prisma.stockReallocation.findUniqueOrThrow({ where: { id: docId }, select: { id: true, number: true } }),
    timeout: 60_000,
  })
  if (!repeat) await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'StockReallocation', entityId: doc.id, after: { number: doc.number, ...data } })
  res.status(repeat ? 200 : 201).json({ success: true, data: doc, message: `${doc.number} raised: it waits for someone else to approve it.${repeat ? ' (That was the same request again: nothing more was saved.)' : ''}`, repeat })
})

/**
 * POST /api/inventory/reallocations/:id/approve { overrideReason? }
 * Approved and posted by someone other than its maker. An Admin approving
 * their own does so only as an override, with a reason, kept in the audit.
 */
router.post('/:id/approve', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const { overrideReason } = z.object({ overrideReason: z.string().trim().max(500).optional().nullable() }).parse(req.body ?? {})
  const done = await prisma.$transaction(
    (tx) => approveReallocation(tx, req.params.id, { id: req.user!.id, admin: isAdmin(req.user) }, overrideReason),
    { timeout: 60_000, maxWait: 20_000 },
  )
  await writeAuditLog(req, {
    module: MODULE,
    action: 'APPROVE',
    entityType: 'StockReallocation',
    entityId: done.id,
    after: { number: done.number, status: 'POSTED', ...(done.selfApproved ? { override: true, overrideReason: overrideReason?.trim() } : {}) },
  })
  res.json({
    success: true,
    message: `${done.number} approved and posted${done.selfApproved ? ' (your own, as an override: the reason is on the document and in the audit trail)' : ''}.`,
  })
})

router.post('/:id/reject', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const doc = await prisma.$transaction((tx) => rejectReallocation(tx, req.params.id, req.user!.id, reason), { timeout: 30_000 })
  await writeAuditLog(req, { module: MODULE, action: 'REJECT', entityType: 'StockReallocation', entityId: doc.id, after: { number: doc.number, reason } })
  res.json({ success: true, message: `${doc.number} refused` })
})

router.post('/:id/cancel', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const doc = await prisma.$transaction((tx) => cancelReallocation(tx, req.params.id, { id: req.user!.id, admin: isAdmin(req.user) }), { timeout: 30_000 })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'StockReallocation', entityId: doc.id, after: { number: doc.number, status: 'CANCELLED' } })
  res.json({ success: true, message: `${doc.number} withdrawn` })
})

router.post('/:id/reverse', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)
  const doc = await prisma.$transaction((tx) => reverseReallocation(tx, req.params.id, req.user!.id, reason), { timeout: 60_000, maxWait: 20_000 })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'StockReallocation', entityId: doc.id, after: { number: doc.number, status: 'REVERSED', reason } })
  res.json({ success: true, message: `${doc.number} reversed: the stock is back where it was.` })
})

export default router
