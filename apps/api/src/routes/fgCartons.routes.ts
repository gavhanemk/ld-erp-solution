import { Router } from 'express'
import { z } from 'zod'
import { prisma, type Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import {
  addCartonToChallan,
  cartonCodeCandidates,
  cartonInclude,
  dispatchCartons,
  openCarton,
  packCarton,
  packedBySpot,
  removeCartonFromChallan,
  type CartonFull,
} from '../services/fgCarton.service'

/*
 * Inventory → Finished Goods → Cartons: garments packed in the store into
 * cartons with their own sticker, and those cartons scanned or picked onto a
 * delivery challan for their order.
 */

const router = Router()
const MODULE = 'inventory'
const OPEN = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] as const

/** A carton as the screens show it: its pieces by item and size, and in all. */
function shape(c: CartonFull) {
  const pieces = c.lines.reduce((t, l) => t + l.qty, 0)
  // Each item once, its sizes in run order: "LD-SH-2601 · SHI-007 White · 38×5 40×10".
  const items = new Map<string, { itemId: string; code: string; name: string; description: string | null; colour: string | null; style: string | null; styleName: string | null; grade: string; sizes: Array<{ sizeId: string; code: string; qty: number }>; pieces: number }>()
  for (const l of c.lines) {
    const k = `${l.itemId}|${l.grade}`
    const it = items.get(k) ?? {
      itemId: l.itemId,
      code: l.item.code,
      name: l.item.name,
      description: l.item.description,
      colour: l.item.color,
      style: l.item.style?.code ?? null,
      styleName: l.item.style?.name ?? null,
      grade: l.grade,
      sizes: [],
      pieces: 0,
    }
    it.sizes.push({ sizeId: l.sizeId, code: l.size.code, qty: l.qty })
    it.pieces += l.qty
    items.set(k, it)
  }
  return {
    id: c.id,
    code: c.code,
    status: c.status,
    store: c.warehouse,
    order: c.so ? { id: c.so.id, soNumber: c.so.soNumber, poRef: c.so.customerPORef, customer: c.so.customer?.name ?? null } : null,
    challan: c.dc,
    notes: c.notes,
    printCount: c.printCount,
    lastPrintedAt: c.lastPrintedAt,
    dispatchedAt: c.dispatchedAt,
    openedAt: c.openedAt,
    openReason: c.openReason,
    packedBy: c.createdBy?.name ?? null,
    createdAt: c.createdAt,
    pieces,
    items: [...items.values()],
  }
}

/** The cartons: in the store by default, or dispatched, opened, or all. */
router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const str = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string).trim() : '')
  const status = str('status') || 'PACKED'
  const q = str('q')
  const where: Prisma.FgCartonWhereInput = {
    ...(status !== 'ALL' ? { status: status as 'PACKED' } : {}),
    ...(str('warehouseId') ? { warehouseId: str('warehouseId') } : {}),
    ...(str('soId') ? { soId: str('soId') } : {}),
    ...(q
      ? {
          OR: [
            { code: { in: cartonCodeCandidates(q) } },
            { code: { contains: q, mode: 'insensitive' } },
            { so: { soNumber: { contains: q, mode: 'insensitive' } } },
            { lines: { some: { item: { OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }, { style: { code: { contains: q, mode: 'insensitive' } } }] } } } },
          ],
        }
      : {}),
  }
  const [rows, counts] = await Promise.all([
    prisma.fgCarton.findMany({ where, include: cartonInclude, orderBy: { createdAt: 'desc' }, take: 300 }),
    prisma.fgCarton.groupBy({ by: ['status'], _count: { _all: true } }),
  ])
  res.json({ success: true, data: rows.map(shape), counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) })
})

/**
 * A store's finished pieces, by style, item, size and grade: how many there
 * are, how many are already sealed in cartons, and how many are free to pack.
 */
