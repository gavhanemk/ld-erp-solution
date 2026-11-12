import type { Prisma, WipBucket, WipEventType } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * The production ledger: where the pieces of every bundle are, step by step.
 *
 * Each entry moves pieces of one bundle into (+) or out of (−) one place —
 * a bucket at a step, and the outside unit holding them when there is one.
 * The entries of an event add up to nothing, except a cutting's, which makes
 * the pieces. So nothing here is ever typed as a balance: a balance is the
 * sum of what moved, and an event that would take more out of a place than is
 * in it is refused before anything is written.
 *
 * Every write locks the order first, so two people saving at once on the same
 * order are taken one after the other and both see the true balance.
 */

type Db = Prisma.TransactionClient

export interface Move {
  stepId: string
  bundleId: string
  bucket: WipBucket
  /** Pieces: + into the place, − out of it. */
  qty: number
  vendorId?: string | null
  reworkStepId?: string | null
  /**
   * The pieces' size, when it is said rather than worked out: a size change
   * (out of the cut size, into the new one) and the undoing of an entry. Left
   * out, a bundle's pieces are its own size — or, in a bundle holding two
   * sizes since a size change, shared over the sizes it has at that place.
   */
  sizeId?: string | null
}

export interface BalanceRow {
  stepId: string
  vendorId: string | null
  bucket: WipBucket
  bundleId: string
  reworkStepId: string | null
  qty: number
}

export const keyOf = (k: { stepId: string; vendorId?: string | null; bucket: WipBucket; bundleId: string; reworkStepId?: string | null }) =>
  `${k.stepId}|${k.vendorId ?? ''}|${k.bucket}|${k.bundleId}|${k.reworkStepId ?? ''}`

/** How a bucket reads in a sentence: "12 done at Stitching". */
export const PLACE: Record<WipBucket, string> = {
  TRANSIT: 'on the way to',
  WIP: 'in hand at',
  DONE: 'done at',
  REWORK: 'in rework at',
  DAMAGED: 'damaged at',
  REJECTED: 'rejected at',
  SHORT: 'short at',
  B_GRADE: 'set aside as B-grade at',
  SCRAPPED: 'written off at',
  PACKED: 'packed from',
  PACKED_B: 'packed as B-grade from',
}

/** Where the pieces stop: nothing moves out of these again. */
export const TERMINAL: WipBucket[] = ['SCRAPPED', 'PACKED', 'PACKED_B']

