import type { Prisma } from '@prisma/client'
import type { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { userCan, type AuthRequest } from '../middleware/auth'
import { nextDocumentNumber } from '../lib/docNumber'
import { CODE_ATTEMPTS, nextStyleCode } from '../lib/masterCode'
import { MAX_FILE_BYTES, MAX_FILES_PER_DOCUMENT, removeObject, statObject } from '../lib/storage'
import { lockedBalanceOf, recordMovement, transferStock } from './stock.service'
import { availableIn, requestPool } from './samplePool.service'
import { checkRouteSteps, routingProblem } from './route.service'
import { assertContractorsFit } from './routing.service'
import { liveSampleOrders, sampleOrderLine, sampleOrderSelect } from './sampleSourcing.service'
import { MAKING_COST_ACTIONS, actOnMaking, syncMaking } from './sampleMaking.service'
import { jobOutstanding, makingStarted } from '../../../../packages/shared/src/sampleMaking'
import {
  colourKey,
  colourOutcomes,
  coloursToCarry,
  handoverReady,
} from '../../../../packages/shared/src/sampleReview'
import { actOnReview } from './sampleReview.service'
import {
  OVERRIDE_REASON_MIN,
  SAMPLE_ATTACHMENT_KIND_LABEL,
  SAMPLE_MATERIAL_TYPES,
  cellCount,
  lineRequiredQty,
  normaliseSpec,
  repeatedBomLines,
  sampleSpecGaps,
  sizesInUse,
  type SampleAttachmentKind,
  type SampleBomLine,
  type SampleItemOption,
  type SampleMaterialType,
  type SampleRouteStep,
  type SampleSpecification,
} from '../../../../packages/shared/src/sampling'
import {
  createSampleSchema,
  sampleAttachSchema,
  sampleCreateStyleSchema,
  sampleDetachSchema,
  sampleLinkStyleSchema,
  sampleUpdateStyleSchema,
  sampleActionSchema,
  sampleSpecificationSchema,
  sampleMaterialSchema,
  sampleWaiveSchema,
  sampleCloseOutSchema,
  sampleHandoverSchema,
  sampleDraftSchema,
  sampleDraftPatchSchema,
  updateSampleRequestSchema,
} from '../schemas/sampling.schemas'

type Tx = Prisma.TransactionClient
type Actor = NonNullable<AuthRequest['user']>
function fail(message: string, code = 'SAMPLE_RULE'): never {
  throw new AppError(message, 409, code)
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const n = (v: unknown) => Number(v)
const round3 = (v: number) => Math.round(v * 1000) / 1000
const round2 = (v: number) => Math.round(v * 100) / 100
/** Every sample file sits under samples/<request id>/, which is how a registered path is checked. */
export const SAMPLE_FILE_FOLDER = 'samples'
export const sampleStyleSelect = {
  id: true,
  code: true,
  name: true,
  stage: true,
  brandId: true,
  category: true,
  season: true,
  sizeGroupId: true,
  colors: true,
  isActive: true,
} satisfies Prisma.StyleSelect
/** An item as the sample BOM's picker reads it (sampleItemOption). */
export const sampleItemSelect = {
  id: true,
  code: true,
  name: true,
  type: true,
  departmentId: true,
  standardRate: true,
  uom: { select: { id: true, name: true, symbol: true } },
} satisfies Prisma.ItemSelect
export const sampleInclude = {
  // With where its samples go, for the delivery challan's address.
  customer: {
    select: {
      id: true,
      name: true,
      phone: true,
      shippingAddress: true,
      shippingCity: true,
      shippingState: true,
      shippingPincode: true,
      billingAddress: true,
      billingCity: true,
      billingState: true,
      billingPincode: true,
    },
  },
  brand: { select: { id: true, name: true } },
  style: { select: sampleStyleSelect },
  rounds: {
    orderBy: { revision: 'desc' as const },
    include: {
      stages: { orderBy: { sequence: 'asc' as const } },
      // How the round is being made (sampleMaking): work at each step, the
      // hand-ons between steps, and outside units' challans with what came back.
      works: { orderBy: { createdAt: 'asc' as const } },
      transfers: { orderBy: { createdAt: 'asc' as const } },
      jobWorks: {
        orderBy: { createdAt: 'asc' as const },
        include: {
          vendor: { select: { id: true, name: true } },
          returns: { orderBy: { createdAt: 'asc' as const } },
        },
      },
      // Samples sent to the buyer on Sample Delivery Challans.
      dispatches: { orderBy: { createdAt: 'asc' as const } },
      materials: {
        // As the merchandiser listed them; the id breaks a tie between lines
        // released before lines were numbered.
        orderBy: [{ sequence: 'asc' as const }, { id: 'asc' as const }],
        include: {
          // As the BOM's picker lists an item (sampleItemSelect), with whether it
          // is still in use: the editor offers a line's own material even when
          // it was added after the page read its list.
          item: { select: { ...sampleItemSelect, isActive: true } },
          warehouse: { select: { name: true, purpose: true } },
          // The orders buying it, for Sourcing: no rates, which Sampling does not show.
          poLines: {
            where: liveSampleOrders,
            select: sampleOrderSelect,
            orderBy: { po: { poDate: 'asc' as const } },
          },
        },
      },
    },
  },
  events: { orderBy: { version: 'desc' as const } },
  // Leftovers closed out: used up in the sample, or moved to a general store.
  closeOuts: {
    orderBy: { createdAt: 'desc' as const },
    include: {
      item: { select: { name: true, code: true, uom: { select: { symbol: true } } } },
      warehouse: { select: { name: true } },
      toWarehouse: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
  },
  attachments: {
    orderBy: { createdAt: 'asc' as const },
    include: { uploadedBy: { select: { id: true, name: true } } },
  },
} satisfies Prisma.SampleRequestInclude
export async function sampleDetail(
  tx: Tx,
  id: string,
  /**
   * With the request's own material in the sample stores (samplePool): what
   * the screen shows. Left out for an action's own reading, which works it out
   * only where it needs it.
   */
  opts: { pool?: boolean } = {}
) {
  const row = await tx.sampleRequest.findUnique({ where: { id }, include: sampleInclude })
  if (!row) throw new AppError('Sample request not found', 404, 'NOT_FOUND')
  const pool = opts.pool ? await requestPool(tx, id) : null
  // Every reader (the request, its print, every action) sees each round's
  // specification in today's shape, however old the round.
  return {
    ...row,
    pool,
    rounds: row.rounds.map((r) => ({
      ...r,
      specification: normaliseSpec(r.specification),
      // Each line's orders as Sourcing lists them (sampleOrdered sums them).
      materials: r.materials.map(({ poLines, ...m }) => ({ ...m, orders: poLines.map(sampleOrderLine) })),
    })),
  }
}
function grant(actor: Actor, module: string, action: string) {
  if (!userCan(actor, module, action))
    throw new AppError(`You need ${module} ${action} permission for this action.`, 403, 'FORBIDDEN')
}
async function event(
  tx: Tx,
  id: string,
  version: number,
  action: string,
  actor: Actor,
  detail: unknown
) {
  const latest = await tx.sampleRound.findFirstOrThrow({
    where: { requestId: id },
    orderBy: { revision: 'desc' },
    select: { state: true },
  })
  // A cancelled request stays cancelled whatever is recorded on it after
  // (leftover material closed out).
  const cancelled = await tx.sampleRequest.findUnique({ where: { id }, select: { cancelledAt: true } })
  await tx.sampleRequest.update({
    where: { id },
    data: {
      version: version + 1,
      state: action === 'CANCEL' || cancelled?.cancelledAt ? 'CANCELLED' : latest.state,
    },
  })
  await tx.sampleEvent.create({
    data: {
      requestId: id,
      version: version + 1,
      action,
      actorId: actor.id,
      detail: json({ ...Object(detail), by: actor.name }),
    },
  })
}
export async function createSample(tx: Tx, data: z.infer<typeof createSampleSchema>, actor: Actor) {
  const old = await tx.sampleRequest.findUnique({ where: { clientKey: data.clientKey } })
  if (old) return sampleDetail(tx, old.id, { pool: true })
  const brand = await tx.brand.findFirst({ where: { id: data.brandId, isActive: true } })
  if (!brand) fail('Pick an active brand.')
  if (
    data.customerId &&
    !(await tx.customer.findFirst({ where: { id: data.customerId, isActive: true } }))
  )
    fail('Pick an active buyer.')
  const number = await nextDocumentNumber(tx, 'SAMPLE')
  const request = await tx.sampleRequest.create({
    data: {
      ...data,
      requiredAt: data.requiredAt ? new Date(data.requiredAt) : null,
      buyerStyleRef: data.buyerStyleRef || null,
      season: data.season || null,
      garmentCategory: data.garmentCategory || null,
      number,
      createdById: actor.id,
    },
  })
  // A new round starts on the usual route, which the merchandiser changes.
  const specification: SampleSpecification = {
    milestone: 'Development sample',
    styleId: '',
    construction: '',
    techPackRef: '',
    patternRef: '',
    colours: [],
    measurements: [],
    route: await routeTemplate(tx),
    materials: [],
    notes: '',
  }
  await tx.sampleRound.create({
    data: { requestId: request.id, revision: 1, specification: json(specification) },
  })
  await event(tx, request.id, 0, 'CREATE', actor, { number })
  return sampleDetail(tx, request.id, { pool: true })
}
/**
 * The style, colours and sizes of a specification against the masters.
 * Returns it with each colour spelt as the style spells it. A blank colour or
 * size is allowed here and left to sampleSpecGaps; one that is filled in must
 * be the style's.
 */
async function validateSpec(
  tx: Tx,
  s: SampleSpecification,
  owner: { brandId: string; customerId: string | null; styleId: string | null },
  draft = false
): Promise<SampleSpecification> {
  const { brandId } = owner
  // Once the request has its style, every round samples that style; another
  // style is another request.
  if (owner.styleId && s.styleId && s.styleId !== owner.styleId)
    fail(
      'A round samples the request’s own style. Change the request’s style first to sample another.',
      'NOT_REQUEST_STYLE'
    )
  const style = s.styleId
    ? await tx.style.findFirst({
        where: { id: s.styleId, isActive: true },
        include: { sizeGroup: { include: { sizes: true } } },
      })
    : null
  if ((!draft || s.styleId) && !style) fail('Pick an active style.')
  if (style && style.brandId !== brandId)
    fail(
      'The style must belong to this request’s brand. Clear the draft style before changing the brand.'
    )
  const colours = s.colours.map((row) => {
    const asked = row.colour.trim()
    if (!asked) return { ...row, colour: '' }
    const own = style?.colors.find((c) => c.toLowerCase() === asked.toLowerCase())
    if (!own)
      fail(
        style
          ? `${asked} is not one of the style’s colours. Add it to the style first, or pick another.`
          : 'Pick the style before its colours.',
        'NOT_STYLE_COLOUR'
      )
    return { ...row, colour: own }
  })
  const sizeIds = new Set(style?.sizeGroup?.sizes.map((x) => x.id) ?? [])
  if (
    colours.some((r) => r.sizes.some((x) => x.sizeId && !sizeIds.has(x.sizeId))) ||
    s.measurements.some((x) => x.sizeId && !sizeIds.has(x.sizeId))
  )
    fail('Every sample size must belong to the style’s size run.')
  return { ...s, colours }
}

// ── The sample BOM: the round's material rows ────────────────────────────────

/** The item kinds a sample BOM line can be. */
const BOM_TYPES: readonly string[] = SAMPLE_MATERIAL_TYPES
/** Most a sample round can need of one material: a typing slip beyond it (DECIMAL(10,3)). */
const MAX_REQUIRED = 999999.999
/** A material row, as the round's include reads it. */
interface MaterialRow {
  id: string
  sequence: number
  component: string
  itemId: string | null
  colour: string | null
  departmentId: string | null
  qtyPerPiece: unknown
  wastagePct: unknown
  plannedQty: unknown
  requiredOverride: boolean
  overrideReason: string | null
  source: string
  estRate: unknown
  remarks: string
  issuedQty: unknown
  returnedQty: unknown
  usedQty: unknown
  wasteQty: unknown
  item?: { name: string } | null
}
/** A row as the specification's copy of it lists it. */
function bomLineOf(m: MaterialRow): SampleBomLine {
  return {
    id: m.id,
    component: m.component,
    itemId: m.itemId ?? '',
    colour: m.colour,
    departmentId: m.departmentId,
    qtyPerPiece: n(m.qtyPerPiece),
    wastagePct: n(m.wastagePct),
    requiredQty: n(m.plannedQty),
    requiredOverride: m.requiredOverride,
    overrideReason: m.overrideReason ?? '',
    source: m.source === 'BUYER_SUPPLIED' ? 'BUYER_SUPPLIED' : 'PURCHASE',
    estRate: m.estRate === null || m.estRate === undefined ? null : n(m.estRate),
    remarks: m.remarks,
  }
}
const byListing = (a: { sequence: number; id: string }, b: { sequence: number; id: string }) =>
  a.sequence - b.sequence || a.id.localeCompare(b.id)
/**
 * The round's lines as they stand: its rows, which decide, once it has any;
 * else the lines a round saved before the rows existed lists in its
 * specification, which become rows on its next save.
 */
function currentLines(round: { materials: MaterialRow[]; specification: SampleSpecification }) {
  return round.materials.length
    ? [...round.materials].sort(byListing).map(bomLineOf)
    : round.specification.materials
}
/** Anything issued, returned, used or wasted on the line. */
const hasMovement = (m: MaterialRow) =>
  n(m.issuedQty) > 0 || n(m.returnedQty) > 0 || n(m.usedQty) > 0 || n(m.wasteQty) > 0

/**
 * Writes a round's BOM lines as its rows and returns the specification's copy
 * of them, with their ids, in the order listed. Rows are kept, never written
 * afresh: a line sent with its id is updated in place, a line without one is
 * added, and only a line the screen dropped is removed. A purchase linked to
 * a line before release (phase 3) therefore stays linked however often the
 * draft is saved.
 *
 * Each required quantity is worked out here by the shared arithmetic
 * (lineRequiredQty), never taken from the screen unless typed by hand, and
 * kept as the row's planned quantity. A draft may leave lines unfinished;
 * whatever is filled in must still be right. `copy` is a round's own lines
 * carried over (a new round, a style change): what was accepted once is not
 * refused for a master switched off since; the next save checks it again,
 * except a department switched off, which is cleared so the line goes back to
 * the item's own rather than carry a dead one into every later save. Each
 * refusal names its line, numbered as listed, as the gaps number them.
 */
async function syncBomRows(
  tx: Tx,
  round: { id: string; materials: MaterialRow[] },
  spec: Pick<SampleSpecification, 'colours'>,
  lines: SampleBomLine[],
  opts: { draft: boolean; customerId: string | null; copy?: boolean }
): Promise<SampleBomLine[]> {
  const rows = new Map(round.materials.map((m) => [m.id, m]))
  const sent = new Set<string>()
  for (const l of lines) {
    if (!l.id) continue
    if (!rows.has(l.id)) fail('That material line is not on this round.', 'NOT_THIS_ROUND')
    if (sent.has(l.id))
      fail('A material line is listed twice. Refresh and save again.', 'LINE_TWICE')
    sent.add(l.id)
  }
  // The round's colours as the style spells them.
  const colours = new Map(
    spec.colours
      .map((r) => r.colour.trim())
      .filter(Boolean)
      .map((c) => [c.toLowerCase(), c])
  )
  const itemIds = [...new Set(lines.map((l) => l.itemId.trim()).filter(Boolean))]
  const items = new Map(
    (itemIds.length
      ? await tx.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, isActive: true, type: true, departmentId: true },
        })
      : []
    ).map((i) => [i.id, i])
  )
  const deptIds = [
    ...new Set(
      [
        ...lines.map((l) => l.departmentId),
        ...[...items.values()].map((i) => i.departmentId),
      ].filter((x): x is string => !!x)
    ),
  ]
  const activeDepts = new Set(
    deptIds.length
      ? (
          await tx.department.findMany({
            where: { id: { in: deptIds }, isActive: true },
            select: { id: true },
          })
        ).map((d) => d.id)
      : []
  )
  // The same part and material twice for a colour, a line for every colour
  // among them: the shared rule the gaps list, by the line's place.
  const repeated = opts.copy ? new Map<number, string>() : repeatedBomLines(lines)
  const prepared = lines.map((l, i) => {
    const at = `Line ${i + 1}:`
    const itemId = l.itemId.trim()
    const item = itemId ? items.get(itemId) : undefined
    if (itemId && !opts.copy && (!item || !item.isActive || !BOM_TYPES.includes(item.type)))
      fail(
        `${at} ${l.component.trim() ? `the material for ${l.component.trim()}` : 'its material'} is no longer in use, or is not a material, trim, packing or consumable. Pick another.`,
        'ITEM_NOT_IN_USE'
      )
    const asked = l.colour?.trim() || null
    const colour = asked ? colours.get(asked.toLowerCase()) : null
    if (asked && !colour)
      fail(
        `${at} ${asked} is not one of this round’s colours. A material is for one of them, or for every colour.`,
        'NOT_ROUND_COLOUR'
      )
    const named = l.departmentId?.trim() || null
    if (named && !opts.copy && !activeDepts.has(named))
      fail(
        `${at} pick a department that is still in use, or leave it blank for the item’s own.`,
        'BAD_DEPARTMENT'
      )
    const given = named && activeDepts.has(named) ? named : null
    // Left blank: drawn by whoever normally uses the item.
    const departmentId =
      given ?? (item?.departmentId && activeDepts.has(item.departmentId) ? item.departmentId : null)
    const repeat = repeated.get(i)
    if (repeat) fail(`${at} ${repeat}`, 'DUPLICATE_MATERIAL')
    const requiredQty = lineRequiredQty({ ...l, colour: colour ?? null }, spec)
    if (requiredQty > MAX_REQUIRED)
      fail(
        `${at} that is more of one material than a sample round can need. Check how much one piece takes.`,
        'QTY_TOO_LARGE'
      )
    if (!opts.draft) {
      if (l.requiredOverride && !(requiredQty > 0)) fail(`${at} enter the quantity needed.`)
      if (l.requiredOverride && l.overrideReason.trim().length < OVERRIDE_REASON_MIN)
        fail(
          `${at} say why the quantity is typed by hand (${OVERRIDE_REASON_MIN} characters or more).`,
          'OVERRIDE_REASON'
        )
      if (l.source === 'BUYER_SUPPLIED' && !opts.customerId)
        fail(`${at} material the buyer sends needs a buyer on the request.`, 'NO_BUYER')
    }
    return {
      id: l.id || undefined,
      data: {
        component: l.component.trim(),
        itemId: itemId || null,
        colour: colour ?? null,
        departmentId,
        qtyPerPiece: l.qtyPerPiece,
        wastagePct: l.wastagePct,
        plannedQty: requiredQty,
        requiredOverride: l.requiredOverride,
        // A reason belongs to a quantity typed by hand; worked out, it needs none.
        overrideReason: l.requiredOverride ? l.overrideReason.trim() || null : null,
        source: l.source,
        ownership: l.source === 'BUYER_SUPPLIED' ? ('CUSTOMER_OWNED' as const) : ('OWNED' as const),
        estRate: l.estRate,
        remarks: l.remarks.trim(),
      },
    }
  })
  // Nothing in a draft has moved, but a line that has keeps its material.
  for (const row of round.materials) {
    if (!hasMovement(row)) continue
    const kept = prepared.find((p) => p.id === row.id)
    const name = row.item?.name ?? 'A material'
    if (!kept) fail(`${name} has stock movements on this round, so its line stays.`, 'LINE_IN_USE')
    if (kept!.data.itemId !== row.itemId || kept!.data.source !== row.source)
      fail(
        `${name} has stock movements on this round, so its material and who supplies it stay.`,
        'LINE_IN_USE'
      )
  }
  const dropped = round.materials.filter((m) => !sent.has(m.id)).map((m) => m.id)
  if (dropped.length)
    await tx.sampleMaterial.deleteMany({ where: { id: { in: dropped }, roundId: round.id } })
  for (const [i, p] of prepared.entries()) {
    const data = { ...p.data, sequence: i + 1 }
    if (p.id) await tx.sampleMaterial.update({ where: { id: p.id }, data })
    else await tx.sampleMaterial.create({ data: { ...data, roundId: round.id } })
  }
  const saved = await tx.sampleMaterial.findMany({
    where: { roundId: round.id },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
  })
  return saved.map(bomLineOf)
}

