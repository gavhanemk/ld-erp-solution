import type { Prisma, PrismaClient, StyleStepRun } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { stepFigures } from './floor.service'

/**
 * A style's progress through its routing, as the floor reports it by hand: a
 * Start and a Stop for each step, pressed on the style's page under Masters →
 * Routings. Separate from the piece ledger (wip.service), which counts pieces
 * and is never typed; the units completed shown beside each step are read from
 * that ledger here, never stored.
 *
 * Rules, settled with the business on 12 Oct:
 * - A step starts once the step before it has started — steps overlap on the
 *   floor, so stitching can start while cutting is still going.
 * - One start and one stop per step.
 * - A step can be left out before it starts, under the routing's own rule for
 *   that step (anyone / a production manager / never).
 * - Undo is for production:edit, with a reason, and only in order: the last
 *   thing done to a step, and never a start a later step depends on.
 */

type Db = PrismaClient | Prisma.TransactionClient
type Tx = Prisma.TransactionClient

/** What the routing editor and the step tracker both need of a routing. */
export const trackRoutingSelect = {
  id: true,
  code: true,
  name: true,
  styleId: true,
  category: true,
  version: true,
  isActive: true,
  isLocked: true,
  notes: true,
  updatedAt: true,
  style: { select: { id: true, code: true, name: true } },
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
  _count: { select: { mos: true } },
} satisfies Prisma.RoutingSelect

type TrackRouting = Prisma.RoutingGetPayload<{ select: typeof trackRoutingSelect }>
type TrackStep = TrackRouting['steps'][number]
export type Applies = 'STYLE' | 'CATEGORY' | 'ANY'

export type StepState = 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE' | 'SKIPPED'
export type StyleState = 'NO_ROUTING' | 'NOT_STARTED' | 'IN_PROGRESS' | 'WAITING' | 'DONE'

/** The key a step's run is kept under: its process, and which time the process comes on the route. */
export const runKey = (operationId: string, occurrence: number) => `${operationId}#${occurrence}`

/** Numbers each step by how many times its process has come up so far, so a repeated process keeps two records. */
export function withOccurrence<T extends { operationId: string }>(steps: T[]): Array<T & { occurrence: number }> {
  const seen = new Map<string, number>()
  return steps.map((s) => {
    const n = (seen.get(s.operationId) ?? 0) + 1
    seen.set(s.operationId, n)
    return { ...s, occurrence: n }
  })
}

type RunTimes = Pick<StyleStepRun, 'startedAt' | 'stoppedAt' | 'skippedAt'>

export const stateOf = (run?: RunTimes | null): StepState =>
  !run ? 'NOT_STARTED' : run.skippedAt ? 'SKIPPED' : run.stoppedAt ? 'DONE' : run.startedAt ? 'IN_PROGRESS' : 'NOT_STARTED'

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

/** The routing's steps, each with its record and what it may do next. */
function stepsWithRuns(routing: TrackRouting | null, runs: StyleStepRun[]) {
  if (!routing) return []
  const byKey = new Map(runs.map((r) => [runKey(r.operationId, r.occurrence), r]))
  const steps = withOccurrence(routing.steps).map((s) => {
    const run = byKey.get(runKey(s.operationId, s.occurrence)) ?? null
    return { step: s, run, state: stateOf(run) }
  })
  return steps.map((x, i) => {
    // The step before, counting only those not left out.
    const before = steps.slice(0, i).filter((p) => p.state !== 'SKIPPED').pop() ?? null
    const startBlockedBy = x.state === 'NOT_STARTED' && before && before.state === 'NOT_STARTED' ? before.step.operation.name : null
    return { ...x, before, startBlockedBy }
  })
}

type Tracked = ReturnType<typeof stepsWithRuns>

/** Where the style as a whole stands, and the step to show beside it. */
export function overallOf(steps: Tracked) {
  if (!steps.length) return { state: 'NO_ROUTING' as StyleState, step: null as string | null, since: null as Date | null, done: 0, total: 0 }
  const live = steps.filter((s) => s.state !== 'SKIPPED')
  const done = live.filter((s) => s.state === 'DONE').length
  const total = live.length
  const going = steps.filter((s) => s.state === 'IN_PROGRESS')
  if (going.length) {
    // The furthest step under way is where the style has got to.
    const at = going[going.length - 1]
    return { state: 'IN_PROGRESS' as StyleState, step: at.step.operation.name, since: at.run!.startedAt, done, total }
  }
  if (done === total) {
    const last = live.map((s) => s.run!.stoppedAt!).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    return { state: 'DONE' as StyleState, step: null, since: last, done, total }
  }
  const next = live.find((s) => s.state === 'NOT_STARTED')!
  if (done === 0) return { state: 'NOT_STARTED' as StyleState, step: next.step.operation.name, since: null, done, total }
  // Some steps finished, none under way: waiting for the next one to start.
  const lastStop = live.filter((s) => s.run?.stoppedAt).map((s) => s.run!.stoppedAt!).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
  return { state: 'WAITING' as StyleState, step: next.step.operation.name, since: lastStop, done, total }
}

