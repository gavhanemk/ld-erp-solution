import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { AuthRequest } from '../middleware/auth'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'

const router = Router()

// GET /api/sales/orders
router.get('/orders', async (req: AuthRequest, res) => {
  const { status, customerId, brandId, page = '1', limit = '20' } = req.query
  const skip = (Number(page) - 1) * Number(limit)

  const where: Record<string, unknown> = {}
  if (status) where.status = status
  if (customerId) where.customerId = customerId
  if (brandId) where.brandId = brandId

  const [orders, total] = await Promise.all([
    prisma.salesOrder.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, type: true } },
        brand: { select: { id: true, name: true, type: true } },
        _count: { select: { lines: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit),
    }),
    prisma.salesOrder.count({ where }),
  ])

  res.json({
    success: true,
    data: orders,
    pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) },
  })
})

// GET /api/sales/orders/:id
router.get('/orders/:id', async (req, res) => {
  const order = await prisma.salesOrder.findUnique({
    where: { id: req.params.id },
    include: {
      customer: true,
      brand: true,
      lines: { include: { item: true } },
      deliveryChallans: true,
      invoices: true,
      manufacturingOrders: { select: { moNumber: true, status: true, totalPackedQty: true } },
    },
  })
  if (!order) throw new AppError('Sales order not found', 404)
  res.json({ success: true, data: order })
})

// POST /api/sales/orders
router.post('/orders', async (req: AuthRequest, res) => {
  const { customerId, brandId, deliveryDate, isJobWork, currency, notes, lines, customerPORef, customerPODate, deliveryAddress } = req.body

  const soNumber = `SO-${new Date().getFullYear().toString().slice(2)}${String(new Date().getMonth() > 2 ? new Date().getFullYear() : new Date().getFullYear() - 1).slice(2)}-${String(Math.floor(Math.random() * 9000) + 1000)}`

  const subtotal = lines.reduce((s: number, l: { totalQty: number; unitPrice: number; discount: number }) =>
    s + (l.totalQty * l.unitPrice * (1 - l.discount / 100)), 0)

  const customer = await prisma.customer.findUnique({ where: { id: customerId } })
  const isSameState = customer?.billingState === process.env.COMPANY_STATE_CODE

  const taxableAmount = subtotal
  let cgst = 0, sgst = 0, igst = 0
  for (const line of lines) {
    const lineAmount = line.totalQty * line.unitPrice * (1 - line.discount / 100)
    const tax = lineAmount * (line.gstRate / 100)
    if (isSameState) { cgst += tax / 2; sgst += tax / 2 }
    else { igst += tax }
  }
  const totalAmount = taxableAmount + cgst + sgst + igst

  const order = await prisma.salesOrder.create({
    data: {
      soNumber,
      customerId,
      brandId,
      deliveryDate: deliveryDate ? new Date(deliveryDate) : undefined,
      customerPORef,
      customerPODate: customerPODate ? new Date(customerPODate) : undefined,
      deliveryAddress,
      isJobWork: isJobWork || false,
      currency: currency || 'INR',
      notes,
      subtotal,
      discountAmount: 0,
      taxableAmount,
      cgst,
      sgst,
      igst,
      totalAmount,
      createdById: req.user!.id,
      lines: {
        create: lines.map((l: Record<string, unknown>, i: number) => ({
          ...l,
          pendingQty: l.totalQty,
          sortOrder: i,
        })),
      },
    },
    include: { customer: true, brand: true, lines: true },
  })

  res.status(201).json({ success: true, data: order })
})

// PATCH /api/sales/orders/:id/confirm
router.patch('/orders/:id/confirm', async (req: AuthRequest, res) => {
  const order = await prisma.salesOrder.update({
    where: { id: req.params.id },
    data: { status: 'CONFIRMED', approvedById: req.user!.id, approvedAt: new Date() },
  })
  res.json({ success: true, data: order })
})

// GET /api/sales/invoices
router.get('/invoices', async (req, res) => {
  const invoices = await prisma.salesInvoice.findMany({
    include: { customer: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  res.json({ success: true, data: invoices })
})

// GET /api/sales/outstanding
router.get('/outstanding', async (req, res) => {
  const invoices = await prisma.salesInvoice.findMany({
    where: { status: { in: ['UNPAID', 'PARTIAL'] } },
    include: { customer: { select: { name: true, phone: true } } },
    orderBy: { dueDate: 'asc' },
  })
  res.json({ success: true, data: invoices })
})

export default router
