// Deleted routings and bringing one back (routingRestore.service), on a local database inside one
// transaction that always rolls back. A style is given a second, newer routing; the older one is
// deleted the way the screen deletes it (deleteRouting, then the DELETE row in the audit log);
// it is listed as deleted, brought back, and checked against what it was. From apps/api:
//   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" npx tsx ../../tools/check-routing-restore.ts
import { prisma } from '../packages/database/src/index'
import { deleteRouting } from '../apps/api/src/services/routing.service'
import { deletedRoutings, restoreRouting } from '../apps/api/src/services/routingRestore.service'
import { trackedRoutings } from '../apps/api/src/services/styleTrack.service'

const ROLLBACK = new Error('ROLLBACK')
let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra: unknown = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' — ' + JSON.stringify(extra)}`)
}

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? 'x:').hostname
  if (!['localhost', '127.0.0.1'].includes(host)) throw new Error('local databases only')
  await prisma
    .$transaction(
      async (tx) => {
        const user = await tx.user.findFirstOrThrow({ select: { id: true } })
        const old = await tx.routing.findFirst({
          where: { isActive: true, isLocked: false, styleId: { not: null }, mos: { none: {} }, boms: { none: {} } },
          include: { steps: { orderBy: { sequence: 'asc' } }, style: { select: { id: true, code: true, category: true } } },
        })
        if (!old?.style) throw new Error('No unlocked routing for a style that nothing uses')
        // A newer routing for the same style: the one new orders take.
        const newer = await tx.routing.create({
          data: {
            code: `${old.code}-ZZ`,
            name: 'ZZCHECK newer routing',
            styleId: old.styleId,
            steps: { create: old.steps.map((s) => ({ sequence: s.sequence, operationId: s.operationId, departmentId: s.departmentId, execution: s.execution, skip: s.skip, isQcStep: s.isQcStep })) },
          },
        })
        const { before } = await deleteRouting(tx, old.id)
        await tx.auditLog.create({ data: { userId: user.id, module: 'masters', action: 'DELETE', entityType: 'Routing', entityId: before.id, before: JSON.parse(JSON.stringify(before)) } })

        const listed = (await deletedRoutings(tx)).find((d) => d.routingId === old.id)
        check(`${old.name} (${old.code}) is listed as deleted, with its ${old.steps.length} steps`, !!listed && listed.steps.length === old.steps.length && listed.style?.code === old.style.code, listed)

        const { routing, message } = await restoreRouting(tx, listed!.auditId, user.id)
        check('brought back: the same name, code, style, version and steps', routing.name === old.name && routing.code === old.code && routing.styleId === old.styleId && routing.version === old.version && routing.steps.map((s) => s.operationId).join() === old.steps.map((s) => s.operationId).join(), { message, code: routing.code })
        check('with its dates as they were', routing.updatedAt.getTime() === old.updatedAt.getTime() && routing.createdAt.getTime() === old.createdAt.getTime(), { was: old.updatedAt, now: routing.updatedAt })
        check('each step as it was: line, minutes, skipping, check', routing.steps.every((s, i) => s.workstationId === old.steps[i].workstationId && String(s.smv) === String(old.steps[i].smv) && s.skip === old.steps[i].skip && s.isQcStep === old.steps[i].isQcStep))
        const inUse = (await trackedRoutings(tx, [old.style])).get(old.style.id)
        check('it does not push the newer routing out of "In use"', inUse?.routing.id === newer.id, inUse?.routing.code)
        check('no longer listed as deleted', !(await deletedRoutings(tx)).some((d) => d.routingId === old.id))
        let twice = ''
        await restoreRouting(tx, listed!.auditId, user.id).catch((e) => (twice = e.code))
        check('not brought back twice', twice === 'ALREADY_RESTORED', twice)
        throw ROLLBACK
      },
      { timeout: 60_000 },
    )
    .catch((e) => {
      if (e !== ROLLBACK) throw e
    })
  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  process.exitCode = fail ? 1 : 0
}
main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
