import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
import { balanceOf, onHand, recordMovement, transferStock } from '../services/stock.service'
import type { Prisma } from '@prisma/client'
import {
  adjustmentSchema,
  cancelCustomerGrnSchema,
  cancelJobWorkChallanSchema,
  cancelTransferSchema,
  createCustomerGrnSchema,
  createJobWorkChallanSchema,
  createJobWorkReturnSchema,
  createRequisitionSchema,
  requisitionSourcingSchema,
  issueRequisitionSchema,
  openingStockSchema,
  rejectRequisitionSchema,
  transferSchema,
} from '../schemas/inventory.schemas'

const router = Router()
const MODULE = 'inventory'

/** Quantities are stored to three decimals; money to two. */
const round3 = (n: number) => Math.round(n * 1000) / 1000
const round2 = (n: number) => Math.round(n * 100) / 100

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

// ── What is on hand ─────────────────────────────────────────────────────────

router.get('/stock', requirePermission(MODULE, 'view'), async (req, res) => {
  const rows = await onHand(prisma, {
    itemId: str(req.query.itemId),
    warehouseId: str(req.query.warehouseId),
    categoryId: str(req.query.categoryId),
    ownership: str(req.query.ownership) as never,
    lowOnly: req.query.low === 'true',
    search: str(req.query.q),
  })

  res.json({
    success: true,
    data: rows,
    summary: {
      lines: rows.length,
      // Only our own stock has a value to us. A customer's fabric sitting in
      // our godown is not an asset and must never reach the balance sheet.
      totalValue: rows
        .filter((r) => r.ownership === 'OWNED')
        .reduce((sum, r) => sum + r.value, 0),
      lowCount: rows.filter((r) => r.isLow).length,
    },
  })
})

/** One item: where it is, and what has happened to it lately. */
router.get('/stock/:itemId', requirePermission(MODULE, 'view'), async (req, res) => {
  const item = await prisma.item.findUnique({
    where: { id: req.params.itemId },
    include: { uom: true, category: true },
  })
  if (!item) throw new AppError('Item not found', 404, 'NOT_FOUND')

  const [byWarehouse, movements] = await Promise.all([
    onHand(prisma, { itemId: item.id }),
    prisma.stockLedger.findMany({
      where: { itemId: item.id },
      include: {
        warehouse: { select: { id: true, name: true } },
        ownerCustomer: { select: { id: true, name: true } },
      },
      orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    }),
  ])

  const owned = byWarehouse.filter((r) => r.ownership === 'OWNED')

  res.json({
    success: true,
    data: {
      item,
      byWarehouse,
      totals: {
        qty: owned.reduce((s, r) => s + r.qty, 0),
        value: owned.reduce((s, r) => s + r.value, 0),
      },
      movements,
    },
  })
})

// ── The ledger ──────────────────────────────────────────────────────────────

/**
 * Every movement, newest first.
 *
 * This is the answer to "why does it say 340 when I counted 300". It is read
 * only and always will be: a ledger somebody can edit is not a ledger.
 */
