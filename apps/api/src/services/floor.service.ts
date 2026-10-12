import type { MOStatus, Prisma, PrismaClient, ProcessKind, StepExecution, WipBucket, WipEventType } from '@prisma/client'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { nextDocumentNumber } from '../lib/docNumber'
import { balancesOf, flowsOf, keyOf, lockMo, postEvent, reverseEvent, type BalanceRow, type Move } from './wip.service'
import { isCheck, isLastStep, nextStepAfter } from './route.service'

/**
 * The floor: what happens to an order's pieces between cutting and packing.
 *
 * A transfer card sends one job card's bundles from one step to the next one
 * on the order's route — never anywhere else — and is printed to go with
 * them. The receiving department counts them in; a shortfall is held as short
 * until somebody settles it, an excess is taken off the sender's count, and
 * neither ever overwrites what the sender wrote.
 *
 * At each step the work is recorded per bundle: done, damaged, rejected, or
 * sent for rework, and damaged or rejected pieces then wait for a decision —
 * rework, B-grade, or write-off. A working step (stitching, finishing) may
 * also send pieces on straight from in hand, as its paper sheet did: in, out,
 * damaged. A check sends on only what it has passed. A step done outside goes
 * to a unit on a job work order, on a job-work challan, and what comes back is
 * counted against it. Packing into finished goods takes only pieces the last
 * step has done.
 *
 * Every function here runs inside the caller's transaction and takes the
 * order's lock before it reads a balance.
 */

type Tx = Prisma.TransactionClient
type Db = PrismaClient | Prisma.TransactionClient

const OPEN_STATUSES: MOStatus[] = ['RELEASED', 'CUTTING', 'STITCHING', 'FINISHING', 'QC', 'PACKING', 'COMPLETED']

const pcs = z.number().int('Pieces are whole numbers').min(0, 'Pieces cannot be less than nothing').max(1_000_000)
const person = z.string().trim().max(120).optional().nullable()
const note = z.string().trim().max(1000).optional().nullable()
const clientKey = z.string().trim().min(8).max(80).optional().nullable()
const reasonText = z.string().trim().min(5, 'Say why, in a few words').max(500)

const stepSelect = {
  id: true,
  sequence: true,
  name: true,
  kind: true,
  isQcStep: true,
  execution: true,
  skippedAt: true,
  skip: true,
  departmentId: true,
  workstationId: true,
  ratePerPiece: true,
} satisfies Prisma.MOStepSelect

/** The order, locked, with its route — refused when nothing may move on it. */
async function openMo(tx: Tx, moId: string) {
  await lockMo(tx, moId)
  const mo = await tx.manufacturingOrder.findUniqueOrThrow({
    where: { id: moId },
    select: {
      id: true,
      moNumber: true,
      status: true,
      heldAt: true,
      holdReason: true,
      soId: true,
      steps: { orderBy: { sequence: 'asc' }, select: stepSelect },
    },
  })
  if (!mo.steps.length) {
    throw new AppError(`${mo.moNumber} has no route, so its pieces are not tracked step by step. Pick a routing for it first.`, 409, 'NO_ROUTE')
  }
  if (!OPEN_STATUSES.includes(mo.status)) {
    throw new AppError(`${mo.moNumber} is ${mo.status === 'DRAFT' ? 'still a draft: release it first' : 'closed'}, so nothing moves on the floor for it.`, 409, 'NOT_OPEN')
  }
  if (mo.heldAt) throw new AppError(`${mo.moNumber} is on hold${mo.holdReason ? ` (${mo.holdReason})` : ''}. Resume it before recording anything.`, 409, 'ON_HOLD')
  return mo
}

type OpenMo = Awaited<ReturnType<typeof openMo>>
const stepOf = (mo: OpenMo, stepId: string) => {
  const s = mo.steps.find((x) => x.id === stepId)
  if (!s) throw new AppError('That step is not on this order’s route.', 404, 'NOT_FOUND')
  return s
}

/** The same save sent twice is recognised by its key and stored once. */
async function seen(tx: Tx, key: string | null | undefined) {
  if (!key) return false
  const [ev, tr] = await Promise.all([tx.wipEvent.findUnique({ where: { clientKey: key }, select: { id: true } }), tx.processTransfer.findUnique({ where: { clientKey: key }, select: { id: true } })])
  return !!(ev || tr)
}

/** Lines naming the same bundle twice are one line. */
function byBundle<T extends { bundleId: string }>(lines: T[], add: (a: T, b: T) => T) {
  const out = new Map<string, T>()
  for (const l of lines) out.set(l.bundleId, out.has(l.bundleId) ? add(out.get(l.bundleId)!, l) : { ...l })
  return [...out.values()]
}

// ─── Transfer cards ───────────────────────────────────────────

export const dispatchSchema = z.object({
  fromStepId: z.string().min(1, 'Say which step it leaves'),
  /** Defaults to the next step on the route, which is the only one allowed. */
  toStepId: z.string().optional().nullable(),
  /** The outside unit, when the next step is done outside. */
  vendorId: z.string().optional().nullable(),
  /** Per piece, for a unit given this step for the first time on this order. */
  rate: z.number().min(0).max(100_000).optional().nullable(),
  expectedBy: z.coerce.date().optional().nullable(),
  lines: z.array(z.object({ bundleId: z.string().min(1), qty: pcs })).min(1, 'Pick the bundles going'),
  issuedBy: person,
  vehicleNo: z.string().trim().max(30).optional().nullable(),
  notes: note,
  dispatchDate: z.coerce.date().optional(),
  clientKey,
})

/** A working step on our own floor sends pieces on straight from in hand; a check, cutting or a unit only what it has done. */
export const sendsFromHand = (s: { kind: ProcessKind; isQcStep: boolean; execution: StepExecution }) => s.kind !== 'CUTTING' && !isCheck(s) && s.execution === 'IN_HOUSE'

