/**
 * Purchase order numbers (the user's rules, 28 Nov 2026), and the running series:
 *   - purchase orders and service purchase orders share ONE PO series;
 *   - a new order takes the lowest free number of it — a deleted unsent
 *     draft's (PO-0002 deleted between 0001 and 0003 is the next order's), or
 *     a number never used at all (the "0001 missing" case);
 *   - an order sent to the supplier — even if put back to Draft — cannot be
 *     deleted, only cancelled, and its number is never used again; one binned
 *     before that rule cannot be destroyed;
 *   - two orders saved at the same moment never get the same number;
 *   - restored from the recycle bin, an order gets its own number back when
 *     free, else a fresh one;
 *   - Settings shows the last used and the true next number; Set moves the
 *     next number ahead (what it skipped stays skipped) but never onto a
 *     number in use; only users who may edit settings can;
 *   - other documents keep the older rule: the newest gives its number back.
 *
 * Demo database (lderp_demo) only; everything it makes is removed at the end
 * and the PO series is put back. From the repo root:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5434/lderp_demo?schema=ld_erp" \
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
const tail = (n?: string) => Number(String(n ?? '').split('-').pop())

async function main() {
  const [{ current_database: db }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (db !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  const call = caller(await login(process.env.E2E_EMAIL, process.env.E2E_PASSWORD))
  const buyer = caller(await login(process.env.E2E_BUYER_EMAIL, process.env.E2E_BUYER_PASSWORD))

  const supplier = ((await call('GET', '/masters/suppliers?limit=20')).body.data as any[]).find((s) => !/vhagar/i.test(s.name) && s.gstin)
  const item = ((await call('GET', '/masters/items?limit=100&active=true')).body.data as any[]).find((i) => !/vhagar|zztest/i.test(i.name) && ['RAW_MATERIAL', 'TRIM', 'PACKING_MATERIAL'].includes(i.type))
  const store = ((await call('GET', '/masters/warehouses?limit=50')).body.data as any[]).find((w) => w.purpose !== 'SAMPLING')
  const line = { itemId: item.id, qty: 10, unitRate: 100, gstRate: 12 }
  const made: string[] = []
  const newPo = async (isService = false) => {
    const r = await call('POST', '/purchase/orders', { supplierId: supplier.id, isService, lines: [line] })
    if (r.body?.data?.id) made.push(r.body.data.id)
    return r.body?.data as { id: string; poNumber: string }
  }
  const series = async () => ((await call('GET', '/settings/number-series')).body.data as any[]).find((s) => s.docType === 'PO' && s.isActive)
  const original = await prisma.numberSeries.findUniqueOrThrow({ where: { id: (await series()).id } })

  try {
    // ── One series for purchase and service orders ─────────────────────
    // From a clean point: older free numbers on this test copy would
    // (rightly) be filled first. Put back at the end.
    await prisma.numberSeries.update({ where: { id: original.id }, data: { reuseFloor: original.lastNumber } })
    const s1 = await newPo(true), s2 = await newPo(true), p3 = await newPo(false), p4 = await newPo(false), s5 = await newPo(true)
    const seq = [s1, s2, p3, p4, s5].map((x) => tail(x.poNumber))
    check(`1. service, service, purchase, purchase, service orders number one after another (${[s1, s2, p3, p4, s5].map((x) => x.poNumber).join(', ')})`,
      seq.every((n, i) => i === 0 || n === seq[i - 1] + 1), seq)

    // ── Scenario A: an unsent draft deleted from the middle ────────────
    const delA = await call('DELETE', `/purchase/orders/${s2.id}`)
    const preview = (await series())?.nextNumber
    const n6 = await newPo(false)
    check(`2. an unsent draft deleted from the middle (${s2.poNumber}) is the next order's number`, delA.status < 300 && n6.poNumber === s2.poNumber, { del: delA.body?.message, got: n6.poNumber })
    check('3. Settings and the order form preview that same number before it is taken', preview === s2.poNumber, { preview })

    // ── Scenario B: a sent order is never deleted, never reused ────────
    await call('PATCH', `/purchase/orders/${p3.id}/send`, {})
    const delB = await call('DELETE', `/purchase/orders/${p3.id}`)
    check(`4. a sent order (${p3.poNumber}) cannot be deleted — it is cancelled instead`, delB.status === 409 && delB.body?.code === 'PO_SENT', delB.body)
    const cancelled = await call('PATCH', `/purchase/orders/${p3.id}/cancel`, {})
    const n7 = await newPo(false)
    check(`5. cancelled, its number stays used: the next order is ${n7.poNumber}, not ${p3.poNumber}`, cancelled.status < 300 && n7.poNumber !== p3.poNumber && tail(n7.poNumber) > tail(s5.poNumber), { got: n7.poNumber })

    await call('PATCH', `/purchase/orders/${p4.id}/send`, {})
    await call('PATCH', `/purchase/orders/${p4.id}/reopen`, {})
    const delC = await call('DELETE', `/purchase/orders/${p4.id}`)
    check(`6. sent and put back to Draft (${p4.poNumber}), it still cannot be deleted`, delC.status === 409 && delC.body?.code === 'PO_SENT', delC.body)

    // ── A number never used (the "0001 missing" case) ──────────────────
    await prisma.numberSeries.update({ where: { id: original.id }, data: { lastNumber: { increment: 1 } } })
    const skipped = tail(n7.poNumber) + 1
    const n8 = await newPo(true)
    const n9 = await newPo(false)
    check(`7. a number never used below the counter is filled by the next order (${n8.poNumber}), then the count goes on (${n9.poNumber})`,
      tail(n8.poNumber) === skipped && tail(n9.poNumber) === skipped + 1, { skipped, n8: n8.poNumber, n9: n9.poNumber })

    // ── At the same moment ─────────────────────────────────────────────
    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => newPo(i % 2 === 0)))
    const numbers = burst.map((b) => b?.poNumber)
    check('8. six orders saved at the same moment all get different numbers', numbers.every(Boolean) && new Set(numbers).size === 6, numbers)

    // ── Restoring ──────────────────────────────────────────────────────
    const r1 = await call('POST', `/purchase/recycle-bin/${s2.id}/restore`)
    const s2After = (await call('GET', `/purchase/orders/${s2.id}`)).body?.data
    check(`9. the draft whose number was reused is restored under a fresh number (${s2After?.poNumber})`, r1.status < 300 && s2After?.poNumber !== s2.poNumber, { status: r1.status, got: s2After?.poNumber })
    const lone = await newPo(false)
    await call('DELETE', `/purchase/orders/${lone.id}`)
    const r2 = await call('POST', `/purchase/recycle-bin/${lone.id}/restore`)
    const loneAfter = (await call('GET', `/purchase/orders/${lone.id}`)).body?.data
    check(`10. restored while its number is still free, a draft gets it back (${lone.poNumber})`, r2.status < 300 && loneAfter?.poNumber === lone.poNumber, { got: loneAfter?.poNumber })

    // ── Destroying from the bin ────────────────────────────────────────
    const old = await newPo(false)
    await call('DELETE', `/purchase/orders/${old.id}`)
    // An order binned before the rule, after it had been sent.
    await prisma.purchaseOrder.update({ where: { id: old.id }, data: { sentAt: new Date() } })
    const bin = (await call('GET', '/purchase/recycle-bin')).body?.data as any[]
    const destroy = await call('DELETE', `/purchase/recycle-bin/${old.id}`)
    check('11. one binned after being sent cannot be destroyed (restore and cancel it), and the bin says so', destroy.status === 409 && destroy.body?.code === 'PO_SENT' && bin?.find((b) => b.id === old.id)?.wasSent === true, destroy.body)

    // ── Running series in Settings ─────────────────────────────────────
    const now = await series()
    check(`12. Settings calls it the purchase & service order series and shows its last number (${now?.lastUsedNumber})`, /service/i.test(now?.label ?? '') && !!now?.lastUsedNumber, now)
    const low = await call('PATCH', `/settings/number-series/${now.id}/next`, { nextNumber: 1 })
    check('13. the next number cannot be set to one already in use', low.status === 409 && low.body?.code === 'NUMBER_IN_USE', low.body)
    const ahead = now.lastNumber + 5
    const up = await call('PATCH', `/settings/number-series/${now.id}/next`, { nextNumber: ahead })
    const e = await newPo(false)
    check(`14. set ahead, the next order takes that number (${e.poNumber}) — what it skipped stays skipped`, up.status < 300 && tail(e.poNumber) === ahead, { status: up.status, next: up.body?.data?.nextNumber, got: e.poNumber })
    const denied = await buyer('PATCH', `/settings/number-series/${now.id}/next`, { nextNumber: ahead + 9 })
    check('15. a user who may not edit settings cannot change it', denied.status === 403, denied.status)

    // ── Other documents keep the newest-only rule ──────────────────────
    const g = await newPo(false)
    await call('PATCH', `/purchase/orders/${g.id}/send`, {})
    const poLine = (await call('GET', `/purchase/orders/${g.id}`)).body?.data?.lines?.[0]
    const grn = async () => (await call('POST', '/purchase/grn', { poId: g.id, challanNo: `ZZ-${Date.now()}`, challanDate: new Date().toISOString(), lines: [{ poLineId: poLine.id, warehouseId: store.id, receivedQty: 1 }] })).body?.data
    const g1 = await grn()
    const del = await call('DELETE', `/purchase/grn/${g1?.id}`, { reason: 'test' })
    const g2 = await grn()
    check(`16. the newest goods receipt deleted (${g1?.grnNumber}), the next one takes its number`, del.status < 300 && g2?.grnNumber === g1?.grnNumber, { del: del.status, g1: g1?.grnNumber, g2: g2?.grnNumber })
    if (g2?.id) await call('DELETE', `/purchase/grn/${g2.id}`, { reason: 'test' })
  } finally {
    // Test orders go for good, sent or not, and the series is put back.
    await prisma.purchaseOrderLine.deleteMany({ where: { poId: { in: made } } })
    await prisma.purchaseOrderCharge.deleteMany({ where: { poId: { in: made } } }).catch(() => undefined)
    for (const id of made) await prisma.purchaseOrder.delete({ where: { id } }).catch(() => undefined)
    await prisma.numberSeries.update({ where: { id: original.id }, data: { lastNumber: original.lastNumber, reuseFloor: original.reuseFloor } })
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}
main().finally(() => prisma.$disconnect())