router.get('/stock', requirePermission(MODULE, 'view'), async (req, res) => {
  const warehouseId = typeof req.query.warehouseId === 'string' ? req.query.warehouseId : ''
  if (!warehouseId) throw new AppError('Pick the store.', 400, 'NO_STORE')
  const rows = await prisma.$queryRaw<Array<{ itemId: string; sizeId: string; grade: string; qty: number }>>`
    SELECT l."itemId", l."sizeId", l.grade, SUM(l."inQty" - l."outQty")::float8 AS qty
    FROM ld_erp.stock_ledger l JOIN ld_erp.items i ON i.id = l."itemId"
    WHERE l."warehouseId" = ${warehouseId} AND l.ownership::text = 'OWNED' AND l."sizeId" IS NOT NULL AND i.type::text = 'FINISHED_GOOD'
    GROUP BY 1, 2, 3
    HAVING SUM(l."inQty" - l."outQty") > 0`
  const itemIds = [...new Set(rows.map((r) => r.itemId))]
  const [items, sizes, packed] = await Promise.all([
    prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, code: true, name: true, description: true, color: true, style: { select: { id: true, code: true, name: true } } },
    }),
    prisma.size.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.sizeId))] } }, select: { id: true, code: true, sequence: true } }),
    packedBySpot(prisma, itemIds),
  ])
  const sizeOf = new Map(sizes.map((z) => [z.id, z]))
  const out = items
    .map((it) => ({
      id: it.id,
      code: it.code,
      name: it.name,
      description: it.description,
      colour: it.color,
      style: it.style ? { id: it.style.id, code: it.style.code, name: it.style.name } : null,
      sizes: rows
        .filter((r) => r.itemId === it.id)
        .map((r) => {
          const inStock = Number(r.qty)
          const sealed = packed.get(`${r.itemId}|${warehouseId}|${r.sizeId}|${r.grade}`) ?? 0
          return { sizeId: r.sizeId, code: sizeOf.get(r.sizeId)?.code ?? '', sequence: sizeOf.get(r.sizeId)?.sequence ?? 0, grade: r.grade, inStock, packed: sealed, free: Math.max(0, inStock - sealed) }
        })
        .sort((a, b) => a.sequence - b.sequence || a.grade.localeCompare(b.grade)),
    }))
    .sort((a, b) => (a.style?.code ?? '').localeCompare(b.style?.code ?? '') || a.code.localeCompare(b.code))
  res.json({ success: true, data: out })
})

const packSchema = z.object({
  warehouseId: z.string().min(1, 'Pick the store'),
  soId: z.string().min(1).nullable().optional(),
  notes: z.string().trim().max(200).nullable().optional(),
  lines: z
    .array(z.object({ itemId: z.string().min(1), sizeId: z.string().min(1), grade: z.enum(['A', 'B']).optional(), qty: z.number().int().positive() }))
    .min(1, 'Put at least one piece in the carton')
    .max(500),
})
router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = packSchema.parse(req.body)
  const { carton, soNumber } = await prisma.$transaction((tx) => packCarton(tx, data, req.user?.id ?? null), { timeout: 60_000, maxWait: 20_000 })
  const out = shape(carton)
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'FgCarton', entityId: carton.id, after: { code: carton.code, store: carton.warehouse.name, order: soNumber, pieces: out.pieces } })
  res.status(201).json({ success: true, message: `${carton.code} packed: ${out.pieces} pcs${soNumber ? ` for ${soNumber}` : ''}, ready to print its sticker.`, data: out })
})

router.post('/:id/open', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Say why the carton is opened') }).parse(req.body)
  const carton = await prisma.$transaction((tx) => openCarton(tx, req.params.id, reason))
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'FgCarton', entityId: carton.id, after: { code: carton.code, opened: reason } })
  res.json({ success: true, message: `${carton.code} opened: its pieces are loose in ${carton.warehouse.name} again.`, data: shape(carton) })
})

