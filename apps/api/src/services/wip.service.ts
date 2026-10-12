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

/** Moves to the same place are one move. */
function merge(moves: Move[]): Move[] {
  const out = new Map<string, Move>()
  for (const m of moves) {
    const k = keyOf(m)
    const had = out.get(k)
    if (had) had.qty += m.qty
    else out.set(k, { ...m, vendorId: m.vendorId ?? null, reworkStepId: m.reworkStepId ?? null })
  }
  return [...out.values()].filter((m) => m.qty !== 0)
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
  // an undo takes back what a cutting made.
  if (e.type === 'CUT') {
    if (moves.some((m) => m.qty < 0)) throw new AppError('A cutting only adds pieces.', 500, 'UNBALANCED')
  } else if (e.type === 'SPLIT') {
    if (moves.reduce((s, m) => s + m.qty, 0) !== 0) throw new AppError('A split must keep every piece.', 500, 'UNBALANCED')
  } else if (e.type !== 'REVERSAL') {
    const net = new Map<string, number>()
    for (const m of moves) net.set(m.bundleId, (net.get(m.bundleId) ?? 0) + m.qty)
    if ([...net.values()].some((q) => q !== 0)) throw new AppError('That entry does not add up: pieces would appear or vanish.', 500, 'UNBALANCED')
  }

  const bundleIds = [...new Set(moves.map((m) => m.bundleId))]
  const bundles = await tx.productionBundle.findMany({
    where: { id: { in: bundleIds } },
    select: { id: true, code: true, moId: true, moLineId: true, sizeId: true },
  })
  const bundleById = new Map(bundles.map((b) => [b.id, b]))
  for (const id of bundleIds) {
    if (bundleById.get(id)?.moId !== e.moId) throw new AppError('One of those bundles is not on this order.', 400, 'BAD_BUNDLE')
  }

  const outs = moves.filter((m) => m.qty < 0)
  if (outs.length) {
    const have = new Map((await balancesOf(tx, e.moId)).map((r) => [keyOf(r), r.qty]))
    for (const m of outs) {
      const held = have.get(keyOf(m)) ?? 0
      if (held + m.qty >= 0) continue
      const [step, vendor] = await Promise.all([
        tx.mOStep.findUnique({ where: { id: m.stepId }, select: { name: true } }),
        m.vendorId ? tx.supplier.findUnique({ where: { id: m.vendorId }, select: { name: true } }) : null,
      ])
      const detail = `${bundleById.get(m.bundleId)!.code}: ${held} ${PLACE[m.bucket]} ${step?.name ?? 'that step'}${vendor ? ` (${vendor.name})` : ''}`
      throw new AppError(e.shortMessage ? e.shortMessage(detail) : `${detail}, so ${-m.qty} is more than there is.`, 409, 'NOT_ENOUGH_PIECES')
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
        create: moves.map((m) => {
          const b = bundleById.get(m.bundleId)!
          return {
            eventType: e.type,
            moId: e.moId,
            stepId: m.stepId,
            bundleId: m.bundleId,
            moLineId: b.moLineId,
            sizeId: b.sizeId,
            vendorId: m.vendorId ?? null,
            bucket: m.bucket,
            qty: m.qty,
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
    moves: full.entries.map((x) => ({ stepId: x.stepId, bundleId: x.bundleId, bucket: x.bucket, qty: -x.qty, vendorId: x.vendorId, reworkStepId: x.reworkStepId })),
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
