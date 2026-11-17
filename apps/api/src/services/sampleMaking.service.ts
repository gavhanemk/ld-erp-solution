/**
 * Making a sample cell by cell (phase 5): work at a step on our own floor,
 * hand-ons from one step to the next, an outside unit's job work on a
 * challan of the JW series, and each step's labour.
 *
 * Every action here runs inside actOnSample, under the request's row lock
 * and expected version, and leaves its event. Where pieces stand is summed
 * from the round's records by the shared ledger (sampleMaking.ts), the same
 * one the screen reads; an action is checked against the ledger as it would
 * be with the action applied, and the steps' own figures (done, rejected,
 * completed) are written back from it. Sample pieces are not stock: nothing
 * here moves stock.
 */
import type { Prisma } from '@prisma/client'
import type { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { nextDocumentNumber } from '../lib/docNumber'
import {
  cellKey,
  gridCells,
  jobOutstanding,
  makingLedger,
  makingProblems,
  qtyCells,
  type MakingCellKey,
  type MakingInput,
  type MakingQtyCell,
  type MakingStep,
} from '../../../../packages/shared/src/sampleMaking'
import { SAMPLE_REASON_MIN, type SampleSpecification } from '../../../../packages/shared/src/sampling'
import {
  sampleJobChargeSchema,
  sampleJobReturnSchema,
  sampleJobSendSchema,
  sampleLabourSchema,
  sampleMakingUndoSchema,
  sampleReceiveSchema,
  sampleSendSchema,
  sampleWorkSchema,
} from '../schemas/sampling.schemas'

type Tx = Prisma.TransactionClient
type When = Date | null
const n = (v: unknown) => Number(v)
const round3 = (v: number) => Math.round(v * 1000) / 1000
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
function fail(message: string, code = 'SAMPLE_RULE'): never {
  throw new AppError(message, 409, code)
}

/**
 * The making actions, each on the request's latest round; the costs (a
 * step's labour, a unit's charge) on any released round until handover.
 */
export const MAKING_ACTIONS = [
  'STEP_WORK',
  'STEP_SEND',
  'STEP_RECEIVE',
  'JOB_SEND',
  'JOB_RETURN',
  'STEP_LABOUR',
  'JOB_CHARGE',
  'MAKING_UNDO',
] as const
/** The making actions that put in a cost, open on any released round until handover. */
export const MAKING_COST_ACTIONS: readonly string[] = ['STEP_LABOUR', 'JOB_CHARGE']
export type MakingAction = (typeof MAKING_ACTIONS)[number]
export const isMakingAction = (a: string): a is MakingAction =>
  (MAKING_ACTIONS as readonly string[]).includes(a)

/** A round as sampleDetail reads it, as far as making needs. */
export interface MakingRound {
  id: string
  revision: number
  state: string
  qc: unknown
  handover: unknown
  releasedAt: Date | null
  specification: SampleSpecification
  stages: Array<{
    id: string
    sequence: number
    name: string
    execution: string
    departmentId: string | null
    vendorId: string | null
    wholeStep: boolean
    doneQty: number | null
    rejectedQty: number | null
    completedAt: When
    labourAmount: unknown
  }>
  materials: Array<{
    waivedAt: When
    issuedQty: unknown
    returnedQty: unknown
    plannedQty: unknown
    item: { name: string } | null
  }>
  works: Array<{ id: string; stageId: string; cells: unknown; undoneAt: When }>
  transfers: Array<{
    id: string
    fromStageId: string
    toStageId: string
    cells: unknown
    receivedCells: unknown
    sentOn: Date
    receivedOn: When
    undoneAt: When
  }>
  jobWorks: Array<{
    id: string
    number: string
    stageId: string
    cells: unknown
    sentOn: Date
    cancelledAt: When
    vendor: { name: string } | null
    returns: Array<{ id: string; cells: unknown; undoneAt: When; chargeAmount: unknown }>
  }>
}

const inputOf = (round: MakingRound): MakingInput => ({
  specification: round.specification,
  stages: round.stages,
  works: round.works,
  transfers: round.transfers,
  jobWorks: round.jobWorks,
})

/** Today as it is in the mill, and a day as text, for comparing dates. */
const dayText = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d)
const longDay = (d: Date) =>
  d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })

