// The routing master under Masters → Routings, end to end, on the live shared
// database inside one transaction that always throws (nothing is kept): the
// code made from the style instead of typed, the fabric picked from the
// fabric items in stock, who made a routing and who changed it last, and
// deleting — refused while an order or a BOM uses the routing.
//
// Needs the demo routing RT-SH-PLAIN (used on orders and a BOM), a style with
// no routing of its own, and two active users. Run it from apps/api, so the
// database settings load:
//
//   cd apps/api
//   npx tsx ../../tools/check-routing-master.ts
import { prisma } from '../packages/database/src/index'
import { createRouting, deleteRouting, fabricStock, routingCode, updateRouting } from '../apps/api/src/services/routing.service'
import { createRoutingSchema, updateRoutingSchema } from '../apps/api/src/schemas/master.schemas'

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
  const plain = await prisma.routing.findUnique({ where: { code: 'RT-SH-PLAIN' }, include: { steps: { orderBy: { sequence: 'asc' } }, _count: { select: { mos: true, boms: true } } } })
  const [maker, editor] = await prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true }, take: 2, orderBy: { createdAt: 'asc' } })
  const bare = await prisma.style.findFirst({ where: { isActive: true, routings: { none: {} } }, select: { id: true, code: true } })
  const other = await prisma.style.findFirst({ where: { isActive: true, routings: { none: {} }, id: { not: bare?.id } }, select: { id: true, code: true } })
  const thread = await prisma.item.findFirst({ where: { isActive: true, category: { OR: [{ name: { contains: 'thread', mode: 'insensitive' } }, { parent: { name: { contains: 'thread', mode: 'insensitive' } } }] } }, select: { id: true, name: true } })
  if (!plain || !maker || !editor || !bare || !other || !thread) throw new Error('Needs RT-SH-PLAIN, two active users, two styles without a routing and a thread item')
  const routingsBefore = await prisma.routing.count()

  const steps = plain.steps.map((s) => ({
    sequence: s.sequence,
    operationId: s.operationId,
    departmentId: s.departmentId,
    workstationId: s.workstationId,
    isQcStep: s.isQcStep,
    execution: s.execution,
    skip: s.skip,
    ratePerPiece: s.ratePerPiece == null ? null : Number(s.ratePerPiece),
  }))

  // ── Fabric: what the form offers ─────────────────────────────
  const fabrics = await fabricStock(prisma)
  check('the form offers fabrics from the stock records', fabrics.length > 0, `${fabrics.length} fabrics`)
  const notFabric = await prisma.item.count({
    where: { id: { in: fabrics.map((f) => f.id) }, NOT: { OR: [{ category: { name: { contains: 'fabric', mode: 'insensitive' } } }, { category: { parent: { name: { contains: 'fabric', mode: 'insensitive' } } } }] } },
  })
  check('every one is filed under Fabric', notFabric === 0)
  const withStock = fabrics.filter((f) => f.onHand + f.customers > 0)
  check('those with stock come first', fabrics.slice(0, withStock.length).every((f) => f.onHand + f.customers > 0))
  const sample = fabrics[0]
  const ledger = await prisma.stockLedger.groupBy({ by: ['ownership'], where: { itemId: sample.id }, _sum: { inQty: true, outQty: true } })
  const sum = (own: boolean) => ledger.filter((l) => (l.ownership === 'OWNED') === own).reduce((n, l) => n + Number(l._sum.inQty ?? 0) - Number(l._sum.outQty ?? 0), 0)
  check(`on hand for ${sample.name} is the ledger's own figure`, Math.abs(sample.onHand - sum(true)) < 0.001 && Math.abs(sample.customers - sum(false)) < 0.001, `${sample.onHand} ours, ${sample.customers} customers'`)

  try {
    await prisma.$transaction(
      async (tx) => {
        // ── Make: no code typed ─────────────────────────────────
        const made = await createRouting(tx, createRoutingSchema.parse({ name: 'Check routing', styleId: bare.id, fabricItemId: sample.id, steps }), maker.id)
        const r1 = made.routing
        check('a routing made without a code gets one from its style', r1.code === `RT-${bare.code}`, r1.code)
        check('it keeps the fabric picked', r1.fabric?.id === sample.id, r1.fabric?.name)
        check('it records who made it, as maker and last editor', r1.createdBy?.id === maker.id && r1.updatedBy?.id === maker.id, r1.updatedBy?.name)
        check('the message names it, not its code', made.message.startsWith('Check routing saved.'), made.message)

        const second = await createRouting(tx, createRoutingSchema.parse({ name: 'Check routing two', styleId: bare.id, steps }), maker.id)
        check('a second for the same style is numbered', second.routing.code === `RT-${bare.code}-2`, second.routing.code)
        check('a fabric is not required', second.routing.fabricItemId === null)

        const shared = await createRouting(tx, createRoutingSchema.parse({ name: 'Check shared', category: 'Formal shirts', steps }), maker.id)
        check('a category routing is named for the category', shared.routing.code === 'RT-FORMAL-SHIRTS', shared.routing.code)
        check('one for any style is RT-ANY', (await routingCode(tx, { styleId: null, category: null })).startsWith('RT-ANY'))

        check(
          'something other than fabric is refused as the fabric',
          (await refused(() => createRouting(tx, createRoutingSchema.parse({ name: 'Bad fabric', styleId: bare.id, fabricItemId: thread.id, steps }), maker.id), 'NOT_A_FABRIC')) === true,
          thread.name,
        )

        // ── Change: who and when ────────────────────────────────
        const before = r1.updatedAt
        await new Promise((r) => setTimeout(r, 20))
        const edited = await updateRouting(tx, r1.id, updateRoutingSchema.parse({ name: 'Check routing, renamed', fabricItemId: fabrics[1]?.id ?? null }), editor.id)
        check('an edit records who made it', edited.routing.updatedBy?.id === editor.id, edited.routing.updatedBy?.name)
        check('the maker stays the maker', edited.routing.createdBy?.id === maker.id)
        check('and the time moves on', edited.routing.updatedAt.getTime() > before.getTime())
        check('the fabric can be changed', edited.routing.fabricItemId === (fabrics[1]?.id ?? null))
        check('the code stays while the style does', edited.routing.code === r1.code)

        const locked = await updateRouting(tx, r1.id, updateRoutingSchema.parse({ isLocked: true }), maker.id)
        check('locking counts as a change, by whoever locked it', locked.routing.updatedBy?.id === maker.id && /locked/.test(locked.message), locked.message)
        check('a locked routing cannot be deleted', (await refused(() => deleteRouting(tx, r1.id), 'ROUTING_LOCKED')) === true)
        await updateRouting(tx, r1.id, updateRoutingSchema.parse({ isLocked: false }), maker.id)

        const moved = await updateRouting(tx, r1.id, updateRoutingSchema.parse({ styleId: other.id }), editor.id)
        check('moved to another style, the code follows it', moved.routing.code === `RT-${other.code}`, moved.routing.code)

        const stopped = await updateRouting(tx, second.routing.id, updateRoutingSchema.parse({ isActive: false }), editor.id)
        check('stopping it says so', /no longer offered/.test(stopped.message), stopped.message)
        const again = await updateRouting(tx, second.routing.id, updateRoutingSchema.parse({ isActive: true }), editor.id)
        check('and it can be used again', again.routing.isActive && /again/.test(again.message), again.message)

        // ── Delete ──────────────────────────────────────────────
        const gone = await deleteRouting(tx, r1.id)
        check('an unused routing is deleted', !(await tx.routing.findUnique({ where: { id: r1.id } })), gone.message)
        check('its steps go with it', (await tx.routingStep.count({ where: { routingId: r1.id } })) === 0)
        check(
          `a routing on orders or a BOM is kept (${plain.code}: ${plain._count.mos} orders, ${plain._count.boms} BOM)`,
          (await refused(() => deleteRouting(tx, plain.id), 'ROUTING_IN_USE')) === true,
        )

        throw ROLLBACK
      },
      { timeout: 120_000, maxWait: 20_000 },
    )
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  check('nothing kept', (await prisma.routing.count()) === routingsBefore)
  console.log(`\n${pass} passed, ${fail} failed`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
