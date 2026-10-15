import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import {
  cancelCount,
  cancelCountSchema,
  countView,
  listCounts,
  looseSchema,
  scanPackage,
  scanSchema,
  setLoose,
  startCount,
  startCountSchema,
  submitCount,
  submitSchema,
  undoScan,
} from '../services/stockCount.service'

/*
 * Stock counts by scanning stickers — Inventory → Stock → Stock Count.
 * Counting is the store's work (inventory: create); the adjustment it raises
 * is approved by a store manager in the usual place (inventory: approve).
 */

const router = Router()
const MODULE = 'inventory'
const T = { timeout: 60_000, maxWait: 20_000 }
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))
  const { rows, total } = await listCounts({ status: str(req.query.status), warehouseId: str(req.query.warehouseId), q: str(req.query.q), page, limit })
  res.json({ success: true, data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 } })
})

router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  res.json({ success: true, data: await countView(req.params.id) })
})

/** A count started for one store. */
router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = startCountSchema.parse(req.body)
  const count = await prisma.$transaction((tx) => startCount(tx, data, req.user?.id ?? null), T)
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'StockCount', entityId: count.id, after: count })
  res.status(201).json({ success: true, message: `${count.countNumber} started. Scan every sticker on the racks.`, data: count })
})

/** One sticker scanned, with the rack being counted when the counter gave one. */
router.post('/:id/scan', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { code, rack } = scanSchema.parse(req.body)
  const scan = await prisma.$transaction((tx) => scanPackage(tx, req.params.id, code, req.user?.id ?? null, rack), T)
  res.status(201).json({ success: true, data: scan })
})

/** A scan taken back. */
router.delete('/:id/scans/:scanId', requirePermission(MODULE, 'create'), async (req, res) => {
  await prisma.$transaction((tx) => undoScan(tx, req.params.id, req.params.scanId), T)
  res.json({ success: true, message: 'Scan taken back.' })
})

/** Stock without stickers, counted by hand. */
router.patch('/:id/loose', requirePermission(MODULE, 'create'), async (req, res) => {
  const data = looseSchema.parse(req.body)
  const loose = await prisma.$transaction((tx) => setLoose(tx, req.params.id, data), T)
  res.json({ success: true, data: loose })
})

/** Finished: the differences go to a store manager as a stock adjustment. */
router.post('/:id/submit', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { scope } = submitSchema.parse(req.body ?? {})
  const out = await prisma.$transaction((tx) => submitCount(tx, req.params.id, scope, req.user?.id ?? null), T)
  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'StockCount',
    entityId: req.params.id,
    after: { status: out.settled ? 'CLOSED' : 'SUBMITTED', scope, adjustment: out.adjustment.adjustmentNumber, notFound: out.review.totals.toFind },
  })
  const a = out.adjustment
  const differences = a.lines.filter((l) => Number(l.difference) !== 0).length
  res.json({
    success: true,
    message: out.settled
      ? `${out.count.countNumber} finished: everything counted matched the book. ${a.adjustmentNumber} is saved as approved.`
      : `${out.count.countNumber} finished. ${a.adjustmentNumber} has ${differences} ${differences === 1 ? 'difference' : 'differences'} and waits for a store manager in Stock Documents → Adjustments.${out.review.totals.toFind ? ` The ${out.review.totals.toFind} ${out.review.totals.toFind === 1 ? 'sticker' : 'stickers'} not found ${out.review.totals.toFind === 1 ? 'is' : 'are'} withdrawn once it is approved.` : ''}`,
    data: { adjustment: { id: a.id, adjustmentNumber: a.adjustmentNumber, status: a.status } },
  })
})

/** A count dropped before it is finished. Nothing in stock changes. */
router.post('/:id/cancel', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { reason } = cancelCountSchema.parse(req.body ?? {})
  const count = await prisma.$transaction((tx) => cancelCount(tx, req.params.id, reason), T)
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'StockCount', entityId: count.id, after: { status: 'CANCELLED', reason } })
  res.json({ success: true, message: `${count.countNumber} cancelled. Nothing in stock was changed.`, data: count })
})

export default router