/**
 * The date a record is for: today when none is given. Never a day still to
 * come, nor before `after` (the round's release, or the hand-on or challan a
 * receipt is against).
 */
function dayOf(raw: string | undefined, after: Date | null, what: string): Date {
  if (!raw) return new Date()
  if (raw > dayText(new Date())) fail(`That date is still to come. Give the day the ${what} happened.`, 'BAD_DATE')
  if (after && raw < dayText(after))
    fail(`That is before ${longDay(after)}, when it could first have happened.`, 'BAD_DATE')
  return new Date(`${raw}T00:00:00.000Z`)
}

/**
 * Applies a set of records to the round's ledger: refuses them if the pieces
 * would not add up, else writes each step's own figures back (done,
 * rejected, completed) and returns the ledger as it now stands.
 */
async function settle(tx: Tx, round: MakingRound, next: MakingInput, sizeName: (id: string) => string) {
  const steps = makingLedger(next)
  const problems = makingProblems(next, sizeName, steps)
  if (problems.length) fail(problems[0], 'MAKING_ARITHMETIC')
  await writeBack(tx, round, steps)
  return steps
}
/**
 * The round's making as its records have it, with each step's own figures
 * written back first. QC reads it so: a step recorded whole that rejected
 * every piece leaves the steps after it done with nothing to record on them.
 */
export async function syncMaking(tx: Tx, round: MakingRound) {
  const steps = makingLedger(inputOf(round))
  await writeBack(tx, round, steps)
  return steps
}
async function writeBack(tx: Tx, round: MakingRound, steps: MakingStep[]) {
  for (const s of steps) {
    const stage = round.stages.find((x) => x.id === s.stageId)!
    // A whole step keeps what was recorded on it.
    if (stage.wholeStep) continue
    const known = s.started || s.complete
    const doneQty = known ? s.total.done : null
    const rejectedQty = known ? s.total.rejected : null
    const completedAt = s.complete ? (stage.completedAt ?? new Date()) : null
    if (
      stage.doneQty !== doneQty ||
      stage.rejectedQty !== rejectedQty ||
      (stage.completedAt?.getTime() ?? null) !== (completedAt?.getTime() ?? null)
    )
      await tx.sampleStage.update({
        where: { id: stage.id },
        data: { doneQty, rejectedQty, completedAt },
      })
  }
}

/**
 * Before the first step takes material into pieces: every line issued in
 * full, or waived, and none of it given back since.
 */
function assertMaterialIssued(round: MakingRound) {
  const live = round.materials.filter((m) => !m.waivedAt)
  if (live.some((m) => n(m.issuedQty) < n(m.plannedQty) - 1e-9))
    fail('Issue every planned material, or waive what is not needed, before making starts.', 'MATERIAL_NOT_ISSUED')
  const back = live.find((m) => round3(n(m.issuedQty) - n(m.returnedQty)) < n(m.plannedQty) - 1e-9)
  if (back)
    fail(
      `Keep the planned material issued while the first step is being made: some ${back.item?.name ?? 'material'} was given back. Issue it again first.`,
      'MATERIAL_NOT_ISSUED'
    )
}

export interface MakingContext {
  round: MakingRound
  /** The request's latest round: making is recorded on it alone (costs on any round). */
  latest: boolean
  /** A round of the request is handed over: its costs are frozen with everything else. */
  handedOver: boolean
  actor: { id: string; name: string }
  data: unknown
}

