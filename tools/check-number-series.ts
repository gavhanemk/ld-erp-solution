/**
 * Purchase order numbers and deleting (the user's rules, 27 Nov 2026), and the
 * running series:
 *   - purchase orders and service purchase orders share ONE PO series, and
 *     numbers run on from the last one (PO-0005 the last, the next is 0006);
 *     gaps further down are not filled;
 *   - Delete offers two ways: to the recycle bin, where the order keeps its
 *     number reserved, or permanently, which frees it — the newest deleted for
 *     good gives its number to the next order;
 *   - only a draft never sent can be deleted; one the supplier has had (even
 *     put back to Draft, even before `sentAt` was kept) is cancelled instead;
 *   - orders saved at the same moment never share a number;
 *   - a bin row re-labelled under the earlier rule still holds its number;
 *   - Settings shows the last used and the true next number; Set moves it,
 *     never onto a number an order holds, and deleting for good never steps
 *     the count back past it; only users who may edit settings can;
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
const tail = (n?: string) => Number(String(n ?? '').split('~')[0].split('-').pop())

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
  const L = original.lastNumber
  const row = (id: string) => prisma.purchaseOrder.findUnique({ where: { id } })
  const forGood = (id: string) => call('DELETE', `/purchase/orders/${id}?permanent=1`)

  try {
    // From a clean point: what this test copy already holds lower down is not
    // this check's business. Put back at the end.
    await prisma.numberSeries.update({ where: { id: original.id }, data: { reuseFloor: L } })
    const s1 = await newPo(true), s2 = await newPo(true), p3 = await newPo(false), p4 = await newPo(false), s5 = await newPo(true)
    const at = (k: number) => s1.poNumber.replace(/\d+$/, (d) => String(k).padStart(d.length, '0'))

    // ── One series, running on ─────────────────────────────────────────
    check(`1. service, service, purchase, purchase, service orders run on from the last number (${[s1, s2, p3, p4, s5].map((x) => x.poNumber).join(', ')})`,
      [s1, s2, p3, p4, s5].every((x, i) => x.poNumber === at(L + 1 + i)))

    // ── To the recycle bin: the number stays reserved ──────────────────
    const bin5 = await call('DELETE', `/purchase/orders/${s5.id}`)
    const shown6 = (await series())?.nextNumber
    const n6 = await newPo(false)
    check(`2. the newest (${s5.poNumber}) moved to the recycle bin keeps its number: the next order is ${n6.poNumber}, as Settings showed`,
      bin5.status < 300 && n6.poNumber === at(L + 6) && shown6 === at(L + 6), { bin: bin5.body?.message, shown6, got: n6.poNumber })
    const binned5 = await row(s5.id)
    check('3. in the bin it carries its number unchanged', binned5?.poNumber === s5.poNumber && !!binned5?.deletedAt, binned5?.poNumber)
    const r5 = await call('POST', `/purchase/recycle-bin/${s5.id}/restore`)
    const s5After = await row(s5.id)
    check(`4. restored, it is ${s5.poNumber} again`, r5.status < 300 && s5After?.poNumber === s5.poNumber && !s5After?.deletedAt, r5.body)

    // ── Deleted for good: the number is freed ──────────────────────────
    const del6 = await forGood(n6.id)
    const shownAfter6 = (await series())?.nextNumber
    const n7 = await newPo(true)
    check(`5. the newest (${n6.poNumber}) deleted for good gives its number to the next order — here a service order: ${n7.poNumber}`,
      del6.status < 300 && n7.poNumber === n6.poNumber && shownAfter6 === n6.poNumber, { del: del6.body?.message, shownAfter6, got: n7.poNumber })
    const left = await prisma.purchaseOrderLine.count({ where: { poId: n6.id } })
    check('6. gone for good: not in the bin, and no lines left behind', !(await row(n6.id)) && left === 0, { left })

    const del3 = await forGood(p3.id)
    const n8 = await newPo(false)
    check(`7. deleted for good from the middle (${p3.poNumber}), its number is not filled: new orders carry on (${n8.poNumber})`,
      del3.status < 300 && n8.poNumber === at(L + 7) && /carry on/.test(del3.body?.message ?? ''), { msg: del3.body?.message, got: n8.poNumber })

    await call('DELETE', `/purchase/orders/${n8.id}`)
    const des8 = await call('DELETE', `/purchase/recycle-bin/${n8.id}`)
    const n9 = await newPo(false)
    check(`8. the newest deleted for good from the recycle bin (${n8.poNumber}) gives its number to the next order (${n9.poNumber})`,
      des8.status < 300 && n9.poNumber === n8.poNumber, { msg: des8.body?.message, got: n9.poNumber })

    await forGood(n7.id) // the middle one first: a gap
    await forGood(n9.id) // then the newest, above the gap
    const n10 = await newPo(true)
    check(`9. the newest deleted for good above a gap: the count goes back to the last order still there (${s5.poNumber}), so the next is ${n10.poNumber}`,
      n10.poNumber === at(L + 6), n10.poNumber)

    // ── An order the supplier has had ──────────────────────────────────
    await call('PATCH', `/purchase/orders/${p4.id}/send`, {})
    const d1 = await call('DELETE', `/purchase/orders/${p4.id}`)
    const d2 = await forGood(p4.id)
    check(`10. a sent order (${p4.poNumber}) cannot be deleted either way — it is cancelled instead`,
      d1.status === 409 && d1.body?.code === 'PO_SENT' && d2.status === 409 && d2.body?.code === 'PO_SENT', { d1: d1.body, d2: d2.body })
    const c4 = await call('PATCH', `/purchase/orders/${p4.id}/cancel`, {})
    const p4After = await row(p4.id)
    check(`11. cancelled, it keeps its number and stays on the list (${p4.poNumber})`, c4.status < 300 && p4After?.poNumber === p4.poNumber && !p4After?.deletedAt)

    await call('PATCH', `/purchase/orders/${s2.id}/send`, {})
    await call('PATCH', `/purchase/orders/${s2.id}/reopen`, {})
    const d3 = await forGood(s2.id)
    check(`12. sent and put back to Draft (${s2.poNumber}), it still cannot be deleted`, d3.status === 409 && d3.body?.code === 'PO_SENT', d3.body)

    await prisma.purchaseOrder.update({ where: { id: s2.id }, data: { sentAt: null } }) // as if sent before the date was kept
    const d4 = await call('DELETE', `/purchase/orders/${s2.id}`)
    const listed = ((await call('GET', `/purchase/orders?service=true&q=${encodeURIComponent(s2.poNumber)}`)).body?.data as any[])?.find((x) => x.id === s2.id)
    check('13. one sent before the date was kept is known from the activity log: not deletable, and the list says so',
      d4.status === 409 && d4.body?.code === 'PO_SENT' && listed?.wasSent === true, { d4: d4.body, wasSent: listed?.wasSent })
    const draft = ((await call('GET', `/purchase/orders?service=true&q=${encodeURIComponent(s1.poNumber)}`)).body?.data as any[])?.find((x) => x.id === s1.id)
    check('14. a draft never sent is listed as one that can be deleted', draft?.wasSent === false, draft?.wasSent)

    // ── Gaps lower down stay gaps ──────────────────────────────────────
    await prisma.numberSeries.update({ where: { id: original.id }, data: { lastNumber: { increment: 1 } } })
    const n11 = await newPo(false)
    check(`15. a number never used below the last one (the "0001 missing" case) stays unused: new orders carry on (${n11.poNumber})`,
      n11.poNumber === at(L + 8), n11.poNumber)

    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => newPo(i % 2 === 0)))
    const nums = burst.map((b) => tail(b?.poNumber)).sort((a, b) => a - b)
    check('16. six orders saved at the same moment get six different numbers, one after another',
      nums.length === 6 && nums.every((n, i) => n === L + 9 + i), nums)

    // ── A bin row from the earlier rule ────────────────────────────────
    const x = await newPo(false)
    await prisma.purchaseOrder.update({ where: { id: x.id }, data: { deletedAt: new Date(), poNumber: `${x.poNumber}~released-zz` } })
    await prisma.numberSeries.update({ where: { id: original.id }, data: { lastNumber: { decrement: 1 } } })
    const shownX = (await series())?.nextNumber
    const n12 = await newPo(true)
    check(`17. a bin row re-labelled under the earlier rule still holds its number (${x.poNumber}): the next order steps over it (${n12.poNumber})`,
      n12.poNumber === at(L + 16) && shownX === at(L + 16), { shownX, got: n12.poNumber })
    const rx = await call('POST', `/purchase/recycle-bin/${x.id}/restore`)
    check(`18. restored, it is ${x.poNumber} again`, rx.status < 300 && (await row(x.id))?.poNumber === x.poNumber, rx.body)

    // ── Running series in Settings ─────────────────────────────────────
    const now = await series()
    check(`19. Settings calls it the purchase & service order series and shows its last number (${now?.lastUsedNumber})`, /service/i.test(now?.label ?? '') && !!now?.lastUsedNumber, now)
    await call('DELETE', `/purchase/orders/${n12.id}`) // the newest, to the bin
    const low = await call('PATCH', `/settings/number-series/${now.id}/next`, { nextNumber: tail(n12.poNumber) })
    check(`20. the next number cannot be set onto one an order in the bin holds (${n12.poNumber})`, low.status === 409 && low.body?.code === 'NUMBER_IN_USE', low.body)
    const ahead = tail(n12.poNumber) + 5
    const up = await call('PATCH', `/settings/number-series/${now.id}/next`, { nextNumber: ahead })
    const e = await newPo(false)
    check(`21. set ahead, the next order takes that number (${e.poNumber}) — what it skipped stays skipped`, up.status < 300 && tail(e.poNumber) === ahead, { status: up.status, got: e.poNumber })
    const de = await forGood(e.id)
    const shownE = (await series())?.nextNumber
    check(`22. that order deleted for good gives its number back, but the count never goes back past the point set (${shownE})`, de.status < 300 && shownE === e.poNumber, { de: de.body, shownE })
    const denied = await buyer('PATCH', `/settings/number-series/${now.id}/next`, { nextNumber: ahead + 9 })
    check('23. a user who may not edit settings cannot change it', denied.status === 403, denied.status)

    // ── Other documents keep the newest-only rule ──────────────────────
    const g = await newPo(false)
    await call('PATCH', `/purchase/orders/${g.id}/send`, {})
    const poLine = (await call('GET', `/purchase/orders/${g.id}`)).body?.data?.lines?.[0]
    const grn = async () => (await call('POST', '/purchase/grn', { poId: g.id, challanNo: `ZZ-${Date.now()}`, challanDate: new Date().toISOString(), lines: [{ poLineId: poLine.id, warehouseId: store.id, receivedQty: 1 }] })).body?.data
    const g1 = await grn()
    const del = await call('DELETE', `/purchase/grn/${g1?.id}`, { reason: 'test' })
    const g2 = await grn()
    check(`24. the newest goods receipt deleted (${g1?.grnNumber}), the next one takes its number`, del.status < 300 && g2?.grnNumber === g1?.grnNumber, { del: del.status, g1: g1?.grnNumber, g2: g2?.grnNumber })
    if (g2?.id) await call('DELETE', `/purchase/grn/${g2.id}`, { reason: 'test' })
  } finally {
    // Test orders go for good, sent or not, and the series is put back.
    await prisma.purchaseOrderLine.deleteMany({ where: { poId: { in: made } } })
    await prisma.purchaseOrderCharge.deleteMany({ where: { poId: { in: made } } }).catch(() => undefined)
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: made } } })
    await prisma.numberSeries.update({ where: { id: original.id }, data: { lastNumber: original.lastNumber, reuseFloor: original.reuseFloor } })
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}
main().finally(() => prisma.$disconnect())
