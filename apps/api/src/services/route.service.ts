import type { Prisma, PrismaClient, ProcessKind, StepExecution, StepSkip } from '@prisma/client'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { lockMo } from './wip.service'

/**
 * An order's route: which steps its pieces go through, in what order.
 *
 * The routing master says how a style (or a whole category, or any style) is
 * usually made. An order takes a copy of one when it is planned — its own
 * steps, MOStep — and is tracked against that copy, so the master can change
 * later without moving work already on the floor. The copy can itself be
 * changed for one order, but only ahead of the pieces: a step pieces have
 * reached, or gone past, stays as it is.
 */

type Db = PrismaClient | Prisma.TransactionClient

export interface RouteStep {
  id: string
  sequence: number
  name: string
  kind: ProcessKind
  isQcStep: boolean
  execution: StepExecution
  skippedAt: Date | null
}

const ordered = <T extends { sequence: number }>(steps: T[]) => [...steps].sort((a, b) => a.sequence - b.sequence)

/** The step pieces go to after this one: the next one not left out. */
export function nextStepAfter<T extends RouteStep>(steps: T[], stepId: string): T | null {
  const list = ordered(steps)
  const i = list.findIndex((s) => s.id === stepId)
  if (i < 0) return null
  return list.slice(i + 1).find((s) => !s.skippedAt) ?? null
}

/** Pieces done at this step are finished: no step after it still takes pieces. */
export const isLastStep = <T extends RouteStep>(steps: T[], stepId: string) => nextStepAfter(steps, stepId) === null

/** What has been sent to a step, bundle by bundle: the lines of its transfers, rework and cancelled ones left out. */
export interface SentLine {
  bundleId: string
  toStepId: string
  qty: number
}

export interface Destination<T> {
  step: T
  /** The step pieces finish at, into finished goods. */
  last: boolean
  /** The next one in the route's order — always, now that the order is kept. */
  next: boolean
  /** How many more pieces of each bundle may go there. */
  caps: Record<string, number>
  /** For the last step: the steps each bundle has still to go through. */
  missing: Record<string, string[]>
}

/**
 * Where pieces at one step go next: the next step of the order's route, in
 * the route's order. Nobody picks, so no step is ever passed by — to leave a
 * step out for one order, a production manager skips it on the order; to do
 * the steps in another order, the order's stages are changed ahead of the
 * pieces. Cutting is where pieces start, so nothing goes back to it. The last
 * step — into finished goods — also takes only pieces that have been through
 * every other step, so nothing gets there half-made.
 *
 * Counted in pieces, bundle by bundle: a bundle of 10 with 6 sent on can
 * still send 4. A bundle split off another carries on from what its parent
 * had been through. Empty when the step is the last one.
 */
export function destinationsFrom<T extends RouteStep>(
  steps: T[],
  fromId: string,
  bundles: Array<{ id: string; qty: number; parentId?: string | null }>,
  sent: SentLine[],
): Destination<T>[] {
  const live = ordered(steps).filter((s) => !s.skippedAt)
  const starts = new Set(live.filter((s) => s.kind === 'CUTTING').map((s) => s.id))
  if (!starts.size && live[0]) starts.add(live[0].id)
  const lastId = live[live.length - 1]?.id
  const parentOf = new Map(bundles.map((b) => [b.id, b.parentId ?? null]))
  const qtyOf = new Map(bundles.map((b) => [b.id, b.qty]))
  const direct = new Map<string, number>()
  for (const l of sent) direct.set(`${l.bundleId}|${l.toStepId}`, (direct.get(`${l.bundleId}|${l.toStepId}`) ?? 0) + l.qty)
  const through = (bundleId: string, stepId: string, depth = 0): number => {
    const own = direct.get(`${bundleId}|${stepId}`) ?? 0
    const parent = parentOf.get(bundleId)
    if (own > 0 || !parent || depth > 5) return own
    return Math.min(qtyOf.get(bundleId) ?? 0, through(parent, stepId, depth + 1))
  }

  const s = nextStepAfter(steps, fromId)
  if (!s || starts.has(s.id)) return []
  const last = s.id === lastId
  const others = live.filter((t) => !starts.has(t.id) && t.id !== s.id)
  const caps: Record<string, number> = {}
  const missing: Record<string, string[]> = {}
  for (const b of bundles) {
    const already = through(b.id, s.id)
    let cap = b.qty - already
    if (last) {
      const done = others.length ? Math.min(...others.map((t) => through(b.id, t.id))) : b.qty
      cap = Math.min(cap, done - already)
      // The steps holding it back: some of its pieces have not been through them.
      const short = others.filter((t) => through(b.id, t.id) <= already && through(b.id, t.id) < b.qty).map((t) => t.name)
      if (short.length) missing[b.id] = short
    }
    caps[b.id] = Math.max(0, cap)
  }
  return [{ step: s, last, next: true, caps, missing }]
}