/** Sends bundles on from a step to the next one on the route. */
export async function dispatch(tx: Tx, moId: string, d: z.infer<typeof dispatchSchema>, userId: string) {
  const mo = await openMo(tx, moId)
  if (await seen(tx, d.clientKey)) {
    const dup = await tx.processTransfer.findUniqueOrThrow({ where: { clientKey: d.clientKey! } })
    return { transfer: dup, duplicate: true }
  }
  const from = stepOf(mo, d.fromStepId)
  const next = nextStepAfter(mo.steps, from.id)
  if (!next) throw new AppError(`${from.name} is the last step: its pieces go to Finished Goods In, not to another step.`, 409, 'LAST_STEP')
  if (d.toStepId && d.toStepId !== next.id) {
    const to = stepOf(mo, d.toStepId)
    throw new AppError(`Pieces done at ${from.name} go next to ${next.name}, not ${to.name}. To change that, change the order's route.`, 409, 'NOT_NEXT_STEP')
  }
  const to = next
  const lines = byBundle(
    d.lines.filter((l) => l.qty > 0),
    (a, b) => ({ ...a, qty: a.qty + b.qty }),
  )
  if (!lines.length) throw new AppError('Enter how many pieces of each bundle are going.', 400, 'NOTHING_SENT')

  const vendorId = d.vendorId || null
  if (to.execution === 'OUTSOURCED' && !vendorId) throw new AppError(`${to.name} is done outside: say which unit the pieces go to.`, 400, 'NO_VENDOR')
  let jobWorkOrderId: string | null = null
  if (vendorId) {
    const vendor = await tx.supplier.findUnique({ where: { id: vendorId }, select: { name: true, isActive: true } })
    if (!vendor?.isActive) throw new AppError('That unit is not an active supplier.', 400, 'BAD_VENDOR')
    jobWorkOrderId = (await jobWorkOrderFor(tx, mo, to, vendorId, d.rate ?? null, d.expectedBy ?? null, userId)).id
  }

  const bundles = await tx.productionBundle.findMany({ where: { id: { in: lines.map((l) => l.bundleId) }, moId }, select: { id: true, code: true, sizeId: true, moLineId: true } })
  if (bundles.length !== lines.length) throw new AppError('One of those bundles is not on this order.', 400, 'BAD_BUNDLE')
  const sizeOf = new Map(bundles.map((b) => [b.id, b.sizeId]))
  const codeOf = new Map(bundles.map((b) => [b.id, b.code]))
  if (new Set(bundles.map((b) => b.moLineId)).size > 1) throw new AppError('A transfer carries one job card’s bundles: send each colour on its own transfer.', 400, 'ONE_JOB_CARD')
  const jobCard = await tx.jobCard.findUnique({ where: { moLineId: bundles[0].moLineId }, select: { id: true } })

  // Done pieces go first; at a working step, pieces in hand after them.
  const held = await balancesOf(tx, moId)
  const has = (bundleId: string, bucket: WipBucket) => held.filter((r) => r.stepId === from.id && r.bundleId === bundleId && r.bucket === bucket && !r.vendorId).reduce((t, r) => t + r.qty, 0)
  const fromHand = sendsFromHand(from)
  const takes = lines.map((l) => {
    const done = Math.min(l.qty, has(l.bundleId, 'DONE'))
    const hand = fromHand ? Math.min(l.qty - done, has(l.bundleId, 'WIP')) : 0
    if (done + hand < l.qty) {
      const there = has(l.bundleId, 'DONE') + (fromHand ? has(l.bundleId, 'WIP') : 0)
      throw new AppError(`${codeOf.get(l.bundleId)}: ${there} ${fromHand ? 'at' : isCheck(from) ? 'passed at' : 'done at'} ${from.name}, so ${l.qty} is more than there is.`, 409, 'NOT_ENOUGH_PIECES')
    }
    return { ...l, done, hand }
  })

  const when = d.dispatchDate ?? new Date()
  const transferNumber = vendorId
    ? await nextDocumentNumber(tx, 'JW', when)
    : `${mo.moNumber}-T${(await tx.processTransfer.count({ where: { moId, vendorId: null } })) + 1}`
  const transfer = await tx.processTransfer.create({
    data: {
      transferNumber,
      moId,
      fromStepId: from.id,
      toStepId: to.id,
      vendorId,
      jobWorkOrderId,
      jobCardId: jobCard?.id ?? null,
      dispatchDate: when,
      issuedBy: d.issuedBy ?? null,
      vehicleNo: d.vehicleNo ?? null,
      notes: d.notes ?? null,
      createdById: userId,
      clientKey: d.clientKey ?? null,
      lines: { create: lines.map((l) => ({ bundleId: l.bundleId, sizeId: sizeOf.get(l.bundleId) ?? null, dispatchedQty: l.qty })) },
    },
  })
  await postEvent(tx, {
    moId,
    type: 'DISPATCH',
    stepId: to.id,
    transferId: transfer.id,
    vendorId,
    jobWorkOrderId,
    eventDate: when,
    personName: d.issuedBy,
    createdById: userId,
    moves: takes.flatMap((l): Move[] => [
      { stepId: from.id, bundleId: l.bundleId, bucket: 'DONE', qty: -l.done },
      { stepId: from.id, bundleId: l.bundleId, bucket: 'WIP', qty: -l.hand },
      // An outside unit does not count in on our system: the pieces are in
      // its hands from the challan.
      vendorId ? { stepId: to.id, bundleId: l.bundleId, bucket: 'WIP', qty: l.qty, vendorId } : { stepId: to.id, bundleId: l.bundleId, bucket: 'TRANSIT', qty: l.qty },
    ]),
  })
  await syncProgress(tx, moId)
  return { transfer, duplicate: false }
}

/** The open job work order for this step and unit, made the first time pieces go to it. */
async function jobWorkOrderFor(tx: Tx, mo: OpenMo, step: OpenMo['steps'][number], vendorId: string, rate: number | null, expectedBy: Date | null, userId: string) {
  const open = await tx.jobWorkOrder.findFirst({ where: { moId: mo.id, stepId: step.id, vendorId, status: 'OPEN' } })
  if (open) return open
  const [count, unit] = await Promise.all([
    tx.jobWorkOrder.count({ where: { moId: mo.id } }),
    step.workstationId ? tx.workstation.findUnique({ where: { id: step.workstationId }, select: { id: true, supplierId: true } }) : null,
  ])
  return tx.jobWorkOrder.create({
    data: {
      orderNumber: `${mo.moNumber}-JW${count + 1}`,
      moId: mo.id,
      stepId: step.id,
      vendorId,
      workstationId: unit?.supplierId === vendorId ? unit.id : null,
      rate: rate ?? Number(step.ratePerPiece ?? 0),
      expectedBy,
      createdById: userId,
    },
  })
}

export const receiveSchema = z.object({
  lines: z.array(z.object({ lineId: z.string().min(1), qty: pcs })).default([]),
  /** Nothing more is coming: whatever has not been counted in is short. */
  close: z.boolean().default(false),
  receivedBy: person,
  receivedAt: z.coerce.date().optional(),
  notes: note,
  clientKey,
})

/**
 * Counts a transfer in at the receiving desk. Up to what was sent comes off
 * the way; more than that is taken off the sender's count as excess. Closing
 * declares the rest short.
 */
