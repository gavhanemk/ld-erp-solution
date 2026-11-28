/**
 * Two-step (in-transit) stock transfers, alongside direct ones:
 *
 *   - a direct transfer still goes straight there (mode DIRECT, RECEIVED);
 *   - sent in transit, the goods wait in the transit store, still ours, at
 *     what they left at, and are not free stock there;
 *   - received in part, with damage (held as rejected at the other end), the
 *     rest later; what did not arrive is sent back or written off as lost;
 *   - two consignments of the same cloth at different rates never blend on
 *     the road: each leaves the transit store at its own rate;
 *   - a late opening rate reprices goods on the road and what arrived;
 *   - cancelled while nothing arrived, the goods go back; after, they cannot;
 *   - the transit store moves only on its transfers: no direct transfer,
 *     count or stock-in there; a repeated request receives once; quantities
 *     follow the unit;
 *   - stickers go on the road with the goods and on to where they arrive;
 *   - value is kept throughout: only what was written off leaves the books,
 *     and the Stock Reconciliation report still agrees.
 *
 * Makes its own ZZTEST stores and items each run (never VHAGAR's), and keeps
 * one "ZZTEST Goods in Transit" store for the demo. Runs against a running
 * API and the demo database (lderp_demo) only. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-transit-transfers.ts
 */
import { randomUUID } from 'node:crypto'
import { prisma } from '../packages/database/src/index'
import { balanceOf } from '../apps/api/src/services/stock.service'

const API = (process.env.E2E_API || 'http://localhost:5105/api').replace(/\/+$/, '')
let pass = 0
let fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 600)}` : ''}`)
}
type Res = { status: number; body: any }
let token = ''
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let j: any = null
  try {
    j = await r.json()
  } catch {}
  return { status: r.status, body: j }
}
const okay = (r: Res) => r.status >= 200 && r.status < 300
const r2 = (n: number) => Math.round(n * 100) / 100
const r3 = (n: number) => Math.round(n * 1000) / 1000
const said = (r: Res) => [r.status, r.body?.code, r.body?.message]

/** One balance: quantity and value. */
async function bal(itemId: string, warehouseId: string, grade = 'A') {
  const b = await balanceOf(prisma, { itemId, warehouseId, grade })
  return { qty: b.qty, value: b.value }
}
/** Every store's value of an item, every grade together. */
async function valueEverywhere(itemId: string) {
  const [row] = await prisma.$queryRaw<Array<{ qty: number; value: number }>>`
    SELECT COALESCE(SUM("inQty" - "outQty"), 0)::float8 AS qty,
           COALESCE(SUM(("inQty" - "outQty") * COALESCE("unitRate", 0)), 0)::float8 AS value
    FROM ld_erp.stock_ledger WHERE "itemId" = ${itemId}`
  return { qty: r3(row.qty), value: r2(row.value) }
}
/**
 * The labels window after a transfer, as the store does it: the packages the
 * screen suggests (oldest first) taken for what went. Returns what it took.
 */
async function labelsWindow(id: string) {
  const plan = await call('POST', '/packages/outward/plan', { type: 'TRANSFER', id })
  const takes = (plan.body?.data?.spots ?? []).flatMap((s: any) => s.packages.filter((p: any) => p.take > 0).map((p: any) => ({ packageId: p.id, qty: p.take })))
  if (!takes.length) return { ok: okay(plan), takes }
  const apply = await call('POST', '/packages/outward/apply', { type: 'TRANSFER', id, takes })
  return { ok: okay(plan) && okay(apply), takes, said: said(apply) }
}
/** An item's stickers in stock, store by store and grade by grade. */
async function stickersOf(itemId: string) {
  const rows = await prisma.stockPackage.findMany({ where: { itemId, status: 'IN_STOCK' }, select: { warehouseId: true, qty: true, grade: true } })
  const at = (warehouseId: string, grade?: string) => r3(rows.filter((p) => p.warehouseId === warehouseId && (!grade || p.grade === grade)).reduce((s, p) => s + Number(p.qty), 0))
  return { at }
}
const kpi = (r: Res, label: string) => (r.body?.data?.analysis?.kpis ?? []).find((k: any) => k.label === label)?.value

