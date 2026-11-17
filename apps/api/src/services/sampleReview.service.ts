/**
 * QC, the buyer's samples and the buyer's word, colour by colour (phase 6):
 * QC, DISPATCH (a Sample Delivery Challan of the SDC series),
 * DISPATCH_CANCEL and DECIDE. Each runs inside actOnSample, under the
 * request's row lock and expected version, and leaves its event. Where each
 * colour stands is read by the shared colourOutcomes (sampleReview.ts), the
 * same one the screen reads. Samples are not stock and not a sale: nothing
 * here moves stock or bills anything.
 */
import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { nextDocumentNumber } from '../lib/docNumber'
import {
  cellKey,
  colourKey,
  colourOutcomes,
  normaliseDecision,
  pointsFor,
  roundVerdict,
  SAMPLE_CHANGES_MIN,
  withinTolerance,
  type SampleColourDecision,
  type SampleDecision,
  type SampleQc,
  type SampleQcColour,
  type SampleSpecification,
} from '@ld-erp/shared'
import {
  sampleDecisionSchema,
  sampleDropColourSchema,
  sampleDispatchCancelSchema,
  sampleDispatchSchema,
  sampleQcSchema,
} from '../schemas/sampling.schemas'
import { dayOf, dayText, gridTools, syncMaking, type MakingRound } from './sampleMaking.service'

type Tx = Prisma.TransactionClient
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
function fail(message: string, code = 'SAMPLE_RULE'): never {
  throw new AppError(message, 409, code)
}
const pieces = (cells: Array<{ qty: number }>) => cells.reduce((t, c) => t + c.qty, 0)

export const REVIEW_ACTIONS = ['QC', 'DISPATCH', 'DISPATCH_CANCEL', 'DECIDE', 'DROP_COLOUR'] as const
export type ReviewAction = (typeof REVIEW_ACTIONS)[number]

/** A round as sampleDetail reads it, as far as review needs. */
export interface ReviewRound extends MakingRound {
  submission: unknown
  decision: unknown
  dispatches: Array<{ id: string; number: string; cells: unknown; cancelledAt: Date | null }>
}
export interface ReviewContext {
  round: ReviewRound
  actor: { id: string; name: string }
  data: unknown
}

/**
 * Writes the round's decision with `given` in it, and its verdict once every
 * colour that passed QC has a word (the round's state follows it).
 */
async function decideRound(tx: Tx, round: ReviewRound, decision: SampleDecision, actor: { name: string }) {
  const verdict = roundVerdict(colourOutcomes({ ...round, decision }))
  const last = Object.values(decision.colours).filter((x) => x.buyerName).at(-1)
  const final = verdict
    ? {
        result: verdict,
        buyerName: last?.buyerName ?? '',
        evidence: last?.evidence ?? '',
        conditions: Object.values(decision.colours)
          .filter((x) => x.result === 'CHANGES_REQUIRED' && x.conditions)
          .map((x) => `${x.colour}: ${x.conditions}`)
          .join('\n'),
        at: new Date(),
        recordedBy: actor.name,
      }
    : {}
  await tx.sampleRound.update({
    where: { id: round.id },
    data: { decision: json({ ...decision, ...final }), ...(verdict ? { state: verdict } : {}) },
  })
  return verdict
}

