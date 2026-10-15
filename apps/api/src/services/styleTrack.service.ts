import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { stepFigures } from './floor.service'

/**
 * A style's progress through its routing, for Masters → Routings: every step
 * of the routing it follows, with where the work stands there and the pieces
 * completed — both read from the floor's own ledger (wip.service), across
 * every order line of the style, and never typed here.
 *
 * Until 15 Oct 2026 the style's page also had a Start and a Stop for each
 * step, pressed by hand, with steps left out and undone. The business took
 * that off: the floor's records already say where a style stands. A note on a
 * step is still kept (StyleStepRun.note); the times already pressed stay on
 * their rows and are not shown.
 */

type Db = PrismaClient | Prisma.TransactionClient
type Tx = Prisma.TransactionClient

const person = { select: { id: true, name: true } } as const

/** What the routing editor and the style's page both need of a routing. */
export const trackRoutingSelect = {
  id: true,
  code: true,
  name: true,
  styleId: true,
  category: true,
  fabricItemId: true,
  version: true,
  isActive: true,
  isLocked: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  style: { select: { id: true, code: true, name: true } },
  fabric: { select: { id: true, code: true, name: true, uom: { select: { symbol: true } } } },
  createdBy: person,
  updatedBy: person,
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
      smv: true,
      instructions: true,
      operation: { select: { id: true, name: true, code: true, kind: true } },
      department: { select: { id: true, name: true } },
      workstation: { select: { id: true, name: true, type: true } },
    },
  },
  _count: { select: { mos: true, boms: true } },
} satisfies Prisma.RoutingSelect

type TrackRouting = Prisma.RoutingGetPayload<{ select: typeof trackRoutingSelect }>
export type Applies = 'STYLE' | 'CATEGORY' | 'ANY'

/** A step across all the style's orders: the floor's own word for each order, put together. */
export type StepState = 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE' | 'SKIPPED'
export type StyleState = 'NO_ROUTING' | 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE'

/** The key a step is matched under: its process, and which time the process comes on the route. */
export const runKey = (operationId: string, occurrence: number) => `${operationId}#${occurrence}`

/** Numbers each step by how many times its process has come up so far, so a repeated process is told apart. */
export function withOccurrence<T extends { operationId: string }>(steps: T[]): Array<T & { occurrence: number }> {
  const seen = new Map<string, number>()
  return steps.map((s) => {
    const n = (seen.get(s.operationId) ?? 0) + 1
    seen.set(s.operationId, n)
    return { ...s, occurrence: n }
  })
}

/**
 * Which routing a style follows: its own, then its category's, then one for
 * any style — the same order an order's stages are offered in. Several of the
 * same kind: the one changed most recently, with how many others there are so
 * the page can say so.
 */
export async function trackedRoutings(db: Db, styles: Array<{ id: string; category: string | null }>) {
  const ids = styles.map((s) => s.id)
  const routings = await db.routing.findMany({
    where: { isActive: true, OR: [{ styleId: { in: ids } }, { styleId: null }] },
    select: trackRoutingSelect,
    orderBy: { updatedAt: 'desc' },
  })
  const out = new Map<string, { routing: TrackRouting; applies: Applies; alternatives: number } | null>()
  for (const s of styles) {
    const own = routings.filter((r) => r.styleId === s.id)
    const cat = s.category?.trim()
      ? routings.filter((r) => !r.styleId && r.category?.trim().toLowerCase() === s.category!.trim().toLowerCase())
      : []
    const any = routings.filter((r) => !r.styleId && !r.category?.trim())
    const [pool, applies]: [TrackRouting[], Applies] = own.length ? [own, 'STYLE'] : cat.length ? [cat, 'CATEGORY'] : [any, 'ANY']
    out.set(s.id, pool.length ? { routing: pool[0], applies, alternatives: pool.length - 1 } : null)
  }
  return out
}

// ─── The floor's figures ──────────────────────────────────────

interface LineFloor {
  /** The order has its stages; one without has nothing on the floor yet. */
  staged: boolean
  /** The order is completed — short on purpose, too — so every step of it is done. */
  finished: boolean
  steps: Map<string, { state: StepState; completed: number }>
}

interface StyleFloor {
  planned: number
  lines: LineFloor[]
  orders: Array<{ moId: string; moNumber: string; status: string; color: string; planned: number; staged: boolean }>
}

/**
 * Each style's order lines, with every step's state and pieces completed as
 * the floor's stage sheets show them. A closed order is listed but left out
 * of the figures, as it is everywhere else that counts what is planned.
 */
