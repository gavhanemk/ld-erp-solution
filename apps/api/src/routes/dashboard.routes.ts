import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { reorderStatus } from '../services/stock.service'
import { AuthRequest, userCan } from '../middleware/auth'
import { getNumericPreference } from '../lib/preferences'
import { homeDashboard } from '../services/homeDashboard.service'

const router = Router()

// GET /api/dashboard/summary
router.get('/summary', async (req: AuthRequest, res) => {
  const money = userCan(req.user, 'accounts', 'view')
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
    prisma.purchaseOrder.count({ where: { status: 'DRAFT', approvedAt: null, deletedAt: null } }),
    prisma.materialRequisition.count({ where: { status: 'PENDING', closedAt: null } }),
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
      // The dashboard is the home screen for the whole mill, so it is not
      // guarded as a whole — but the money on it is. A store keeper with no
      // accounts access was being shown what every customer owes, which is
      // exactly the figure the permission grid exists to withhold. Null rather
      // than zero: zero is a fact, and it would be the wrong one.
      revenueMTD: money ? revenueAgg._sum.totalAmount || 0 : null,
      outstandingReceivable: money ? outstandingAgg._sum.balanceAmount || 0 : null,
      outstandingPayable: money ? payableAgg._sum.balanceAmount || 0 : null,
      generatedAt: new Date().toISOString(),
    },
  })
})

// GET /api/dashboard/alerts
router.get('/alerts', async (req: AuthRequest, res) => {
  // Same rule as the summary: who is overdue, and for how much, is an accounts
  // fact. It was being listed by customer name to anyone who could sign in.
  const money = userCan(req.user, 'accounts', 'view')

  const overdueInvoices = money
    ? await prisma.salesInvoice.findMany({
        where: {
          status: { in: ['UNPAID', 'PARTIAL'] },
          dueDate: { lt: new Date() },
        },
        include: { customer: { select: { name: true } } },
        take: 5,
        orderBy: { dueDate: 'asc' },
      })
    : []

  const pendingApprovals = await prisma.purchaseOrder.count({
    where: { status: 'DRAFT', approvedAt: null, deletedAt: null },
  })

  res.json({
    success: true,
    data: {
      overdueInvoices: money ? overdueInvoices.length : null,
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

  // The same rule as the stock screen: our own stock, every store together,
  // at or below the reorder level. A customer's fabric in our godown used to be
  // added in here, which could hide a real shortage.
  const status = await reorderStatus(prisma)

  const warned = status
    .map((i) => ({
      id: i.itemId,
      code: i.itemCode,
      name: i.itemName,
      uom: i.uom,
      reorderLevel: i.reorderLevel,
      currentStock: i.onHand,
      warnAt: i.reorderLevel * (1 + bufferPercent / 100),
      belowReorder: i.isLow,
    }))
    .filter((i) => i.currentStock <= i.warnAt)
    // Items already at or under the reorder level are the real shortages; the
    // buffer only brings the next ones into view, so they sort behind.
    .sort(
      (a, b) =>
        Number(b.belowReorder) - Number(a.belowReorder) ||
        a.currentStock - a.reorderLevel - (b.currentStock - b.reorderLevel),
    )

  const low = warned.slice(0, limit)
  // The list is cut to fit the card; the totals say how many there are in all,
  // so the card and the stock screen give the same number.
  res.json({
    success: true,
    data: low,
    totals: {
      toReorder: warned.filter((i) => i.belowReorder).length,
      comingUp: warned.filter((i) => !i.belowReorder).length,
    },
  })
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
      where: { status: 'DRAFT', approvedAt: null, deletedAt: null },
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
      // A withdrawn requisition is not waiting for anybody.
      where: { status: 'PENDING', closedAt: null },
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
      // So the dashboard does not offer Approve to the person who raised it,
      // which the server would only refuse.
      raisedById: mr.raisedById,
    })),
  ]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, limit)

  res.json({ success: true, data: approvals })
})

// GET /api/dashboard/overview?days=30
// The home screen in one call: every module the signed-in role may see, where
// it stands now and what moved in the period. A module the role may not see
// comes back null, and money owed either way is accounts only, as above.
router.get('/overview', async (req: AuthRequest, res) => {
  const data = await homeDashboard({
    days: Number(req.query.days) || 30,
    access: {
      sales: userCan(req.user, 'sales', 'view'),
      purchase: userCan(req.user, 'purchase', 'view'),
      inventory: userCan(req.user, 'inventory', 'view'),
      production: userCan(req.user, 'production', 'view'),
      money: userCan(req.user, 'accounts', 'view'),
      masters: userCan(req.user, 'masters', 'view'),
      settings: userCan(req.user, 'settings', 'view'),
    },
  })
  res.json({ success: true, data })
})

export default router
