// Job work (our goods out to an outside unit and back), end to end, on the DEMO API (E2E_API, default 5101) and DEMO database (lderp_demo) only.
// Send out → part back → the rest back with damaged and wasted → debit note → cancels → statement.
import { API, demoDb, adminLogin, exit } from '../lib/demo.mjs'
const db = await demoDb()
const q = async (sql, p = []) => (await db.query(sql, p)).rows
const ADMIN = await adminLogin(db)
if (!ADMIN) { console.log('login failed'); process.exit(1) }
const call = async (m, p, b, tok = ADMIN) => {
  const r = await fetch(`${API}${p}`, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: b ? JSON.stringify(b) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
let pass = 0, fail = 0
const check = (id, name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${name}${extra && !ok ? `  — ${extra}` : ''}`) }
const err = (r) => `${r.status} ${r.body?.code ?? ''} ${(r.body?.message ?? '').slice(0, 220)}`
if ((await q(`SELECT current_database() d`))[0].d !== 'lderp_demo') { console.log('not the demo database'); process.exit(1) }

const JW = 'cmth8didp00heoijjlp9o8aoh' // Ambika Stitching Unit
const UNIT = 'cmth8dd4y00gvoijjanbj6sm0' // Job Work Godown, standing for the unit's floor
const FW = 'cmth8dcgm00gpoijjnarcpvj3' // Fabric Warehouse: holds the buttons
const STORE = 'cmth8dcoq00groijjrxeufsdd' // Store: holds none
const BTN = 'cmukzhhyy000dkurgxiokhtud' // BUT-001 ZZTEST Shirt Button
const A = 'cmth8dkwh00hvoijj4in66tuc' // Bengal Trend House
const FAB = 'cmukzhguv0009kurg1huthki3' // their poplin

const bal = async (wh, item = BTN, own = 'OWNED') =>
  Number((await q(`SELECT COALESCE(SUM("inQty"-"outQty"),0)::float8 b FROM stock_ledger WHERE "itemId"=$1 AND "warehouseId"=$2 AND ownership=$3`, [item, wh, own]))[0].b)
const challanRow = async (id) => (await q(`SELECT status::text s FROM job_work_challans WHERE id=$1`, [id]))[0]
const lineOf = async (challanId) => {
  const r = await call('GET', '/inventory/job-work/lines')
  return (r.body?.data?.rows ?? r.body?.data ?? []).find((l) => l.challanId === challanId)
}
const send = (o) => call('POST', '/inventory/job-work', { jobWorkerId: JW, process: 'Dyeing — test', fromWarehouseId: FW, toWarehouseId: UNIT, expectedBackOn: new Date(Date.now() + 7 * 864e5).toISOString(), lines: [{ itemId: BTN, qty: 100, ownership: 'OWNED' }], ...o })

// ── Sending out ──
const empty = await send({ fromWarehouseId: STORE, lines: [{ itemId: BTN, qty: 20, ownership: 'OWNED' }] })
check('J1', 'Sending from a store that holds none is refused (what made LBL-CARE-001 go to −2)', empty.status >= 400 && empty.status < 500, err(empty))

const fw0 = await bal(FW), unit0 = await bal(UNIT)
const s = await send({})
const ch = s.body?.data
check('J2', 'Sent out: a JW challan, status Out', s.status === 201 && /^JW-/.test(ch?.challanNumber ?? '') && (await challanRow(ch.id))?.s === 'SENT', err(s))
check('J3', "The 100 left Fabric Warehouse and sit in the unit's store, still ours", (await bal(FW)) === fw0 - 100 && (await bal(UNIT)) === unit0 + 100)
const cl = ch.lines[0]

// ── Part back ──
const RUN_NO = String(Date.now() % 1000000)
const back = (lines) => call('POST', `/inventory/job-work/${ch.id}/returns`, { theirChallanNo: `AMB-${RUN_NO}`, lines })
const r1 = await back([{ challanLineId: cl.id, consumedQty: 40, itemId: BTN, receivedQty: 40, warehouseId: FW }])
check('J4', '40 back: the challan is Part back, the 40 are in Fabric Warehouse again', r1.status === 201 && (await challanRow(ch.id))?.s === 'PARTLY_BACK' && (await bal(FW)) === fw0 - 60, err(r1))
const over = await back([{ challanLineId: cl.id, consumedQty: 70, itemId: BTN, receivedQty: 70, warehouseId: FW }])
check('J5', 'Settling 70 when 60 are out is refused', over.status >= 400 && over.status < 500, err(over))
const odd = await back([{ challanLineId: cl.id, consumedQty: 30, itemId: BTN, receivedQty: 25, warehouseId: FW }])
check('J6', 'Good + damaged + wasted must add up: 25 of 30 with nothing said about 5 is refused', odd.status >= 400 && odd.status < 500, err(odd))

// ── The rest back: 50 good, 6 damaged, 4 wasted ──
const r2 = await back([{ challanLineId: cl.id, consumedQty: 60, itemId: BTN, receivedQty: 50, damagedQty: 6, wastedQty: 4, warehouseId: FW }])
check('J7', 'The rest settled (50 good, 6 damaged, 4 wasted): All back', r2.status === 201 && (await challanRow(ch.id))?.s === 'CLOSED', err(r2))
check('J8', "Only the 90 good are back in stock; nothing is left in the unit's store", (await bal(FW)) === fw0 - 10 && (await bal(UNIT)) === unit0)
const ln = await lineOf(ch.id)
check('J9', 'The list shows sent 100, wasted 4, damaged 6, still out 0', ln?.sentQty === 100 && ln?.wastedQty === 4 && ln?.damagedQty === 6 && ln?.stillOutQty === 0, JSON.stringify(ln && { s: ln.sentQty, w: ln.wastedQty, d: ln.damagedQty, o: ln.stillOutQty }))

// ── Cancels and the debit note ──
const cx = await call('PATCH', `/inventory/job-work/${ch.id}/cancel`, { reason: 'Testing a cancel after goods came back' })
check('J10', 'The challan cannot be cancelled once goods came back', cx.status === 409 || cx.status === 400, err(cx))
const rets = await q(`SELECT id, "returnNumber" FROM job_work_returns WHERE "challanId"=$1 ORDER BY "createdAt"`, [ch.id])
const dn = await call('POST', `/inventory/job-work/returns/${rets[1].id}/debit-note`, { gstRate: 5, notes: 'Six buttons cracked at the unit' })
check('J11', 'The 6 damaged are charged to the unit on a debit note', dn.status === 201, err(dn))
check('J12', 'Nothing damaged is left uncharged', ((await lineOf(ch.id))?.damagedUncharged ?? 0) === 0)
const c2 = await call('PATCH', `/inventory/job-work/returns/${rets[1].id}/cancel`, { reason: 'Testing cancel under a debit note' })
check('J13', 'A receipt a debit note charges cannot be cancelled', c2.status >= 400 && c2.status < 500, err(c2))
const c1 = await call('PATCH', `/inventory/job-work/returns/${rets[0].id}/cancel`, { reason: 'Entered against the wrong challan' })
check('J14', 'The first receipt, entered by mistake, is cancelled: the 40 are out at the unit again', c1.status === 200 && (await challanRow(ch.id))?.s === 'PARTLY_BACK' && (await bal(UNIT)) === unit0 + 40 && (await bal(FW)) === fw0 - 50, err(c1))

// ── The statement ──
const st = await call('GET', `/inventory/statements/job-worker/${JW}`)
const stText = JSON.stringify(st.body ?? {})
check('J15', "The job worker's statement lists the challan", st.status === 200 && stText.includes(ch.challanNumber), err(st))

// ── A customer's material ──
const cust = await send({ lines: [{ itemId: FAB, qty: 5, ownership: 'CUSTOMER_OWNED', ownerCustomerId: A }] })
check('J16', "A customer's material goes out only against their job-work order", cust.status >= 400 && cust.status < 500, err(cust))

// ── An untouched challan cancels cleanly ──
const s2 = await send({ lines: [{ itemId: BTN, qty: 10, ownership: 'OWNED' }] })
const fwMid = await bal(FW)
const cx2 = await call('PATCH', `/inventory/job-work/${s2.body?.data?.id}/cancel`, { reason: 'Sent by mistake, never left' })
check('J17', 'A challan nothing came back on cancels, and the 10 are back in Fabric Warehouse', cx2.status === 200 && (await bal(FW)) === fwMid + 10 && (await challanRow(s2.body.data.id))?.s === 'CANCELLED', err(cx2))

console.log(`\n${pass} passed, ${fail} failed`)
await db.end()
await exit(fail ? 1 : 0)
