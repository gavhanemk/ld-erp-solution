import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { AuthRequest, requirePermission } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
import { assertStockUnused, recordMovement } from '../services/stock.service'
import { lockRow } from '../lib/lockRow'
import { syncMoPacked } from '../services/manufacturing.service'
import { packForReceipt, unpackForReceipt } from '../services/floor.service'
import { voidForCancelledReceipt } from '../services/garment.service'

/**
 * Finished goods in: packed garments going into the finished-goods store.
 *
 * Until this existed nothing put a finished garment into stock except an
 * opening balance, so nothing could ever be dispatched against an order. Each
 * receipt brings pieces in by style, colour and size — a size is its own
 * balance (see stock.service) because a challan sends sizes, not shirts.
 *
 * A piece goes in at the style's approved BOM cost per piece — material,
 * labour and overhead — or, with no approved costing, the item's standard
 * rate. Nothing is typed: the business chose this on 9 Oct 2026, so the
 * stock value follows the costing rather than whoever is at the store.
 *
 * A store document, so it answers to Inventory's permissions. It lives in a
 * file of its own rather than inside inventory.routes.ts.
 */

const router = Router()
const MODULE = 'inventory'

const lineSchema = z.object({
  itemId: z.string().min(1, 'Pick an item'),
  sizeId: z.string().optional().nullable(),
  qty: z.number().positive('Pieces must be more than zero'),
  /** "B" for B-grade pieces: made, but not first quality. Counted apart from good ones. */
  grade: z.enum(['A', 'B']).optional(),
})

export const createSchema = z
  .object({
    receiptDate: z.coerce.date().optional(),
    warehouseId: z.string().min(1, 'Pick the finished-goods store'),
    soId: z.string().optional().nullable(),
    /** The manufacturing order these were packed for; their pieces count as its packed. */
    moId: z.string().optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
    lines: z.array(lineSchema).min(1, 'Add at least one item'),
  })
  .superRefine((r, ctx) => {
    const seen = new Set<string>()
    r.lines.forEach((l, i) => {
      const key = `${l.itemId}|${l.sizeId ?? ''}|${l.grade ?? 'A'}`
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines', i], message: 'The same item, size and grade appear twice' })
      }
      seen.add(key)
    })
  })

const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(500) })

const round2 = (n: number) => Math.round(n * 100) / 100

type Rate = { rate: number; source: 'BOM' | 'STANDARD'; bomVersion: string | null }

/**
 * What one piece of each item goes into stock at: the approved BOM costing for
 * its style in its colour, else the style's costing for any colour, else the
 * item's standard rate. Null when there is none of the three.
 */
export async function fgRates(
  db: Prisma.TransactionClient | typeof prisma,
  items: Array<{ id: string; styleId: string | null; color: string | null; standardRate: Prisma.Decimal | null }>,
): Promise<Map<string, Rate | null>> {
  const styleIds = [...new Set(items.map((i) => i.styleId).filter((x): x is string => !!x))]
  const boms = styleIds.length
    ? await db.bOM.findMany({
        where: { styleId: { in: styleIds }, status: 'APPROVED', costPerPiece: { not: null } },
        select: { styleId: true, color: true, costPerPiece: true, version: true },
        orderBy: [{ approvedAt: 'desc' }, { createdAt: 'desc' }],
      })
    : []

  const out = new Map<string, Rate | null>()
  for (const item of items) {
    const forStyle = boms.filter((b) => b.styleId === item.styleId)
    const colour = item.color?.trim().toLowerCase()
    const bom =
      (colour && forStyle.find((b) => b.color?.trim().toLowerCase() === colour)) ||
      forStyle.find((b) => !b.color)
    if (bom?.costPerPiece != null) {
      out.set(item.id, { rate: Number(bom.costPerPiece), source: 'BOM', bomVersion: bom.version })
    } else if (item.standardRate != null && Number(item.standardRate) > 0) {
      out.set(item.id, { rate: Number(item.standardRate), source: 'STANDARD', bomVersion: null })
    } else {
      out.set(item.id, null)
    }
  }
  return out
}