// ── The making route ─────────────────────────────────────────────────────────

/** A step as an operation of the master gives it, before anyone changes it. */
function stepOf(o: {
  id: string
  name: string
  kind: SampleRouteStep['kind']
  departmentId: string
  defaultExecution: SampleRouteStep['execution']
  instructions: string | null
}): SampleRouteStep {
  return {
    operationId: o.id,
    name: o.name,
    kind: o.kind,
    departmentId: o.departmentId,
    execution: o.defaultExecution,
    contractorId: null,
    vendorId: null,
    instructions: o.instructions ?? '',
  }
}
/** The kinds of step a sample usually goes through, in the order it goes through them. */
const USUAL_KINDS = ['CUTTING', 'STITCHING', 'FINISHING', 'QC'] as const
/**
 * The route a sample is usually made on, from the Operation master: for each
 * of cutting, stitching, finishing and the check, the process in use listed
 * first (lowest sort order, then code). A kind with no process in use is left
 * out. Where each is done is the process's own default.
 */
export async function routeTemplate(tx: Tx): Promise<SampleRouteStep[]> {
  const ops = await tx.operation.findMany({
    where: { isActive: true, kind: { in: [...USUAL_KINDS] }, department: { isActive: true } },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    select: {
      id: true,
      name: true,
      kind: true,
      departmentId: true,
      defaultExecution: true,
      instructions: true,
    },
  })
  return USUAL_KINDS.flatMap((kind) => {
    const op = ops.find((o) => o.kind === kind)
    return op ? [stepOf(op)] : []
  })
}
/**
 * A routing's steps as a sample's route, for a merchandiser who wants the
 * style's production route: no rates. A step given to an outside unit takes
 * that unit when the routing names a job-work workstation of one.
 */
