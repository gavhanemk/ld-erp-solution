import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { userCan, type AuthRequest } from '../middleware/auth'
import {
  approvedFrom,
  colourKey,
  handoverBomLines,
  handoverCostLines,
  handoverReady,
  normaliseDecision,
  type SampleCostSheet,
  type SampleHandoverBom,
  type SampleHandoverRouting,
} from '@ld-erp/shared'
import { sampleHandoverSchema } from '../schemas/sampling.schemas'
import { createRoutingSchema } from '../schemas/master.schemas'
import { createRouting } from './routing.service'
import { routingProblem } from './route.service'
import {
  assertVersionFree,
  bomName,
  costBom,
  nextBomVersion,
  priceBomLines,
  rethrowVersionClash,
  toLineCreate,
} from './bom.service'
import type { SampleAfterCommit, sampleDetail } from './sampling.service'

/**
 * The handover to bulk (phase 8): what the buyer approved becomes what
 * production makes. HANDOVER, once every colour has ended and the costs are
 * final, makes the style a production style if sampling made it, gives each
 * approved colour its BOM (a draft made from the round it was approved in, or
 * one Masters has already approved) and the style its routing (one it has,
 * or one made from the sample's route). ACCEPT_HANDOVER, production's word,
 * waits for Masters to approve each colour's BOM. No production order is made.
 */
type Tx = Prisma.TransactionClient
type Detail = Awaited<ReturnType<typeof sampleDetail>>
type Round = Detail['rounds'][number]
type Actor = NonNullable<AuthRequest['user']>
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const n = (v: unknown) => Number(v ?? 0)
function fail(message: string, code = 'SAMPLE_RULE'): never {
  throw new AppError(message, 409, code)
}
const joinAnd = (list: string[]) =>
  list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
const held = (m: { issuedQty: unknown; usedQty: unknown; wasteQty: unknown; returnedQty: unknown }) =>
  n(m.issuedQty) - n(m.usedQty) - n(m.wasteQty) - n(m.returnedQty)

export const HANDOVER_ACTIONS = ['HANDOVER', 'ACCEPT_HANDOVER'] as const
export type HandoverAction = (typeof HANDOVER_ACTIONS)[number]

/** A handover as kept on its round: today's shape, or the pilot's single linked BOM before it. */
export interface SampleHandover {
  notes: string
  preparedBy: string
  preparedAt?: string | Date
  acceptedBy?: string
  acceptedAt?: string | Date
  style?: { id: string; code: string; name: string; promoted: boolean }
  boms?: SampleHandoverBom[]
  routing?: SampleHandoverRouting
  accepted?: Array<{ colour: string; bomId: string; version: string }>
  [key: string]: unknown
}
const handoverOf = (raw: unknown) => (raw && typeof raw === 'object' ? (raw as SampleHandover) : null)

/**
 * Where each handed-over colour's BOM stands in Masters now: the one the
 * handover gave it, and the BOM production would take — that one once
 * approved, or one Masters approved for the colour (or for every colour)
 * after the handover was prepared, such as a corrected copy. A BOM approved
 * before the handover is not the sample's, so it never stands in for a draft.
 */
export async function handoverBomStatus(db: Tx, raw: unknown) {
  const h = handoverOf(raw)
  if (!h?.style || !Array.isArray(h.boms)) return []
  const since = h.preparedAt ? new Date(h.preparedAt) : null
  const boms = await db.bOM.findMany({
    where: {
      styleId: h.style.id,
      OR: [
        { id: { in: h.boms.map((b) => b.bomId) } },
        ...(since ? [{ status: 'APPROVED' as const, isActive: true, approvedAt: { gt: since } }] : []),
      ],
    },
    select: { id: true, version: true, color: true, status: true, isActive: true },
    orderBy: { approvedAt: 'desc' },
  })
  return h.boms.map((b) => {
    const own = boms.find((x) => x.id === b.bomId) ?? null
    const usable = (x: (typeof boms)[number]) => x.status === 'APPROVED' && x.isActive
    const later = (x: (typeof boms)[number]) => x.id !== b.bomId && usable(x)
    const approved =
      (own && usable(own) ? own : null) ??
      boms.find((x) => later(x) && x.color && colourKey(x.color) === colourKey(b.colour)) ??
      boms.find((x) => later(x) && !x.color) ??
      null
    return {
      colour: b.colour,
      bomId: b.bomId,
      version: b.version,
      made: b.made,
      /** The handed-over BOM's status now; DELETED once Masters removed it. */
      status: own ? (own.isActive ? own.status : 'OBSOLETE') : 'DELETED',
      approved: approved ? { id: approved.id, version: approved.version, color: approved.color } : null,
    }
  })
}