/**
 * Steps a transfer passed by: those on the route between where it left and
 * where it went. Empty for a transfer that went to the next step. Transfers
 * made before the route's order was kept strictly can have some; those
 * pieces have to be taken back and sent on in order.
 */
export function passedBy<T extends RouteStep>(steps: T[], fromId: string, toId: string): T[] {
  const list = ordered(steps)
  const from = list.findIndex((s) => s.id === fromId)
  const to = list.findIndex((s) => s.id === toId)
  if (from < 0 || to <= from) return []
  return list.slice(from + 1, to).filter((s) => !s.skippedAt)
}

/** A check: what comes out is passed or failed rather than made. */
export const isCheck = (s: { isQcStep: boolean; kind: ProcessKind }) => s.isQcStep || s.kind === 'QC'

/**
 * Whether a routing can make these styles. One for a style makes only that
 * style; one for a category makes every style filed under it; one with
 * neither makes any. Null when it fits, else why not.
 */
export function routingProblem(
  routing: { styleId: string | null; category: string | null; style?: { code: string } | null },
  styles: Array<{ id: string; code: string; category: string | null }>,
): string | null {
  if (routing.styleId) {
    const other = styles.find((s) => s.id !== routing.styleId)
    return other ? `It is for ${routing.style?.code ?? 'another style'} only, and this order also makes ${other.code}.` : null
  }
  if (routing.category?.trim()) {
    const want = routing.category.trim().toLowerCase()
    const other = styles.find((s) => (s.category ?? '').trim().toLowerCase() !== want)
    return other ? `It is for ${routing.category} styles, and ${other.code} is ${other.category ? `a ${other.category}` : 'not filed under a category'}.` : null
  }
  return null
}

const routingSelect = {
  id: true,
  code: true,
  name: true,
  styleId: true,
  category: true,
  version: true,
  isActive: true,
  style: { select: { code: true, name: true } },
  steps: {
    orderBy: { sequence: 'asc' as const },
    select: {
      id: true,
      sequence: true,
      operationId: true,
      departmentId: true,
      workstationId: true,
      isQcStep: true,
      execution: true,
      skip: true,
      ratePerPiece: true,
      instructions: true,
      operation: { select: { name: true, kind: true, instructions: true, jobWorkRate: true } },
      department: { select: { name: true } },
      workstation: { select: { name: true, type: true } },
    },
  },
} satisfies Prisma.RoutingSelect

/**
 * The routings an order with these styles could take, the best fit first:
 * the style's own, then its category's, then any style's. Each carries why it
 * does not fit, when it does not, so the form can say so.
 */
export async function routingsFor(db: Db, styleIds: string[]) {
  const styles = await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, category: true } })
  const routings = await db.routing.findMany({
    where: { isActive: true, OR: [{ styleId: { in: styleIds } }, { styleId: null }] },
    select: routingSelect,
    orderBy: { code: 'asc' },
  })
  const rank = (r: { styleId: string | null; category: string | null }) => (r.styleId ? 0 : r.category?.trim() ? 1 : 2)
  return routings
    .map((r) => ({ ...r, problem: routingProblem(r, styles), applies: r.styleId ? 'STYLE' : r.category?.trim() ? 'CATEGORY' : 'ANY' }))
    .sort((a, b) => Number(!!a.problem) - Number(!!b.problem) || rank(a) - rank(b) || a.code.localeCompare(b.code))
}