const itemSelect = {
  id: true,
  code: true,
  name: true,
  type: true,
  isActive: true,
  color: true,
  styleId: true,
  standardRate: true,
  style: { select: { code: true, sizeGroupId: true } },
} satisfies Prisma.ItemSelect

/**
 * GET /api/finished-goods/rates?itemIds=a,b
 *
 * The value per piece each item would go in at, and where it comes from, for
 * the form to show before anything is saved.
 */
router.get('/rates', requirePermission(MODULE, 'view'), async (req, res) => {
  const ids = String(req.query.itemIds ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200)
  const items = ids.length ? await prisma.item.findMany({ where: { id: { in: ids } }, select: itemSelect }) : []
  const rates = await fgRates(prisma, items)
  res.json({ success: true, data: Object.fromEntries(rates) })
})

/**
 * GET /api/finished-goods/stock?itemIds=a,b&warehouseId=&ownerCustomerId=
 *
 * Finished goods on hand, by item, size, grade and store — our own stock, or
 * with ownerCustomerId the garments made from that customer's fabric on a
 * job-work order. What the dispatch screens check "packed in stock" against.
 */
router.get('/stock', requirePermission(MODULE, 'view'), async (req, res) => {
  const ids = String(req.query.itemIds ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200)
  const warehouseId = typeof req.query.warehouseId === 'string' && req.query.warehouseId ? req.query.warehouseId : null
  const ownerCustomerId = typeof req.query.ownerCustomerId === 'string' && req.query.ownerCustomerId ? req.query.ownerCustomerId : null

  const rows = await prisma.stockLedger.groupBy({
    by: ['itemId', 'sizeId', 'warehouseId', 'grade'],
    where: {
      ...(ownerCustomerId ? { ownership: 'CUSTOMER_OWNED', ownerCustomerId } : { ownership: 'OWNED' }),
      item: { type: 'FINISHED_GOOD' },
      ...(ids.length ? { itemId: { in: ids } } : {}),
      ...(warehouseId ? { warehouseId } : {}),
    },
    _sum: { inQty: true, outQty: true },
  })
  const data = rows
    .map((r) => ({
      itemId: r.itemId,
      sizeId: r.sizeId,
      warehouseId: r.warehouseId,
      grade: r.grade,
      qty: Math.round((Number(r._sum.inQty ?? 0) - Number(r._sum.outQty ?? 0)) * 1000) / 1000,
    }))
    .filter((r) => r.qty > 0)
  res.json({ success: true, data })
})

const receiptInclude = {
  warehouse: { select: { id: true, name: true } },
  so: { select: { id: true, soNumber: true, customer: { select: { name: true } } } },
  mo: { select: { id: true, moNumber: true } },
  createdBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  lines: {
    include: {
      item: { select: { id: true, code: true, name: true, color: true } },
      size: { select: { id: true, code: true, sequence: true } },
    },
  },
} satisfies Prisma.FinishedGoodsReceiptInclude

