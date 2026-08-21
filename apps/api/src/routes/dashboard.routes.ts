import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { AuthRequest } from '../middleware/auth'

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
  const target = todayProductionAgg._sum.target || 1
  const efficiency = Math.round((achieved / target) * 100)

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

export default router
