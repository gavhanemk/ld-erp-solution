// Masters → Routings, by style (GET /masters/routings/by-style), against a
// database on this machine, inside one transaction that always rolls back.
//
// Makes a manufacturing order for a style with a routing of its own, given
// that routing, and checks the list puts it under that routing; that the
// style counts as having orders in work; that the order's and its sales
// order's numbers find the style; that a style with no routing says so; and
// that the routing a new order takes is the one marked. From apps/api:
//
//   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
//   npx tsx ../../tools/check-routings-by-style.ts
import { prisma } from '../packages/database/src/index'
import { routingsByStyle } from '../apps/api/src/services/routingOverview.service'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra: unknown = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || extra === '' ? '' : ' — ' + JSON.stringify(extra)}`)
}
const ROLLBACK = new Error('ROLLBACK')

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? 'x:').hostname
  if (!['localhost', '127.0.0.1'].includes(host)) throw new Error(`Refusing to run against ${host || 'an unknown database'}: local databases only.`)
  await prisma
    .$transaction(
      async (tx) => {
        const before = await routingsByStyle(tx, { page: 1, limit: 100 })
        const withOwn = before.rows.find((r) => r.kind === 'OWN' && r.routings.some((x) => x.takesNew))
        if (!withOwn) throw new Error('No style with a routing of its own in use')
        const routing = withOwn.routings.find((x) => x.takesNew)!
        check(`setup: ${withOwn.style.code} takes "${routing.name}" v${routing.version} on new orders`, routing.applies === 'STYLE' && routing.isActive)
        check('every style is counted once, by kind', before.counts.ALL === before.counts.OWN + before.counts.SHARED + before.counts.NONE, before.counts)
        const none = before.rows.find((r) => r.kind === 'NONE')
        if (none) check(`${none.style.code} has no routing: shown with none, so the list offers "Make routing"`, none.routings.length === 0)

        const user = await tx.user.findFirstOrThrow({ select: { id: true } })
        const brand = await tx.brand.findFirstOrThrow({ select: { id: true } })
        const so = await tx.salesOrder.findFirst({ select: { id: true, soNumber: true } })
        const stamp = Date.now()
        const mo = await tx.manufacturingOrder.create({
          data: {
            moNumber: `ZZCHECK-MO-${stamp}`,
            brandId: brand.id,
            createdById: user.id,
            status: 'CUTTING',
            soId: so?.id ?? null,
            routingId: routing.id,
            routingVersion: routing.version,
            lines: { create: [{ styleId: withOwn.style.id, color: 'Check Blue', totalQty: 120 }] },
          },
        })

        const after = await routingsByStyle(tx, { page: 1, limit: 100 })
        const row = after.rows.find((r) => r.style.id === withOwn.style.id)!
        const order = row.orders.find((o) => o.moId === mo.id)
        check('the order is listed under its style, given that routing and its version', order?.routingId === routing.id && order?.routingVersion === routing.version && order?.planned === 120 && order?.open === true, order)
        check(`its sales order is named${so ? ` (${so.soNumber})` : ' (none: for stock)'}`, so ? order?.so?.soNumber === so.soNumber : order?.so === null, order?.so)
        check('the style now counts as having orders in work', after.counts.ON_ORDERS === before.counts.ON_ORDERS + (before.rows.find((r) => r.style.id === withOwn.style.id)!.orders.some((o) => o.open) ? 0 : 1), { before: before.counts.ON_ORDERS, after: after.counts.ON_ORDERS })
        const onOrders = await routingsByStyle(tx, { page: 1, limit: 100, show: 'ON_ORDERS' })
        check('"Orders in work" lists the style', onOrders.rows.some((r) => r.style.id === withOwn.style.id) && onOrders.rows.every((r) => r.orders.some((o) => o.open)))
        const byMo = await routingsByStyle(tx, { page: 1, limit: 100, q: mo.moNumber })
        check(`searching ${mo.moNumber} finds just that style`, byMo.rows.length === 1 && byMo.rows[0].style.id === withOwn.style.id, byMo.rows.map((r) => r.style.code))
        if (so) {
          const bySo = await routingsByStyle(tx, { page: 1, limit: 100, q: so.soNumber })
          check(`searching ${so.soNumber} finds the style`, bySo.rows.some((r) => r.style.id === withOwn.style.id))
        }
        const byRouting = await routingsByStyle(tx, { page: 1, limit: 100, q: routing.name.slice(0, 12) })
        check(`searching the routing's name finds its style`, byRouting.rows.some((r) => r.style.id === withOwn.style.id))

        // Stopped: still shown under the style (its order keeps it), no longer the one new orders take.
        await tx.routing.update({ where: { id: routing.id }, data: { isActive: false } })
        const stopped = await routingsByStyle(tx, { page: 1, limit: 100, q: withOwn.style.code })
        const still = stopped.rows.find((r) => r.style.id === withOwn.style.id)?.routings.find((x) => x.id === routing.id)
        check('a stopped routing stays under its style, with its order, and is no longer the one new orders take', !!still && still.isActive === false && still.takesNew === false && stopped.rows[0].orders.some((o) => o.routingId === routing.id))

        throw ROLLBACK
      },
      { timeout: 60_000 },
    )
    .catch((e) => {
      if (e !== ROLLBACK) throw e
    })
  const left = await prisma.manufacturingOrder.count({ where: { moNumber: { startsWith: 'ZZCHECK-MO-' } } })
  check('nothing kept', left === 0, left)
  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  process.exitCode = fail ? 1 : 0
}
main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
