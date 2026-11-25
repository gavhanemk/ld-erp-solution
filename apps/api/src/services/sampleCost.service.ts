/**
 * What a sample cost to make (phase 7): its other charges, putting a
 * challan's courier charge right, the cost sheet as the records stand, and
 * finalising it (a snapshot kept on the request, after which nothing that
 * costs may change until it is reopened). Every action runs inside
 * actOnSample, under the request's row lock and expected version, and leaves
 * its event. The sheet itself is the shared sampleCostSheet. Nothing here is
 * posted to the books.
 */
import { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { makingLedger, sampleCostSheet, type SampleCostSheet } from '@ld-erp/shared'
import {
  sampleChargeRemoveSchema,
  sampleChargeSchema,
  sampleDispatchChargeSchema,
  sampleFinaliseCostSchema,
  sampleReopenCostSchema,
} from '../schemas/sampling.schemas'
import { requestPool } from './samplePool.service'
import { liveSampleOrders } from './sampleSourcing.service'
import { dayOf } from './sampleMaking.service'
import type { sampleDetail } from './sampling.service'

type Tx = Prisma.TransactionClient
type Detail = Awaited<ReturnType<typeof sampleDetail>>
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const n = (v: unknown) => Number(v)
function fail(message: string, code = 'SAMPLE_RULE'): never {
  throw new AppError(message, 409, code)
}

export const COST_ACTIONS = ['ADD_CHARGE', 'REMOVE_CHARGE', 'DISPATCH_CHARGE', 'FINALISE_COST', 'REOPEN_COST'] as const
export type CostAction = (typeof COST_ACTIONS)[number]
export const COST_FINAL_TEXT = 'The sample’s costs are finalised. Reopen them to change anything that costs.'

/**
 * Whether an action would change what the sample cost: its material, labour,
 * pieces made or charges. Refused while the costs are finalised.
 */
export function changesCost(action: string, data: unknown): boolean {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  if (action === 'CLOSE_MATERIAL') return d.kind === 'USED'
  if (action === 'DISPATCH') return Number(d.courierCharge ?? 0) > 0
  return [
    'MATERIAL',
    'NEW_ROUND',
    'STEP_WORK',
    'STEP_SEND',
    'STEP_RECEIVE',
    'JOB_SEND',
    'JOB_RETURN',
    'STEP_LABOUR',
    'JOB_CHARGE',
    'MAKING_UNDO',
    'ADD_CHARGE',
    'REMOVE_CHARGE',
    'DISPATCH_CHARGE',
  ].includes(action)
}

/** The request's cost sheet as its records stand now: its own orders' rates, its pool's leftovers. */
export async function costSheetOf(tx: Tx, request: Detail): Promise<SampleCostSheet> {
  const materialIds = request.rounds.flatMap((r) => r.materials.map((m) => m.id))
  const orders = materialIds.length
    ? await tx.purchaseOrderLine.findMany({
        where: { sampleMaterialId: { in: materialIds }, ...liveSampleOrders },
        select: { itemId: true, qty: true, receivedQty: true, amount: true },
      })
    : []
  const pool = request.pool ?? (await requestPool(tx, request.id))
  return sampleCostSheet({ ...request, orders, pool })
}

export interface CostContext {
  request: Detail
  actor: { id: string; name: string }
  data: unknown
}

/** One cost action on the request. Returns what its event says. */
export async function actOnCost(tx: Tx, action: CostAction, ctx: CostContext): Promise<unknown> {
  const { request, actor } = ctx
  if (request.rounds.some((r) => r.handover))
    fail('This request has a production handover. Its costs are now frozen.')
  const final = !!request.costFinalisedAt
  if (final && action !== 'REOPEN_COST') fail(COST_FINAL_TEXT, 'COST_FINAL')
  switch (action) {
    case 'ADD_CHARGE': {
      const d = sampleChargeSchema.parse(ctx.data)
      const round = d.roundId ? request.rounds.find((r) => r.id === d.roundId) : null
      if (d.roundId && !round) fail('That round is not one of this request’s.', 'NO_ROUND')
      if (round?.state === 'DRAFT') fail('A round still being prepared has nothing to charge yet.', 'NO_ROUND')
      const charge = await tx.sampleCharge.create({
        data: {
          requestId: request.id,
          roundId: round?.id ?? null,
          kind: d.kind,
          description: d.description,
          amount: d.amount,
          billRef: d.billRef || null,
          chargedOn: dayOf(d.chargedOn, null, 'charge'),
          createdById: actor.id,
        },
      })
      return {
        chargeId: charge.id,
        kind: d.kind,
        description: d.description,
        amount: d.amount,
        revision: round?.revision ?? null,
      }
    }
    case 'REMOVE_CHARGE': {
      const d = sampleChargeRemoveSchema.parse(ctx.data)
      const charge = request.charges.find((c) => c.id === d.chargeId && !c.removedAt)
      if (!charge) fail('That charge is not on this request, or is removed already.', 'NOT_FOUND')
      await tx.sampleCharge.update({
        where: { id: charge!.id },
        data: { removedAt: new Date(), removedBy: actor.name, removeReason: d.reason },
      })
      return { kind: charge!.kind, description: charge!.description, amount: n(charge!.amount), reason: d.reason }
    }
    case 'DISPATCH_CHARGE': {
      const d = sampleDispatchChargeSchema.parse(ctx.data)
      const dispatch = request.rounds.flatMap((r) => r.dispatches).find((x) => x.id === d.dispatchId)
      if (!dispatch) fail('That challan is not on this request.', 'NOT_FOUND')
      if (dispatch!.cancelledAt) fail(`${dispatch!.number} was cancelled; it carries no charge.`, 'CHALLAN_CANCELLED')
      await tx.sampleDispatch.update({ where: { id: dispatch!.id }, data: { courierCharge: d.courierCharge } })
      return { number: dispatch!.number, charge: d.courierCharge, was: n(dispatch!.courierCharge), reason: d.reason }
    }
    case 'FINALISE_COST': {
      const d = sampleFinaliseCostSchema.parse(ctx.data)
      const latest = request.rounds[0]
      // A cancelled request is costed as it stopped; any other once its rounds are made.
      if (!request.cancelledAt) {
        if (latest.state === 'DRAFT')
          fail(`Round ${latest.revision} is still being prepared: finalise the costs once it is made.`, 'NOT_MADE')
        for (const r of request.rounds.filter((x) => x.state !== 'DRAFT')) {
          const steps = makingLedger(r)
          if (!steps.length || steps.some((s) => !s.complete))
            fail(`Round ${r.revision} is still being made: finalise the costs once every step is done.`, 'NOT_MADE')
        }
      }
      const held = request.rounds.find((r) =>
        r.materials.some((m) => n(m.issuedQty) - n(m.usedQty) - n(m.wasteQty) - n(m.returnedQty) > 0.0005)
      )
      if (held)
        fail(
          `Round ${held.revision} still holds material: record what was used, wasted or returned first.`,
          'MATERIAL_HELD'
        )
      const sheet = await costSheetOf(tx, request)
      // What it bought and still holds is closed out first, used or moved:
      // once the costs are final, a leftover can no longer be counted as used.
      if (sheet.notCosted.length)
        fail(
          `Close out what is left in the sample store first: ${sheet.notCosted
            .map((x) => `${x.qty} ${x.unit} of ${x.item}`)
            .join(', ')}.`,
          'LEFTOVERS'
        )
      await tx.sampleRequest.update({
        where: { id: request.id },
        data: { costSheet: json({ ...sheet, notes: d.notes }), costFinalisedAt: new Date(), costFinalisedBy: actor.name },
      })
      return { total: sheet.total, perPiece: sheet.perPiece, pieces: sheet.pieces, notes: d.notes }
    }
    case 'REOPEN_COST': {
      const d = sampleReopenCostSchema.parse(ctx.data)
      if (!final) fail('The costs are not finalised.', 'NOT_FINAL')
      await tx.sampleRequest.update({
        where: { id: request.id },
        data: { costSheet: Prisma.DbNull, costFinalisedAt: null, costFinalisedBy: null },
      })
      return { reason: d.reason }
    }
  }
}