router.get('/ledger', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))

  const where: Record<string, unknown> = {}
  if (str(req.query.itemId)) where.itemId = str(req.query.itemId)
  if (str(req.query.warehouseId)) where.warehouseId = str(req.query.warehouseId)
  if (str(req.query.type)) where.transactionType = str(req.query.type)

  const from = str(req.query.from)
  const to = str(req.query.to)
  if (from || to) {
    where.transactionDate = {
      ...(from ? { gte: new Date(from) } : {}),
      // An end date means the whole of that day, not midnight at its start.
      ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
    }
  }

  const [rows, total] = await Promise.all([
    prisma.stockLedger.findMany({
      where,
      include: {
        item: { select: { id: true, code: true, name: true, uom: { select: { symbol: true } } } },
        warehouse: { select: { id: true, name: true } },
        ownerCustomer: { select: { id: true, name: true } },
      },
      orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stockLedger.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

/** Stock value, cut by warehouse and by category, for the accounts side. */
router.get('/valuation', requirePermission(MODULE, 'view'), async (_req, res) => {
  const rows = (await onHand(prisma)).filter((r) => r.ownership === 'OWNED')

  const group = (key: (r: (typeof rows)[number]) => string) => {
    const map = new Map<string, { name: string; qty: number; value: number; items: number }>()
    for (const r of rows) {
      const k = key(r)
      const cur = map.get(k) ?? { name: k, qty: 0, value: 0, items: 0 }
      cur.qty += r.qty
      cur.value += r.value
      cur.items += 1
      map.set(k, cur)
    }
    return [...map.values()].sort((a, b) => b.value - a.value)
  }

  res.json({
    success: true,
    data: {
      totalValue: rows.reduce((s, r) => s + r.value, 0),
      byWarehouse: group((r) => r.warehouseName),
      byCategory: group((r) => r.categoryName),
    },
  })
})

// ── Documents that move stock ───────────────────────────────────────────────

const itemSelect = {
  select: { id: true, code: true, name: true, uom: { select: { symbol: true } } },
}

const transferInclude = {
  fromWarehouse: { select: { id: true, name: true } },
  toWarehouse: { select: { id: true, name: true } },
  movedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  lines: { include: { item: itemSelect } },
}

const adjustmentInclude = {
  warehouse: { select: { id: true, name: true } },
  madeBy: { select: { id: true, name: true } },
  lines: { include: { item: itemSelect } },
}

/**
 * Opening stock.
 *
 * Allowed once per item and warehouse. Running it twice is almost always
 * somebody re-importing the same spreadsheet, and the second run would double
 * the mill's stock silently — so it is refused with the name of the item that
 * already has a balance.
 */
router.post('/opening', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = openingStockSchema.parse(req.body)
  const asOn = data.asOnDate ?? new Date()

  const result = await prisma.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.findUnique({ where: { id: data.warehouseId } })
    if (!warehouse) throw new AppError('That warehouse does not exist', 404, 'NOT_FOUND')

    const reference = `OPEN-${Date.now()}`
    const written = []

    for (const line of data.lines) {
      const existing = await balanceOf(tx, {
        itemId: line.itemId,
        warehouseId: data.warehouseId,
      })
      if (existing.qty !== 0) {
        const item = await tx.item.findUnique({
          where: { id: line.itemId },
          select: { name: true },
        })
        throw new AppError(
          `${item?.name ?? 'That item'} already has ${existing.qty} in ${warehouse.name}. Opening stock can only be entered once — use a stock adjustment to correct it.`,
          409,
          'OPENING_ALREADY_SET',
        )
      }

      const { balance } = await recordMovement(tx, {
        itemId: line.itemId,
        warehouseId: data.warehouseId,
        transactionType: 'OPENING',
        direction: 'IN',
        qty: line.qty,
        unitRate: line.unitRate,
        batchNumber: line.batchNumber,
        referenceType: 'OPENING_STOCK',
        referenceId: reference,
        transactionDate: asOn,
        notes: data.notes ?? 'Opening stock',
      })

      written.push({ itemId: line.itemId, qty: line.qty, balance: balance.qty })
    }

    return { reference, lines: written }
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'OpeningStock',
    entityId: result.reference,
    after: result,
  })

  res.status(201).json({
    success: true,
    message: `Opening stock recorded for ${result.lines.length} ${result.lines.length === 1 ? 'item' : 'items'}.`,
    data: result,
  })
})

/**
 * A correction after a physical count.
 *
 * Guarded by the approve permission rather than create. An adjustment is the
 * one movement with no document behind it in the real world — it says the book
 * was wrong — so it should not be within reach of everyone who can receive
 * goods. The reason is mandatory and lands in the ledger against every line.
 */
router.post('/adjustments', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const data = adjustmentSchema.parse(req.body)
  const when = data.adjustmentDate ?? new Date()

  const adjustment = await prisma.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.findUnique({ where: { id: data.warehouseId } })
    if (!warehouse) throw new AppError('That warehouse does not exist', 404, 'NOT_FOUND')

    const counted = []

    for (const line of data.lines) {
      const key = { itemId: line.itemId, warehouseId: data.warehouseId }
      const before = await balanceOf(tx, key)
      const difference = Number((line.countedQty - before.qty).toFixed(3))

      if (difference > 0 && before.qty === 0 && line.unitRate === undefined) {
        const item = await tx.item.findUnique({
          where: { id: line.itemId },
          select: { name: true },
        })
        throw new AppError(
          `${item?.name ?? 'That item'} has nothing on hand to take a rate from. Enter a rate so the stock found can be valued.`,
          400,
          'NO_RATE',
        )
      }

      counted.push({
        itemId: line.itemId,
        bookQty: before.qty,
        countedQty: line.countedQty,
        difference,
        unitRate: difference > 0 ? (line.unitRate ?? before.avgRate) : before.avgRate,
      })
    }

    const adjustmentNumber = await nextDocumentNumber(tx, 'ADJ', when)

    const created = await tx.stockAdjustment.create({
      data: {
        adjustmentNumber,
        warehouseId: data.warehouseId,
        adjustmentDate: when,
        reason: data.reason,
        madeById: req.user?.id ?? null,
        // Every line that was counted is kept, including the ones that matched.
        // "We counted forty items and three were wrong" is the useful sentence
        // in a stock audit; recording only the three loses the forty.
        lines: { create: counted },
      },
    })

    for (const line of counted) {
      // A figure that matched the book needs no movement. The line above is
      // still the record that somebody counted it.
      if (line.difference === 0) continue

      await recordMovement(tx, {
        itemId: line.itemId,
        warehouseId: data.warehouseId,
        transactionType: 'ADJUSTMENT',
        direction: line.difference > 0 ? 'IN' : 'OUT',
        qty: Math.abs(line.difference),
        unitRate: line.difference > 0 ? line.unitRate : undefined,
        referenceType: 'STOCK_ADJUSTMENT',
        referenceId: created.id,
        transactionDate: when,
        notes: `${adjustmentNumber}: ${data.reason}`,
      })
    }

    return tx.stockAdjustment.findUniqueOrThrow({
      where: { id: created.id },
      include: adjustmentInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'StockAdjustment',
    entityId: adjustment.id,
    after: adjustment,
  })

  const corrected = adjustment.lines.filter((l) => Number(l.difference) !== 0).length

  res.status(201).json({
    success: true,
    message: corrected
      ? `${adjustment.adjustmentNumber} saved. ${corrected} ${corrected === 1 ? 'figure' : 'figures'} corrected.`
      : `${adjustment.adjustmentNumber} saved. Everything counted matched the book, so no stock moved.`,
    data: adjustment,
  })
})