export async function routingAsRoute(tx: Tx, routingId: string): Promise<SampleRouteStep[]> {
  const routing = await tx.routing.findFirst({
    where: { id: routingId, isActive: true },
    select: {
      steps: {
        orderBy: { sequence: 'asc' },
        select: {
          operationId: true,
          departmentId: true,
          contractorId: true,
          execution: true,
          instructions: true,
          operation: { select: { name: true, kind: true, departmentId: true, instructions: true } },
          workstation: { select: { type: true, supplierId: true } },
        },
      },
    },
  })
  if (!routing) throw new AppError('That routing is not in use.', 404, 'NOT_FOUND')
  return routing.steps.map((s) => {
    const outside = s.execution === 'OUTSOURCED'
    return {
      operationId: s.operationId,
      name: s.operation.name,
      kind: s.operation.kind,
      // The process's own department, which a sample step keeps (fitRoute);
      // the same as the routing's unless the process has moved since.
      departmentId: s.operation.departmentId,
      execution: s.execution,
      // A step done outside has no floor contractor on a sample's route.
      contractorId: outside ? null : s.contractorId,
      vendorId:
        outside && s.workstation?.type === 'JOB_WORK' ? (s.workstation.supplierId ?? null) : null,
      instructions: s.instructions ?? s.operation.instructions ?? '',
    }
  })
}
/**
 * A route checked against the masters and filled in from them: each step
 * takes its process's kind and department, and its name unless the
 * merchandiser gave another. A process, department, contractor or unit picked
 * must still be in use, and a step is done by its process's own department and
 * a contractor who takes the process, by the routing master's own rules
 * (assertRoutingRefsExist, assertContractorsFit): the route becomes a routing
 * at handover, and the floor books its work by department. Only a step with no
 * process yet (an old round's, or one being filled in) names a department of
 * its own. Steps not yet complete pass here; sampleSpecGaps says what they lack.
 */
async function fitRoute(tx: Tx, steps: SampleRouteStep[]): Promise<SampleRouteStep[]> {
  const ids = (pick: (s: SampleRouteStep) => string | null) => [
    ...new Set(steps.map(pick).filter((x): x is string => !!x)),
  ]
  const opIds = ids((s) => s.operationId)
  const ops = new Map(
    (opIds.length
      ? await tx.operation.findMany({
          where: { id: { in: opIds } },
          select: { id: true, name: true, kind: true, departmentId: true, isActive: true },
        })
      : []
    ).map((o) => [o.id, o])
  )
  const deptIds = [
    ...new Set([...ids((s) => s.departmentId), ...[...ops.values()].map((o) => o.departmentId)]),
  ]
  const vendorIds = ids((s) => s.vendorId)
  const contractorIds = ids((s) => s.contractorId)
  const [depts, vendors, contractors] = await Promise.all([
    deptIds.length
      ? tx.department.findMany({
          where: { id: { in: deptIds } },
          select: { id: true, name: true, isActive: true },
        })
      : [],
    // Any supplier in use can take job work, as the floor's job-work orders allow.
    vendorIds.length
      ? tx.supplier.findMany({
          where: { id: { in: vendorIds }, isActive: true },
          select: { id: true },
        })
      : [],
    contractorIds.length
      ? tx.contractor.findMany({
          where: { id: { in: contractorIds }, isActive: true },
          select: { id: true },
        })
      : [],
  ])
  const live = (list: Array<{ id: string }>) => new Set(list.map((x) => x.id))
  const [deptOk, vendorOk, contractorOk] = [
    live(depts.filter((d) => d.isActive)),
    live(vendors),
    live(contractors),
  ]
  const deptName = new Map(depts.map((d) => [d.id, d.name]))
  const route = steps.map((s, i): SampleRouteStep => {
    const at = `Step ${i + 1}:`
    const op = s.operationId ? ops.get(s.operationId) : undefined
    if (s.operationId && !op?.isActive)
      fail(`${at} pick a process that is still in use.`, 'BAD_OPERATION')
    // In the routing master's words (routing.service assertRoutingRefsExist).
    if (op && s.departmentId && s.departmentId !== op.departmentId)
      fail(
        `${at} ${op.name} is a ${deptName.get(op.departmentId) ?? 'different department'} operation, not ${deptName.get(s.departmentId) ?? 'this department'}. Pick the department it belongs to, or another operation.`,
        'STEP_DEPARTMENT_MISMATCH'
      )
    const departmentId = op ? op.departmentId : s.departmentId || ''
    if (departmentId && !deptOk.has(departmentId))
      fail(`${at} pick a department that is still in use.`, 'BAD_DEPARTMENT')
    if (s.vendorId && !vendorOk.has(s.vendorId))
      fail(`${at} that unit is not an active supplier.`, 'BAD_VENDOR')
    if (s.contractorId && !contractorOk.has(s.contractorId))
      fail(`${at} pick a contractor who is still in use.`, 'BAD_CONTRACTOR')
    return {
      operationId: s.operationId,
      name: s.name.trim() || op?.name || '',
      kind: op?.kind ?? s.kind,
      departmentId,
      execution: s.execution,
      contractorId: s.contractorId || null,
      vendorId: s.vendorId || null,
      instructions: s.instructions.trim(),
    }
  })
  // A contractor is checked against the step's process once one is picked.
  await assertContractorsFit(
    tx,
    route.map((s) => ({
      operationId: s.operationId,
      contractorId: s.operationId ? s.contractorId : null,
    }))
  )
  return route
}

/**
 * A specification complete enough to save as complete, or to release: the
 * same shape as a draft, with nothing missing (sampleSpecGaps, the list the
 * screen shows) and a route every routing would accept (checkRouteSteps:
 * cutting first, and only once). Returns the route's warnings, such as no
 * quality check, which do not stop it.
 */
async function assertComplete(tx: Tx, s: SampleSpecification, customerId: string | null) {
  const style = await tx.style.findUnique({
    where: { id: s.styleId },
    select: {
      colors: true,
      sizeGroup: { select: { sizes: { select: { id: true, code: true } } } },
    },
  })
  const sizes = style?.sizeGroup?.sizes ?? []
  const gaps = sampleSpecGaps(s, {
    style: style ? { colors: style.colors, sizeIds: sizes.map((z) => z.id) } : null,
    sizes,
    hasBuyer: !!customerId,
  })
  if (gaps.length)
    throw new AppError(
      gaps.length === 1
        ? gaps[0].message
        : `Still to finish: ${gaps.map((g) => g.message).join(' ')}`,
      400,
      'SPEC_INCOMPLETE'
    )
  return checkRouteSteps(
    tx,
    s.route.map((step) => ({ operationId: step.operationId }))
  )
}
/** SAVE_SPEC and RELEASE: the whole specification checked, its BOM rows written. */
async function completeSpec(
  tx: Tx,
  round: { id: string; materials: MaterialRow[] },
  raw: unknown,
  owner: { brandId: string; customerId: string | null; styleId: string | null }
) {
  const parsed = sampleSpecificationSchema.parse(raw)
  await shareStyle(tx, parsed.styleId)
  const s = await validateSpec(tx, parsed, owner)
  const full: SampleSpecification = { ...s, route: await fitRoute(tx, s.route) }
  const warnings = await assertComplete(tx, full, owner.customerId)
  const materials = await syncBomRows(tx, round, full, full.materials, {
    draft: false,
    customerId: owner.customerId,
  })
  return { spec: { ...full, materials }, warnings }
}
function held(m: {
  issuedQty: unknown
  returnedQty: unknown
  usedQty: unknown
  wasteQty: unknown
}) {
  return round3(n(m.issuedQty) - n(m.returnedQty) - n(m.usedQty) - n(m.wasteQty))
}
type RoundState = { id: string; revision: number; state: string; releasedAt: Date | null }
const released = (x: RoundState) => !!x.releasedAt || x.state !== 'DRAFT'
/** Whether any round has left draft: from then on buyer, brand and style are history. */
function everReleased(request: { rounds: RoundState[] }) {
  return request.rounds.some(released)
}
/**
 * The style the first released round was made in, or ''. A request released
 * before requests named their own style has only this to say which it samples.
 */
function releasedStyleId(request: { rounds: Array<RoundState & { specification: unknown }> }) {
  const first = request.rounds.filter(released).sort((a, b) => a.revision - b.revision)[0]
  return first ? String((first.specification as SampleSpecification).styleId ?? '') : ''
}
const STYLE_FIXED =
  'The style is fixed once a round has been released, as the buyer and brand are. Raise a new request to sample another style.'

/**
 * Why a file can no longer be taken off the request, or null while it can.
 *
 * What a round was made and judged from is the files it had when it was
 * released, and the tech pack a release followed; those stay. A file added
 * after the release it would belong to (a photo of the finished sample, a
 * wrong upload) was no part of it, so it can still be removed, with a reason,
 * until the request is cancelled or handed over. Locking every file the
 * moment it landed made a wrong photo permanent and, with five a kind, could
 * fill a round for good. A newer version of a kept file is added beside it.
 * The file list and DETACH both ask here, so the screen and the rule agree.
 */