/** "White (v1.0)", or the colour alone once its BOM is retired or removed in Masters. */
const waitingName = (s: { colour: string; version: string; status: string }) =>
  s.status === 'DELETED' || s.status === 'OBSOLETE' ? s.colour : `${s.colour} (v${s.version})`

/** What the register shows of a handover: whether it is prepared and accepted, by whom. */
export function handoverStanding(raw: unknown) {
  const h = handoverOf(raw)
  return h ? { preparedBy: h.preparedBy, preparedAt: h.preparedAt, acceptedBy: h.acceptedBy, acceptedAt: h.acceptedAt } : null
}

/** A handover's figures, for those who do not see what samples cost. */
export function handoverWithoutMoney(raw: unknown): unknown {
  const h = handoverOf(raw)
  if (!h || !Array.isArray(h.boms)) return raw
  const { cost, ...rest } = h
  return {
    ...rest,
    boms: h.boms.map(({ totalCost, costPerPiece, costLines, lines, ...b }) => ({
      ...b,
      lines: lines.map(({ unitCost, ...l }) => l),
    })),
  }
}

export async function actOnHandover(
  tx: Tx,
  action: HandoverAction,
  ctx: { request: Detail; round: Round; actor: Actor; data: unknown; after: SampleAfterCommit }
): Promise<unknown> {
  const { request, round, actor, after } = ctx
  switch (action) {
    case 'HANDOVER': {
      // Every colour the request sampled has ended (approved, rejected or
      // dropped), in whichever round, and at least one is approved.
      const ready = handoverReady(request.rounds)
      if (!ready.ready || !['APPROVED', 'REJECTED'].includes(round.state) || request.rounds.some((x) => x.handover))
        fail('Handover requires buyer approval and can only be prepared once.')
      // What the sample cost is settled first: the BOMs are priced from it.
      if (!request.costFinalisedAt || !request.costSheet)
        fail('Finalise what the sample cost before preparing the handover.', 'COST_NOT_FINAL')
      if (request.rounds.some((x) => x.materials.some((m) => held(m) > 0.0005)))
        fail('Account for used, wasted and returned material on every round before handover.')
      const d = sampleHandoverSchema.parse(ctx.data)
      const styleId = round.specification.styleId
      const style = await tx.style.findUnique({ where: { id: styleId } })
      if (!style) fail('The style this sample was made in no longer exists.')
      if (!style.isActive)
        fail(`${style.code} is deactivated. Reactivate it in Masters before handing the sample over.`, 'STYLE_INACTIVE')

      // One choice for each approved colour, no more and no fewer.
      const from = approvedFrom(request.rounds)
      const asked = new Map(d.boms.map((b) => [colourKey(b.colour), b]))
      const missing = from.filter((f) => !asked.has(colourKey(f.colour))).map((f) => f.colour)
      const stray = d.boms.filter((b) => !from.some((f) => colourKey(f.colour) === colourKey(b.colour)))
      if (asked.size !== d.boms.length || missing.length || stray.length)
        fail(
          `Say for each colour the buyer approved (${joinAnd(from.map((f) => f.colour))}) which BOM it goes to production with${
            stray.length ? `; ${joinAnd(stray.map((b) => b.colour))} ${stray.length === 1 ? 'is' : 'are'} not one of them` : ''
          }.`,
          'HANDOVER_COLOURS'
        )
      // The style's own spelling of each colour, which its BOMs are named by.
      const named = new Map(from.map((f) => [colourKey(f.colour), style.colors.find((c) => colourKey(c) === colourKey(f.colour))]))
      const gone = from.filter((f) => !named.get(colourKey(f.colour))).map((f) => f.colour)
      if (gone.length)
        fail(`${joinAnd(gone)} ${gone.length === 1 ? 'is' : 'are'} no longer one of ${style.code}’s colours. Add ${gone.length === 1 ? 'it' : 'them'} back on the style first.`, 'NOT_STYLE_COLOUR')

      // A BOM Masters has approved: this style's, for the colour or for every colour.
      const approvedBom = (id: string) =>
        tx.bOM.findFirst({
          where: { id, styleId, isActive: true, status: 'APPROVED' },
          include: { lines: { include: { componentItem: { select: { name: true } }, sizes: true } } },
        })
      const existing = new Map<string, NonNullable<Awaited<ReturnType<typeof approvedBom>>>>()
      for (const b of d.boms.filter((x) => x.bomId)) {
        const bom = await approvedBom(b.bomId!)
        if (!bom || (bom.color && colourKey(bom.color) !== colourKey(b.colour)))
          fail(
            `Pick an approved BOM of ${style.code} for ${b.colour} or for every colour, or make one from the sample.`,
            'HANDOVER_BOM'
          )
        existing.set(colourKey(b.colour), bom)
      }

      // The style's BOM versions are taken one handover at a time.
      await tx.$queryRaw`SELECT id FROM ld_erp.styles WHERE id = ${style.id} FOR UPDATE`
      // Sampling made the style: it is a production style from now on, so it
      // can have a BOM, a routing and orders.
      const promoted = style.stage === 'DEVELOPMENT'
      if (promoted) {
        const updated = await tx.style.update({ where: { id: style.id }, data: { stage: 'PRODUCTION' } })
        after.styleAudit = { action: 'UPDATE', styleId: style.id, before: style, after: updated }
      }
      after.mastersAudit ??= []
      after.warnings ??= []

      // The routing: one the style has, or one made from the route the
      // approved colours were last made on.
      const madeOn = from.reduce((a, f) => (f.round.revision > a.revision ? f.round : a), from[0].round)
      let routing: SampleHandoverRouting
      let routingStyleId: string | null
      if (d.routingId) {
        const r = await tx.routing.findFirst({
          where: { id: d.routingId, isActive: true },
          include: { steps: { orderBy: { sequence: 'asc' } }, style: { select: { code: true } } },
        })
        if (!r || routingProblem(r, [style])) fail('Pick an active routing that fits this style, or make one from the sample.', 'HANDOVER_ROUTING')
        routingStyleId = r.styleId
        routing = {
          id: r.id,
          code: r.code,
          name: r.name,
          version: r.version,
          made: false,
          revision: null,
          steps: r.steps.map((s) => ({
            sequence: s.sequence,
            operationId: s.operationId,
            departmentId: s.departmentId,
            workstationId: s.workstationId,
            contractorId: s.contractorId,
            execution: s.execution,
            instructions: s.instructions,
          })),
        }
      } else {
        const stages = [...madeOn.stages].sort((a, b) => a.sequence - b.sequence)
        const typed = stages.filter((s) => !s.operationId || !s.departmentId).map((s) => s.name)
        if (!stages.length || typed.length)
          fail(
            `Round ${madeOn.revision}’s route ${typed.length ? `has steps typed in by name (${joinAnd(typed)})` : 'has no steps'}, so no routing can be made from it. Pick a routing that fits ${style.code}${promoted ? ' (one for its category or for any style)' : ''} instead.`,
            'ROUTE_NOT_FROM_MASTERS'
          )
        const ops = await tx.operation.findMany({
          where: { id: { in: stages.map((s) => s.operationId!) } },
          select: { id: true, kind: true },
        })
        const input = createRoutingSchema.parse({
          name: `${style.code} ${style.name}`.slice(0, 200),
          styleId: style.id,
          notes: `Made from sample ${request.number}, round ${madeOn.revision}, at handover.`,
          isActive: true,
          steps: stages.map((s, i) => ({
            sequence: i + 1,
            operationId: s.operationId,
            departmentId: s.departmentId,
            contractorId: s.contractorId ?? null,
            execution: s.execution,
            isQcStep: ops.find((o) => o.id === s.operationId)?.kind === 'QC',
            instructions: s.instructions?.trim() || null,
          })),
        })
        const made = await createRouting(tx, input, actor.id)
        const said = made.message.slice(`${made.routing.name} saved.`.length).trim()
        if (said) after.warnings.push(`${made.routing.code}: ${said}`)
        after.mastersAudit.push({ action: 'CREATE', entityType: 'Routing', entityId: made.routing.id, after: made.routing })
        routingStyleId = made.routing.styleId
        routing = {
          id: made.routing.id,
          code: made.routing.code,
          name: made.routing.name,
          version: made.routing.version,
          made: true,
          revision: madeOn.revision,
          steps: made.routing.steps.map((s) => ({
            sequence: s.sequence,
            operationId: s.operationId,
            departmentId: s.departmentId,
            workstationId: s.workstationId,
            contractorId: s.contractorId,
            execution: s.execution,
            instructions: s.instructions,
          })),
        }
      }

      // Each approved colour's BOM.
      const sheet = request.costSheet as unknown as SampleCostSheet
      const boms: SampleHandoverBom[] = []
      for (const f of from) {
        const colour = named.get(colourKey(f.colour))!
        const have = existing.get(colourKey(f.colour))
        if (have) {
          boms.push({
            colour,
            bomId: have.id,
            version: have.version,
            made: false,
            revision: null,
            lines: have.lines.map((l) => ({
              itemId: l.componentItemId,
              item: l.componentItem.name,
              component: l.component,
              qtyPerUnit: n(l.qtyPerUnit),
              wastagePercent: n(l.wastagePercent),
              unitCost: l.unitCost === null ? null : n(l.unitCost),
              sizes: l.sizes.map((z) => ({ sizeId: z.sizeId, qtyPerUnit: n(z.qtyPerUnit) })),
            })),
            // Its labour, overhead and cost a piece are Masters' approvers' to see: not copied here.
            totalCost: have.totalCost === null ? null : n(have.totalCost),
            baseSizeId: have.baseSizeId,
            approvedAt: have.approvedAt,
          })
          continue
        }
        const costed = sheet.rounds.find((r) => r.roundId === f.round.id) ?? null
        const { lines, skipped } = handoverBomLines(f.round, colour, costed)
        if (!lines.length)
          fail(
            `Round ${f.round.revision} has no material for ${colour} to make its BOM from${
              promoted ? '. Add its material in a new round before handing it over' : ': pick a BOM Masters has approved for it'
            }.`,
            'NO_BOM_LINES'
          )
        if (skipped.length)
          after.warnings.push(`${bomName(style.code, colour)}: ${joinAnd(skipped)} had no quantity a piece, so ${skipped.length === 1 ? 'it is' : 'they are'} not on the BOM.`)
        const retired = await tx.item.findMany({
          where: { id: { in: lines.map((l) => l.componentItemId) }, isActive: false },
          select: { name: true },
        })
        if (retired.length)
          fail(
            `${joinAnd(retired.map((i) => i.name))} ${retired.length === 1 ? 'is' : 'are'} deactivated, so ${retired.length === 1 ? 'it' : 'they'} cannot go on ${style.code}’s BOM. Reactivate ${retired.length === 1 ? 'it' : 'them'} in Masters first.`,
            'BOM_COMPONENT_INACTIVE'
          )
        const { priced, totalCost, warnings } = await priceBomLines(
          tx,
          lines.map((l) => ({
            componentItemId: l.componentItemId,
            component: l.component,
            departmentId: l.departmentId,
            qtyPerUnit: l.qtyPerUnit,
            wastagePercent: l.wastagePercent,
            unitCost: l.unitCost,
            notes: l.notes || null,
            sortOrder: l.sortOrder,
          }))
        )
        const costing = costBom(totalCost, handoverCostLines(costed, f.round.revision))
        const version = await nextBomVersion(tx, style.id, colour)
        await assertVersionFree(tx, style.id, colour, version, style.code, undefined, false)
        const by = normaliseDecision(f.round.decision, f.round.specification)?.colours[colourKey(colour)]?.buyerName
        const bom = await tx.bOM
          .create({
          data: {
            styleId: style.id,
            color: colour,
            version,
            // A BOM names a routing of its own style only.
            routingId: routingStyleId === style.id ? routing.id : null,
            notes: `Made from sample ${request.number}, round ${f.round.revision}${by ? `, approved by ${by}` : ''}. Rates are what the sample paid; labour and charges are the sample's, a piece. Check them before approving.`,
            totalCost,
            labourCost: costing.labourCost,
            overheadCost: costing.overheadCost,
            costPerPiece: costing.costPerPiece,
            // The buyer supplying a sample's trim says nothing of bulk: the line
            // says so in its notes, and Masters decides (customerSupplied stays off).
            lines: { create: priced.map(toLineCreate) },
            ...(costing.rows.length ? { costLines: { create: costing.rows } } : {}),
          },
          include: { lines: true, costLines: true },
        })
          .catch((e) => rethrowVersionClash(e, style.code, colour, version, false))
        if (warnings.length)
          after.warnings.push(
            `${bomName(style.code, colour)} v${version}: ${joinAnd(warnings.map((w) => w.name))} ${warnings.length === 1 ? 'has' : 'have'} no rate yet. Set ${warnings.length === 1 ? 'it' : 'them'} in Masters before approving.`
          )
        after.mastersAudit.push({ action: 'CREATE', entityType: 'BOM', entityId: bom.id, after: bom })
        boms.push({
          colour,
          bomId: bom.id,
          version,
          made: true,
          revision: f.round.revision,
          lines: lines.map((l, i) => ({
            itemId: l.componentItemId,
            item: f.round.materials.find((m) => m.id === l.materialId)?.item?.name ?? 'Material',
            component: l.component,
            qtyPerUnit: l.qtyPerUnit,
            wastagePercent: l.wastagePercent,
            unitCost: priced[i].unitCost,
            usedPerPiece: l.usedPerPiece,
            unit: l.unit,
            customerSupplied: l.customerSupplied,
          })),
          costLines: costing.rows.map((c) => ({ kind: c.kind, name: c.name, value: c.amount })),
          totalCost,
          costPerPiece: costing.costPerPiece,
        })
      }

      const handover: SampleHandover = {
        notes: d.notes,
        preparedBy: actor.name,
        preparedAt: new Date(),
        style: { id: style.id, code: style.code, name: style.name, promoted },
        boms,
        routing,
        cost: { total: sheet.total, perPiece: sheet.perPiece, pieces: sheet.pieces, finalisedAt: request.costFinalisedAt },
        approvedColours: ready.approved,
        // The rounds the colours were approved in, as they were specified and decided.
        approvedIn: [...new Map(from.map((f) => [f.round.id, f.round])).values()].map((r) => ({
          revision: r.revision,
          colours: from.filter((f) => f.round.id === r.id).map((f) => f.colour),
          specification: r.specification,
          decision: r.decision,
        })),
      }
      await tx.sampleRound.update({ where: { id: round.id }, data: { handover: json(handover) } })
      return {
        style: style.code,
        promoted,
        boms: boms.map((b) => ({ colour: b.colour, version: b.version, made: b.made })),
        routing: { code: routing.code, made: routing.made },
        notes: d.notes,
      }
    }
    case 'ACCEPT_HANDOVER': {
      if (!userCan(actor, 'production', 'approve'))
        throw new AppError('You need production approve permission for this action.', 403, 'FORBIDDEN')
      const h = handoverOf(round.handover)
      if (!h || h.acceptedAt) fail('Prepare a handover first; an accepted handover cannot be accepted again.')
      // Production takes a colour once Masters has approved its BOM.
      const status = await handoverBomStatus(tx, h)
      const waiting = status.filter((s) => !s.approved)
      if (waiting.length)
        fail(
          `Masters has still to approve a BOM for ${joinAnd(waiting.map(waitingName))}. Approve ${waiting.length === 1 ? 'it' : 'them'} in Masters → BOMs, then accept the handover.`,
          'BOM_NOT_APPROVED'
        )
      const accepted = status.map((s) => ({ colour: s.colour, bomId: s.approved!.id, version: s.approved!.version }))
      await tx.sampleRound.update({
        where: { id: round.id },
        data: { handover: json({ ...h, acceptedBy: actor.name, acceptedAt: new Date(), ...(status.length ? { accepted } : {}) }) },
      })
      return { acceptedBy: actor.name, ...(status.length ? { boms: accepted } : {}) }
    }
  }
}