router.get('/adjustments', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

  const where: Record<string, unknown> = {}
  if (str(req.query.warehouseId)) where.warehouseId = str(req.query.warehouseId)
  if (str(req.query.q)) {
    where.OR = [
      { adjustmentNumber: { contains: str(req.query.q), mode: 'insensitive' } },
      { reason: { contains: str(req.query.q), mode: 'insensitive' } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.stockAdjustment.findMany({
      where,
      include: adjustmentInclude,
      orderBy: [{ adjustmentDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stockAdjustment.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/adjustments/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const row = await prisma.stockAdjustment.findUnique({
    where: { id: req.params.id },
    include: adjustmentInclude,
  })
  if (!row) throw new AppError('That stock adjustment does not exist', 404, 'NOT_FOUND')
  res.json({ success: true, data: row })
})

/**
 * Moving stock between two of our own stores.
 *
 * Value travels with it: cloth carried across the yard is worth what it was
 * worth on the other side. The rate each line left at is copied onto the
 * document so the note prints the same figure a year later.
 */
router.post('/transfers', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = transferSchema.parse(req.body)
  const when = data.transferDate ?? new Date()

  const transfer = await prisma.$transaction(async (tx) => {
    const [from, to] = await Promise.all([
      tx.warehouse.findUnique({ where: { id: data.fromWarehouseId } }),
      tx.warehouse.findUnique({ where: { id: data.toWarehouseId } }),
    ])
    if (!from || !to) throw new AppError('One of those warehouses does not exist', 404, 'NOT_FOUND')

    const transferNumber = await nextDocumentNumber(tx, 'STN', when)

    const created = await tx.stockTransfer.create({
      data: {
        transferNumber,
        fromWarehouseId: data.fromWarehouseId,
        toWarehouseId: data.toWarehouseId,
        transferDate: when,
        notes: data.notes ?? null,
        movedById: req.user?.id ?? null,
        lines: { create: data.lines.map((l) => ({ itemId: l.itemId, qty: l.qty })) },
      },
      include: { lines: true },
    })

    for (const line of created.lines) {
      // Read what it is carried at before it moves. transferStock prices the
      // arriving stock at the same figure, so this is the rate the document
      // should remember.
      const carried = await balanceOf(tx, {
        itemId: line.itemId,
        warehouseId: data.fromWarehouseId,
      })

      await transferStock(tx, {
        itemId: line.itemId,
        fromWarehouseId: data.fromWarehouseId,
        toWarehouseId: data.toWarehouseId,
        qty: Number(line.qty),
        referenceType: 'STOCK_TRANSFER',
        referenceId: created.id,
        transactionDate: when,
        notes: `${transferNumber}: ${from.name} → ${to.name}`,
      })

      await tx.stockTransferLine.update({
        where: { id: line.id },
        data: { unitRate: carried.avgRate },
      })
    }

    return tx.stockTransfer.findUniqueOrThrow({
      where: { id: created.id },
      include: transferInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'StockTransfer',
    entityId: transfer.id,
    after: transfer,
  })

  res.status(201).json({
    success: true,
    message: `${transfer.transferNumber} saved. ${transfer.lines.length} ${transfer.lines.length === 1 ? 'item' : 'items'} moved from ${transfer.fromWarehouse.name} to ${transfer.toWarehouse.name}.`,
    data: transfer,
  })
})

router.get('/transfers', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

  const where: Record<string, unknown> = {}
  if (str(req.query.warehouseId)) {
    where.OR = [
      { fromWarehouseId: str(req.query.warehouseId) },
      { toWarehouseId: str(req.query.warehouseId) },
    ]
  }
  if (str(req.query.q)) where.transferNumber = { contains: str(req.query.q), mode: 'insensitive' }

  const [rows, total] = await Promise.all([
    prisma.stockTransfer.findMany({
      where,
      include: transferInclude,
      orderBy: [{ transferDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stockTransfer.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/transfers/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const row = await prisma.stockTransfer.findUnique({
    where: { id: req.params.id },
    include: transferInclude,
  })
  if (!row) throw new AppError('That stock transfer does not exist', 404, 'NOT_FOUND')
  res.json({ success: true, data: row })
})

/**
 * Taking a transfer back out.
 *
 * The goods walk back the way they came, so the reversal is a transfer in the
 * other direction rather than a quiet deletion. If the stock has since moved on
 * from the destination the stock service refuses and says how much is actually
 * there — which is the right answer, because the goods have gone and pretending
 * otherwise would leave the rack and the book disagreeing.
 */
router.patch(
  '/transfers/:id/cancel',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { reason } = cancelTransferSchema.parse(req.body ?? {})

    const after = await prisma.$transaction(async (tx) => {
      const before = await tx.stockTransfer.findUnique({
        where: { id: req.params.id },
        include: { lines: true, fromWarehouse: true, toWarehouse: true },
      })
      if (!before) throw new AppError('That stock transfer does not exist', 404, 'NOT_FOUND')

      if (before.cancelledAt) {
        throw new AppError(
          `${before.transferNumber} was already cancelled on ${before.cancelledAt.toLocaleDateString('en-IN')}.`,
          400,
          'ALREADY_CANCELLED',
        )
      }

      for (const line of before.lines) {
        await transferStock(tx, {
          itemId: line.itemId,
          // Back the way it came.
          fromWarehouseId: before.toWarehouseId,
          toWarehouseId: before.fromWarehouseId,
          qty: Number(line.qty),
          referenceType: 'STOCK_TRANSFER_CANCELLED',
          referenceId: before.id,
          transactionDate: new Date(),
          notes: `${before.transferNumber} cancelled: ${reason}`,
        })
      }

      return tx.stockTransfer.update({
        where: { id: before.id },
        data: {
          cancelledAt: new Date(),
          cancelledById: req.user?.id ?? null,
          cancelReason: reason,
        },
        include: transferInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'StockTransfer',
      entityId: after.id,
      after,
    })

    res.json({
      success: true,
      message: `${after.transferNumber} cancelled and the stock moved back to ${after.fromWarehouse.name}.`,
      data: after,
    })
  },
)

// ── Material requisitions ───────────────────────────────────────────────────

const mrInclude = {
  department: { select: { id: true, name: true, code: true } },
  mo: { select: { id: true, moNumber: true } },
  raisedBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  issuedBy: { select: { id: true, name: true } },
  lines: {
    include: {
      item: {
        select: { id: true, code: true, name: true, uom: { select: { symbol: true } } },
      },
      warehouse: { select: { id: true, name: true } },
    },
  },
}

router.get('/requisitions', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))

  const where: Record<string, unknown> = {}
  if (str(req.query.status)) where.status = str(req.query.status)
  if (str(req.query.departmentId)) where.departmentId = str(req.query.departmentId)

  const q = str(req.query.q)
  if (q) {
    where.OR = [
      { mrNumber: { contains: q, mode: 'insensitive' } },
      { department: { name: { contains: q, mode: 'insensitive' } } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.materialRequisition.findMany({
      where,
      include: mrInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.materialRequisition.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/requisitions/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const mr = await prisma.materialRequisition.findUnique({
    where: { id: req.params.id },
    include: mrInclude,
  })
  if (!mr) throw new AppError('Requisition not found', 404, 'NOT_FOUND')

  // What is actually on the rack right now, so whoever approves it is not
  // approving an issue the store cannot fulfil.
  const available = await Promise.all(
    mr.lines.map(async (l) => ({
      lineId: l.id,
      available: (await balanceOf(prisma, { itemId: l.itemId, warehouseId: l.warehouseId })).qty,
    })),
  )

  res.json({ success: true, data: { ...mr, available } })
})

router.post('/requisitions', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createRequisitionSchema.parse(req.body)

  const mr = await prisma.$transaction(async (tx) => {
    const [department, warehouse] = await Promise.all([
      tx.department.findUnique({ where: { id: data.departmentId } }),
      tx.warehouse.findUnique({ where: { id: data.warehouseId } }),
    ])
    if (!department) throw new AppError('That department does not exist', 404, 'NOT_FOUND')
    if (!warehouse) throw new AppError('That warehouse does not exist', 404, 'NOT_FOUND')

    const mrNumber = await nextDocumentNumber(tx, 'MR')

    return tx.materialRequisition.create({
      data: {
        mrNumber,
        departmentId: data.departmentId,
        moId: data.moId || null,
        requiredDate: data.requiredDate ?? null,
        notes: data.notes ?? null,
        raisedById: req.user!.id,
        lines: {
          create: data.lines.map((l) => ({
            itemId: l.itemId,
            requestedQty: l.requestedQty,
            // Whose material this line draws. Without it a request for a
            // customer's fabric would be issued out of our own balance of the
            // same cloth.
            ownership: l.ownership ?? 'OWNED',
            ownerCustomerId: l.ownerCustomerId ?? null,
            // One store per requisition, chosen once on the header in the UI
            // and copied down, so there is still only one place it is stored.
            warehouseId: data.warehouseId,
            purpose: l.purpose ?? null,
          })),
        },
      },
      include: mrInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'MaterialRequisition',
    entityId: mr.id,
    after: mr,
  })

  res.status(201).json({ success: true, data: mr })
})

/**
 * The store's answer: which lines it will issue, and which have to be bought.
 *
 * Only on an approved requisition, and only until it is issued. Before approval
 * there is nothing to answer — the request may yet be refused. After issue the
 * stock has already moved, and saying a line should have been bought would be
 * rewriting what happened.
 *
 * A line marked PURCHASE is not issued by the store; it appears on the purchase
 * order form instead, and stays there until it has been ordered.
 */
router.patch(
  '/requisitions/:id/sourcing',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const data = requisitionSourcingSchema.parse(req.body)

    const after = await prisma.$transaction(async (tx) => {
      const mr = await tx.materialRequisition.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!mr) throw new AppError('Requisition not found', 404, 'NOT_FOUND')

      if (mr.status !== 'APPROVED') {
        throw new AppError(
          mr.status === 'PENDING'
            ? 'This requisition has not been approved yet, so there is nothing for the store to answer.'
            : 'This requisition was refused.',
          400,
          'NOT_APPROVED',
        )
      }
      if (mr.issuedAt) {
        throw new AppError(
          `${mr.mrNumber} was already issued on ${mr.issuedAt.toLocaleDateString('en-IN')}, so how it was answered can no longer be changed.`,
          400,
          'ALREADY_ISSUED',
        )
      }

      const own = new Set(mr.lines.map((l) => l.id))
      for (const l of data.lines) {
        if (!own.has(l.lineId)) {
          throw new AppError(
            `One of those lines is not on ${mr.mrNumber}. Reopen the requisition and try again.`,
            400,
            'WRONG_LINE',
          )
        }
      }

      /*
       * A line already ordered against cannot be handed back to the store.
       * The purchase order exists, the supplier may have despatched, and the
       * indent list would go on showing a request that has been placed.
       */
      const backToStock = data.lines.filter((l) => l.fulfilment === 'FROM_STOCK')
      if (backToStock.length) {
        const ordered = await tx.purchaseOrderLine.findMany({
          where: {
            mrLineId: { in: backToStock.map((l) => l.lineId) },
            po: { status: { not: 'CANCELLED' } },
          },
          select: { mrLineId: true, po: { select: { poNumber: true } } },
        })
        if (ordered.length) {
          throw new AppError(
            `That line is already on ${ordered[0].po.poNumber}. Cancel the order first if it is to come from the store instead.`,
            400,
            'ALREADY_ORDERED',
          )
        }
      }

      await Promise.all(
        data.lines.map((l) =>
          tx.materialRequisitionLine.update({
            where: { id: l.lineId },
            data: { fulfilment: l.fulfilment },
          }),
        ),
      )

      return tx.materialRequisition.findUnique({
        where: { id: mr.id },
        include: mrInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'MaterialRequisition',
      entityId: req.params.id,
      after,
    })

    const buying = data.lines.filter((l) => l.fulfilment === 'PURCHASE').length
    res.json({
      success: true,
      data: after,
      message: buying
        ? `${buying} ${buying === 1 ? 'line goes' : 'lines go'} to the buyer. ${
            buying === 1 ? 'It is' : 'They are'
          } waiting on the purchase order screen.`
        : 'Every line will be issued from the store.',
    })
  },
)

router.patch(
  '/requisitions/:id/approve',
  requirePermission(MODULE, 'approve'),
  async (req: AuthRequest, res) => {
    const before = await prisma.materialRequisition.findUnique({
      where: { id: req.params.id },
      include: mrInclude,
    })
    if (!before) throw new AppError('Requisition not found', 404, 'NOT_FOUND')

    if (before.status !== 'PENDING') {
      throw new AppError(
        `This requisition is already ${before.status.toLowerCase()}.`,
        400,
        'NOT_PENDING',
      )
    }

    // docs/04-business-rules.md, section 7. Nobody signs off their own request,
    // and this is the only place that rule can actually be held.
    if (before.raisedById && before.raisedById === req.user!.id) {
      throw new AppError(
        'You raised this requisition, so somebody else has to approve it.',
        403,
        'SELF_APPROVAL',
      )
    }

    const after = await prisma.materialRequisition.update({
      where: { id: before.id },
      data: { status: 'APPROVED', approvedById: req.user!.id, approvedAt: new Date() },
      include: mrInclude,
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'APPROVE',
      entityType: 'MaterialRequisition',
      entityId: after.id,
      before,
      after,
    })

    res.json({ success: true, message: `${after.mrNumber} approved.`, data: after })
  },
)

router.patch(
  '/requisitions/:id/reject',
  requirePermission(MODULE, 'approve'),
  async (req: AuthRequest, res) => {
    const { reason } = rejectRequisitionSchema.parse(req.body)

    const before = await prisma.materialRequisition.findUnique({
      where: { id: req.params.id },
      include: mrInclude,
    })
    if (!before) throw new AppError('Requisition not found', 404, 'NOT_FOUND')
    if (before.status !== 'PENDING') {
      throw new AppError(
        `This requisition is already ${before.status.toLowerCase()}.`,
        400,
        'NOT_PENDING',
      )
    }

    const after = await prisma.materialRequisition.update({
      where: { id: before.id },
      data: {
        status: 'REJECTED',
        approvedById: req.user!.id,
        approvedAt: new Date(),
        rejectionReason: reason,
      },
      include: mrInclude,
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'REJECT',
      entityType: 'MaterialRequisition',
      entityId: after.id,
      before,
      after,
    })

    res.json({ success: true, message: `${after.mrNumber} refused.`, data: after })
  },
)

/**
 * Handing the material over. This is the moment stock actually leaves.
 *
 * Everything until now was paperwork; one transaction takes the quantities off
 * the rack and stamps who did it. If any line is short the whole issue is
 * refused rather than half-done, because a partly-issued requisition that
 * nobody noticed is how a cutting room starts a lay it cannot finish.
 */
router.post(
  '/requisitions/:id/issue',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const body = issueRequisitionSchema.parse(req.body ?? {})
    const when = body.issueDate ?? new Date()

    const after = await prisma.$transaction(async (tx) => {
      const mr = await tx.materialRequisition.findUnique({
        where: { id: req.params.id },
        include: { lines: true, department: true },
      })
      if (!mr) throw new AppError('Requisition not found', 404, 'NOT_FOUND')

      if (mr.status !== 'APPROVED') {
        throw new AppError(
          mr.status === 'PENDING'
            ? 'This requisition has not been approved yet.'
            : 'This requisition was refused, so nothing can be issued against it.',
          400,
          'NOT_APPROVED',
        )
      }
      if (mr.issuedAt) {
        throw new AppError(
          `${mr.mrNumber} was already issued on ${mr.issuedAt.toLocaleDateString('en-IN')}.`,
          400,
          'ALREADY_ISSUED',
        )
      }

      const askedFor = new Map(body.lines?.map((l) => [l.lineId, l.issueQty]) ?? [])

      for (const line of mr.lines) {
        /*
         * A line marked for purchase is not the store's to answer.
         *
         * It is on this requisition to tell the buyer what to order, and there
         * is nothing on the rack behind it. Skipped silently rather than
         * refused: a requisition routinely mixes the two — four things off
         * the shelf and one to be bought — and stopping the whole issue
         * because of the fifth would leave the other four sitting in a store
         * somebody is waiting at.
         */
        if (line.fulfilment === 'PURCHASE') continue

        const qty = askedFor.get(line.id) ?? Number(line.requestedQty)
        if (qty <= 0) continue

        if (qty > Number(line.requestedQty)) {
          const item = await tx.item.findUnique({
            where: { id: line.itemId },
            select: { name: true },
          })
          throw new AppError(
            `${item?.name ?? 'That item'}: ${qty} is more than the ${Number(line.requestedQty)} approved. Raise a new requisition for the rest.`,
            400,
            'OVER_ISSUE',
          )
        }

        // recordMovement refuses if the rack is short, and names the shortfall.
        await recordMovement(tx, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          transactionType: 'ISSUE',
          direction: 'OUT',
          qty,
          // Hand the ownership straight through. The stock service keeps a
          // customer's cloth and our own in separate balances, so issuing the
          // wrong one would take stock nobody asked for.
          ownership: line.ownership,
          ownerCustomerId: line.ownerCustomerId,
          referenceType: 'MATERIAL_REQUISITION',
          referenceId: mr.id,
          transactionDate: when,
          notes: `${mr.mrNumber} → ${mr.department.name}`,
        })

        await tx.materialRequisitionLine.update({
          where: { id: line.id },
          data: { issuedQty: qty },
        })
      }

      return tx.materialRequisition.update({
        where: { id: mr.id },
        data: { issuedById: req.user!.id, issuedAt: when },
        include: mrInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'MaterialRequisition',
      entityId: after.id,
      after,
    })

    res.json({
      success: true,
      message: `Material issued against ${after.mrNumber}.`,
      data: after,
    })
  },
)


// ── A customer's material, and fabric out at a job worker ───────────────────
//
// Two directions that look alike and are not. A customer's fabric is in our
// godown and is not ours: it is held apart from our own balance of the same
// cloth, carries no value, and never reaches the stock figure. Our fabric at a
// job worker is ours the whole time; it has simply moved to a store standing
// for their floor.

const partySelect = { select: { id: true, name: true, code: true } }
const itemLineSelect = {
  select: { id: true, code: true, name: true, hsnCode: true, uom: { select: { symbol: true } } },
}

const customerGrnInclude = {
  customer: partySelect,
  so: { select: { id: true, soNumber: true } },
  warehouse: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  lines: { include: { item: itemLineSelect } },
}

const jobWorkInclude = {
  jobWorker: partySelect,
  fromWarehouse: { select: { id: true, name: true } },
  toWarehouse: { select: { id: true, name: true } },
  sentBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  lines: { include: { item: itemLineSelect } },
  returns: {
    include: {
      receivedBy: { select: { id: true, name: true } },
      lines: {
        include: { item: itemLineSelect, warehouse: { select: { id: true, name: true } } },
      },
    },
    orderBy: { returnDate: 'asc' as const },
  },
}

/**
 * Booking in a customer's material.
 *
 * The rate is zero and that is the whole point. Rule 6.5 says a customer's
 * fabric in our godown is left out of the stock value, and a zero rate achieves
 * that everywhere the ledger is read rather than only on the two screens that
 * remember to filter. The quantity is real; the value is not ours to claim.
 */
router.post('/customer-grn', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createCustomerGrnSchema.parse(req.body)
  const when = data.receiptDate ?? new Date()

  const grn = await prisma.$transaction(async (tx) => {
    const [customer, warehouse] = await Promise.all([
      tx.customer.findUnique({ where: { id: data.customerId }, select: { id: true, name: true, isActive: true } }),
      tx.warehouse.findUnique({ where: { id: data.warehouseId }, select: { id: true, name: true, isActive: true } }),
    ])
    if (!customer) throw new AppError('That customer does not exist', 404, 'NOT_FOUND')
    if (!warehouse) throw new AppError('That store does not exist', 404, 'NOT_FOUND')
    if (!warehouse.isActive) {
      throw new AppError(
        `${warehouse.name} is no longer in use. Pick another store for these goods.`,
        400,
        'WAREHOUSE_INACTIVE',
      )
    }

    if (data.soId) {
      const so = await tx.salesOrder.findUnique({
        where: { id: data.soId },
        select: { id: true, customerId: true, soNumber: true },
      })
      if (!so) throw new AppError('That sales order does not exist', 404, 'NOT_FOUND')
      if (so.customerId !== data.customerId) {
        throw new AppError(
          `${so.soNumber} belongs to a different customer. Pick the right order, or leave it blank.`,
          400,
          'ORDER_NOT_THEIRS',
        )
      }
    }

    const grnNumber = await nextDocumentNumber(tx, 'CGRN', when)

    const created = await tx.customerGRN.create({
      data: {
        grnNumber,
        customerId: data.customerId,
        soId: data.soId ?? null,
        warehouseId: data.warehouseId,
        receiptDate: when,
        challanNumber: data.challanNumber ?? null,
        challanDate: data.challanDate ?? null,
        gateEntryNumber: data.gateEntryNumber ?? null,
        gateEntryDate: data.gateEntryDate ?? null,
        vehicleNo: data.vehicleNo ?? null,
        transporter: data.transporter ?? null,
        notes: data.notes ?? null,
        receivedById: req.user?.id ?? null,
        lines: {
          create: data.lines.map((l) => ({
            itemId: l.itemId,
            challanQty: l.challanQty,
            receivedQty: l.receivedQty,
            batchNumber: l.batchNumber ?? null,
            markings: l.markings ?? null,
          })),
        },
      },
      include: { lines: true },
    })

    for (const line of created.lines) {
      await recordMovement(tx, {
        itemId: line.itemId,
        warehouseId: data.warehouseId,
        transactionType: 'CUSTOMER_MATERIAL',
        direction: 'IN',
        qty: Number(line.receivedQty),
        // Not ours, so it carries no value to us and never reaches the stock
        // figure or the balance sheet.
        unitRate: 0,
        ownership: 'CUSTOMER_OWNED',
        ownerCustomerId: data.customerId,
        batchNumber: line.batchNumber,
        referenceType: 'CUSTOMER_GRN',
        referenceId: created.id,
        transactionDate: when,
        notes: `${grnNumber}: ${customer.name}`,
      })
    }

    return tx.customerGRN.findUniqueOrThrow({
      where: { id: created.id },
      include: customerGrnInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'CustomerGRN',
    entityId: grn.id,
    after: grn,
  })

  const short = grn.lines.reduce(
    (n, l) => n + (Number(l.receivedQty) !== Number(l.challanQty) ? 1 : 0),
    0,
  )

  res.status(201).json({
    success: true,
    message: short
      ? `${grn.grnNumber} saved. ${short} ${short === 1 ? 'line does' : 'lines do'} not match their challan — worth telling ${grn.customer.name}.`
      : `${grn.grnNumber} saved. ${grn.customer.name}'s material is in ${grn.warehouse.name}.`,
    data: grn,
  })
})

router.get('/customer-grn', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

  const where: Record<string, unknown> = {}
  if (str(req.query.customerId)) where.customerId = str(req.query.customerId)
  if (str(req.query.warehouseId)) where.warehouseId = str(req.query.warehouseId)
  if (str(req.query.q)) {
    where.OR = [
      { grnNumber: { contains: str(req.query.q), mode: 'insensitive' } },
      { challanNumber: { contains: str(req.query.q), mode: 'insensitive' } },
      { customer: { name: { contains: str(req.query.q), mode: 'insensitive' } } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.customerGRN.findMany({
      where,
      include: customerGrnInclude,
      orderBy: [{ receiptDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.customerGRN.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/customer-grn/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const row = await prisma.customerGRN.findUnique({
    where: { id: req.params.id },
    include: customerGrnInclude,
  })
  if (!row) throw new AppError('That receipt does not exist', 404, 'NOT_FOUND')
  res.json({ success: true, data: row })
})

/**
 * Sending a customer's material back out again because the receipt was wrong.
 *
 * If any of it has already been issued to the floor the stock service refuses
 * and says how much is actually left, which is the right answer: the cloth is
 * cut, and a tidy document would not put it back together.
 */
router.patch(
  '/customer-grn/:id/cancel',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { reason } = cancelCustomerGrnSchema.parse(req.body ?? {})

    const after = await prisma.$transaction(async (tx) => {
      const before = await tx.customerGRN.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!before) throw new AppError('That receipt does not exist', 404, 'NOT_FOUND')
      if (before.cancelledAt) {
        throw new AppError(
          `${before.grnNumber} was already cancelled on ${before.cancelledAt.toLocaleDateString('en-IN')}.`,
          400,
          'ALREADY_CANCELLED',
        )
      }

      for (const line of before.lines) {
        const qty = Number(line.receivedQty)
        if (qty <= 0) continue

        await recordMovement(tx, {
          itemId: line.itemId,
          warehouseId: before.warehouseId,
          transactionType: 'RETURN',
          direction: 'OUT',
          qty,
          ownership: 'CUSTOMER_OWNED',
          ownerCustomerId: before.customerId,
          referenceType: 'CUSTOMER_GRN_CANCELLED',
          referenceId: before.id,
          transactionDate: new Date(),
          notes: `${before.grnNumber} cancelled: ${reason}`,
        })
      }

      return tx.customerGRN.update({
        where: { id: before.id },
        data: {
          cancelledAt: new Date(),
          cancelledById: req.user?.id ?? null,
          cancelReason: reason,
        },
        include: customerGrnInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'CustomerGRN',
      entityId: after.id,
      after,
    })

    res.json({
      success: true,
      message: `${after.grnNumber} cancelled and the material taken back off the books.`,
      data: after,
    })
  },
)

/**
 * Sending our own fabric out to an outside unit.
 *
 * The stock does not leave the ledger — it moves to a store standing for that
 * unit's floor, because rule 6.5 says fabric at a job worker is still ours and
 * rule 6.4 says stock always lives in a warehouse. Which means the whole
 * existing machinery answers "how much of ours is sitting at Ritesh Enterprises"
 * with no new reporting at all.
 */
router.post('/job-work', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createJobWorkChallanSchema.parse(req.body)
  const when = data.challanDate ?? new Date()

  const challan = await prisma.$transaction(async (tx) => {
    const [worker, from, to] = await Promise.all([
      tx.supplier.findUnique({
        where: { id: data.jobWorkerId },
        select: { id: true, name: true, isActive: true },
      }),
      tx.warehouse.findUnique({ where: { id: data.fromWarehouseId }, select: { id: true, name: true } }),
      tx.warehouse.findUnique({
        where: { id: data.toWarehouseId },
        select: { id: true, name: true, isActive: true },
      }),
    ])
    if (!worker) throw new AppError('That job worker does not exist', 404, 'NOT_FOUND')
    if (!from || !to) throw new AppError('One of those stores does not exist', 404, 'NOT_FOUND')
    if (!to.isActive) {
      throw new AppError(`${to.name} is no longer in use.`, 400, 'WAREHOUSE_INACTIVE')
    }

    const challanNumber = await nextDocumentNumber(tx, 'JW', when)

    // The HSN is copied onto the line now. A job work challan has to carry it,
    // and correcting the item master next month must not change what a challan
    // already sent out says.
    const items = await tx.item.findMany({
      where: { id: { in: data.lines.map((l) => l.itemId) } },
      select: { id: true, hsnCode: true },
    })
    const hsnOf = new Map(items.map((i) => [i.id, i.hsnCode]))

    const created = await tx.jobWorkChallan.create({
      data: {
        challanNumber,
        jobWorkerId: data.jobWorkerId,
        process: data.process,
        fromWarehouseId: data.fromWarehouseId,
        toWarehouseId: data.toWarehouseId,
        challanDate: when,
        expectedBackOn: data.expectedBackOn ?? null,
        vehicleNo: data.vehicleNo ?? null,
        transporter: data.transporter ?? null,
        lrNumber: data.lrNumber ?? null,
        notes: data.notes ?? null,
        sentById: req.user?.id ?? null,
        lines: {
          create: data.lines.map((l) => ({
            itemId: l.itemId,
            qty: l.qty,
            hsnCode: hsnOf.get(l.itemId) ?? null,
          })),
        },
      },
      include: { lines: true },
    })

    for (const line of created.lines) {
      const carried = await balanceOf(tx, {
        itemId: line.itemId,
        warehouseId: data.fromWarehouseId,
      })

      await transferStock(tx, {
        itemId: line.itemId,
        fromWarehouseId: data.fromWarehouseId,
        toWarehouseId: data.toWarehouseId,
        qty: Number(line.qty),
        referenceType: 'JOB_WORK_CHALLAN',
        referenceId: created.id,
        transactionDate: when,
        notes: `${challanNumber}: ${data.process} at ${worker.name}`,
      })

      await tx.jobWorkChallanLine.update({
        where: { id: line.id },
        data: { unitRate: carried.avgRate },
      })
    }

    return tx.jobWorkChallan.findUniqueOrThrow({
      where: { id: created.id },
      include: jobWorkInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'JobWorkChallan',
    entityId: challan.id,
    after: challan,
  })

  res.status(201).json({
    success: true,
    message: `${challan.challanNumber} saved. ${challan.lines.length} ${challan.lines.length === 1 ? 'item is' : 'items are'} now at ${challan.jobWorker.name} and still ours.`,
    data: challan,
  })
})

router.get('/job-work', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

  const where: Record<string, unknown> = {}
  if (str(req.query.jobWorkerId)) where.jobWorkerId = str(req.query.jobWorkerId)
  if (str(req.query.status)) where.status = str(req.query.status)
  if (str(req.query.q)) {
    where.OR = [
      { challanNumber: { contains: str(req.query.q), mode: 'insensitive' } },
      { process: { contains: str(req.query.q), mode: 'insensitive' } },
      { jobWorker: { name: { contains: str(req.query.q), mode: 'insensitive' } } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.jobWorkChallan.findMany({
      where,
      include: jobWorkInclude,
      orderBy: [{ challanDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.jobWorkChallan.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/job-work/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const row = await prisma.jobWorkChallan.findUnique({
    where: { id: req.params.id },
    include: jobWorkInclude,
  })
  if (!row) throw new AppError('That challan does not exist', 404, 'NOT_FOUND')
  res.json({ success: true, data: row })
})

/**
 * How much of each challan line is still out, counted from the returns rather
 * than kept as a running total on the line — the same reasoning as the purchase
 * order's received quantity. A counter and the documents it counts drift apart
 * the first time one is cancelled.
 */
async function stillOut(tx: Prisma.TransactionClient, challanId: string) {
  const challan = await tx.jobWorkChallan.findUnique({
    where: { id: challanId },
    include: { lines: { include: { item: { select: { name: true } } } } },
  })
  if (!challan) throw new AppError('That challan does not exist', 404, 'NOT_FOUND')

  const sums = await tx.jobWorkReturnLine.groupBy({
    by: ['challanLineId'],
    where: { challanLineId: { in: challan.lines.map((l) => l.id) } },
    _sum: { consumedQty: true },
  })
  const consumed = new Map(sums.map((s) => [s.challanLineId, Number(s._sum.consumedQty ?? 0)]))

  return challan.lines.map((l) => ({
    line: l,
    consumed: consumed.get(l.id) ?? 0,
    outstanding: round3(Number(l.qty) - (consumed.get(l.id) ?? 0)),
  }))
}

/**
 * Goods coming back from an outside unit.
 *
 * Two movements per line, not one, because what comes back is often not what
 * went out: forty metres of fabric return as three hundred cut panels. The
 * material consumed leaves the job worker's balance and whatever arrived comes
 * into ours, and the value of the one carries into the other so nothing is
 * created or destroyed by the conversion. What the unit could not return at all
 * is named as waste rather than quietly absorbed.
 */
router.post(
  '/job-work/:id/returns',
  requirePermission(MODULE, 'create'),
  async (req: AuthRequest, res) => {
    const data = createJobWorkReturnSchema.parse({ ...req.body, challanId: req.params.id })
    const when = data.returnDate ?? new Date()

    const result = await prisma.$transaction(async (tx) => {
      const challan = await tx.jobWorkChallan.findUnique({
        where: { id: req.params.id },
        include: { lines: { include: { item: { select: { name: true } } } }, jobWorker: true },
      })
      if (!challan) throw new AppError('That challan does not exist', 404, 'NOT_FOUND')
      if (challan.cancelledAt) {
        throw new AppError(
          `${challan.challanNumber} was cancelled, so nothing can come back against it.`,
          400,
          'CHALLAN_CANCELLED',
        )
      }

      const outstanding = new Map(
        (await stillOut(tx, challan.id)).map((o) => [o.line.id, o]),
      )

      // Check every line before writing anything, so a return does not book
      // three lines in and then refuse the fourth.
      for (const line of data.lines) {
        const o = outstanding.get(line.challanLineId)
        if (!o) {
          throw new AppError(
            `One of those lines is not on ${challan.challanNumber}.`,
            400,
            'LINE_NOT_ON_CHALLAN',
          )
        }
        if (round3(line.consumedQty) > o.outstanding) {
          throw new AppError(
            o.outstanding > 0
              ? `${o.line.item.name}: only ${o.outstanding} is still out at ${challan.jobWorker.name}, and you are settling ${line.consumedQty}.`
              : `${o.line.item.name}: everything sent has already come back.`,
            400,
            'OVER_RETURN',
          )
        }
      }

      const returnNumber = await nextDocumentNumber(tx, 'JWR', when)

      const created = await tx.jobWorkReturn.create({
        data: {
          returnNumber,
          challanId: challan.id,
          returnDate: when,
          vehicleNo: data.vehicleNo ?? null,
          lrNumber: data.lrNumber ?? null,
          theirChallanNo: data.theirChallanNo ?? null,
          notes: data.notes ?? null,
          receivedById: req.user?.id ?? null,
          lines: {
            create: data.lines.map((l) => ({
              challanLineId: l.challanLineId,
              consumedQty: l.consumedQty,
              itemId: l.itemId,
              receivedQty: l.receivedQty,
              wastedQty: l.wastedQty ?? 0,
              warehouseId: l.warehouseId,
              notes: l.notes ?? null,
            })),
          },
        },
        include: { lines: true },
      })

      for (const line of created.lines) {
        const o = outstanding.get(line.challanLineId)!
        const consumed = Number(line.consumedQty)
        const received = Number(line.receivedQty)

        // What was used up leaves the unit's floor. The stock service prices
        // this at the running average, which is what it left our store at.
        const out = await recordMovement(tx, {
          itemId: o.line.itemId,
          warehouseId: challan.toWarehouseId,
          transactionType: 'PRODUCTION',
          direction: 'OUT',
          qty: consumed,
          referenceType: 'JOB_WORK_RETURN',
          referenceId: created.id,
          transactionDate: when,
          notes: `${returnNumber} against ${challan.challanNumber}`,
        })

        if (received <= 0) continue

        // Whatever arrived comes into our store, carrying the value of the
        // material it was made from. Forty metres at ₹200 returning as three
        // hundred panels makes each panel worth ₹26.67, and the mill's stock
        // value does not move because cloth was cut.
        const carriedValue = round2(consumed * out.unitRate)

        await recordMovement(tx, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          transactionType: 'PRODUCTION',
          direction: 'IN',
          qty: received,
          unitRate: round2(carriedValue / received),
          referenceType: 'JOB_WORK_RETURN',
          referenceId: created.id,
          transactionDate: when,
          notes: `${returnNumber}: ${challan.process} at ${challan.jobWorker.name}`,
        })
      }

      // Closed only when nothing is still out. Counted again after the writes
      // rather than worked out from what we just did.
      const after = await stillOut(tx, challan.id)
      const anyOut = after.some((o) => o.outstanding > 0)
      const anyBack = after.some((o) => o.consumed > 0)

      await tx.jobWorkChallan.update({
        where: { id: challan.id },
        data: { status: anyOut ? (anyBack ? 'PARTLY_BACK' : 'SENT') : 'CLOSED' },
      })

      return {
        challan: await tx.jobWorkChallan.findUniqueOrThrow({
          where: { id: challan.id },
          include: jobWorkInclude,
        }),
        returnNumber,
      }
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'CREATE',
      entityType: 'JobWorkReturn',
      entityId: result.challan.id,
      after: result.challan,
    })

    res.status(201).json({
      success: true,
      message:
        result.challan.status === 'CLOSED'
          ? `${result.returnNumber} saved. Everything sent on ${result.challan.challanNumber} is now back.`
          : `${result.returnNumber} saved. Some of ${result.challan.challanNumber} is still out.`,
      data: result.challan,
    })
  },
)

/**
 * Cancelling a challan walks the goods back from the job worker's floor.
 *
 * Refused once anything has come back against it: the consignment is part
 * finished, and unpicking it with one button would be a lie about what happened.
 */
router.patch(
  '/job-work/:id/cancel',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { reason } = cancelJobWorkChallanSchema.parse(req.body ?? {})

    const after = await prisma.$transaction(async (tx) => {
      const before = await tx.jobWorkChallan.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!before) throw new AppError('That challan does not exist', 404, 'NOT_FOUND')
      if (before.cancelledAt) {
        throw new AppError(`${before.challanNumber} is already cancelled.`, 400, 'ALREADY_CANCELLED')
      }

      const returned = await tx.jobWorkReturn.count({ where: { challanId: before.id } })
      if (returned > 0) {
        throw new AppError(
          `Some of ${before.challanNumber} has already come back, so it cannot be cancelled. Record what is left as a return instead.`,
          400,
          'ALREADY_PARTLY_BACK',
        )
      }

      for (const line of before.lines) {
        await transferStock(tx, {
          itemId: line.itemId,
          fromWarehouseId: before.toWarehouseId,
          toWarehouseId: before.fromWarehouseId,
          qty: Number(line.qty),
          referenceType: 'JOB_WORK_CHALLAN_CANCELLED',
          referenceId: before.id,
          transactionDate: new Date(),
          notes: `${before.challanNumber} cancelled: ${reason}`,
        })
      }

      return tx.jobWorkChallan.update({
        where: { id: before.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledById: req.user?.id ?? null,
          cancelReason: reason,
        },
        include: jobWorkInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'JobWorkChallan',
      entityId: after.id,
      after,
    })

    res.json({
      success: true,
      message: `${after.challanNumber} cancelled and the goods brought back to ${after.fromWarehouse.name}.`,
      data: after,
    })
  },
)

export default router