export async function receive(tx: Tx, transferId: string, d: z.infer<typeof receiveSchema>, userId: string) {
  const head = await tx.processTransfer.findUnique({ where: { id: transferId }, select: { moId: true } })
  if (!head) throw new AppError('Transfer not found', 404, 'NOT_FOUND')
  const mo = await openMo(tx, head.moId)
  if (await seen(tx, d.clientKey)) return { transfer: await tx.processTransfer.findUniqueOrThrow({ where: { id: transferId } }), duplicate: true }
  const t = await tx.processTransfer.findUniqueOrThrow({ where: { id: transferId }, include: { lines: true } })
  if (t.vendorId) throw new AppError(`${t.transferNumber} went to an outside unit: record what comes back on its job work order.`, 409, 'AT_VENDOR')
  if (t.status === 'CANCELLED') throw new AppError(`${t.transferNumber} was cancelled.`, 409, 'CANCELLED')
  if (t.status === 'RECEIVED' || t.status === 'DISCREPANCY') throw new AppError(`${t.transferNumber} has already been counted in.`, 409, 'ALREADY_RECEIVED')

  const lineById = new Map(t.lines.map((l) => [l.id, l]))
  const counted = new Map<string, number>()
  for (const l of d.lines) {
    if (!lineById.has(l.lineId)) throw new AppError(`That bundle is not on ${t.transferNumber}.`, 400, 'BAD_LINE')
    if (l.qty > 0) counted.set(l.lineId, (counted.get(l.lineId) ?? 0) + l.qty)
  }
  if (!counted.size && !d.close) throw new AppError('Enter what was counted in, or close it as short.', 400, 'NOTHING_COUNTED')

  const inMoves: Move[] = []
  const excessMoves: Move[] = []
  const shortMoves: Move[] = []
  const change = new Map<string, { received: number; excess: number; short: number }>()
  const sender = stepOf(mo, t.fromStepId)
  const held = await balancesOf(tx, mo.id)
  const senderDone = (bundleId: string) => held.filter((r) => r.stepId === t.fromStepId && r.bundleId === bundleId && r.bucket === 'DONE' && !r.vendorId).reduce((s, r) => s + r.qty, 0)
  for (const line of t.lines) {
    const pending = line.dispatchedQty + line.excessQty - line.receivedQty - line.shortQty
    const qty = counted.get(line.id) ?? 0
    const off = Math.min(qty, Math.max(0, pending))
    const excess = qty - off
    const c = { received: qty, excess, short: 0 }
    if (off) inMoves.push({ stepId: t.toStepId, bundleId: line.bundleId, bucket: 'TRANSIT', qty: -off }, { stepId: t.toStepId, bundleId: line.bundleId, bucket: 'WIP', qty: off })
    if (excess) {
      // The sender's miscount: off what it has done, then — at a working
      // step — off what it has in hand.
      const done = sendsFromHand(sender) ? Math.min(excess, Math.max(0, senderDone(line.bundleId))) : excess
      excessMoves.push(
        { stepId: t.fromStepId, bundleId: line.bundleId, bucket: 'DONE', qty: -done },
        { stepId: t.fromStepId, bundleId: line.bundleId, bucket: 'WIP', qty: -(excess - done) },
        { stepId: t.toStepId, bundleId: line.bundleId, bucket: 'WIP', qty: excess },
      )
    }
    const left = pending - off
    if (d.close && left > 0) {
      c.short = left
      shortMoves.push({ stepId: t.toStepId, bundleId: line.bundleId, bucket: 'TRANSIT', qty: -left }, { stepId: t.toStepId, bundleId: line.bundleId, bucket: 'SHORT', qty: left })
    }
    if (c.received || c.short) change.set(line.id, c)
  }

  const when = d.receivedAt ?? new Date()
  const common = { moId: mo.id, stepId: t.toStepId, transferId: t.id, eventDate: when, personName: d.receivedBy, notes: d.notes, createdById: userId }
  let key = d.clientKey ?? null
  const once = () => {
    const k = key
    key = null
    return k
  }
  const fromName = sender.name
  if (inMoves.length) await postEvent(tx, { ...common, type: 'RECEIVE', clientKey: once(), moves: inMoves })
  if (excessMoves.length) {
    await postEvent(tx, {
      ...common,
      type: 'EXCESS',
      clientKey: once(),
      moves: excessMoves,
      shortMessage: (detail) => `More was counted in than ${t.transferNumber} sent, and ${fromName} has no more of it done to account for the extra (${detail}). Count again.`,
    })
  }
  if (shortMoves.length) await postEvent(tx, { ...common, type: 'SHORT', clientKey: once(), moves: shortMoves, reason: 'Closed short at the count' })

  for (const [id, c] of change) {
    await tx.processTransferLine.update({
      where: { id },
      data: { receivedQty: { increment: c.received }, excessQty: { increment: c.excess }, shortQty: { increment: c.short } },
    })
  }
  const after = await tx.processTransferLine.findMany({ where: { transferId: t.id } })
  const allIn = after.every((l) => l.dispatchedQty + l.excessQty - l.receivedQty - l.shortQty <= 0)
  const open = after.some((l) => l.shortQty > l.settledQty)
  const transfer = await tx.processTransfer.update({
    where: { id: t.id },
    data: {
      status: allIn ? (open ? 'DISCREPANCY' : 'RECEIVED') : 'PARTLY_RECEIVED',
      receivedBy: d.receivedBy ?? t.receivedBy,
      receivedAt: when,
    },
  })
  await syncProgress(tx, mo.id)
  return { transfer, duplicate: false }
}

export const settleSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1),
        qty: pcs,
        /** FOUND: turned up after all. NOT_SENT: never left the sender. LOST: written off. */
        outcome: z.enum(['FOUND', 'NOT_SENT', 'LOST']),
      }),
    )
    .min(1),
  reason: reasonText,
  clientKey,
})

/** Settles pieces held short on a transfer. Writing them off needs a production manager. */
export async function settleShort(tx: Tx, transferId: string, d: z.infer<typeof settleSchema>, by: { userId: string; mayApprove: boolean }) {
  const head = await tx.processTransfer.findUnique({ where: { id: transferId }, select: { moId: true } })
  if (!head) throw new AppError('Transfer not found', 404, 'NOT_FOUND')
  const mo = await openMo(tx, head.moId)
  if (await seen(tx, d.clientKey)) return { transfer: await tx.processTransfer.findUniqueOrThrow({ where: { id: transferId } }), duplicate: true }
  const t = await tx.processTransfer.findUniqueOrThrow({ where: { id: transferId }, include: { lines: { include: { bundle: { select: { code: true } } } } } })
  const lineById = new Map(t.lines.map((l) => [l.id, l]))
  const moves: Move[] = []
  const settled = new Map<string, number>()
  for (const s of d.lines) {
    if (s.qty <= 0) continue
    const line = lineById.get(s.lineId)
    if (!line) throw new AppError(`That bundle is not on ${t.transferNumber}.`, 400, 'BAD_LINE')
    const open = line.shortQty - line.settledQty - (settled.get(line.id) ?? 0)
    if (s.qty > open) throw new AppError(`${line.bundle.code}: ${open} short to settle, so ${s.qty} is too many.`, 400, 'MORE_THAN_SHORT')
    if (s.outcome === 'LOST' && !by.mayApprove) throw new AppError('Writing pieces off needs a production manager.', 403, 'NEEDS_APPROVAL')
    moves.push({ stepId: t.toStepId, bundleId: line.bundleId, bucket: 'SHORT', qty: -s.qty })
    if (s.outcome === 'FOUND') moves.push({ stepId: t.toStepId, bundleId: line.bundleId, bucket: 'WIP', qty: s.qty })
    else if (s.outcome === 'NOT_SENT') moves.push({ stepId: t.fromStepId, bundleId: line.bundleId, bucket: 'DONE', qty: s.qty })
    else moves.push({ stepId: t.toStepId, bundleId: line.bundleId, bucket: 'SCRAPPED', qty: s.qty })
    settled.set(line.id, (settled.get(line.id) ?? 0) + s.qty)
  }
  if (!moves.length) throw new AppError('Enter how many pieces are being settled.', 400, 'NOTHING_SETTLED')
  const outcomes = [...new Set(d.lines.filter((l) => l.qty > 0).map((l) => l.outcome))]
  await postEvent(tx, {
    moId: mo.id,
    type: 'SETTLE',
    stepId: t.toStepId,
    transferId: t.id,
    reason: `${outcomes.map((o) => ({ FOUND: 'found', NOT_SENT: 'never sent', LOST: 'written off' })[o]).join(', ')}: ${d.reason}`,
    clientKey: d.clientKey,
    createdById: by.userId,
    moves,
  })
  for (const [id, n] of settled) await tx.processTransferLine.update({ where: { id }, data: { settledQty: { increment: n } } })
  const after = await tx.processTransferLine.findMany({ where: { transferId: t.id } })
  const transfer = await tx.processTransfer.update({
    where: { id: t.id },
    data: { status: after.some((l) => l.shortQty > l.settledQty) ? 'DISCREPANCY' : 'RECEIVED' },
  })
  await syncProgress(tx, mo.id)
  return { transfer, duplicate: false }
}

/** Takes back a transfer nobody has counted in yet: the pieces return to the sender. */
export async function cancelTransfer(tx: Tx, transferId: string, reason: string, userId: string) {
  const head = await tx.processTransfer.findUnique({ where: { id: transferId }, select: { moId: true } })
  if (!head) throw new AppError('Transfer not found', 404, 'NOT_FOUND')
  await openMo(tx, head.moId)
  const t = await tx.processTransfer.findUniqueOrThrow({ where: { id: transferId }, include: { lines: true } })
  if (t.status === 'CANCELLED') throw new AppError(`${t.transferNumber} is already cancelled.`, 409, 'ALREADY_CANCELLED')
  if (t.status !== 'DISPATCHED' || t.lines.some((l) => l.receivedQty > 0 || l.shortQty > 0)) {
    throw new AppError(
      t.vendorId
        ? `${t.transferNumber} cannot be cancelled: the unit has already returned some of it.`
        : `${t.transferNumber} has been counted in, so it stands. Send the pieces back on a new transfer if they went wrong.`,
      409,
      'ALREADY_RECEIVED',
    )
  }
  const sent = await tx.wipEvent.findFirst({ where: { transferId: t.id, type: 'DISPATCH', reversedAt: null } })
  if (sent) {
    try {
      await reverseEvent(tx, sent.id, `Cancelled ${t.transferNumber}: ${reason}`, userId)
    } catch (err) {
      // A unit does not count in on our system: what it has returned stands.
      if (err instanceof AppError && err.code === 'NOT_ENOUGH_PIECES') {
        throw new AppError(`${t.transferNumber} cannot be cancelled: ${t.vendorId ? 'the unit has already returned some of it' : 'some of its pieces have moved on'}.`, 409, 'ALREADY_RECEIVED')
      }
      throw err
    }
  }
  const transfer = await tx.processTransfer.update({
    where: { id: t.id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: userId, cancelReason: reason },
  })
  await syncProgress(tx, t.moId)
  return transfer
}

