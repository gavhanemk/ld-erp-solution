import { Router } from 'express'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
import { balanceOf, onHand, recordMovement, transferStock } from '../services/stock.service'
import {
  adjustmentSchema,
  cancelTransferSchema,
  createRequisitionSchema,
  requisitionSourcingSchema,
  issueRequisitionSchema,
  openingStockSchema,
  rejectRequisitionSchema,
  transferSchema,
} from '../schemas/inventory.schemas'

const router = Router()
const MODULE = 'inventory'

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

export default router
