/**
 * Checks a purchase order's "Delivery by" date against a running API and the
 * demo database (lderp_demo) only. Refuses any other database. Each run makes
 * one draft order and deletes it at the end. From the repo root:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5117/api npx tsx tools/check-po-delivery-date.ts
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 400)}` : ''}`)
}
type Res = { status: number; body: any }
let token = ''
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  let j: any = null
  try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}

async function main() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) { console.error('Set E2E_EMAIL and E2E_PASSWORD.'); process.exitCode = 2; return }
  const [{ current_database: dbName }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (dbName !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  token = (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())).accessToken
  if (!token) throw new Error('login failed')
  // The API must be writing to the same demo database: the sign-in is recorded there.
  const me = await prisma.user.findUnique({ where: { email }, select: { lastLoginAt: true } })
  if (!me?.lastLoginAt || Date.now() - me.lastLoginAt.getTime() > 60_000) {
    console.error('Refusing to run: the API is not using lderp_demo.'); process.exitCode = 2; return
  }

  // LD Cotton Mills goods only — never VHAGAR.
  const supplier = ((await call('GET', '/masters/suppliers?limit=20')).body.data as Array<{ id: string; name: string }>).find((s) => !/vhagar/i.test(s.name))!
  const item = ((await call('GET', '/masters/items?limit=100')).body.data as Array<{ id: string; name: string; type: string }>)
    .find((i) => !/vhagar/i.test(i.name) && ['RAW_MATERIAL', 'TRIM', 'PACKING_MATERIAL'].includes(i.type))!
  const line = { itemId: item.id, qty: 10, unitRate: 12, gstRate: 18 }
  const body = (deliveryDate: string | null) => ({ supplierId: supplier.id, poDate: '2026-11-25', deliveryDate, lines: [line] })

  const early = await call('POST', '/purchase/orders', body('2026-11-20'))
  check('a delivery date before the order date is refused', early.status === 400 && early.body?.code === 'DELIVERY_BEFORE_ORDER', early)
  if (early.status < 300 && early.body?.data?.id) await call('DELETE', `/purchase/orders/${early.body.data.id}`)

  const same = await call('POST', '/purchase/orders', body('2026-11-25'))
  check('delivery on the order date itself is accepted', same.status < 300, same)
  if (same.body?.data?.id) await call('DELETE', `/purchase/orders/${same.body.data.id}`)

  const po = await call('POST', '/purchase/orders', body('2026-12-05'))
  check('a later delivery date is saved', po.status < 300, po)
  const id = po.body?.data?.id as string | undefined
  if (id) {
    const read = await call('GET', `/purchase/orders/${id}`)
    check('the order reads back its delivery date', String(read.body?.data?.deliveryDate ?? '').startsWith('2026-12-05'), read.body?.data?.deliveryDate)

    const moved = await call('PATCH', `/purchase/orders/${id}`, { deliveryDate: '2026-11-01', lines: [line] })
    check('editing it to before the stored order date is refused', moved.status === 400 && moved.body?.code === 'DELIVERY_BEFORE_ORDER', moved)

    const cleared = await call('PATCH', `/purchase/orders/${id}`, { supplierId: supplier.id, deliveryDate: null, lines: [line] })
    check('the date can be cleared', cleared.status < 300 && !(await call('GET', `/purchase/orders/${id}`)).body?.data?.deliveryDate, cleared)

    await call('DELETE', `/purchase/orders/${id}`)
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}
main().finally(() => prisma.$disconnect())