/**
 * The rules every routing keeps, checked when one is saved: pieces start at
 * cutting, so a cutting step comes first and only once. Returns warnings that
 * do not stop it — no check before the end.
 */
export async function checkRouteSteps(db: Db, steps: Array<{ operationId: string; isQcStep?: boolean }>) {
  const ops = await db.operation.findMany({ where: { id: { in: [...new Set(steps.map((s) => s.operationId))] } }, select: { id: true, name: true, kind: true } })
  const op = new Map(ops.map((o) => [o.id, o]))
  const kinds = steps.map((s) => op.get(s.operationId)?.kind)
  if (kinds[0] !== 'CUTTING') {
    throw new AppError('A route starts with cutting: that is where the pieces are made. Put a cutting process first (Masters → Processes marks which ones cut).', 400, 'CUTTING_FIRST')
  }
  if (kinds.filter((k) => k === 'CUTTING').length > 1) throw new AppError('Only one cutting step: the pieces are cut once.', 400, 'ONE_CUTTING')
  const warnings: string[] = []
  if (!steps.some((s, i) => s.isQcStep || kinds[i] === 'QC')) warnings.push('There is no quality check on this route, so pieces go to finished goods without one.')
  return warnings
}

/** The styles an order makes, for choosing its routing. */
export async function stylesOfMo(db: Db, moId: string) {
  const lines = await db.mOLine.findMany({ where: { moId }, select: { style: { select: { id: true, code: true, category: true } } } })
  const seen = new Map(lines.map((l) => [l.style.id, l.style]))
  return [...seen.values()]
}

/**
 * Copies a routing's steps onto an order as its own route. Only while nothing
 * has been cut for it: after that the route is changed step by step instead.
 */
export async function applyRouting(tx: Prisma.TransactionClient, moId: string, routingId: string) {
  const [routing, styles, activity] = await Promise.all([
    tx.routing.findUnique({ where: { id: routingId }, select: routingSelect }),
    stylesOfMo(tx, moId),
    tx.wipEntry.count({ where: { moId } }),
  ])
  if (!routing) throw new AppError('That routing was not found.', 404, 'NOT_FOUND')
  if (!routing.isActive) throw new AppError(`${routing.code} is no longer in use. Pick another, or bring it back in Masters → Routings.`, 400, 'ROUTING_INACTIVE')
  if (activity) throw new AppError('Pieces have already been cut on this order, so its route is changed step by step, not replaced.', 409, 'ROUTE_IN_USE')
  const problem = routingProblem(routing, styles)
  if (problem) throw new AppError(`${routing.code} does not suit this order. ${problem}`, 400, 'ROUTING_DOES_NOT_FIT')
  if (!routing.steps.length || routing.steps[0].operation.kind !== 'CUTTING') {
    throw new AppError(`${routing.code} does not start with cutting. Fix it in Masters → Routings first.`, 400, 'CUTTING_FIRST')
  }

  await tx.mOStep.deleteMany({ where: { moId } })
  await tx.mOStep.createMany({
    data: routing.steps.map((s, i) => ({
      moId,
      sequence: i + 1,
      operationId: s.operationId,
      name: s.operation.name,
      kind: s.operation.kind,
      departmentId: s.departmentId,
      execution: s.execution,
      workstationId: s.workstationId,
      isQcStep: s.isQcStep || s.operation.kind === 'QC',
      skip: s.operation.kind === 'CUTTING' ? 'NEVER' : s.skip,
      ratePerPiece: s.ratePerPiece ?? s.operation.jobWorkRate,
      instructions: s.instructions ?? s.operation.instructions,
    })),
  })
  await tx.manufacturingOrder.update({ where: { id: moId }, data: { routingId: routing.id, routingVersion: routing.version } })
  return routing
}