async function main() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) {
    console.error('Set E2E_EMAIL and E2E_PASSWORD.')
    process.exitCode = 2
    return
  }
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  if (db !== 'lderp_demo') {
    console.error('Refusing to run: not lderp_demo.')
    process.exitCode = 2
    return
  }
  token = (
    await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())
  ).accessToken
  if (!token) throw new Error('login failed')
  const stamp = Date.now().toString(36).slice(-5).toUpperCase()
  const made: string[] = []

  const reconBefore = await call('GET', '/reports/stock-reconciliation/run')
  const findingsBefore = Number(kpi(reconBefore, 'Findings') ?? -1)

  // ── Stores: three of ours, and the one transit store ──
  const store = async (name: string, kind = 'GENERAL') => {
    const r = await call('POST', '/masters/warehouses', { name, kind, isActive: true })
    if (!okay(r)) throw new Error(`store ${name}: ${JSON.stringify(said(r))}`)
    return r.body.data as { id: string; name: string }
  }
  const A = await store(`ZZTEST TR Store A ${stamp}`)
  const B = await store(`ZZTEST TR Store B ${stamp}`)
  const C = await store(`ZZTEST TR Store C ${stamp}`)
  made.push(A.id, B.id, C.id)
  // Exactly one active transit store, as a mill would have: kept for the demo.
  const transits = await prisma.warehouse.findMany({ where: { kind: 'TRANSIT', isActive: true }, select: { id: true, name: true } })
  let T = transits.find((w) => w.name === 'ZZTEST Goods in Transit') ?? null
  for (const w of transits) if (w.id !== T?.id) await call('PATCH', `/masters/warehouses/${w.id}`, { isActive: false })
  if (!T) T = await store('ZZTEST Goods in Transit', 'TRANSIT')

  // ── Items: cloth in metres, cartons in whole boxes, cloth whose opening rate is pending ──
  const units = await prisma.uOM.findMany({ select: { id: true, symbol: true } })
  const unit = (s: string) => units.find((u) => u.symbol === s)!.id
  const cat = await prisma.item.findFirstOrThrow({ where: { name: { startsWith: 'ZZTEST' }, type: 'RAW_MATERIAL', isActive: true }, select: { categoryId: true } })
  const item = (code: string, name: string, uom: string) =>
    prisma.item.create({ data: { code, name, type: 'RAW_MATERIAL', categoryId: cat.categoryId, uomId: unit(uom), isActive: true }, select: { id: true, code: true, name: true } })
  const X = await item(`ZZTRX${stamp}`, `ZZTEST TR cloth ${stamp}`, 'mtr')
  const Y = await item(`ZZTRY${stamp}`, `ZZTEST TR carton ${stamp}`, 'box')
  const Z = await item(`ZZTRZ${stamp}`, `ZZTEST TR cloth unpriced ${stamp}`, 'mtr')

  // ── Opening stock: X at ₹100 in A and ₹120 in C, Y at ₹40 in A ──
  const open1 = await call('POST', '/inventory/opening', { warehouseId: A.id, lines: [{ itemId: X.id, qty: 50, unitRate: 100 }, { itemId: Y.id, qty: 10, unitRate: 40 }] })
  const open2 = await call('POST', '/inventory/opening', { warehouseId: C.id, lines: [{ itemId: X.id, qty: 30, unitRate: 120 }] })
  check('opening stock in: X 50 m at ₹100 in A, 30 m at ₹120 in C; Y 10 boxes at ₹40 in A', okay(open1) && okay(open2), [said(open1), said(open2)])
  // Opening stock comes with its stickers: they are what travels.
  const s0 = await stickersOf(X.id)
  check('the opening stock has its stickers: 50 m of X in A, 30 m in C', s0.at(A.id) === 50 && s0.at(C.id) === 30, [s0.at(A.id), s0.at(C.id)])
  const startX = await valueEverywhere(X.id)

  // ── 1. A direct transfer still goes straight there ──
  const direct = await call('POST', '/inventory/transfers', { requestId: randomUUID(), fromWarehouseId: A.id, toWarehouseId: B.id, lines: [{ itemId: Y.id, qty: 2 }] })
  check(
    'a direct transfer goes straight there: DIRECT, RECEIVED, in B at once',
    okay(direct) && direct.body?.data?.mode === 'DIRECT' && direct.body?.data?.status === 'RECEIVED' && (await bal(Y.id, B.id)).qty === 2,
    said(direct),
  )
  const lwDirect = await labelsWindow(direct.body?.data?.id)
  check('its labels window moves the stickers straight to B, as before', lwDirect.ok, lwDirect)

  // ── 2. Guards on the transit store ──
  const intoTransit = await call('POST', '/inventory/transfers', { fromWarehouseId: A.id, toWarehouseId: T.id, lines: [{ itemId: Y.id, qty: 1 }] })
  check('a direct transfer into the transit store is refused', intoTransit.status === 400 && intoTransit.body?.code === 'TRANSIT_STORE', said(intoTransit))
  const countThere = await call('POST', '/inventory/adjustments', { warehouseId: T.id, reason: 'ZZTEST count in transit', lines: [{ itemId: Y.id, countedQty: 1 }] })
  check('a stock count in the transit store is refused when saved', countThere.status === 400 && countThere.body?.code === 'TRANSIT_STORE', said(countThere))
  const stockInThere = await call('POST', '/inventory/stock-in', { warehouseId: T.id, source: 'FOUND', lines: [{ itemId: Y.id, qty: 1, unitRate: 40 }] })
  check('a stock-in to the transit store is refused when saved', stockInThere.status === 400 && stockInThere.body?.code === 'TRANSIT_STORE', said(stockInThere))

  // ── 3. Sent in transit: T1, A → B, 30 m of X and 5 boxes of Y ──
  const aBefore = await bal(X.id, A.id)
  const send1Id = randomUUID()
  const t1r = await call('POST', '/inventory/transfers', {
    requestId: send1Id,
    fromWarehouseId: A.id,
    toWarehouseId: B.id,
    mode: 'IN_TRANSIT',
    notes: 'ZZTEST on the road',
    lines: [{ itemId: X.id, qty: 30 }, { itemId: Y.id, qty: 5 }],
  })
  const t1 = t1r.body?.data
  const lineOf = (t: any, itemId: string) => t?.lines?.find((l: any) => l.item?.id === itemId || l.itemId === itemId)
  check('sent in transit: DISPATCHED, through the transit store', okay(t1r) && t1?.mode === 'IN_TRANSIT' && t1?.status === 'DISPATCHED' && t1?.transitWarehouse?.id === T.id, said(t1r))
  const inRoadX = await bal(X.id, T.id)
  check('A is down by what went; the transit store holds it at A’s rate; B has none of it yet', (await bal(X.id, A.id)).qty === r3(aBefore.qty - 30) && inRoadX.qty === 30 && inRoadX.value === 3000 && (await bal(X.id, B.id)).qty === 0, [await bal(X.id, A.id), inRoadX])
  check('the line remembers the rate it went on the road at', Number(lineOf(t1, X.id)?.unitRate) === 100, lineOf(t1, X.id))
  const again = await call('POST', '/inventory/transfers', { requestId: send1Id, fromWarehouseId: A.id, toWarehouseId: B.id, mode: 'IN_TRANSIT', lines: [{ itemId: X.id, qty: 30 }, { itemId: Y.id, qty: 5 }] })
  check('the same send again sends nothing more', okay(again) && again.body?.repeat === true && (await bal(X.id, T.id)).qty === 30, said(again))

  // Goods on the road are not free stock.
  const transitHas = await call('GET', `/inventory/stock?warehouseId=${T.id}`)
  const roadRow = (transitHas.body?.data ?? []).find((r: any) => r.itemId === X.id)
  check('on the road, it is stock but not free', !!roadRow && Number(roadRow.qty) === 30 && Number(roadRow.free ?? 0) === 0, roadRow ?? said(transitHas))

  // Its stickers go on the road with it: the labels window after the send.
  const lw1 = await labelsWindow(t1.id)
  const s1 = await stickersOf(X.id)
  check('the labels window sends 30 m of stickers into the transit store, 20 m stay in A', lw1.ok && s1.at(T.id) === 30 && s1.at(A.id) === 20, [lw1, s1.at(T.id), s1.at(A.id)])

  // ── 4. A second consignment of the same cloth at another rate: T2, C → B, 10 m at ₹120 ──
  const t2r = await call('POST', '/inventory/transfers', { requestId: randomUUID(), fromWarehouseId: C.id, toWarehouseId: B.id, mode: 'IN_TRANSIT', lines: [{ itemId: X.id, qty: 10 }] })
  const t2 = t2r.body?.data
  const road2 = await bal(X.id, T.id)
  check('two consignments on the road: 30 m at ₹100 and 10 m at ₹120, ₹4,200 in all', okay(t2r) && road2.qty === 40 && road2.value === 4200, [said(t2r), road2])
  const lw2 = await labelsWindow(t2.id)
  check('T2’s stickers go on the road too', lw2.ok && (await stickersOf(X.id)).at(T.id) === 40, lw2)

  // ── 5. Refusals on receiving ──
  const xLine = lineOf(t1, X.id)
  const yLine = lineOf(t1, Y.id)
  const tooMuch = await call('POST', `/inventory/transfers/${t1.id}/receive`, { lines: [{ lineId: xLine.id, qty: 31 }] })
  check('more than is on the way cannot arrive', tooMuch.status === 400 && tooMuch.body?.code === 'MORE_THAN_ON_THE_WAY', said(tooMuch))
  const halfBox = await call('POST', `/inventory/transfers/${t1.id}/receive`, { lines: [{ lineId: yLine.id, qty: 2.5 }] })
  check('half a box cannot arrive', halfBox.status === 400 && halfBox.body?.code === 'QTY_NOT_IN_UNIT', said(halfBox))
  const nothing = await call('POST', `/inventory/transfers/${t1.id}/receive`, { lines: [{ lineId: yLine.id, qty: 0 }] })
  check('a receipt with nothing on it is refused', nothing.status === 400 && nothing.body?.code === 'NOTHING_ENTERED', said(nothing))
  const directReceive = await call('POST', `/inventory/transfers/${direct.body?.data?.id}/receive`, { lines: [{ lineId: direct.body?.data?.lines?.[0]?.id, qty: 1 }] })
  check('a direct transfer has nothing on the road to receive', directReceive.status === 400 && directReceive.body?.code === 'NOT_IN_TRANSIT', said(directReceive))

  // ── 6. Part received, some damaged: X 12 good + 3 damaged, Y all 5 ──
  const bVal = (await bal(X.id, B.id)).value
  const rec1Id = randomUUID()
  const rec1 = await call('POST', `/inventory/transfers/${t1.id}/receive`, {
    requestId: rec1Id,
    notes: 'ZZTEST two rolls wet',
    lines: [{ lineId: xLine.id, qty: 12, damagedQty: 3 }, { lineId: yLine.id, qty: 5 }],
  })
  const afterRec1 = rec1.body?.data
  check('part received: PARTLY_RECEIVED, 15 m still on the way', okay(rec1) && afterRec1?.status === 'PARTLY_RECEIVED' && /15 m still on the way|still on the way/.test(rec1.body?.message ?? ''), said(rec1))
  const bGood = await bal(X.id, B.id)
  const bHeld = await bal(X.id, B.id, 'R')
  check('B has 12 m good and 3 m held as rejected, both at ₹100', bGood.qty === 12 && r2(bGood.value - bVal) === 1200 && bHeld.qty === 3 && bHeld.value === 300, [bGood, bHeld])
  check('Y arrived whole: 2 boxes direct + 5 on the road', (await bal(Y.id, B.id)).qty === 7, await bal(Y.id, B.id))
  const rec1Again = await call('POST', `/inventory/transfers/${t1.id}/receive`, { requestId: rec1Id, lines: [{ lineId: xLine.id, qty: 12, damagedQty: 3 }, { lineId: yLine.id, qty: 5 }] })
  check('the same receipt again receives nothing more', okay(rec1Again) && rec1Again.body?.repeat === true && (await bal(X.id, B.id)).qty === 12, said(rec1Again))
  const road3 = await bal(X.id, T.id)
  check('on the road now: 15 m of T1 at ₹100 and 10 m of T2 at ₹120 — ₹2,700, not blended', road3.qty === 25 && road3.value === 2700, road3)

  // Stickers moved on with what arrived: 15 m (12 good + 3 damaged); T1's 15 m and T2's 10 m still on the road.
  const s2 = await stickersOf(X.id)
  check(
    'stickers went on with the goods: 15 m at B (3 m of it held as R), 25 m still on the road',
    s2.at(B.id) === 15 && s2.at(B.id, 'R') === 3 && s2.at(T.id) === 25,
    [s2.at(B.id), s2.at(B.id, 'R'), s2.at(T.id)],
  )

  // ── 7. T2 arrives whole: it leaves the transit store at its own ₹120 ──
  const t2Line = t2.lines[0]
  const bBefore2 = await bal(X.id, B.id)
  const rec2 = await call('POST', `/inventory/transfers/${t2.id}/receive`, { requestId: randomUUID(), lines: [{ lineId: t2Line.id, qty: 10 }] })
  const bAfter2 = await bal(X.id, B.id)
  check('T2 received in full: RECEIVED', okay(rec2) && rec2.body?.data?.status === 'RECEIVED', said(rec2))
  check('T2 arrived at its own ₹120: B up by ₹1,200; the road keeps T1’s 15 m at ₹1,500', r2(bAfter2.value - bBefore2.value) === 1200 && (await bal(X.id, T.id)).value === 1500, [bBefore2, bAfter2, await bal(X.id, T.id)])

  // ── 8. What did not arrive of T1: 8 m sent back, 7 m written off ──
  const cancelLate = await call('PATCH', `/inventory/transfers/${t1.id}/cancel`, { reason: 'ZZTEST cancel after a receipt' })
  check('cannot cancel once part has arrived', cancelLate.status === 409 && cancelLate.body?.code === 'PART_RECEIVED', said(cancelLate))
  const aBeforeBack = await bal(X.id, A.id)
  const back = await call('POST', `/inventory/transfers/${t1.id}/send-back`, { requestId: randomUUID(), notes: 'ZZTEST did not fit', lines: [{ lineId: xLine.id, qty: 8 }] })
  const aAfterBack = await bal(X.id, A.id)
  check('8 m sent back to A at ₹100', okay(back) && r3(aAfterBack.qty - aBeforeBack.qty) === 8 && r2(aAfterBack.value - aBeforeBack.value) === 800, [said(back), aBeforeBack, aAfterBack])
  const noReason = await call('POST', `/inventory/transfers/${t1.id}/write-off`, { reason: 'lost', lines: [{ lineId: xLine.id, qty: 7 }] })
  check('a write-off needs a real reason', noReason.status === 400, said(noReason))
  const lost = await call('POST', `/inventory/transfers/${t1.id}/write-off`, { requestId: randomUUID(), reason: 'ZZTEST fell off the vehicle', lines: [{ lineId: xLine.id, qty: 7 }] })
  const t1Closed = lost.body?.data
  check('7 m written off, worth ₹700: T1 closes with differences (DISCREPANCY)', okay(lost) && t1Closed?.status === 'DISCREPANCY' && /₹700/.test(lost.body?.message ?? ''), said(lost))
  const xl = lineOf(t1Closed, X.id)
  check('T1’s cloth line: 30 sent = 12 arrived + 3 damaged + 8 back + 7 lost', Number(xl?.qty) === 30 && Number(xl?.receivedQty) === 12 && Number(xl?.damagedQty) === 3 && Number(xl?.returnedQty) === 8 && Number(xl?.lostQty) === 7, xl)
  const roadEmpty = await bal(X.id, T.id)
  check('nothing of X on the road any more, and no value left there', roadEmpty.qty === 0 && roadEmpty.value === 0, roadEmpty)
  const after = await call('POST', `/inventory/transfers/${t1.id}/receive`, { lines: [{ lineId: xLine.id, qty: 1 }] })
  check('a closed transfer receives nothing more', after.status === 400 && after.body?.code === 'TRANSFER_CLOSED', said(after))
  const s3 = await stickersOf(X.id)
  check('no sticker left on the road: the 8 m sent back is labelled in A again, the lost 7 m taken down', s3.at(T.id) === 0 && s3.at(A.id) === 28 && s3.at(B.id) === 25, [s3.at(T.id), s3.at(A.id), s3.at(B.id)])

  // ── 9. Cancelled while nothing arrived: T3, A → B, 5 m ──
  const t3r = await call('POST', '/inventory/transfers', { requestId: randomUUID(), fromWarehouseId: A.id, toWarehouseId: B.id, mode: 'IN_TRANSIT', lines: [{ itemId: X.id, qty: 5 }] })
  const lw3 = await labelsWindow(t3r.body?.data?.id)
  check('T3’s 5 m of stickers go on the road', lw3.ok && (await stickersOf(X.id)).at(T.id) === 5, lw3)
  const aBefore3 = await bal(X.id, A.id)
  const cancel3 = await call('PATCH', `/inventory/transfers/${t3r.body?.data?.id}/cancel`, { reason: 'ZZTEST wrong store' })
  const aAfter3 = await bal(X.id, A.id)
  check('cancelled before anything arrived: CANCELLED, the 5 m back in A at what it left at', okay(t3r) && okay(cancel3) && cancel3.body?.data?.status === 'CANCELLED' && r3(aAfter3.qty - aBefore3.qty) === 5 && (await bal(X.id, T.id)).qty === 0, [said(t3r), said(cancel3), aBefore3, aAfter3])
  check('cancelled, its stickers come back to A with the goods', (await stickersOf(X.id)).at(T.id) === 0 && (await stickersOf(X.id)).at(A.id) === 28, (await stickersOf(X.id)).at(A.id))
  const receiveCancelled = await call('POST', `/inventory/transfers/${t3r.body?.data?.id}/receive`, { lines: [{ lineId: t3r.body?.data?.lines?.[0]?.id, qty: 1 }] })
  check('a cancelled transfer receives nothing', receiveCancelled.status === 400 && receiveCancelled.body?.code === 'ALREADY_CANCELLED', said(receiveCancelled))

  // ── 9b. Stickers left behind: a step waits for the labels window ──
  const t5r = await call('POST', '/inventory/transfers', { requestId: randomUUID(), fromWarehouseId: A.id, toWarehouseId: B.id, mode: 'IN_TRANSIT', lines: [{ itemId: X.id, qty: 2 }] })
  const t5 = t5r.body?.data
  const early = await call('POST', `/inventory/transfers/${t5?.id}/receive`, { requestId: randomUUID(), lines: [{ lineId: t5?.lines?.[0]?.id, qty: 2 }] })
  check('received before its stickers went on the road: refused, and says to open its labels window', early.status === 409 && early.body?.code === 'STICKERS_NOT_ON_THE_ROAD', said(early))
  const lw5 = await labelsWindow(t5?.id)
  const late = await call('POST', `/inventory/transfers/${t5?.id}/receive`, { requestId: randomUUID(), lines: [{ lineId: t5?.lines?.[0]?.id, qty: 2 }] })
  check('after the labels window it is received, stickers and all', lw5.ok && okay(late) && late.body?.data?.status === 'RECEIVED' && (await stickersOf(X.id)).at(T.id) === 0, [lw5, said(late)])
  const after5 = await call('POST', '/packages/outward/plan', { type: 'TRANSFER', id: t1.id })
  check('once anything of it was received, its labels window has nothing left to do', okay(after5) && (after5.body?.data?.lines ?? []).length === 0, after5.body?.data?.lines)

  // ── 10. Value kept throughout: only the 7 m written off left the books ──
  const endX = await valueEverywhere(X.id)
  check('X across every store: 7 m and ₹700 less than at the start, nothing else made or lost', r3(startX.qty - endX.qty) === 7 && r2(startX.value - endX.value) === 700, [startX, endX])

  // ── 11. A late opening rate reprices goods on the road and what arrived ──
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
  const entry = await call('POST', '/inventory/opening-stock/entry', { confirm: true, kind: 'RM', requestKey: `zztr-${stamp}-${randomUUID().slice(0, 8)}`, notes: 'ZZTEST unpriced', lines: [{ date: today, location: A.name, code: Z.code, qty: 20 }] })
  const zLine = await prisma.openingStockLine.findFirst({ where: { itemId: Z.id }, select: { id: true, valuationPending: true } })
  check('opening stock without a rate: valuation pending', okay(entry) && !!zLine?.valuationPending, [said(entry), zLine])
  const t4r = await call('POST', '/inventory/transfers', { requestId: randomUUID(), fromWarehouseId: A.id, toWarehouseId: B.id, mode: 'IN_TRANSIT', lines: [{ itemId: Z.id, qty: 10 }] })
  const t4 = t4r.body?.data
  const lw4 = await labelsWindow(t4?.id)
  check('T4’s labels window done', lw4.ok, lw4)
  const rec4 = await call('POST', `/inventory/transfers/${t4?.id}/receive`, { requestId: randomUUID(), lines: [{ lineId: t4?.lines?.[0]?.id, qty: 4 }] })
  check('unpriced cloth sent in transit and 4 m received, all at nought', okay(t4r) && okay(rec4) && (await bal(Z.id, T.id)).value === 0 && (await bal(Z.id, B.id)).value === 0, [said(t4r), said(rec4)])
  const rate = zLine ? await call('POST', `/inventory/opening-stock/lines/${zLine.id}/rate`, { rate: 50 }) : { status: 0, body: null }
  const zA = await bal(Z.id, A.id)
  const zT = await bal(Z.id, T.id)
  const zB = await bal(Z.id, B.id)
  const t4Line = await prisma.stockTransferLine.findFirst({ where: { transferId: t4?.id }, select: { unitRate: true } })
  check(
    'the opening rate set later prices it all at ₹50: 10 m in A, 6 m on the road, 4 m in B, and the transfer line',
    okay(rate) && zA.value === 500 && zT.value === 300 && zB.value === 200 && Number(t4Line?.unitRate) === 50,
    [said(rate), zA, zT, zB, t4Line],
  )
  const rec4b = await call('POST', `/inventory/transfers/${t4?.id}/receive`, { requestId: randomUUID(), lines: [{ lineId: t4?.lines?.[0]?.id, qty: 6 }] })
  check('the rest arrives at the new ₹50: nothing left on the road, B holds ₹500', okay(rec4b) && (await bal(Z.id, T.id)).qty === 0 && (await bal(Z.id, T.id)).value === 0 && (await bal(Z.id, B.id)).value === 500, said(rec4b))

  // ── 12. The list, the print and the reports ──
  const openList = await call('GET', '/inventory/transfers?open=1&limit=100')
  check('"On the way only" lists open transfers and none of the closed ones', okay(openList) && !(openList.body?.data ?? []).some((t: any) => [t1.id, t2.id].includes(t.id)), said(openList))
  const print = await call('GET', `/inventory/transfers/${t1.id}/print`)
  check('the transfer note prints with its receipts', okay(print) && (print.body?.data?.transfer?.receipts ?? []).length === 3, (print.body?.data?.transfer?.receipts ?? []).map((r: any) => r.kind))
  const ledger = await prisma.stockLedger.findMany({ where: { referenceId: t1.id }, select: { referenceType: true } })
  const kinds = [...new Set(ledger.map((l) => l.referenceType))].sort()
  check('every stock row of T1 names T1, by step', JSON.stringify(kinds) === JSON.stringify(['STOCK_TRANSFER', 'STOCK_TRANSFER_LOST', 'STOCK_TRANSFER_RECEIVED', 'STOCK_TRANSFER_RETURNED']), kinds)
  const recon = await call('GET', '/reports/stock-reconciliation/run')
  check('Stock Reconciliation: no new findings, and the value still agrees with the books', okay(recon) && Number(kpi(recon, 'Findings')) <= Math.max(0, findingsBefore) && Math.abs(Number(kpi(recon, 'Not explained'))) < 1, [kpi(recon, 'Findings'), findingsBefore, kpi(recon, 'Not explained')])

  for (const id of made) await call('PATCH', `/masters/warehouses/${id}`, { isActive: false })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
