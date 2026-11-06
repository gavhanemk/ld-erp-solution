// A job-work order end to end, on the DEMO API (E2E_API, default 5101) and DEMO database (lderp_demo) only:
// BOM → order → customer's fabric received, QC'd, approved → MO → requisition,
// issue → stages → cutting on the cutting sheet, against the BOM → floor
// return → cutting to packing → finished goods → dispatch → invoice (with our
// own trims billed) → payment → closing, with the customer's material
// accounted for. Then the closing rule's exceptions.
import { API, demoDb, adminLogin, staffLogins, exit } from '../lib/demo.mjs'
const db = await demoDb()
const q = async (sql, p = []) => (await db.query(sql, p)).rows
if ((await q('SELECT current_database() d'))[0].d !== 'lderp_demo') { console.log('not the demo database'); process.exit(1) }
const ADMIN = await adminLogin(db)
const { QC, KEEPER, SALES } = await staffLogins(ADMIN)
if (!ADMIN || !QC || !KEEPER || !SALES) { console.log('login failed'); process.exit(1) }
const call = async (m, p, b, tok = ADMIN) => {
  const r = await fetch(`${API}${p}`, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: b ? JSON.stringify(b) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
let pass = 0, fail = 0
const check = (id, name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${name}${extra && !ok ? `  — ${extra}` : ''}`) }
const err = (r) => `${r.status} ${r.body?.code ?? ''} ${(r.body?.message ?? '').slice(0, 220)}`
const must = (r, what) => { if (r.status >= 300) { console.log(`setup failed: ${what}: ${err(r)}`); process.exit(1) } return r.body.data }
const r2 = (n) => Math.round(n * 100) / 100, r3 = (n) => Math.round(n * 1000) / 1000
const near = (a, b, e = 0.0015) => Math.abs(Number(a) - Number(b)) < e

const A = 'cmth8dkwh00hvoijj4in66tuc' // Bengal Trend House (state 19)
const STYLE = 'cmth8dxgc00kroijjlgedtbsv' // LD-SH-2601
const FG = 'cmv4ud8bu002awgu064gsx1hs' // Formal Shirt LD-SH-2601 — Sky Blue
const FAB = 'cmukzhguv0009kurg1huthki3' // ZZTEST Poplin Fabric (the customer's)
const BTN = 'cmukzhhyy000dkurgxiokhtud' // ZZTEST Shirt Button (ours)
const WH = 'cmth8dcgm00gpoijjnarcpvj3', STORE = 'cmth8dcoq00groijjrxeufsdd'
const S38 = 'cmth89v4e002moijjgegocwv0', S40 = 'cmth89vci002ooijj1otoy5u8'
const tag = String(Date.now()).slice(-6)
const CUTTING = 'cmth89k8k000aoijj6oujhe60', STITCHING = 'cmth89lmw000koijjt4loo9im'

// Bring the labels of a document's stock up to date, as the window after a typed issue does.
const settleLabels = async (type, id) => {
  const plan = await call('POST', '/packages/outward/plan', { type, id })
  const takes = (plan.body?.data?.spots ?? []).flatMap((s) => (s.packages ?? []).filter((p) => p.take > 0).map((p) => ({ packageId: p.id, qty: p.take })))
  return takes.length ? call('POST', '/packages/outward/apply', { type, id, takes }) : { status: 200 }
}
const receiveQcApprove = async (body) => {
  const rcv = must(await call('POST', '/inventory/customer-grn', { action: 'SUBMIT', ...body }, KEEPER), 'receipt')
  return { rcv, qc: (rejects) => call('POST', `/inventory/customer-grn/${rcv.id}/inspect`, { lines: rcv.lines.map((l, i) => ({ lineId: l.id, rejectedQty: rejects?.[i]?.qty ?? 0, rejectReason: rejects?.[i]?.reason ?? null })), inspectionNotes: 'Shade and width checked, roll by roll' }, QC) }
}

// Every order is cut on its cutting sheet once its stages are set up (6 Nov 2026). The tests' own
// routing for LD-SH-2601 is cutting then packing, both on our floor: made once through the API,
// switched on only while an order takes its stages, so it is never offered on real orders nor
// shown as the style's routing.
const TEST_ROUTING = 'ZZTEST-RT-CUTPACK'
const stagesFor = async (moId) => {
  const op = async (code) => (await q(`SELECT id, "departmentId" FROM operations WHERE code = $1`, [code]))[0]
  const cutOp = await op('OP-CUT'), pkgOp = await op('OP-PKG')
  if (!cutOp || !pkgOp) { console.log('setup failed: processes OP-CUT and OP-PKG are not in the demo masters'); process.exit(1) }
  let rt = (await q(`SELECT id, "isActive" a FROM routings WHERE code = $1`, [TEST_ROUTING]))[0]
  if (!rt) {
    rt = must(await call('POST', '/masters/routings', {
      code: TEST_ROUTING, name: 'ZZTEST cut and pack (API tests)', styleId: STYLE, notes: 'Made by the API tests; switched off between runs.',
      steps: [
        { sequence: 1, operationId: cutOp.id, departmentId: cutOp.departmentId, execution: 'IN_HOUSE', skip: 'NEVER' },
        { sequence: 2, operationId: pkgOp.id, departmentId: pkgOp.departmentId, execution: 'IN_HOUSE' },
      ],
    }), 'test routing')
  } else if (!rt.a) must(await call('PATCH', `/masters/routings/${rt.id}`, { isActive: true }), 'test routing on')
  const r = await call('POST', `/production/orders/${moId}/routing`, { routingId: rt.id })
  must(await call('PATCH', `/masters/routings/${rt.id}`, { isActive: false }), 'test routing off')
  const steps = await q(`SELECT id, kind::text k FROM mo_steps WHERE "moId"=$1 ORDER BY sequence`, [moId])
  return { r, cutStep: steps.find((s) => s.k === 'CUTTING')?.id, packStep: steps.find((s) => s.k === 'PACKING')?.id, count: steps.length }
}

// ── 1. The BOM: Sky Blue shirt, the customer's poplin by size, our buttons ──
const bom = must(await call('POST', '/masters/bom', {
  styleId: STYLE, color: 'Sky Blue', version: `ZZ-E2E-${tag}`, notes: 'Demo test BOM',
  lines: [
    { componentItemId: FAB, component: 'Body', qtyPerUnit: 1.4, wastagePercent: 4, unitCost: 100, sizes: [{ sizeId: S38, qtyPerUnit: 1.35 }, { sizeId: S40, qtyPerUnit: 1.45 }] },
    { componentItemId: BTN, component: 'Buttons', qtyPerUnit: 8, wastagePercent: 0, unitCost: 0.5 },
  ],
}), 'BOM')
must(await call('PATCH', `/masters/bom/${bom.id}/approve`, {}), 'BOM approval')
console.log(`setup: BOM ${bom.version} approved`)

// Our own buttons in the store, at a cost.
const sin = must(await call('POST', '/inventory/stock-in', { warehouseId: WH, source: 'OTHER', notes: 'Demo test: buttons for the job-work test', lines: [{ itemId: BTN, qty: 2000, unitRate: 0.5 }] }), 'stock-in')
must(await call('POST', `/inventory/adjustments/${sin.id}/approve`, {}), 'stock-in approval')

// ── 2. The order: 200 shirts, 80 in 38 and 120 in 40, job charge ₹20, B-grade ₹10, our trims billed ──
const so = must(await call('POST', '/sales/orders', {
  customerId: A, isJobWork: true, ownMaterialBilling: 'BILLED', customerPORef: `BTH-PO-${tag}`,
  lines: [{ itemId: FG, totalQty: 200, unitPrice: 20, bGradeRate: 10, sizes: [{ sizeId: S38, qty: 80 }, { sizeId: S40, qty: 120 }] }],
}), 'order')
check('O1', 'a job-work order that bills our own trims separately', so.isJobWork && so.ownMaterialBilling === 'BILLED', JSON.stringify({ j: so.isJobWork, b: so.ownMaterialBilling }))
must(await call('POST', `/sales/orders/${so.id}/confirm`, { creditReleaseReason: 'Demo test order' }), 'confirm')
const soLine = (await q(`SELECT id, "gstRate"::float8 g, "hsnCode" FROM sales_order_lines WHERE "soId"=$1`, [so.id]))[0]

// ── 3. Their fabric: challan 300, 298 arrived, QC rejects 3 stained, approved ──
const g = await receiveQcApprove({ customerId: A, soId: so.id, warehouseId: WH, challanNumber: `BTH/DC/${tag}`, challanDate: new Date().toISOString(), vehicleNo: 'WB19A1234', lines: [{ itemId: FAB, challanQty: 300, receivedQty: 298, batchNumber: `LOT-${tag}` }] })
const qcr = await g.qc([{ qty: 3, reason: 'Stained along the selvedge' }])
check('R1', 'received 298 of 300 and handed to QC; QC rejects 3', g.rcv.status === 'SUBMITTED' && qcr.status === 200 && qcr.body.data.status === 'INSPECTED', err(qcr))
const grn = must(await call('POST', `/inventory/customer-grn/${g.rcv.id}/post`, {}), 'stock approval')
const grnRows = await q(`SELECT grade, SUM("inQty")::float8 n FROM stock_ledger WHERE "referenceId"=$1 GROUP BY grade`, [grn.id])
check('R2', 'approved: 295 usable, 3 held, at no value', grnRows.find((r) => r.grade === 'A')?.n === 295 && grnRows.find((r) => r.grade === 'R')?.n === 3, JSON.stringify(grnRows))

// ── 4. Production: MO against the BOM, its plan, the requisition ──
let moR = await call('POST', '/production/orders', { soId: so.id, release: true, lines: [{ soLineId: soLine.id, sizes: [{ sizeId: S38, qty: 80 }, { sizeId: S40, qty: 120 }] }] })
const mo = must(moR, 'MO')
const moLine = (await q(`SELECT id, "bomId" FROM mo_lines WHERE "moId"=$1`, [mo.id]))[0]
check('P1', `${mo.moNumber} takes the new BOM`, moLine.bomId === bom.id, `bomId=${moLine.bomId}`)
const plan = await call('GET', `/production/orders/${mo.id}/materials`)
const planRows = plan.body?.data?.rows ?? plan.body?.data?.materials ?? plan.body?.data ?? []
const findPlan = (id) => (Array.isArray(planRows) ? planRows : []).find((r) => r.itemId === id || r.item?.id === id)
// 80 × 1.35 × 1.04 + 120 × 1.45 × 1.04 = 112.32 + 180.96
const BOM_FAB = r3(80 * 1.35 * 1.04 + 120 * 1.45 * 1.04)
check('P2', `the plan wants ${BOM_FAB} m of their fabric and 1,600 buttons`, plan.status === 200 && near(findPlan(FAB)?.required, BOM_FAB) && near(findPlan(BTN)?.required, 1600), `${err(plan)} ${JSON.stringify([findPlan(FAB), findPlan(BTN)].map((r) => r && { req: r.required, own: r.ownership }))}`)
const raise = await call('POST', `/production/orders/${mo.id}/requisitions`, { lines: [
  { itemId: FAB, warehouseId: WH, qty: 290, ownership: 'CUSTOMER_OWNED', ownerCustomerId: A, departmentId: CUTTING },
  { itemId: BTN, warehouseId: WH, qty: 1600, ownership: 'OWNED', departmentId: STITCHING },
] })
// One requisition a department: the fabric to cutting, the buttons to stitching.
const mrs = must(raise, 'requisition')
const mrIds = mrs.map((m) => m.id)
const issues = []
for (const id of mrIds) {
  must(await call('PATCH', `/inventory/requisitions/${id}/approve`, {}), 'MR approval')
  issues.push(await call('POST', `/inventory/requisitions/${id}/issue`, {}))
  issues.push(await settleLabels('MR', id))
}
const mrId = (await q(`SELECT "mrId" FROM material_requisition_lines WHERE "mrId" = ANY($1::text[]) AND "itemId"=$2`, [mrIds, FAB]))[0].mrId
const outNow = await q(`SELECT "itemId", SUM("outQty")::float8 n FROM stock_ledger WHERE "referenceId" = ANY($1::text[]) GROUP BY 1`, [mrIds])
check('P3', `two requisitions (cutting, stitching) issued: 290 m of their fabric and 1,600 of our buttons`, mrIds.length === 2 && issues.every((r) => r.status === 200) && outNow.find((r) => r.itemId === FAB)?.n === 290 && outNow.find((r) => r.itemId === BTN)?.n === 1600, `${issues.map(err).join(' | ')} ${JSON.stringify(outNow)}`)

// ── 5. Cutting on the cutting sheet: 200 pieces, 282.5 m used, 6.4 m wasted; 1.1 m back from the floor ──
// Without stages nothing is cut any more; with them, sizes go to a cutting contractor and come back cut, in bundles.
const sizes200 = [{ sizeId: S38, qty: 80 }, { sizeId: S40, qty: 120 }]
const oldCut = await call('POST', `/production/orders/${mo.id}/cutting`, { moLineId: moLine.id, fabricItemId: FAB, fabricUsed: 282.5, wastage: 6.4, sizes: sizes200 })
check('C0', `${mo.moNumber} has no stages yet: cutting it the old way is refused`, oldCut.status === 409 && oldCut.body?.code === 'NEEDS_STAGES', err(oldCut))
const staged = await stagesFor(mo.id)
check('C0', 'its materials issued, it takes its stages: cutting, then packing', staged.r.status === 200 && staged.count === 2 && !!staged.cutStep && !!staged.packStep, `${err(staged.r)} steps=${staged.count}`)
const issue = must(await call('POST', `/production/orders/${mo.id}/cutting-issues`, { moLineId: moLine.id, cutterName: 'ZZTEST Cutter', fabricItemId: FAB, fabricGiven: 290, noOfLayers: 40, lotNo: `LOT-${tag}`, planned: sizes200 }), 'issue to the cutting contractor')
const cut = await call('POST', `/production/cutting/${issue.id}/receive`, { fabricUsed: 282.5, wastage: 6.4, bundleSize: 0, sizes: sizes200 })
check('C1', '200 pieces cut from 288.9 m, back from the cutting contractor in a bundle a size', cut.status === 200 && cut.body?.data?.actualPieces === 200 && cut.body?.data?.bundles === 2, `${err(cut)} pieces=${cut.body?.data?.actualPieces} bundles=${cut.body?.data?.bundles}`)
let rc = (await call('GET', `/sales/orders/${so.id}/reconciliation`)).body?.data
let f = rc?.fabric?.find((x) => x.item.id === FAB)
check('C2', `the BOM allows ${BOM_FAB} m for the 200 cut; 288.9 used and wasted`, near(f?.bomForCut, BOM_FAB) && near(f?.used, 282.5) && near(f?.waste, 6.4), JSON.stringify(f && { bomForCut: f.bomForCut, used: f.used, waste: f.waste }))
check('C2', `under the BOM by ${r3(BOM_FAB - 288.9)} m (variance ${r3(288.9 - BOM_FAB)})`, near(f?.bomVariance, r3(288.9 - BOM_FAB)), `variance=${f?.bomVariance}`)
check('C2', `the BOM for the whole order is ${BOM_FAB} m`, near(f?.bomForOrder, BOM_FAB), `bomForOrder=${f?.bomForOrder}`)
check('C3', '1.1 m issued and neither cut nor returned shows as on the floor', near(f?.issuedNotCut, 1.1), `issuedNotCut=${f?.issuedNotCut}`)
const fabLine = (await q(`SELECT id FROM material_requisition_lines WHERE "mrId"=$1 AND "itemId"=$2`, [mrId, FAB]))[0].id
const back = await call('POST', `/inventory/requisitions/${mrId}/return`, { reason: 'Leftover after cutting', lines: [{ lineId: fabLine, qty: 1.1, warehouseId: WH }] })
rc = (await call('GET', `/sales/orders/${so.id}/reconciliation`)).body?.data
f = rc?.fabric?.find((x) => x.item.id === FAB)
check('C3', 'the 1.1 m comes back from the floor: nothing left on it', back.status === 200 && near(f?.issuedNotCut, 0) && near(f?.issuedNet, 288.9), `${err(back)} ${JSON.stringify(f && { net: f.issuedNet, floor: f.issuedNotCut })}`)

// ── 6. The floor, then finished goods: 198 good, 2 B-grade ──
// Both bundles from cutting to packing, counted in there, and recorded: 198 done, 2 set aside as B-grade.
const bundles = await q(`SELECT id, "sizeId", qty FROM production_bundles WHERE "cuttingOrderId"=$1 ORDER BY "bundleNo"`, [issue.id])
const b38 = bundles.find((b) => b.sizeId === S38), b40 = bundles.find((b) => b.sizeId === S40)
if (!b38 || !b40) { console.log(`setup failed: the cutting made ${bundles.length} bundles, not one for each size`); process.exit(1) }
const sent = await call('POST', `/production/orders/${mo.id}/transfers`, { fromStepId: staged.cutStep, lines: bundles.map((b) => ({ bundleId: b.id, qty: b.qty })), issuedBy: 'ZZTEST Cutter' })
const counted = sent.status < 300
  ? await call('POST', `/production/transfers/${sent.body.data.id}/receive`, { lines: sent.body.data.lines.map((l) => ({ lineId: l.id, qty: l.dispatchedQty })), receivedBy: 'ZZTEST Packer' })
  : sent
const worked = counted.status < 300
  ? await call('POST', `/production/orders/${mo.id}/steps/${staged.packStep}/work`, { lines: [{ bundleId: b38.id, done: 80 }, { bundleId: b40.id, done: 118, bGrade: 2 }], personName: 'ZZTEST Packer' })
  : counted
check('W1', 'both bundles sent from cutting to packing, counted in, and recorded there: 198 done, 2 B-grade', sent.status === 201 && counted.status === 200 && worked.status === 201, `${err(sent)} | ${err(counted)} | ${err(worked)}`)
const fgr = await call('POST', '/finished-goods', { warehouseId: STORE, moId: mo.id, lines: [
  { itemId: FG, sizeId: S38, qty: 80, grade: 'A' },
  { itemId: FG, sizeId: S40, qty: 118, grade: 'A' },
  { itemId: FG, sizeId: S40, qty: 2, grade: 'B' },
] })
check('F1', '198 good and 2 B-grade packed into the store', fgr.status === 201 || fgr.status === 200, err(fgr))
const fgVal = await q(`SELECT ownership::text o, "ownerCustomerId" c, SUM("inQty"*COALESCE("unitRate",0))::float8 v, SUM("inQty")::float8 n FROM stock_ledger WHERE "referenceId"=$1 GROUP BY 1,2`, [fgr.body?.data?.id ?? ''])
check('F1', "they are the customer's goods at ₹0", fgVal.length === 1 && fgVal[0].o === 'CUSTOMER_OWNED' && fgVal[0].c === A && fgVal[0].v === 0 && fgVal[0].n === 200, JSON.stringify(fgVal))

// ── 7. Dispatch: everything sent, but their fabric is not all back yet ──
const dc = await call('POST', '/sales/challans', { soId: so.id, warehouseId: STORE, dispatch: true, vehicleNumber: 'WB19B5678', lines: [
  { soLineId: soLine.id, grade: 'A', sizes: [{ sizeId: S38, qty: 80 }, { sizeId: S40, qty: 118 }] },
  { soLineId: soLine.id, grade: 'B', sizes: [{ sizeId: S40, qty: 2 }] },
] })
const DC = dc.body?.data
check('D1', 'all 200 dispatched on one challan', dc.status === 201 && DC?.status === 'DISPATCHED', err(dc))
const soNow = (await q(`SELECT status::text s FROM sales_orders WHERE id=$1`, [so.id]))[0].s
check('D2', 'everything sent, yet the order stays open: 9.1 m of their fabric is still with us', soNow === 'PARTIALLY_DISPATCHED', `status=${soNow}`)

// ── 8. Invoice: the job charge, the B-grade, and our trims as a charge ──
const prep = await call('GET', `/sales/invoices/prepare?dcId=${DC.id}`)
const own = prep.body?.data?.ownMaterial
const btnCost = r2(-Number((await q(`SELECT COALESCE(SUM(("inQty"-"outQty")*"unitRate"),0)::float8 v FROM stock_ledger WHERE "referenceId" = ANY($1::text[]) AND "itemId"=$2`, [mrIds, BTN]))[0].v))
check('I1', `the invoice form offers our 1,600 buttons to bill: ₹${btnCost} at cost`, prep.status === 200 && btnCost > 500 && near(own?.cost, btnCost, 0.01) && near(own?.toBill, btnCost, 0.01) && own?.billed === 0, `${err(prep)} ${JSON.stringify(own)} cost=${btnCost}`)
// The tests' own charge type for our trims: made once, and switched back on if someone switched it off.
const ctRow = (await q(`SELECT id, "isActive" a, "applyOnSale" s FROM charge_types WHERE name = 'ZZTEST Trims supplied'`))[0]
const ct = ctRow?.id ??
  must(await call('POST', '/masters/charge-types', { name: 'ZZTEST Trims supplied', defaultGstRate: 12, applyOnSale: true }), 'charge type').id
// The charge type is switched on only around the invoices that need it, and back as it was found even if one fails.
const ctWasOff = !!ctRow && (!ctRow.a || !ctRow.s)
const withCharge = async (fn) => {
  if (ctWasOff) must(await call('PATCH', `/masters/charge-types/${ct}`, { isActive: true, applyOnSale: true }), 'charge type switched on')
  try {
    return await fn()
  } finally {
    if (ctWasOff) await call('PATCH', `/masters/charge-types/${ct}`, { isActive: ctRow.a, applyOnSale: ctRow.s })
  }
}
const inv = await withCharge(() => call('POST', '/sales/invoices', { dcId: DC.id, charges: [{ chargeTypeId: ct, amount: btnCost, ownMaterial: true }] }))
const INV = inv.body?.data
const gst = soLine.g
const goods = r2(198 * 20 + 2 * 10)
const chargeRate = Number((await q(`SELECT "defaultGstRate"::float8 r FROM charge_types WHERE id=$1`, [ct]))[0].r)
const expect = Math.round(goods + goods * gst / 100 + btnCost + btnCost * chargeRate / 100)
check('I2', `invoiced: ₹${goods} job charge (198 × 20 + 2 × 10) at ${gst}% GST, plus the trims at ${chargeRate}%`, inv.status === 201 && near(INV?.taxableAmount, goods, 0.01) && Math.abs(Number(INV?.totalAmount) - expect) <= 1, `${err(inv)} taxable=${INV?.taxableAmount} total=${INV?.totalAmount} expect≈${expect} hsn=${soLine.hsnCode}`)
rc = (await call('GET', `/sales/orders/${so.id}/reconciliation`)).body?.data
check('I3', 'the order now shows our trims billed, nothing left to bill', near(rc?.ownMaterial?.billed, btnCost, 0.01) && near(rc?.ownMaterial?.toBill, 0, 0.01), JSON.stringify(rc?.ownMaterial && { b: rc.ownMaterial.billed, t: rc.ownMaterial.toBill }))

// ── 9. Payment: 60% now, the rest later ──
const total = Number(INV.totalAmount), first = r2(total * 0.6)
const pay1 = await call('POST', '/sales/receipts', { customerId: A, mode: 'CASH', amount: first, notes: 'Demo test: part payment', allocations: [{ invoiceId: INV.id, amount: first }] })
let invNow = (await call('GET', `/sales/invoices/${INV.id}`)).body?.data
check('M1', `₹${first} received: the invoice is part paid`, pay1.status === 201 && invNow?.status === 'PARTIAL' && near(invNow?.balanceAmount, r2(total - first), 0.01), `${err(pay1)} ${invNow?.status} ${invNow?.balanceAmount}`)
const pay2 = await call('POST', '/sales/receipts', { customerId: A, mode: 'CASH', amount: r2(total - first), notes: 'Demo test: balance', allocations: [{ invoiceId: INV.id, amount: r2(total - first) }] })
invNow = (await call('GET', `/sales/invoices/${INV.id}`)).body?.data
const open = await call('GET', `/sales/receipts/open-invoices?customerId=${A}`)
check('M2', 'the balance received: the invoice is paid, nothing owed on it', pay2.status === 201 && invNow?.status === 'PAID' && near(invNow?.balanceAmount, 0, 0.01), `${err(pay2)} ${invNow?.status} ${invNow?.balanceAmount}`)
check('M2', 'it is off the customer\'s open invoices', open.status === 200 && !(open.body?.data?.invoices ?? []).some((i) => i.id === INV.id), err(open))

// ── 10. Closing: refused while their fabric is with us; fine once it is back ──
const chk = (await call('GET', `/sales/orders/${so.id}/close-check`)).body?.data
check('X1', 'the close check names what is still with us: 9.1 m, rejected included', chk?.gaps?.length === 1 && chk.gaps[0].kind === 'WITH_US' && near(chk.gaps[0].qty, 9.1), JSON.stringify(chk?.gaps))
const sc1 = await call('POST', `/sales/orders/${so.id}/short-close`, { reason: 'All shirts sent' })
check('X1', 'closing it now is refused', sc1.status === 409 && sc1.body?.code === 'MATERIAL_UNACCOUNTED', err(sc1))
const rej = await call('POST', '/inventory/customer-return', { customerId: A, warehouseId: WH, grnId: grn.id, reason: 'REJECTED', vehicleNo: 'WB19A1234', lines: [{ itemId: FAB, qty: 3 }] })
const left = await call('POST', '/inventory/customer-return', { customerId: A, warehouseId: WH, soId: so.id, reason: 'LEFTOVER', vehicleNo: 'WB19A1234', lines: [{ itemId: FAB, qty: 6.1 }] })
await settleLabels('CUSTOMER_RETURN', left.body?.data?.id)
check('X2', 'the 3 rejected and the 6.1 left over go back to Bengal', rej.status === 201 && left.status === 201, `${err(rej)} ${err(left)}`)
const chk2 = (await call('GET', `/sales/orders/${so.id}/close-check`)).body?.data
const sc2 = await call('POST', `/sales/orders/${so.id}/short-close`, { reason: 'All shirts sent, fabric reconciled' })
const done = (await q(`SELECT status::text s, "materialExceptionReason" x FROM sales_orders WHERE id=$1`, [so.id]))[0]
check('X3', 'with every metre accounted for, the order closes, no exception needed', chk2?.gaps?.length === 0 && sc2.status === 200 && done.s === 'COMPLETED' && !done.x, `${JSON.stringify(chk2?.gaps)} ${err(sc2)}`)
rc = (await call('GET', `/sales/orders/${so.id}/reconciliation`)).body?.data
f = rc?.fabric?.find((x) => x.item.id === FAB)
check('X3', 'the order\'s fabric balances: 298 = 288.9 cut + 9.1 sent back; 200 pieces = 198 + 2', near(f?.received, 298) && near(f?.issuedNet, 288.9) && near(f?.returned, 9.1) && near(f?.leftForOrder, 0) && rc?.balanced === true, JSON.stringify(f && { r: f.received, n: f.issuedNet, b: f.returned, l: f.leftForOrder, bal: rc?.balanced }))

// ── 11. Exceptions: a manager may close with material unaccounted, with a reason ──
// (a) Called off with its MO released but never started and their fabric
// still here: not cancelled outright but asked for, which puts the MO on hold
// and stops everything for the order, then approved with a manager's
// exception for the fabric. The MO closes with it.
const so4 = must(await call('POST', '/sales/orders', { customerId: A, isJobWork: true, lines: [{ itemId: FG, totalQty: 20, unitPrice: 20, sizes: [{ sizeId: S38, qty: 10 }, { sizeId: S40, qty: 10 }] }] }), 'order 4')
must(await call('POST', `/sales/orders/${so4.id}/confirm`, { creditReleaseReason: 'Demo test order' }), 'confirm 4')
const so4Line = (await q(`SELECT id FROM sales_order_lines WHERE "soId"=$1`, [so4.id]))[0].id
const mo4 = must(await call('POST', '/production/orders', { soId: so4.id, release: true, lines: [{ soLineId: so4Line, sizes: [{ sizeId: S38, qty: 10 }, { sizeId: S40, qty: 10 }] }] }), 'MO 4')
const g4 = await receiveQcApprove({ customerId: A, soId: so4.id, warehouseId: WH, challanNumber: `BTH/DC/${tag}-4`, lines: [{ itemId: FAB, challanQty: 30, receivedQty: 30 }] })
await g4.qc()
must(await call('POST', `/inventory/customer-grn/${g4.rcv.id}/post`, {}), 'approval 4')
const e0 = await call('POST', `/sales/orders/${so4.id}/short-close`, { reason: 'Buyer cancelled the rest' })
check('E1', `nothing issued, cut or packed on ${mo4.moNumber}: it is not short-closed`, e0.status === 409 && e0.body?.code === 'NOTHING_STARTED' && (e0.body?.message ?? '').includes(mo4.moNumber), err(e0))
const k0 = await call('POST', `/sales/orders/${so4.id}/cancel`, { reason: 'Buyer cancelled the rest' })
check('E1', `with ${mo4.moNumber} raised it is not cancelled outright: its cancellation is asked for`, k0.status === 409 && k0.body?.code === 'NEEDS_REQUEST', err(k0))
const rq4 = await call('POST', `/sales/orders/${so4.id}/cancellation/request`, { reason: 'Buyer cancelled the rest' }, SALES)
const mo4Held = (await q(`SELECT "heldAt" h, "holdReason" r FROM manufacturing_orders WHERE id=$1`, [mo4.id]))[0]
check('E1', `asked for by sales: ${mo4.moNumber} goes on hold, saying why`, rq4.status === 200 && !!mo4Held.h && (mo4Held.r ?? '').startsWith(`Cancellation requested for ${so4.soNumber}`), `${err(rq4)} ${JSON.stringify(mo4Held)}`)
const rq4b = await call('POST', `/sales/orders/${so4.id}/cancellation/request`, { reason: 'Asked twice' }, SALES)
check('E1', 'asked once: a second request is refused', rq4b.status === 409 && rq4b.body?.code === 'ALREADY_REQUESTED', err(rq4b))
// While it waits nothing more is asked of the store, packed, sent, resumed or short-closed.
const held4 = [
  await call('POST', `/production/orders/${mo4.id}/requisitions`, { lines: [{ itemId: FAB, warehouseId: WH, qty: 1, ownership: 'CUSTOMER_OWNED', ownerCustomerId: A, departmentId: CUTTING }] }),
  await call('POST', '/finished-goods', { warehouseId: STORE, soId: so4.id, lines: [{ itemId: FG, sizeId: S38, qty: 1 }] }),
  await call('POST', '/sales/challans', { soId: so4.id, warehouseId: STORE, lines: [{ soLineId: so4Line, sizes: [{ sizeId: S38, qty: 1 }] }] }),
  await call('POST', `/production/orders/${mo4.id}/resume`, {}),
  await call('POST', `/sales/orders/${so4.id}/short-close`, { reason: 'Buyer cancelled the rest' }),
]
check('E1', 'while it waits: no requisition, packing, challan, resume or short-close', held4.every((r) => r.status === 409 && r.body?.code === 'CANCEL_REQUESTED'), held4.map(err).join(' | '))
const imp4 = (await call('GET', `/sales/orders/${so4.id}/cancellation`)).body?.data
check('E2', `the impact: waiting, ${mo4.moNumber} closes on approval, 30 m of their fabric to account for`, imp4?.request?.pending === true && imp4?.mos?.some((m) => m.moNumber === mo4.moNumber && m.closes) && imp4?.gaps?.some((g) => g.qty === 30) && (imp4?.effects?.[0] ?? '').includes('is cancelled'), JSON.stringify({ r: imp4?.request?.pending, mos: imp4?.mos?.map((m) => [m.moNumber, m.closes]), gaps: imp4?.gaps?.map((g) => g.qty), e: imp4?.effects?.[0] }))
const e1 = await call('POST', `/sales/orders/${so4.id}/cancellation/approve`, {})
check('E2', 'approving with 30 m of their fabric here is refused, saying why', e1.status === 409 && e1.body?.code === 'MATERIAL_UNACCOUNTED' && /30 mtr/.test(e1.body?.message ?? ''), err(e1))
const e2 = await call('POST', `/sales/orders/${so4.id}/cancellation/approve`, { materialException: 'Customer asked us to keep the fabric for their next order' }, SALES)
check('E2', 'a sales manager who does not approve stock cannot make the exception', e2.status === 403 && e2.body?.code === 'NEEDS_MANAGER', err(e2))
const mo4Open = (await q(`SELECT status::text s, "heldAt" h FROM manufacturing_orders WHERE id=$1`, [mo4.id]))[0]
check('E2', `refused, ${mo4.moNumber} stays as it was, on hold`, mo4Open.s === 'RELEASED' && !!mo4Open.h, JSON.stringify(mo4Open))
const e3 = await call('POST', `/sales/orders/${so4.id}/cancellation/approve`, { materialException: 'Customer asked us to keep the fabric for their next order' })
const so4Row = (await q(`SELECT status::text s, "cancelReason" c, "cancelRequestReason" q, "materialExceptionReason" r, "materialExceptionById" b, "materialExceptionSnapshot" snap FROM sales_orders WHERE id=$1`, [so4.id]))[0]
check('E3', 'a manager approves it with the reason: cancelled; who asked, why, and what was missing are kept', e3.status === 200 && so4Row.s === 'CANCELLED' && so4Row.c === 'Buyer cancelled the rest' && so4Row.q === 'Buyer cancelled the rest' && so4Row.r?.includes('next order') && so4Row.b && so4Row.snap?.gaps?.[0]?.qty === 30, `${err(e3)} ${JSON.stringify(so4Row)}`)
const mo4Row = (await q(`SELECT status::text s, "closeReason" r, "heldAt" h FROM manufacturing_orders WHERE id=$1`, [mo4.id]))[0]
check('E3', `${mo4.moNumber} is closed with it, saying why, off hold`, mo4Row.s === 'CLOSED' && (mo4Row.r ?? '').includes(`${so4.soNumber} cancelled`) && !mo4Row.h && (e3.body?.message ?? '').includes(mo4.moNumber), `${JSON.stringify(mo4Row)} ${e3.body?.message}`)
const aud = await q(`SELECT action::text a FROM audit_logs WHERE "entityType"='SalesOrderMaterialException' AND "entityId"=$1`, [so4.id])
check('E3', 'and the exception is in the audit trail', aud.length === 1 && aud[0].a === 'APPROVE', JSON.stringify(aud))
const mo4Aud = await q(`SELECT 1 FROM audit_logs WHERE "entityType"='ManufacturingOrder' AND "entityId"=$1 AND action='UPDATE'`, [mo4.id])
check('E3', `and so is ${mo4.moNumber} going on hold and closing`, mo4Aud.length >= 2, `entries=${mo4Aud.length}`)

// (a3) Asked for, then withdrawn: the order carries on. Asked again, approved.
const so8 = must(await call('POST', '/sales/orders', { customerId: A, isJobWork: true, lines: [{ itemId: FG, totalQty: 4, unitPrice: 20, sizes: [{ sizeId: S38, qty: 2 }, { sizeId: S40, qty: 2 }] }] }), 'order 8')
must(await call('POST', `/sales/orders/${so8.id}/confirm`, { creditReleaseReason: 'Demo test order' }), 'confirm 8')
const so8Line = (await q(`SELECT id FROM sales_order_lines WHERE "soId"=$1`, [so8.id]))[0].id
const mo8 = must(await call('POST', '/production/orders', { soId: so8.id, release: true, lines: [{ soLineId: so8Line, sizes: [{ sizeId: S38, qty: 2 }, { sizeId: S40, qty: 2 }] }] }), 'MO 8')
const w1 = await call('POST', `/sales/orders/${so8.id}/cancellation/request`, { reason: 'Buyer may call it off' }, SALES)
const w2 = await call('POST', `/sales/orders/${so8.id}/cancellation/withdraw`, {}, SALES)
const mo8Now = (await q(`SELECT "heldAt" h FROM manufacturing_orders WHERE id=$1`, [mo8.id]))[0]
const so8Now = (await q(`SELECT status::text s, "cancelRequestedAt" c FROM sales_orders WHERE id=$1`, [so8.id]))[0]
check('E6', `withdrawn: the order carries on, ${mo8.moNumber} off hold`, w1.status === 200 && w2.status === 200 && !mo8Now.h && !so8Now.c && so8Now.s === 'IN_PRODUCTION', `${err(w1)} ${err(w2)} ${JSON.stringify({ mo8Now, so8Now })}`)
const w3 = await call('POST', `/sales/orders/${so8.id}/cancellation/request`, { reason: 'Buyer called it off' }, SALES)
const w4 = await call('POST', `/sales/orders/${so8.id}/cancellation/approve`, {})
const so8Done = (await q(`SELECT status::text s FROM sales_orders WHERE id=$1`, [so8.id]))[0].s
const mo8Done = (await q(`SELECT status::text s FROM manufacturing_orders WHERE id=$1`, [mo8.id]))[0].s
check('E6', `asked again and approved: cancelled, ${mo8.moNumber} closed`, w3.status === 200 && w4.status === 200 && so8Done === 'CANCELLED' && mo8Done === 'CLOSED', `${err(w3)} ${err(w4)} ${so8Done} ${mo8Done}`)

// (a4) Asked for after goods went out: approved, it is short-closed at what was sent.
const so9 = must(await call('POST', '/sales/orders', { customerId: A, isJobWork: true, lines: [{ itemId: FG, totalQty: 6, unitPrice: 20, sizes: [{ sizeId: S38, qty: 2 }, { sizeId: S40, qty: 4 }] }] }), 'order 9')
must(await call('POST', `/sales/orders/${so9.id}/confirm`, { creditReleaseReason: 'Demo test order' }), 'confirm 9')
const so9Line = (await q(`SELECT id FROM sales_order_lines WHERE "soId"=$1`, [so9.id]))[0].id
const mo9 = must(await call('POST', '/production/orders', { soId: so9.id, release: true, lines: [{ soLineId: so9Line, sizes: [{ sizeId: S38, qty: 2 }] }] }), 'MO 9')
must(await call('POST', '/finished-goods', { warehouseId: STORE, soId: so9.id, lines: [{ itemId: FG, sizeId: S40, qty: 4 }] }), 'FG 9')
must(await call('POST', '/sales/challans', { soId: so9.id, warehouseId: STORE, dispatch: true, lines: [{ soLineId: so9Line, sizes: [{ sizeId: S40, qty: 4 }] }] }), 'DC 9')
const imp9 = (await call('GET', `/sales/orders/${so9.id}/cancellation`)).body?.data
const a1 = await call('POST', `/sales/orders/${so9.id}/cancellation/request`, { reason: 'Buyer does not want the other two' }, SALES)
const a2 = await call('POST', `/sales/orders/${so9.id}/cancellation/approve`, {})
const so9Done = (await q(`SELECT status::text s, "shortCloseReason" r, (SELECT SUM("pendingQty")::float8 FROM sales_order_lines WHERE "soId"=$1) p FROM sales_orders WHERE id=$1`, [so9.id]))[0]
const mo9Done = (await q(`SELECT status::text s FROM manufacturing_orders WHERE id=$1`, [mo9.id]))[0].s
check('E7', `4 of 6 sent: the impact says short-closed; approved, it is, nothing pending, ${mo9.moNumber} closed`, (imp9?.effects?.[0] ?? '').includes('short-closed at the 4 pieces sent') && a1.status === 200 && a2.status === 200 && so9Done.s === 'COMPLETED' && so9Done.r === 'Buyer does not want the other two' && so9Done.p === 0 && mo9Done === 'CLOSED', `${imp9?.effects?.[0]} ${err(a1)} ${err(a2)} ${JSON.stringify(so9Done)} ${mo9Done}`)

// (a5) Called off with material out on the floor: nothing more is issued while
// it waits, the unused fabric comes back on a floor return when the store has
// it, and approval closes what is still asked for. The issue and the return
// stay on record.
const so10 = must(await call('POST', '/sales/orders', { customerId: A, isJobWork: true, lines: [{ itemId: FG, totalQty: 10, unitPrice: 20, sizes: [{ sizeId: S38, qty: 5 }, { sizeId: S40, qty: 5 }] }] }), 'order 10')
must(await call('POST', `/sales/orders/${so10.id}/confirm`, { creditReleaseReason: 'Demo test order' }), 'confirm 10')
const so10Line = (await q(`SELECT id FROM sales_order_lines WHERE "soId"=$1`, [so10.id]))[0].id
const g10 = await receiveQcApprove({ customerId: A, soId: so10.id, warehouseId: WH, challanNumber: `BTH/DC/${tag}-10`, lines: [{ itemId: FAB, challanQty: 20, receivedQty: 20 }] })
await g10.qc()
must(await call('POST', `/inventory/customer-grn/${g10.rcv.id}/post`, {}), 'approval 10')
const mo10 = must(await call('POST', '/production/orders', { soId: so10.id, release: true, lines: [{ soLineId: so10Line, sizes: [{ sizeId: S38, qty: 5 }, { sizeId: S40, qty: 5 }] }] }), 'MO 10')
must(await call('POST', `/production/orders/${mo10.id}/requisitions`, { lines: [
  { itemId: FAB, warehouseId: WH, qty: 10, ownership: 'CUSTOMER_OWNED', ownerCustomerId: A, departmentId: CUTTING },
  { itemId: BTN, warehouseId: WH, qty: 80, ownership: 'OWNED', departmentId: STITCHING },
] }), 'requisitions 10')
const mrs10 = await q(`SELECT m.id, m."mrNumber" n, l.id "lineId", l."itemId" i FROM material_requisitions m JOIN material_requisition_lines l ON l."mrId" = m.id WHERE m."moId"=$1`, [mo10.id])
const fab10 = mrs10.find((m) => m.i === FAB), btn10 = mrs10.find((m) => m.i === BTN)
for (const m of [fab10, btn10]) must(await call('PATCH', `/inventory/requisitions/${m.id}/approve`, {}), 'MR approval 10')
must(await call('POST', `/inventory/requisitions/${fab10.id}/issue`, {}), 'fabric issue 10')
await settleLabels('MR', fab10.id)
must(await call('POST', `/sales/orders/${so10.id}/cancellation/request`, { reason: 'Buyer cancelled before cutting' }, SALES), 'request 10')
const iss10 = await call('POST', `/inventory/requisitions/${btn10.id}/issue`, {})
check('E8', `while it waits nothing more is issued: ${btn10.n} is refused`, iss10.status === 409 && iss10.body?.code === 'CANCEL_REQUESTED', err(iss10))
let imp10 = (await call('GET', `/sales/orders/${so10.id}/cancellation`)).body?.data
const fabRow = (d) => d?.materials?.find((m) => m.item.code === d.materials.find((x) => x.customers)?.item.code)
check('E8', `the impact: 10 m of their fabric with production; ${btn10.n} closes on approval, ${fab10.n} can be returned`, fabRow(imp10)?.withProduction === 10 && imp10?.requisitions?.some((r) => r.mrNumber === btn10.n && r.closes) && imp10?.requisitions?.some((r) => r.mrNumber === fab10.n && r.returnable && !r.closes), JSON.stringify({ fab: fabRow(imp10), mrs: imp10?.requisitions }))
const back10 = await call('POST', `/inventory/requisitions/${fab10.id}/return`, { reason: 'Order called off before cutting', lines: [{ lineId: fab10.lineId, qty: 10, warehouseId: WH }] })
imp10 = (await call('GET', `/sales/orders/${so10.id}/cancellation`)).body?.data
check('E8', 'returns still go on while it waits: the 10 m is back in the store once received', back10.status === 200 && fabRow(imp10)?.withProduction === 0 && fabRow(imp10)?.returned === 10, `${err(back10)} ${JSON.stringify(fabRow(imp10))}`)
const ap10 = await call('POST', `/sales/orders/${so10.id}/cancellation/approve`, { materialException: 'Customer collects all 20 m themselves next week' })
const so10Done = (await q(`SELECT status::text s FROM sales_orders WHERE id=$1`, [so10.id]))[0].s
const mo10Done = (await q(`SELECT status::text s FROM manufacturing_orders WHERE id=$1`, [mo10.id]))[0].s
const mrs10Done = await q(`SELECT m."mrNumber" n, m."closedAt" c, l."issuedQty"::float8 iss, l."returnedQty"::float8 ret FROM material_requisitions m JOIN material_requisition_lines l ON l."mrId" = m.id WHERE m."moId"=$1`, [mo10.id])
const fabDone = mrs10Done.find((m) => m.n === fab10.n), btnDone = mrs10Done.find((m) => m.n === btn10.n)
check('E8', `approved: cancelled, ${mo10.moNumber} and ${btn10.n} closed; ${fab10.n}'s 10 m issued and 10 m returned stay on record`, ap10.status === 200 && so10Done === 'CANCELLED' && mo10Done === 'CLOSED' && !!btnDone?.c && fabDone?.iss === 10 && fabDone?.ret === 10, `${err(ap10)} ${so10Done} ${mo10Done} ${JSON.stringify(mrs10Done)}`)

// (a2) Short-closed once goods have gone: an MO nothing was made on closes with it.
const so7 = must(await call('POST', '/sales/orders', { customerId: A, isJobWork: true, lines: [{ itemId: FG, totalQty: 6, unitPrice: 20, sizes: [{ sizeId: S38, qty: 2 }, { sizeId: S40, qty: 4 }] }] }), 'order 7')
must(await call('POST', `/sales/orders/${so7.id}/confirm`, { creditReleaseReason: 'Demo test order' }), 'confirm 7')
const so7Line = (await q(`SELECT id FROM sales_order_lines WHERE "soId"=$1`, [so7.id]))[0].id
const mo7 = must(await call('POST', '/production/orders', { soId: so7.id, release: true, lines: [{ soLineId: so7Line, sizes: [{ sizeId: S38, qty: 2 }] }] }), 'MO 7')
must(await call('POST', '/finished-goods', { warehouseId: STORE, soId: so7.id, lines: [{ itemId: FG, sizeId: S40, qty: 4 }] }), 'FG 7')
must(await call('POST', '/sales/challans', { soId: so7.id, warehouseId: STORE, dispatch: true, lines: [{ soLineId: so7Line, sizes: [{ sizeId: S40, qty: 4 }] }] }), 'DC 7')
const cx7 = await call('POST', `/sales/orders/${so7.id}/cancel`, { reason: 'Buyer does not want the rest' })
check('E5', '4 of 6 sent: it is not cancelled outright', cx7.status === 409 && cx7.body?.code === 'NEEDS_REQUEST', err(cx7))
const sc7 = await call('POST', `/sales/orders/${so7.id}/short-close`, { reason: 'Buyer does not want the rest' })
const so7Now = (await q(`SELECT status::text s FROM sales_orders WHERE id=$1`, [so7.id]))[0].s
const mo7Row = (await q(`SELECT status::text s, "closeReason" r FROM manufacturing_orders WHERE id=$1`, [mo7.id]))[0]
check('E5', `short-closed at the 4 sent; ${mo7.moNumber}, nothing made on it, closes with it`, sc7.status === 200 && so7Now === 'COMPLETED' && mo7Row.s === 'CLOSED' && (mo7Row.r ?? '').includes(`${so7.soNumber} short-closed`) && (sc7.body?.message ?? '').includes(mo7.moNumber), `${err(sc7)} ${so7Now} ${JSON.stringify(mo7Row)}`)

// (b) Cancel a confirmed order whose fabric already came in.
const so5 = must(await call('POST', '/sales/orders', { customerId: A, isJobWork: true, lines: [{ itemId: FG, totalQty: 10, unitPrice: 20, sizes: [{ sizeId: S38, qty: 5 }, { sizeId: S40, qty: 5 }] }] }), 'order 5')
must(await call('POST', `/sales/orders/${so5.id}/confirm`, { creditReleaseReason: 'Demo test order' }), 'confirm 5')
const g5 = await receiveQcApprove({ customerId: A, soId: so5.id, warehouseId: WH, challanNumber: `BTH/DC/${tag}-5`, lines: [{ itemId: FAB, challanQty: 12, receivedQty: 12 }] })
await g5.qc()
must(await call('POST', `/inventory/customer-grn/${g5.rcv.id}/post`, {}), 'approval 5')
const k1 = await call('POST', `/sales/orders/${so5.id}/cancel`, { reason: 'Customer withdrew the order' })
check('E4', 'cancelling an order whose 12 m came in is refused until it goes back', k1.status === 409 && k1.body?.code === 'MATERIAL_UNACCOUNTED', err(k1))
const ret5 = await call('POST', '/inventory/customer-return', { customerId: A, warehouseId: WH, soId: so5.id, reason: 'LEFTOVER', lines: [{ itemId: FAB, qty: 12 }] })
await settleLabels('CUSTOMER_RETURN', ret5.body?.data?.id)
const k2 = await call('POST', `/sales/orders/${so5.id}/cancel`, { reason: 'Customer withdrew the order' })
check('E4', 'sent back, the order cancels', ret5.status === 201 && k2.status === 200, `${err(ret5)} ${err(k2)}`)

// (c) An order that does not bill our material takes no charge for it.
const so6 = must(await call('POST', '/sales/orders', { customerId: A, isJobWork: true, lines: [{ itemId: FG, totalQty: 4, unitPrice: 20, sizes: [{ sizeId: S38, qty: 2 }, { sizeId: S40, qty: 2 }] }] }), 'order 6')
must(await call('POST', `/sales/orders/${so6.id}/confirm`, { creditReleaseReason: 'Demo test order' }), 'confirm 6')
const so6Line = (await q(`SELECT id FROM sales_order_lines WHERE "soId"=$1`, [so6.id]))[0].id
must(await call('POST', '/finished-goods', { warehouseId: STORE, soId: so6.id, lines: [{ itemId: FG, sizeId: S38, qty: 2 }, { itemId: FG, sizeId: S40, qty: 2 }] }), 'FG 6')
const dc6 = must(await call('POST', '/sales/challans', { soId: so6.id, warehouseId: STORE, dispatch: true, lines: [{ soLineId: so6Line, sizes: [{ sizeId: S38, qty: 2 }, { sizeId: S40, qty: 2 }] }] }), 'DC 6')
const inv6 = await withCharge(() => call('POST', '/sales/invoices', { dcId: dc6.id, charges: [{ chargeTypeId: ct, amount: 50, ownMaterial: true }] }))
check('B1', 'an order whose job charge covers our trims refuses a trims charge', inv6.status === 400 && inv6.body?.code === 'OWN_MATERIAL_NOT_BILLED', err(inv6))
const so6Now = (await q(`SELECT status::text s FROM sales_orders WHERE id=$1`, [so6.id]))[0].s
check('B2', 'an order with no customer material of its own completes on full dispatch, as before', so6Now === 'COMPLETED', `status=${so6Now}`)

console.log(`\n${pass} passed, ${fail} failed`)
await db.end()
await exit(fail ? 1 : 0)
