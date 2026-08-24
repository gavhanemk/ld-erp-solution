import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { AuthRequest } from '../middleware/auth'
import { getNumericPreference } from '../lib/preferences'

const router = Router()

// GET /api/dashboard/summary
router.get('/summary', async (req: AuthRequest, res) => {
  const today = new Date()
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59)

  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)

  const [
    activeOrdersCount,
    todayProductionAgg,
    pendingPOCount,
    pendingMRCount,
    revenueAgg,
    outstandingAgg,
    payableAgg,
  ] = await Promise.all([
    prisma.salesOrder.count({
      where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] } },
    }),
    prisma.productionEntry.aggregate({
      where: { entryDate: { gte: startOfDay, lte: endOfDay } },
      _sum: { achieved: true, target: true, rejection: true },
    }),
    prisma.purchaseOrder.count({ where: { status: 'DRAFT', approvedAt: null } }),
    prisma.materialRequisition.count({ where: { status: 'PENDING' } }),
    prisma.salesInvoice.aggregate({
      where: { invoiceDate: { gte: startOfMonth } },
      _sum: { totalAmount: true },
    }),
    prisma.salesInvoice.aggregate({
      where: { status: { in: ['UNPAID', 'PARTIAL'] } },
      _sum: { balanceAmount: true },
    }),
    prisma.purchaseInvoice.aggregate({
      where: { status: { in: ['UNPAID', 'PARTIAL'] } },
      _sum: { balanceAmount: true },
    }),
  ])

  const achieved = todayProductionAgg._sum.achieved || 0
  // Report the real target. Substituting 1 to dodge the divide made the
  // dashboard claim "of 1 target" on a day nobody had set one.
  const target = todayProductionAgg._sum.target || 0
  const efficiency = target > 0 ? Math.round((achieved / target) * 100) : 0

  res.json({
    success: true,
    data: {
      activeOrders: activeOrdersCount,
      todayProduction: {
        achieved,
        target,
        efficiency,
        rejection: todayProductionAgg._sum.rejection || 0,
      },
      pendingApprovals: pendingPOCount + pendingMRCount,
      revenueMTD: revenueAgg._sum.totalAmount || 0,
      outstandingReceivable: outstandingAgg._sum.balanceAmount || 0,
      outstandingPayable: payableAgg._sum.balanceAmount || 0,
      generatedAt: new Date().toISOString(),
    },
  })
})

// GET /api/dashboard/alerts
router.get('/alerts', async (_, res) => {
  const overdueInvoices = await prisma.salesInvoice.findMany({
    where: {
      status: { in: ['UNPAID', 'PARTIAL'] },
      dueDate: { lt: new Date() },
    },
    include: { customer: { select: { name: true } } },
    take: 5,
    orderBy: { dueDate: 'asc' },
  })

  const pendingApprovals = await prisma.purchaseOrder.count({
    where: { status: 'DRAFT', approvedAt: null },
  })

  res.json({
    success: true,
    data: {
      overdueInvoices: overdueInvoices.length,
      pendingApprovals,
      overdueList: overdueInvoices.map((i) => ({
        invoice: i.invoiceNumber,
        customer: i.customer.name,
        amount: i.balanceAmount,
        dueDate: i.dueDate,
      })),
    },
  })
})

// GET /api/dashboard/revenue-trend?months=6
// Invoiced value per calendar month, oldest first.
router.get('/revenue-trend', async (req, res) => {
  const months = Math.min(24, Math.max(1, Number(req.query.months) || 6))

  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1)

  const [sales, purchases] = await Promise.all([
    prisma.salesInvoice.findMany({
      where: { invoiceDate: { gte: start } },
      select: { invoiceDate: true, totalAmount: true },
    }),
    prisma.purchaseInvoice.findMany({
      where: { billDate: { gte: start } },
      select: { billDate: true, totalAmount: true },
    }),
  ])

  // Every month in the window must appear, including the ones with no
  // invoices, or the chart silently compresses gaps and misleads.
  const buckets = new Map<string, { revenue: number; expenses: number }>()
  for (let i = 0; i < months; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
    buckets.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, {
      revenue: 0,
      expenses: 0,
    })
  }

  const keyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

  for (const inv of sales) {
    const bucket = buckets.get(keyOf(inv.invoiceDate))
    if (bucket) bucket.revenue += Number(inv.totalAmount)
  }
  for (const bill of purchases) {
    const bucket = buckets.get(keyOf(bill.billDate))
    if (bucket) bucket.expenses += Number(bill.totalAmount)
  }

  res.json({
    success: true,
    data: [...buckets.entries()].map(([month, totals]) => ({
      month,
      label: new Date(`${month}-01`).toLocaleDateString('en-IN', {
        month: 'short',
        year: '2-digit',
      }),
      ...totals,
    })),
  })
})

// GET /api/dashboard/order-status
router.get('/order-status', async (_req, res) => {
  const grouped = await prisma.salesOrder.groupBy({
    by: ['status'],
    _count: { _all: true },
    _sum: { totalAmount: true },
  })

  res.json({
    success: true,
    data: grouped.map((g) => ({
      status: g.status,
      count: g._count._all,
      value: Number(g._sum.totalAmount ?? 0),
    })),
  })
})

// GET /api/dashboard/recent-orders?limit=5
router.get('/recent-orders', async (req, res) => {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5))

  const orders = await prisma.salesOrder.findMany({
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      customer: { select: { name: true } },
      brand: { select: { name: true, type: true } },
    },
  })

  res.json({
    success: true,
    data: orders.map((o) => ({
      id: o.id,
      soNumber: o.soNumber,
      customer: o.customer.name,
      brand: o.brand.name,
      brandType: o.brand.type,
      status: o.status,
      totalAmount: Number(o.totalAmount),
      isJobWork: o.isJobWork,
      deliveryDate: o.deliveryDate,
    })),
  })
})