/** Takes the order's lock for the rest of the transaction. */
export async function lockMo(tx: Db, moId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM ld_erp.manufacturing_orders WHERE id = ${moId} FOR UPDATE`
  if (!rows.length) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
}

/** Every place on the order — or on one line of it — that holds pieces, with how many. */
export async function balancesOf(tx: Db, moId: string, moLineId?: string): Promise<BalanceRow[]> {
  const rows = await tx.wipEntry.groupBy({
    by: ['stepId', 'vendorId', 'bucket', 'bundleId', 'reworkStepId'],
    where: { moId, ...(moLineId ? { moLineId } : {}) },
    _sum: { qty: true },
  })
  return rows
    .map((r) => ({ stepId: r.stepId, vendorId: r.vendorId, bucket: r.bucket, bundleId: r.bundleId, reworkStepId: r.reworkStepId, qty: r._sum.qty ?? 0 }))
    .filter((r) => r.qty !== 0)
}

/** Moves to the same place (and, where it is said, of the same size) are one move. */
function merge(moves: Move[]): Move[] {
  const out = new Map<string, Move>()
  for (const m of moves) {
    const k = `${keyOf(m)}|${m.sizeId ?? ''}`
    const had = out.get(k)
    if (had) had.qty += m.qty
    else out.set(k, { ...m, vendorId: m.vendorId ?? null, reworkStepId: m.reworkStepId ?? null })
  }
  return [...out.values()].filter((m) => m.qty !== 0)
}

/** Pieces of the given bundles at each place, size by size: keyOf(place) → size → pieces. */
export async function sizeBalancesOf(tx: Db, bundleIds: string[]) {
  const rows = bundleIds.length
    ? await tx.wipEntry.groupBy({
        by: ['stepId', 'vendorId', 'bucket', 'bundleId', 'reworkStepId', 'sizeId'],
        where: { bundleId: { in: bundleIds } },
        _sum: { qty: true },
      })
    : []
  const out = new Map<string, Map<string | null, number>>()
  for (const r of rows) {
    const q = r._sum.qty ?? 0
    if (!q) continue
    const k = keyOf(r)
    const at = out.get(k) ?? new Map<string | null, number>()
    at.set(r.sizeId, (at.get(r.sizeId) ?? 0) + q)
    out.set(k, at)
  }
  return out
}

/**
 * `qty` pieces shared over the sizes in `have`, in proportion to what each
 * holds and never past it (the largest remainders take the odd pieces): which
 * sizes go when part of a bundle holding two sizes moves on.
 */
export function shareOut(qty: number, have: Array<[string | null, number]>): Array<[string | null, number]> {
  const pool = have.filter(([, n]) => n > 0)
  const total = pool.reduce((s, [, n]) => s + n, 0)
  const take = Math.min(qty, total)
  if (take <= 0) return []
  const parts = pool.map(([size, n]) => {
    const exact = (take * n) / total
    return { size, n, q: Math.min(n, Math.floor(exact)), rest: exact - Math.floor(exact) }
  })
  let left = take - parts.reduce((s, p) => s + p.q, 0)
  for (const p of [...parts].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break
    if (p.q < p.n) {
      p.q += 1
      left -= 1
    }
  }
  for (const p of parts) {
    while (left > 0 && p.q < p.n) {
      p.q += 1
      left -= 1
    }
  }
  return parts.filter((p) => p.q > 0).map((p) => [p.size, p.q])
}

export interface EventInput {
  moId: string
  type: WipEventType
  stepId?: string | null
  eventDate?: Date
  personName?: string | null
  vendorId?: string | null
  transferId?: string | null
  jobWorkOrderId?: string | null
  cuttingOrderId?: string | null
  fgReceiptId?: string | null
  reworkStepId?: string | null
  reason?: string | null
  notes?: string | null
  theirChallanNo?: string | null
  chargeQty?: number | null
  chargeRate?: number | null
  billNo?: string | null
  billDate?: Date | null
  reversalOfId?: string | null
  clientKey?: string | null
  createdById: string
  moves: Move[]
  /** Said instead of the usual "more than there is" when a move cannot be made. */
  shortMessage?: (detail: string) => string
}

/**
 * Writes one event and its entries, inside the caller's transaction and after
 * the caller has taken the order's lock. Refuses, before writing anything,
 * any move that would take out of a place more pieces than it holds.
 */
export async function postEvent(tx: Db, e: EventInput) {
  const moves = merge(e.moves)
  if (!moves.length) throw new AppError('Nothing to record: every quantity is nought.', 400, 'NOTHING_TO_RECORD')
  for (const m of moves) {
    if (!Number.isInteger(m.qty)) throw new AppError('Pieces are whole numbers.', 400, 'NOT_WHOLE')
  }
  // Pieces move, they do not appear: every bundle's moves net to nothing,
  // except where a cutting makes them, a split hands them to a new bundle, or
  // an undo takes back what a cutting made. A size change (12 Nov 2026) moves
  // no piece at all: in its own bundle and where they lie, pieces go out of
  // the size they were cut in and into the one they are made as.
  const splits = e.type === 'SPLIT'
  if (e.type === 'CUT') {
    if (moves.some((m) => m.qty < 0)) throw new AppError('A cutting only adds pieces.', 500, 'UNBALANCED')
  } else if (e.type === 'SIZE_CHANGE') {
    if (moves.some((m) => !m.sizeId)) throw new AppError('A size change says the size of every piece it moves.', 500, 'UNBALANCED')
    const place = new Map<string, number>()
    for (const m of moves) place.set(keyOf(m), (place.get(keyOf(m)) ?? 0) + m.qty)
    if ([...place.values()].some((q) => q !== 0)) throw new AppError('A size change keeps every piece in its bundle and where it is.', 500, 'UNBALANCED')
  } else if (splits) {
    // A split hands pieces over where they lie: every place keeps its count.
    const place = new Map<string, number>()
    for (const m of moves) {
      const k = `${m.stepId}|${m.vendorId ?? ''}|${m.bucket}|${m.reworkStepId ?? ''}`
      place.set(k, (place.get(k) ?? 0) + m.qty)
    }
    if ([...place.values()].some((q) => q !== 0)) throw new AppError('A split must keep every piece where it is.', 500, 'UNBALANCED')
  } else if (e.type !== 'REVERSAL') {
    const net = new Map<string, number>()
    for (const m of moves) net.set(m.bundleId, (net.get(m.bundleId) ?? 0) + m.qty)
    if ([...net.values()].some((q) => q !== 0)) throw new AppError('That entry does not add up: pieces would appear or vanish.', 500, 'UNBALANCED')
  }

  const bundleIds = [...new Set(moves.map((m) => m.bundleId))]
  const bundles = await tx.productionBundle.findMany({
    where: { id: { in: bundleIds } },
    select: { id: true, code: true, moId: true, moLineId: true, sizeId: true, parentId: true },
  })
  const bundleById = new Map(bundles.map((b) => [b.id, b]))
  for (const id of bundleIds) {
    if (bundleById.get(id)?.moId !== e.moId) throw new AppError('One of those bundles is not on this order.', 400, 'BAD_BUNDLE')
  }
  if (splits) {
    // Pieces go only to new bundles made from the ones giving them, on the
    // same colour line.
    if (new Set(bundles.map((b) => b.moLineId)).size > 1) throw new AppError('A split stays on one colour line.', 500, 'UNBALANCED')
    const giving = new Set(moves.filter((m) => m.qty < 0).map((m) => m.bundleId))
    const taking = [...new Set(moves.filter((m) => m.qty > 0).map((m) => m.bundleId))]
    for (const id of taking) {
      const b = bundleById.get(id)!
      if (giving.has(id) || !b.parentId || !giving.has(b.parentId)) throw new AppError('A split hands pieces only to a new bundle made from the one giving them.', 500, 'UNBALANCED')
    }
    if (await tx.wipEntry.count({ where: { bundleId: { in: taking } } })) throw new AppError('A split hands pieces only to a new bundle.', 500, 'UNBALANCED')
  }

  // Bundles that hold, or held, two sizes since a size change: their pieces are counted size by size.
  const mixed = new Set(
    (await tx.sizeChange.findMany({ where: { fromBundleId: { in: bundleIds }, toBundleId: null }, select: { fromBundleId: true } })).map((c) => c.fromBundleId),
  )
  const bySize = mixed.size || moves.some((m) => m.sizeId) ? await sizeBalancesOf(tx, bundleIds) : new Map<string, Map<string | null, number>>()

  const outs = moves.filter((m) => m.qty < 0)
  if (outs.length) {
    const have = new Map((await balancesOf(tx, e.moId)).map((r) => [keyOf(r), r.qty]))
    const sayShort = async (m: Move, held: number) => {
      const [step, vendor] = await Promise.all([
        tx.mOStep.findUnique({ where: { id: m.stepId }, select: { name: true } }),
        m.vendorId ? tx.supplier.findUnique({ where: { id: m.vendorId }, select: { name: true } }) : null,
      ])
      const detail = `${bundleById.get(m.bundleId)!.code}: ${held} ${PLACE[m.bucket]} ${step?.name ?? 'that step'}${vendor ? ` (${vendor.name})` : ''}`
      return new AppError(e.shortMessage ? e.shortMessage(detail) : `${detail}, so ${-m.qty} is more than there is.`, 409, 'NOT_ENOUGH_PIECES')
    }
    for (const m of outs) {
      const held = have.get(keyOf(m)) ?? 0
      if (held + m.qty < 0) throw await sayShort(m, held)
    }
    // Where a move says its size, that size must hold the pieces: a size change takes only pieces
    // still in the size they were cut in, and an undo only what is still where the entry put it.
    const sized = new Map<string, number>()
    for (const m of outs.filter((x) => x.sizeId)) {
      const k = `${keyOf(m)}|${m.sizeId}`
      sized.set(k, (sized.get(k) ?? 0) - m.qty)
      const heldOfSize = bySize.get(keyOf(m))?.get(m.sizeId!) ?? 0
      if (heldOfSize < sized.get(k)!) throw await sayShort(m, heldOfSize)
    }
  }

  // Each move's pieces, size by size. A bundle of one size: its own. A bundle holding two sizes:
  // what leaves a place is shared over the sizes there, and what arrives takes the sizes that left.
  const parts: Array<{ m: Move; sizeId: string | null; qty: number }> = []
  for (const id of bundleIds) {
    const b = bundleById.get(id)!
    const mine = moves.filter((m) => m.bundleId === id)
    if (!mixed.has(id)) {
      for (const m of mine) parts.push({ m, sizeId: m.sizeId ?? b.sizeId, qty: m.qty })
      continue
    }
    const left = new Map<string, Map<string | null, number>>()
    const at = (m: Move) => left.get(keyOf(m)) ?? new Map(bySize.get(keyOf(m)) ?? [])
    const pool = new Map<string | null, number>()
    for (const m of mine.filter((x) => x.qty < 0)) {
      const here = at(m)
      const shares: Array<[string | null, number]> = m.sizeId ? [[m.sizeId, -m.qty]] : shareOut(-m.qty, [...here.entries()])
      const given = shares.reduce((s, [, q]) => s + q, 0)
      if (given < -m.qty) shares.push([b.sizeId, -m.qty - given])
      for (const [size, q] of shares) {
        parts.push({ m, sizeId: size, qty: -q })
        pool.set(size, (pool.get(size) ?? 0) + q)
        here.set(size, (here.get(size) ?? 0) - q)
      }
      left.set(keyOf(m), here)
    }
    for (const m of mine.filter((x) => x.qty > 0)) {
      if (m.sizeId) {
        parts.push({ m, sizeId: m.sizeId, qty: m.qty })
        continue
      }
      const shares = shareOut(m.qty, [...pool.entries()])
      const got = shares.reduce((s, [, q]) => s + q, 0)
      if (got < m.qty) shares.push([b.sizeId, m.qty - got])
      for (const [size, q] of shares) {
        parts.push({ m, sizeId: size, qty: q })
        pool.set(size, (pool.get(size) ?? 0) - q)
      }
    }
  }

  return tx.wipEvent.create({
    data: {
      moId: e.moId,
      type: e.type,
      stepId: e.stepId ?? null,
      eventDate: e.eventDate ?? new Date(),
      personName: e.personName ?? null,
      vendorId: e.vendorId ?? null,
      transferId: e.transferId ?? null,
      jobWorkOrderId: e.jobWorkOrderId ?? null,
      cuttingOrderId: e.cuttingOrderId ?? null,
      fgReceiptId: e.fgReceiptId ?? null,
      reworkStepId: e.reworkStepId ?? null,
      reason: e.reason ?? null,
      notes: e.notes ?? null,
      theirChallanNo: e.theirChallanNo ?? null,
      chargeQty: e.chargeQty ?? null,
      chargeRate: e.chargeRate ?? null,
      billNo: e.billNo ?? null,
      billDate: e.billDate ?? null,
      reversalOfId: e.reversalOfId ?? null,
      clientKey: e.clientKey ?? null,
      createdById: e.createdById,
      entries: {
        create: parts.map(({ m, sizeId, qty }) => {
          const b = bundleById.get(m.bundleId)!
          return {
            eventType: e.type,
            moId: e.moId,
            stepId: m.stepId,
            bundleId: m.bundleId,
            moLineId: b.moLineId,
            sizeId,
            vendorId: m.vendorId ?? null,
            bucket: m.bucket,
            qty,
            reworkStepId: m.reworkStepId ?? null,
          }
        }),
      },
    },
  })
}

/**
 * Undoes an event by writing its entries turned round — only while the pieces
 * are still where it put them. Inside the caller's transaction; takes the
 * order's lock itself.
 */
export async function reverseEvent(tx: Db, eventId: string, reason: string, userId: string) {
  const ev = await tx.wipEvent.findUnique({ where: { id: eventId }, select: { moId: true } })
  if (!ev) throw new AppError('That entry was not found.', 404, 'NOT_FOUND')
  await lockMo(tx, ev.moId)
  const full = await tx.wipEvent.findUniqueOrThrow({ where: { id: eventId }, include: { entries: true } })
  if (full.reversedAt) throw new AppError('That entry has already been undone.', 409, 'ALREADY_UNDONE')
  if (full.type === 'REVERSAL') throw new AppError('An undo cannot itself be undone; record the work again instead.', 400, 'IS_UNDO')
  const reversal = await postEvent(tx, {
    moId: full.moId,
    type: 'REVERSAL',
    stepId: full.stepId,
    transferId: full.transferId,
    jobWorkOrderId: full.jobWorkOrderId,
    cuttingOrderId: full.cuttingOrderId,
    fgReceiptId: full.fgReceiptId,
    vendorId: full.vendorId,
    reversalOfId: full.id,
    reason,
    createdById: userId,
    // Each entry taken back in its own size, so a bundle holding two sizes gets back exactly what it gave.
    moves: full.entries.map((x) => ({ stepId: x.stepId, bundleId: x.bundleId, bucket: x.bucket, qty: -x.qty, vendorId: x.vendorId, reworkStepId: x.reworkStepId, sizeId: x.sizeId })),
    shortMessage: (detail) => `It cannot be undone: some of those pieces have moved on since (${detail}). Undo what came after it first.`,
  })
  await tx.wipEvent.update({ where: { id: full.id }, data: { reversedAt: new Date() } })
  return { event: full, reversal }
}

/**
 * What came into and went out of each place, by kind of event, leaving out
 * events that were undone (and the undoing). The figures a step shows —
 * received, done, sent on — are read off this.
 */
export async function flowsOf(tx: Db, moId: string, moLineId?: string) {
  const where = { moId, ...(moLineId ? { moLineId } : {}), eventType: { not: 'REVERSAL' as const }, event: { reversedAt: null } }
  const [ins, outs] = await Promise.all([
    tx.wipEntry.groupBy({ by: ['stepId', 'vendorId', 'bucket', 'eventType'], where: { ...where, qty: { gt: 0 } }, _sum: { qty: true } }),
    tx.wipEntry.groupBy({ by: ['stepId', 'vendorId', 'bucket', 'eventType'], where: { ...where, qty: { lt: 0 } }, _sum: { qty: true } }),
  ])
  const shape = (r: (typeof ins)[number]) => ({ stepId: r.stepId, vendorId: r.vendorId, bucket: r.bucket, eventType: r.eventType, qty: Math.abs(r._sum.qty ?? 0) })
  return { ins: ins.map(shape), outs: outs.map(shape) }
}
