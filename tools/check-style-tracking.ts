// The style page under Masters → Routings, on the live shared database inside
// one transaction that always throws (nothing is kept): each step's state and
// units completed read from the floor's ledger across the style's orders — no
// Start or Stop since 15 Oct 2026 — a closed order left out, a style with no
// orders, notes on a step, and the list's states.
//
// Needs the demo style LD-SH-2601 with its routing RT-SH-PLAIN and its orders
// (one completed, one not yet cut). Run it from apps/api, so the database
// settings load:
//
//   cd apps/api
//   npx tsx ../../tools/check-style-tracking.ts
import { prisma } from '../packages/database/src/index'
import * as track from '../apps/api/src/services/styleTrack.service'
import { stepFigures } from '../apps/api/src/services/floor.service'

const { listStyles, noteStep, styleDetail, runKey, withOccurrence } = track

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')

const stepSelect = { id: true, sequence: true, operationId: true, kind: true, isQcStep: true, skippedAt: true, name: true, execution: true } as const

async function main() {
  const style = await prisma.style.findUnique({ where: { code: 'LD-SH-2601' }, select: { id: true, code: true } })
  if (!style) throw new Error('Needs the demo style LD-SH-2601')
  const runsBefore = await prisma.styleStepRun.count()
  check('the timer is gone: no Start, Stop, leave-out or undo', !('startStep' in track) && !('stopStep' in track) && !('leaveOutStep' in track) && !('undoStep' in track))

  try {
    await prisma.$transaction(
      async (tx) => {
        let d = await styleDetail(tx, style.id)
        check('the style has a routing of its own', d.applies === 'STYLE' && !!d.routing, d.routing?.name)
        check('the routing comes with its fabric and who changed it', d.routing !== null && 'fabric' in d.routing && 'updatedBy' in d.routing)

        // Each step worked out again here, straight from the floor: done on
        // every counted order, not started on any, in progress otherwise.
        const lines = await tx.mOLine.findMany({
          where: { styleId: style.id, mo: { status: { not: 'CLOSED' } } },
          select: { id: true, totalQty: true, mo: { select: { id: true, status: true, steps: { select: stepSelect } } } },
        })
        const perLine = await Promise.all(
          lines.map(async (l) => {
            if (!l.mo.steps.length) return null
            const figs = new Map((await stepFigures(tx, l.mo.id, l.mo.steps, l.totalQty, l.id)).map((f) => [f.stepId, f]))
            return new Map(withOccurrence([...l.mo.steps].sort((a, b) => a.sequence - b.sequence)).map((s) => [runKey(s.operationId, s.occurrence), { state: l.mo.status === 'COMPLETED' ? 'DONE' : figs.get(s.id)!.state, completed: figs.get(s.id)!.completed }]))
          }),
        )
        const expected = d.steps.map((s) => {
          const states = perLine.map((m) => (m ? m.get(s.key)?.state : 'NOT_STARTED')).filter(Boolean) as string[]
          const completed = perLine.reduce((n, m) => n + (m?.get(s.key)?.completed ?? 0), 0)
          const live = states.filter((x) => x !== 'SKIPPED')
          const state = !states.length ? 'NOT_STARTED' : !live.length ? 'SKIPPED' : live.every((x) => x === 'DONE') ? 'DONE' : live.every((x) => x === 'NOT_STARTED') ? 'NOT_STARTED' : 'IN_PROGRESS'
          return { state, completed }
        })
        check('every step\'s state is the floor\'s, across the style\'s orders', d.steps.every((s, i) => s.state === expected[i].state), d.steps.map((s) => `${s.name} ${s.state}`).join(', '))
        check('every step\'s units completed is the floor\'s own figure', d.steps.every((s, i) => s.completed === expected[i].completed), d.steps.map((s) => `${s.name} ${s.completed}`).join(', '))
        check('planned is the counted orders\' pieces', d.production.planned === lines.reduce((n, l) => n + l.totalQty, 0), String(d.production.planned))
        const firstOpen = d.steps.find((s) => s.state !== 'DONE' && s.state !== 'SKIPPED')
        check(
          'the style stands at its first step not yet done',
          d.overall.state === 'IN_PROGRESS' ? d.overall.step === firstOpen?.name : d.overall.state === 'DONE' ? !firstOpen : true,
          `${d.overall.state} ${d.overall.step ?? ''}`,
        )

        // Close every order that is not finished: only the completed one
        // counts, and the style is done.
        const open = await tx.manufacturingOrder.findMany({ where: { lines: { some: { styleId: style.id } }, status: { notIn: ['COMPLETED', 'CLOSED'] } }, select: { id: true } })
        const finished = await tx.manufacturingOrder.count({ where: { lines: { some: { styleId: style.id } }, status: 'COMPLETED' } })
        if (open.length && finished) {
          await tx.manufacturingOrder.updateMany({ where: { id: { in: open.map((o) => o.id) } }, data: { status: 'CLOSED' } })
          d = await styleDetail(tx, style.id)
          check('with the unfinished orders closed, every step is done', d.steps.every((s) => s.state === 'DONE' || s.state === 'SKIPPED') && d.overall.state === 'DONE', d.overall.state)
          check('a closed order is still listed, but not counted', d.production.orders.some((o) => o.status === 'CLOSED') && d.production.planned < d.production.orders.reduce((n, o) => n + o.planned, 0))
        } else {
          check('the style has a completed order and an open one to test closing with', false)
        }

        // A style with a routing and no orders has not started.
        const idle = (await tx.style.findMany({ where: { isActive: true, routings: { some: { isActive: true } }, moLines: { none: {} } }, select: { id: true }, take: 1 }))[0]
        if (idle) {
          const i = await styleDetail(tx, idle.id)
          check('a style with no orders has not started, and plans nothing', i.overall.state === 'NOT_STARTED' && i.overall.planned === 0 && i.steps.every((s) => s.state === 'NOT_STARTED'))
        }

        // Notes stay.
        const [, , third] = d.steps
        await tx.styleStepRun.deleteMany({ where: { styleId: style.id, operationId: third.operationId, occurrence: third.occurrence } })
        await noteStep(tx, style.id, third.operationId, third.occurrence, 'Waiting for the trims to arrive')
        d = await styleDetail(tx, style.id)
        check('a note goes on a step', d.steps[2].note === 'Waiting for the trims to arrive' && !!d.steps[2].noteAt)
        await noteStep(tx, style.id, third.operationId, third.occurrence, null)
        d = await styleDetail(tx, style.id)
        check('clearing it removes the record', !d.steps[2].note && (await tx.styleStepRun.count({ where: { styleId: style.id, operationId: third.operationId, occurrence: third.occurrence } })) === 0)

        // The list reads the same states.
        const list = await listStyles(tx, { q: style.code, page: 1, limit: 10 })
        const row = list.rows.find((r) => r.style.id === style.id)
        check('the list shows the same state', row?.overall.state === d.overall.state, row?.overall.state)
        check('and the routing by name, with its fabric', row?.routing?.name === d.routing?.name && row?.routing?.fabric === (d.routing?.fabric?.name ?? null))
        const all = await listStyles(tx, { page: 1, limit: 200 })
        const counted = all.counts.IN_PROGRESS + all.counts.NOT_STARTED + all.counts.DONE + all.counts.NO_ROUTING
        check('every style falls in exactly one state', counted === all.counts.ALL, `${counted} of ${all.counts.ALL}`)
        const filtered = await listStyles(tx, { state: 'DONE', page: 1, limit: 200 })
        check('the filter keeps only that state', filtered.rows.every((r) => r.overall.state === 'DONE') && filtered.total === all.counts.DONE, `${filtered.total} done`)

        throw ROLLBACK
      },
      { timeout: 120_000, maxWait: 20_000 },
    )
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  check('nothing kept', (await prisma.styleStepRun.count()) === runsBefore)
  console.log(`\n${pass} passed, ${fail} failed`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