async function floorOf(db: Db, styleIds: string[]) {
  const out = new Map<string, StyleFloor>()
  if (!styleIds.length) return out
  const lines = await db.mOLine.findMany({
    where: { styleId: { in: styleIds } },
    select: {
      id: true,
      styleId: true,
      color: true,
      totalQty: true,
      mo: {
        select: {
          id: true,
          moNumber: true,
          status: true,
          steps: { select: { id: true, sequence: true, operationId: true, kind: true, isQcStep: true, skippedAt: true, name: true, execution: true } },
        },
      },
    },
    orderBy: { mo: { createdAt: 'desc' } },
  })
  for (const line of lines) {
    const f = out.get(line.styleId) ?? { planned: 0, lines: [], orders: [] }
    out.set(line.styleId, f)
    const staged = line.mo.steps.length > 0
    f.orders.push({ moId: line.mo.id, moNumber: line.mo.moNumber, status: line.mo.status, color: line.color, planned: line.totalQty, staged })
    if (line.mo.status === 'CLOSED') continue
    f.planned += line.totalQty
    const steps = new Map<string, { state: StepState; completed: number }>()
    if (staged) {
      const figures = new Map((await stepFigures(db, line.mo.id, line.mo.steps, line.totalQty, line.id)).map((x) => [x.stepId, x]))
      for (const s of withOccurrence([...line.mo.steps].sort((a, b) => a.sequence - b.sequence))) {
        const x = figures.get(s.id)
        steps.set(runKey(s.operationId, s.occurrence), { state: (x?.state ?? 'NOT_STARTED') as StepState, completed: x?.completed ?? 0 })
      }
    }
    f.lines.push({ staged, finished: line.mo.status === 'COMPLETED', steps })
  }
  return out
}

/**
 * One step of the routing across the style's orders: done when every order
 * is done there, not started when none has begun, in progress otherwise. An
 * order whose route has no such step does not count; one not yet staged has
 * not started it.
 */
function stepAcross(key: string, floor: StyleFloor | undefined): { state: StepState; completed: number } {
  const states: StepState[] = []
  let completed = 0
  for (const l of floor?.lines ?? []) {
    if (!l.staged) {
      states.push('NOT_STARTED')
      continue
    }
    const here = l.steps.get(key)
    if (!here) continue
    completed += here.completed
    states.push(l.finished && here.state !== 'SKIPPED' ? 'DONE' : here.state)
  }
  const live = states.filter((s) => s !== 'SKIPPED')
  const state: StepState = !states.length
    ? 'NOT_STARTED'
    : !live.length
      ? 'SKIPPED'
      : live.every((s) => s === 'DONE')
        ? 'DONE'
        : live.every((s) => s === 'NOT_STARTED')
          ? 'NOT_STARTED'
          : 'IN_PROGRESS'
  return { state, completed }
}

/** The routing's steps, each with where it stands on the floor. */
function stepsOnFloor(routing: TrackRouting | null, floor: StyleFloor | undefined) {
  if (!routing) return []
  return withOccurrence(routing.steps).map((step) => ({ step, ...stepAcross(runKey(step.operationId, step.occurrence), floor) }))
}

/** Where the style as a whole stands, and the step to show beside it: the first one not yet done. */
export function overallOf(steps: Array<{ step: { operation: { name: string } }; state: StepState }>, planned: number) {
  if (!steps.length) return { state: 'NO_ROUTING' as StyleState, step: null as string | null, done: 0, total: 0, planned }
  const live = steps.filter((s) => s.state !== 'SKIPPED')
  const done = live.filter((s) => s.state === 'DONE').length
  const total = live.length
  if (total && done === total) return { state: 'DONE' as StyleState, step: null, done, total, planned }
  if (live.every((s) => s.state === 'NOT_STARTED')) return { state: 'NOT_STARTED' as StyleState, step: live[0]?.step.operation.name ?? null, done, total, planned }
  const at = live.find((s) => s.state !== 'DONE')!
  return { state: 'IN_PROGRESS' as StyleState, step: at.step.operation.name, done, total, planned }
}

// ─── The list ─────────────────────────────────────────────────

const STATES: StyleState[] = ['IN_PROGRESS', 'NOT_STARTED', 'DONE', 'NO_ROUTING']

/**
 * Every style with its routing and where it stands. Worked out in memory:
 * there are tens of styles, not thousands, and the state has to be known to
 * filter on it. Counts per state are for the filter's labels.
 */
