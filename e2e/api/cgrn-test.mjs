// Customer GRN controls — scenario tests against the DEMO API (E2E_API, default 5101) and DEMO database (lderp_demo) only.
// Round 2 (16 Oct 2026): receiving → QC → stock approval; part rolls split onto new stickers.
import { randomUUID } from 'node:crypto'
import { API, demoDb, adminLogin, staffLogins, exit } from '../lib/demo.mjs'
const db = await demoDb()
const q = async (sql, p = []) => (await db.query(sql, p)).rows
const ADMIN = await adminLogin(db)
const { KEEPER, QC } = await staffLogins(ADMIN)
if (!ADMIN || !KEEPER || !QC) { console.log('login failed'); process.exit(1) }
const RUN = String(Date.now() % 1000000)
const call = async (m, p, b, tok = ADMIN) => {
  const r = await fetch(`${API}${p}`, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: b ? JSON.stringify(b) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
let pass = 0, fail = 0
const check = (id, name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${name}${extra && !ok ? `  — ${extra}` : ''}`) }
const err = (r) => `${r.status} ${r.body?.code ?? ''} ${(r.body?.message ?? '').slice(0, 200)}`

// Guard: demo only.
const guard = await q(`SELECT current_database() d`)
if (guard[0].d !== 'lderp_demo') { console.log('not the demo database'); process.exit(1) }

const A = 'cmth8dkwh00hvoijj4in66tuc' // Bengal Trend House
const B = 'cmth8djr900hloijjlgjml9gc' // Kanha Apparels
const RAJ = 'cmth8djiv00hjoijjqi0pzb5o' // Rajmandir Garments
const FG = 'cmv4ud8bu002awgu064gsx1hs'
const FAB = 'cmukzhguv0009kurg1huthki3' // ZZTEST Poplin Fabric (stickered)
const WH = 'cmth8dcgm00gpoijjnarcpvj3', JWG = 'cmth8dd4y00gvoijjanbj6sm0'
const DEPT = (await q(`SELECT id FROM departments LIMIT 1`))[0].id
// A job worker: one already on a challan, else Ambika Stitching Unit (a master).
const JW = (await q(`SELECT DISTINCT "jobWorkerId" id FROM job_work_challans LIMIT 1`))[0]?.id ?? 'cmth8didp00heoijjlp9o8aoh'
// A non-job-work order of Rajmandir's: one already in the demo, else a draft made for this run.
const RAJ_SO = (await q(`SELECT id FROM sales_orders WHERE "customerId"=$1 AND NOT "isJobWork" AND status <> 'CANCELLED' ORDER BY "createdAt" LIMIT 1`, [RAJ]))[0]?.id ?? (await (async () => {
  const r = await call('POST', '/sales/orders', { customerId: RAJ, isJobWork: false, customerPORef: `RAJ-PO-${RUN}`, lines: [{ itemId: FG, totalQty: 10, unitPrice: 450, sizes: [{ sizeId: 'cmth89v4e002moijjgegocwv0', qty: 5 }, { sizeId: 'cmth89vci002ooijj1otoy5u8', qty: 5 }] }] })
  if (r.status !== 201) { console.log('setup failed: a non-job-work order', err(r)); process.exit(1) }
  return r.body.data.id
})())
await q(`UPDATE items SET "packQty" = 10, "packType" = 'ROLL' WHERE id = $1`, [FAB])
// Demo fixture: earlier runs left this spot's stickers claiming more than the
// ledger holds (a typed issue whose labels window was never done). Settle it
// as the labels window would, so each run starts clean.
{
  const [l] = await q(`SELECT COALESCE(SUM("inQty"-"outQty"),0)::float8 b FROM stock_ledger WHERE "itemId"=$1 AND "warehouseId"=$2 AND ownership='CUSTOMER_OWNED' AND "ownerCustomerId"=$3 AND "sizeId" IS NULL AND grade IN ('A','R')`, [FAB, WH, A])
  const pks = await q(`SELECT id, qty::float8 q FROM stock_packages WHERE "itemId"=$1 AND "warehouseId"=$2 AND "ownerCustomerId"=$3 AND status='IN_STOCK' ORDER BY "createdAt"`, [FAB, WH, A])
  let over = pks.reduce((t, p) => t + p.q, 0) - Number(l.b)
  for (const p of pks) {
    if (over <= 0.0005) break
    const take = Math.min(p.q, over)
    await q(`UPDATE stock_packages SET qty = qty - $2, status = CASE WHEN qty - $2 <= 0.0005 THEN 'EMPTY'::ld_erp."PackageStatus" ELSE status END WHERE id = $1`, [p.id, take])
    over -= take
  }
}
const runStart = (await q(`SELECT now() t`))[0].t

const bal = async (grade, owner = A, item = FAB, wh = WH) =>
  Number((await q(`SELECT COALESCE(SUM("inQty"-"outQty"),0)::float8 b FROM stock_ledger WHERE "itemId"=$1 AND "warehouseId"=$2 AND ownership='CUSTOMER_OWNED' AND "ownerCustomerId"=$3 AND grade=$4`, [item, wh, owner, grade]))[0].b)
const rowsFor = async (ref) => Number((await q(`SELECT COUNT(*)::int n FROM stock_ledger WHERE "referenceId"=$1`, [ref]))[0].n)
const pkg = async (id) => (await q(`SELECT id, code, qty::float8 q, "initialQty"::float8 i, status, grade, rack, "printCount", "parentId", "warehouseId" FROM stock_packages WHERE id=$1`, [id]))[0]
const kids = async (id) => q(`SELECT id, code, qty::float8 q, "initialQty"::float8 i, status, grade, rack, "printCount", "warehouseId" FROM stock_packages WHERE "parentId"=$1 ORDER BY code`, [id])

// ── Setup: three job-work orders ──
const mkSo = async (customerId) => {
  const r = await call('POST', '/sales/orders', { customerId, isJobWork: true, lines: [{ itemId: FG, totalQty: 50, unitPrice: 20, sizes: [{ sizeId: 'cmth89v4e002moijjgegocwv0', qty: 20 }, { sizeId: 'cmth89vci002ooijj1otoy5u8', qty: 30 }] }] })
  if (r.status !== 201) { console.log('SO create failed', err(r)); process.exit(1) }
  return r.body.data
}
const SO_A1 = await mkSo(A), SO_A2 = await mkSo(A), SO_B = await mkSo(B)
console.log(`setup: ${SO_A1.soNumber} and ${SO_A2.soNumber} (Bengal, job work), ${SO_B.soNumber} (Kanha, job work)\n`)

const grnBody = (o) => ({ customerId: A, warehouseId: WH, challanNumber: `T-${Date.now() % 100000}`, lines: [{ itemId: FAB, challanQty: 100, receivedQty: 96 }], ...o })
// The flow as it runs now: receiving hands over, QC checks every line, an approver approves.
const receive = (o, tok = ADMIN) => call('POST', '/inventory/customer-grn', { action: 'SUBMIT', ...o }, tok)
const qcOf = (grn, rejects = [], tok = QC, extra = {}) =>
  call('POST', `/inventory/customer-grn/${grn.id}/inspect`, { lines: grn.lines.map((l, i) => ({ lineId: l.id, rejectedQty: rejects[i]?.qty ?? 0, rejectReason: rejects[i]?.reason ?? null })), inspectionNotes: 'Checked roll by roll', ...extra }, tok)
const approveGrn = (grn, tok = ADMIN) => call('POST', `/inventory/customer-grn/${grn.id}/post`, {}, tok)
async function receiveQcApprove(o, rejects = []) {
  const r = await receive(o, KEEPER)
  if (r.status !== 201) return r
  const c = await qcOf(r.body.data, rejects)
  if (c.status !== 200) return c
  return approveGrn(r.body.data)
}

// ── Q. Receiving → QC → stock approval ──
const usableBefore = await bal('A'), heldBefore = await bal('R')
const anyPost = await call('POST', '/inventory/customer-grn', grnBody({ action: 'POST' }))
check('Q1', 'no receipt goes into stock as it is received, not even an approver\'s', anyPost.status === 400 && anyPost.body?.code === 'QC_FIRST', err(anyPost))
const rx = await receive(grnBody({ soId: SO_A1.id, lines: [{ itemId: FAB, challanQty: 100, receivedQty: 96, rejectedQty: 6, rejectReason: 'Torn edge' }] }), KEEPER)
const G1r = rx.body?.data
check('Q2', 'the keeper receives 96 against a challan of 100 and hands it to QC', rx.status === 201 && G1r?.status === 'SUBMITTED', err(rx))
check('Q2', 'receiving records no rejects: that is QC\'s to say', Number(G1r?.lines?.[0]?.rejectedQty) === 0)
check('Q3', 'waiting for QC: nothing on the books, no stickers, nothing usable', (await rowsFor(G1r.id)) === 0 && Number((await q(`SELECT COUNT(*)::int n FROM stock_packages WHERE "sourceId"=$1`, [G1r.id]))[0].n) === 0 && (await bal('A')) === usableBefore)
const early = await approveGrn(G1r)
check('Q4', 'it cannot be approved into stock before QC', early.status === 409 && early.body?.code === 'QC_FIRST', err(early))
const own = await qcOf(G1r, [{ qty: 6, reason: 'Torn edge' }], KEEPER)
check('Q5', 'whoever received it does not QC it', own.status === 403 && own.body?.code === 'QC_NOT_RECEIVER', err(own))
const noReason = await qcOf(G1r, [{ qty: 6 }])
check('Q6', 'a reject needs its reason', noReason.status === 400, err(noReason))
const tooMany = await qcOf(G1r, [{ qty: 97, reason: 'All bad' }])
check('Q6', 'QC cannot reject more than arrived', tooMany.status === 400 && tooMany.body?.code === 'OVER_REJECTED', err(tooMany))
const qcApprove = await qcOf(G1r, [{ qty: 6, reason: 'Torn edge' }], QC, { approve: true })
check('Q7', 'QC without approval rights cannot approve it into stock', qcApprove.status === 403 && qcApprove.body?.code === 'NEEDS_APPROVER', err(qcApprove))
const qc1 = await qcOf(G1r, [{ qty: 6, reason: 'Torn edge' }])
check('Q8', 'QC records 6 rejected, torn edge: waiting for stock approval', qc1.status === 200 && qc1.body?.data?.status === 'INSPECTED' && qc1.body?.data?.inspectedBy?.name === 'ZZTEST QC Checker', err(qc1))
check('Q8', 'still nothing on the books after QC', (await rowsFor(G1r.id)) === 0)
const edit = await call('PATCH', `/inventory/customer-grn/${G1r.id}`, grnBody({ soId: SO_A1.id }), KEEPER)
check('Q9', 'once QC has checked it, receiving cannot change it', edit.status === 409 && edit.body?.code === 'NOT_EDITABLE', err(edit))
const sbQc = await call('POST', `/inventory/customer-grn/${G1r.id}/send-back`, { reason: 'Recheck the shade' }, QC)
check('Q10', 'only an approver sends it back from stock approval', sbQc.status === 403, err(sbQc))
const sb = await call('POST', `/inventory/customer-grn/${G1r.id}/send-back`, { reason: 'Recheck the shade of roll 4' })
check('Q10', 'an approver sends it back to QC; the old QC is cleared', sb.status === 200 && sb.body?.data?.status === 'SUBMITTED' && !sb.body?.data?.inspectedAt, err(sb))
const qc2 = await qcOf(G1r, [{ qty: 6, reason: 'Torn edge; shade fine' }])
const g1 = await approveGrn(G1r)
const G1 = g1.body?.data
check('T01', 'QC again, then approved into stock', qc2.status === 200 && g1.status === 200 && G1?.status === 'POSTED' && G1?.postedBy?.name, err(g1))
check('T01', '90 usable and 6 held, at no value', Math.abs((await bal('A')) - usableBefore - 90) < 1e-6 && Math.abs((await bal('R')) - heldBefore - 6) < 1e-6,
  `usable +${(await bal('A')) - usableBefore}, held +${(await bal('R')) - heldBefore}`)
const val = await q(`SELECT COALESCE(SUM(("inQty"-"outQty")*COALESCE("unitRate",0)),0)::float8 v FROM stock_ledger WHERE "referenceId"=$1`, [G1.id])
check('T01', 'no company value on customer stock', Number(val[0].v) === 0)
check('T01', 'shortage is 4, recorded as a variance only', Number(G1.lines[0].challanQty) - Number(G1.lines[0].receivedQty) === 4)

const pk = await q(`SELECT id, code, qty::float8 qty, grade, status FROM stock_packages WHERE "sourceId"=$1 ORDER BY "createdAt"`, [G1.id])
const pkA = pk.filter((p) => p.grade === 'A'), pkR = pk.filter((p) => p.grade === 'R')
check('T08', 'one sticker per roll: 9 usable of 10 + 1 held of 6', pkA.length === 9 && pkA.every((p) => p.qty === 10) && pkR.length === 1 && pkR[0].qty === 6, JSON.stringify(pk.map((p) => `${p.grade}${p.qty}`)))
check('T08', 'every sticker code distinct', new Set(pk.map((p) => p.code)).size === pk.length)
const dup = await q(`SELECT code FROM stock_packages GROUP BY code HAVING COUNT(*) > 1`)
check('T08', 'no sticker code anywhere is used twice', dup.length === 0)

// ── D. A keeper's receipt, corrected before QC, approved once ──
const ks = await receive(grnBody({ soId: SO_A2.id, lines: [{ itemId: FAB, challanQty: 30, receivedQty: 30 }] }), KEEPER)
const G3 = ks.body?.data
check('D1', 'a keeper hands a receipt over for QC', ks.status === 201 && G3?.status === 'SUBMITTED', err(ks))
const ke = await call('PATCH', `/inventory/customer-grn/${G3.id}`, grnBody({ soId: SO_A2.id, action: 'SUBMIT', lines: [{ itemId: FAB, challanQty: 30, receivedQty: 32 }] }), KEEPER)
check('D2', 'the count can still be corrected before QC', ke.status === 200 && Number(ke.body?.data?.lines?.[0]?.receivedQty) === 32, err(ke))
const G3b = ke.body.data
await qcOf(G3b)
const kpost = await approveGrn(G3b, KEEPER)
check('T27', 'a keeper cannot approve it into stock', kpost.status === 403, err(kpost))
const [ap1, ap2] = await Promise.all([approveGrn(G3b), approveGrn(G3b)])
const oks = [ap1, ap2].filter((r) => r.status === 200).length, dupe = [ap1, ap2].find((r) => r.status !== 200)
check('T20', 'two approvers at once: approved exactly once', oks === 1 && dupe?.body?.code === 'ALREADY_POSTED', `${ap1.status}/${ap2.status} ${err(dupe ?? ap1)}`)
check('T20', 'its stock written once (32 in)', Number((await q(`SELECT COALESCE(SUM("inQty"),0)::float8 n FROM stock_ledger WHERE "referenceId"=$1`, [G3.id]))[0].n) === 32)
const ed = await call('PATCH', `/inventory/customer-grn/${G3.id}`, grnBody({ soId: SO_A2.id, lines: [{ itemId: FAB, challanQty: 30, receivedQty: 1 }] }))
check('D3', 'a receipt in stock is not edited in place', ed.status === 409 && ed.body?.code === 'NOT_EDITABLE', err(ed))

const g2 = await receiveQcApprove(grnBody({ lines: [{ itemId: FAB, challanQty: 20, receivedQty: 20 }] }))
const G2 = g2.body?.data
check('T04', 'a receipt with no order is allowed, unassigned', g2.status === 200 && G2?.status === 'POSTED' && !G2.soId, err(g2))

// ── B. Ownership ──
const mr = (o) => call('POST', '/inventory/requisitions', { departmentId: DEPT, warehouseId: WH, lines: [{ itemId: FAB, requestedQty: 10, ownership: 'CUSTOMER_OWNED', ownerCustomerId: A }], ...o })
const r5 = await mr({ soId: SO_B.id })
check('T05', "Bengal's fabric refused for Kanha's order", r5.status === 400 && r5.body?.code === 'WRONG_OWNER', err(r5))
const r6 = await mr({})
check('T06', "Bengal's fabric refused with no order named", r6.status === 400 && r6.body?.code === 'NEEDS_ORDER', err(r6))
const r6b = await call('POST', '/inventory/requisitions', { departmentId: DEPT, warehouseId: WH, soId: RAJ_SO, lines: [{ itemId: FAB, requestedQty: 1, ownership: 'CUSTOMER_OWNED', ownerCustomerId: RAJ }] })
check('T06', 'customer material refused on a non-job-work order', r6b.status === 400 && r6b.body?.code === 'NOT_JOB_WORK', err(r6b))
if (JW) {
  const jw = (o) => call('POST', '/inventory/job-work', { jobWorkerId: JW, process: 'Washing', fromWarehouseId: WH, toWarehouseId: JWG, lines: [{ itemId: FAB, qty: 1, ownership: 'CUSTOMER_OWNED', ownerCustomerId: A }], ...o })
  const j1 = await jw({})
  check('T07', "Bengal's fabric refused on a job-work challan with no order", j1.status === 400 && j1.body?.code === 'NEEDS_ORDER', err(j1))
  const j2 = await jw({ soId: SO_B.id })
  check('T07', "…and on a challan for Kanha's order", j2.status === 400 && j2.body?.code === 'WRONG_OWNER', err(j2))
}

// ── C. Stickers, one-time issue, part rolls on new stickers ──
const ok = await mr({ soId: SO_A1.id, lines: [{ itemId: FAB, requestedQty: 40, ownership: 'CUSTOMER_OWNED', ownerCustomerId: A }] })
check('B1', "Bengal's fabric accepted for Bengal's job-work order", ok.status === 201, err(ok))
const MR = ok.body?.data, LINE = MR?.lines?.[0]?.id
const ap = await call('PATCH', `/inventory/requisitions/${MR.id}/approve`, {})
check('B1', 'requisition approved', ap.status === 200, err(ap))

const heldPkg = pkR[0]
const sh = await call('POST', `/packages/${heldPkg.id}/issue`, { mrId: MR.id, lineId: LINE, qty: 1 })
check('T02', 'a held (rejected) roll cannot be scanned out', sh.status === 409 && sh.body?.code === 'HELD', err(sh))
const heldNow = await bal('R')
const usable = await bal('A')
const want = usable + 1
const mrBig = await mr({ soId: SO_A1.id, lines: [{ itemId: FAB, requestedQty: want, ownership: 'CUSTOMER_OWNED', ownerCustomerId: A }] })
await call('PATCH', `/inventory/requisitions/${mrBig.body?.data?.id}/approve`, {})
const big = await call('POST', `/inventory/requisitions/${mrBig.body?.data?.id}/issue`, { lines: [{ lineId: mrBig.body?.data?.lines?.[0]?.id, issueQty: want, warehouseId: WH }] })
check('T02', `held stock is never issued: ${want} asked, only ${usable} usable (${heldNow} held)`, big.status >= 400 && (await bal('R')) === heldNow && (await bal('A')) === usable, err(big))
const M2 = MR, L2 = LINE
const [P1, P2, P3] = pkA
const ledgerOut = async () => Number((await q(`SELECT COALESCE(SUM("outQty"),0)::float8 n FROM stock_ledger WHERE "referenceId"=$1`, [M2.id]))[0].n)

const s1 = await call('POST', `/packages/${P1.id}/issue`, { mrId: M2.id, lineId: L2, qty: 10, requestId: randomUUID() })
check('T10', `first scan of ${P1.code} issues the whole roll once`, s1.status === 200 && (await ledgerOut()) === 10 && !s1.body?.data?.newSticker, err(s1))
const s1b = await call('POST', `/packages/${P1.id}/issue`, { mrId: M2.id, lineId: L2, qty: 10, requestId: randomUUID() })
check('T11', 'a second scan of the same roll is refused with where it went', s1b.status === 409 && s1b.body?.code === 'ALREADY_ISSUED' && /already issued/.test(s1b.body?.message ?? '') && (await ledgerOut()) === 10, err(s1b))
const rid = randomUUID()
const s2 = await call('POST', `/packages/${P2.id}/issue`, { mrId: M2.id, lineId: L2, qty: 4, requestId: rid })
const s2b = await call('POST', `/packages/${P2.id}/issue`, { mrId: M2.id, lineId: L2, qty: 4, requestId: rid })
check('T12', 'the same request sent again issues nothing more', s2.status === 200 && s2b.status === 200 && s2b.body?.repeat === true && (await ledgerOut()) === 14, `${err(s2b)} out=${await ledgerOut()}`)

// Part of a roll: the old sticker retires, the part issued and the rest get new ones.
const p2 = await pkg(P2.id), p2kids = await kids(P2.id)
const part = p2kids.find((k) => k.i === 4), rest = p2kids.find((k) => k.i === 6)
check('S1', `${P2.code} part-issued: its sticker is retired (nothing left on it)`, p2.status === 'SPLIT' && p2.q === 0, JSON.stringify(p2))
check('S1', 'the 4 issued is a sticker of its own, used up', part?.status === 'EMPTY' && part?.q === 0, JSON.stringify(p2kids))
check('S1', 'the 6 left is a new sticker on the same rack, waiting to be printed', rest?.status === 'IN_STOCK' && rest?.q === 6 && rest?.printCount === 0 && rest?.rack === p2.rack, JSON.stringify(rest))
check('S1', 'the issue says which sticker to print', s2.body?.data?.newSticker?.code === rest?.code && s2.body?.message?.includes(rest?.code), s2.body?.message)
const issuedMove = await q(`SELECT "referenceNumber" FROM stock_package_moves WHERE "packageId"=$1 AND type='ISSUED'`, [part.id])
check('S1', 'the issued part records the requisition it went to', issuedMove[0]?.referenceNumber === M2.mrNumber)
const ready = await call('GET', `/packages/ready`)
check('S1', 'the new sticker is on Ready to print', ready.body?.data?.groups?.some((g) => g.ids.includes(rest.id)), err(ready))
const look2 = await call('GET', `/packages/scan/${P2.code}`)
check('S2', 'scanning the retired sticker names its replacement', look2.body?.data?.status === 'SPLIT' && look2.body?.data?.replacedBy?.[0]?.code === rest.code, JSON.stringify(look2.body?.data?.replacedBy))
const old = await call('POST', `/packages/${P2.id}/issue`, { mrId: M2.id, lineId: L2, qty: 1, requestId: randomUUID() })
check('S2', 'the retired sticker cannot be issued from again, and says what to scan', old.status === 409 && old.body?.code === 'STICKER_RETIRED' && old.body?.message?.includes(rest.code) && (await ledgerOut()) === 14, err(old))

const [c1, c2] = await Promise.all([
  call('POST', `/packages/${P3.id}/issue`, { mrId: M2.id, lineId: L2, qty: 10, requestId: randomUUID() }),
  call('POST', `/packages/${P3.id}/issue`, { mrId: M2.id, lineId: L2, qty: 10, requestId: randomUUID() }),
])
check('T13', 'two scans of one roll at the same moment: one issue', [c1, c2].filter((r) => r.status === 200).length === 1 && (await ledgerOut()) === 24, `${c1.status}/${c2.status} out=${await ledgerOut()}`)
const same = await call('POST', `/packages/${P2.id}/issue`, { mrId: M2.id, lineId: L2, qty: 4, requestId: rid })
check('T12', 'a retried request id cannot be used for a different roll', same.body?.repeat === true && (await ledgerOut()) === 24)
const before14 = await ledgerOut()
const look = await call('GET', `/packages/scan/${P1.code}`)
check('T14', 'looking up a used sticker shows its history and moves nothing', look.status === 200 && look.body?.data?.status === 'EMPTY' && (await ledgerOut()) === before14, err(look))
const s3 = await call('POST', `/packages/${rest.id}/issue`, { mrId: M2.id, lineId: L2, qty: 6, requestId: randomUUID() })
const s3b = await call('POST', `/packages/${rest.id}/issue`, { mrId: M2.id, lineId: L2, qty: 1, requestId: randomUUID() })
check('T16', `part rolls: ${P2.code} gave 4, its new sticker ${rest.code} the other 6, then nothing`, s3.status === 200 && s3b.status === 409 && (await ledgerOut()) === 30, `${s3.status}/${s3b.status} out=${await ledgerOut()}`)
const fam = [await pkg(P2.id), ...(await kids(P2.id))]
check('T15', 'never more out of a roll than it held: 4 + 6 = 10, nothing left on any of its stickers', fam.every((p) => p.q === 0) && (await kids(P2.id)).reduce((t, k) => t + k.i, 0) === 10)
const corr = await call('POST', `/packages/${P1.id}/correct`, { qty: 10, reason: 'Found it again' })
check('T17', 'a used sticker cannot be brought back to life', corr.status === 409 && corr.body?.code === 'STICKER_USED', err(corr))
const P4 = pkA[3]
const lab = await call('GET', `/packages/labels?ids=${P1.id},${P4.id}`)
check('T17', 'a used sticker is not printed again', lab.status === 200 && lab.body?.data?.packages?.length === 1 && lab.body.data.skipped === 1, err(lab))
const fr = await call('POST', `/inventory/requisitions/${M2.id}/return`, { reason: 'Leftover', lines: [{ lineId: L2, qty: 3, warehouseId: WH }] })
const back = await q(`SELECT code, status FROM stock_packages WHERE "sourceType"='MR_RETURN' AND "sourceId"=$1`, [M2.id])
const p1now = (await q(`SELECT status FROM stock_packages WHERE id=$1`, [P1.id]))[0]
check('T17', 'leftover back from the floor gets a new sticker; the old one stays used', fr.status === 200 && back.length >= 1 && !back.some((b) => b.code === P1.code) && p1now.status === 'EMPTY', `${err(fr)} new=${back.map((b) => b.code)}`)

// Reprints keep the code.
for (let i = 0; i < 3; i++) await call('POST', '/packages/printed', { ids: [P4.id] })
const p4 = (await q(`SELECT code, "printCount" FROM stock_packages WHERE id=$1`, [P4.id]))[0]
const prints = Number((await q(`SELECT COUNT(*)::int n FROM stock_package_moves WHERE "packageId"=$1 AND type='PRINTED'`, [P4.id]))[0].n)
check('T09', 'three prints: same code, three logged with who and when', p4.code === P4.code && p4.printCount >= 3 && prints === 3, `count=${p4.printCount} logged=${prints}`)

// Kanha's 40 of the fabric, 4 rolls, every metre on a sticker: what goes out
// without a scan has to come off a roll.
const gk = await receiveQcApprove({ customerId: B, soId: SO_B.id, warehouseId: WH, challanNumber: `KAN-${RUN}`,lines: [{ itemId: FAB, challanQty: 40, receivedQty: 40 }] })
const K = await q(`SELECT id, code FROM stock_packages WHERE "sourceId"=$1 ORDER BY "createdAt", code`, [gk.body?.data?.id ?? ''])
check('SET', "Kanha's 40 in stock on 4 stickers", gk.status === 200 && K.length === 4, err(gk))

// A typed issue: the labels window takes part of a roll, onto new stickers.
const P5 = K[0]
const mr3 = await call('POST', '/inventory/requisitions', { departmentId: DEPT, warehouseId: WH, soId: SO_B.id, lines: [{ itemId: FAB, requestedQty: 3, ownership: 'CUSTOMER_OWNED', ownerCustomerId: B }] })
await call('PATCH', `/inventory/requisitions/${mr3.body.data.id}/approve`, {})
const typed = await call('POST', `/inventory/requisitions/${mr3.body.data.id}/issue`, { lines: [{ lineId: mr3.body.data.lines[0].id, issueQty: 3, warehouseId: WH }] })
const outw = await call('POST', '/packages/outward/apply', { type: 'MR', id: mr3.body.data.id, takes: [{ packageId: P5.id, qty: 3 }] })
const p5 = await pkg(P5.id), p5kids = await kids(P5.id)
check('S3', 'typed issue of 3, then the labels window: the roll\'s sticker retires', typed.status === 200 && outw.status === 200 && p5.status === 'SPLIT', `${err(typed)} ${err(outw)}`)
check('S3', '3 on a used-up sticker, 7 on a new one to print', p5kids.some((k) => k.i === 3 && k.status === 'EMPTY') && p5kids.some((k) => k.i === 7 && k.status === 'IN_STOCK' && outw.body?.data?.reprint?.includes(k.id)), JSON.stringify(p5kids))

// Moving part of a roll to another store.
const P6 = pkA[5]
const mv = await call('POST', `/packages/${P6.id}/transfer`, { toWarehouseId: JWG, qty: 4 })
const p6 = await pkg(P6.id), p6kids = await kids(P6.id)
const there = p6kids.find((k) => k.i === 4), here = p6kids.find((k) => k.i === 6)
check('S4', 'part of a roll moved: old sticker retired, 4 on a new sticker in the other store, 6 on a new one here', mv.status === 200 && p6.status === 'SPLIT' && there?.warehouseId === JWG && there?.status === 'IN_STOCK' && here?.warehouseId === WH && here?.status === 'IN_STOCK', `${err(mv)} ${JSON.stringify(p6kids)}`)
await call('POST', `/packages/${there.id}/transfer`, { toWarehouseId: WH, qty: 4 })

// Splitting by hand: whatever is not cut off gets a sticker too.
const P7 = pkA[6]
const sp = await call('POST', `/packages/${P7.id}/split`, { qtys: [3, 3] })
const p7 = await pkg(P7.id), p7kids = await kids(P7.id)
check('S5', 'a roll of 10 split 3 + 3: three new stickers (3, 3 and the 4 left), the old one retired', sp.status === 200 && p7.status === 'SPLIT' && p7kids.length === 3 && p7kids.map((k) => k.i).sort().join(',') === '3,3,4', `${err(sp)} ${JSON.stringify(p7kids)}`)

// ── A. Release and rejected return ──
const kr = await call('POST', `/inventory/customer-grn/${G1.id}/release`, { lineId: G1.lines[0].id, qty: 2, reason: 'Second look: usable' }, KEEPER)
check('T27', 'a keeper cannot release held material', kr.status === 403, err(kr))
const u0 = await bal('A'), h0 = await bal('R')
const rel = await call('POST', `/inventory/customer-grn/${G1.id}/release`, { lineId: G1.lines[0].id, qty: 2, reason: 'Second look: edges are fine' })
check('T03', 'an approver releases 2 from hold', rel.status === 200 && Math.abs((await bal('A')) - u0 - 2) < 1e-6 && Math.abs(h0 - (await bal('R')) - 2) < 1e-6, err(rel))
const hp = await pkg(heldPkg.id), hpKids = await kids(heldPkg.id)
check('T03', 'the held roll splits: its sticker retired, 2 released on one new sticker, 4 still held on another', hp.status === 'SPLIT' && hpKids.some((p) => p.grade === 'A' && p.q === 2) && hpKids.some((p) => p.grade === 'R' && p.q === 4), JSON.stringify(hpKids))
const over = await call('POST', `/inventory/customer-grn/${G1.id}/release`, { lineId: G1.lines[0].id, qty: 5, reason: 'Too much' })
check('T03', 'cannot release more than is held', over.status === 400 && over.body?.code === 'OVER_HELD', err(over))

const h1 = await bal('R')
const cmr = await call('POST', '/inventory/customer-return', { customerId: A, warehouseId: WH, grnId: G1.id, reason: 'REJECTED', lines: [{ itemId: FAB, qty: 4 }] })
check('T18', 'the held 4 go back to the customer as rejected', cmr.status === 201 && Math.abs(h1 - (await bal('R')) - 4) < 1e-6, err(cmr))
const heldPk = await q(`SELECT COUNT(*)::int n FROM stock_packages WHERE "sourceId"=$1 AND grade='R' AND status='IN_STOCK'`, [G1.id])
check('T18', 'their held stickers go with them', heldPk[0].n === 0)
const cmr2 = await call('POST', '/inventory/customer-return', { customerId: A, warehouseId: WH, grnId: G1.id, reason: 'REJECTED', lines: [{ itemId: FAB, qty: 1 }] })
check('T18', 'nothing more can go back as rejected than was held', cmr2.status === 400, err(cmr2))
const cc = await call('PATCH', `/inventory/customer-return/${cmr.body.data.id}/cancel`, { reason: 'Lorry did not leave' })
check('T18', 'cancelling that return puts the 4 back on hold, not into usable stock', cc.status === 200 && Math.abs((await bal('R')) - h1) < 1e-6, err(cc))

// A leftover return: its labels window takes part of a roll, onto new stickers.
const P8 = K[1]
const lo = await call('POST', '/inventory/customer-return', { customerId: B, warehouseId: WH, soId: SO_B.id, reason: 'LEFTOVER', lines: [{ itemId: FAB, qty: 2.5 }] })
const loOut = await call('POST', '/packages/outward/apply', { type: 'CUSTOMER_RETURN', id: lo.body?.data?.id, takes: [{ packageId: P8.id, qty: 2.5 }] })
const p8kids = await kids(P8.id)
check('S6', 'a leftover return of 2.5 from a roll of 10: 2.5 on a used-up sticker, 7.5 on a new one', lo.status === 201 && loOut.status === 200 && (await pkg(P8.id)).status === 'SPLIT' && p8kids.some((k) => k.i === 2.5 && k.status === 'EMPTY') && p8kids.some((k) => k.i === 7.5 && k.status === 'IN_STOCK'), `${err(lo)} ${err(loOut)} ${JSON.stringify(p8kids)}`)

// Stock out with no window at all (a count found less): the stickers come down by themselves.
const spot = async () => {
  const [l] = await q(`SELECT COALESCE(SUM("inQty"-"outQty"),0)::float8 b FROM stock_ledger WHERE "itemId"=$1 AND "warehouseId"=$2 AND ownership='CUSTOMER_OWNED' AND "ownerCustomerId"=$3 AND "sizeId" IS NULL AND grade='A'`, [FAB, WH, B])
  const [p] = await q(`SELECT COALESCE(SUM(qty),0)::float8 s FROM stock_packages WHERE "itemId"=$1 AND "warehouseId"=$2 AND "ownerCustomerId"=$3 AND status='IN_STOCK'`, [FAB, WH, B])
  return { book: Number(l.b), loose: Number(l.b) - Number(p.s) }
}
const sp0 = await spot()
const adj = await call('POST', '/inventory/adjustments', { warehouseId: WH, reason: 'Demo test: count found 1.5 less', lines: [{ itemId: FAB, countedQty: Math.round((sp0.book - 1.5) * 1000) / 1000, ownership: 'CUSTOMER_OWNED', ownerCustomerId: B }] })
const adjOk = await call('POST', `/inventory/adjustments/${adj.body?.data?.id}/approve`, {})
const adjMoves = await q(`SELECT m.type, m.qty::float8 q, p.code, p.status, p."parentId" FROM stock_package_moves m JOIN stock_packages p ON p.id=m."packageId" WHERE m."referenceId"=$1`, [adj.body?.data?.id ?? ''])
const adjDown = -adjMoves.filter((m) => m.type === 'ISSUED').reduce((t, m) => t + m.q, 0)
check('S7', `a count 1.5 short (book ${sp0.book}, nothing loose) takes 1.5 off the stickers by itself`, adj.status === 201 && adjOk.status === 200 && sp0.loose === 0 && Math.abs(adjDown - 1.5) < 1e-6, `${err(adj)} ${err(adjOk)} ${JSON.stringify(adjMoves)}`)
check('S7', '…by retiring a roll\'s sticker: 1.5 used up, the rest on a new one', adjMoves.some((m) => m.type === 'SPLIT') && adjMoves.some((m) => m.type === 'ISSUED' && m.status === 'EMPTY' && m.parentId))
const sp1 = await spot()
check('S7', "Kanha's stickers add up to the book again", Math.abs(sp1.loose) < 1e-6, JSON.stringify(sp1))

const cg = await call('PATCH', `/inventory/customer-grn/${G1.id}/cancel`, { reason: 'Test: should be refused' })
check('T19', 'a receipt whose material was issued cannot be cancelled', cg.status === 409, err(cg))

const corrG = await call('POST', `/inventory/customer-grn/${G2.id}/correct`, { reason: 'Wrong quantity typed' })
const g2after = (await q(`SELECT status FROM customer_grn WHERE id=$1`, [G2.id]))[0]
const g2net = Number((await q(`SELECT COALESCE(SUM("inQty"-"outQty"),0)::float8 n FROM stock_ledger WHERE "referenceId"=$1`, [G2.id]))[0].n)
check('D4', 'cancel & correct: the old one off the books, a linked draft in its place', corrG.status === 201 && g2after.status === 'CANCELLED' && g2net === 0 && corrG.body?.data?.status === 'DRAFT' && corrG.body?.data?.correctionOfId === G2.id, err(corrG))

// The one rule all of it keeps: a sticker on stock holds exactly what it was made with.
const shrunk = await q(`SELECT p.code, p.qty::float8 q, p."initialQty"::float8 i FROM stock_packages p WHERE p.status='IN_STOCK' AND p.qty <> p."initialQty" AND (p."createdAt" >= $1 OR p.id IN (SELECT "packageId" FROM stock_package_moves WHERE "createdAt" >= $1 AND type IN ('ISSUED','SPLIT','TRANSFERRED')))`, [runStart])
check('I1', 'no sticker on stock touched in this run holds less than it says', shrunk.length === 0, JSON.stringify(shrunk))

// ── Print, history, reconciliation ──
const pr = await call('GET', `/inventory/customer-grn/${G1.id}/print`)
check('T26', 'the receipt prints with its stickers and who checked and approved it', pr.status === 200 && pr.body?.data?.doc?.packages?.length >= 10 && pr.body?.data?.doc?.inspectedBy?.name && pr.body?.data?.doc?.postedBy?.name, err(pr))
const ls = await call('GET', '/inventory/customer-grn/lines')
check('T28', 'every receipt reads as one of the five statuses', ls.status === 200 && ls.body.data.every((l) => ['POSTED', 'CANCELLED', 'DRAFT', 'SUBMITTED', 'INSPECTED'].includes(l.status)), err(ls))

const rc = await call('GET', `/sales/orders/${SO_A1.id}/reconciliation`)
const f1 = rc.body?.data?.fabric?.find((f) => f.item.id === FAB)
check('T21', `${SO_A1.soNumber}: only its own receipt counts (96)`, rc.status === 200 && f1?.received === 96, JSON.stringify(f1 && { r: f1.received, iss: f1.issuedNet, left: f1.leftForOrder, other: f1.otherOrdersReceived }))
const others = Number((await q(`SELECT COALESCE(SUM(l."receivedQty"),0)::float8 n FROM customer_grn_lines l JOIN customer_grn g ON g.id=l."grnId" WHERE g."customerId"=$1 AND g.status='POSTED' AND g."soId" IS NOT NULL AND g."soId"<>$2 AND l."itemId"=$3`, [A, SO_A1.id, FAB]))[0].n)
check('T21', `…and other orders' receipts (${others}, incl. ${SO_A2.soNumber}'s 32) shown as theirs, not this one's`, f1?.otherOrdersReceived === others && others >= 32)
const rc2 = await call('GET', `/sales/orders/${SO_A2.id}/reconciliation`)
const f2 = rc2.body?.data?.fabric?.find((f) => f.item.id === FAB)
check('T21', `${SO_A2.soNumber}: its own 32, none issued, nothing double counted`, f2?.received === 32 && f2?.issuedNet === 0 && f2?.leftForOrder === 32, JSON.stringify(f2 && { r: f2.received, left: f2.leftForOrder }))

const purch = await call('GET', '/purchase/grn?limit=1')
check('T29', 'purchase goods receipts still list', purch.status === 200, err(purch))

console.log(`\n${pass} passed, ${fail} failed`)
await db.end()
await exit(fail ? 1 : 0)