export const routeStepSchema = z.object({
  /** An existing step of the order's route, when it is kept. */
  id: z.string().optional().nullable(),
  operationId: z.string().min(1, 'Pick the process'),
  departmentId: z.string().min(1, 'Pick the department'),
  execution: z.enum(['IN_HOUSE', 'OUTSOURCED']).default('IN_HOUSE'),
  workstationId: z.string().optional().nullable(),
  isQcStep: z.boolean().default(false),
  skip: z.enum(['OPTIONAL', 'WITH_APPROVAL', 'NEVER']).default('WITH_APPROVAL'),
  ratePerPiece: z.number().min(0).max(100_000).optional().nullable(),
  instructions: z.string().trim().max(1000).optional().nullable(),
})

export const editRouteSchema = z.object({
  steps: z.array(routeStepSchema).min(1, 'A route needs at least its cutting step').max(60),
  reason: z.string().trim().min(5, 'Say why the route is changing, in a few words').max(500),
})

/**
 * Changes one order's own route. The steps up to the furthest one pieces have
 * reached stay where they are — only their instructions, rate and unit can
 * change. Everything after can be added, removed or reordered.
 */
export async function editRoute(tx: Prisma.TransactionClient, moId: string, input: z.infer<typeof editRouteSchema>) {
  await lockMo(tx, moId)
  const current = ordered(
    await tx.mOStep.findMany({
      where: { moId },
      select: { id: true, sequence: true, name: true, operationId: true, departmentId: true, kind: true, skippedAt: true, skippedById: true, skipReason: true },
    }),
  )
  if (!current.length) throw new AppError('This order has no route yet. Pick a routing for it first.', 409, 'NO_ROUTE')

  // A step anything has ever moved through, or that an outside unit has been
  // given work on, stays.
  const [moved, given] = await Promise.all([
    tx.wipEntry.groupBy({ by: ['stepId'], where: { moId } }),
    tx.jobWorkOrder.findMany({ where: { moId }, select: { stepId: true } }),
  ])
  const touched = new Set([...moved.map((r) => r.stepId), ...given.map((g) => g.stepId)])
  const lastTouched = current.reduce((at, s, i) => (touched.has(s.id) ? i : at), -1)
  const fixed = current.slice(0, lastTouched + 1)

  // The fixed steps lead the new route, unchanged in order.
  for (let i = 0; i < fixed.length; i++) {
    const s = input.steps[i]
    if (!s || s.id !== fixed[i].id) {
      throw new AppError(
        `Pieces have reached ${fixed[fixed.length - 1].name}, so the route up to it stays as it is: ${fixed.map((f) => f.name).join(' → ')}. Change what comes after.`,
        409,
        'ROUTE_FIXED',
      )
    }
    if (s.operationId !== fixed[i].operationId || s.departmentId !== fixed[i].departmentId) {
      throw new AppError(`${fixed[i].name} has pieces through it, so its process and department cannot change.`, 409, 'STEP_FIXED')
    }
  }

  const rest = input.steps.slice(fixed.length)
  const restIds = rest.map((s) => s.id).filter(Boolean) as string[]
  const known = new Map(current.map((s) => [s.id, s]))
  for (const id of restIds) {
    if (!known.has(id) || fixed.some((f) => f.id === id)) throw new AppError('One of those steps is not on this order, or appears twice.', 400, 'BAD_STEP')
  }
  if (new Set(restIds).size !== restIds.length) throw new AppError('The same step appears twice.', 400, 'BAD_STEP')

  const ops = await tx.operation.findMany({
    where: { id: { in: [...new Set(input.steps.map((s) => s.operationId))] } },
    select: { id: true, name: true, kind: true, departmentId: true, isActive: true },
  })
  const op = new Map(ops.map((o) => [o.id, o]))
  input.steps.forEach((s, i) => {
    const o = op.get(s.operationId)
    if (!o) throw new AppError(`Step ${i + 1}: that process no longer exists.`, 400, 'BAD_OPERATION')
    if (o.departmentId !== s.departmentId) throw new AppError(`Step ${i + 1}: ${o.name} belongs to another department.`, 400, 'STEP_DEPARTMENT_MISMATCH')
  })
  const kinds = input.steps.map((s) => op.get(s.operationId)!.kind)
  if (kinds[0] !== 'CUTTING') throw new AppError('The route starts with cutting: that is where the pieces are made.', 400, 'CUTTING_FIRST')
  if (kinds.filter((k) => k === 'CUTTING').length > 1) throw new AppError('Only one cutting step: the pieces are cut once.', 400, 'ONE_CUTTING')
  const units = [...new Set(input.steps.map((s) => s.workstationId).filter(Boolean))] as string[]
  if (units.length) {
    const found = await tx.workstation.count({ where: { id: { in: units } } })
    if (found !== units.length) throw new AppError('One of those units no longer exists.', 400, 'BAD_UNIT')
  }

  // Fixed steps: only what does not change how pieces already moved.
  for (let i = 0; i < fixed.length; i++) {
    const s = input.steps[i]
    await tx.mOStep.update({
      where: { id: fixed[i].id },
      data: { instructions: s.instructions ?? null, ratePerPiece: s.ratePerPiece ?? null, workstationId: s.workstationId ?? null },
    })
  }
  // Everything after: written afresh, keeping a kept step's "left out".
  const after = current.slice(fixed.length)
  await tx.mOStep.deleteMany({ where: { id: { in: after.map((s) => s.id) } } })
  const base = fixed.length ? fixed[fixed.length - 1].sequence : 0
  for (const [i, s] of rest.entries()) {
    const kept = s.id ? known.get(s.id) : undefined
    const o = op.get(s.operationId)!
    await tx.mOStep.create({
      data: {
        moId,
        sequence: base + i + 1,
        operationId: s.operationId,
        name: o.name,
        kind: o.kind,
        departmentId: s.departmentId,
        execution: s.execution,
        workstationId: s.workstationId ?? null,
        isQcStep: s.isQcStep || o.kind === 'QC',
        skip: o.kind === 'CUTTING' ? 'NEVER' : (s.skip as StepSkip),
        ratePerPiece: s.ratePerPiece ?? null,
        instructions: s.instructions ?? null,
        skippedAt: kept?.skippedAt ?? null,
        skippedById: kept?.skippedById ?? null,
        skipReason: kept?.skipReason ?? null,
      },
    })
  }
  return { fixed: fixed.map((f) => f.name), steps: input.steps.length }
}