/** One making action. Returns what its event says. */
export async function actOnMaking(tx: Tx, action: MakingAction, ctx: MakingContext): Promise<unknown> {
  const { round, actor } = ctx
  if (round.handover) fail('This round is handed over; its record is frozen.')
  if (round.state === 'DRAFT') fail('Release the round before making starts.')
  const grid = gridCells(round.specification)
  const sizes = await tx.size.findMany({
    where: { id: { in: [...new Set(grid.map((g) => g.sizeId))] } },
    select: { id: true, code: true },
  })
  const sizeName = (id: string) => sizes.find((z) => z.id === id)?.code ?? 'a size no longer in use'
  const cellName = (c: MakingCellKey) => `${c.colour} · ${sizeName(c.sizeId)}`
  const stages = [...round.stages].sort((a, b) => a.sequence - b.sequence)
  const stageOf = (stageId: string) => {
    const s = stages.find((x) => x.id === stageId)
    if (!s) fail('That step is not on this round’s route.', 'NO_STEP')
    return s!
  }
  const first = stages[0]
  /** Cells as the grid spells them; a cell the grid lacks, or one given twice, is refused. */
  function onGrid<T extends MakingCellKey>(cells: T[]): T[] {
    const byKey = new Map(grid.map((g) => [cellKey(g), g]))
    const seen = new Set<string>()
    return cells.map((c) => {
      const g = byKey.get(cellKey(c))
      if (!g) fail(`${cellName(c)} is not in this round’s colours and sizes.`, 'NOT_IN_GRID')
      if (seen.has(cellKey(c))) fail(`${cellName(g!)} is given twice.`, 'NOT_IN_GRID')
      seen.add(cellKey(c))
      return { ...c, colour: g!.colour, sizeId: g!.sizeId }
    })
  }
  const pieces = (cells: Array<{ qty: number }>) => cells.reduce((t, c) => t + c.qty, 0)
  const ledger = makingLedger(inputOf(round))
  const stepAt = (steps: MakingStep[], stageId: string) => steps.find((s) => s.stageId === stageId)!
  const cellAt = (step: MakingStep, c: MakingCellKey) => step.cells.find((x) => cellKey(x) === cellKey(c))!

  // A cost, typed once the bill is known: on any released round until handover.
  if (MAKING_COST_ACTIONS.includes(action) && ctx.handedOver)
    fail('This request has a production handover. Its costs are now frozen.')
  if (action === 'JOB_CHARGE') {
    const d = sampleJobChargeSchema.parse(ctx.data)
    const job = round.jobWorks.find(
      (j) => !j.cancelledAt && j.returns.some((r) => r.id === d.returnId && !r.undoneAt)
    )
    if (!job) fail('That receipt is not on this round, or is taken back.', 'NOT_FOUND')
    const ret = job!.returns.find((r) => r.id === d.returnId)!
    await tx.sampleJobReturn.update({ where: { id: ret.id }, data: { chargeAmount: d.chargeAmount } })
    return {
      stage: stageOf(job!.stageId).name,
      number: job!.number,
      charge: d.chargeAmount,
      was: n(ret.chargeAmount),
      reason: d.reason,
    }
  }
  if (action === 'STEP_LABOUR') {
    const d = sampleLabourSchema.parse(ctx.data)
    const stage = stageOf(d.stageId)
    await tx.sampleStage.update({
      where: { id: stage.id },
      data: { labourAmount: d.amount, labourNote: d.note || null },
    })
    return { stage: stage.name, amount: d.amount, was: n(stage.labourAmount), note: d.note }
  }

  if (!ctx.latest) fail('Only the latest sample round can be changed.')
  if (round.state !== 'RELEASED')
    fail('This round’s making is closed: it has gone on to QC and the buyer.', 'MAKING_CLOSED')
  if (round.qc)
    fail('QC is recorded on this round, so its making is closed. Start a correction round to make it again.', 'MAKING_CLOSED')

  switch (action) {
    case 'STEP_WORK': {
      const d = sampleWorkSchema.parse(ctx.data)
      const stage = stageOf(d.stageId)
      if (stage.execution === 'OUTSOURCED')
        fail(`${stage.name} is done outside: send its pieces to the unit, then record what comes back.`, 'OUTSIDE_STEP')
      if (stage.wholeStep) fail(`${stage.name} was recorded whole; nothing more is recorded on it.`)
      const cells = onGrid(d.cells).filter((c) => c.done + c.rejected > 0)
      if (!cells.length) fail('Say how many pieces were done or rejected.', 'NO_PIECES')
      const rejected = cells.reduce((t, c) => t + c.rejected, 0)
      if (rejected > 0 && d.notes.length < SAMPLE_REASON_MIN)
        fail('Say what was wrong with the rejected pieces.', 'REASON_REQUIRED')
      if (stage.id === first.id) assertMaterialIssued(round)
      const step = stepAt(ledger, stage.id)
      const before = stages[stages.indexOf(stage) - 1]
      for (const c of cells) {
        const at = cellAt(step, c)
        if (c.done + c.rejected > at.here)
          fail(
            at.here > 0
              ? `Only ${at.here} of ${cellName(c)} ${at.here === 1 ? 'is' : 'are'} at ${stage.name} to work on.`
              : at.coming > 0
                ? `${at.coming} of ${cellName(c)} ${at.coming === 1 ? 'is' : 'are'} on the way from ${before?.name ?? 'the step before'}: count ${at.coming === 1 ? 'it' : 'them'} in first.`
                : `No ${cellName(c)} pieces are at ${stage.name} to work on.`,
            'NOT_HERE'
          )
      }
      const workedOn = dayOf(d.workedOn, round.releasedAt, 'work')
      await settle(
        tx,
        round,
        { ...inputOf(round), works: [...round.works, { id: '', stageId: stage.id, cells, undoneAt: null }] },
        sizeName
      )
      await tx.sampleWork.create({
        data: {
          roundId: round.id,
          stageId: stage.id,
          cells: json(cells),
          doneBy: d.doneBy,
          workedOn,
          notes: d.notes || null,
          createdById: actor.id,
        },
      })
      return {
        stage: stage.name,
        done: cells.reduce((t, c) => t + c.done, 0),
        rejected,
        cells,
        doneBy: d.doneBy,
        notes: d.notes,
      }
    }
    case 'STEP_SEND': {
      const d = sampleSendSchema.parse(ctx.data)
      const from = stageOf(d.fromStageId)
      const to = stages[stages.indexOf(from) + 1]
      if (!to) fail(`${from.name} is the last step: its finished pieces go to QC.`, 'LAST_STEP')
      if (to.execution === 'OUTSOURCED')
        fail(`${to.name} is done outside: send the pieces to the unit on a job-work challan.`, 'OUTSIDE_STEP')
      const cells = onGrid(d.cells).filter((c) => c.qty > 0)
      if (!cells.length) fail('Say how many pieces go on.', 'NO_PIECES')
      const step = stepAt(ledger, from.id)
      for (const c of cells) {
        const at = cellAt(step, c)
        if (c.qty > at.ready)
          fail(
            at.ready > 0
              ? `Only ${at.ready} of ${cellName(c)} ${at.ready === 1 ? 'is' : 'are'} done at ${from.name} and not handed on yet.`
              : `No ${cellName(c)} pieces are done at ${from.name} to hand on.`,
            'NOT_READY'
          )
      }
      const sentOn = dayOf(d.sentOn, round.releasedAt, 'hand-on')
      // One department's own steps: no one else counts them in.
      const sameDepartment = (from.departmentId ?? null) === (to.departmentId ?? null)
      await settle(
        tx,
        round,
        {
          ...inputOf(round),
          transfers: [
            ...round.transfers,
            {
              id: '',
              fromStageId: from.id,
              toStageId: to.id,
              cells,
              receivedCells: sameDepartment ? cells : null,
              undoneAt: null,
            },
          ],
        },
        sizeName
      )
      await tx.sampleTransfer.create({
        data: {
          roundId: round.id,
          fromStageId: from.id,
          toStageId: to.id,
          cells: json(cells),
          sentBy: d.sentBy,
          sentOn,
          notes: d.notes || null,
          createdById: actor.id,
          ...(sameDepartment
            ? { receivedCells: json(cells), receivedBy: d.sentBy, receivedOn: sentOn }
            : {}),
        },
      })
      return {
        from: from.name,
        to: to.name,
        pieces: pieces(cells),
        cells,
        sentBy: d.sentBy,
        received: sameDepartment,
      }
    }
    case 'STEP_RECEIVE': {
      const d = sampleReceiveSchema.parse(ctx.data)
      const t = round.transfers.find((x) => x.id === d.transferId && !x.undoneAt)
      if (!t) fail('That hand-on is not on this round.', 'NO_TRANSFER')
      if (t!.receivedOn) fail('Those pieces are already counted in.', 'ALREADY_RECEIVED')
      const sent = qtyCells(t!.cells)
      const given = onGrid(d.cells)
      for (const c of given)
        if (!sent.some((s) => cellKey(s) === cellKey(c)) && c.qty > 0)
          fail(`No ${cellName(c)} pieces were sent on that hand-on.`, 'NOT_SENT')
      // Every cell sent is counted: one left out came to nothing.
      const counted: MakingQtyCell[] = sent.map((s) => ({
        ...s,
        qty: given.find((c) => cellKey(c) === cellKey(s))?.qty ?? 0,
      }))
      for (const [i, c] of counted.entries())
        if (c.qty > sent[i].qty)
          fail(`Only ${sent[i].qty} of ${cellName(c)} ${sent[i].qty === 1 ? 'was' : 'were'} sent.`, 'MORE_THAN_SENT')
      const short = pieces(sent) - pieces(counted)
      if (short > 0 && d.shortReason.length < SAMPLE_REASON_MIN)
        fail('Say why fewer pieces arrived than were sent.', 'REASON_REQUIRED')
      const receivedOn = dayOf(d.receivedOn, t!.sentOn, 'count')
      await settle(
        tx,
        round,
        {
          ...inputOf(round),
          transfers: round.transfers.map((x) => (x.id === t!.id ? { ...x, receivedCells: counted } : x)),
        },
        sizeName
      )
      await tx.sampleTransfer.update({
        where: { id: t!.id },
        data: {
          receivedCells: json(counted),
          receivedBy: d.receivedBy,
          receivedOn,
          shortReason: short > 0 ? d.shortReason : null,
        },
      })
      return {
        from: stageOf(t!.fromStageId).name,
        to: stageOf(t!.toStageId).name,
        pieces: pieces(counted),
        short,
        cells: counted,
        receivedBy: d.receivedBy,
        shortReason: short > 0 ? d.shortReason : '',
      }
    }
    case 'JOB_SEND': {
      const d = sampleJobSendSchema.parse(ctx.data)
      const stage = stageOf(d.stageId)
      if (stage.execution !== 'OUTSOURCED')
        fail(`${stage.name} is done on our own floor: hand the pieces on to it instead.`, 'NOT_OUTSIDE')
      if (stage.wholeStep) fail(`${stage.name} was recorded whole; nothing more is recorded on it.`)
      const vendor = await tx.supplier.findFirst({
        where: { id: d.vendorId, isActive: true },
        select: { id: true, name: true },
      })
      if (!vendor) fail('Pick an active outside unit.', 'BAD_VENDOR')
      const cells = onGrid(d.cells).filter((c) => c.qty > 0)
      if (!cells.length) fail('Say how many pieces go out.', 'NO_PIECES')
      const step = stepAt(ledger, stage.id)
      const before = stages[stages.indexOf(stage) - 1]
      for (const c of cells) {
        const at = cellAt(step, c)
        if (c.qty > at.toSend)
          fail(
            !before
              ? `Only ${at.toSend} of ${cellName(c)} ${at.toSend === 1 ? 'is' : 'are'} still to go out for ${stage.name}.`
              : at.toSend > 0
                ? `Only ${at.toSend} of ${cellName(c)} ${at.toSend === 1 ? 'is' : 'are'} done at ${before.name} and not sent on yet.`
                : `No ${cellName(c)} pieces are done at ${before.name} to send out.`,
            'NOT_READY'
          )
      }
      if (stage.id === first.id) assertMaterialIssued(round)
      const sentOn = dayOf(d.sentOn, round.releasedAt, 'dispatch')
      if (d.expectedBack && d.expectedBack < dayText(sentOn))
        fail('The day it is due back is before it goes out.', 'BAD_DATE')
      await settle(
        tx,
        round,
        {
          ...inputOf(round),
          jobWorks: [
            ...round.jobWorks,
            { id: '', stageId: stage.id, cells, cancelledAt: null, returns: [] },
          ],
        },
        sizeName
      )
      // The job-work series, one run with the floor's and the store's challans.
      const number = await nextDocumentNumber(tx, 'JW', sentOn)
      const job = await tx.sampleJobWork.create({
        data: {
          number,
          roundId: round.id,
          stageId: stage.id,
          vendorId: vendor!.id,
          cells: json(cells),
          sentBy: d.sentBy,
          sentOn,
          expectedBack: d.expectedBack ? new Date(`${d.expectedBack}T00:00:00.000Z`) : null,
          vehicleNo: d.vehicleNo || null,
          declaredValue: d.declaredValue,
          notes: d.notes || null,
          createdById: actor.id,
        },
      })
      return {
        stage: stage.name,
        jobWorkId: job.id,
        number,
        vendor: vendor!.name,
        pieces: pieces(cells),
        cells,
        sentBy: d.sentBy,
      }
    }
    case 'JOB_RETURN': {
      const d = sampleJobReturnSchema.parse(ctx.data)
      const job = round.jobWorks.find((j) => j.id === d.jobWorkId)
      if (!job) fail('That challan is not on this round.', 'NO_CHALLAN')
      if (job!.cancelledAt) fail(`${job!.number} was cancelled; nothing comes back on it.`, 'CHALLAN_CANCELLED')
      const stage = stageOf(job!.stageId)
      const out = jobOutstanding(job!)
      const cells = onGrid(d.cells).filter((c) => c.accepted + c.rejected > 0)
      if (!cells.length) fail('Say how many pieces came back.', 'NO_PIECES')
      for (const c of cells) {
        const o = out.find((x) => cellKey(x) === cellKey(c))
        if (!o) fail(`No ${cellName(c)} pieces went out on ${job!.number}.`, 'NOT_SENT')
        if (c.accepted + c.rejected > o!.out)
          fail(
            o!.out > 0
              ? `Only ${o!.out} of ${cellName(c)} ${o!.out === 1 ? 'is' : 'are'} still out on ${job!.number}.`
              : `All of ${cellName(c)} on ${job!.number} is back already.`,
            'NOT_OUT'
          )
      }
      const rejected = cells.reduce((t, c) => t + c.rejected, 0)
      if (rejected > 0 && d.notes.length < SAMPLE_REASON_MIN)
        fail('Say what was wrong with the rejected pieces, or that they did not come back.', 'REASON_REQUIRED')
      const receivedOn = dayOf(d.receivedOn, job!.sentOn, 'receipt')
      await settle(
        tx,
        round,
        {
          ...inputOf(round),
          jobWorks: round.jobWorks.map((j) =>
            j.id === job!.id ? { ...j, returns: [...j.returns, { id: '', cells, undoneAt: null }] } : j
          ),
        },
        sizeName
      )
      await tx.sampleJobReturn.create({
        data: {
          jobWorkId: job!.id,
          cells: json(cells),
          theirChallanNo: d.theirChallanNo || null,
          receivedBy: d.receivedBy,
          receivedOn,
          chargeAmount: d.chargeAmount,
          notes: d.notes || null,
          createdById: actor.id,
        },
      })
      return {
        stage: stage.name,
        number: job!.number,
        vendor: job!.vendor?.name ?? null,
        accepted: cells.reduce((t, c) => t + c.accepted, 0),
        rejected,
        cells,
        charge: d.chargeAmount,
        theirChallanNo: d.theirChallanNo,
        receivedBy: d.receivedBy,
      }
    }
    case 'MAKING_UNDO': {
      const d = sampleMakingUndoSchema.parse(ctx.data)
      const now = new Date()
      let next: MakingInput
      let said: Record<string, unknown>
      let refused: string
      let write: () => Promise<unknown>
      const undone = { undoneAt: now, undoneBy: actor.name, undoneReason: d.reason }
      if (d.kind === 'WORK') {
        const w = round.works.find((x) => x.id === d.id && !x.undoneAt)
        if (!w) fail('That work is not on this round, or is taken back already.', 'NOT_FOUND')
        const stage = stageOf(w!.stageId)
        next = { ...inputOf(round), works: round.works.map((x) => (x.id === w!.id ? { ...x, undoneAt: now } : x)) }
        said = { kind: d.kind, stage: stage.name, cells: w!.cells }
        refused = `Some of those pieces have gone on from ${stage.name} since. Take that hand-on back first.`
        write = () => tx.sampleWork.update({ where: { id: w!.id }, data: undone })
      } else if (d.kind === 'TRANSFER') {
        const t = round.transfers.find((x) => x.id === d.id && !x.undoneAt)
        if (!t) fail('That hand-on is not on this round, or is taken back already.', 'NOT_FOUND')
        const to = stageOf(t!.toStageId)
        next = {
          ...inputOf(round),
          transfers: round.transfers.map((x) => (x.id === t!.id ? { ...x, undoneAt: now } : x)),
        }
        said = { kind: d.kind, from: stageOf(t!.fromStageId).name, to: to.name, cells: t!.cells }
        refused = `Some of those pieces have been worked at ${to.name} since. Take that work back first.`
        write = () => tx.sampleTransfer.update({ where: { id: t!.id }, data: undone })
      } else if (d.kind === 'JOB_SEND') {
        const j = round.jobWorks.find((x) => x.id === d.id && !x.cancelledAt)
        if (!j) fail('That challan is not on this round, or is cancelled already.', 'NOT_FOUND')
        if (j!.returns.some((r) => !r.undoneAt))
          fail(`Pieces have come back on ${j!.number}. Take those receipts back first.`, 'HAS_RETURNS')
        next = {
          ...inputOf(round),
          jobWorks: round.jobWorks.map((x) => (x.id === j!.id ? { ...x, cancelledAt: now } : x)),
        }
        said = { kind: d.kind, stage: stageOf(j!.stageId).name, number: j!.number, cells: j!.cells }
        refused = 'Those pieces cannot be taken back now.'
        write = () =>
          tx.sampleJobWork.update({
            where: { id: j!.id },
            data: { cancelledAt: now, cancelledBy: actor.name, cancelReason: d.reason },
          })
      } else {
        const j = round.jobWorks.find((x) => !x.cancelledAt && x.returns.some((r) => r.id === d.id && !r.undoneAt))
        if (!j) fail('That receipt is not on this round, or is taken back already.', 'NOT_FOUND')
        const stage = stageOf(j!.stageId)
        next = {
          ...inputOf(round),
          jobWorks: round.jobWorks.map((x) =>
            x.id === j!.id
              ? { ...x, returns: x.returns.map((r) => (r.id === d.id ? { ...r, undoneAt: now } : r)) }
              : x
          ),
        }
        said = {
          kind: d.kind,
          stage: stage.name,
          number: j!.number,
          cells: j!.returns.find((r) => r.id === d.id)!.cells,
        }
        refused = `Some of those pieces have gone on from ${stage.name} since. Take that hand-on back first.`
        write = () => tx.sampleJobReturn.update({ where: { id: d.id }, data: undone })
      }
      if (makingProblems(next, sizeName).length) fail(refused, 'UNDO_BLOCKED')
      await settle(tx, round, next, sizeName)
      await write()
      return { ...said, reason: d.reason }
    }
  }
  return null
}
