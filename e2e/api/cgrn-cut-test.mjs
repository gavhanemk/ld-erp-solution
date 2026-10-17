// Cutting with mixed owners, and our own trims on a job-work order — DEMO API (E2E_API, default 5101) / demo database (lderp_demo) only.
import { API, demoDb, adminLogin, exit } from '../lib/demo.mjs'
const db = await demoDb()
const q = async (sql, p = []) => (await db.query(sql, p)).rows
if ((await q('SELECT current_database() d'))[0].d !== 'lderp_demo') process.exit(1)
const T = await adminLogin(db)
const call = async (m, p, b) => {
  const r = await fetch(`${API}${p}`, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${T}` }, body: b ? JSON.stringify(b) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
let pass = 0, fail = 0
const check = (id, name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${name}${extra ? `  — ${extra}` : ''}`) }
const err = (r) => `${r.status} ${r.body?.code ?? ''} ${(r.body?.message ?? '').slice(0, 170)}`
const must = (r, what) => { if (r.status >= 300) { console.log(`setup failed: ${what}: ${err(r)}`); process.exit(1) } return r.body.data }

const A = 'cmth8dkwh00hvoijj4in66tuc', FG = 'cmv4ud8bu002awgu064gsx1hs', FAB = 'cmukzhguv0009kurg1huthki3', BTN = 'cmukzhhyy000dkurgxiokhtud'
const WH = 'cmth8dcgm00gpoijjnarcpvj3', S38 = 'cmth89v4e002moijjgegocwv0', S40 = 'cmth89vci002ooijj1otoy5u8'
const DEPT = (await q(`SELECT id FROM departments LIMIT 1`))[0].id

// Our own fabric and buttons in the store, at a cost.
const sin = await call('POST', '/inventory/stock-in', { warehouseId: WH, source: 'OTHER', notes: 'Demo test: own stock for the cutting test', lines: [{ itemId: FAB, qty: 50, unitRate: 80 }, { itemId: BTN, qty: 200, unitRate: 1.5 }] })
if (sin.status >= 300) { console.log('stock-in failed', err(sin)); process.exit(1) }
const appr = await call('POST', `/inventory/adjustments/${sin.body.data.id}/approve`, {})
if (appr.status >= 300) { console.log('stock-in approve failed', err(appr)); process.exit(1) }

// A confirmed job-work order with a released MO.
const so = must(await call('POST', '/sales/orders', { customerId: A, isJobWork: true, lines: [{ itemId: FG, totalQty: 50, unitPrice: 20, sizes: [{ sizeId: S38, qty: 20 }, { sizeId: S40, qty: 30 }] }] }), 'order')
must(await call('POST', `/sales/orders/${so.id}/confirm`, { creditReleaseReason: 'Demo test order' }), 'confirm')
const soLine = (await q(`SELECT id FROM sales_order_lines WHERE "soId"=$1`, [so.id]))[0].id
let moR = await call('POST', '/production/orders', { soId: so.id, release: true, lines: [{ soLineId: soLine, sizes: [{ sizeId: S38, qty: 20 }, { sizeId: S40, qty: 30 }] }] })
if (moR.status >= 300) moR = await call('POST', '/production/orders', { soId: so.id, release: true, routingId: 'cmth8e78c00n0oijjdw6rr22i', lines: [{ soLineId: soLine, sizes: [{ sizeId: S38, qty: 20 }, { sizeId: S40, qty: 30 }] }] })
const mo = must(moR, 'MO')
console.log(`setup: ${so.soNumber}, ${mo.moNumber} (${mo.status})`)

// Bengal's fabric received for it.
// Received, then QC and approval in one step by an approver (who may check their own count).
const rcv = must(await call('POST', '/inventory/customer-grn', { customerId: A, soId: so.id, warehouseId: WH, action: 'SUBMIT', lines: [{ itemId: FAB, challanQty: 30, receivedQty: 30 }] }), 'receipt')
must(await call('POST', `/inventory/customer-grn/${rcv.id}/inspect`, { lines: rcv.lines.map((l) => ({ lineId: l.id, rejectedQty: 0 })), approve: true }), 'QC and approval')

// One requisition for the MO: their fabric, our fabric of the same item, our buttons.
const mr = must(await call('POST', '/inventory/requisitions', {
  departmentId: DEPT, warehouseId: WH, moId: mo.id,
  lines: [
    { itemId: FAB, requestedQty: 10, ownership: 'CUSTOMER_OWNED', ownerCustomerId: A },
    { itemId: FAB, requestedQty: 5, ownership: 'OWNED' },
    { itemId: BTN, requestedQty: 20, ownership: 'OWNED' },
  ],
}), 'requisition')
check('B2', 'a requisition with only an MO named takes its order', mr.soId === so.id, `soId=${mr.soId}`)
must(await call('PATCH', `/inventory/requisitions/${mr.id}/approve`, {}), 'approve')
const iss = await call('POST', `/inventory/requisitions/${mr.id}/issue`, {})
check('SET', 'issued: 10 of theirs, 5 of ours, 20 buttons', iss.status === 200, err(iss))

const moLine = (await q(`SELECT id FROM mo_lines WHERE "moId"=$1`, [mo.id]))[0].id
const cut = () => call('POST', `/production/orders/${mo.id}/cutting`, { moLineId: moLine, fabricItemId: FAB, fabricUsed: 4, wastage: 0.5, sizes: [{ sizeId: S38, qty: 2 }, { sizeId: S40, qty: 2 }] })
const c1 = await cut()
check('T24', 'fabric that is partly ours and partly theirs cannot be cut into one owner\'s panels', c1.status === 409 && c1.body?.code === 'MIXED_OWNERS', err(c1))

// Our 5 back to the store: what is left on the floor is theirs alone.
const ownLine = mr.lines.find((l) => l.itemId === FAB && l.ownership === 'OWNED')
const fr = await call('POST', `/inventory/requisitions/${mr.id}/return`, { reason: 'Wrong owner issued', lines: [{ lineId: ownLine.id, qty: 5, warehouseId: WH }] })
check('SET', 'our fabric returned from the floor', fr.status === 200, err(fr))
const c2 = await cut()
check('T23', 'with only their fabric on the floor, the cutting goes through', c2.status === 201 || c2.status === 200, err(c2))

const rc = await call('GET', `/sales/orders/${so.id}/reconciliation`)
const own = rc.body?.data?.ownMaterial
const btn = own?.lines?.find((l) => l.item.id === BTN || l.item.code === 'BUT-001')
check('G1', 'our own buttons on the job-work order are listed at their cost', !!btn && btn.qty === 20 && btn.value > 0, JSON.stringify(own))
check('G1', 'our fabric that came back is not counted as used', !own?.lines?.some((l) => l.item.code === 'COT-003'))
const f = rc.body?.data?.fabric?.find((x) => x.item.id === FAB)
check('E1', 'the order sees its 30 received, 10 issued, 4 used and 0.5 wasted', f?.received === 30 && f?.issuedNet === 10 && f?.used === 4 && f?.waste === 0.5, JSON.stringify(f && { r: f.received, i: f.issuedNet, u: f.used, w: f.waste, left: f.leftForOrder, bom: f.bomForCut }))

console.log(`\n${pass} passed, ${fail} failed`)
await db.end()
await exit(fail ? 1 : 0)