export function attachmentLock(
  request: { cancelledAt: Date | null; rounds: Array<RoundState & { handover: unknown }> },
  file: { roundId: string | null; kind: string; createdAt: Date }
): string | null {
  if (request.cancelledAt) return 'This request is cancelled; its files are kept with it.'
  if (request.rounds.some((x) => x.handover))
    return 'This request has a production handover; its files are kept with it.'
  // Out of draft but with no release time: from before the time was kept, so
  // nobody can say the file came later, and it stays.
  const releasedWith = (round: RoundState) =>
    round.releasedAt ? file.createdAt <= round.releasedAt : round.state !== 'DRAFT'
  const round = file.roundId ? request.rounds.find((x) => x.id === file.roundId) : undefined
  if (round && releasedWith(round))
    return `Round ${round.revision} was released with this file, so it is kept as the record of what was made.`
  // A tech pack is the request's, not one round's: kept once any round has
  // been released on it, so a newer one added before round 2 is kept by it.
  if (!file.roundId && file.kind === 'TECH_PACK' && request.rounds.some(releasedWith))
    return 'A round has been released on this tech pack, so it is kept. Add the newer version beside it instead.'
  return null
}

/**
 * Why one more file of this kind cannot be filed here, or null while it can.
 *
 * Five of a kind against the whole request, and five against each round: a
 * photo of round 3 must not be refused because rounds 1 and 2 already have
 * theirs, which could never be removed. Upload-url asks first, so nobody
 * sends a file only to be turned away, and ATTACH again under the lock.
 */
export function fileLimitProblem(
  request: {
    number: string
    cancelledAt: Date | null
    rounds: Array<RoundState & { handover: unknown }>
  },
  files: Array<{ roundId: string | null; kind: string; createdAt: Date }>,
  kind: SampleAttachmentKind,
  roundId: string | null
): string | null {
  const here = files.filter((f) => f.kind === kind && (f.roundId ?? null) === roundId)
  if (here.length < MAX_FILES_PER_DOCUMENT) return null
  const round = roundId ? request.rounds.find((x) => x.id === roundId) : undefined
  const where = round ? `Round ${round.revision} of ${request.number}` : request.number
  const what = `${MAX_FILES_PER_DOCUMENT} ${SAMPLE_ATTACHMENT_KIND_LABEL[kind].toLowerCase()} files`
  // "Remove one" only when one can be removed.
  if (here.every((f) => attachmentLock(request, f)))
    return `${where} already has ${what}, kept as the record of what was made. File the new one against ${roundId ? 'the whole request or a later round' : 'the round it is for'}.`
  return `${where} already has ${what}. Remove one before adding another.`
}

/**
 * A stored file's name as upload-url hands it out (storagePathFor: a random
 * part, a dash, the cleaned file name). Nothing else is filed. Cloud storage
 * reads "x.pdf#" or "x.pdf?v=2" as x.pdf, and a Windows disk reads "X.PDF" as
 * x.pdf, so another spelling would put a second row on a kept file, and
 * removing that row would delete the file under the kept one.
 */
const STORED_FILE_NAME = /^[a-z0-9]{1,8}-[A-Za-z0-9_.-]{1,80}$/

/**
 * A draft specification moved onto another style, or off one. What still fits
 * is kept; a colour the new style does not have goes with its sizes and its
 * own material lines, and a size outside the new run goes with its
 * measurements, as the specification form clears them when the style is
 * changed. Lines for every colour stay, their quantities worked out again for
 * what is left. Drafts have nothing issued, so no line is held back. Says
 * what each draft lost, for the event.
 */
async function refitDrafts(
  tx: Tx,
  rounds: Array<{
    id: string
    revision: number
    state: string
    specification: SampleSpecification
    materials: MaterialRow[]
  }>,
  style: { id: string; colors: string[]; sizeGroupId: string | null } | null,
  customerId: string | null
) {
  const drafts = rounds.filter((x) => x.state === 'DRAFT')
  if (!drafts.length) return undefined
  const sizeIds = new Set(
    style?.sizeGroupId
      ? (
          await tx.size.findMany({
            where: { sizeGroupId: style.sizeGroupId },
            select: { id: true },
          })
        ).map((x) => x.id)
      : []
  )
  const fits = (sizeId: string) => !sizeId || sizeIds.has(sizeId)
  const report = []
  for (const draft of drafts) {
    const s = draft.specification
    let coloursDropped = 0
    let sizesDropped = 0
    const colours = s.colours.flatMap((row) => {
      const asked = row.colour.trim()
      // A row whose colour is not picked yet stays, as it was.
      const own = asked ? style?.colors.find((c) => c.toLowerCase() === asked.toLowerCase()) : ''
      if (own === undefined) {
        coloursDropped++
        return []
      }
      const sizes = row.sizes.filter((x) => fits(x.sizeId))
      sizesDropped += row.sizes.length - sizes.length
      return [{ colour: own, sizes }]
    })
    const measurements = s.measurements.filter((x) => fits(x.sizeId))
    const next: SampleSpecification = { ...s, styleId: style?.id ?? '', colours, measurements }
    const kept = new Set(colours.map((c) => c.colour.toLowerCase()).filter(Boolean))
    const before = currentLines(draft)
    const lines = before.filter((l) => !l.colour?.trim() || kept.has(l.colour.trim().toLowerCase()))
    const materials = await syncBomRows(tx, draft, next, lines, {
      draft: true,
      copy: true,
      customerId,
    })
    await tx.sampleRound.update({
      where: { id: draft.id },
      data: { specification: json({ ...next, materials }) },
    })
    report.push({
      revision: draft.revision,
      coloursDropped,
      sizesDropped,
      measurementsDropped: s.measurements.length - measurements.length,
      materialsDropped: before.length - lines.length,
    })
  }
  return report
}

/** A size run the style can be made in: switched on, with sizes in it. */
async function assertSizeRun(tx: Tx, sizeGroupId: string) {
  const run = await tx.sizeGroup.findFirst({
    where: { id: sizeGroupId, isActive: true },
    select: { _count: { select: { sizes: true } } },
  })
  if (!run) fail('Pick an active size run.')
  if (!run._count.sizes) fail('That size run has no sizes yet. Add its sizes in the masters first.')
}

/*
 * A style's row lock. UPDATE_STYLE takes it to change the style; a release
 * takes it shared, so the colours and size run it checks cannot be changed
 * until it has committed, and a change that would remove a colour then sees
 * the released round. Always taken after the request's own lock.
 */
async function lockStyle(tx: Tx, styleId: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.styles WHERE id = ${styleId} FOR UPDATE`
}
async function shareStyle(tx: Tx, styleId: string) {
  if (styleId) await tx.$queryRaw`SELECT id FROM ld_erp.styles WHERE id = ${styleId} FOR SHARE`
}
/** Other open requests that sample this style (cancelled ones no longer do). */
function otherRequestsOn(tx: Tx, styleId: string, requestId: string) {
  return tx.sampleRequest.findMany({
    where: { styleId, id: { not: requestId }, cancelledAt: null },
    select: { number: true },
    orderBy: { number: 'asc' },
  })
}

let savepoints = 0
/**
 * The style a request makes for itself, coded the way the Styles master codes
 * one (brand, garment, season, number). It is made inside the request's own
 * transaction, where a clash on the code would otherwise abort everything, so
 * each try is wrapped in a savepoint and the next number is tried instead.
 */
async function createDevelopmentStyle(
  tx: Tx,
  data: {
    name: string
    category: string | null
    season: string | null
    sizeGroupId: string
    colors: string[]
    brandId: string
    brandType: Prisma.StyleCreateInput['brandType']
  }
) {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = await nextStyleCode(data, attempt)
    const savepoint = `sample_style_${++savepoints}`
    await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`)
    try {
      const style = await tx.style.create({
        data: { ...data, code, stage: 'DEVELOPMENT' },
        select: sampleStyleSelect,
      })
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`)
      return style
    } catch (err) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`)
      const e = err as { code?: string; meta?: { target?: unknown } }
      if (e?.code !== 'P2002' || !String(e.meta?.target ?? '').includes('code')) throw err
    }
  }
  return fail(
    'Another style took the next code at the same moment. Save again.',
    'STYLE_CODE_TAKEN'
  )
}
const styleFacts = (s: {
  name: string
  category: string | null
  season: string | null
  sizeGroupId: string | null
  colors: string[]
}) => ({
  name: s.name,
  category: s.category,
  season: s.season,
  sizeGroupId: s.sizeGroupId,
  colors: s.colors,
})

/**
 * What the route does once the action has committed: files whose rows went
 * with it, and the audit rows, which name what the action really touched.
 */
export interface SampleAfterCommit {
  removeObjects: string[]
  /** The round the action's event names, which for a file is the file's own round. */
  eventRoundId?: string | null
  /** A style made or changed from the request: a masters record, audited as one. */
  styleAudit?: { action: 'CREATE' | 'UPDATE'; styleId: string; before?: unknown; after: unknown }
  /** What the action allowed but the screen should say, such as a route with no check. */
  warnings?: string[]
}
/** Actions on the request as a whole, which name no round of their own. */
const REQUEST_ACTIONS = [
  'CANCEL',
  'CLOSE_MATERIAL',
  'UPDATE_REQUEST',
  'ATTACH',
  'DETACH',
  'CREATE_STYLE',
  'LINK_STYLE',
  'UPDATE_STYLE',
]

