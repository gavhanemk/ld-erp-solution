import type { Prisma } from '@prisma/client'

/*
 * What keeps tagged garments right when a document moves their stock from
 * another screen: a challan dispatched or cancelled on the Sales screen, a
 * write-off approved or refused. Kept apart from the scanning service so the
 * challan and adjustment code can call it without importing that service.
 */

export async function event(
  tx: Prisma.TransactionClient,
  ids: string[],
  type: Prisma.GarmentEventCreateManyInput['type'],
  ref: { type?: string; id?: string; number?: string; notes?: string | null },
  userId: string | null,
) {
  if (!ids.length) return
  await tx.garmentEvent.createMany({
    data: ids.map((garmentId) => ({
      garmentId,
      type,
      referenceType: ref.type ?? null,
      referenceId: ref.id ?? null,
      referenceNumber: ref.number ?? null,
      notes: ref.notes ?? null,
      createdById: userId,
    })),
  })
}

/** A challan dispatched, from here or from the Sales screen: its scanned pieces are gone. */
export async function afterChallanDispatched(tx: Prisma.TransactionClient, dcId: string, userId: string | null) {
  const held = await tx.garment.findMany({ where: { dcId, status: 'IN_STOCK' }, select: { id: true } })
  if (!held.length) return
  const dc = await tx.deliveryChallan.findUniqueOrThrow({ where: { id: dcId }, select: { dcNumber: true } })
  await tx.garment.updateMany({ where: { id: { in: held.map((g) => g.id) } }, data: { status: 'DISPATCHED' } })
  await event(tx, held.map((g) => g.id), 'DISPATCHED', { type: 'DELIVERY_CHALLAN', id: dcId, number: dc.dcNumber }, userId)
}

/** A challan cancelled: its pieces are back in the store and free for another. */
export async function afterChallanCancelled(tx: Prisma.TransactionClient, dcId: string, userId: string | null) {
  const on = await tx.garment.findMany({ where: { dcId, status: { in: ['IN_STOCK', 'DISPATCHED'] } }, select: { id: true, status: true } })
  if (!on.length) return
  const dc = await tx.deliveryChallan.findUniqueOrThrow({ where: { id: dcId }, select: { dcNumber: true } })
  await tx.garment.updateMany({ where: { id: { in: on.map((g) => g.id) } }, data: { status: 'IN_STOCK', dcId: null } })
  await event(tx, on.map((g) => g.id), on.some((g) => g.status === 'DISPATCHED') ? 'RETURNED' : 'OFF_CHALLAN', { type: 'DELIVERY_CHALLAN', id: dcId, number: dc.dcNumber, notes: 'Challan cancelled' }, userId)
}

/** A write-off approved: its pieces are gone. Refused: they are free again. */
export async function afterAdjustmentDecided(tx: Prisma.TransactionClient, adjustmentId: string, approved: boolean, userId: string | null) {
  const held = await tx.garment.findMany({ where: { adjustmentId, status: 'IN_STOCK' }, select: { id: true } })
  if (!held.length) return
  const adj = await tx.stockAdjustment.findUniqueOrThrow({ where: { id: adjustmentId }, select: { adjustmentNumber: true } })
  const ids = held.map((g) => g.id)
  if (approved) {
    await tx.garment.updateMany({ where: { id: { in: ids } }, data: { status: 'SCRAPPED' } })
    await event(tx, ids, 'SCRAPPED', { type: 'STOCK_ADJUSTMENT', id: adjustmentId, number: adj.adjustmentNumber }, userId)
  } else {
    await tx.garment.updateMany({ where: { id: { in: ids } }, data: { adjustmentId: null } })
    await event(tx, ids, 'SCRAP_REFUSED', { type: 'STOCK_ADJUSTMENT', id: adjustmentId, number: adj.adjustmentNumber }, userId)
  }
}