/** A carton by its scanned or typed sticker code. */
router.get('/scan/:code', requirePermission(MODULE, 'view'), async (req, res) => {
  const raw = decodeURIComponent(req.params.code)
  const c = await prisma.fgCarton.findFirst({ where: { code: { in: cartonCodeCandidates(raw) } }, include: cartonInclude })
  if (!c) throw new AppError(`No carton with the code ${raw.trim().toUpperCase()}. Check the sticker.`, 404, 'NOT_FOUND')
  res.json({ success: true, data: shape(c) })
})

/** Carton stickers to print: the company, and each carton's buyer, order and contents. */
router.get('/labels', requirePermission(MODULE, 'view'), async (req, res) => {
  const ids = String(req.query.ids ?? '').split(',').filter(Boolean).slice(0, 300)
  if (!ids.length) throw new AppError('Choose the cartons to print', 400, 'NO_IDS')
  const [company, rows] = await Promise.all([
    prisma.company.findFirst({ select: { name: true, logoUrl: true } }),
    prisma.fgCarton.findMany({ where: { id: { in: ids }, status: 'PACKED' }, include: cartonInclude, orderBy: { code: 'asc' } }),
  ])
  res.json({ success: true, data: { company: company?.name ?? '', logo: company?.logoUrl ?? null, cartons: rows.map(shape) } })
})

router.post('/printed', requirePermission(MODULE, 'view'), async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string().min(1)).min(1).max(300) }).parse(req.body)
  await prisma.fgCarton.updateMany({ where: { id: { in: ids } }, data: { printCount: { increment: 1 }, lastPrintedAt: new Date() } })
  res.json({ success: true })
})

// ── Loading cartons onto a delivery challan ──────────────────────────────

/** Open orders to load cartons for: what is packed for each, and drafts being loaded. */
router.get('/dispatch/orders', requirePermission('sales', 'view'), async (_req, res) => {
  const [orders, packedFor, drafts] = await Promise.all([
    prisma.salesOrder.findMany({
      where: { status: { in: [...OPEN] } },
      select: { id: true, soNumber: true, customerPORef: true, customer: { select: { name: true } }, lines: { select: { itemId: true } } },
      orderBy: { soNumber: 'desc' },
      take: 500,
    }),
    prisma.fgCarton.groupBy({ by: ['soId'], where: { status: 'PACKED', dcId: null, soId: { not: null } }, _count: { _all: true } }),
    prisma.deliveryChallan.findMany({
      where: { status: 'DRAFT', fgCartons: { some: {} } },
      select: { id: true, dcNumber: true, soId: true, warehouse: { select: { name: true } }, _count: { select: { fgCartons: true } } },
    }),
  ])
  res.json({
    success: true,
    data: orders.map((o) => ({
      soId: o.id,
      soNumber: o.soNumber,
      poRef: o.customerPORef,
      customer: o.customer?.name ?? '',
      // Its items, so a carton packed for it offers only them.
      itemIds: [...new Set(o.lines.map((l) => l.itemId).filter(Boolean))],
      packed: packedFor.find((p) => p.soId === o.id)?._count._all ?? 0,
      drafts: drafts.filter((d) => d.soId === o.id).map((d) => ({ dcId: d.id, dcNumber: d.dcNumber, store: d.warehouse?.name ?? '', cartons: d._count.fgCartons })),
    })),
  })
})

/** Cartons free to load for an order: packed for it, or for no order, holding only its items. */
router.get('/dispatch/available', requirePermission('sales', 'view'), async (req, res) => {
  const soId = typeof req.query.soId === 'string' ? req.query.soId : ''
  if (!soId) throw new AppError('Pick the order.', 400, 'NO_ORDER')
  const order = await prisma.salesOrder.findUnique({ where: { id: soId }, select: { lines: { select: { itemId: true } } } })
  if (!order) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  const onOrder = new Set(order.lines.map((l) => l.itemId).filter(Boolean) as string[])
  const rows = await prisma.fgCarton.findMany({
    where: { status: 'PACKED', dcId: null, OR: [{ soId }, { soId: null }], lines: { some: { itemId: { in: [...onOrder] } } } },
    include: cartonInclude,
    orderBy: { code: 'asc' },
    take: 500,
  })
  res.json({ success: true, data: rows.filter((c) => c.lines.every((l) => onOrder.has(l.itemId))).map(shape) })
})

