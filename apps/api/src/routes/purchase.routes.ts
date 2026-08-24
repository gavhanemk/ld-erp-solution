import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { applyRoundOff, nextDocumentNumber } from '../lib/docNumber'
import { amountInWords, getPrintHeader } from '../lib/printData'

const router = Router()
const MODULE = 'purchase'

/** Money is stored to two decimals; accumulating floats without rounding drifts. */
const round2 = (n: number) => Math.round(n * 100) / 100

const lineSchema = z.object({
  itemId: z.string().min(1, 'Pick an item'),
  description: z.string().max(300).optional().nullable(),
  qty: z.number().positive('Quantity must be more than zero'),
  unitRate: z.number().min(0, 'Rate cannot be negative'),
  discount: z.number().min(0).max(100).optional(),
  gstRate: z.number().min(0).max(100).optional(),
})

const createSchema = z.object({
  supplierId: z.string().min(1, 'Pick a supplier'),
  poDate: z.coerce.date().optional(),
  deliveryDate: z.coerce.date().optional().nullable(),
  deliveryWarehouseId: z.string().optional().nullable(),
  discountAmount: z.number().min(0).optional(),
  notes: z.string().max(1000).optional().nullable(),
  terms: z.string().max(4000).optional().nullable(),
  lines: z.array(lineSchema).min(1, 'An order needs at least one line'),
})

const updateSchema = createSchema.partial()

const poInclude = {
  supplier: {
    select: {
      id: true, name: true, code: true, gstin: true, stateCode: true,
      address: true, city: true, state: true, pincode: true, phone: true, email: true,
    },
  },
  deliveryWarehouse: { select: { id: true, name: true, address: true } },
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    include: { item: { select: { id: true, code: true, name: true, hsnCode: true, uom: { select: { symbol: true } } } } },
  },
}

/**
 * Works out the tax split for a purchase.
 *
 * The supplier's state against ours decides whether they should bill us
 * CGST+SGST or IGST. Getting it wrong on the order means the bill that comes
 * back will not reconcile against it.
 */
async function purchaseTaxContext(tx: Prisma.TransactionClient, supplierId: string) {
  const [company, supplier] = await Promise.all([
    tx.company.findFirst({ select: { stateCode: true, gstin: true } }),
    tx.supplier.findUnique({ where: { id: supplierId }, select: { stateCode: true, gstin: true, name: true } }),
  ])

  if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')

  const ourState = company?.stateCode || company?.gstin?.slice(0, 2)
  if (!ourState) {
    throw new AppError(
      'Your company GST state code is not set. Add it in Settings → Company, or the tax on this order will be wrong.',
      409,
      'NO_COMPANY_STATE',
    )
  }

  // A supplier with no GSTIN is unregistered; there is no split to make and the
  // order carries no tax, so this must not be treated as an error.
  const theirState = supplier.stateCode || supplier.gstin?.slice(0, 2) || null

  return {
    ourState,
    theirState,
    isIntraState: theirState ? theirState === ourState : true,
    supplierIsUnregistered: !supplier.gstin,
  }
}

function priceOrder(
  lines: z.infer<typeof lineSchema>[],
  discountAmount: number,
  isIntraState: boolean,
  chargeTax: boolean,
) {
  const lineTotals = lines.map((l) => l.qty * l.unitRate * (1 - (l.discount ?? 0) / 100))
  const subtotal = round2(lineTotals.reduce((s, n) => s + n, 0))

  const discount = round2(Math.min(discountAmount, subtotal))
  const taxable = round2(subtotal - discount)
  const factor = subtotal > 0 ? taxable / subtotal : 1

  let cgst = 0
  let sgst = 0
  let igst = 0

  if (chargeTax) {
    lines.forEach((line, i) => {
      const tax = lineTotals[i] * factor * ((line.gstRate ?? 0) / 100)
      if (isIntraState) {
        cgst += tax / 2
        sgst += tax / 2
      } else {
        igst += tax
      }
    })
  }

  cgst = round2(cgst)
  sgst = round2(sgst)
  igst = round2(igst)

  const { rounded, roundOff } = applyRoundOff(taxable + cgst + sgst + igst)

  return { lineTotals, subtotal, discount, taxable, cgst, sgst, igst, roundOff, total: rounded }
}

// ── Purchase orders ─────────────────────────────────────────────────────────