/**
 * Leaves a step out of an order's route: no more pieces are sent to it.
 * Pieces already there finish as normal. An optional step needs a reason; a
 * required one a production manager as well; some can never be left out.
 */
export async function skipStep(tx: Prisma.TransactionClient, moId: string, stepId: string, reason: string, by: { userId: string; mayApprove: boolean }) {
  await lockMo(tx, moId)
  const step = await tx.mOStep.findFirst({ where: { id: stepId, moId } })
  if (!step) throw new AppError('That step is not on this order.', 404, 'NOT_FOUND')
  if (step.skippedAt) throw new AppError(`${step.name} is already left out.`, 409, 'ALREADY_SKIPPED')
  if (step.kind === 'CUTTING' || step.skip === 'NEVER') throw new AppError(`${step.name} cannot be left out of the route.`, 409, 'CANNOT_SKIP')
  if (step.skip === 'WITH_APPROVAL' && !by.mayApprove) {
    throw new AppError(`${step.name} is a required step: only a production manager can leave it out.`, 403, 'NEEDS_APPROVAL')
  }
  return tx.mOStep.update({ where: { id: step.id }, data: { skippedAt: new Date(), skippedById: by.userId, skipReason: reason } })
}

/** Puts a left-out step back: pieces sent on from now go through it again. */
export async function restoreStep(tx: Prisma.TransactionClient, moId: string, stepId: string, by: { mayApprove: boolean }) {
  await lockMo(tx, moId)
  const step = await tx.mOStep.findFirst({ where: { id: stepId, moId } })
  if (!step) throw new AppError('That step is not on this order.', 404, 'NOT_FOUND')
  if (!step.skippedAt) throw new AppError(`${step.name} is not left out.`, 409, 'NOT_SKIPPED')
  if (step.skip === 'WITH_APPROVAL' && !by.mayApprove) throw new AppError('Only a production manager can put a required step back.', 403, 'NEEDS_APPROVAL')
  return tx.mOStep.update({ where: { id: step.id }, data: { skippedAt: null, skippedById: null, skipReason: null } })
}
