// Which routing an order is offered first when its stages are loaded: of a style's own routings,
// the one changed last — the one Masters → Routings marks "In use". On a local database, inside
// a transaction that always rolls back. From apps/api:
//   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" npx tsx ../../tools/check-routing-default.ts
import { prisma } from '../packages/database/src/index'
import { routingsFor } from '../apps/api/src/services/route.service'
import { trackedRoutings } from '../apps/api/src/services/styleTrack.service'

const ROLLBACK = new Error('ROLLBACK')
async function main() {
  const host = new URL(process.env.DATABASE_URL ?? 'x:').hostname
  if (!['localhost', '127.0.0.1'].includes(host)) throw new Error('local databases only')
  let pass = 0
  let fail = 0
  const check = (label: string, ok: boolean, extra: unknown = '') => {
    ok ? pass++ : fail++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' — ' + JSON.stringify(extra)}`)
  }
  await prisma
    .$transaction(async (tx) => {
      const old = await tx.routing.findFirst({ where: { isActive: true, styleId: { not: null } }, include: { steps: true, style: { select: { id: true, code: true, category: true } } } })
      if (!old?.style) throw new Error('No active routing made for a style')
      // A second routing for the same style, made now, with a code that sorts after the old one's.
      const fresh = await tx.routing.create({
        data: {
          code: `${old.code}-ZZ`,
          name: 'ZZCHECK newer routing',
          styleId: old.styleId,
          isActive: true,
          steps: { create: old.steps.map((s) => ({ sequence: s.sequence, operationId: s.operationId, departmentId: s.departmentId, execution: s.execution, skip: s.skip, isQcStep: s.isQcStep })) },
        },
      })
      const offered = await routingsFor(tx, [old.style.id])
      const marked = (await trackedRoutings(tx, [old.style])).get(old.style.id)
      check(`${old.style.code}: the newer routing is offered first when an order loads its stages`, offered[0]?.id === fresh.id, offered.map((r) => r.code))
      check('and it is the one Masters → Routings marks "In use"', marked?.routing.id === fresh.id && offered[0]?.id === marked?.routing.id, marked?.routing.code)
      // Changed later, the older one becomes the default again.
      await tx.routing.update({ where: { id: old.id }, data: { notes: 'touched by the check' } })
      const again = await routingsFor(tx, [old.style.id])
      const marked2 = (await trackedRoutings(tx, [old.style])).get(old.style.id)
      check('the older one, changed since, is offered first again — and marked "In use"', again[0]?.id === old.id && marked2?.routing.id === old.id, again.map((r) => r.code))
      throw ROLLBACK
    })
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
