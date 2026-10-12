// The style tracker under Masters → Routings, end to end, on the live shared
// database inside one transaction that always throws (nothing is kept):
// starting in order (a step starts once the one before it has started),
// overlapping steps, stopping, undo in order, leaving a step out under the
// routing's own rule, notes, the list's states, and units completed read from
// the floor's ledger.
//
// Needs a style with a routing of its own whose first step is cutting and
// which has a step that only a manager may leave out — the demo style
// LD-SH-2601 with RT-SH-PLAIN. Run it from apps/api, so the database settings
// load:
//
//   cd apps/api
//   npx tsx ../../tools/check-style-tracking.ts
import { prisma } from '../packages/database/src/index'
import { leaveOutStep, listStyles, noteStep, startStep, stopStep, styleDetail, undoStep } from '../apps/api/src/services/styleTrack.service'
import { stepFigures } from '../apps/api/src/services/floor.service'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}
const ROLLBACK = new Error('ROLLBACK')

/** Runs `fn` and says whether it was refused with this code. */
async function refused(fn: () => Promise<unknown>, code: string) {
  try {
    await fn()
    return 'not refused'
  } catch (e) {
    const got = (e as { code?: string }).code
    return got === code ? true : `refused with ${got ?? (e as Error).message}`
  }
}

