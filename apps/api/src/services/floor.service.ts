import type { MOStatus, Prisma, PrismaClient, ProcessKind, StepExecution, WipBucket, WipEventType } from '@prisma/client'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { assertNotCancelling } from './orderCancel.service'
import { nextDocumentNumber } from '../lib/docNumber'
import { balancesOf, flowsOf, keyOf, lockMo, postEvent, reverseEvent, sizeBalancesOf, type BalanceRow, type Move } from './wip.service'
import { destinationsFrom, isCheck, isLastStep, nextStepAfter, passedBy, type RouteStep } from './route.service'
import { nextChallanNo } from './challanNo'

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
  /** The next step of the route; refused when it names any other. Taken as the next one when not said. */
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

type TakeBackFacts = {
  id: string
  transferNumber: string
  vendorId: string | null
  toStep: { name: string }
  lines: Array<{ receivedQty: number; shortQty: number; excessQty: number }>
}

/**
 * A count-in taken back, so a transfer that went wrong can be cancelled —
 * only when it was counted in as sent, and only while the pieces still sit at
 * the step as they were counted in. Once that step has worked on any of them,
 * undoing the count fails, and the transfer stands.
 */
async function takeBackCount(tx: Tx, t: TakeBackFacts, reason: string, userId: string) {
  if (t.lines.some((l) => l.shortQty > 0 || l.excessQty > 0)) {
    throw new AppError(`${t.transferNumber} was counted in with a difference, so it stands. Send the pieces on from ${t.toStep.name} instead.`, 409, 'ALREADY_RECEIVED')
  }
  const counts = await tx.wipEvent.findMany({ where: { transferId: t.id, type: 'RECEIVE', reversedAt: null }, select: { id: true }, orderBy: { createdAt: 'desc' } })
  for (const ev of counts) {
    try {
      await reverseEvent(tx, ev.id, `Count-in taken back, to cancel ${t.transferNumber}: ${reason}`, userId)
    } catch (err) {
      if (err instanceof AppError && err.code === 'NOT_ENOUGH_PIECES') {
        throw new AppError(
          `${t.toStep.name} has already worked on some of these pieces, so ${t.transferNumber} can no longer be taken back. Send the pieces on from ${t.toStep.name} instead.`,
          409,
          'WORKED_ON',
        )
      }
      throw err
    }
  }
  await tx.processTransferLine.updateMany({ where: { transferId: t.id }, data: { receivedQty: 0 } })
  await tx.processTransfer.update({ where: { id: t.id }, data: { status: 'DISPATCHED', receivedBy: null, receivedAt: null } })
}

/**
 * Where pieces at a step may go next, with how many of each bundle — read
 * fresh, for the transfer form and for the check when it is saved.
 */
export async function destinationsOf<T extends RouteStep>(db: Tx | PrismaClient, mo: { id: string; steps: T[] }, fromId: string) {
  const [bundles, sent] = await Promise.all([
    db.productionBundle.findMany({ where: { moId: mo.id }, select: { id: true, qty: true, parentId: true, splitAtStepId: true } }),
    db.processTransferLine.findMany({
      where: { transfer: { moId: mo.id, isRework: false, status: { not: 'CANCELLED' } } },
      select: { bundleId: true, dispatchedQty: true, transfer: { select: { toStepId: true } } },
    }),
  ])
  return destinationsFrom(
    mo.steps,
    fromId,
    bundles,
    sent.map((l) => ({ bundleId: l.bundleId, toStepId: l.transfer.toStepId, qty: l.dispatchedQty })),
  )
}

/**
 * Sends bundles on from a step to the next step of the order's route — in
 * the route's order, so none is passed by — and to the last one only once
 * they have been through all the others.
 *
 * Between two steps of the same department — cutting and its own check, the
 * final check and packing — nothing changes hands: the department does both.
 * The move is counted in there and then, so nobody counts their own pieces in.
 */