// ─── Work at a step ───────────────────────────────────────────

export const workSchema = z.object({
  lines: z
    .array(
      z.object({
        bundleId: z.string().min(1),
        done: pcs.default(0),
        damaged: pcs.default(0),
        rejected: pcs.default(0),
        rework: pcs.default(0),
        bGrade: pcs.default(0),
      }),
    )
    .min(1, 'Pick the bundles worked on'),
  /** Whose people put the rework right: this step's, or an earlier one's. */
  reworkStepId: z.string().optional().nullable(),
  /** What was wrong, for damaged or rejected pieces — and where it went wrong. */
  reason: z.string().trim().max(500).optional().nullable(),
  personName: person,
  eventDate: z.coerce.date().optional(),
  notes: note,
  clientKey,
})

/** Records work done at a step on pieces in hand there. */
export async function recordWork(tx: Tx, moId: string, stepId: string, d: z.infer<typeof workSchema>, userId: string) {
  const mo = await openMo(tx, moId)
  if (await seen(tx, d.clientKey)) return { duplicate: true }
  const step = stepOf(mo, stepId)
  if (step.kind === 'CUTTING') throw new AppError('Cutting is recorded on the cutting document, which also makes the bundles.', 400, 'USE_CUTTING')
  const lines = byBundle(d.lines, (a, b) => ({
    bundleId: a.bundleId,
    done: a.done + b.done,
    damaged: a.damaged + b.damaged,
    rejected: a.rejected + b.rejected,
    rework: a.rework + b.rework,
    bGrade: a.bGrade + b.bGrade,
  })).filter((l) => l.done + l.damaged + l.rejected + l.rework + l.bGrade > 0)
  if (!lines.length) throw new AppError('Enter the pieces worked on.', 400, 'NOTHING_RECORDED')
  const bad = lines.reduce((s, l) => s + l.damaged + l.rejected, 0)
  if (bad > 0 && !d.reason?.trim()) throw new AppError('Say what was wrong with the damaged or rejected pieces.', 400, 'NO_REASON')
  const reworkStep = reworkStepFor(mo, step, d.reworkStepId, lines.some((l) => l.rework > 0))
  const moves = lines.flatMap((l): Move[] => [
    { stepId: step.id, bundleId: l.bundleId, bucket: 'WIP', qty: -(l.done + l.damaged + l.rejected + l.rework + l.bGrade) },
    { stepId: step.id, bundleId: l.bundleId, bucket: 'DONE', qty: l.done },
    { stepId: step.id, bundleId: l.bundleId, bucket: 'DAMAGED', qty: l.damaged },
    { stepId: step.id, bundleId: l.bundleId, bucket: 'REJECTED', qty: l.rejected },
    { stepId: step.id, bundleId: l.bundleId, bucket: 'REWORK', qty: l.rework, reworkStepId: reworkStep?.id ?? step.id },
    { stepId: step.id, bundleId: l.bundleId, bucket: 'B_GRADE', qty: l.bGrade },
  ])
  const event = await postEvent(tx, {
    moId,
    type: 'PROCESS',
    stepId: step.id,
    reworkStepId: lines.some((l) => l.rework > 0) ? reworkStep?.id ?? step.id : null,
    reason: d.reason ?? null,
    personName: d.personName,
    eventDate: d.eventDate,
    notes: d.notes,
    clientKey: d.clientKey,
    createdById: userId,
    moves,
    shortMessage: (detail) => `${detail}, so that is more than is in hand there. Count it in first if it has just arrived.`,
  })
  await syncProgress(tx, moId)
  return { event, duplicate: false }
}

/** Rework is put right by this step's people or an earlier step's — never a later one. */
function reworkStepFor(mo: OpenMo, step: OpenMo['steps'][number], reworkStepId: string | null | undefined, needed: boolean) {
  if (!needed) return null
  if (!reworkStepId) return step
  const r = stepOf(mo, reworkStepId)
  if (r.sequence > step.sequence) throw new AppError(`Rework from ${step.name} goes back to ${step.name} or a step before it, not ${r.name}.`, 400, 'BAD_REWORK_STEP')
  return r
}

export const decideSchema = z.object({
  /** Where the pieces are now. */
  from: z.enum(['DAMAGED', 'REJECTED', 'DONE']),
  /** What is decided for them. */
  to: z.enum(['REWORK', 'B_GRADE', 'SCRAPPED', 'DONE', 'WIP', 'DAMAGED', 'REJECTED']),
  lines: z.array(z.object({ bundleId: z.string().min(1), qty: pcs })).min(1),
  reworkStepId: z.string().optional().nullable(),
  reason: reasonText,
  personName: person,
  eventDate: z.coerce.date().optional(),
  clientKey,
})

const DECISIONS: Record<string, string[]> = {
  DAMAGED: ['REWORK', 'B_GRADE', 'SCRAPPED', 'DONE', 'WIP'],
  REJECTED: ['REWORK', 'B_GRADE', 'SCRAPPED', 'DONE', 'WIP'],
  DONE: ['DAMAGED', 'REJECTED'],
}

/**
 * A decision on pieces at a step: damaged or rejected ones put right,
 * set aside as B-grade, written off, passed after all, or checked again — or
 * done ones found faulty after all. Writing off and passing after all need a
 * production manager.
 */
export async function decide(tx: Tx, moId: string, stepId: string, d: z.infer<typeof decideSchema>, by: { userId: string; mayApprove: boolean }) {
  const mo = await openMo(tx, moId)
  if (await seen(tx, d.clientKey)) return { duplicate: true }
  const step = stepOf(mo, stepId)
  if (!DECISIONS[d.from]?.includes(d.to)) throw new AppError('That is not a decision that can be made on those pieces.', 400, 'BAD_DECISION')
  if ((d.to === 'SCRAPPED' || (d.to === 'DONE' && d.from !== 'DONE')) && !by.mayApprove) {
    throw new AppError(d.to === 'SCRAPPED' ? 'Writing pieces off needs a production manager.' : 'Passing rejected or damaged pieces as they are needs a production manager.', 403, 'NEEDS_APPROVAL')
  }
  if (d.to === 'WIP' && !isCheck(step)) throw new AppError(`Only a check sends pieces back to be checked again; at ${step.name} send them for rework instead.`, 400, 'BAD_DECISION')
  const lines = byBundle(
    d.lines.filter((l) => l.qty > 0),
    (a, b) => ({ ...a, qty: a.qty + b.qty }),
  )
  if (!lines.length) throw new AppError('Enter how many pieces.', 400, 'NOTHING_DECIDED')
  const reworkStep = d.to === 'REWORK' ? reworkStepFor(mo, step, d.reworkStepId, true) : null
  const event = await postEvent(tx, {
    moId,
    type: 'DECIDE',
    stepId: step.id,
    reworkStepId: reworkStep?.id ?? null,
    reason: d.reason,
    personName: d.personName,
    eventDate: d.eventDate,
    clientKey: d.clientKey,
    createdById: by.userId,
    moves: lines.flatMap((l): Move[] => [
      { stepId: step.id, bundleId: l.bundleId, bucket: d.from as WipBucket, qty: -l.qty },
      { stepId: step.id, bundleId: l.bundleId, bucket: d.to as WipBucket, qty: l.qty, reworkStepId: d.to === 'REWORK' ? reworkStep!.id : null },
    ]),
  })
  await syncProgress(tx, moId)
  return { event, duplicate: false }
}

