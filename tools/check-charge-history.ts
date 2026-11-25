/**
 * A charge's GST rate is set in Masters → Charges, and a saved purchase order
 * keeps the rate it was saved with (the user's rule, 25 Nov 2026):
 *
 *   1. Transport at 18% in the master; an order saved with it is at 18%.
 *   2. The master is changed to 5%.
 *   3. The saved order still reads and recalculates at 18% — reopened and
 *      saved again unchanged, it stays 18%.
 *   4. A new order takes 5%; on the saved order, the charge taken off and
 *      added again takes 5% too.
 *
 * Demo database (lderp_demo) only; the master is put back and the orders
 * deleted at the end. From the repo root:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5117/api npx tsx tools/check-charge-history.ts
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 300)}` : ''}`)
}
let token = ''
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: (await r.json().catch(() => null)) as any }
}

async function main() {
  const email = process.env.E2E_EMAIL, password = process.env.E2E_PASSWORD
  if (!email || !password) { console.error('Set E2E_EMAIL and E2E_PASSWORD.'); process.exitCode = 2; return }
  const [{ current_database: db }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (db !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  token = (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())).accessToken
  if (!token) throw new Error('login failed')

  const type = ((await call('GET', '/masters/charge-types?limit=100')).body.data as any[]).find((t) => t.name === 'Transport Charges')
  if (!type) { check('Transport Charges is in the master', false); return }
  const original = { defaultGstRate: Number(type.defaultGstRate), defaultGstMode: type.defaultGstMode }
  const setRate = (rate: number) => call('PATCH', `/masters/charge-types/${type.id}`, { defaultGstMode: 'MANUAL', defaultGstRate: rate })

  const supplier = ((await call('GET', '/masters/suppliers?limit=20')).body.data as any[]).find((s) => !/vhagar/i.test(s.name) && s.gstin)
  const item = ((await call('GET', '/masters/items?limit=100')).body.data as any[]).find((i) => !/vhagar/i.test(i.name) && ['RAW_MATERIAL', 'TRIM', 'PACKING_MATERIAL'].includes(i.type))
  const line = { itemId: item.id, qty: 10, unitRate: 100, gstRate: 12 }
  const made: string[] = []
  const rateOn = async (id: string) => {
    const po = (await call('GET', `/purchase/orders/${id}`)).body?.data
    const c = po?.charges?.find((x: any) => x.chargeTypeId === type.id)
    return { rate: Number(c?.gstRate), id: c?.id as string | undefined, total: Number(po?.totalAmount) }
  }
  try {
    check('master set to 18%', (await setRate(18)).status < 300)
    const po = await call('POST', '/purchase/orders', { supplierId: supplier.id, lines: [line], charges: [{ chargeTypeId: type.id, amount: 1000 }] })
    const id = po.body?.data?.id as string
    if (id) made.push(id)
    const first = await rateOn(id)
    check('1. an order saved now carries Transport at 18%', first.rate === 18, first)

    check('2. master changed to 5%', (await setRate(5)).status < 300)
    const after = await rateOn(id)
    check('3a. the saved order still reads 18%', after.rate === 18 && after.total === first.total, after)

    const resaved = await call('PATCH', `/purchase/orders/${id}`, { lines: [line], charges: [{ chargeTypeId: type.id, amount: 1000, sourceChargeId: first.id }] })
    const r2 = await rateOn(id)
    check('3b. saved again unchanged, it stays 18% and the same total', resaved.status < 300 && r2.rate === 18 && r2.total === first.total, { status: resaved.status, ...r2 })

    const edited = await call('PATCH', `/purchase/orders/${id}`, { lines: [line], charges: [{ chargeTypeId: type.id, amount: 1500, sourceChargeId: r2.id }] })
    const r3 = await rateOn(id)
    check('3c. its amount edited, it keeps 18%', edited.status < 300 && r3.rate === 18, { status: edited.status, ...r3 })

    const fresh = await call('POST', '/purchase/orders', { supplierId: supplier.id, lines: [line], charges: [{ chargeTypeId: type.id, amount: 1000 }] })
    if (fresh.body?.data?.id) made.push(fresh.body.data.id)
    check('4a. a new order takes the master’s new 5%', (await rateOn(fresh.body?.data?.id)).rate === 5)

    const readded = await call('PATCH', `/purchase/orders/${id}`, { lines: [line], charges: [{ chargeTypeId: type.id, amount: 1000, fresh: true }] })
    const r4 = await rateOn(id)
    check('4b. on the saved order, Transport taken off and added again takes 5%', readded.status < 300 && r4.rate === 5, { status: readded.status, ...r4 })
  } finally {
    await call('PATCH', `/masters/charge-types/${type.id}`, original)
    for (const id of made) await call('DELETE', `/purchase/orders/${id}`)
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}
main().finally(() => prisma.$disconnect())
