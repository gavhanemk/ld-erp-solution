/**
 * Document numbers (the user's rules, 27 Nov 2026):
 *   - deleting the NEWEST document of a series gives its number back, so the
 *     next one takes it again; deleting one in the middle leaves that gap;
 *   - a document restored from the recycle bin gets its old number back when
 *     it is still free, a fresh one when it has been reused;
 *   - Settings shows each series' last used number, and a user who may edit
 *     settings can set the next number — never below one already in use.
 *
 * Demo database (lderp_demo) only; everything it makes is deleted at the end
 * and the PO series is put back. From the repo root:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_BUYER_EMAIL=... E2E_BUYER_PASSWORD=... \
 *   E2E_API=http://localhost:5117/api npx tsx tools/check-number-series.ts
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 300)}` : ''}`)
}
const login = async (email?: string, password?: string) =>
  (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())).accessToken as string
const caller = (token: string) => async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: (await r.json().catch(() => null)) as any }
}

async function main() {
  const [{ current_database: db }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (db !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  const call = caller(await login(process.env.E2E_EMAIL, process.env.E2E_PASSWORD))
  const buyer = caller(await login(process.env.E2E_BUYER_EMAIL, process.env.E2E_BUYER_PASSWORD))

  const supplier = ((await call('GET', '/masters/suppliers?limit=20')).body.data as any[]).find((s) => !/vhagar/i.test(s.name) && s.gstin)
  const item = ((await call('GET', '/masters/items?limit=100')).body.data as any[]).find((i) => !/vhagar/i.test(i.name) && ['RAW_MATERIAL', 'TRIM', 'PACKING_MATERIAL'].includes(i.type))
  const store = ((await call('GET', '/masters/warehouses?limit=50')).body.data as any[])[0]
  const line = { itemId: item.id, qty: 10, unitRate: 100, gstRate: 12 }
  const newPo = async () => (await call('POST', '/purchase/orders', { supplierId: supplier.id, lines: [line] })).body?.data as { id: string; poNumber: string }
  const series = async () => ((await call('GET', '/settings/number-series')).body.data as any[]).find((s) => s.docType === 'PO' && s.isActive)
  const made: string[] = []
  const original = await series()

  try {
    // ── The newest number comes back ─────────────────────────────────────
    const a = await newPo(); made.push(a.id)
    await call('DELETE', `/purchase/orders/${a.id}`)
    const b = await newPo(); made.push(b.id)
    check(`1. the newest order deleted (${a.poNumber}), the next one takes its number`, b.poNumber === a.poNumber, { a: a.poNumber, b: b.poNumber })

    // ── A middle one stays a gap ─────────────────────────────────────────
    const c = await newPo(); made.push(c.id)
    await call('DELETE', `/purchase/orders/${b.id}`)
    const d = await newPo(); made.push(d.id)
    check(`2. one in the middle deleted (${b.poNumber}), the next one does not fill it`, d.poNumber !== b.poNumber && d.poNumber > c.poNumber, { b: b.poNumber, c: c.poNumber, d: d.poNumber })

    // ── Restoring ────────────────────────────────────────────────────────
    const rb = await call('POST', `/purchase/recycle-bin/${b.id}/restore`)
    const bAfter = (await call('GET', `/purchase/orders/${b.id}`)).body?.data
    check(`3. the middle one restored gets its own number back (${b.poNumber})`, rb.status < 300 && bAfter?.poNumber === b.poNumber, { status: rb.status, got: bAfter?.poNumber })
    const ra = await call('POST', `/purchase/recycle-bin/${a.id}/restore`)
    const aAfter = (await call('GET', `/purchase/orders/${a.id}`)).body?.data
    check(`4. the one whose number was reused is restored under a fresh number`, ra.status < 300 && !!aAfter?.poNumber && aAfter.poNumber !== a.poNumber && aAfter.poNumber > d.poNumber, { status: ra.status, got: aAfter?.poNumber })

    // ── Goods receipt: deleted outright, its number comes back ───────────
    await call('PATCH', `/purchase/orders/${d.id}/send`, {})
    const poLine = (await call('GET', `/purchase/orders/${d.id}`)).body?.data?.lines?.[0]
    const grn = async () => (await call('POST', '/purchase/grn', { poId: d.id, challanNo: `ZZ-${Date.now()}`, challanDate: new Date().toISOString(), lines: [{ poLineId: poLine.id, warehouseId: store.id, receivedQty: 1 }] })).body?.data
    const g1 = await grn()
    const del = await call('DELETE', `/purchase/grn/${g1?.id}`, { reason: 'test' })
    const g2 = await grn()
    check(`5. the newest goods receipt deleted (${g1?.grnNumber}), the next one takes its number`, del.status < 300 && g2?.grnNumber === g1?.grnNumber, { del: del.status, g1: g1?.grnNumber, g2: g2?.grnNumber })
    if (g2?.id) await call('DELETE', `/purchase/grn/${g2.id}`, { reason: 'test' })

    // ── Running series in Settings ───────────────────────────────────────
    const now = await series()
    const lastMade = [a, b, c, d].map((x) => x.poNumber).concat(aAfter?.poNumber ?? []).sort().at(-1)
    check(`6. Settings shows the PO series' last used number (${lastMade})`, now?.lastUsedNumber === lastMade, now)
    const low = await call('PATCH', `/settings/number-series/${now.id}/next`, { nextNumber: 1 })
    check('7. the next number cannot be set to one already in use', low.status === 409 && low.body?.code === 'NUMBER_IN_USE', low)
    const up = await call('PATCH', `/settings/number-series/${now.id}/next`, { nextNumber: now.lastNumber + 5 })
    const e = await newPo(); made.push(e.id)
    check(`8. set ahead, the next order takes that number`, up.status < 300 && e.poNumber === up.body?.data?.nextNumber, { status: up.status, next: up.body?.data?.nextNumber, got: e.poNumber })
    const denied = await buyer('PATCH', `/settings/number-series/${now.id}/next`, { nextNumber: now.lastNumber + 9 })
    check('9. a user who may not edit settings cannot change it', denied.status === 403, denied.status)
  } finally {
    for (const id of made.reverse()) {
      await call('DELETE', `/purchase/orders/${id}`)
      await call('DELETE', `/purchase/recycle-bin/${id}`)
    }
    // Put the counter back where it was found.
    await prisma.numberSeries.update({ where: { id: original.id }, data: { lastNumber: original.lastNumber } })
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}
main().finally(() => prisma.$disconnect())
