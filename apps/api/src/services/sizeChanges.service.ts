import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * Size jumps at stitching, read back: how far each order line's sizes moved
 * from what was planned, and the history of every change. Recorded by
 * `changeSizes` / `undoSizeChange` in floor.service.ts; nothing here writes.
 *
 * An order line's planned sizes (MOLineSize) are never edited. Its revised
 * size is the planned one plus pieces made as it, less pieces of it made as
 * another — counting only changes not undone. Worked out every time, never
 * stored, so it cannot drift from what happened.
 */

type Db = PrismaClient | Prisma.TransactionClient

/** Net pieces each size of each line gained (+) or gave up (−) to size changes not undone. */
export async function netSizeChanges(db: Db, where: Prisma.SizeChangeWhereInput) {
  const live: Prisma.SizeChangeWhereInput = { ...where, undoneAt: null }
  const [into, outOf] = await Promise.all([
    db.sizeChange.groupBy({ by: ['moLineId', 'toSizeId'], where: live, _sum: { qty: true } }),
    db.sizeChange.groupBy({ by: ['moLineId', 'fromSizeId'], where: live, _sum: { qty: true } }),
  ])
  const net = new Map<string, Map<string, number>>()
  const add = (moLineId: string, sizeId: string, qty: number) => {
    const m = net.get(moLineId) ?? new Map<string, number>()
    m.set(sizeId, (m.get(sizeId) ?? 0) + qty)
    net.set(moLineId, m)
  }
  for (const r of into) add(r.moLineId, r.toSizeId, r._sum.qty ?? 0)
  for (const r of outOf) add(r.moLineId, r.fromSizeId, -(r._sum.qty ?? 0))
  return (moLineId: string, sizeId: string) => net.get(moLineId)?.get(sizeId) ?? 0
}

/**
 * Every size change on an order (or one line of it), newest first, as one
 * entry per save: where, who, when, why, and each bundle's pieces from one
 * size to the other — with the undo, when it was taken back.
 */
export async function sizeChangeHistory(db: Db, where: { moId: string } | { moLineId: string }) {
  const rows = await db.sizeChange.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { toBundle: { bundleNo: 'asc' } }],
    select: {
      id: true,
      eventId: true,
      moLineId: true,
      qty: true,
      reason: true,
      createdAt: true,
      undoneAt: true,
      undoReason: true,
      step: { select: { id: true, name: true } },
      event: { select: { eventDate: true, personName: true } },
      createdBy: { select: { name: true } },
      undoneBy: { select: { name: true } },
      fromBundle: { select: { id: true, code: true, bundleNo: true } },
      toBundle: { select: { id: true, code: true, bundleNo: true } },
      fromSize: { select: { id: true, code: true } },
      toSize: { select: { id: true, code: true } },
    },
  })
  const byEvent = new Map<string, {
    eventId: string
    moLineId: string
    at: Date
    date: Date
    by: string
    personName: string | null
    step: { id: string; name: string }
    reason: string
    undone: { at: Date; by: string | null; reason: string | null } | null
    moves: Array<{ from: { bundleId: string; code: string; bundleNo: number; size: string; sizeId: string }; to: { bundleId: string; code: string; bundleNo: number; size: string; sizeId: string }; qty: number }>
  }>()
  for (const r of rows) {
    const e =
      byEvent.get(r.eventId) ??
      byEvent
        .set(r.eventId, {
          eventId: r.eventId,
          moLineId: r.moLineId,
          at: r.createdAt,
          date: r.event.eventDate,
          by: r.createdBy.name,
          personName: r.event.personName,
          step: r.step,
          reason: r.reason,
          undone: r.undoneAt ? { at: r.undoneAt, by: r.undoneBy?.name ?? null, reason: r.undoReason } : null,
          moves: [],
        })
        .get(r.eventId)!
    e.moves.push({
      from: { bundleId: r.fromBundle.id, code: r.fromBundle.code, bundleNo: r.fromBundle.bundleNo, size: r.fromSize.code, sizeId: r.fromSize.id },
      to: { bundleId: r.toBundle.id, code: r.toBundle.code, bundleNo: r.toBundle.bundleNo, size: r.toSize.code, sizeId: r.toSize.id },
      qty: r.qty,
    })
  }
  return [...byEvent.values()]
}

/**
 * An order's sizes line by line: planned, moved by size changes, revised, and
 * packed into finished goods so far (first quality and B-grade, receipts not
 * cancelled) — with what is still to pack of each. The revised count is what
 * the floor is making; finished goods follow it.
 */
export async function orderSizes(db: Db, moId: string) {
  const [lines, changed, receipts] = await Promise.all([
    db.mOLine.findMany({
      where: { moId },
      select: {
        id: true,
        color: true,
        totalQty: true,
        styleId: true,
        style: { select: { code: true } },
        soLine: { select: { itemId: true } },
        sizes: { select: { sizeId: true, qty: true, size: { select: { code: true, sequence: true } } } },
      },
    }),
    netSizeChanges(db, { moId }),
    // Packed off the floor by this line, size by size (first quality and B-grade), packings not undone.
    db.wipEntry.groupBy({
      by: ['moLineId', 'sizeId'],
      where: { moId, eventType: 'PACK', event: { reversedAt: null }, bucket: { in: ['PACKED', 'PACKED_B'] } },
      _sum: { qty: true },
    }),
  ])
  const packedOf = new Map(receipts.map((r) => [`${r.moLineId}|${r.sizeId ?? ''}`, r._sum.qty ?? 0]))
  return lines.map((l) => {
    const sizes = [...l.sizes]
      .sort((a, b) => a.size.sequence - b.size.sequence)
      .map((z) => {
        const moved = changed(l.id, z.sizeId)
        const revised = Math.max(0, z.qty + moved)
        const packed = packedOf.get(`${l.id}|${z.sizeId}`) ?? 0
        return { sizeId: z.sizeId, code: z.size.code, planned: z.qty, changed: moved, revised, packed, toPack: Math.max(0, revised - packed) }
      })
    return { moLineId: l.id, style: l.style.code, color: l.color, totalQty: l.totalQty, itemId: l.soLine?.itemId ?? null, sizes }
  })
}