// ─── The list ─────────────────────────────────────────────────

const STATE_FILTERS: Record<string, StyleState[]> = {
  IN_PROGRESS: ['IN_PROGRESS', 'WAITING'],
  NOT_STARTED: ['NOT_STARTED'],
  DONE: ['DONE'],
  NO_ROUTING: ['NO_ROUTING'],
}

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
  const [routings, runs] = await Promise.all([
    trackedRoutings(db, styles),
    db.styleStepRun.findMany({ where: { styleId: { in: styles.map((s) => s.id) } } }),
  ])

  const rows = styles.map((s) => {
    const t = routings.get(s.id) ?? null
    const own = runs.filter((r) => r.styleId === s.id)
    const overall = overallOf(stepsWithRuns(t?.routing ?? null, own))
    const lastTouched = own
      .flatMap((r) => [r.startedAt, r.stoppedAt, r.skippedAt])
      .filter((d): d is Date => !!d)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    return {
      style: s,
      routing: t
        ? { id: t.routing.id, code: t.routing.code, name: t.routing.name, version: t.routing.version, applies: t.applies, steps: t.routing.steps.length, alternatives: t.alternatives }
        : null,
      overall,
      lastTouched,
    }
  })

  const counts = Object.fromEntries(Object.entries(STATE_FILTERS).map(([k, states]) => [k, rows.filter((r) => states.includes(r.overall.state)).length]))
  const wanted = opts.state && STATE_FILTERS[opts.state] ? STATE_FILTERS[opts.state] : null
  const filtered = wanted ? rows.filter((r) => wanted.includes(r.overall.state)) : rows
  const start = (opts.page - 1) * opts.limit
  return { rows: filtered.slice(start, start + opts.limit), total: filtered.length, counts: { ALL: rows.length, ...counts } }
}

// ─── One style ────────────────────────────────────────────────

/**
 * Pieces completed at each process of the route, for this style, from the
 * floor's ledger: every order line of the style whose order has its stages,
 * summed process by process — so the figure is the one the stage sheets show.
 */