export async function listStyles(db: Db, opts: { q?: string; state?: string; page: number; limit: number; includeInactive?: boolean }) {
  const q = opts.q?.trim()
  const styles = await db.style.findMany({
    where: {
      ...(opts.includeInactive ? {} : { isActive: true }),
      ...(q
        ? {
            OR: [
              { code: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
              { category: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    select: { id: true, code: true, name: true, category: true, colors: true, isActive: true },
    orderBy: { code: 'asc' },
  })
  const [routings, floor] = await Promise.all([trackedRoutings(db, styles), floorOf(db, styles.map((s) => s.id))])

  const rows = styles.map((s) => {
    const t = routings.get(s.id) ?? null
    const f = floor.get(s.id)
    return {
      style: s,
      routing: t
        ? {
            id: t.routing.id,
            code: t.routing.code,
            name: t.routing.name,
            version: t.routing.version,
            applies: t.applies,
            steps: t.routing.steps.length,
            alternatives: t.alternatives,
            fabric: t.routing.fabric?.name ?? null,
          }
        : null,
      overall: overallOf(stepsOnFloor(t?.routing ?? null, f), f?.planned ?? 0),
    }
  })

  const counts = Object.fromEntries(STATES.map((k) => [k, rows.filter((r) => r.overall.state === k).length]))
  const wanted = STATES.find((k) => k === opts.state)
  const filtered = wanted ? rows.filter((r) => r.overall.state === wanted) : rows
  const start = (opts.page - 1) * opts.limit
  return { rows: filtered.slice(start, start + opts.limit), total: filtered.length, counts: { ALL: rows.length, ...counts } }
}

// ─── One style ────────────────────────────────────────────────

export async function styleDetail(db: Db, styleId: string) {
  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      id: true,
      code: true,
      name: true,
      category: true,
      season: true,
      colors: true,
      isActive: true,
      imageUrl: true,
      sizeGroup: { select: { name: true } },
    },
  })
  if (!style) throw new AppError('Style not found', 404, 'NOT_FOUND')

  const [routings, notes, floor] = await Promise.all([
    trackedRoutings(db, [style]),
    db.styleStepRun.findMany({ where: { styleId, note: { not: null } }, select: { operationId: true, occurrence: true, note: true, updatedAt: true } }),
    floorOf(db, [styleId]),
  ])
  const tracked = routings.get(style.id) ?? null
  const f = floor.get(styleId)
  const steps = stepsOnFloor(tracked?.routing ?? null, f)
  const noteOf = new Map(notes.map((n) => [runKey(n.operationId, n.occurrence), n]))

  return {
    style,
    routing: tracked?.routing ?? null,
    applies: tracked?.applies ?? null,
    alternatives: tracked?.alternatives ?? 0,
    overall: overallOf(steps, f?.planned ?? 0),
    steps: steps.map(({ step, state, completed }) => {
      const key = runKey(step.operationId, step.occurrence)
      return {
        key,
        operationId: step.operationId,
        occurrence: step.occurrence,
        sequence: step.sequence,
        name: step.operation.name,
        kind: step.operation.kind,
        isQcStep: step.isQcStep || step.operation.kind === 'QC',
        execution: step.execution,
        skip: step.operation.kind === 'CUTTING' ? 'NEVER' : step.skip,
        department: step.department,
        workstation: step.workstation,
        ratePerPiece: step.ratePerPiece,
        instructions: step.instructions,
        state,
        completed,
        note: noteOf.get(key)?.note ?? null,
        noteAt: noteOf.get(key)?.updatedAt ?? null,
      }
    }),
    production: { planned: f?.planned ?? 0, orders: f?.orders ?? [] },
  }
}

// ─── Notes ────────────────────────────────────────────────────

/** Two people writing on the same style at once are taken one after the other. */
async function lockStyle(tx: Tx, styleId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM ld_erp.styles WHERE id = ${styleId} FOR UPDATE`
  if (!rows.length) throw new AppError('Style not found', 404, 'NOT_FOUND')
}

/** Writes, changes or clears the note on one step of the style's routing. */
export async function noteStep(tx: Tx, styleId: string, operationId: string, occurrence: number, note: string | null) {
  await lockStyle(tx, styleId)
  const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { id: true, code: true, category: true } })
  const tracked = (await trackedRoutings(tx, [style])).get(styleId) ?? null
  if (!tracked) throw new AppError(`${style.code} has no routing yet. Make one first.`, 409, 'NO_ROUTING')
  const step = withOccurrence(tracked.routing.steps).find((s) => s.operationId === operationId && s.occurrence === occurrence)
  if (!step) {
    throw new AppError('That step is no longer on this style\'s routing — it may just have been changed. Refresh the page.', 404, 'STEP_NOT_ON_ROUTING')
  }

  const before = await tx.styleStepRun.findUnique({ where: { styleId_operationId_occurrence: { styleId, operationId, occurrence } } })
  if (!before && !note) return { before, run: null, message: 'Nothing to save.' }
  // A row that holds nothing but the note goes with it; one that still has
  // times pressed before the timer was taken off keeps them.
  if (before && !note && !before.startedAt && !before.skippedAt) {
    await tx.styleStepRun.delete({ where: { id: before.id } })
    return { before, run: null, message: 'Note removed.' }
  }
  const snapshot = { routingId: tracked.routing.id, routingVersion: tracked.routing.version, stepName: step.operation.name, sequence: step.sequence }
  const run = await tx.styleStepRun.upsert({
    where: { styleId_operationId_occurrence: { styleId, operationId, occurrence } },
    create: { styleId, operationId, occurrence, ...snapshot, note },
    update: { note },
  })
  return { before, run, message: note ? 'Note saved.' : 'Note removed.' }
}