router.get('/orders', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

  const where: Record<string, unknown> = {}
  if (typeof req.query.status === 'string' && req.query.status) where.status = req.query.status
  if (typeof req.query.supplierId === 'string' && req.query.supplierId) {
    where.supplierId = req.query.supplierId
  }
  if (q) {
    where.OR = [
      { poNumber: { contains: q, mode: 'insensitive' } },
      { supplier: { name: { contains: q, mode: 'insensitive' } } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: poInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.purchaseOrder.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/orders/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id }, include: poInclude })
  if (!po) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
  res.json({ success: true, data: po })
})

/** Everything the printed sheet needs, in one call. */
router.get('/orders/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id }, include: poInclude })
  if (!po) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')

  const header = await getPrintHeader('PO')

  res.json({
    success: true,
    data: {
      ...header,
      order: po,
      totalInWords: amountInWords(Number(po.totalAmount)),
      // Which tax columns to print. A purchase from an unregistered supplier
      // carries no GST at all, and showing empty columns invites the question
      // of whether something was forgotten.
      taxMode: Number(po.igst) > 0 ? 'IGST' : Number(po.cgst) > 0 ? 'CGST_SGST' : 'NONE',
    },
  })
})

router.post('/orders', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createSchema.parse(req.body)

  const po = await prisma.$transaction(async (tx) => {
    // A back-dated order belongs to its own financial year's series.
    const poNumber = await nextDocumentNumber(tx, 'PO', data.poDate ?? new Date())
    const tax = await purchaseTaxContext(tx, data.supplierId)

    // HSN is copied onto the line now, so an order already sent to a supplier
    // does not change if the item master is corrected next week.
    const items = await tx.item.findMany({
      where: { id: { in: data.lines.map((l) => l.itemId) } },
      select: { id: true, hsnCode: true },
    })
    const hsnById = new Map(items.map((i) => [i.id, i.hsnCode]))
    if (items.length !== new Set(data.lines.map((l) => l.itemId)).size) {
      throw new AppError('One of those items no longer exists', 400, 'INVALID_ITEM')
    }

    const priced = priceOrder(
      data.lines,
      data.discountAmount ?? 0,
      tax.isIntraState,
      !tax.supplierIsUnregistered,
    )

    return tx.purchaseOrder.create({
      data: {
        poNumber,
        supplierId: data.supplierId,
        poDate: data.poDate ?? new Date(),
        deliveryDate: data.deliveryDate ?? undefined,
        deliveryWarehouseId: data.deliveryWarehouseId || null,
        placeOfSupplyCode: tax.ourState,
        subtotal: priced.subtotal,
        discountAmount: priced.discount,
        taxableAmount: priced.taxable,
        cgst: priced.cgst,
        sgst: priced.sgst,
        igst: priced.igst,
        roundOff: priced.roundOff,
        totalAmount: priced.total,
        notes: data.notes ?? null,
        terms: data.terms ?? null,
        createdById: req.user!.id,
        lines: {
          create: data.lines.map((l, i) => ({
            itemId: l.itemId,
            description: l.description ?? null,
            hsnCode: hsnById.get(l.itemId) ?? null,
            qty: l.qty,
            unitRate: l.unitRate,
            discount: l.discount ?? 0,
            gstRate: tax.supplierIsUnregistered ? 0 : (l.gstRate ?? 0),
            amount: round2(priced.lineTotals[i]),
            pendingQty: l.qty,
            sortOrder: i,
          })),
        },
      },
      include: poInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'PurchaseOrder',
    entityId: po.id,
    after: po,
  })

  res.status(201).json({ success: true, data: po })
})

router.patch('/orders/:id', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = updateSchema.parse(req.body)

  const before = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id }, include: poInclude })
  if (!before) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')

  // Once an order is with the supplier, or goods have started arriving against
  // it, editing it silently would leave the paper they hold disagreeing with
  // ours. Cancel and raise a fresh one instead.
  if (before.status !== 'DRAFT') {
    throw new AppError(
      `This order is ${before.status.toLowerCase().replace('_', ' ')} and can no longer be edited. Raise a new one.`,
      400,
      'PO_NOT_DRAFT',
    )
  }

  const after = await prisma.$transaction(async (tx) => {
    if (data.lines) {
      const tax = await purchaseTaxContext(tx, data.supplierId ?? before.supplierId)
      const items = await tx.item.findMany({
        where: { id: { in: data.lines.map((l) => l.itemId) } },
        select: { id: true, hsnCode: true },
      })
      const hsnById = new Map(items.map((i) => [i.id, i.hsnCode]))

      const priced = priceOrder(
        data.lines,
        data.discountAmount ?? Number(before.discountAmount),
        tax.isIntraState,
        !tax.supplierIsUnregistered,
      )

      await tx.purchaseOrderLine.deleteMany({ where: { poId: before.id } })
      await tx.purchaseOrderLine.createMany({
        data: data.lines.map((l, i) => ({
          poId: before.id,
          itemId: l.itemId,
          description: l.description ?? null,
          hsnCode: hsnById.get(l.itemId) ?? null,
          qty: l.qty,
          unitRate: l.unitRate,
          discount: l.discount ?? 0,
          gstRate: tax.supplierIsUnregistered ? 0 : (l.gstRate ?? 0),
          amount: round2(priced.lineTotals[i]),
          pendingQty: l.qty,
          sortOrder: i,
        })),
      })

      return tx.purchaseOrder.update({
        where: { id: before.id },
        data: {
          ...(data.supplierId ? { supplierId: data.supplierId } : {}),
          ...(data.poDate ? { poDate: data.poDate } : {}),
          ...(data.deliveryDate !== undefined ? { deliveryDate: data.deliveryDate ?? null } : {}),
          ...(data.deliveryWarehouseId !== undefined
            ? { deliveryWarehouseId: data.deliveryWarehouseId || null }
            : {}),
          ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
          ...(data.terms !== undefined ? { terms: data.terms ?? null } : {}),
          subtotal: priced.subtotal,
          discountAmount: priced.discount,
          taxableAmount: priced.taxable,
          cgst: priced.cgst,
          sgst: priced.sgst,
          igst: priced.igst,
          roundOff: priced.roundOff,
          totalAmount: priced.total,
        },
        include: poInclude,
      })
    }

    return tx.purchaseOrder.update({
      where: { id: before.id },
      data: {
        ...(data.poDate ? { poDate: data.poDate } : {}),
        ...(data.deliveryDate !== undefined ? { deliveryDate: data.deliveryDate ?? null } : {}),
        ...(data.deliveryWarehouseId !== undefined
          ? { deliveryWarehouseId: data.deliveryWarehouseId || null }
          : {}),
        ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
        ...(data.terms !== undefined ? { terms: data.terms ?? null } : {}),
      },
      include: poInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseOrder',
    entityId: after.id,
    before,
    after,
  })

  res.json({ success: true, data: after })
})

