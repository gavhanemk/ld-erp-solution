import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AuthRequest } from '../middleware/auth'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { writeAuditLog } from '../lib/audit'
import { applyRoundOff, nextDocumentNumber, resolvePlaceOfSupply } from '../lib/docNumber'

const router = Router()

/**
 * A sales order used to be created straight from `req.body` with no validation
 * at all, which meant a missing quantity became NaN and a bad customer id
 * surfaced as a database error.
 */
const salesOrderLineSchema = z.object({
  itemId: z.string().min(1, 'Pick an item'),
  styleCode: z.string().max(50).optional().nullable(),
  color: z.string().max(50).optional().nullable(),
  totalQty: z.number().positive('Quantity must be more than zero'),
  unitPrice: z.number().min(0, 'Rate cannot be negative'),
  discount: z.number().min(0).max(100).optional(),
  gstRate: z.number().min(0).max(100).optional(),
  /** The size run for this line. Quantities must add up to the line total. */
  sizes: z
    .array(z.object({ sizeId: z.string().min(1), qty: z.number().min(0) }))
    .optional(),
})

export const createSalesOrderSchema = z
  .object({
    customerId: z.string().min(1, 'Pick a customer'),
    brandId: z.string().min(1, 'Pick a brand'),
    orderDate: z.coerce.date().optional(),
    deliveryDate: z.coerce.date().optional().nullable(),
    customerPORef: z.string().max(60).optional().nullable(),
    customerPODate: z.coerce.date().optional().nullable(),
    deliveryAddress: z.string().max(500).optional().nullable(),
    salesperson: z.string().max(120).optional().nullable(),
    brokerId: z.string().optional().nullable(),
    brokeragePercent: z.number().min(0).max(100).optional().nullable(),
    discountAmount: z.number().min(0).optional(),
    isJobWork: z.boolean().optional(),
    currency: z.string().length(3).optional(),
    notes: z.string().max(1000).optional().nullable(),
    lines: z.array(salesOrderLineSchema).min(1, 'An order needs at least one line'),
  })
  // A size run that does not add up to the line quantity is the classic way a
  // cutting sheet and an invoice quietly stop agreeing.
  .superRefine((order, ctx) => {
    order.lines.forEach((line, i) => {
      if (!line.sizes?.length) return
      const sum = line.sizes.reduce((s, x) => s + x.qty, 0)
      if (Math.abs(sum - line.totalQty) > 0.001) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'sizes'],
          message: `Size quantities add up to ${sum}, but the line total is ${line.totalQty}`,
        })
      }
    })
  })

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
  const data = createSalesOrderSchema.parse(req.body)

  const order = await prisma.$transaction(async (tx) => {
    const soNumber = await nextDocumentNumber(tx, 'SO')
    const { placeOfSupplyCode, isIntraState } = await resolvePlaceOfSupply(tx, data.customerId)

    // Line discounts first, then a discount on the whole bill. LD prices at
    // invoice level, so taxing before that discount would overstate the GST.
    const lineTotals = data.lines.map((l) => l.totalQty * l.unitPrice * (1 - (l.discount ?? 0) / 100))
    const subtotal = round2(lineTotals.reduce((s, n) => s + n, 0))

    const discountAmount = round2(Math.min(data.discountAmount ?? 0, subtotal))
    const taxableAmount = round2(subtotal - discountAmount)

    // The bill-level discount is spread across the lines in proportion, so each
    // line is taxed on what the customer is actually being charged for it.
    const discountFactor = subtotal > 0 ? taxableAmount / subtotal : 1

    let cgst = 0
    let sgst = 0
    let igst = 0
    data.lines.forEach((line, i) => {
      const tax = lineTotals[i] * discountFactor * ((line.gstRate ?? 0) / 100)
      if (isIntraState) {
        cgst += tax / 2
        sgst += tax / 2
      } else {
        igst += tax
      }
    })
    cgst = round2(cgst)
    sgst = round2(sgst)
    igst = round2(igst)

    const beforeRounding = taxableAmount + cgst + sgst + igst
    const { rounded, roundOff } = applyRoundOff(beforeRounding)

    // Brokerage falls on the order value, not on the tax.
    const brokeragePercent = data.brokeragePercent ?? (await defaultBrokerage(tx, data.customerId, data.brokerId))
    const brokerageAmount = round2((taxableAmount * (brokeragePercent ?? 0)) / 100)

    return tx.salesOrder.create({
      data: {
        soNumber,
        customerId: data.customerId,
        brandId: data.brandId,
        orderDate: data.orderDate ?? new Date(),
        deliveryDate: data.deliveryDate ?? undefined,
        customerPORef: data.customerPORef ?? null,
        customerPODate: data.customerPODate ?? undefined,
        deliveryAddress: data.deliveryAddress ?? null,
        salesperson: data.salesperson ?? null,
        brokerId: data.brokerId ?? null,
        brokeragePercent: brokeragePercent ?? null,
        brokerageAmount,
        placeOfSupplyCode,
        isJobWork: data.isJobWork ?? false,
        currency: data.currency ?? 'INR',
        notes: data.notes ?? null,
        subtotal,
        discountAmount,
        taxableAmount,
        cgst,
        sgst,
        igst,
        roundOff,
        totalAmount: rounded,
        createdById: req.user!.id,
        lines: {
          create: data.lines.map((l, i) => ({
            itemId: l.itemId,
            styleCode: l.styleCode ?? null,
            color: l.color ?? null,
            totalQty: l.totalQty,
            unitPrice: l.unitPrice,
            discount: l.discount ?? 0,
            gstRate: l.gstRate ?? 0,
            amount: round2(lineTotals[i]),
            pendingQty: l.totalQty,
            sortOrder: i,
            sizes: l.sizes?.length
              ? { create: l.sizes.map((s) => ({ sizeId: s.sizeId, qty: s.qty })) }
              : undefined,
          })),
        },
      },
      include: {
        customer: { select: { id: true, name: true, gstin: true } },
        brand: { select: { id: true, name: true } },
        broker: { select: { id: true, name: true } },
        lines: { include: { sizes: { include: { size: true } } }, orderBy: { sortOrder: 'asc' } },
      },
    })
  })

  await writeAuditLog(req, {
    module: 'sales',
    action: 'CREATE',
    entityType: 'SalesOrder',
    entityId: order.id,
    after: order,
  })

  res.status(201).json({ success: true, data: order })
})

/** Money is stored to two decimals; accumulating floats without rounding drifts. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Brokerage falls back to the rate on the broker, then to the rate agreed with
 * the customer, so nobody has to retype it on every order.
 */
async function defaultBrokerage(
  tx: Prisma.TransactionClient,
  customerId: string,
  brokerId?: string | null,
): Promise<number | null> {
  if (brokerId) {
    const broker = await tx.broker.findUnique({
      where: { id: brokerId },
      select: { brokeragePercent: true },
    })
    if (broker) return Number(broker.brokeragePercent)
  }

  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: { brokeragePercent: true },
  })
  return customer?.brokeragePercent != null ? Number(customer.brokeragePercent) : null
}

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