/** GET /api/finished-goods — receipts, newest first. Filters: q, from, to, warehouseId, page, limit. */
router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

  const and: Prisma.FinishedGoodsReceiptWhereInput[] = []
  const q = text(req.query.q)
  if (q) {
    and.push({
      OR: [
        { fgrNumber: { contains: q, mode: 'insensitive' } },
        { so: { soNumber: { contains: q, mode: 'insensitive' } } },
        { lines: { some: { item: { OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } } } },
      ],
    })
  }
  const warehouseId = text(req.query.warehouseId)
  if (warehouseId) and.push({ warehouseId })
  const from = text(req.query.from)
  const to = text(req.query.to)
  if (from || to) {
    const end = to ? new Date(to) : null
    if (end) end.setDate(end.getDate() + 1)
    and.push({ receiptDate: { ...(from && { gte: new Date(from) }), ...(end && { lt: end }) } })
  }
  const where: Prisma.FinishedGoodsReceiptWhereInput = and.length ? { AND: and } : {}

  const [rows, total] = await Promise.all([
    prisma.finishedGoodsReceipt.findMany({
      where,
      include: receiptInclude,
      orderBy: [{ receiptDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.finishedGoodsReceipt.count({ where }),
  ])

  const data = rows.map((r) => ({
    ...r,
    pieces: r.lines.reduce((s, l) => s + Number(l.qty), 0),
    value: round2(r.lines.reduce((s, l) => s + Number(l.qty) * Number(l.unitRate), 0)),
  }))
  res.json({ success: true, data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
})

// GET /api/finished-goods/:id
router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const receipt = await prisma.finishedGoodsReceipt.findUnique({ where: { id: req.params.id }, include: receiptInclude })
  if (!receipt) throw new AppError('Finished goods receipt not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: receipt })
})

/** The database half of the route below, so it can run inside any transaction (and a rolled-back test). */
export async function createFgReceipt(tx: Prisma.TransactionClient, data: z.infer<typeof createSchema>, userId: string) {
  const receiptDate = data.receiptDate ?? new Date()

  const warehouse = await tx.warehouse.findUnique({ where: { id: data.warehouseId }, select: { name: true, isActive: true } })
  if (!warehouse) throw new AppError('That store does not exist', 400, 'BAD_WAREHOUSE')
  if (!warehouse.isActive) throw new AppError(`${warehouse.name} is switched off`, 400, 'INACTIVE')

  const items = await tx.item.findMany({
    where: { id: { in: [...new Set(data.lines.map((l) => l.itemId))] } },
    select: itemSelect,
  })
  const itemById = new Map(items.map((i) => [i.id, i]))
  const sizeIds = [...new Set(data.lines.map((l) => l.sizeId).filter((x): x is string => !!x))]
  const sizes = sizeIds.length
    ? await tx.size.findMany({ where: { id: { in: sizeIds } }, select: { id: true, code: true, sizeGroupId: true } })
    : []
  const sizeById = new Map(sizes.map((s) => [s.id, s]))

  // Packed for a manufacturing order: it has to be released and not
  // finished, and its sales order is the one these are for.
  if (data.moId) {
    const mo = await tx.manufacturingOrder.findUnique({ where: { id: data.moId }, select: { moNumber: true, status: true, soId: true } })
    if (!mo) throw new AppError('That manufacturing order does not exist', 400, 'BAD_MO')
    if (mo.status === 'DRAFT' || mo.status === 'CLOSED') {
      throw new AppError(`${mo.moNumber} is ${mo.status === 'DRAFT' ? 'still a draft' : 'closed'}, so nothing is packed for it`, 400, 'MO_NOT_OPEN')
    }
    if (data.soId && mo.soId && data.soId !== mo.soId) {
      throw new AppError(`${mo.moNumber} is for another sales order`, 400, 'WRONG_ORDER')
    }
    data.soId = data.soId ?? mo.soId
  } else if (data.soId) {
    // An order made step by step packs only what its last step has passed, so
    // the receipt has to say which manufacturing order the pieces came off.
    const routed = await tx.manufacturingOrder.findFirst({
      where: { soId: data.soId, status: { notIn: ['DRAFT', 'CLOSED'] }, steps: { some: {} } },
      select: { moNumber: true },
    })
    if (routed) {
      throw new AppError(`${routed.moNumber} makes this order step by step: pick it as the manufacturing order these were packed for.`, 400, 'PICK_MO')
    }
  }

  // Packed for an order: it has to be one still being made, and every
  // garment on the receipt has to be on it. On a job-work order the
  // garments are made from the customer's fabric, so they are the
  // customer's stock at no value of ours — counted, tagged as theirs.
  let jobWorkFor: string | null = null
  if (data.soId) {
    const so = await tx.salesOrder.findUnique({
      where: { id: data.soId },
      select: { soNumber: true, status: true, isJobWork: true, customerId: true, lines: { select: { itemId: true } } },
    })
    if (so?.isJobWork) jobWorkFor = so.customerId
    if (!so) throw new AppError('That sales order does not exist', 400, 'BAD_ORDER')
    if (!['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'].includes(so.status)) {
      throw new AppError(`${so.soNumber} is ${so.status.toLowerCase().replace(/_/g, ' ')}, so nothing is being packed for it`, 400, 'ORDER_NOT_OPEN')
    }
    const onOrder = new Set(so.lines.map((l) => l.itemId))
    for (const l of data.lines) {
      if (!onOrder.has(l.itemId)) {
        throw new AppError(`${itemById.get(l.itemId)?.code ?? 'An item'} is not on ${so.soNumber}`, 400, 'NOT_ON_ORDER')
      }
    }
  }

  data.lines.forEach((l, i) => {
    const item = itemById.get(l.itemId)
    if (!item) throw new AppError(`Line ${i + 1}: that item does not exist`, 400, 'BAD_ITEM')
    if (!item.isActive) throw new AppError(`Line ${i + 1}: ${item.code} is switched off`, 400, 'INACTIVE')
    if (item.type !== 'FINISHED_GOOD') {
      throw new AppError(`Line ${i + 1}: ${item.code} is not a finished good`, 400, 'NOT_FINISHED_GOOD')
    }
    const run = item.style?.sizeGroupId
    if (run && !l.sizeId) {
      throw new AppError(`Line ${i + 1}: ${item.code} is cut in sizes, so say which size`, 400, 'NEEDS_SIZE')
    }
    if (l.sizeId) {
      const size = sizeById.get(l.sizeId)
      if (!size) throw new AppError(`Line ${i + 1}: that size does not exist`, 400, 'BAD_SIZE')
      if (!run) throw new AppError(`Line ${i + 1}: ${item.code} has no size run, so it takes no size`, 400, 'BAD_SIZE')
      if (size.sizeGroupId !== run) {
        throw new AppError(`Line ${i + 1}: size ${size.code} is not in ${item.code}'s size run`, 400, 'BAD_SIZE')
      }
    }
  })

  const rates = await fgRates(tx, items)
  for (const item of items) {
    if (!jobWorkFor && !rates.get(item.id)) {
      throw new AppError(
        `${item.code} has no approved BOM cost and no standard rate, so it cannot be valued. Approve its BOM costing, or set a standard rate on the item in Masters.`,
        400,
        'NO_RATE',
      )
    }
  }

  // Checked first, so a refused receipt never takes a number.
  const fgrNumber = await nextDocumentNumber(tx, 'FGR', receiptDate)
  const created = await tx.finishedGoodsReceipt.create({
    data: {
      fgrNumber,
      receiptDate,
      warehouseId: data.warehouseId,
      soId: data.soId ?? null,
      moId: data.moId ?? null,
      notes: data.notes ?? null,
      createdById: userId,
      lines: {
        create: data.lines.map((l) => {
          const rate = rates.get(l.itemId)
          return {
            itemId: l.itemId,
            sizeId: l.sizeId ?? null,
            qty: l.qty,
            grade: l.grade ?? 'A',
            unitRate: jobWorkFor ? 0 : rate!.rate,
            rateSource: jobWorkFor ? 'JOB_WORK' : rate!.source,
          }
        }),
      },
    },
    include: receiptInclude,
  })

  for (const line of created.lines) {
    await recordMovement(tx, {
      itemId: line.itemId,
      warehouseId: created.warehouseId,
      sizeId: line.sizeId,
      grade: line.grade,
      ...(jobWorkFor ? { ownership: 'CUSTOMER_OWNED' as const, ownerCustomerId: jobWorkFor } : {}),
      transactionType: 'PRODUCTION',
      direction: 'IN',
      qty: Number(line.qty),
      unitRate: Number(line.unitRate),
      referenceType: 'FG_RECEIPT',
      referenceId: created.id,
      transactionDate: receiptDate,
      notes: `Finished goods in, ${fgrNumber}`,
    })
  }
  // On an order with a route, the pieces come off its last step: first
  // quality only once that step has passed them, B-grade only from pieces set
  // aside as B-grade. Refused, with the count, if the floor is not there yet.
  if (created.moId && (await tx.mOStep.count({ where: { moId: created.moId } }))) {
    await packForReceipt(tx, {
      moId: created.moId,
      fgReceiptId: created.id,
      lines: created.lines.map((l) => ({ itemId: l.itemId, sizeId: l.sizeId, qty: Number(l.qty), grade: l.grade })),
      userId,
      date: receiptDate,
    })
  }
  if (created.moId) await syncMoPacked(tx, created.moId)
  return created
}

/**
 * POST /api/finished-goods
 *
 * Packed pieces into the store, by item and size, in one go: the receipt and
 * every stock movement are written together or not at all.
 */
router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createSchema.parse(req.body)
  const receipt = await prisma.$transaction((tx) => createFgReceipt(tx, data, req.user!.id), { timeout: 30_000 })

  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'FinishedGoodsReceipt', entityId: receipt.id, after: receipt })
  const pieces = receipt.lines.reduce((s, l) => s + Number(l.qty), 0)
  res.status(201).json({
    success: true,
    message: `${receipt.fgrNumber}: ${pieces.toLocaleString('en-IN')} pcs into ${receipt.warehouse.name}`,
    data: receipt,
  })
})