/** Marks the order as sent to the supplier. From here it can no longer be edited. */
router.patch('/orders/:id/send', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const before = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
  if (before.status !== 'DRAFT') {
    throw new AppError('Only a draft order can be sent', 400, 'PO_NOT_DRAFT')
  }

  const after = await prisma.purchaseOrder.update({
    where: { id: before.id },
    data: { status: 'SENT' },
    include: poInclude,
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseOrder',
    entityId: after.id,
    before,
    after,
  })

  res.json({ success: true, data: after, message: `${after.poNumber} marked as sent.` })
})

router.patch('/orders/:id/cancel', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const reason = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {})

  const before = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } })
  if (!before) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
  if (before.status === 'COMPLETED') {
    throw new AppError('A completed order cannot be cancelled', 400, 'PO_COMPLETED')
  }

  const after = await prisma.purchaseOrder.update({
    where: { id: before.id },
    data: {
      status: 'CANCELLED',
      notes: reason.reason ? `${before.notes ? before.notes + '\n' : ''}Cancelled: ${reason.reason}` : before.notes,
    },
    include: poInclude,
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'PurchaseOrder',
    entityId: after.id,
    before,
    after,
  })

  res.json({ success: true, data: after, message: `${after.poNumber} cancelled.` })
})

// ── Not built yet ───────────────────────────────────────────────────────────
//
// These used to return an empty list, which made the screens look as though
// they worked and simply had no data. Saying so plainly is more honest.

const notBuilt = (what: string) => (_req: unknown, res: import('express').Response) =>
  res.status(501).json({
    success: false,
    message: `${what} has not been built yet.`,
    code: 'NOT_IMPLEMENTED',
  })

router.get('/grn', notBuilt('Goods receipt'))
router.get('/invoices', notBuilt('Purchase bills'))
router.get('/payments', notBuilt('Supplier payments'))

export default router