/** What is loaded on a challan: its cartons and pieces by size. */
async function loading(dcId: string) {
  const dc = await prisma.deliveryChallan.findUnique({
    where: { id: dcId },
    select: { id: true, dcNumber: true, status: true, soId: true, warehouse: { select: { id: true, name: true } } },
  })
  if (!dc) return null
  const cartons = await prisma.fgCarton.findMany({ where: { dcId }, include: cartonInclude, orderBy: { code: 'asc' } })
  const shaped = cartons.map(shape)
  const bySize = new Map<string, number>()
  for (const c of shaped) for (const it of c.items) for (const s of it.sizes) bySize.set(s.code, (bySize.get(s.code) ?? 0) + s.qty)
  return {
    dcId: dc.id,
    dcNumber: dc.dcNumber,
    status: dc.status,
    soId: dc.soId,
    store: dc.warehouse,
    cartons: shaped,
    pieces: shaped.reduce((t, c) => t + c.pieces, 0),
    bySize: [...bySize].map(([code, qty]) => ({ code, qty })),
  }
}

router.get('/dispatch/:dcId', requirePermission('sales', 'view'), async (req, res) => {
  const out = await loading(req.params.dcId)
  if (!out) throw new AppError('That challan does not exist.', 404, 'NOT_FOUND')
  res.json({ success: true, data: out })
})

router.post('/dispatch/scan', requirePermission('sales', 'create'), async (req: AuthRequest, res) => {
  const data = z.object({ soId: z.string().min(1, 'Pick the order'), dcId: z.string().nullable().optional(), code: z.string().trim().min(1) }).parse(req.body)
  const r = await prisma.$transaction((tx) => addCartonToChallan(tx, data, req.user!.id), { timeout: 60_000, maxWait: 20_000 })
  res.json({ success: true, message: `${r.carton.code} on the challan.`, data: await loading(r.dcId) })
})

router.delete('/dispatch/:dcId/cartons/:cartonId', requirePermission('sales', 'create'), async (req: AuthRequest, res) => {
  const r = await prisma.$transaction((tx) => removeCartonFromChallan(tx, req.params.dcId, req.params.cartonId, req.user!.id), { timeout: 60_000, maxWait: 20_000 })
  res.json({
    success: true,
    message: r.emptied ? `${r.code} taken off; ${r.dcNumber} had nothing left, so it is cancelled.` : `${r.code} taken off ${r.dcNumber}.`,
    data: r.emptied ? null : await loading(req.params.dcId),
  })
})

router.post('/dispatch/:dcId/dispatch', requirePermission('sales', 'create'), async (req: AuthRequest, res) => {
  const data = z
    .object({ vehicleNumber: z.string().trim().max(20).nullable().optional(), transporter: z.string().trim().max(100).nullable().optional(), lrNumber: z.string().trim().max(50).nullable().optional() })
    .parse(req.body ?? {})
  const r = await prisma.$transaction((tx) => dispatchCartons(tx, req.params.dcId, data, req.user!.id), { timeout: 120_000, maxWait: 20_000 })
  await writeAuditLog(req, { module: 'sales', action: 'UPDATE', entityType: 'DeliveryChallan', entityId: req.params.dcId, after: { dispatched: true, cartons: r.cartons, pieces: r.pieces } })
  res.json({ success: true, message: `${r.dcNumber} dispatched: ${r.cartons} ${r.cartons === 1 ? 'carton' : 'cartons'}, ${r.pieces} pcs.`, data: { dcId: req.params.dcId, dcNumber: r.dcNumber } })
})

export default router
