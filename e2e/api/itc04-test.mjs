// ITC-04 Tables 4 and 5A on the DEMO API (E2E_API, default 5101) and DEMO database (lderp_demo): what goes in, what stays out, the tax split, the matching.
//
// Each run makes its own store challans first, so it can run again and again:
// our buttons out to Ambika and back (40 back by mistake and cancelled, then
// 50 good, 6 damaged, 4 wasted), a challan cancelled unsent, and a customer's
// fabric out on two challans against their job-work order. Production's
// challan to an outside unit comes from the browser walk (test:walk): with
// none in this half-year, the three production checks are skipped.
import { API, demoDb, adminLogin, exit } from '../lib/demo.mjs'
const db = await demoDb()
const q = async (sql, p = []) => (await db.query(sql, p)).rows
if ((await q(`SELECT current_database() d`))[0].d !== 'lderp_demo') { console.log('not the demo database'); process.exit(1) }
const t = await adminLogin(db)
const run = async (id, period) => {
  const r = await fetch(`${API}/reports/${id}/run${period ? `?period=${period}` : ''}`, { headers: { authorization: `Bearer ${t}` } })
  return { status: r.status, data: (await r.json()).data }
}
const call = async (m, p, b) => {
  const r = await fetch(`${API}${p}`, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: b ? JSON.stringify(b) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
let pass = 0, fail = 0, skip = 0
const check = (id, name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${name}${extra && !ok ? `  — ${extra}` : ''}`) }
const skipped = (id, name, why) => { skip++; console.log(`SKIP  ${id.padEnd(5)} ${name}  — ${why}`) }
const err = (r) => `${r.status} ${r.body?.code ?? ''} ${(r.body?.message ?? '').slice(0, 220)}`
const must = (r, what) => { if (r.status >= 300) { console.log(`setup failed: ${what}: ${err(r)}`); process.exit(1) } return r.body.data }
const r2 = (n) => Math.round(n * 100) / 100

// ── The half-year we are in and the one before, named as the report names them (India time) ──
const istDay = (y, m, d, end = false) => new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${end ? '23:59:59.999' : '00:00:00'}+05:30`)
const half = (y, k) => ({
  id: `${y}-${k}`,
  label: k === 'H1' ? `Apr – Sep ${y}` : `Oct ${y} – Mar ${y + 1}`,
  due: k === 'H1' ? `25 Oct ${y}` : `25 Apr ${y + 1}`,
  from: k === 'H1' ? istDay(y, 4, 1) : istDay(y, 10, 1),
  to: k === 'H1' ? istDay(y, 9, 30, true) : istDay(y + 1, 3, 31, true),
})
const ist = new Date(Date.now() + 5.5 * 3600_000)
const FY = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1
const NOW = ist.getUTCMonth() >= 3 && ist.getUTCMonth() <= 8 ? half(FY, 'H1') : half(FY, 'H2')
const PREV = NOW.id.endsWith('H2') ? half(FY, 'H1') : half(FY - 1, 'H2')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ── Setup: this run's challans ──
const JW = 'cmth8didp00heoijjlp9o8aoh' // Ambika Stitching Unit
const UNIT = 'cmth8dd4y00gvoijjanbj6sm0' // Job Work Godown, standing for the unit's floor
const FW = 'cmth8dcgm00gpoijjnarcpvj3' // Fabric Warehouse
const BTN = 'cmukzhhyy000dkurgxiokhtud' // BUT-001 ZZTEST Shirt Button
const A = 'cmth8dkwh00hvoijj4in66tuc' // Bengal Trend House
const FAB = 'cmukzhguv0009kurg1huthki3' // their poplin
const FG = 'cmv4ud8bu002awgu064gsx1hs', S38 = 'cmth89v4e002moijjgegocwv0', S40 = 'cmth89vci002ooijj1otoy5u8'
const RUN = String(Date.now() % 1000000)
const send = async (o) => must(await call('POST', '/inventory/job-work', { jobWorkerId: JW, process: 'Dyeing — test', fromWarehouseId: FW, toWarehouseId: UNIT, expectedBackOn: new Date(Date.now() + 7 * 864e5).toISOString(), lines: [{ itemId: BTN, qty: 100, ownership: 'OWNED' }], ...o }), 'a challan')
const settleLabels = async (type, id) => {
  const plan = await call('POST', '/packages/outward/plan', { type, id })
  const takes = (plan.body?.data?.spots ?? []).flatMap((s) => (s.packages ?? []).filter((p) => p.take > 0).map((p) => ({ packageId: p.id, qty: p.take })))
  if (takes.length) await call('POST', '/packages/outward/apply', { type, id, takes })
}

// Buttons in the store for this run.
const sin = must(await call('POST', '/inventory/stock-in', { warehouseId: FW, source: 'OTHER', notes: 'Demo test: buttons for the ITC-04 test', lines: [{ itemId: BTN, qty: 110, unitRate: 0.6 }] }), 'stock-in')
must(await call('POST', `/inventory/adjustments/${sin.id}/approve`, {}), 'stock-in approval')

// Our buttons: 100 out; 40 back, entered by mistake; the other 60 back as 50 good, 6 damaged, 4 wasted; the mistake cancelled.
const OWN = await send({})
const BACK_ON = `AMB-${RUN}`
const back = async (lines) => must(await call('POST', `/inventory/job-work/${OWN.id}/returns`, { theirChallanNo: BACK_ON, lines }), 'a return')
await back([{ challanLineId: OWN.lines[0].id, consumedQty: 40, itemId: BTN, receivedQty: 40, warehouseId: FW }])
await back([{ challanLineId: OWN.lines[0].id, consumedQty: 60, itemId: BTN, receivedQty: 50, damagedQty: 6, wastedQty: 4, warehouseId: FW }])
const rets = await q(`SELECT id FROM job_work_returns WHERE "challanId"=$1 ORDER BY "createdAt"`, [OWN.id])
must(await call('PATCH', `/inventory/job-work/returns/${rets[0].id}/cancel`, { reason: 'Entered against the wrong challan' }), 'cancel the first return')
// The value it went out at, from the stock ledger.
const OWN_VALUE = r2(Number((await q(`SELECT COALESCE(SUM("outQty"*"unitRate"),0)::float8 v FROM stock_ledger WHERE "referenceId"=$1 AND "warehouseId"=$2`, [OWN.id, FW]))[0].v))

// A challan sent by mistake, cancelled before it left.
const CX = await send({ lines: [{ itemId: BTN, qty: 10, ownership: 'OWNED' }] })
must(await call('PATCH', `/inventory/job-work/${CX.id}/cancel`, { reason: 'Sent by mistake, never left' }), 'cancel the challan')

// Bengal's fabric: their job-work order, 10 m received, 2 m out on each of two challans, 1 m back on the first.
const so = must(await call('POST', '/sales/orders', { customerId: A, isJobWork: true, customerPORef: `BTH-ITC-${RUN}`, lines: [{ itemId: FG, totalQty: 10, unitPrice: 20, sizes: [{ sizeId: S38, qty: 5 }, { sizeId: S40, qty: 5 }] }] }), 'job-work order')
const rcv = must(await call('POST', '/inventory/customer-grn', { customerId: A, soId: so.id, warehouseId: FW, action: 'SUBMIT', challanNumber: `BTH/ITC/${RUN}`, lines: [{ itemId: FAB, challanQty: 10, receivedQty: 10 }] }), 'their fabric received')
must(await call('POST', `/inventory/customer-grn/${rcv.id}/inspect`, { lines: rcv.lines.map((l) => ({ lineId: l.id, rejectedQty: 0 })), approve: true }), 'QC and approval')
const THEIRS = []
for (let i = 0; i < 2; i++) {
  const c = await send({ soId: so.id, process: 'Washing — test', lines: [{ itemId: FAB, qty: 2, ownership: 'CUSTOMER_OWNED', ownerCustomerId: A }] })
  await settleLabels('JOB_WORK', c.id)
  THEIRS.push(c)
}
must(await call('POST', `/inventory/job-work/${THEIRS[0].id}/returns`, { theirChallanNo: `${BACK_ON}-W`, lines: [{ challanLineId: THEIRS[0].lines[0].id, consumedQty: 1, itemId: FAB, receivedQty: 1, warehouseId: FW }] }), 'their fabric back')
const THEIR_NOS = THEIRS.map((c) => c.challanNumber)
// Every customer's line on a store challan in the half-year, as the report counts them.
const theirLines = Number((await q(`SELECT COUNT(*)::int n FROM job_work_challan_lines l JOIN job_work_challans c ON c.id=l."challanId" WHERE c.status <> 'CANCELLED' AND c."challanDate" BETWEEN $1 AND $2 AND l.ownership='CUSTOMER_OWNED'`, [NOW.from, NOW.to]))[0].n)

// Production's challan to an outside unit for one of our own orders, with pieces back: the walk makes one.
const PROD = (await q(`SELECT t."transferNumber" no, m.id "moId", m."moNumber" mo, (SELECT COALESCE(SUM(l."dispatchedQty"),0)::int FROM process_transfer_lines l WHERE l."transferId"=t.id) qty
  FROM process_transfers t JOIN manufacturing_orders m ON m.id=t."moId" LEFT JOIN sales_orders s ON s.id=m."soId"
  WHERE t."vendorId" IS NOT NULL AND t."cancelledAt" IS NULL AND t."dispatchDate" BETWEEN $1 AND $2 AND NOT COALESCE(s."isJobWork", false)
    AND EXISTS (SELECT 1 FROM wip_events e JOIN job_work_orders j ON j.id=e."jobWorkOrderId" WHERE j."moId"=m.id AND e.type='VENDOR_RETURN' AND e."reversedAt" IS NULL)
  ORDER BY t."dispatchDate" DESC, t."transferNumber" DESC LIMIT 1`, [NOW.from, NOW.to]))[0]
const PROD_NOS = PROD ? (await q(`SELECT "transferNumber" no FROM process_transfers WHERE "moId"=$1 AND "vendorId" IS NOT NULL AND "cancelledAt" IS NULL`, [PROD.moId])).map((r) => r.no) : []
const NO_PROD = `no production challan to an outside unit with pieces back in ${NOW.label}: run test:walk on this demo first`
const gstin = ((await q(`SELECT gstin FROM suppliers WHERE id=$1`, [JW]))[0]?.gstin ?? '').trim().toUpperCase()
console.log(`setup: ${OWN.challanNumber} (buttons, back on ${BACK_ON}), ${CX.challanNumber} (cancelled), ${THEIR_NOS.join(' + ')} (Bengal's fabric)${PROD ? `, production ${PROD.no} (${PROD.mo})` : ''}\n`)

// ── Table 4, the half-year we are in ──
const s = await run('itc04-sent', NOW.id)
const rows4 = s.data?.rows ?? []
const btn = rows4.find((r) => r.challanNumber === OWN.challanNumber)
check('T1', `Table 4 runs for ${NOW.label}`, s.status === 200 && new RegExp(esc(NOW.label)).test(s.data.analysis.headline), s.data?.analysis?.headline)
check('T2', `Our own buttons challan is in it: 100 PCS, value ₹${OWN_VALUE}`, btn && btn.qty === 100 && btn.uqc === 'PCS' && OWN_VALUE > 0 && btn.taxableValue === OWN_VALUE && btn.goodsType === 'Inputs', JSON.stringify(btn))
check('T3', 'Same state (27 and 27): 18% splits 9% Central + 9% State, no Integrated', btn && btn.cgstRate === 9 && btn.sgstRate === 9 && btn.igstRate === 0, JSON.stringify(btn && { c: btn.cgstRate, s: btn.sgstRate, i: btn.igstRate }))
check('T4', 'The job worker is named by GSTIN, registered', btn && gstin && btn.jwGstin === gstin && btn.jwType === 'Registered' && btn.jwState === '', JSON.stringify(btn && { g: btn.jwGstin, t: btn.jwType, s: btn.jwState, master: gstin }))
check('T5', `Customers' challans (${THEIR_NOS.join(', ')}) are left out`, !rows4.some((r) => THEIR_NOS.includes(r.challanNumber)))
check('T6', `The cancelled challan (${CX.challanNumber}) is left out`, !rows4.some((r) => r.challanNumber === CX.challanNumber))
const prod = PROD && rows4.find((r) => r.challanNumber === PROD.no)
if (PROD) check('T7', `Production's challan for our own order is in, ${PROD.qty} PCS, value marked to fill`, prod && prod.qty === PROD.qty && prod.source === 'Production' && prod.taxableValue == null && /Value and tax rate to fill/.test(prod.check), JSON.stringify(prod))
else skipped('T7', "Production's challan for our own order is in, value marked to fill", NO_PROD)
check('T8', 'Says what was left out as the customers\' to declare', s.data.analysis.insights.some((i) => /customers' to declare/.test(i) && new RegExp(`${theirLines} store challan ${theirLines === 1 ? 'line' : 'lines'}`).test(i)), JSON.stringify(s.data.analysis.insights))
check('T9', `Says when the return is due: ${NOW.due}`, s.data.analysis.insights.some((i) => new RegExp(esc(NOW.due)).test(i)))

// ── Table 4, the half-year before: none of these challans ──
const s1 = await run('itc04-sent', PREV.id)
const ours = [OWN.challanNumber, CX.challanNumber, ...THEIR_NOS, ...PROD_NOS]
check('T10', `${PREV.label} holds none of this run's challans, and says when it was due`, s1.status === 200 && !(s1.data.rows ?? []).some((r) => ours.includes(r.challanNumber)) && s1.data.analysis.insights.some((i) => new RegExp(esc(PREV.due)).test(i)))

// ── Table 5A ──
const rcvd = await run('itc04-received', NOW.id)
const rows5 = rcvd.data?.rows ?? []
const backRows = rows5.filter((r) => r.originalChallan === OWN.challanNumber)
check('T11', 'Table 5A runs', rcvd.status === 200, JSON.stringify(rcvd.data?.analysis?.headline))
check('T12', `The buttons came back on ${BACK_ON}: 50 received, 10 lost (4 wasted + 6 damaged)`, backRows.length === 1 && backRows[0].theirChallan === BACK_ON && backRows[0].qty === 50 && backRows[0].lossQty === 10 && backRows[0].lossUqc === 'PCS', JSON.stringify(backRows))
check('T13', 'The cancelled receipt is not in it', !rows5.some((r) => r.originalChallan === OWN.challanNumber && r.qty === 40))
check('T14', 'Nothing of the customers’ challans is in it', !rows5.some((r) => THEIR_NOS.includes(r.originalChallan)))
const prodBack = rows5.filter((r) => r.source === 'Production')
if (PROD) {
  const mine = prodBack.filter((r) => r.description.endsWith(`— ${PROD.mo}`))
  const prodSum = mine.reduce((s, r) => s + r.qty + r.lossQty, 0)
  const evts = await q(`SELECT COALESCE(SUM(x.qty),0)::int n FROM wip_events e JOIN wip_entries x ON x."eventId"=e.id JOIN job_work_orders j ON j.id=e."jobWorkOrderId" JOIN manufacturing_orders m ON m.id=j."moId" WHERE e.type='VENDOR_RETURN' AND e."reversedAt" IS NULL AND x.bucket IN ('DONE','REJECTED','DAMAGED') AND x.qty>0 AND m."moNumber"=$1`, [PROD.mo])
  check('T15', `Production's returns for ${PROD.mo} are matched to ${PROD_NOS.join(', ')}, every piece back accounted`, mine.length > 0 && mine.every((r) => PROD_NOS.includes(r.originalChallan)) && prodSum === evts[0].n, `${JSON.stringify(mine.map((r) => ({ o: r.originalChallan, q: r.qty, l: r.lossQty })))} vs ${evts[0].n}`)
  check('T16', 'A return with no job-worker challan number is flagged', prodBack.every((r) => r.theirChallan || /Their challan no\. missing/.test(r.check)))
} else {
  skipped('T15', "Production's returns are matched to their challans, every piece back accounted", NO_PROD)
  skipped('T16', 'A return with no job-worker challan number is flagged', NO_PROD)
}

// ── No period picked: the half-year we are in ──
const d = await run('itc04-sent')
check('T17', `With no period picked it takes the half-year we are in (${NOW.label})`, d.status === 200 && new RegExp(esc(NOW.label)).test(d.data.analysis.headline))

// ── Excel ──
for (const id of ['itc04-sent', 'itc04-received']) {
  const x = await fetch(`${API}/reports/${id}/export?period=${NOW.id}`, { headers: { authorization: `Bearer ${t}` } })
  check('T18', `${id} downloads as Excel`, x.status === 200 && /spreadsheetml/.test(x.headers.get('content-type') ?? '') && (await x.arrayBuffer()).byteLength > 5000)
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`)
await db.end()
await exit(fail ? 1 : 0)