/** Parent row lock + expected version serialize all decisions, quantities and retries. */
export async function actOnSample(
  tx: Tx,
  id: string,
  cmd: z.infer<typeof sampleActionSchema>,
  actor: Actor,
  after: SampleAfterCommit = { removeObjects: [] }
) {
  await tx.$queryRaw`SELECT id FROM ld_erp.sample_requests WHERE id = ${id} FOR UPDATE`
  const request = await sampleDetail(tx, id)
  if (request.version !== cmd.version)
    fail('This sample changed in another window. Refresh it before saving.', 'STALE_SAMPLE')
  // Leftover material is closed out after a cancellation too.
  if (request.cancelledAt && cmd.action !== 'CLOSE_MATERIAL') fail('This request is cancelled.')
  const r = request.rounds.find((x) => x.id === cmd.roundId)
  if (
    !REQUEST_ACTIONS.includes(cmd.action) &&
    // Material, and making's costs once their bills are known, on any round.
    (!r ||
      (cmd.action !== 'MATERIAL' &&
        !MAKING_COST_ACTIONS.includes(cmd.action) &&
        request.rounds[0].id !== r.id))
  )
    fail('Only the latest sample round can be changed.')
  const round = r!
  const spec = round?.specification
  const approver = ['RELEASE', 'QC', 'DECIDE', 'DROP_COLOUR', 'HANDOVER', 'CANCEL'].includes(cmd.action)
  grant(actor, 'sampling', approver ? 'approve' : 'edit')
  if (
    ['ATTACH', 'DETACH', 'CREATE_STYLE', 'LINK_STYLE', 'UPDATE_STYLE'].includes(cmd.action) &&
    request.rounds.some((x) => x.handover)
  )
    fail('This request has a production handover. Its details are now frozen.')
  let detail: unknown = cmd.data
  let eventRoundId: string | undefined = round?.id
  const owner = {
    brandId: request.brandId,
    customerId: request.customerId,
    styleId: request.styleId,
  }
  switch (cmd.action) {
    case 'UPDATE_REQUEST': {
      if (request.rounds.some((x) => x.handover))
        fail('This request has a production handover. Its details are now frozen.')
      const { reason, ...d } = updateSampleRequestSchema.parse(cmd.data)
      const identityChanged = d.brandId !== request.brandId || d.customerId !== request.customerId
      if (identityChanged && everReleased(request))
        fail(
          'Buyer and brand are locked after the first release to preserve stock ownership and approval history.'
        )
      if (d.brandId !== request.brandId) {
        // A style belongs to one brand, so the request's style cannot follow it.
        if (request.style)
          fail(
            `${request.style.code} belongs to the current brand. Take the style off the request before changing its brand.`,
            'STYLE_BRAND'
          )
        if (!(await tx.brand.findFirst({ where: { id: d.brandId, isActive: true } })))
          fail('Pick an active brand.')
        for (const draft of request.rounds)
          await validateSpec(
            tx,
            draft.specification,
            { brandId: d.brandId, customerId: d.customerId, styleId: request.styleId },
            true
          )
      }
      if (
        d.customerId !== request.customerId &&
        d.customerId &&
        !(await tx.customer.findFirst({ where: { id: d.customerId, isActive: true } }))
      )
        fail('Pick an active buyer.')
      const before = {
        title: request.title,
        customerId: request.customerId,
        brandId: request.brandId,
        buyerRef: request.buyerRef ?? '',
        owner: request.owner,
        brief: request.brief,
        requiredAt: request.requiredAt?.toISOString().slice(0, 10) ?? null,
        buyerStyleRef: request.buyerStyleRef,
        season: request.season,
        garmentCategory: request.garmentCategory,
      }
      // Tech-pack details left out are unchanged (a screen that does not show
      // them must not wipe them); an emptied box is saved as nothing.
      const next = (value: string | null | undefined, was: string | null) =>
        value === undefined ? was : value || null
      const intake = {
        buyerStyleRef: next(d.buyerStyleRef, request.buyerStyleRef),
        season: next(d.season, request.season),
        garmentCategory: next(d.garmentCategory, request.garmentCategory),
      }
      await tx.sampleRequest.update({
        where: { id },
        data: { ...d, ...intake, requiredAt: d.requiredAt ? new Date(d.requiredAt) : null },
      })
      detail = { reason, before, after: { ...d, ...intake } }
      break
    }
    case 'SAVE_DRAFT': {
      if (round.state !== 'DRAFT')
        fail('Released specifications are frozen. Make a new round to change them.')
      const patch = sampleDraftPatchSchema.parse(cmd.data)
      // A patch without its materials leaves the lines as the rows have them,
      // and works their quantities out again for the grid as it now is.
      const draft = sampleDraftSchema.parse({
        ...spec,
        ...patch,
        materials: patch.materials ?? currentLines(round),
      })
      const s = await validateSpec(tx, draft, owner, true)
      const route = await fitRoute(tx, s.route)
      const materials = await syncBomRows(tx, round, s, s.materials, {
        draft: true,
        customerId: request.customerId,
      })
      const saved: SampleSpecification = { ...s, route, materials }
      await tx.sampleRound.update({ where: { id: round.id }, data: { specification: json(saved) } })
      detail = { specification: saved }
      break
    }
    case 'SAVE_SPEC': {
      if (round.state !== 'DRAFT')
        fail('Released specifications are frozen. Make a new round to change them.')
      const { spec: s, warnings } = await completeSpec(tx, round, cmd.data, owner)
      await tx.sampleRound.update({ where: { id: round.id }, data: { specification: json(s) } })
      after.warnings = warnings
      detail = { specification: s }
      break
    }
    case 'RELEASE': {
      if (round.state !== 'DRAFT') fail('Only a draft round can be released.')
      // The specification sent with the release, or the saved draft with its rows.
      const sent = cmd.data && typeof cmd.data === 'object' && 'styleId' in cmd.data
      const { spec: s, warnings } = await completeSpec(
        tx,
        round,
        sent ? cmd.data : { ...spec, materials: currentLines(round) },
        owner
      )
      after.warnings = warnings
      // The route as released: each step's process, department and who does it.
      await tx.sampleStage.createMany({
        data: s.route.map((st, i) => ({
          roundId: round.id,
          sequence: i + 1,
          name: st.name,
          operationId: st.operationId,
          kind: st.kind,
          departmentId: st.departmentId || null,
          execution: st.execution,
          contractorId: st.contractorId,
          vendorId: st.vendorId,
          instructions: st.instructions || null,
        })),
      })
      await tx.sampleRound.update({
        where: { id: round.id },
        data: {
          state: 'RELEASED',
          specification: json(s),
          releasedAt: new Date(),
          releasedById: actor.id,
        },
      })
      // A request begun before it named its style takes the style its first
      // released round was made in, so every released request says which it is.
      if (!request.styleId)
        await tx.sampleRequest.update({ where: { id }, data: { styleId: s.styleId } })
      detail = {
        revision: round.revision,
        milestone: s.milestone,
        ...(request.styleId ? {} : { styleId: s.styleId }),
      }
      break
    }
    case 'MATERIAL': {
      // A sample store is Sampling's own: sampling rights issue from it, not
      // inventory rights (MATERIAL issues from sample stores only).
      if (round.state === 'DRAFT' || round.handover)
        fail('Release the round before issuing material; a handed-over round is frozen.')
      const d = sampleMaterialSchema.parse(cmd.data),
        m = round.materials.find((x) => x.id === d.materialId)
      if (!m) fail('This material is not on the round.')
      const material = m!
      if (!material.itemId)
        fail('This line has no material picked, so nothing can be issued against it.', 'NO_ITEM')
      // One store per line: named at the first issue, then every issue and
      // return goes through it, so what the line holds is in one place. A line
      // with nothing of it out may be issued from another store, which it then
      // keeps (a later delivery received into another sample store, or a line
      // issued from a general store before sample stores).
      const store = material.warehouse?.name ?? 'another store'
      const out = round3(n(material.issuedQty) - n(material.returnedQty))
      const switching =
        d.kind === 'ISSUE' &&
        !!material.warehouseId &&
        !!d.warehouseId &&
        d.warehouseId !== material.warehouseId &&
        out <= 0
      if (
        (d.kind === 'ISSUE' || d.kind === 'RETURN') &&
        material.warehouseId &&
        d.warehouseId &&
        d.warehouseId !== material.warehouseId &&
        !switching
      )
        fail(
          d.kind === 'RETURN'
            ? `This material was issued from ${store}. Return it there.`
            : n(material.issuedQty) > 0
              ? `This material was issued from ${store}. Issue the rest from there.`
              : `This material is planned from ${store}. Issue it from there.`,
          'OTHER_STORE'
        )
      // Ours when we buy it; the buyer's when they send it.
      const ownership = material.source === 'BUYER_SUPPLIED' ? 'CUSTOMER_OWNED' : 'OWNED'
      const key = {
        itemId: material.itemId!,
        warehouseId: material.warehouseId ?? '',
        ownership,
        ownerCustomerId: ownership === 'CUSTOMER_OWNED' ? request.customerId : null,
      } as const
      // Stock put back into a general store is an inventory act (a line issued
      // from one before sample stores); a sample store is Sampling's own.
      if (d.kind === 'RETURN' && material.warehouse && material.warehouse.purpose !== 'SAMPLING')
        grant(actor, 'inventory', 'edit')
      if (d.kind === 'ISSUE') {
        if (round.state !== 'RELEASED' || round.stages.some((x) => x.completedAt))
          fail('Issue materials before making starts; extra needs require a new round.')
        if (material.waivedAt)
          fail('This line is waived. Take the waiver off before issuing against it.', 'LINE_WAIVED')
        const firstStore = !material.warehouseId
        if (firstStore && !d.warehouseId)
          throw new AppError('Pick the store to issue this material from.', 400, 'STORE_REQUIRED')
        const storeId = switching ? d.warehouseId! : (material.warehouseId ?? d.warehouseId!)
        const picking = firstStore || switching
        // A sample's material is issued from a sample store, where it was
        // received for it (or where the buyer's own material was received).
        const from = await tx.warehouse.findUnique({
          where: { id: storeId },
          select: { name: true, isActive: true, purpose: true },
        })
        if (!from || (picking && !from.isActive)) fail('Pick an active store.')
        if (from!.purpose !== 'SAMPLING')
          fail(
            picking
              ? `${from!.name} is a general store. A sample's material is issued from the sample store it was received into.`
              : `This line was issued from ${from!.name}, a general store, before sample stores kept sample material apart. Return what is out of it there; then it is issued from the sample store. Or mark the rest not needed.`,
            'NOT_SAMPLE_STORE'
          )
        const unit = material.item?.uom?.symbol ?? ''
        if (material.source === 'PURCHASE') {
          // No more than this request bought and still holds there (samplePool):
          // never another sample's material.
          const pool = await requestPool(tx, id)
          const free = availableIn(pool, material.itemId!, storeId)
          if (round3(d.qty) > free + 1e-9) {
            // Where the rest of it is, if it was received into another sample store.
            const elsewhere = pool.stores.filter(
              (s) => s.itemId === material.itemId && s.warehouseId !== storeId && s.available > 0
            )
            const names = elsewhere.length
              ? await tx.warehouse.findMany({
                  where: { id: { in: elsewhere.map((s) => s.warehouseId) } },
                  select: { id: true, name: true },
                })
              : []
            const there = elsewhere
              .map((s) => `${s.available} ${unit} in ${names.find((w) => w.id === s.warehouseId)?.name ?? 'another sample store'}`)
              .join(' and ')
            fail(
              (free > 0
                ? `Only ${free} ${unit} of ${material.item?.name ?? 'this material'} bought for this request is in ${from!.name}. Issue ${free} or less`
                : `Nothing of ${material.item?.name ?? 'this material'} bought for this request is in ${from!.name}`) +
                (there
                  ? `; ${there} for it. A line is issued from one store: issue from there once nothing of this line is out.`
                  : free > 0
                    ? '; buy or receive the rest first.'
                    : ' yet. Receive it against its purchase order first.'),
              'POOL_SHORT'
            )
          }
        } else if (round3(out + d.qty) > n(material.plannedQty) + 1e-9) {
          // The buyer's material is theirs, sent for their samples: no more of
          // it than this line's plan, so another of their samples keeps its share.
          const left = round3(Math.max(0, n(material.plannedQty) - out))
          fail(
            left > 0
              ? `The buyer sent ${material.item?.name ?? 'this material'} for their samples: issue no more than the ${left} ${unit} this line still needs.`
              : `This line has all of the buyer's ${material.item?.name ?? 'material'} it plans for.`,
            'BUYER_PLAN'
          )
        }
        const movement = await recordMovement(tx, {
          ...key,
          warehouseId: storeId,
          direction: 'OUT',
          qty: d.qty,
          transactionType: 'ISSUE',
          referenceType: 'SAMPLING',
          referenceId: round.id,
          notes: `${request.number}: ${d.reason}`,
        })
        await tx.sampleMaterial.update({
          where: { id: material.id },
          data: {
            ...(picking ? { warehouseId: storeId } : {}),
            issuedQty: { increment: d.qty },
            issuedValue: { increment: round2(d.qty * movement.unitRate) },
          },
        })
      } else {
        if (d.qty > held(material)) fail('That is more material than this round still holds.')
        if (d.kind === 'RETURN') {
          const rate =
            n(material.issuedQty) > 0 ? n(material.issuedValue) / n(material.issuedQty) : 0
          await recordMovement(tx, {
            ...key,
            direction: 'IN',
            qty: d.qty,
            unitRate: rate,
            transactionType: 'RETURN',
            referenceType: 'SAMPLING',
            referenceId: round.id,
            notes: `${request.number}: ${d.reason}`,
          })
          await tx.sampleMaterial.update({
            where: { id: material.id },
            data: {
              returnedQty: { increment: d.qty },
              returnedValue: { increment: round2(d.qty * rate) },
            },
          })
        } else
          await tx.sampleMaterial.update({
            where: { id: material.id },
            data:
              d.kind === 'USE'
                ? { usedQty: { increment: d.qty } }
                : { wasteQty: { increment: d.qty } },
          })
      }
      detail = { ...d, item: material.item?.name ?? null }
      break
    }
    case 'WAIVE_MATERIAL': {
      // A line not needed after all: making may start without it. Only before
      // making starts, and only while something of it is still to issue.
      const d = sampleWaiveSchema.parse(cmd.data)
      const m = round.materials.find((x) => x.id === d.materialId)
      if (!m) fail('This material is not on the round.')
      // Once anything is worked or sent out, a line given back is issued again,
      // not waived: what was made took it.
      if (round.state !== 'RELEASED' || makingStarted(round))
        fail('A line is waived before making starts.')
      if (d.undo) {
        if (!m!.waivedAt) fail('This line is not waived.')
        await tx.sampleMaterial.update({
          where: { id: m!.id },
          data: { waivedAt: null, waivedReason: null, waivedBy: null },
        })
      } else {
        if (m!.waivedAt) fail('This line is already waived.')
        if (round3(n(m!.issuedQty) - n(m!.returnedQty)) >= n(m!.plannedQty))
          fail('This line is issued in full; there is nothing to waive.')
        await tx.sampleMaterial.update({
          where: { id: m!.id },
          data: { waivedAt: new Date(), waivedReason: d.reason, waivedBy: actor.name },
        })
      }
      detail = { ...d, item: m!.item?.name ?? null, component: m!.component }
      break
    }
    case 'CLOSE_MATERIAL': {
      // What is left of the request's own material in a sample store, once no
      // round needs it: used up in the sample, or moved to a general store.
      const d = sampleCloseOutSchema.parse(cmd.data)
      const latest = request.rounds[0]
      const settled =
        !!request.cancelledAt ||
        ['APPROVED', 'REJECTED'].includes(latest.state) ||
        request.rounds.some((x) => x.handover)
      if (!settled)
        fail(
          'Leftover material is closed out once the buyer has decided, or the request is cancelled. Until then it is kept for the next round.',
          'NOT_SETTLED'
        )
      const pool = await requestPool(tx, id)
      const free = availableIn(pool, d.itemId, d.warehouseId)
      const item = await tx.item.findUnique({
        where: { id: d.itemId },
        select: { name: true, uom: { select: { symbol: true } } },
      })
      const from = await tx.warehouse.findUnique({ where: { id: d.warehouseId }, select: { name: true, purpose: true } })
      if (!item || !from || from.purpose !== 'SAMPLING') fail('That material is not in a sample store.')
      if (round3(d.qty) > free + 1e-9)
        fail(
          `Only ${free} ${item!.uom?.symbol ?? ''} of ${item!.name} is left for this request in ${from!.name}.`,
          'POOL_SHORT'
        )
      const notes = `${request.number}: ${d.reason}`
      let value = 0
      if (d.kind === 'USED') {
        const moved = await recordMovement(tx, {
          itemId: d.itemId,
          warehouseId: d.warehouseId,
          direction: 'OUT',
          qty: d.qty,
          transactionType: 'ISSUE',
          referenceType: 'SAMPLING',
          referenceId: latest.id,
          notes: `${notes} (left over, used in the sample)`,
        })
        value = round2(d.qty * moved.unitRate)
      } else {
        // Into general stock: an inventory act, as a transfer is.
        grant(actor, 'inventory', 'edit')
        const to = await tx.warehouse.findUnique({
          where: { id: d.toWarehouseId! },
          select: { name: true, isActive: true, purpose: true },
        })
        if (!to || !to.isActive || to.purpose === 'SAMPLING')
          fail('Pick an active general store to move it to.', 'BAD_STORE')
        // Read under the stock lock the transfer takes, so the rate kept is the one it moves at.
        const carried = await lockedBalanceOf(tx, { itemId: d.itemId, warehouseId: d.warehouseId })
        await transferStock(tx, {
          itemId: d.itemId,
          fromWarehouseId: d.warehouseId,
          toWarehouseId: d.toWarehouseId!,
          qty: d.qty,
          referenceType: 'SAMPLING',
          referenceId: latest.id,
          notes: `${notes} (left over, moved to ${to!.name})`,
        })
        value = round2(d.qty * carried.avgRate)
      }
      await tx.sampleCloseOut.create({
        data: {
          requestId: id,
          roundId: latest.id,
          itemId: d.itemId,
          warehouseId: d.warehouseId,
          kind: d.kind,
          toWarehouseId: d.kind === 'MOVED' ? d.toWarehouseId! : null,
          qty: d.qty,
          value,
          reason: d.reason,
          createdById: actor.id,
        },
      })
      eventRoundId = latest.id
      detail = { ...d, item: item!.name, from: from!.name }
      break
    }
    // Making, colour by colour and size by size (sampleMaking.service).
    case 'STEP_WORK':
    case 'STEP_SEND':
    case 'STEP_RECEIVE':
    case 'JOB_SEND':
    case 'JOB_RETURN':
    case 'STEP_LABOUR':
    case 'JOB_CHARGE':
    case 'MAKING_UNDO': {
      detail = await actOnMaking(tx, cmd.action, {
        round,
        latest: request.rounds[0].id === round.id,
        handedOver: request.rounds.some((x) => x.handover),
        actor,
        data: cmd.data,
      })
      break
    }
    // QC, the buyer's samples and the buyer's word, colour by colour (sampleReview.service).
    case 'QC':
    case 'DISPATCH':
    case 'DISPATCH_CANCEL':
    case 'DECIDE':
    case 'DROP_COLOUR': {
      detail = await actOnReview(tx, cmd.action, { round, actor, data: cmd.data })
      break
    }
    case 'NEW_ROUND': {
      if (round.handover)
        fail('A handed-over round is frozen; raise a separate request for new development.')
      // A failed QC recorded before failing had a state of its own was left being made.
      const qcFailed =
        round.state === 'QC_FAILED' ||
        (round.state === 'RELEASED' && !!round.qc && (round.qc as { passed: boolean }).passed === false)
      if (!['APPROVED', 'REJECTED', 'CHANGES_REQUIRED'].includes(round.state) && !qcFailed)
        fail('Finish the buyer review before beginning another round.')
      const reason = String(cmd.data ?? '').trim()
      if (reason.length < 5 || reason.length > 2000)
        fail('Say why a revision or next milestone is needed (5–2000 characters).')
      if (round.state === 'RELEASED')
        await tx.sampleRound.update({ where: { id: round.id }, data: { state: 'QC_FAILED' } })
      // The colours the next round makes: those to make again (the buyer wants
      // them changed, or they failed QC); after an approval, the approved ones
      // for the next milestone; else all.
      const carried = new Set(coloursToCarry(colourOutcomes(round)).map(colourKey))
      const colours = spec.colours.filter((r) => carried.has(colourKey(r.colour)))
      const sizes = sizesInUse({ colours })
      const nextSpec = {
        ...spec,
        colours,
        // Measured for the sizes it still makes.
        measurements: spec.measurements.filter((m) => sizes.includes(m.sizeId)),
      }
      // The next round starts from this one's specification, its BOM lines
      // copied into rows of its own (new ids, nothing issued, the store
      // chosen again at the first issue), their quantities worked out for
      // the grid it carries over; a line for a colour it does not make is left.
      const next = await tx.sampleRound.create({
        data: {
          requestId: id,
          revision: round.revision + 1,
          specification: json({ ...nextSpec, materials: [] }),
        },
      })
      const copied = currentLines(round)
        .filter((l) => !l.colour || carried.has(colourKey(l.colour)))
        .map(({ id: _was, ...line }) => line)
      const materials = await syncBomRows(tx, { id: next.id, materials: [] }, nextSpec, copied, {
        draft: true,
        copy: true,
        customerId: request.customerId,
      })
      await tx.sampleRound.update({
        where: { id: next.id },
        data: { specification: json({ ...nextSpec, materials }) },
      })
      // A request released before requests named their style has none, and
      // the new draft could not be prepared or released without one: it takes
      // the style its rounds were made in, as RELEASE would have given it.
      const made = request.styleId ? '' : releasedStyleId(request)
      const filled =
        made &&
        (await tx.style.findFirst({
          where: { id: made, brandId: request.brandId },
          select: { id: true },
        }))
      if (filled) await tx.sampleRequest.update({ where: { id }, data: { styleId: filled.id } })
      detail = {
        fromRevision: round.revision,
        reason,
        colours: colours.map((r) => r.colour),
        materials: materials.length,
        ...(filled ? { styleId: filled.id } : {}),
      }
      break
    }
    case 'HANDOVER': {
      // Every colour the request sampled has ended (approved, rejected or
      // dropped), in whichever round, and at least one is approved.
      const ready = handoverReady(request.rounds)
      if (!ready.ready || !['APPROVED', 'REJECTED'].includes(round.state) || round.handover)
        fail('Handover requires buyer approval and can only be prepared once.')
      if (request.rounds.some((x) => x.materials.some((m) => held(m) > 0.0005)))
        fail('Account for used, wasted and returned material on every round before handover.')
      const d = sampleHandoverSchema.parse(cmd.data)
      // A style made in sampling has no BOM or route yet and cannot be given
      // one, so the usual "pick a BOM" would send people round in a circle.
      const madeHere = await tx.style.findUnique({
        where: { id: spec.styleId },
        select: { code: true, stage: true },
      })
      if (madeHere?.stage === 'DEVELOPMENT')
        fail(
          `${madeHere.code} is a new style made in sampling. Handing it over to production comes in a later update; keep the approved round as the record.`,
          'STYLE_IN_DEVELOPMENT'
        )
      const bom = await tx.bOM.findFirst({
        where: { id: d.bomId, styleId: spec.styleId, isActive: true, status: 'APPROVED' },
        include: { lines: { include: { sizes: true } } },
      })
      // A BOM for every colour, or for a colour the buyer approved, in any round.
      const approved = ready.approved.map(colourKey)
      if (!bom || (bom.color && !approved.includes(colourKey(bom.color))))
        fail('Pick an approved production BOM for this style, for every colour or for one the buyer approved.')
      const routing = await tx.routing.findFirst({
        where: { id: d.routingId, isActive: true },
        include: { steps: { orderBy: { sequence: 'asc' } }, style: { select: { code: true } } },
      })
      const style = await tx.style.findUniqueOrThrow({ where: { id: spec.styleId } })
      if (!routing || routingProblem(routing, [style]))
        fail('Pick an active routing that fits this style.')
      await tx.sampleRound.update({
        where: { id: round.id },
        data: {
          handover: json({
            ...d,
            bomVersion: bom.version,
            bomSnapshot: {
              id: bom.id,
              version: bom.version,
              styleId: bom.styleId,
              color: bom.color,
              baseSizeId: bom.baseSizeId,
              approvedAt: bom.approvedAt,
              materials: bom.lines.map((l) => ({
                itemId: l.componentItemId,
                component: l.component,
                qtyPerUnit: l.qtyPerUnit,
                wastagePercent: l.wastagePercent,
                sizes: l.sizes.map((z) => ({ sizeId: z.sizeId, qtyPerUnit: z.qtyPerUnit })),
              })),
            },
            routingVersion: routing!.version,
            routingSnapshot: {
              id: routing!.id,
              name: routing!.name,
              version: routing!.version,
              steps: routing!.steps.map((x) => ({
                sequence: x.sequence,
                operationId: x.operationId,
                departmentId: x.departmentId,
                workstationId: x.workstationId,
                contractorId: x.contractorId,
                execution: x.execution,
                instructions: x.instructions,
              })),
            },
            specification: spec,
            decision: round.decision,
            approvedColours: ready.approved,
            preparedBy: actor.name,
            preparedAt: new Date(),
          }),
        },
      })
      break
    }
    case 'ACCEPT_HANDOVER': {
      grant(actor, 'production', 'approve')
      const h = round.handover as Record<string, unknown> | null
      if (!h || h.acceptedAt)
        fail('Prepare a handover first; an accepted handover cannot be accepted again.')
      await tx.sampleRound.update({
        where: { id: round.id },
        data: { handover: json({ ...h, acceptedBy: actor.name, acceptedAt: new Date() }) },
      })
      detail = { acceptedBy: actor.name }
      break
    }
    case 'CANCEL': {
      if (request.rounds.some((x) => x.handover))
        fail('This request has a production handover and cannot be cancelled.')
      // A challan with pieces still out stays answerable: they come back, or it is cancelled, first.
      const out = request.rounds
        .flatMap((x) => x.jobWorks)
        .find((j) => !j.cancelledAt && jobOutstanding(j).some((c) => c.out > 0))
      if (out)
        fail(
          `Pieces are still with ${out.vendor?.name ?? 'an outside unit'} on ${out.number}. Record them back, or cancel the challan, before cancelling the request.`,
          'PIECES_OUT'
        )
      if (request.rounds.some((x) => x.materials.some((m) => held(m) > 0.0005)))
        fail('Return or account for material held by every round before cancelling.')
      const reason = String(cmd.data ?? '').trim()
      if (reason.length < 5 || reason.length > 2000)
        fail('Record the reason and disposition of any samples already made (5–2000 characters).')
      await tx.sampleRequest.update({
        where: { id },
        data: { cancelledAt: new Date(), cancelReason: reason },
      })
      detail = { reason }
      break
    }
    case 'ATTACH': {
      // The file is already in storage (upload-url, then the browser sent it);
      // this files it against the request, or one of its rounds.
      const d = sampleAttachSchema.parse(cmd.data)
      const roundId = d.roundId || null
      if (roundId && !request.rounds.some((x) => x.id === roundId))
        fail('That round is not on this request.')
      // A path is handed out for one request only; this stops it being replayed on another.
      const [folder, docId, name, ...rest] = d.storagePath.split('/')
      if (folder !== SAMPLE_FILE_FOLDER || docId !== id || !name || rest.length)
        throw new AppError('That file does not belong to this request', 400, 'WRONG_DOCUMENT')
      if (!STORED_FILE_NAME.test(name))
        throw new AppError(
          'That file location is not one this server hands out. Upload the file again.',
          400,
          'BAD_STORAGE_PATH'
        )
      const kind = d.kind as SampleAttachmentKind
      const full = fileLimitProblem(request, request.attachments, kind, roundId)
      if (full) throw new AppError(full, 409, 'TOO_MANY_FILES')
      // Ignoring capitals, as a Windows disk does: one stored file, one row.
      if (
        await tx.sampleAttachment.findFirst({
          where: { storagePath: { equals: d.storagePath, mode: 'insensitive' } },
          select: { id: true },
        })
      )
        fail('That file is already attached.', 'ALREADY_ATTACHED')
      // The size as storage has it, not as the browser said.
      const { sizeBytes, mimeType } = await statObject(d.storagePath)
      if (sizeBytes > MAX_FILE_BYTES) {
        await removeObject(d.storagePath).catch(() => {})
        throw new AppError(
          `That file is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024}MB.`,
          400,
          'FILE_TOO_LARGE'
        )
      }
      const file = await tx.sampleAttachment.create({
        data: {
          requestId: id,
          roundId,
          kind,
          fileName: d.fileName,
          storagePath: d.storagePath,
          mimeType,
          sizeBytes,
          uploadedById: actor.id,
          // By the same clock as releasedAt: the two are compared to tell a
          // file a round was released with from one added after it.
          createdAt: new Date(),
        },
      })
      detail = {
        attachmentId: file.id,
        storagePath: file.storagePath,
        fileName: file.fileName,
        mimeType,
        sizeBytes,
        kind,
        roundId,
      }
      eventRoundId = roundId ?? undefined
      break
    }
    case 'DETACH': {
      const d = sampleDetachSchema.parse(cmd.data)
      const file = request.attachments.find((x) => x.id === d.attachmentId)
      if (!file) throw new AppError('That file is no longer on this request.', 404, 'NOT_FOUND')
      const kept = attachmentLock(request, file)
      if (kept) fail(kept, 'FILE_KEPT')
      // The row goes with this transaction; the file itself only once it has
      // committed. A row pointing at a missing file is a broken download; a
      // file with no row merely wastes space.
      await tx.sampleAttachment.delete({ where: { id: file.id } })
      // Never the stored file while another row still names it, however that
      // row came to spell it: removing one row must not empty another.
      const twin = await tx.sampleAttachment.findFirst({
        where: { storagePath: { equals: file.storagePath, mode: 'insensitive' } },
        select: { id: true },
      })
      if (!twin) after.removeObjects.push(file.storagePath)
      detail = {
        attachmentId: file.id,
        reason: d.reason,
        fileName: file.fileName,
        kind: file.kind,
        roundId: file.roundId,
        storagePath: file.storagePath,
      }
      eventRoundId = file.roundId ?? undefined
      break
    }
    case 'CREATE_STYLE': {
      // The buyer's style is usually new to us: it is made here, kept in
      // sampling (DEVELOPMENT), and needs no masters rights to make.
      const d = sampleCreateStyleSchema.parse(cmd.data)
      if (request.styleId)
        fail(
          'This request already has its style. Change its details, or link another style instead.',
          'STYLE_ALREADY_SET'
        )
      if (everReleased(request)) fail(STYLE_FIXED, 'STYLE_FIXED')
      const brand = await tx.brand.findFirst({
        where: { id: request.brandId, isActive: true },
        select: { id: true, type: true },
      })
      if (!brand) fail('Pick an active brand for the request first.')
      // The tech-pack details on the request stand in for one left out here;
      // one sent empty was cleared on purpose and stays empty.
      const from = (value: string | null | undefined, onRequest: string | null) =>
        value === undefined ? onRequest : value || null
      const category = from(d.category, request.garmentCategory)
      // Its first letters go into the code, which never changes, as Masters →
      // Styles also insists: without it every such style is coded GN.
      if (!category)
        throw new AppError(
          'Name the garment. Its first letters go into the style code, which cannot change later.',
          400,
          'CATEGORY_REQUIRED'
        )
      await assertSizeRun(tx, d.sizeGroupId)
      const style = await createDevelopmentStyle(tx, {
        name: d.name,
        category,
        season: from(d.season, request.season),
        sizeGroupId: d.sizeGroupId,
        colors: d.colors,
        brandId: brand.id,
        brandType: brand.type,
      })
      await tx.sampleRequest.update({ where: { id }, data: { styleId: style.id } })
      const refit = await refitDrafts(tx, request.rounds, style, request.customerId)
      detail = {
        styleId: style.id,
        code: style.code,
        stage: style.stage,
        ...styleFacts(style),
        ...(refit ? { refit } : {}),
      }
      after.styleAudit = {
        action: 'CREATE',
        styleId: style.id,
        after: await tx.style.findUniqueOrThrow({ where: { id: style.id } }),
      }
      eventRoundId = undefined
      break
    }
    case 'LINK_STYLE': {
      // A re-sample of a style we already have, or one no open request is
      // developing. Null takes the style off, so a draft can move brand.
      const d = sampleLinkStyleSchema.parse(cmd.data)
      if (everReleased(request)) {
        // A request released before requests named their style may still
        // take the one its released rounds were made in; nothing else.
        const made = request.styleId ? '' : releasedStyleId(request)
        if (!made || d.styleId !== made) fail(STYLE_FIXED, 'STYLE_FIXED')
      }
      if (d.styleId === request.styleId)
        fail(
          d.styleId
            ? 'This request already samples that style.'
            : 'This request has no style to take off.'
        )
      const style = d.styleId
        ? await tx.style.findFirst({
            where: { id: d.styleId, isActive: true },
            select: sampleStyleSelect,
          })
        : null
      if (d.styleId && !style) fail('Pick an active style.')
      if (style && style.brandId !== request.brandId)
        fail('The style must belong to this request’s brand.')
      if (style?.stage === 'DEVELOPMENT') {
        // A style in sampling belongs to the one request developing it. Two
        // requests on it would each refit only their own draft and overwrite
        // each other's colours. Locked first, so two requests cannot both
        // find it free at the same moment.
        await lockStyle(tx, style.id)
        const [developing] = await otherRequestsOn(tx, style.id, id)
        if (developing)
          fail(
            `${style.code} is being developed on ${developing.number}. Sample it from that request, or use a production style here.`,
            'STYLE_TAKEN'
          )
      }
      await tx.sampleRequest.update({ where: { id }, data: { styleId: style?.id ?? null } })
      const refit = await refitDrafts(tx, request.rounds, style, request.customerId)
      const named = (x: { id: string; code: string; stage: string } | null) =>
        x ? { id: x.id, code: x.code, stage: x.stage } : null
      detail = { before: named(request.style), after: named(style), ...(refit ? { refit } : {}) }
      eventRoundId = undefined
      break
    }
    case 'UPDATE_STYLE': {
      const d = sampleUpdateStyleSchema.parse(cmd.data)
      const linked = request.style
      if (!linked) fail('Make or link the request’s style first.', 'NO_STYLE')
      if (linked.stage !== 'DEVELOPMENT')
        fail(
          `${linked.code} is a production style. Change it in Masters → Styles.`,
          'STYLE_IN_PRODUCTION'
        )
      // Locked, then read again: the copy read with the request may already
      // be out of date, and a release checking these colours waits for us.
      await lockStyle(tx, linked.id)
      const style = await tx.style.findUniqueOrThrow({ where: { id: linked.id } })
      // Changed from the one request developing it, which refits its own draft.
      // Another open request on it (from before only one could be) would be
      // left with a draft its style no longer fits, and no word of why.
      const sharing = await otherRequestsOn(tx, style.id, id)
      if (sharing.length)
        fail(
          `${style.code} is also the style of ${sharing.map((x) => x.number).join(', ')}. A style in sampling is changed from one request only: take it off the other request first.`,
          'STYLE_SHARED'
        )
      // What any released round (of any request) was made in stays true of the
      // style: its size run, and every colour a round was made in.
      const madeIn = await tx.sampleRound.findMany({
        where: { state: { not: 'DRAFT' }, specification: { path: ['styleId'], equals: style.id } },
        select: { specification: true },
      })
      if (d.sizeGroupId !== undefined && d.sizeGroupId !== style.sizeGroupId) {
        if (madeIn.length)
          fail(
            `${style.code} has been sampled in its current size run, so the run stays. Make another style for a new run.`,
            'STYLE_SIZE_RUN_IN_USE'
          )
        await assertSizeRun(tx, d.sizeGroupId)
      }
      if (d.colors) {
        const kept = new Set(d.colors.map((c) => c.toLowerCase()))
        // Read in today's shape, so a round released before the colour grid
        // still holds on to the colour it was made in.
        const made = new Set(
          madeIn.flatMap((x) =>
            normaliseSpec(x.specification)
              .colours.map((r) => r.colour.trim().toLowerCase())
              .filter(Boolean)
          )
        )
        const lost = style.colors.filter(
          (c) => !kept.has(c.toLowerCase()) && made.has(c.toLowerCase())
        )
        if (lost.length)
          fail(
            `${lost.join(', ')} ${lost.length === 1 ? 'has' : 'have'} been sampled in a released round, so ${lost.length === 1 ? 'it stays' : 'they stay'} on the style. Colours can still be added.`,
            'STYLE_COLOUR_IN_USE'
          )
      }
      const updated = await tx.style.update({
        where: { id: style.id },
        data: {
          ...(d.name !== undefined ? { name: d.name } : {}),
          ...(d.category !== undefined ? { category: d.category || null } : {}),
          ...(d.season !== undefined ? { season: d.season || null } : {}),
          ...(d.colors ? { colors: d.colors } : {}),
          ...(d.sizeGroupId !== undefined ? { sizeGroupId: d.sizeGroupId } : {}),
        },
      })
      const refit = await refitDrafts(tx, request.rounds, updated, request.customerId)
      detail = {
        styleId: style.id,
        code: style.code,
        before: styleFacts(style),
        after: styleFacts(updated),
        ...(refit ? { refit } : {}),
      }
      after.styleAudit = { action: 'UPDATE', styleId: style.id, before: style, after: updated }
      eventRoundId = undefined
      break
    }
  }
  after.eventRoundId = eventRoundId ?? null
  await event(tx, id, request.version, cmd.action, actor, { roundId: eventRoundId, data: detail })
  return sampleDetail(tx, id, { pool: true })
}

