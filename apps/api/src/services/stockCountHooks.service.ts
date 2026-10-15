import type { Prisma } from '@prisma/client'
import { recordPackageMove } from './package.service'

/**
 * A scanned count's adjustment decided by a store manager.
 *
 * Approved: the stock is already corrected by the adjustment, so the stickers
 * nobody found are withdrawn — the boxes are not on the rack, and a sticker
 * left standing for one would send somebody looking for it. Only those fixed
 * when the count was finished, and only while they are still in stock in that
 * store: a box issued or moved since is left alone.
 *
 * Refused: nothing is withdrawn; the count is closed as it stands, and a new
 * count can be started.
 *
 * Kept apart from the count itself so the adjustment's approval can call it
 * without the two depending on each other.
 */
export async function afterCountDecided(tx: Prisma.TransactionClient, adjustmentId: string, approved: boolean, userId: string | null) {
  const count = await tx.stockCount.findFirst({
    where: { adjustmentId, status: 'SUBMITTED' },
    select: { id: true, countNumber: true, warehouseId: true, missing: true, adjustment: { select: { adjustmentNumber: true } } },
  })
  if (!count) return { withdrawn: 0 }
  let withdrawn = 0
  if (approved) {
    const ids = Array.isArray(count.missing) ? (count.missing as string[]) : []
    const packages = ids.length
      ? await tx.stockPackage.findMany({ where: { id: { in: ids }, warehouseId: count.warehouseId, status: 'IN_STOCK' }, select: { id: true, qty: true } })
      : []
    for (const p of packages) {
      await tx.$queryRaw`SELECT id FROM ld_erp.stock_packages WHERE id = ${p.id} FOR UPDATE`
      await tx.stockPackage.update({ where: { id: p.id }, data: { qty: 0, status: 'VOID' } })
      await recordPackageMove(tx, {
        packageId: p.id,
        type: 'VOIDED',
        qty: -Number(p.qty),
        balanceAfter: 0,
        warehouseId: count.warehouseId,
        referenceType: 'STOCK_COUNT',
        referenceId: count.id,
        referenceNumber: count.countNumber,
        notes: `Not found in stock count ${count.countNumber}; written off on ${count.adjustment?.adjustmentNumber ?? 'its adjustment'}`,
        userId,
      })
      withdrawn++
    }
  }
  await tx.stockCount.update({ where: { id: count.id }, data: { status: 'CLOSED', closedAt: new Date() } })
  return { withdrawn }
}
