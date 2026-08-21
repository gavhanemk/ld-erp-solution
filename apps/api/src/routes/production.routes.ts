import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission } from '../middleware/auth'

const router = Router()
const MODULE = 'production'

// GET /api/production/orders
router.get('/orders', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

  const where: Record<string, unknown> = {}
  if (req.query.status) where.status = req.query.status
  if (req.query.brandId) where.brandId = req.query.brandId

  const [orders, total] = await Promise.all([
    prisma.manufacturingOrder.findMany({
      where,
      include: {
        brand: { select: { id: true, name: true, type: true } },
        so: {
          select: { soNumber: true, customer: { select: { name: true } } },
        },
        lines: { include: { style: { select: { code: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.manufacturingOrder.count({ where }),
  ])

  res.json({
    success: true,
    data: orders.map((mo) => ({
      id: mo.id,
      moNumber: mo.moNumber,
      status: mo.status,
      brand: mo.brand,
      customer: mo.so?.customer.name ?? null,
      soNumber: mo.so?.soNumber ?? null,
      // A manufacturing order can cover several styles, so the list gets all
      // their codes and decides how many to show.
      styles: mo.lines.map((l) => l.style.code),
      plannedStartDate: mo.plannedStartDate,
      plannedEndDate: mo.plannedEndDate,
      totalPlannedQty: mo.totalPlannedQty,
      totalCutQty: mo.totalCutQty,
      totalStitchedQty: mo.totalStitchedQty,
      totalFinishedQty: mo.totalFinishedQty,
      totalPackedQty: mo.totalPackedQty,
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

// GET /api/production/orders/:id
router.get('/orders/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const order = await prisma.manufacturingOrder.findUnique({
    where: { id: req.params.id },
    include: {
      brand: true,
      so: { include: { customer: { select: { name: true } } } },
      lines: { include: { style: true } },
      cuttingOrders: true,
      productionEntries: { orderBy: { entryDate: 'desc' }, take: 50 },
      qcRecords: { orderBy: { qcDate: 'desc' }, take: 20 },
      packingOrders: true,
    },
  })
  if (!order) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: order })
})

// GET /api/production/entries?moId=&from=&to=
router.get('/entries', requirePermission(MODULE, 'view'), async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))

  const where: Record<string, unknown> = {}
  if (req.query.moId) where.moId = String(req.query.moId)

  if (req.query.from || req.query.to) {
    const range: Record<string, Date> = {}
    if (req.query.from) range.gte = new Date(String(req.query.from))
    // An end date is inclusive of that whole day, not midnight at its start.
    if (req.query.to) {
      const to = new Date(String(req.query.to))
      to.setHours(23, 59, 59, 999)
      range.lte = to
    }
    where.entryDate = range
  }

  const entries = await prisma.productionEntry.findMany({
    where,
    orderBy: { entryDate: 'desc' },
    take: limit,
    include: { mo: { select: { moNumber: true } } },
  })

  res.json({ success: true, data: entries })
})

// GET /api/production/cutting
router.get('/cutting', requirePermission(MODULE, 'view'), async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))

  const cutting = await prisma.cuttingOrder.findMany({
    orderBy: { cutDate: 'desc' },
    take: limit,
    include: { mo: { select: { moNumber: true } } },
  })

  res.json({ success: true, data: cutting })
})

// GET /api/production/qc
router.get('/qc', requirePermission(MODULE, 'view'), async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))

  const records = await prisma.productionQC.findMany({
    orderBy: { qcDate: 'desc' },
    take: limit,
    include: { mo: { select: { moNumber: true } } },
  })

  res.json({ success: true, data: records })
})

export default router
