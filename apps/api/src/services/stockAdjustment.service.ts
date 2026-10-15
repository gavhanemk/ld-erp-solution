import { prisma } from '@ld-erp/database'
import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { recordMovement } from './stock.service'
import { afterAdjustmentDecided } from './garmentHooks.service'
import { afterCountDecided } from './stockCountHooks.service'
import { autoStickers } from './stickers.service'

/**
 * A stock adjustment is a count the store keeper made; it changes stock only
 * once a store manager approves it. Approving and refusing live here so the
 * inventory screen and the approvals inbox, two doors into the same decision,
 * apply the same rules.
 *
 * The difference posted is the one worked out when the count was made —
 * "the book said 35, we counted 33" — not one recomputed at approval, because
 * the count is a fact about that moment. If stock has since moved so far that
 * a shortfall can no longer be taken out, the stock service refuses and says
 * what is there, and the manager can refuse the count and have it redone.
 */

const include = {
  warehouse: { select: { id: true, name: true } },
  lines: {
    include: {
      item: { select: { name: true } },
      ownerCustomer: { select: { name: true } },
    },
  },
}

export async function approveAdjustment(id: string, userId: string, admin = false) {
  const result = await prisma.$transaction((tx) => approveAdjustmentIn(tx, id, userId, admin), { timeout: 60_000, maxWait: 20_000 })
  // A stock-in brings stock in: its stickers are made now, ready to print,
  // whichever screen it was approved from.
  const stickers = result.after.kind === 'STOCK_IN' ? await autoStickers({ sourceType: 'STOCK_IN', sourceId: result.after.id }, userId) : null
  return { ...result, stickers }
}

/** The approval inside the caller's transaction. */
export async function approveAdjustmentIn(tx: Prisma.TransactionClient, id: string, userId: string, admin = false) {
  await tx.$queryRaw`SELECT id FROM ld_erp.stock_adjustments WHERE id = ${id} FOR UPDATE`
  const before = await tx.stockAdjustment.findUnique({ where: { id }, include })
  if (!before) throw new AppError('That stock adjustment does not exist', 404, 'NOT_FOUND')
  if (before.status !== 'PENDING') {
    throw new AppError(
      `${before.adjustmentNumber} is already ${before.status === 'APPROVED' ? 'approved' : 'refused'}.`,
      409,
      'ALREADY_DECIDED',
    )
  }
  if (!admin && before.madeById === userId) {
    throw new AppError(
      'You counted this, so somebody else has to approve it.',
      403,
      'OWN_ADJUSTMENT',
    )
  }

  for (const line of before.lines) {
    const difference = Number(line.difference)
    if (difference === 0) continue
    const owner = line.ownership === 'CUSTOMER_OWNED' ? ` (${line.ownerCustomer?.name ?? 'customer'}'s)` : ''
    await recordMovement(tx, {
      itemId: line.itemId,
      warehouseId: before.warehouseId,
      ownership: line.ownership,
      ownerCustomerId: line.ownerCustomerId,
      sizeId: line.sizeId,
      transactionType: 'ADJUSTMENT',
      direction: difference > 0 ? 'IN' : 'OUT',
      qty: Math.abs(difference),
      // A customer's cloth carries no value of ours, found or lost.
      unitRate: difference > 0 ? (line.ownership === 'CUSTOMER_OWNED' ? 0 : Number(line.unitRate ?? 0)) : undefined,
      // A stock-in reads as one in the ledger and the reports, not as a count.
      referenceType: before.kind === 'STOCK_IN' ? 'STOCK_IN' : 'STOCK_ADJUSTMENT',
      referenceId: before.id,
      transactionDate: before.adjustmentDate,
      notes: `${before.adjustmentNumber}${owner}: ${before.reason}`,
      // Approved now: entered just after the last movement if its count date is earlier.
      earlierDate: 'move-up',
      // What was counted is a fact; holds on the stock do not change it.
      ignoreReservations: true,
      // A scanned count withdraws the stickers it did not find, just below;
      // a typed one has its stickers taken down to what is left.
      stickers: before.source === 'SCAN_COUNT' ? 'caller' : 'auto',
    })
  }

  const after = await tx.stockAdjustment.update({
    where: { id },
    data: { status: 'APPROVED', approvedById: userId, approvedAt: new Date() },
    include,
  })
  // Tagged garments waiting on this write-off are written off with it.
  await afterAdjustmentDecided(tx, id, true, userId)
  // A scanned count's stickers that were not found go with it.
  await afterCountDecided(tx, id, true, userId)
  return { before, after }
}

export async function rejectAdjustment(id: string, userId: string, reason: string) {
  // All in one: refused, its garments freed and its count closed together, or
  // none of it — a failure half-way used to leave it refused with its garments
  // still held.
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM ld_erp.stock_adjustments WHERE id = ${id} FOR UPDATE`
    const before = await tx.stockAdjustment.findUnique({ where: { id } })
    if (!before) throw new AppError('That stock adjustment does not exist', 404, 'NOT_FOUND')
    if (before.status !== 'PENDING') {
      throw new AppError(
        `${before.adjustmentNumber} is already ${before.status === 'APPROVED' ? 'approved' : 'refused'}.`,
        409,
        'ALREADY_DECIDED',
      )
    }
    await tx.stockAdjustment.update({
      where: { id },
      data: { status: 'REJECTED', approvedById: userId, approvedAt: new Date(), rejectReason: reason },
    })
    // Tagged garments it was writing off are free again; a scanned count it came from is closed.
    await afterAdjustmentDecided(tx, id, false, userId)
    await afterCountDecided(tx, id, false, userId)
    const after = await tx.stockAdjustment.findUniqueOrThrow({ where: { id }, include })
    return { before, after }
  })
}