async function main() {
  const style = await prisma.style.findUnique({ where: { code: 'LD-SH-2601' }, select: { id: true, code: true } })
  const user = await prisma.user.findFirst({ where: { status: 'ACTIVE' }, select: { id: true } })
  if (!style || !user) throw new Error('Needs the demo style LD-SH-2601 and an active user')
  const runsBefore = await prisma.styleStepRun.count()

  try {
    await prisma.$transaction(
      async (tx) => {
        const clerk = { userId: user.id, mayApprove: false }
        const manager = { userId: user.id, mayApprove: true }
        // Clear this style's records inside the transaction, so the run starts clean.
        await tx.styleStepRun.deleteMany({ where: { styleId: style.id } })

        let d = await styleDetail(tx, style.id)
        check('the style has a routing of its own', d.applies === 'STYLE' && !!d.routing, d.routing?.code)
        check('it starts not started', d.overall.state === 'NOT_STARTED', d.overall.state)
        const [first, second, third] = d.steps
        check('the first step is cutting, which cannot be left out', first.kind === 'CUTTING' && first.skip === 'NEVER')
        check('the second step waits for the first', second.startBlockedBy === first.name, String(second.startBlockedBy))

        const at = (s: { operationId: string; occurrence: number }) => [s.operationId, s.occurrence] as const

        check('starting the second step before the first is refused', (await refused(() => startStep(tx, style.id, ...at(second), clerk), 'PREVIOUS_NOT_STARTED')) === true)

        await startStep(tx, style.id, ...at(first), clerk)
        d = await styleDetail(tx, style.id)
        check('after Start, the style is in progress at cutting', d.overall.state === 'IN_PROGRESS' && d.overall.step === first.name, `${d.overall.state} ${d.overall.step}`)
        check('starting cutting again is refused', (await refused(() => startStep(tx, style.id, ...at(first), clerk), 'ALREADY_STARTED')) === true)

        await startStep(tx, style.id, ...at(second), clerk)
        d = await styleDetail(tx, style.id)
        check('the second step starts while cutting is still going (overlap)', d.steps[0].state === 'IN_PROGRESS' && d.steps[1].state === 'IN_PROGRESS')
        check('the style shows the furthest step under way', d.overall.step === second.name, String(d.overall.step))

        check('stopping a step not started is refused', (await refused(() => stopStep(tx, style.id, ...at(third), clerk), 'NOT_STARTED')) === true)
        const stopped = await stopStep(tx, style.id, ...at(first), clerk)
        check('stopping cutting says how long it took', /after it started/.test(stopped.message), stopped.message)
        check('stopping it twice is refused', (await refused(() => stopStep(tx, style.id, ...at(first), clerk), 'ALREADY_STOPPED')) === true)

        await undoStep(tx, style.id, ...at(first), manager)
        d = await styleDetail(tx, style.id)
        check('undo takes back the stop first', d.steps[0].state === 'IN_PROGRESS', d.steps[0].state)
        check('undoing cutting\'s start is refused while a later step has started', (await refused(() => undoStep(tx, style.id, ...at(first), manager), 'LATER_STEP_STARTED')) === true)

        // Leaving out: cutting never; a manager-only step needs a manager.
        check('cutting cannot be left out', (await refused(() => leaveOutStep(tx, style.id, ...at(first), 'testing the rule', manager), 'CANNOT_SKIP')) === true)
        const managerOnly = d.steps.find((s, i) => i >= 2 && s.skip === 'WITH_APPROVAL' && s.state === 'NOT_STARTED')
        if (managerOnly) {
          check('a manager-only step is refused to a clerk', (await refused(() => leaveOutStep(tx, style.id, ...at(managerOnly), 'testing the rule', clerk), 'NEEDS_APPROVAL')) === true)
          await leaveOutStep(tx, style.id, ...at(managerOnly), 'testing the rule', manager)
          d = await styleDetail(tx, style.id)
          const i = d.steps.findIndex((s) => s.key === managerOnly.key)
          check('a manager can leave it out', d.steps[i].state === 'SKIPPED')
          const after = d.steps[i + 1]
          if (after) {
            const expected = d.steps.slice(0, i).filter((s) => s.state !== 'SKIPPED').pop()
            check('the step after it now waits on the one before the left-out step', after.startBlockedBy === (expected?.state === 'NOT_STARTED' ? expected.name : null), String(after.startBlockedBy))
          }
          check('starting a left-out step is refused', (await refused(() => startStep(tx, style.id, ...at(managerOnly), manager), 'STEP_SKIPPED')) === true)
          await undoStep(tx, style.id, ...at(managerOnly), manager)
          d = await styleDetail(tx, style.id)
          check('undo puts it back, and the empty record goes', d.steps[i].state === 'NOT_STARTED' && !d.steps[i].run)
        } else {
          check('the routing has a manager-only step to test with', false)
        }

        await noteStep(tx, style.id, ...at(third), 'Waiting for the trims to arrive')
        d = await styleDetail(tx, style.id)
        check('a note can go on a step not yet started', d.steps[2].run?.note === 'Waiting for the trims to arrive' && d.steps[2].state === 'NOT_STARTED')
        await noteStep(tx, style.id, ...at(third), null)
        d = await styleDetail(tx, style.id)
        check('clearing it removes the empty record', !d.steps[2].run)

        // The list reads the same states.
        const list = await listStyles(tx, { q: style.code, state: 'IN_PROGRESS', page: 1, limit: 10 })
        check('the list finds it under in progress', list.rows.some((r) => r.style.id === style.id && r.overall.state === 'IN_PROGRESS'))
        const all = await listStyles(tx, { page: 1, limit: 200 })
        const counted = all.counts.IN_PROGRESS + all.counts.NOT_STARTED + all.counts.DONE + all.counts.NO_ROUTING
        check('every style falls in exactly one state', counted === all.counts.ALL, `${counted} of ${all.counts.ALL}`)

        // Units completed: the floor's own figures, summed over the style's lines.
        const lines = await tx.mOLine.findMany({
          where: { styleId: style.id, mo: { steps: { some: {} } } },
          select: { id: true, totalQty: true, mo: { select: { id: true, steps: { select: { id: true, sequence: true, operationId: true, kind: true, isQcStep: true, skippedAt: true, name: true, execution: true } } } } },
        })
        let cutDirect = 0
        for (const l of lines) {
          const figs = await stepFigures(tx, l.mo.id, l.mo.steps, l.totalQty, l.id)
          const cutStep = l.mo.steps.find((s) => s.kind === 'CUTTING')
          cutDirect += figs.find((f) => f.stepId === cutStep?.id)?.completed ?? 0
        }
        check('units completed at cutting match the floor\'s own figures', d.steps[0].completed === cutDirect, `${d.steps[0].completed} vs ${cutDirect} over ${lines.length} line(s)`)
        console.log(`     units completed by step: ${d.steps.map((s) => `${s.name} ${s.completed}`).join(', ')}`)

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