export const reworkDoneSchema = z.object({
  lines: z.array(z.object({ bundleId: z.string().min(1), qty: pcs, reworkStepId: z.string().optional().nullable() })).min(1),
  personName: person,
  eventDate: z.coerce.date().optional(),
  notes: note,
  clientKey,
})

/**
 * Rework put right. At a check the pieces go back to be checked again; at any
 * other step they are done. Reworked pieces are not new production: they
 * were never counted done before.
 */
export async function reworkDone(tx: Tx, moId: string, stepId: string, d: z.infer<typeof reworkDoneSchema>, userId: string) {
  const mo = await openMo(tx, moId)
  if (await seen(tx, d.clientKey)) return { duplicate: true }
  const step = stepOf(mo, stepId)
  const back: WipBucket = isCheck(step) ? 'WIP' : 'DONE'
  const moves = d.lines
    .filter((l) => l.qty > 0)
    .flatMap((l): Move[] => [
      { stepId: step.id, bundleId: l.bundleId, bucket: 'REWORK', qty: -l.qty, reworkStepId: l.reworkStepId ?? step.id },
      { stepId: step.id, bundleId: l.bundleId, bucket: back, qty: l.qty },
    ])
  if (!moves.length) throw new AppError('Enter how many pieces were put right.', 400, 'NOTHING_RECORDED')
  const event = await postEvent(tx, {
    moId,
    type: 'REWORK_DONE',
    stepId: step.id,
    personName: d.personName,
    eventDate: d.eventDate,
    notes: d.notes,
    clientKey: d.clientKey,
    createdById: userId,
    moves,
  })
  await syncProgress(tx, moId)
  return { event, duplicate: false }
}

// ─── Job work orders ──────────────────────────────────────────

export const vendorReturnSchema = z.object({
  lines: z
    .array(
      z.object({
        bundleId: z.string().min(1),
        accepted: pcs.default(0),
        rejected: pcs.default(0),
        /** Spoiled or lost at the unit: chargeable to them. */
        damaged: pcs.default(0),
      }),
    )
    .min(1, 'Pick the bundles that came back'),
  theirChallanNo: z.string().trim().max(60).optional().nullable(),
  eventDate: z.coerce.date().optional(),
  /** Pieces charged for at the rate; defaults to the accepted pieces sent fresh, not rework. */
  chargeQty: z.number().int().min(0).max(1_000_000).optional().nullable(),
  rate: z.number().min(0).max(100_000).optional().nullable(),
  billNo: z.string().trim().max(60).optional().nullable(),
  billDate: z.coerce.date().optional().nullable(),
  reason: z.string().trim().max(500).optional().nullable(),
  personName: person,
  notes: note,
  clientKey,
})

/**
 * Pieces back from an outside unit, counted by bundle: accepted ones are done
 * at the step and can go on; rejected and damaged ones wait for a decision —
 * damaged at the unit is chargeable to it. Pieces sent back for rework come
 * off what they hold for rework; fresh work comes off the rest first.
 */
export async function vendorReturn(tx: Tx, jobWorkOrderId: string, d: z.infer<typeof vendorReturnSchema>, userId: string) {
  const head = await tx.jobWorkOrder.findUnique({ where: { id: jobWorkOrderId }, select: { moId: true } })
  if (!head) throw new AppError('Job work order not found', 404, 'NOT_FOUND')
  const mo = await openMo(tx, head.moId)
  if (await seen(tx, d.clientKey)) return { duplicate: true }
  const j = await tx.jobWorkOrder.findUniqueOrThrow({ where: { id: jobWorkOrderId }, include: { vendor: { select: { name: true } } } })
  if (j.status !== 'OPEN') throw new AppError(`${j.orderNumber} is ${j.status.toLowerCase()}.`, 409, 'NOT_OPEN')
  const step = stepOf(mo, j.stepId)
  const lines = byBundle(d.lines, (a, b) => ({ bundleId: a.bundleId, accepted: a.accepted + b.accepted, rejected: a.rejected + b.rejected, damaged: a.damaged + b.damaged })).filter(
    (l) => l.accepted + l.rejected + l.damaged > 0,
  )
  if (!lines.length) throw new AppError('Enter what came back.', 400, 'NOTHING_BACK')
  if (lines.some((l) => l.rejected + l.damaged > 0) && !d.reason?.trim()) throw new AppError('Say what was wrong with the rejected or damaged pieces.', 400, 'NO_REASON')

  const held = await balancesOf(tx, mo.id)
  const at = (bundleId: string, bucket: WipBucket) =>
    held.filter((r) => r.stepId === step.id && r.vendorId === j.vendorId && r.bucket === bucket && r.bundleId === bundleId).reduce((s, r) => s + r.qty, 0)
  let fresh = 0
  const moves: Move[] = []
  for (const l of lines) {
    const total = l.accepted + l.rejected + l.damaged
    const fromWork = Math.min(total, at(l.bundleId, 'WIP'))
    const fromRework = total - fromWork
    fresh += Math.min(l.accepted, fromWork)
    moves.push(
      { stepId: step.id, bundleId: l.bundleId, bucket: 'WIP', qty: -fromWork, vendorId: j.vendorId },
      { stepId: step.id, bundleId: l.bundleId, bucket: 'REWORK', qty: -fromRework, vendorId: j.vendorId, reworkStepId: step.id },
      { stepId: step.id, bundleId: l.bundleId, bucket: 'DONE', qty: l.accepted },
      { stepId: step.id, bundleId: l.bundleId, bucket: 'REJECTED', qty: l.rejected },
      { stepId: step.id, bundleId: l.bundleId, bucket: 'DAMAGED', qty: l.damaged },
    )
  }
  const event = await postEvent(tx, {
    moId: mo.id,
    type: 'VENDOR_RETURN',
    stepId: step.id,
    vendorId: j.vendorId,
    jobWorkOrderId: j.id,
    theirChallanNo: d.theirChallanNo ?? null,
    chargeQty: d.chargeQty ?? fresh,
    chargeRate: d.rate ?? Number(j.rate),
    billNo: d.billNo ?? null,
    billDate: d.billDate ?? null,
    reason: d.reason ?? null,
    personName: d.personName,
    eventDate: d.eventDate,
    notes: d.notes,
    clientKey: d.clientKey,
    createdById: userId,
    moves,
    shortMessage: (detail) => `${j.vendor.name} does not hold that many: ${detail}.`,
  })
  await syncChallans(tx, j.id)
  await syncProgress(tx, mo.id)
  return { event, duplicate: false }
}

export const sendBackSchema = z.object({
  from: z.enum(['REJECTED', 'DAMAGED']),
  lines: z.array(z.object({ bundleId: z.string().min(1), qty: pcs })).min(1),
  reason: reasonText,
  issuedBy: person,
  vehicleNo: z.string().trim().max(30).optional().nullable(),
  dispatchDate: z.coerce.date().optional(),
  notes: note,
  clientKey,
})