export async function dispatch(tx: Tx, moId: string, d: z.infer<typeof dispatchSchema>, userId: string) {
  const mo = await openMo(tx, moId)
  if (await seen(tx, d.clientKey)) {
    const dup = await tx.processTransfer.findUniqueOrThrow({ where: { clientKey: d.clientKey! } })
    return { transfer: dup, duplicate: true }
  }
  const from = stepOf(mo, d.fromStepId)
  if (!nextStepAfter(mo.steps, from.id)) throw new AppError(`${from.name} is the last step: its pieces go to Finished Goods In, not to another step.`, 409, 'LAST_STEP')
  const lines = byBundle(
    d.lines.filter((l) => l.qty > 0),
    (a, b) => ({ ...a, qty: a.qty + b.qty }),
  )
  if (!lines.length) throw new AppError('Enter how many pieces of each bundle are going.', 400, 'NOTHING_SENT')

  // Where they go: the next step of the route, in its order — never past one.
  const [choice] = await destinationsOf(tx, mo, from.id)
  if (!choice) throw new AppError(`${from.name} is the last step: its pieces go to Finished Goods In, not to another step.`, 409, 'LAST_STEP')
  if (d.toStepId && d.toStepId !== choice.step.id) {
    const asked = stepOf(mo, d.toStepId)
    const passed = passedBy(mo.steps, from.id, asked.id).map((s) => s.name)
    throw new AppError(
      asked.id === from.id
        ? `The pieces are already at ${from.name}. From here they go to ${choice.step.name}.`
        : asked.skippedAt
          ? `${asked.name} is left out of this order's route. From ${from.name} the pieces go to ${choice.step.name}.`
          : passed.length
            ? `From ${from.name} the pieces go to ${choice.step.name} next: the stages run in the route's order, so ${passed.join(', ')} cannot be passed by. To leave a stage out or change their order, change the style's routing in Masters → Routings, then take its new stages on the order.`
            : `Pieces do not go back to ${asked.name}. From ${from.name} they go to ${choice.step.name}.`,
      409,
      'NOT_NEXT_STEP',
    )
  }
  const to = choice.step
  // Pieces that reached this step past others go no further until their card is taken back.
  const cameIn = await tx.processTransfer.findMany({
    where: { moId, toStepId: from.id, isRework: false, status: { not: 'CANCELLED' }, lines: { some: { bundleId: { in: lines.map((l) => l.bundleId) } } } },
    select: { transferNumber: true, fromStepId: true },
  })
  const cameWrong = cameIn.map((t) => ({ t, by: passedBy(mo.steps, t.fromStepId, from.id) })).find((x) => x.by.length)
  if (cameWrong) {
    throw new AppError(
      `${cameWrong.t.transferNumber} brought these pieces to ${from.name} past ${cameWrong.by.map((s) => s.name).join(', ')}. Take that card back first, then send the pieces on in the route's order.`,
      409,
      'TAKE_BACK_FIRST',
    )
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

  // No more of a bundle than the next step still takes.
  for (const l of lines) {
    const cap = choice.caps[l.bundleId] ?? 0
    if (l.qty <= cap) continue
    const code = codeOf.get(l.bundleId) ?? 'A bundle'
    const missing = choice.missing[l.bundleId]
    throw new AppError(
      choice.last && missing?.length
        ? `${code} has not been through ${missing.join(', ')} yet, so it cannot go to ${to.name}: everything else on the route comes first.`
        : cap > 0
          ? `${code}: only ${cap} more of its pieces can go to ${to.name}; the rest have already been sent there.`
          : `${code} has already been sent to ${to.name}.`,
      409,
      'NOT_ALLOWED_THERE',
    )
  }

  const vendorId = d.vendorId || null
  if (to.execution === 'OUTSOURCED' && !vendorId) throw new AppError(`${to.name} is done outside: say which unit the pieces go to.`, 400, 'NO_VENDOR')
  let jobWorkOrderId: string | null = null
  if (vendorId) {
    const vendor = await tx.supplier.findUnique({ where: { id: vendorId }, select: { name: true, isActive: true } })
    if (!vendor?.isActive) throw new AppError('That unit is not an active supplier.', 400, 'BAD_VENDOR')
    jobWorkOrderId = (await jobWorkOrderFor(tx, mo, to, vendorId, d.rate ?? null, d.expectedBy ?? null, userId)).id
  }

  const when = d.dispatchDate ?? new Date()
  // Pieces leaving a working step straight from in hand were worked on there.
  // Record that first, as the step's own work, so its sheet, its report and
  // its piece-rate wages count them — not "sent on, never processed".
  const handWork = takes.filter((l) => l.hand > 0)
  if (handWork.length) {
    await postEvent(tx, {
      moId,
      type: 'PROCESS',
      stepId: from.id,
      reworkStepId: null,
      reason: null,
      personName: d.issuedBy,
      eventDate: when,
      notes: 'Recorded as done when sent on',
      createdById: userId,
      moves: handWork.flatMap((l): Move[] => [
        { stepId: from.id, bundleId: l.bundleId, bucket: 'WIP', qty: -l.hand },
        { stepId: from.id, bundleId: l.bundleId, bucket: 'DONE', qty: l.hand },
      ]),
    })
  }
  // Out to a unit: the job-work challan's own series, one run for GST. On our
  // floor: the sending department's challan on this order, e.g. STI/2627-0001/01.
  const transferNumber = vendorId ? await nextDocumentNumber(tx, 'JW', when) : await nextChallanNo(tx, mo, { stepId: from.id })
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
      // What came from in hand was booked done just above.
      { stepId: from.id, bundleId: l.bundleId, bucket: 'DONE', qty: -(l.done + l.hand) },
      // An outside unit does not count in on our system: the pieces are in
      // its hands from the challan.
      vendorId ? { stepId: to.id, bundleId: l.bundleId, bucket: 'WIP', qty: l.qty, vendorId } : { stepId: to.id, bundleId: l.bundleId, bucket: 'TRANSIT', qty: l.qty },
    ]),
  })
  if (!vendorId && to.departmentId === from.departmentId) {
    const sent = await tx.processTransferLine.findMany({ where: { transferId: transfer.id }, select: { id: true, dispatchedQty: true } })
    await receive(tx, transfer.id, { lines: sent.map((l) => ({ lineId: l.id, qty: l.dispatchedQty })), close: false, receivedBy: d.issuedBy ?? null, receivedAt: when, notes: 'Same department: no handover' }, userId)
    return { transfer: await tx.processTransfer.findUniqueOrThrow({ where: { id: transfer.id } }), duplicate: false, sameDepartment: true }
  }
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
  /**
   * Counting in at stitching: pieces of these bundles that will be made as
   * another size (a size jump), recorded with the count in one go — the same
   * change as Change sizes on the sheet, made the moment they are in hand.
   */
  sizeChanges: z
    .object({
      lines: z.array(z.object({ bundleId: z.string().min(1), toSizeId: z.string().min(1, 'Pick the size they are made as'), qty: pcs })).min(1),
      reason: reasonText,
    })
    .optional(),
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