/** One review action on the latest round. Returns what its event says. */
export async function actOnReview(tx: Tx, action: ReviewAction, ctx: ReviewContext): Promise<unknown> {
  const { round, actor } = ctx
  const spec = round.specification as SampleSpecification
  const live = round.dispatches.filter((d) => !d.cancelledAt)
  if (round.handover) fail('This round is handed over; its record is frozen.')
  // Any colour with a word on it, the buyer's or dropped.
  const decided = Object.keys(normaliseDecision(round.decision, spec)?.colours ?? {}).length > 0
  switch (action) {
    case 'QC': {
      // The first inspection once making is done; again while it has failed,
      // or passed with nothing yet sent on it and no colour decided.
      const again =
        round.state === 'QC_FAILED' || (round.state === 'QC_PASSED' && !live.length && !decided)
      if (round.state !== 'RELEASED' && !again)
        fail(
          round.state === 'QC_PASSED' || round.state === 'SUBMITTED'
            ? 'Samples have gone to the buyer, or a colour is decided, on this inspection, so it stands.'
            : 'Complete the making route before recording QC.',
          'QC_CLOSED'
        )
      // As the round's records have it (sampleMaking), each step's figures written back.
      const made = await syncMaking(tx, round)
      if (!made.length || made.some((s) => !s.complete))
        fail('Complete the making route before recording QC.')
      const finished = made.at(-1)!.cells.filter((c) => c.done > 0)
      const { sizeName } = await gridTools(tx, spec)
      const d = sampleQcSchema.parse(ctx.data)
      // A size made with no point to measure it on (a round from before every
      // size was measured) cannot be judged within tolerance.
      for (const f of finished)
        if (!pointsFor(spec, [f.sizeId]).length)
          fail(
            `Size ${sizeName(f.sizeId)} has no measurement points in this round’s specification, so it cannot be inspected. Start a new round with its measurements.`,
            'QC_READINGS'
          )
      const given = new Map<string, (typeof d.colours)[number]>()
      for (const c of d.colours) {
        const key = colourKey(c.colour)
        if (given.has(key)) fail(`${c.colour} is inspected twice.`, 'QC_COLOURS')
        if (!finished.some((f) => colourKey(f.colour) === key))
          fail(`${c.colour} has no finished pieces to inspect in this round.`, 'QC_COLOURS')
        given.set(key, c)
      }
      // Every colour that finished pieces is inspected, in the grid's order.
      const names = [...new Map(finished.map((f) => [colourKey(f.colour), f.colour])).values()]
      const colours: SampleQcColour[] = names.map((colour) => {
        const c = given.get(colourKey(colour))
        const cells = finished.filter((f) => colourKey(f.colour) === colourKey(colour))
        if (!c)
          fail(`Inspect ${colour} too: ${pieces(cells.map((f) => ({ qty: f.done })))} of it finished.`, 'QC_COLOURS')
        const points = pointsFor(spec, cells.map((f) => f.sizeId))
        if (c!.actuals.length !== points.length)
          fail(
            `Measure every point of ${colour}: ${points.length} reading${points.length === 1 ? '' : 's'} for the sizes it finished.`,
            'QC_READINGS'
          )
        const seen = new Set<string>()
        for (const z of c!.cells) {
          if (seen.has(z.sizeId)) fail(`${colour} · ${sizeName(z.sizeId)} is given twice.`, 'QC_CELLS')
          seen.add(z.sizeId)
          if (!cells.some((f) => f.sizeId === z.sizeId))
            fail(`${colour} has no finished pieces in size ${sizeName(z.sizeId)}.`, 'QC_CELLS')
        }
        const inspected = cells.map((f) => {
          const z = c!.cells.find((x) => x.sizeId === f.sizeId)
          if (!z) fail(`Say how many of ${colour} · ${sizeName(f.sizeId)} passed.`, 'QC_CELLS')
          if (z!.passed > f.done)
            fail(`Only ${f.done} of ${colour} · ${sizeName(f.sizeId)} finished.`, 'QC_CELLS')
          return { sizeId: f.sizeId, finished: f.done, passed: z!.passed }
        })
        const results = points.map((m, i) => ({
          ...m,
          colour,
          actual: c!.actuals[i],
          pass: withinTolerance(m, c!.actuals[i]),
        }))
        return {
          colour,
          // Every point within tolerance, and something to send.
          passed: results.every((r) => r.pass) && inspected.some((z) => z.passed > 0),
          results,
          cells: inspected,
          notes: c!.notes,
        }
      })
      const passed = colours.some((c) => c.passed)
      const qc: SampleQc = {
        passed,
        passedQty: colours
          .filter((c) => c.passed)
          .reduce((t, c) => t + c.cells.reduce((s, z) => s + z.passed, 0), 0),
        notes: d.notes,
        by: actor.name,
        at: new Date(),
        colours,
        results: colours.flatMap((c) => c.results),
      }
      await tx.sampleRound.update({
        where: { id: round.id },
        data: { qc: json(qc), state: passed ? 'QC_PASSED' : 'QC_FAILED' },
      })
      return {
        notes: d.notes,
        passed,
        passedQty: qc.passedQty,
        colours: colours.map((c) => ({
          colour: c.colour,
          passed: c.passed,
          pieces: c.cells.reduce((s, z) => s + z.passed, 0),
        })),
      }
    }
    case 'DISPATCH': {
      if (round.state !== 'QC_PASSED' && round.state !== 'SUBMITTED')
        fail('Pass QC before sending samples to the buyer.', 'NOT_READY_TO_SEND')
      const d = sampleDispatchSchema.parse(ctx.data)
      const { cellName, onGrid } = await gridTools(tx, spec)
      const outcomes = colourOutcomes(round)
      const cells = onGrid(d.cells).filter((c) => c.qty > 0)
      if (!cells.length) fail('Say how many pieces go.', 'NO_PIECES')
      for (const c of cells) {
        const o = outcomes.find((x) => x.key === colourKey(c.colour))!
        if (o.qc !== 'PASSED')
          fail(`${o.colour} did not pass QC: it is made again in the next round.`, 'NOT_PASSED')
        if (o.decision) fail(`The buyer has decided on ${o.colour} already.`, 'DECIDED')
        const left = o.toSend.find((x) => cellKey(x) === cellKey(c))?.qty ?? 0
        if (c.qty > left)
          fail(
            left > 0
              ? `Only ${left} of ${cellName(c)} passed QC and ${left === 1 ? 'is' : 'are'} not sent yet.`
              : `No ${cellName(c)} pieces are left to send.`,
            'NOT_TO_SEND'
          )
      }
      const sentOn = dayOf(d.sentOn, round.releasedAt, 'dispatch')
      if (d.expectedBack && d.expectedBack < dayText(sentOn))
        fail('The day they are due back is before they go.', 'BAD_DATE')
      // The Sample Delivery Challan's own series.
      const number = await nextDocumentNumber(tx, 'SDC', sentOn)
      await tx.sampleDispatch.create({
        data: {
          number,
          roundId: round.id,
          cells: json(cells),
          recipient: d.recipient,
          address: d.address || null,
          mode: d.mode,
          courier: d.courier || null,
          awb: d.awb || null,
          sentOn,
          returnable: d.returnable,
          expectedBack: d.expectedBack ? new Date(`${d.expectedBack}T00:00:00.000Z`) : null,
          declaredValue: d.declaredValue,
          courierCharge: d.courierCharge,
          notes: d.notes || null,
          createdById: actor.id,
        },
      })
      if (round.state === 'QC_PASSED')
        await tx.sampleRound.update({ where: { id: round.id }, data: { state: 'SUBMITTED' } })
      return {
        number,
        recipient: d.recipient,
        mode: d.mode,
        courier: d.courier,
        awb: d.awb,
        pieces: pieces(cells),
        cells,
      }
    }
    case 'DISPATCH_CANCEL': {
      if (round.state !== 'SUBMITTED')
        fail('Only a challan of a round with the buyer is cancelled; once the buyer has decided, it stands.')
      const d = sampleDispatchCancelSchema.parse(ctx.data)
      const disp = live.find((x) => x.id === d.dispatchId)
      if (!disp) fail('That challan is not on this round, or is cancelled already.', 'NOT_FOUND')
      const outcomes = colourOutcomes(round)
      const sent = new Set((disp!.cells as Array<{ colour: string }>).map((c) => colourKey(c.colour)))
      const onIt = outcomes.find((o) => sent.has(o.key) && o.decision)
      if (onIt) fail(`The buyer has decided on ${onIt.colour}; its challan stands.`, 'DECIDED')
      await tx.sampleDispatch.update({
        where: { id: disp!.id },
        data: { cancelledAt: new Date(), cancelledBy: actor.name, cancelReason: d.reason },
      })
      // Nothing left with the buyer and nothing decided: back to ready to send.
      if (live.length === 1 && !round.submission && !decided)
        await tx.sampleRound.update({ where: { id: round.id }, data: { state: 'QC_PASSED' } })
      return { number: disp!.number, reason: d.reason }
    }
    case 'DROP_COLOUR': {
      // Not to go on with: not sent and not wanted after all, or failed QC and
      // not to be made again. Ours, not the buyer's word.
      if (round.state !== 'QC_PASSED' && round.state !== 'SUBMITTED')
        fail('A colour is dropped once QC is recorded, while the round waits on the buyer.', 'NOT_WITH_BUYER')
      const d = sampleDropColourSchema.parse(ctx.data)
      const o = colourOutcomes(round).find((x) => x.key === colourKey(d.colour))
      if (!o) fail(`${d.colour} is not one of this round’s colours.`, 'NOT_IN_GRID')
      if (o!.decision)
        fail(
          o!.decision.result === 'DROPPED'
            ? `${o!.colour} is dropped already.`
            : `The buyer has decided on ${o!.colour}; that stands.`,
          'DECIDED'
        )
      const decision = normaliseDecision(round.decision, spec) ?? { colours: {} }
      decision.colours[o!.key] = {
        colour: o!.colour,
        result: 'DROPPED',
        conditions: d.reason,
        buyerName: '',
        evidence: '',
        at: new Date(),
        recordedBy: actor.name,
      }
      const verdict = await decideRound(tx, round, decision, actor)
      return { colour: o!.colour, reason: d.reason, ...(verdict ? { result: verdict } : {}) }
    }
    case 'DECIDE': {
      if (round.state !== 'SUBMITTED')
        fail('Only a round with the buyer can receive a buyer decision.', 'NOT_WITH_BUYER')
      const d = sampleDecisionSchema.parse(ctx.data)
      const outcomes = colourOutcomes(round)
      const decision = normaliseDecision(round.decision, spec) ?? { colours: {} }
      const at = new Date()
      const seen = new Set<string>()
      const given: SampleColourDecision[] = d.colours.map((c) => {
        const key = colourKey(c.colour)
        const o = outcomes.find((x) => x.key === key)
        if (!o) fail(`${c.colour} is not one of this round’s colours.`, 'NOT_IN_GRID')
        if (seen.has(key)) fail(`${o!.colour} is given twice.`, 'NOT_IN_GRID')
        seen.add(key)
        if (o!.qc !== 'PASSED')
          fail(`${o!.colour} did not pass QC: the buyer has nothing of it to decide on.`, 'NOT_PASSED')
        // The buyer decides on what they saw; a colour not sent is dropped instead.
        if (!o!.sent.some((x) => x.qty > 0))
          fail(`${o!.colour} has not been sent to the buyer yet; drop it if it is not to be sent.`, 'NOT_SENT')
        if (o!.decision?.result === 'DROPPED')
          fail(`${o!.colour} is dropped; the buyer’s word on it is not recorded.`, 'DECIDED')
        if (c.result === 'APPROVED' && c.conditions)
          fail(
            `Resolve conditions before approving ${o!.colour} for bulk. Record Changes required while conditions remain.`,
            'CONDITIONS'
          )
        if (c.result === 'CHANGES_REQUIRED' && c.conditions.length < SAMPLE_CHANGES_MIN)
          fail(`Say what the buyer wants changed on ${o!.colour}: the next round is made to it.`, 'CONDITIONS')
        return {
          colour: o!.colour,
          result: c.result,
          conditions: c.conditions,
          buyerName: d.buyerName,
          evidence: d.evidence,
          at,
          recordedBy: actor.name,
        }
      })
      for (const g of given) decision.colours[colourKey(g.colour)] = g
      // The round's verdict once every colour that passed QC has a word.
      const verdict = await decideRound(tx, round, decision, actor)
      return {
        buyerName: d.buyerName,
        evidence: d.evidence,
        colours: given.map(({ colour, result, conditions }) => ({ colour, result, conditions })),
        ...(verdict ? { result: verdict } : {}),
      }
    }
  }
}