/** Rejected pieces sent back to the unit to put right, on a challan of their own. */
export async function sendBack(tx: Tx, jobWorkOrderId: string, d: z.infer<typeof sendBackSchema>, userId: string) {
  const head = await tx.jobWorkOrder.findUnique({ where: { id: jobWorkOrderId }, select: { moId: true } })
  if (!head) throw new AppError('Job work order not found', 404, 'NOT_FOUND')
  const mo = await openMo(tx, head.moId)
  if (await seen(tx, d.clientKey)) return { transfer: await tx.processTransfer.findUniqueOrThrow({ where: { clientKey: d.clientKey! } }), duplicate: true }
  const j = await tx.jobWorkOrder.findUniqueOrThrow({ where: { id: jobWorkOrderId } })
  if (j.status !== 'OPEN') throw new AppError(`${j.orderNumber} is ${j.status.toLowerCase()}.`, 409, 'NOT_OPEN')
  const lines = byBundle(
    d.lines.filter((l) => l.qty > 0),
    (a, b) => ({ ...a, qty: a.qty + b.qty }),
  )
  if (!lines.length) throw new AppError('Enter how many pieces go back.', 400, 'NOTHING_SENT')
  const bundles = await tx.productionBundle.findMany({ where: { id: { in: lines.map((l) => l.bundleId) }, moId: mo.id }, select: { id: true, sizeId: true } })
  if (bundles.length !== lines.length) throw new AppError('One of those bundles is not on this order.', 400, 'BAD_BUNDLE')
  const sizeOf = new Map(bundles.map((b) => [b.id, b.sizeId]))
  const when = d.dispatchDate ?? new Date()
  const transfer = await tx.processTransfer.create({
    data: {
      transferNumber: await nextDocumentNumber(tx, 'JW', when),
      moId: mo.id,
      fromStepId: j.stepId,
      toStepId: j.stepId,
      vendorId: j.vendorId,
      jobWorkOrderId: j.id,
      isRework: true,
      dispatchDate: when,
      issuedBy: d.issuedBy ?? null,
      vehicleNo: d.vehicleNo ?? null,
      notes: [d.reason, d.notes].filter(Boolean).join(' · ') || null,
      createdById: userId,
      clientKey: d.clientKey ?? null,
      lines: { create: lines.map((l) => ({ bundleId: l.bundleId, sizeId: sizeOf.get(l.bundleId) ?? null, dispatchedQty: l.qty })) },
    },
  })
  await postEvent(tx, {
    moId: mo.id,
    type: 'DISPATCH',
    stepId: j.stepId,
    transferId: transfer.id,
    vendorId: j.vendorId,
    jobWorkOrderId: j.id,
    reworkStepId: j.stepId,
    reason: d.reason,
    eventDate: when,
    personName: d.issuedBy,
    createdById: userId,
    moves: lines.flatMap((l): Move[] => [
      { stepId: j.stepId, bundleId: l.bundleId, bucket: d.from, qty: -l.qty },
      { stepId: j.stepId, bundleId: l.bundleId, bucket: 'REWORK', qty: l.qty, vendorId: j.vendorId, reworkStepId: j.stepId },
    ]),
  })
  await syncProgress(tx, mo.id)
  return { transfer, duplicate: false }
}

/**
 * A unit's challans, marked back as its returns come in. A unit does not count
 * in on our system, so each return is set against the oldest challan of each
 * bundle first: a challan is back when all it carried has come back, partly
 * back while some has. Worked out afresh after every return, and after one
 * is undone.
 */
export async function syncChallans(tx: Tx, jobWorkOrderId: string) {
  const [challans, returned] = await Promise.all([
    tx.processTransfer.findMany({
      where: { jobWorkOrderId, status: { not: 'CANCELLED' } },
      orderBy: [{ dispatchDate: 'asc' }, { createdAt: 'asc' }],
      include: { lines: true },
    }),
    tx.wipEntry.groupBy({
      by: ['bundleId'],
      where: { eventType: 'VENDOR_RETURN', qty: { lt: 0 }, vendorId: { not: null }, event: { jobWorkOrderId, reversedAt: null } },
      _sum: { qty: true },
    }),
  ])
  const back = new Map(returned.map((r) => [r.bundleId, -(r._sum.qty ?? 0)]))
  for (const t of challans) {
    let sent = 0
    let got = 0
    for (const l of t.lines) {
      const left = back.get(l.bundleId) ?? 0
      const qty = Math.min(l.dispatchedQty, left)
      back.set(l.bundleId, left - qty)
      if (qty !== l.receivedQty) await tx.processTransferLine.update({ where: { id: l.id }, data: { receivedQty: qty } })
      sent += l.dispatchedQty
      got += qty
    }
    const status = got >= sent ? 'RECEIVED' : got > 0 ? 'PARTLY_RECEIVED' : 'DISPATCHED'
    if (status !== t.status) await tx.processTransfer.update({ where: { id: t.id }, data: { status, receivedAt: got ? t.receivedAt ?? new Date() : null } })
  }
}

/** Closes a job work order once the unit holds nothing of it. */
export async function closeJobWorkOrder(tx: Tx, jobWorkOrderId: string) {
  const head = await tx.jobWorkOrder.findUnique({ where: { id: jobWorkOrderId }, select: { moId: true } })
  if (!head) throw new AppError('Job work order not found', 404, 'NOT_FOUND')
  await lockMo(tx, head.moId)
  const j = await tx.jobWorkOrder.findUniqueOrThrow({ where: { id: jobWorkOrderId }, include: { vendor: { select: { name: true } } } })
  if (j.status !== 'OPEN') throw new AppError(`${j.orderNumber} is already ${j.status.toLowerCase()}.`, 409, 'NOT_OPEN')
  const held = (await balancesOf(tx, j.moId)).filter((r) => r.stepId === j.stepId && r.vendorId === j.vendorId).reduce((s, r) => s + r.qty, 0)
  if (held > 0) throw new AppError(`${j.vendor.name} still holds ${held} pieces of ${j.orderNumber}. Record them back (damaged, if they are lost) first.`, 409, 'STILL_HELD')
  return tx.jobWorkOrder.update({ where: { id: j.id }, data: { status: 'CLOSED', closedAt: new Date() } })
}

export const billSchema = z.object({
  billNo: z.string().trim().min(1, 'Enter their bill number').max(60),
  billDate: z.coerce.date().optional().nullable(),
  chargeQty: z.number().int().min(0).max(1_000_000).optional().nullable(),
  rate: z.number().min(0).max(100_000).optional().nullable(),
})

/** Their bill for a return, when it comes: which return it charges for, and at what. */
export async function setReturnBill(tx: Tx, eventId: string, d: z.infer<typeof billSchema>) {
  const ev = await tx.wipEvent.findUnique({ where: { id: eventId }, select: { id: true, type: true, reversedAt: true } })
  if (!ev || ev.type !== 'VENDOR_RETURN') throw new AppError('That return was not found.', 404, 'NOT_FOUND')
  if (ev.reversedAt) throw new AppError('That return has been undone.', 409, 'UNDONE')
  return tx.wipEvent.update({
    where: { id: ev.id },
    data: {
      billNo: d.billNo,
      billDate: d.billDate ?? null,
      ...(d.chargeQty != null ? { chargeQty: d.chargeQty } : {}),
      ...(d.rate != null ? { chargeRate: d.rate } : {}),
    },
  })
}

// ─── Packing into finished goods ──────────────────────────────

/**
 * Takes the pieces a finished-goods receipt books in off the floor: first
 * quality only from pieces the last step has passed, B-grade only from pieces
 * set aside as B-grade. The oldest bundles go first. Refused when the floor
 * has not finished that many — nothing is packed that was not made.
 */