/**
 * POST /api/finished-goods/:id/cancel
 *
 * Takes the pieces back out of stock and marks the receipt cancelled. Refused
 * by the stock service, naming the size, once any of them have been sent out.
 */
router.post('/:id/cancel', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = reasonSchema.parse(req.body)

  const { before, after } = await prisma.$transaction(
    async (tx) => {
      // Two clicks at once would both find it open and take its pieces out twice.
      await lockRow(tx, 'fgReceipt', req.params.id)
      const before = await tx.finishedGoodsReceipt.findUnique({ where: { id: req.params.id }, include: receiptInclude })
      if (!before) throw new AppError('Finished goods receipt not found', 404, 'NOT_FOUND')
      if (before.cancelledAt) throw new AppError(`${before.fgrNumber} is already cancelled`, 409, 'ALREADY_CANCELLED')
      // Pieces already sent out cannot be taken back a second time.
      await assertStockUnused(tx, { referenceId: before.id, label: before.fgrNumber, suggestion: 'Bring the pieces back first, or correct the stock with a stock adjustment.' })

      // What came in is what goes out: the same owner, size and grade.
      const ins = await tx.stockLedger.findMany({ where: { referenceType: 'FG_RECEIPT', referenceId: before.id, inQty: { gt: 0 } } })
      for (const row of ins) {
        await recordMovement(tx, {
          itemId: row.itemId,
          warehouseId: row.warehouseId,
          sizeId: row.sizeId,
          grade: row.grade,
          ownership: row.ownership,
          ownerCustomerId: row.ownerCustomerId,
          transactionType: 'ADJUSTMENT',
          direction: 'OUT',
          qty: Number(row.inQty),
          referenceType: 'FG_RECEIPT_CANCEL',
          referenceId: before.id,
          notes: `Cancelled ${before.fgrNumber}: ${reason}`,
          earlierDate: 'move-up',
        })
      }
      const after = await tx.finishedGoodsReceipt.update({
        where: { id: before.id },
        data: { cancelledAt: new Date(), cancelledById: req.user!.id, cancelReason: reason },
        include: receiptInclude,
      })
      // Its pieces' garment tags go with them; refused if any are packed or sent.
      await voidForCancelledReceipt(tx, before.id, `Cancelled ${before.fgrNumber}: ${reason}`, req.user!.id)
      // On an order with a route, the pieces go back to the step they were packed from.
      await unpackForReceipt(tx, before.id, `Cancelled ${before.fgrNumber}: ${reason}`, req.user!.id)
      // Its pieces come off the manufacturing order's packed again.
      if (after.moId) await syncMoPacked(tx, after.moId)
      return { before, after }
    },
    { timeout: 30_000 },
  )

  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'FinishedGoodsReceipt', entityId: after.id, before, after })
  res.json({ success: true, message: `${after.fgrNumber} cancelled; its pieces are out of stock again`, data: after })
})

export default router
