/**
 * Checks the company's head office address: kept in Settings → Company and
 * carried to the purchase order's print. Demo database (lderp_demo) only; the
 * address it found is put back at the end. From the repo root:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5117/api npx tsx tools/check-company-head-office.ts
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
const HO = 'Essgee Options One, 3rd Floor, Shop No. 333-336 Near Tilak Bhavan, Opp. Indiabulls Senapati Bapat Marg, Prabhadevi, Mumbai - 400013'

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

  const before = (await call('GET', '/settings/company')).body?.data
  const saved = await call('PATCH', '/settings/company', { headOfficeAddress: HO })
  check('Settings → Company saves a head office address', saved.status < 300 && saved.body?.data?.headOfficeAddress === HO, saved)

  const po = (await call('GET', '/purchase/orders?limit=1')).body?.data?.[0]
  if (!po) { check('a purchase order to print exists', false); return }
  const print = await call('GET', `/purchase/orders/${po.id}/print`)
  check("the purchase order's print carries it", print.body?.data?.header?.company?.headOfficeAddress === HO || print.body?.data?.company?.headOfficeAddress === HO, Object.keys(print.body?.data ?? {}))

  const cleared = await call('PATCH', '/settings/company', { headOfficeAddress: null })
  check('it can be cleared', cleared.status < 300 && cleared.body?.data?.headOfficeAddress == null, cleared.body?.data?.headOfficeAddress)

  await call('PATCH', '/settings/company', { headOfficeAddress: before?.headOfficeAddress ?? null })
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}
main().finally(() => prisma.$disconnect())