export async function packForReceipt(
  tx: Tx,
  a: { moId: string; fgReceiptId: string; lines: Array<{ itemId: string; sizeId: string | null; qty: number; grade: string }>; userId: string; date: Date },
) {
  const mo = await openMo(tx, a.moId)
  const [moLines, bundles, held, items] = await Promise.all([
    tx.mOLine.findMany({ where: { moId: mo.id }, select: { id: true, styleId: true, color: true, soLine: { select: { itemId: true } } } }),
    tx.productionBundle.findMany({ where: { moId: mo.id }, select: { id: true, bundleNo: true, moLineId: true, sizeId: true } }),
    balancesOf(tx, mo.id),
    tx.item.findMany({ where: { id: { in: [...new Set(a.lines.map((l) => l.itemId))] } }, select: { id: true, code: true, styleId: true, color: true } }),
  ])
  const itemById = new Map(items.map((i) => [i.id, i]))
  const sizeCodes = new Map(
    (await tx.size.findMany({ where: { id: { in: a.lines.map((l) => l.sizeId).filter(Boolean) as string[] } }, select: { id: true, code: true } })).map((s) => [s.id, s.code]),
  )
  const last = mo.steps.filter((s) => isLastStep(mo.steps, s.id))
  const lastIds = new Set(last.map((s) => s.id))
  const bundleNo = new Map(bundles.map((b) => [b.id, b.bundleNo]))
  const left = new Map(held.map((r) => [keyOf(r), r.qty]))

  const moves: Move[] = []
  for (const line of a.lines) {
    const item = itemById.get(line.itemId)
    const linesOfItem = moLines.filter(
      (m) => m.soLine?.itemId === line.itemId || (item?.styleId === m.styleId && (item?.color ?? '').trim().toLowerCase() === m.color.trim().toLowerCase()),
    )
    if (!linesOfItem.length) throw new AppError(`${item?.code ?? 'That item'} is not made on ${mo.moNumber}.`, 400, 'NOT_ON_MO')
    const lineIds = new Set(linesOfItem.map((m) => m.id))
    // A garment item with no size run is booked in without a size: it takes
    // pieces of any size of its line.
    const mine = new Set(bundles.filter((b) => lineIds.has(b.moLineId) && (!line.sizeId || b.sizeId === line.sizeId)).map((b) => b.id))
    const want: WipBucket = line.grade === 'B' ? 'B_GRADE' : 'DONE'
    // Done pieces first; at a working last step (packing), pieces in hand after.
    const handIds = new Set(last.filter(sendsFromHand).map((s) => s.id))
    const rank = (r: BalanceRow) => (r.bucket === 'WIP' ? 1 : 0)
    const sources: BalanceRow[] = held
      .filter(
        (r) =>
          !r.vendorId &&
          mine.has(r.bundleId) &&
          (want === 'B_GRADE' ? r.bucket === 'B_GRADE' : (r.bucket === 'DONE' && lastIds.has(r.stepId)) || (r.bucket === 'WIP' && handIds.has(r.stepId))),
      )
      .sort((x, y) => rank(x) - rank(y) || (bundleNo.get(x.bundleId) ?? 0) - (bundleNo.get(y.bundleId) ?? 0))
    let need = Math.round(line.qty)
    for (const r of sources) {
      if (need <= 0) break
      const k = keyOf(r)
      const take = Math.min(need, left.get(k) ?? 0)
      if (take <= 0) continue
      left.set(k, (left.get(k) ?? 0) - take)
      moves.push({ stepId: r.stepId, bundleId: r.bundleId, bucket: r.bucket, qty: -take }, { stepId: r.stepId, bundleId: r.bundleId, bucket: want === 'B_GRADE' ? 'PACKED_B' : 'PACKED', qty: take })
      need -= take
    }
    if (need > 0) {
      const ready = Math.round(line.qty) - need
      const size = line.sizeId ? ` in ${sizeCodes.get(line.sizeId) ?? 'that size'}` : ''
      throw new AppError(
        line.grade === 'B'
          ? `Only ${ready} pieces of ${item?.code}${size} are set aside as B-grade on ${mo.moNumber}, so ${Math.round(line.qty)} cannot be packed as B-grade.`
          : `Only ${ready} pieces of ${item?.code}${size} have reached ${last.map((s) => s.name).join(' / ')} on ${mo.moNumber}; the rest are still on the floor.`,
        409,
        'NOT_FINISHED',
      )
    }
  }
  if (!moves.length) return null
  const event = await postEvent(tx, { moId: mo.id, type: 'PACK', fgReceiptId: a.fgReceiptId, eventDate: a.date, createdById: a.userId, moves })
  await syncProgress(tx, mo.id)
  return event
}

/** A cancelled finished-goods receipt puts its pieces back where they were packed from. */
export async function unpackForReceipt(tx: Tx, fgReceiptId: string, reason: string, userId: string) {
  const packs = await tx.wipEvent.findMany({ where: { fgReceiptId, type: 'PACK', reversedAt: null }, select: { id: true, moId: true } })
  for (const p of packs) await reverseEvent(tx, p.id, reason, userId)
  for (const moId of new Set(packs.map((p) => p.moId))) await syncProgress(tx, moId)
}

// ─── Undo ─────────────────────────────────────────────────────

const UNDOABLE: WipEventType[] = ['PROCESS', 'DECIDE', 'REWORK_DONE', 'VENDOR_RETURN', 'SETTLE']

/**
 * Undoes one entry made at a step — work recorded, a decision, a return —
 * while its pieces are still where it put them. Transfers, cuttings and
 * packing are taken back on their own documents.
 */
export async function undoEvent(tx: Tx, eventId: string, reason: string, userId: string) {
  const ev = await tx.wipEvent.findUnique({ where: { id: eventId }, select: { moId: true, type: true, transferId: true, jobWorkOrderId: true } })
  if (!ev) throw new AppError('That entry was not found.', 404, 'NOT_FOUND')
  await openMo(tx, ev.moId)
  if (!UNDOABLE.includes(ev.type)) {
    throw new AppError('Take that back on its own document: cancel the transfer, the cutting, or the finished-goods receipt.', 400, 'UNDO_ON_DOCUMENT')
  }
  const out = await reverseEvent(tx, eventId, reason, userId)
  if (ev.type === 'SETTLE' && ev.transferId) {
    // The settled pieces are short again.
    const back = new Map<string, number>()
    for (const e of out.event.entries) if (e.bucket === 'SHORT' && e.qty < 0) back.set(e.bundleId, (back.get(e.bundleId) ?? 0) - e.qty)
    for (const [bundleId, n] of back) await tx.processTransferLine.updateMany({ where: { transferId: ev.transferId, bundleId }, data: { settledQty: { decrement: n } } })
    await tx.processTransfer.update({ where: { id: ev.transferId }, data: { status: 'DISCREPANCY' } })
  }
  if (ev.type === 'VENDOR_RETURN' && ev.jobWorkOrderId) await syncChallans(tx, ev.jobWorkOrderId)
  await syncProgress(tx, ev.moId)
  return out
}

// ─── Hold ─────────────────────────────────────────────────────

export async function holdMo(tx: Tx, moId: string, reason: string, userId: string) {
  await lockMo(tx, moId)
  const mo = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: moId }, select: { moNumber: true, status: true, heldAt: true } })
  if (mo.heldAt) throw new AppError(`${mo.moNumber} is already on hold.`, 409, 'ALREADY_HELD')
  if (mo.status === 'CLOSED' || mo.status === 'DRAFT') throw new AppError(`${mo.moNumber} is ${mo.status.toLowerCase()}; there is nothing on the floor to hold.`, 409, 'NOT_OPEN')
  return tx.manufacturingOrder.update({ where: { id: moId }, data: { heldAt: new Date(), heldById: userId, holdReason: reason } })
}

export async function resumeMo(tx: Tx, moId: string) {
  await lockMo(tx, moId)
  const mo = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: moId }, select: { moNumber: true, heldAt: true } })
  if (!mo.heldAt) throw new AppError(`${mo.moNumber} is not on hold.`, 409, 'NOT_HELD')
  return tx.manufacturingOrder.update({ where: { id: moId }, data: { heldAt: null, heldById: null, holdReason: null } })
}