export async function sampleLookups(tx: Tx) {
  const [customers, brands, styles, sizes, items, warehouses, boms, routings] = await Promise.all([
    tx.customer.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    tx.brand.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    tx.style.findMany({
      where: { isActive: true },
      select: {
        id: true,
        code: true,
        name: true,
        brandId: true,
        colors: true,
        sizeGroupId: true,
        stage: true,
        category: true,
        season: true,
        // The open requests on each style: one in sampling is offered only
        // to the request developing it (LINK_STYLE refuses it to any other).
        sampleRequests: {
          where: { cancelledAt: null },
          select: { id: true, number: true },
        },
      },
    }),
    tx.size.findMany({
      select: { id: true, code: true, sizeGroupId: true },
      orderBy: { sequence: 'asc' },
    }),
    tx.item.findMany({
      where: { isActive: true, type: { in: [...SAMPLE_MATERIAL_TYPES] } },
      select: sampleItemSelect,
      orderBy: { name: 'asc' },
    }),
    // Sample stores first: what a sample bought is received and issued there.
    tx.warehouse.findMany({
      where: { isActive: true },
      select: { id: true, name: true, purpose: true },
      orderBy: [{ purpose: 'desc' }, { name: 'asc' }],
    }),
    tx.bOM.findMany({
      where: { isActive: true, status: 'APPROVED' },
      select: { id: true, styleId: true, color: true, version: true },
    }),
    tx.routing.findMany({
      where: { isActive: true },
      select: { id: true, name: true, styleId: true, category: true, version: true },
    }),
  ])
  // The size runs a style made for a request can be cut in.
  const sizeGroups = await tx.sizeGroup.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  // What the specification's route and BOM are made of.
  const [operations, departments, contractors, jobWorkers, itemCategories, uoms] =
    await Promise.all([
      tx.operation.findMany({
        where: { isActive: true },
        select: {
          id: true,
          code: true,
          name: true,
          kind: true,
          departmentId: true,
          defaultExecution: true,
          instructions: true,
          sortOrder: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
      tx.department.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
      }),
      tx.contractor.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true, operationIds: true },
        orderBy: { name: 'asc' },
      }),
      // Any supplier in use can take job work, as the floor's job-work orders
      // allow; service suppliers (embroidery, washing units) are listed first.
      tx.supplier.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true, category: true },
        orderBy: { name: 'asc' },
      }),
      // For adding a material that is not in the masters yet.
      tx.itemCategory.findMany({
        where: { isActive: true },
        select: { id: true, name: true, parentId: true, departmentId: true },
        orderBy: { name: 'asc' },
      }),
      tx.uOM.findMany({
        where: { isActive: true },
        select: { id: true, name: true, symbol: true },
        orderBy: { name: 'asc' },
      }),
    ])
  const opName = new Map(operations.map((o) => [o.id, o.name]))
  return {
    customers,
    brands,
    styles,
    sizes,
    items: items.map(sampleItemOption),
    warehouses,
    boms,
    routings,
    sizeGroups,
    operations,
    departments,
    // With the processes each one takes, by name, for the step's contractor list.
    contractors: contractors.map((c) => ({
      ...c,
      operations: c.operationIds.flatMap((id) =>
        opName.has(id) ? [{ id, name: opName.get(id)! }] : []
      ),
    })),
    jobWorkers: [...jobWorkers].sort(
      (a, b) => Number(b.category === 'SERVICE') - Number(a.category === 'SERVICE')
    ),
    itemCategories,
    uoms,
  }
}

// ── Items for the sample BOM ─────────────────────────────────────────────────

/** An item as the BOM's picker shows it. A unit has no code of its own, so its symbol is its code. */
export function sampleItemOption(i: {
  id: string
  code: string
  name: string
  type: string
  departmentId: string | null
  standardRate: unknown
  uom: { id: string; name: string; symbol: string } | null
}): SampleItemOption {
  return {
    id: i.id,
    code: i.code,
    name: i.name,
    type: i.type as SampleMaterialType,
    uom: i.uom
      ? { id: i.uom.id, code: i.uom.symbol, name: i.uom.name, symbol: i.uom.symbol }
      : null,
    departmentId: i.departmentId,
    standardRate:
      i.standardRate === null || i.standardRate === undefined ? null : n(i.standardRate),
  }
}
/** Materials in use whose name or code has the words typed, for the BOM's picker. */
export async function searchSampleItems(tx: Tx, q: string, limit: number) {
  const rows = await tx.item.findMany({
    where: {
      isActive: true,
      type: { in: [...SAMPLE_MATERIAL_TYPES] },
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { code: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    select: sampleItemSelect,
    orderBy: { name: 'asc' },
    take: limit,
  })
  return rows.map(sampleItemOption)
}
