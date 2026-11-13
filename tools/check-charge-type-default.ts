/**
 * Checks Masters → Charges' purchase default (ChargeType.defaultGstMode /
 * defaultHsnCodeId), against a running API and the demo database (lderp_demo)
 * only. Refuses any database that is not the demo. Each run makes its own
 * ZZTEST charge types and SAC, named with the time, so it can run again and
 * again. From apps/api, so the Prisma client resolves:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... npx tsx ../../tools/check-charge-type-default.ts
 *
 * Optional: E2E_API (default http://localhost:5101/api).
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra)}` : ''}`)
}

async function main() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) {
    console.error('Set E2E_EMAIL and E2E_PASSWORD in your shell for this run.')
    process.exitCode = 2
    return
  }

  const [{ current_database: dbName }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (dbName !== 'lderp_demo') {
    console.error('Refusing to run: the database is not lderp_demo. These tests write data and run only on the local demo.')
    process.exitCode = 2
    return
  }

  const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())
  const token = login.accessToken
  if (!token) {
    console.error(`Sign-in refused for ${email} at ${API}.`)
    process.exitCode = 2
    return
  }
  const call = async (m: string, p: string, b?: unknown) => {
    const r = await fetch(`${API}${p}`, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: b ? JSON.stringify(b) : undefined })
    let j: any = null
    try { j = await r.json() } catch {}
    return { status: r.status, body: j }
  }

  const RUN = String(Date.now() % 100000)

  // ── HSN mode needs an active SAC; 9965 (goods transport) if the demo has none. ──
  let sac = (await call('GET', '/masters/hsn-codes?q=9965&limit=5')).body?.data?.[0]
  if (!sac) {
    const made = await call('POST', '/masters/hsn-codes', { code: '9965', description: 'Goods transport services', kind: 'SERVICES', gstRate: 18 })
    check('setup: made SAC 9965 to test against', made.status === 201, made.body)
    sac = made.body?.data
  }

  // ── A charge type refuses HSN mode with no code, and with a retired code. ──
  let r = await call('POST', '/masters/charge-types', { name: `ZZTEST Charge ${RUN}`, applyOnPurchase: true, defaultGstMode: 'HSN' })
  check('refuses HSN with no SAC chosen', r.status === 400 && r.body?.code === 'NO_DEFAULT_HSN', r.body)

  const deadSac = await call('POST', '/masters/hsn-codes', { code: String(90000 + (Number(RUN) % 9999)), description: 'Retiring this at once', kind: 'SERVICES', gstRate: 12 })
  await call('PATCH', `/masters/hsn-codes/${deadSac.body?.data?.id}`, { isActive: false })
  r = await call('POST', '/masters/charge-types', { name: `ZZTEST Charge B ${RUN}`, applyOnPurchase: true, defaultGstMode: 'HSN', defaultHsnCodeId: deadSac.body?.data?.id })
  check('refuses HSN with a retired SAC', r.status === 400 && r.body?.code === 'INVALID_DEFAULT_HSN', r.body)

  // ── Saved correctly, and read back with the SAC's own rate for the form to show. ──
  r = await call('POST', '/masters/charge-types', { name: `ZZTEST Charge ${RUN}`, applyOnPurchase: true, defaultGstMode: 'HSN', defaultHsnCodeId: sac.id })
  const made = r.body?.data
  check('saves with its usual SAC', r.status === 201 && made?.defaultGstMode === 'HSN' && made?.defaultHsnCodeId === sac.id, made)

  const list = await call('GET', `/masters/charge-types?q=${encodeURIComponent(`ZZTEST Charge ${RUN}`)}&limit=5`)
  const row = list.body?.data?.find((x: any) => x.id === made?.id)
  check("the list sends it with the SAC's own rate (18%), for the column and the form", row?.defaultHsnRate === 18 && row?.defaultHsnCode?.code === '9965', row)

  // ── Switching to MANUAL clears the SAC it no longer needs. ──
  r = await call('PATCH', `/masters/charge-types/${made.id}`, { defaultGstMode: 'MANUAL', defaultGstRate: 5 })
  check('switching to manual clears the SAC it started from', r.status === 200 && r.body?.data?.defaultGstMode === 'MANUAL' && r.body?.data?.defaultHsnCodeId === null, r.body)

  r = await call('PATCH', `/masters/charge-types/${made.id}`, { defaultGstMode: 'HSN', defaultHsnCodeId: sac.id })
  check('back to HSN with the SAC again', r.status === 200 && r.body?.data?.defaultGstMode === 'HSN')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