async function unitsByStep(db: Db, styleId: string) {
  const lines = await db.mOLine.findMany({
    where: { styleId },
    select: {
      id: true,
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
  const completed = new Map<string, number>()
  for (const line of lines) {
    if (!line.mo.steps.length) continue
    const figures = await stepFigures(db, line.mo.id, line.mo.steps, line.totalQty, line.id)
    const done = new Map(figures.map((f) => [f.stepId, f.completed]))
    for (const s of withOccurrence([...line.mo.steps].sort((a, b) => a.sequence - b.sequence))) {
      const key = runKey(s.operationId, s.occurrence)
      completed.set(key, (completed.get(key) ?? 0) + (done.get(s.id) ?? 0))
    }
  }
  return {
    completed,
    orders: lines.map((l) => ({
      moId: l.mo.id,
      moNumber: l.mo.moNumber,
      status: l.mo.status,
      color: l.color,
      planned: l.totalQty,
      staged: l.mo.steps.length > 0,
    })),
  }
}

const userName = { select: { id: true, name: true } } as const

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

  const [routings, runs, units] = await Promise.all([
    trackedRoutings(db, [style]),
    db.styleStepRun.findMany({
      where: { styleId },
      include: { startedBy: userName, stoppedBy: userName, skippedBy: userName },
    }),
    unitsByStep(db, styleId),
  ])
  const tracked = routings.get(style.id) ?? null
  const steps = stepsWithRuns(tracked?.routing ?? null, runs)
  const onRoute = new Set(steps.map((s) => runKey(s.step.operationId, s.step.occurrence)))
  const planned = units.orders.reduce((n, o) => n + o.planned, 0)

  return {
    style,
    routing: tracked?.routing ?? null,
    applies: tracked?.applies ?? null,
    alternatives: tracked?.alternatives ?? 0,
    overall: overallOf(steps),
    steps: steps.map(({ step, run, state, startBlockedBy }) => ({
      key: runKey(step.operationId, step.occurrence),
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
      startBlockedBy,
      run,
      completed: units.completed.get(runKey(step.operationId, step.occurrence)) ?? 0,
    })),
    // Records for processes the routing no longer has: kept, and shown as history.
    history: runs.filter((r) => !onRoute.has(runKey(r.operationId, r.occurrence))),
    production: { planned, orders: units.orders },
  }
}

// ─── Start, stop, leave out, undo ─────────────────────────────

/** Two people pressing on the same style at once are taken one after the other. */
async function lockStyle(tx: Tx, styleId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM ld_erp.styles WHERE id = ${styleId} FOR UPDATE`
  if (!rows.length) throw new AppError('Style not found', 404, 'NOT_FOUND')
}

/** The style, its routing, and the one step being acted on, read under the lock. */
async function loadStep(tx: Tx, styleId: string, operationId: string, occurrence: number) {
  await lockStyle(tx, styleId)
  const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { id: true, code: true, category: true } })
  const tracked = (await trackedRoutings(tx, [style])).get(styleId) ?? null
  if (!tracked) throw new AppError(`${style.code} has no routing yet. Make one first.`, 409, 'NO_ROUTING')
  const runs = await tx.styleStepRun.findMany({ where: { styleId } })
  const steps = stepsWithRuns(tracked.routing, runs)
  const index = steps.findIndex((s) => s.step.operationId === operationId && s.step.occurrence === occurrence)
  if (index < 0) {
    throw new AppError('That step is no longer on this style\'s routing — it may just have been changed. Refresh the page.', 404, 'STEP_NOT_ON_ROUTING')
  }
  return { style, routing: tracked.routing, steps, index, here: steps[index] }
}

/** What a record keeps of the step as it was when first touched. */
const snapshot = (routing: TrackRouting, step: TrackStep) => ({
  routingId: routing.id,
  routingVersion: routing.version,
  stepName: step.operation.name,
  sequence: step.sequence,
})

/** "2 days 3 hours", "45 minutes" — how long a step took, in words. */
export function took(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (days) return hours ? `${part(days, 'day')} ${part(hours, 'hour')}` : part(days, 'day')
  if (hours) return mins ? `${part(hours, 'hour')} ${part(mins, 'minute')}` : part(hours, 'hour')
  return part(mins, 'minute')
}

type Who = { userId: string; mayApprove: boolean }

export async function startStep(tx: Tx, styleId: string, operationId: string, occurrence: number, by: Who) {
  const { style, routing, here } = await loadStep(tx, styleId, operationId, occurrence)
  const name = here.step.operation.name
  if (here.state === 'SKIPPED') throw new AppError(`${name} is left out for ${style.code}. Put it back first.`, 409, 'STEP_SKIPPED')
  if (here.run?.startedAt) throw new AppError(`${name} has already been started.`, 409, 'ALREADY_STARTED')
  if (here.startBlockedBy) {
    throw new AppError(`Start ${here.startBlockedBy} first: a step starts once the one before it has started.`, 409, 'PREVIOUS_NOT_STARTED')
  }
  const now = new Date()
  const before = here.run
  const run = await tx.styleStepRun.upsert({
    where: { styleId_operationId_occurrence: { styleId, operationId, occurrence } },
    create: { styleId, operationId, occurrence, ...snapshot(routing, here.step), startedAt: now, startedById: by.userId },
    update: { ...snapshot(routing, here.step), startedAt: now, startedById: by.userId },
  })
  return { before, run, message: `${name} started for ${style.code}.` }
}

export async function stopStep(tx: Tx, styleId: string, operationId: string, occurrence: number, by: Who) {
  const { style, here } = await loadStep(tx, styleId, operationId, occurrence)
  const name = here.step.operation.name
  const before = here.run
  if (!before?.startedAt) throw new AppError(`${name} has not been started, so it cannot be stopped.`, 409, 'NOT_STARTED')
  if (before.stoppedAt) throw new AppError(`${name} has already been stopped.`, 409, 'ALREADY_STOPPED')
  const now = new Date()
  const run = await tx.styleStepRun.update({ where: { id: before.id }, data: { stoppedAt: now, stoppedById: by.userId } })
  return { before, run, message: `${name} stopped for ${style.code}, ${took(before.startedAt, now)} after it started.` }
}

export async function leaveOutStep(tx: Tx, styleId: string, operationId: string, occurrence: number, reason: string, by: Who) {
  const { style, routing, here } = await loadStep(tx, styleId, operationId, occurrence)
  const name = here.step.operation.name
  const rule = here.step.operation.kind === 'CUTTING' ? 'NEVER' : here.step.skip
  if (rule === 'NEVER') throw new AppError(`${name} cannot be left out: every piece goes through it.`, 409, 'CANNOT_SKIP')
  if (rule === 'WITH_APPROVAL' && !by.mayApprove) {
    throw new AppError(`${name} is a required step: only a production manager can leave it out.`, 403, 'NEEDS_APPROVAL')
  }
  if (here.state === 'SKIPPED') throw new AppError(`${name} is already left out.`, 409, 'ALREADY_SKIPPED')
  if (here.run?.startedAt) throw new AppError(`${name} has started, so it can no longer be left out.`, 409, 'ALREADY_STARTED')
  const before = here.run
  const now = new Date()
  const run = await tx.styleStepRun.upsert({
    where: { styleId_operationId_occurrence: { styleId, operationId, occurrence } },
    create: { styleId, operationId, occurrence, ...snapshot(routing, here.step), skippedAt: now, skippedById: by.userId, skipReason: reason },
    update: { ...snapshot(routing, here.step), skippedAt: now, skippedById: by.userId, skipReason: reason },
  })
  return { before, run, message: `${name} left out for ${style.code}.` }
}

/**
 * Takes back the last thing done to a step: putting a left-out step back, a
 * stop, or a start. A start that a later step has followed is refused — that
 * later step is undone first, so the rule "starts once the one before has" is
 * never left broken.
 */
export async function undoStep(tx: Tx, styleId: string, operationId: string, occurrence: number, by: Who) {
  const { style, steps, index, here } = await loadStep(tx, styleId, operationId, occurrence)
  const name = here.step.operation.name
  const run = here.run
  if (!run || (!run.startedAt && !run.skippedAt)) throw new AppError(`Nothing has been recorded on ${name} to undo.`, 409, 'NOTHING_TO_UNDO')

  let data: Prisma.StyleStepRunUpdateInput
  let what: string
  if (run.skippedAt) {
    const rule = here.step.operation.kind === 'CUTTING' ? 'NEVER' : here.step.skip
    if (rule === 'WITH_APPROVAL' && !by.mayApprove) {
      throw new AppError(`${name} is a required step: only a production manager can put it back.`, 403, 'NEEDS_APPROVAL')
    }
    data = { skippedAt: null, skippedBy: { disconnect: true }, skipReason: null }
    what = `${name} is back on ${style.code}'s route.`
  } else if (run.stoppedAt) {
    data = { stoppedAt: null, stoppedBy: { disconnect: true } }
    what = `${name}'s stop is undone: it is in progress again.`
  } else {
    const later = steps.slice(index + 1).find((s) => s.run?.startedAt)
    if (later) throw new AppError(`Undo ${later.step.operation.name} first: it started after ${name}.`, 409, 'LATER_STEP_STARTED')
    data = { startedAt: null, startedBy: { disconnect: true } }
    what = `${name}'s start is undone: it has not started.`
  }

  const after = await tx.styleStepRun.update({ where: { id: run.id }, data })
  // A record with nothing left on it — no start, no leaving out, no note — goes.
  if (!after.startedAt && !after.skippedAt && !after.note) {
    await tx.styleStepRun.delete({ where: { id: run.id } })
    return { before: run, run: null, message: what }
  }
  return { before: run, run: after, message: what }
}

export async function noteStep(tx: Tx, styleId: string, operationId: string, occurrence: number, note: string | null) {
  const { routing, here } = await loadStep(tx, styleId, operationId, occurrence)
  const before = here.run
  if (!before && !note) return { before, run: null, message: 'Nothing to save.' }
  if (before && !note && !before.startedAt && !before.skippedAt) {
    await tx.styleStepRun.delete({ where: { id: before.id } })
    return { before, run: null, message: 'Note removed.' }
  }
  const run = await tx.styleStepRun.upsert({
    where: { styleId_operationId_occurrence: { styleId, operationId, occurrence } },
    create: { styleId, operationId, occurrence, ...snapshot(routing, here.step), note },
    update: { note },
  })
  return { before, run, message: note ? 'Note saved.' : 'Note removed.' }
}
