import { Router } from 'express'
import { prisma, type Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, userCan, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
import {
  balanceOf,
  lockedBalanceOf,
  onHand,
  recordMovement,
  reorderStatus,
  transferStock,
} from '../services/stock.service'
import { decidePending } from '../services/requisition.service'
import {
  adjustmentSchema,
  cancelTransferSchema,
  createRequisitionSchema,
  requisitionSourcingSchema,
  issueRequisitionSchema,
  openingStockSchema,
  rejectRequisitionSchema,
  closeRequisitionSchema,
  transferSchema,
} from '../schemas/inventory.schemas'

const router = Router()
const MODULE = 'inventory'

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

// ── What is on hand ─────────────────────────────────────────────────────────

router.get('/stock', requirePermission(MODULE, 'view'), async (req, res) => {
  const [rows, reorder] = await Promise.all([onHand(prisma, {
    itemId: str(req.query.itemId),
    warehouseId: str(req.query.warehouseId),
    categoryId: str(req.query.categoryId),
    ownership: str(req.query.ownership) as never,
    lowOnly: req.query.low === 'true',
    search: str(req.query.q),
  }), reorderStatus(prisma)])

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
      // Items, not rows: an item in two stores is one thing to reorder. The
      // same count the dashboard shows.
      lowCount: reorder.filter((r) => r.isLow).length,
    },
  })
})

/**
 * The items that need reordering, and how far below they are.
 *
 * The same rule as the stock screen and the dashboard (`reorderStatus`), for
 * any screen that only wants to mark them: the items master shows its warning
 * on these and no others.
 */
