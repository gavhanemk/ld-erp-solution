import type { Prisma } from '@prisma/client'

/*
 * What happens to finished-goods cartons when the delivery challan they are
 * loaded on moves on. Kept apart from the carton service, which itself builds
 * challans, so the challan routes can call these without going round in a
 * circle.
 */

/** A challan gone: the cartons loaded on it went with it. */
export async function cartonsAfterDispatch(tx: Prisma.TransactionClient, dcId: string) {
  await tx.fgCarton.updateMany({ where: { dcId, status: 'PACKED' }, data: { status: 'DISPATCHED', dispatchedAt: new Date() } })
}

/** A challan cancelled: its cartons are back in the store, sealed, free for another. */
export async function cartonsAfterCancel(tx: Prisma.TransactionClient, dcId: string) {
  await tx.fgCarton.updateMany({ where: { dcId, status: 'PACKED' }, data: { dcId: null } })
}

/** How many cartons a challan carries: its lines then come from them, not from typing. */
export async function cartonsOnChallan(tx: Prisma.TransactionClient, dcId: string) {
  return tx.fgCarton.count({ where: { dcId, status: { not: 'OPENED' } } })
}