// GET /api/dashboard/low-stock?limit=10
// Items whose closing stock has fallen to or below their reorder level.
router.get('/low-stock', async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10))

  // Settings → Preferences can ask for a warning before stock actually reaches
  // the reorder level, so there is time to raise a purchase order.
  const bufferPercent = await getNumericPreference('lowStockBufferPercent', 0)

  const items = await prisma.item.findMany({
    where: { isActive: true, reorderLevel: { gt: 0 } },
    select: { id: true, code: true, name: true, reorderLevel: true, uom: { select: { symbol: true } } },
  })
  if (items.length === 0) return res.json({ success: true, data: [] })

  // Stock on hand is the ledger's net movement per item, across warehouses.
  const movements = await prisma.stockLedger.groupBy({
    by: ['itemId'],
    where: { itemId: { in: items.map((i) => i.id) } },
    _sum: { inQty: true, outQty: true },
  })

  const onHand = new Map(
    movements.map((m) => [m.itemId, Number(m._sum.inQty ?? 0) - Number(m._sum.outQty ?? 0)]),
  )

  const low = items
    .map((i) => {
      const reorderLevel = Number(i.reorderLevel)
      return {
        id: i.id,
        code: i.code,
        name: i.name,
        uom: i.uom?.symbol ?? '',
        reorderLevel,
        // An item that has never moved is at zero, which is genuinely below its
        // reorder level and should be flagged.
        currentStock: onHand.get(i.id) ?? 0,
        warnAt: reorderLevel * (1 + bufferPercent / 100),
      }
    })
    .filter((i) => i.currentStock <= i.warnAt)
    // Items already at or under the reorder level are the real shortages; the
    // buffer only brings the next ones into view, so they sort behind.
    .map((i) => ({ ...i, belowReorder: i.currentStock <= i.reorderLevel }))
    .sort((a, b) => a.currentStock - a.reorderLevel - (b.currentStock - b.reorderLevel))
    .slice(0, limit)

  res.json({ success: true, data: low })
})

// GET /api/dashboard/production-today
// Today's output per workstation, for the line-wise performance widget.
router.get('/production-today', async (_req, res) => {
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)

  const grouped = await prisma.productionEntry.groupBy({
    by: ['workstationId'],
    where: { entryDate: { gte: startOfDay, lte: endOfDay } },
    _sum: { target: true, achieved: true, rejection: true, rework: true },
  })

  // Most of these are outside job-work units rather than lines on our own
  // floor, so the name and the unit behind it both matter on the widget.
  const ids = grouped.map((g) => g.workstationId).filter((id): id is string => Boolean(id))
  const stations = ids.length
    ? await prisma.workstation.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, type: true, supplier: { select: { name: true } } },
      })
    : []
  const byId = new Map(stations.map((w) => [w.id, w]))

  const lines = grouped
    .map((g) => {
      const target = g._sum.target ?? 0
      const achieved = g._sum.achieved ?? 0
      const station = g.workstationId ? byId.get(g.workstationId) : undefined

      return {
        workstationId: g.workstationId,
        line: station?.name ?? 'Unassigned',
        isJobWork: station?.type === 'JOB_WORK',
        jobWorkUnit: station?.supplier?.name ?? null,
        target,
        achieved,
        rejection: g._sum.rejection ?? 0,
        rework: g._sum.rework ?? 0,
        // Guard the divide: a line can be logged with output but no target.
        efficiency: target > 0 ? Math.round((achieved / target) * 100) : 0,
      }
    })
    .sort((a, b) => a.line.localeCompare(b.line, undefined, { numeric: true }))

  res.json({ success: true, data: lines })
})

// GET /api/dashboard/pending-approvals?limit=10
// Documents waiting on a sign-off, newest first.
router.get('/pending-approvals', async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10))

  const [purchaseOrders, salesOrders, requisitions] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: { status: 'DRAFT', approvedAt: null },
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { supplier: { select: { name: true } } },
    }),
    prisma.salesOrder.findMany({
      where: { status: 'DRAFT', approvedAt: null },
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { customer: { select: { name: true } } },
    }),
    prisma.materialRequisition.findMany({
      where: { status: 'PENDING' },
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { department: { select: { name: true } } },
    }),
  ])

  // Anything left unapproved for too long is called out, so the oldest items do
  // not quietly sink down the list. How long is set in Settings → Preferences.
  const urgentAfterDays = await getNumericPreference('approvalUrgentAfterDays', 2)
  const isUrgent = (d: Date) =>
    (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24) > urgentAfterDays

  const approvals = [
    ...purchaseOrders.map((po) => ({
      id: po.id,
      type: 'PO' as const,
      number: po.poNumber,
      description: po.supplier.name,
      amount: Number(po.totalAmount),
      date: po.createdAt,
      urgent: isUrgent(po.createdAt),
    })),
    ...salesOrders.map((so) => ({
      id: so.id,
      type: 'SO' as const,
      number: so.soNumber,
      description: so.customer.name,
      amount: Number(so.totalAmount),
      date: so.createdAt,
      urgent: isUrgent(so.createdAt),
    })),
    ...requisitions.map((mr) => ({
      id: mr.id,
      type: 'MR' as const,
      number: mr.mrNumber,
      description: mr.department.name,
      amount: null,
      date: mr.createdAt,
      urgent: isUrgent(mr.createdAt),
    })),
  ]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, limit)

  res.json({ success: true, data: approvals })
})

export default router