// ─── Figures ──────────────────────────────────────────────────

const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0)

export type FigureStep = { id: string; sequence: number; kind: ProcessKind; isQcStep: boolean; skippedAt: Date | null; name: string; execution: StepExecution }
type FlowRow = { stepId: string; bucket: WipBucket; eventType: WipEventType; qty: number }
export type Flows = { ins: FlowRow[]; outs: FlowRow[] }

/**
 * Per step, what has come, what has been done, what is where now — worked out
 * from the entries, never stored. For the whole order, or for one job card
 * (one line of it). Shared by the order's timeline, the job cards and the
 * departments' sheets, and the figures kept on the order itself.
 */
export async function stepFigures(db: Db, moId: string, steps: FigureStep[], planned: number, moLineId?: string) {
  const [held, flows] = await Promise.all([balancesOf(db as Tx, moId, moLineId), flowsOf(db as Tx, moId, moLineId)])
  return figuresFrom(steps, planned, held, flows)
}

/** The same figures, from balances and flows already read — for many job cards at once. */
export function figuresFrom(steps: FigureStep[], planned: number, held: Array<Pick<BalanceRow, 'stepId' | 'bucket' | 'vendorId' | 'qty'>>, flows: Flows) {
  const sorted = [...steps].sort((a, b) => a.sequence - b.sequence)
  const inOf = (stepId: string, bucket: WipBucket, types: WipEventType[]) => sum(flows.ins.filter((r) => r.stepId === stepId && r.bucket === bucket && types.includes(r.eventType)), (r) => r.qty)
  const outOf = (stepId: string, bucket: WipBucket, types: WipEventType[]) => sum(flows.outs.filter((r) => r.stepId === stepId && r.bucket === bucket && types.includes(r.eventType)), (r) => r.qty)
  const now = (stepId: string, bucket: WipBucket, where: 'house' | 'vendor' | 'any' = 'house') =>
    sum(
      held.filter((r) => r.stepId === stepId && r.bucket === bucket && (where === 'any' || (where === 'vendor' ? !!r.vendorId : !r.vendorId))),
      (r) => r.qty,
    )

  let lostBefore = 0
  return sorted.map((s) => {
    const cut = s.kind === 'CUTTING' ? inOf(s.id, 'DONE', ['CUT']) : 0
    const received = s.kind === 'CUTTING' ? cut : inOf(s.id, 'WIP', ['RECEIVE', 'EXCESS', 'SETTLE', 'DISPATCH'])
    // A working step sends pieces on, and packs them, straight from in hand:
    // those were done there too.
    const straightOn = outOf(s.id, 'WIP', ['DISPATCH', 'EXCESS', 'PACK'])
    const completed = inOf(s.id, 'DONE', ['CUT', 'PROCESS', 'VENDOR_RETURN', 'REWORK_DONE', 'DECIDE']) - outOf(s.id, 'DONE', ['DECIDE']) + straightOn
    const sentOn = outOf(s.id, 'DONE', ['DISPATCH', 'EXCESS']) + outOf(s.id, 'WIP', ['DISPATCH', 'EXCESS']) - inOf(s.id, 'DONE', ['SETTLE'])
    const figures = {
      received,
      completed,
      sentOn,
      packed: outOf(s.id, 'DONE', ['PACK']) + outOf(s.id, 'WIP', ['PACK']),
      damaged: inOf(s.id, 'DAMAGED', ['PROCESS', 'VENDOR_RETURN', 'DECIDE']),
      rejected: inOf(s.id, 'REJECTED', ['PROCESS', 'VENDOR_RETURN', 'DECIDE']),
      rework: inOf(s.id, 'REWORK', ['PROCESS', 'DECIDE', 'DISPATCH']),
      bGrade: inOf(s.id, 'B_GRADE', ['PROCESS', 'DECIDE']),
      scrapped: now(s.id, 'SCRAPPED', 'any'),
      inTransit: now(s.id, 'TRANSIT'),
      inHand: now(s.id, 'WIP'),
      atVendor: now(s.id, 'WIP', 'vendor') + now(s.id, 'REWORK', 'vendor'),
      inRework: now(s.id, 'REWORK'),
      waiting: now(s.id, 'DONE'),
      damagedNow: now(s.id, 'DAMAGED'),
      rejectedNow: now(s.id, 'REJECTED'),
      short: now(s.id, 'SHORT'),
      bGradeNow: now(s.id, 'B_GRADE'),
      // Pieces written off as lost on the way here will not come either.
      yetToCome: Math.max(0, planned - (s.kind === 'CUTTING' ? cut : received) - lostBefore - inOf(s.id, 'SCRAPPED', ['SETTLE'])),
    }
    lostBefore += figures.scrapped + figures.bGrade
    const somethingHere =
      figures.inTransit + figures.inHand + figures.atVendor + figures.inRework + figures.waiting + figures.damagedNow + figures.rejectedNow + figures.short
    const state = s.skippedAt
      ? somethingHere
        ? 'IN_PROGRESS'
        : 'SKIPPED'
      : figures.received === 0 && somethingHere === 0
        ? 'NOT_STARTED'
        : somethingHere === 0 && figures.yetToCome === 0
          ? 'DONE'
          : 'IN_PROGRESS'
    const flags = [
      figures.short > 0 ? 'DISCREPANCY' : null,
      now(s.id, 'REWORK', 'any') > 0 ? 'REWORK' : null,
      figures.damagedNow + figures.rejectedNow > 0 ? 'DECISION' : null,
      isCheck(s) && figures.inHand > 0 ? 'QC_PENDING' : null,
      figures.atVendor > 0 ? 'AT_VENDOR' : null,
    ].filter(Boolean) as string[]
    return { stepId: s.id, state, flags, ...figures }
  })
}

/**
 * Brings the order's own figures up to date from its entries: where the work
 * stands, pieces stitched and finished, and when it started. Never typed.
 */
export async function syncProgress(tx: Tx, moId: string) {
  const mo = await tx.manufacturingOrder.findUniqueOrThrow({
    where: { id: moId },
    select: { totalPlannedQty: true, actualStartDate: true, steps: { select: { id: true, sequence: true, kind: true, isQcStep: true, skippedAt: true, name: true, execution: true } } },
  })
  if (!mo.steps.length) return
  const figs = await stepFigures(tx, moId, mo.steps, mo.totalPlannedQty)
  const byId = new Map(figs.map((f) => [f.stepId, f]))
  const cut = sum(mo.steps.filter((s) => s.kind === 'CUTTING'), (s) => byId.get(s.id)!.received)
  const flags = new Set(figs.flatMap((f) => f.flags))
  const onFloor = sum(figs, (f) => f.inTransit + f.inHand + f.atVendor + f.inRework + f.waiting + f.damagedNow + f.rejectedNow + f.short + f.bGradeNow)
  const progress =
    cut === 0
      ? 'NOT_STARTED'
      : flags.has('DISCREPANCY')
        ? 'DISCREPANCY'
        : flags.has('REWORK')
          ? 'REWORK'
          : flags.has('QC_PENDING')
            ? 'QC_PENDING'
            : onFloor === 0 && cut >= mo.totalPlannedQty
              ? 'DONE'
              : 'IN_PROGRESS'
  const lastIds = new Set(mo.steps.filter((s) => isLastStep(mo.steps, s.id)).map((s) => s.id))
  await tx.manufacturingOrder.update({
    where: { id: moId },
    data: {
      progress,
      totalStitchedQty: sum(mo.steps.filter((s) => s.kind === 'STITCHING'), (s) => byId.get(s.id)!.completed),
      totalFinishedQty: sum(mo.steps.filter((s) => lastIds.has(s.id)), (s) => byId.get(s.id)!.completed),
      ...(cut > 0 && !mo.actualStartDate ? { actualStartDate: new Date() } : {}),
    },
  })
}