/**
 * Takes a transfer back: the pieces return to the step that sent them. One
 * still on its way, or one counted in on our floor that nobody there has
 * worked on yet; after that it stands.
 */
export async function cancelTransfer(tx: Tx, transferId: string, reason: string, userId: string) {
  const head = await tx.processTransfer.findUnique({ where: { id: transferId }, select: { moId: true } })
  if (!head) throw new AppError('Transfer not found', 404, 'NOT_FOUND')
  await openMo(tx, head.moId)
  const t0 = await tx.processTransfer.findUniqueOrThrow({ where: { id: transferId }, include: { lines: true, toStep: { select: { name: true } } } })
  if (t0.status === 'CANCELLED') throw new AppError(`${t0.transferNumber} is already cancelled.`, 409, 'ALREADY_CANCELLED')
  // Counted in on our floor, and nobody there has touched the pieces yet: the
  // count-in is taken back first, then it is cancelled like one on its way.
  if (!t0.vendorId && t0.lines.some((l) => l.receivedQty > 0)) await takeBackCount(tx, t0, reason, userId)
  const t = await tx.processTransfer.findUniqueOrThrow({ where: { id: transferId }, include: { lines: true } })
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
 *
 * A size is taken by the size the pieces are now, not the size their bundle was
 * cut in: since 12 Nov 2026 a bundle can hold pieces made as another size, so
 * XS booked in finds the XS pieces of an S bundle, and S booked in leaves them.
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
  // What each place holds, size by size, as the pieces are now.
  const leftOfSize = new Map<string, number>()
  for (const [k, at] of await sizeBalancesOf(tx, bundles.map((b) => b.id))) for (const [size, q] of at) leftOfSize.set(`${k}|${size ?? ''}`, q)

  const moves: Move[] = []
  for (const line of a.lines) {
    const item = itemById.get(line.itemId)
    const linesOfItem = moLines.filter(
      (m) => m.soLine?.itemId === line.itemId || (item?.styleId === m.styleId && (item?.color ?? '').trim().toLowerCase() === m.color.trim().toLowerCase()),
    )
    if (!linesOfItem.length) throw new AppError(`${item?.code ?? 'That item'} is not made on ${mo.moNumber}.`, 400, 'NOT_ON_MO')
    const lineIds = new Set(linesOfItem.map((m) => m.id))
    // A garment item with no size run is booked in without a size: it takes
    // pieces of any size of its line. One with a size takes pieces that are
    // that size now, in whatever bundle.
    const mine = new Set(bundles.filter((b) => lineIds.has(b.moLineId)).map((b) => b.id))
    const ofSize = (r: BalanceRow) => (line.sizeId ? (leftOfSize.get(`${keyOf(r)}|${line.sizeId}`) ?? 0) : Infinity)
    const want: WipBucket = line.grade === 'B' ? 'B_GRADE' : 'DONE'
    // Done pieces first; at a working last step (packing), pieces in hand after.
    const handIds = new Set(last.filter(sendsFromHand).map((s) => s.id))
    const rank = (r: BalanceRow) => (r.bucket === 'WIP' ? 1 : 0)
    const sources: BalanceRow[] = held
      .filter(
        (r) =>
          !r.vendorId &&
          mine.has(r.bundleId) &&
          ofSize(r) > 0 &&
          (want === 'B_GRADE' ? r.bucket === 'B_GRADE' : (r.bucket === 'DONE' && lastIds.has(r.stepId)) || (r.bucket === 'WIP' && handIds.has(r.stepId))),
      )
      .sort((x, y) => rank(x) - rank(y) || (bundleNo.get(x.bundleId) ?? 0) - (bundleNo.get(y.bundleId) ?? 0))
    let need = Math.round(line.qty)
    for (const r of sources) {
      if (need <= 0) break
      const k = keyOf(r)
      const take = Math.min(need, left.get(k) ?? 0, ofSize(r))
      if (take <= 0) continue
      left.set(k, (left.get(k) ?? 0) - take)
      if (line.sizeId) leftOfSize.set(`${k}|${line.sizeId}`, ofSize(r) - take)
      // Packed in the size booked: what the order's sizes, the stock and the garments go by.
      const sizeId = line.sizeId ?? undefined
      moves.push(
        { stepId: r.stepId, bundleId: r.bundleId, bucket: r.bucket, qty: -take, sizeId },
        { stepId: r.stepId, bundleId: r.bundleId, bucket: want === 'B_GRADE' ? 'PACKED_B' : 'PACKED', qty: take, sizeId },
      )
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

// ─── Size changes (size jumps at stitching) ───────────────────

/**
 * A count-in with the pieces made as another size there, in one go — the Count
 * in window at stitching. Counted in first, then the size change by the same
 * rules as Change sizes on the sheet; inside the caller's transaction, so a
 * size change that is refused takes the count back with it.
 */
export async function receiveWithSizes(tx: Tx, transferId: string, d: z.infer<typeof receiveSchema>, userId: string) {
  const r = await receive(tx, transferId, d, userId)
  const lines = d.sizeChanges?.lines.filter((l) => l.qty > 0) ?? []
  if (r.duplicate || !lines.length) return { ...r, sizes: null }
  const t = await tx.processTransfer.findUniqueOrThrow({ where: { id: transferId }, select: { moId: true, toStepId: true } })
  const sizes = await changeSizes(
    tx,
    t.moId,
    sizeChangeSchema.parse({ stepId: t.toStepId, lines, reason: d.sizeChanges!.reason, personName: d.receivedBy ?? null, eventDate: d.receivedAt, notes: d.notes ?? null }),
    userId,
  )
  return { ...r, sizes }
}

export const sizeChangeSchema = z.object({
  stepId: z.string().min(1, 'Say which step'),
  /** Each bundle, the size its pieces are made as, and how many. */
  lines: z
    .array(z.object({ bundleId: z.string().min(1), toSizeId: z.string().min(1, 'Pick the size they are made as'), qty: pcs }))
    .min(1, 'Pick the pieces made as another size'),
  reason: reasonText,
  personName: person,
  eventDate: z.coerce.date().optional(),
  notes: note,
  clientKey,
})

/**
 * A size jump: pieces of a bundle made as another size of the order at
 * stitching (cut as M, made as L). They stay in their own bundle — the floor
 * works bundle by bundle from the stickers made at cutting, so the bundle count
 * and the stickers stay as cut (12 Nov 2026; before, a new bundle was made for
 * them). On the ledger the pieces go out of the size they were cut in and into
 * the new one, where they lie, so a bundle can hold two sizes from here on; one
 * whose every piece changed is simply the new size now, with the same number,
 * and its sticker can be printed again. Only at stitching done on our own floor,
 * only on pieces in hand or done there still in the size they were cut in
 * (pieces change size once), and only to a size on the order line. The order's
 * planned sizes are never edited, and nothing is posted to stock: finished
 * goods take the pieces by the size they are made as when they are packed.
 */
export async function changeSizes(tx: Tx, moId: string, d: z.infer<typeof sizeChangeSchema>, userId: string) {
  const mo = await openMo(tx, moId)
  if (await seen(tx, d.clientKey)) {
    const ev = await tx.wipEvent.findUniqueOrThrow({ where: { clientKey: d.clientKey! }, select: { id: true } })
    return { eventId: ev.id, bundleIds: [] as string[], duplicate: true }
  }
  const step = stepOf(mo, d.stepId)
  if (step.kind !== 'STITCHING') throw new AppError(`Sizes change only at stitching, not at ${step.name}.`, 400, 'NOT_AT_STITCHING')
  if (step.execution !== 'IN_HOUSE') {
    throw new AppError(`${step.name} on ${mo.moNumber} is done by an outside unit; sizes change only where stitching is done on our own floor.`, 400, 'NOT_AT_STITCHING')
  }

  // One line per bundle and new size.
  const merged = new Map<string, { bundleId: string; toSizeId: string; qty: number }>()
  for (const l of d.lines) {
    if (l.qty <= 0) continue
    const k = `${l.bundleId}|${l.toSizeId}`
    const had = merged.get(k)
    merged.set(k, had ? { ...had, qty: had.qty + l.qty } : { ...l })
  }
  const lines = [...merged.values()]
  if (!lines.length) throw new AppError('Enter how many pieces of each bundle are made as another size.', 400, 'NOTHING_RECORDED')
  const ids = [...new Set(lines.map((l) => l.bundleId))]
  const bundles = await tx.productionBundle.findMany({
    where: { id: { in: ids }, moId },
    select: {
      id: true,
      code: true,
      moLineId: true,
      sizeId: true,
      size: { select: { code: true } },
      parent: { select: { code: true, size: { select: { code: true } } } },
    },
  })
  if (bundles.length !== ids.length) throw new AppError('One of those bundles is not on this order.', 400, 'BAD_BUNDLE')
  // A bundle made by a size change before 12 Nov 2026 holds pieces already made as another size: a
  // mistake there is undone, not changed again.
  const again = bundles.find((b) => b.parent)
  if (again) {
    throw new AppError(
      `${again.code} was made from ${again.parent!.code} (cut as ${again.parent!.size?.code ?? 'another size'}) by an earlier size change, so its pieces are already made as ${again.size?.code}. To correct it, undo that change.`,
      409,
      'ALREADY_CHANGED',
    )
  }
  if (new Set(bundles.map((b) => b.moLineId)).size > 1) throw new AppError('Change one job card’s sizes at a time: these bundles are of different colours.', 400, 'ONE_JOB_CARD')
  const byId = new Map(bundles.map((b) => [b.id, b]))
  const moLineId = bundles[0].moLineId
  const onOrder = new Map(
    (await tx.mOLineSize.findMany({ where: { moLineId }, select: { sizeId: true, size: { select: { code: true, sequence: true } } }, orderBy: { size: { sequence: 'asc' } } })).map((z) => [
      z.sizeId,
      z.size.code,
    ]),
  )
  for (const l of lines) {
    const b = byId.get(l.bundleId)!
    if (!b.sizeId) throw new AppError(`${b.code} has no size, so it cannot change size.`, 400, 'NO_SIZE')
    if (l.toSizeId === b.sizeId) throw new AppError(`${b.code} was cut as size ${b.size?.code}: pick another size for its pieces.`, 400, 'SAME_SIZE')
    if (!onOrder.has(l.toSizeId)) {
      throw new AppError(`Pieces can be made only as a size on the order: ${[...onOrder.values()].join(', ')}.`, 400, 'NOT_ON_ORDER')
    }
  }

  // Pieces that reached stitching past a step change nothing until their card is taken back.
  const cameIn = await tx.processTransfer.findMany({
    where: { moId, toStepId: step.id, isRework: false, status: { not: 'CANCELLED' }, lines: { some: { bundleId: { in: ids } } } },
    select: { transferNumber: true, fromStepId: true },
  })
  const cameWrong = cameIn.map((t) => ({ t, by: passedBy(mo.steps, t.fromStepId, step.id) })).find((x) => x.by.length)
  if (cameWrong) {
    throw new AppError(
      `${cameWrong.t.transferNumber} brought these pieces to ${step.name} past ${cameWrong.by.map((s) => s.name).join(', ')}. Take that card back first, then send the pieces on in the route's order.`,
      409,
      'TAKE_BACK_FIRST',
    )
  }

  // Pieces given to an outside unit for this step were stitched there, where sizes do not change.
  const viaUnit = await tx.processTransfer.findMany({
    where: { moId, toStepId: step.id, vendorId: { not: null }, status: { not: 'CANCELLED' }, lines: { some: { bundleId: { in: ids } } } },
    select: { transferNumber: true, vendor: { select: { name: true } }, lines: { select: { bundleId: true } } },
  })
  for (const t of viaUnit) {
    const b = t.lines.map((l) => byId.get(l.bundleId)).find(Boolean)
    if (b) {
      throw new AppError(
        `${b.code} was stitched by ${t.vendor?.name ?? 'an outside unit'} (${t.transferNumber}); sizes change only on pieces stitched on our own floor.`,
        409,
        'STITCHED_OUTSIDE',
      )
    }
  }

  // Each bundle's pieces here still in the size they were cut in: in hand first, then those done
  // and waiting to go on. Pieces already made as another size do not change again.
  const bySize = await sizeBalancesOf(tx, ids)
  const placeOf = (bundleId: string, bucket: 'WIP' | 'DONE') => keyOf({ stepId: step.id, vendorId: null, bucket, bundleId, reworkStepId: null })
  const left = new Map<string, number>()
  for (const b of bundles) for (const bucket of ['WIP', 'DONE'] as const) left.set(`${b.id}|${bucket}`, bySize.get(placeOf(b.id, bucket))?.get(b.sizeId) ?? 0)
  const asked = new Map<string, number>()
  for (const l of lines) asked.set(l.bundleId, (asked.get(l.bundleId) ?? 0) + l.qty)
  for (const [bundleId, n] of asked) {
    const b = byId.get(bundleId)!
    const there = (left.get(`${bundleId}|WIP`) ?? 0) + (left.get(`${bundleId}|DONE`) ?? 0)
    if (n > there) {
      throw new AppError(
        `${b.code}: ${there} in hand or done at ${step.name} still size ${b.size?.code ?? ''}, so ${n} is more than there is. Pieces already made as another size do not change again.`,
        409,
        'NOT_ENOUGH_PIECES',
      )
    }
  }
  const take = (bundleId: string, bucket: 'WIP' | 'DONE', want: number) => {
    const k = `${bundleId}|${bucket}`
    const n = Math.min(want, left.get(k) ?? 0)
    left.set(k, (left.get(k) ?? 0) - n)
    return n
  }

  // Out of the cut size, into the new one — in the same bundle, where the pieces lie.
  const moves: Move[] = []
  for (const l of lines) {
    const from = byId.get(l.bundleId)!
    const inHand = take(from.id, 'WIP', l.qty)
    const done = take(from.id, 'DONE', l.qty - inHand)
    moves.push(
      { stepId: step.id, bundleId: from.id, bucket: 'WIP', qty: -inHand, sizeId: from.sizeId },
      { stepId: step.id, bundleId: from.id, bucket: 'WIP', qty: inHand, sizeId: l.toSizeId },
      { stepId: step.id, bundleId: from.id, bucket: 'DONE', qty: -done, sizeId: from.sizeId },
      { stepId: step.id, bundleId: from.id, bucket: 'DONE', qty: done, sizeId: l.toSizeId },
    )
  }
  const event = await postEvent(tx, {
    moId,
    type: 'SIZE_CHANGE',
    stepId: step.id,
    reason: d.reason,
    personName: d.personName,
    eventDate: d.eventDate,
    notes: d.notes,
    clientKey: d.clientKey,
    createdById: userId,
    moves,
    shortMessage: (detail) => `${detail}, so that is more than is in hand there.`,
  })
  for (const l of lines) {
    const from = byId.get(l.bundleId)!
    await tx.sizeChange.create({
      data: {
        moId,
        moLineId,
        stepId: step.id,
        eventId: event.id,
        fromBundleId: from.id,
        fromSizeId: from.sizeId!,
        toSizeId: l.toSizeId,
        qty: l.qty,
        reason: d.reason,
        createdById: userId,
      },
    })
  }
  await syncProgress(tx, moId)

  // Whole bundles: none of their pieces left in the size they were cut in — the bundle is the new size
  // now, same number, and its sticker is printed again.
  const after = await sizeBalancesOf(tx, ids)
  const cutLeft = (b: (typeof bundles)[number]) => [...after.entries()].reduce((s, [k, at]) => s + (k.split('|')[3] === b.id ? (at.get(b.sizeId) ?? 0) : 0), 0)
  const whole = bundles.filter((b) => cutLeft(b) === 0)
  return {
    eventId: event.id,
    /** Bundles whose sticker is printed again: every piece of them changed size. */
    bundleIds: whole.map((b) => b.id),
    whole: whole.map((b) => b.code),
    duplicate: false,
    step: step.name,
    moves: lines.map((l) => {
      const b = byId.get(l.bundleId)!
      return { from: b.code, fromSize: b.size?.code ?? '', to: b.code, toSize: onOrder.get(l.toSizeId) ?? '', qty: l.qty }
    }),
  }
}

/**
 * Takes a size change back: the pieces go back into the bundles they came
 * from, while every one of them is still where the change put them. The new
 * bundles stay on record, marked undone.
 */
export async function undoSizeChange(tx: Tx, eventId: string, reason: string, userId: string) {
  const ev = await tx.wipEvent.findUnique({ where: { id: eventId }, select: { moId: true, type: true } })
  if (!ev || ev.type !== 'SIZE_CHANGE') throw new AppError('That size change was not found.', 404, 'NOT_FOUND')
  await openMo(tx, ev.moId)
  const out = await reverseEvent(tx, eventId, reason, userId)
  await tx.sizeChange.updateMany({ where: { eventId }, data: { undoneAt: new Date(), undoneById: userId, undoReason: reason } })
  await syncProgress(tx, ev.moId)
  return out
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
  if (ev.type === 'SIZE_CHANGE') return undoSizeChange(tx, eventId, reason, userId)
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
  const mo = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: moId }, select: { moNumber: true, heldAt: true, soId: true } })
  if (!mo.heldAt) throw new AppError(`${mo.moNumber} is not on hold.`, 409, 'NOT_HELD')
  await assertNotCancelling(tx, mo.soId, `${mo.moNumber} stays on hold`)
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
    // Done pieces made as another size here count as done in the size they
    // are made as; for a job card or an order the two sides cancel out.
    const completed =
      inOf(s.id, 'DONE', ['CUT', 'PROCESS', 'VENDOR_RETURN', 'REWORK_DONE', 'DECIDE', 'SIZE_CHANGE']) - outOf(s.id, 'DONE', ['DECIDE', 'SIZE_CHANGE']) + straightOn
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