router.get('/reorder', requirePermission(MODULE, 'view'), async (_req, res) => {
  const rows = (await reorderStatus(prisma)).filter((r) => r.isLow)
  res.json({ success: true, data: rows })
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
 * Refuses a count or an opening that lists the same item twice.
 *
 * Each line is set against the book figure as it stood before the document,
 * so two lines for one item were both applied: 500 on the book, two lines
 * of 400, and the book ended at 300. Adding the lines up would be a guess —
 * two racks of 400, or one rack counted twice? — so the person is asked to
 * enter the item once, with its total.
 */
async function refuseRepeatedItems(tx: Prisma.TransactionClient, itemIds: string[]) {
  const seen = new Map<string, number>()
  for (const [i, itemId] of itemIds.entries()) {
    const first = seen.get(itemId)
    if (first !== undefined) {
      const item = await tx.item.findUnique({ where: { id: itemId }, select: { name: true } })
      throw new AppError(
        `${item?.name ?? 'An item'} is on lines ${first + 1} and ${i + 1}. Enter it once, with the total.`,
        400,
        'REPEATED_ITEM',
      )
    }
    seen.set(itemId, i)
  }
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

    await refuseRepeatedItems(tx, data.lines.map((l) => l.itemId))

    const reference = `OPEN-${Date.now()}`
    const written = []

    for (const line of data.lines) {
      // Locked, so two people entering the same opening at once cannot both
      // find it empty.
      const existing = await lockedBalanceOf(tx, {
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

    await refuseRepeatedItems(tx, data.lines.map((l) => l.itemId))

    const counted = []

    for (const line of data.lines) {
      const key = { itemId: line.itemId, warehouseId: data.warehouseId }
      const before = await lockedBalanceOf(tx, key)
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
  closedBy: { select: { id: true, name: true } },
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
  const status = str(req.query.status)
  if (status) {
    // Where a requisition stands, which is more than its approval status: an
    // approved one may be waiting, part handed over, complete, or closed.
    const open = { closedAt: null, issuedAt: null }
    const stages: Record<string, Record<string, unknown>> = {
      PENDING: { status: 'PENDING', closedAt: null },
      APPROVED: { status: 'APPROVED', ...open },
      PARTLY: { status: 'APPROVED', ...open, lines: { some: { issuedQty: { gt: 0 } } } },
      ISSUED: { issuedAt: { not: null } },
      CLOSED: { closedAt: { not: null } },
      REJECTED: { status: 'REJECTED' },
    }
    if (!stages[status]) {
      throw new AppError(`Unknown status '${status}'`, 400, 'INVALID_STATUS')
    }
    Object.assign(where, stages[status])
  }
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
      if (mr.closedAt) {
        throw new AppError(
          `${mr.mrNumber} was closed, so how it was answered can no longer be changed.`,
          400,
          'CLOSED',
        )
      }

      const own = new Map(mr.lines.map((l) => [l.id, l]))
      for (const l of data.lines) {
        const line = own.get(l.lineId)
        if (!line) {
          throw new AppError(
            `One of those lines is not on ${mr.mrNumber}. Reopen the requisition and try again.`,
            400,
            'WRONG_LINE',
          )
        }
        // Part of it has already left the rack, so it is the store's line now.
        if (l.fulfilment === 'PURCHASE' && Number(line.issuedQty) > 0) {
          throw new AppError(
            `Some of that line was already handed over from the store, so it cannot be switched to buying. Close the requisition and raise a new one for the rest.`,
            400,
            'PART_ISSUED',
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

    // Only a requisition still pending is approved, checked in the same
    // statement that approves it, so an approve and a refuse arriving
    // together cannot both land.
    await decidePending(before.id, before.mrNumber, {
      status: 'APPROVED',
      approvedById: req.user!.id,
      approvedAt: new Date(),
    })
    const after = await prisma.materialRequisition.findUniqueOrThrow({
      where: { id: before.id },
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

    await decidePending(before.id, before.mrNumber, {
      status: 'REJECTED',
      approvedById: req.user!.id,
      approvedAt: new Date(),
      rejectionReason: reason,
    })
    const after = await prisma.materialRequisition.findUniqueOrThrow({
      where: { id: before.id },
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

/** A quantity as the store says it: 12.5, not 12.500. */
const qtyText = (n: number) => String(Number(n.toFixed(3)))

/**
 * Holds a requisition for the rest of the transaction.
 *
 * Everything that changes what can still be issued (an issue, a close) takes
 * this first, so two of them cannot both work from the same "still to issue".
 * A second waits here and, once through, reads what the first left.
 */
async function lockRequisition(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.material_requisitions WHERE id = ${id} FOR UPDATE`
}

/**
 * Handing the material over. This is the moment stock actually leaves.
 *
 * The store can hand over part of it now and the rest later: 30 of the 50
 * metres today because that is what is on the rack, the other 20 when the
 * next roll comes in. Each issue takes what is given on each line, up to what
 * is still owed, and leaves the rest open. Once every line from the store has
 * been handed over in full, the requisition is complete. If the rest is no
 * longer wanted, it is closed instead (see /close).
 *
 * Within one issue, if any line is short on the rack the whole issue is
 * refused rather than half-done, so what the person pressed is what happened.
 */
router.post(
  '/requisitions/:id/issue',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const body = issueRequisitionSchema.parse(req.body ?? {})
    const when = body.issueDate ?? new Date()

    const result = await prisma.$transaction(async (tx) => {
      // Held before anything is read. Three clicks at once (a double-click,
      // two tabs, a retried request) used to all read "not issued yet" and all
      // take stock: 2 metres asked for, 6 left the store. Now the second waits
      // here and then sees what the first issued.
      await lockRequisition(tx, req.params.id)

      const mr = await tx.materialRequisition.findUnique({
        where: { id: req.params.id },
        include: {
          lines: {
            include: { item: { select: { name: true, uom: { select: { symbol: true } } } } },
          },
          department: true,
        },
      })
      if (!mr) throw new AppError('Requisition not found', 404, 'NOT_FOUND')

      if (mr.closedAt) {
        throw new AppError(
          `${mr.mrNumber} was closed on ${mr.closedAt.toLocaleDateString('en-IN')}, so nothing more can be issued against it.`,
          400,
          'CLOSED',
        )
      }
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
          `${mr.mrNumber} was issued in full on ${mr.issuedAt.toLocaleDateString('en-IN')}.`,
          409,
          'ALREADY_ISSUED',
        )
      }

      // docs/04-business-rules.md, section 7: raised, approved and issued by
      // three different people.
      if (mr.raisedById && mr.raisedById === req.user!.id) {
        throw new AppError(
          'You raised this requisition, so somebody else in the store has to hand the material over.',
          403,
          'SELF_ISSUE',
        )
      }
      if (mr.approvedById && mr.approvedById === req.user!.id) {
        throw new AppError(
          'You approved this requisition, so somebody else in the store has to hand the material over.',
          403,
          'SELF_ISSUE',
        )
      }

      const askedFor = new Map(body.lines?.map((l) => [l.lineId, l.issueQty]) ?? [])
      const handedOver: string[] = []

      for (const line of mr.lines) {
        /*
         * A line marked for purchase is not the store's to answer.
         *
         * It is on this requisition to tell the buyer what to order, and there
         * is nothing on the rack behind it. Skipped rather than refused: a
         * requisition routinely mixes the two.
         */
        if (line.fulfilment === 'PURCHASE') continue

        const unit = line.item.uom?.symbol ?? ''
        const owed = Number((Number(line.requestedQty) - Number(line.issuedQty)).toFixed(3))
        if (owed <= 0) continue

        // Not named in the request: everything still owed on it.
        const qty = askedFor.get(line.id) ?? owed
        if (qty <= 0) continue

        if (qty > owed + 1e-9) {
          throw new AppError(
            `${line.item.name}: only ${qtyText(owed)} ${unit} is still to be issued on this line, not ${qtyText(qty)}. Raise a new requisition for more.`.replace(
              /\s+/g,
              ' ',
            ),
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
          data: { issuedQty: { increment: qty } },
        })
        handedOver.push(`${qtyText(qty)} ${unit} ${line.item.name}`.replace(/\s+/g, ' '))
      }

      if (handedOver.length === 0) {
        throw new AppError(
          'Nothing to hand over: enter a quantity on at least one line.',
          400,
          'NOTHING_TO_ISSUE',
        )
      }

      // Complete once every line from the store has been handed over in full.
      // issuedBy is whoever handed over the last of it; each part is in the
      // stock ledger with its own date, and in the audit trail with its person.
      const lines = await tx.materialRequisitionLine.findMany({ where: { mrId: mr.id } })
      const stillOwed = lines.filter(
        (l) => l.fulfilment !== 'PURCHASE' && Number(l.issuedQty) < Number(l.requestedQty) - 1e-9,
      ).length
      if (stillOwed === 0) {
        await tx.materialRequisition.update({
          where: { id: mr.id },
          data: { issuedById: req.user!.id, issuedAt: when },
        })
      }

      const after = await tx.materialRequisition.findUniqueOrThrow({
        where: { id: mr.id },
        include: mrInclude,
      })
      return { after, handedOver, stillOwed }
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'MaterialRequisition',
      entityId: result.after.id,
      after: { ...result.after, handedOverNow: result.handedOver },
    })

    res.json({
      success: true,
      message:
        result.stillOwed === 0
          ? `${result.after.mrNumber} issued in full.`
          : `Issued against ${result.after.mrNumber}: ${result.handedOver.join(', ')}. ${result.stillOwed} ${result.stillOwed === 1 ? 'line is' : 'lines are'} still to be handed over.`,
      data: result.after,
    })
  },
)

/**
 * Cancelling a requisition, or closing one that is part issued.
 *
 * Material that is no longer wanted should not sit on the list for ever as
 * "approved, not collected". Nothing issued yet: it is cancelled. Some of it
 * issued: it is closed, and what was handed over stays handed over.
 *
 * The person who raised it can withdraw it; the store, or anybody who can
 * approve requisitions, can close one that is no longer needed. A reason is
 * always asked for. Refused and fully issued requisitions are already over.
 */
router.post(
  '/requisitions/:id/close',
  requirePermission(MODULE, 'view'),
  async (req: AuthRequest, res) => {
    const { reason } = closeRequisitionSchema.parse(req.body ?? {})

    const result = await prisma.$transaction(async (tx) => {
      await lockRequisition(tx, req.params.id)
      const before = await tx.materialRequisition.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!before) throw new AppError('Requisition not found', 404, 'NOT_FOUND')

      const mine = before.raisedById === req.user!.id
      if (!mine && !userCan(req.user, MODULE, 'edit') && !userCan(req.user, MODULE, 'approve')) {
        throw new AppError(
          'Only the person who raised it, the store, or an approver can cancel a requisition.',
          403,
          'NOT_ALLOWED',
        )
      }
      if (before.closedAt) {
        throw new AppError(`${before.mrNumber} is already closed.`, 409, 'CLOSED')
      }
      if (before.status === 'REJECTED') {
        throw new AppError(
          `${before.mrNumber} was refused, so there is nothing to cancel.`,
          400,
          'REJECTED',
        )
      }
      if (before.issuedAt) {
        throw new AppError(
          `${before.mrNumber} was issued in full, so there is nothing left to close.`,
          400,
          'ALREADY_ISSUED',
        )
      }

      await tx.materialRequisition.update({
        where: { id: before.id },
        data: { closedAt: new Date(), closedById: req.user!.id, closeReason: reason },
      })
      const after = await tx.materialRequisition.findUniqueOrThrow({
        where: { id: before.id },
        include: mrInclude,
      })
      const partly = before.lines.some((l) => Number(l.issuedQty) > 0)
      return { before, after, partly }
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'MaterialRequisition',
      entityId: result.after.id,
      before: result.before,
      after: result.after,
    })

    res.json({
      success: true,
      message: result.partly
        ? `${result.after.mrNumber} closed. What was handed over stays issued; the rest is no longer owed.`
        : `${result.after.mrNumber} cancelled.`,
      data: result.after,
    })
  },
)

export default router
