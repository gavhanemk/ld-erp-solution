// Customer receipts from a sheet: no QC, the store imports, an approver approves in bulk.
// DEMO API (E2E_API, default 5101) and DEMO database (lderp_demo) only (16 Oct 2026).
import { API, demoDb, adminLogin, staffLogins, exit } from '../lib/demo.mjs'
const db = await demoDb()
const q = async (sql, p = []) => (await db.query(sql, p)).rows
const ADMIN = await adminLogin(db)
const { KEEPER, QC } = await staffLogins(ADMIN)
if (!ADMIN || !KEEPER || !QC) { console.log('login failed'); process.exit(1) }
const call = async (m, p, b, tok = ADMIN) => {
  const r = await fetch(`${API}${p}`, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: b ? JSON.stringify(b) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
let pass = 0, fail = 0
const check = (id, name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${name}${extra && !ok ? `  — ${extra}` : ''}`) }
const err = (r) => `${r.status} ${r.body?.code ?? ''} ${(r.body?.message ?? '').slice(0, 200)}`

if ((await q(`SELECT current_database() d`))[0].d !== 'lderp_demo') { console.log('not the demo database'); process.exit(1) }

const A = 'cmth8dkwh00hvoijj4in66tuc' // Bengal Trend House
const B = 'cmth8djr900hloijjlgjml9gc' // Kanha Apparels Pvt Ltd
const FAB = 'cmukzhguv0009kurg1huthki3' // COT-003
const WH = 'cmth8dcgm00gpoijjnarcpvj3' // Fabric Warehouse
const tag = `IMP${Date.now() % 1000000}`

/** A sheet as the import reads it: headings by name, one row an item. */
const sheet = (rows) => {
  const head = ['Customer', 'Store', 'Their Challan No', 'Item Code', 'Their Challan Qty', 'Arrived Qty', 'Rejected Qty', 'Reject Reason']
  const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
  return { fileName: `${tag}.csv`, file: Buffer.from(csv).toString('base64') }
}
const good = sheet([
  ['Bengal Trend House', 'Fabric Warehouse', `${tag}-1`, 'COT-003', 50, 50, '', ''],
  ['Bengal Trend House', 'Fabric Warehouse', `${tag}-2`, 'COT-003', 40, 38, 3, 'Stained'],
  ['Kanha Apparels Pvt Ltd', 'Fabric Warehouse', `${tag}-3`, 'COT-003', 20, 20, '', ''],
  ['Bengal Trend House', 'Fabric Warehouse', `${tag}-4`, 'COT-003', 10, 10, '', ''],
])
const ledgerRows = async (id) => Number((await q(`SELECT COUNT(*)::int n FROM stock_ledger WHERE "referenceId"=$1`, [id]))[0].n)
const stickers = async (id) => Number((await q(`SELECT COUNT(*)::int n FROM stock_packages WHERE "sourceType"='CUSTOMER_GRN' AND "sourceId"=$1`, [id]))[0].n)
const grn = async (id) => (await q(`SELECT id, "grnNumber", status, "inspectedAt", "inspectedById", "postedAt", "postedById", "receivedById", "inspectionNotes" FROM customer_grn WHERE id=$1`, [id]))[0]

// ── Checking the sheet ──
const noReason = await call('POST', '/inventory/customer-grn/import', sheet([['Bengal Trend House', 'Fabric Warehouse', `${tag}-x`, 'COT-003', 10, 10, 2, '']]), KEEPER)
check('I1', 'A rejected quantity with no reason is a problem on that row', noReason.status === 200 && noReason.body?.data?.summary?.problems === 1 && /Reject Reason/.test(JSON.stringify(noReason.body?.data?.rows)), err(noReason))
const look = await call('POST', '/inventory/customer-grn/import', good, KEEPER)
check('I2', 'The store can check a sheet: 4 receipts, no problems', look.status === 200 && look.body?.data?.summary?.receipts === 4 && look.body?.data?.summary?.problems === 0, err(look))

// ── The store imports: nothing is in stock ──
const imp = await call('POST', '/inventory/customer-grn/import', { ...good, confirm: true }, KEEPER)
const made = imp.body?.data?.created ?? []
check('I3', 'Someone who is not an approver can import the sheet', imp.status === 201 && made.length === 4, err(imp))
check('I4', 'The answer gives each new receipt its id', made.every((c) => typeof c.id === 'string' && c.id.length > 10))
check('I5', 'The message says they wait for stock approval', /wait for stock approval/.test(imp.body?.message ?? ''), imp.body?.message)
const rows = await Promise.all(made.map((c) => grn(c.id)))
check('I6', 'Every imported receipt waits for stock approval (INSPECTED)', rows.every((g) => g?.status === 'INSPECTED'), rows.map((g) => g?.status).join(','))
check('I7', 'No QC is on record for them, and the note says they came from a sheet', rows.every((g) => !g.inspectedAt && !g.inspectedById && /Imported from .*no QC/.test(g.inspectionNotes ?? '')))
check('I8', 'Nothing reached the stock ledger and no stickers were made', (await Promise.all(made.map((c) => ledgerRows(c.id)))).every((n) => n === 0) && (await Promise.all(made.map((c) => stickers(c.id)))).every((n) => n === 0))
const lines2 = await q(`SELECT "rejectedQty"::float8 r, "rejectReason" FROM customer_grn_lines WHERE "grnId"=$1`, [made[1].id])
check('I9', "The sheet's rejected quantity and its reason are on the receipt", lines2[0]?.r === 3 && lines2[0]?.rejectReason === 'Stained', JSON.stringify(lines2))
const again = await call('POST', '/inventory/customer-grn/import', { ...good, confirm: true }, KEEPER)
check('I10', 'Importing the same sheet again makes nothing (its challans are already in)', again.status === 201 && (again.body?.data?.created ?? []).length === 0, err(again))

// ── Approving in bulk ──
const ids = made.map((c) => c.id)
const byKeeper = await call('POST', '/inventory/customer-grn/post-many', { ids }, KEEPER)
check('I11', 'The store cannot approve them', byKeeper.status === 403, err(byKeeper))
const byQc = await call('POST', '/inventory/customer-grn/post-many', { ids }, QC)
check('I12', 'Nor can QC without approval rights', byQc.status === 403, err(byQc))
const empty = await call('POST', '/inventory/customer-grn/post-many', { ids: [] })
check('I13', 'Approving none is refused', empty.status === 400, err(empty))

// One that cannot go in: its customer switched off since the import. The rest still go in.
// A draft receipt: one already in the demo, else one made for this run.
const draft = (await q(`SELECT id, "grnNumber" FROM customer_grn WHERE status='DRAFT' AND "cancelledAt" IS NULL LIMIT 1`))[0] ??
  (await call('POST', '/inventory/customer-grn', { action: 'DRAFT', customerId: A, warehouseId: WH, challanNumber: `${tag}-draft`, lines: [{ itemId: FAB, challanQty: 1, receivedQty: 1 }] })).body?.data
await q(`UPDATE customers SET "isActive"=false WHERE id=$1`, [B])
let bulk
try {
  bulk = await call('POST', '/inventory/customer-grn/post-many', { ids: [ids[0], ids[1], ids[2], draft.id, 'no-such-receipt'] })
} finally {
  await q(`UPDATE customers SET "isActive"=true WHERE id=$1`, [B])
}
const ok = bulk.body?.data?.approved ?? [], no = bulk.body?.data?.refused ?? []
check('I14', 'An approver approves several at once: the two that can go in, go in', bulk.status === 200 && ok.length === 2 && ok.every((a) => [ids[0], ids[1]].includes(a.id)), err(bulk) + ' ' + JSON.stringify(bulk.body?.data))
check('I15', 'The rest are listed with why: customer switched off, a draft, one that does not exist', no.length === 3 && /switched off/.test(no.find((r) => r.id === ids[2])?.message ?? '') && /still being received|QC/.test(no.find((r) => r.id === draft.id)?.message ?? '') && /does not exist/.test(no.find((r) => r.id === 'no-such-receipt')?.message ?? ''), JSON.stringify(no))
check('I16', 'The message counts both', /2 receipts approved/.test(bulk.body?.message ?? '') && /3 could not be/.test(bulk.body?.message ?? ''), bulk.body?.message)
const after = await Promise.all(ids.map(grn))
check('I17', 'Approved ones are POSTED with who and when; the refused one still waits', after[0].status === 'POSTED' && after[1].status === 'POSTED' && after[0].postedById && after[0].postedAt && after[2].status === 'INSPECTED' && after[3].status === 'INSPECTED')
check('I18', 'Approved ones reached the ledger; the refused one did not', (await ledgerRows(ids[0])) > 0 && (await ledgerRows(ids[1])) > 0 && (await ledgerRows(ids[2])) === 0)
const graded = await q(`SELECT grade, SUM("inQty")::float8 q FROM stock_ledger WHERE "referenceId"=$1 GROUP BY grade ORDER BY grade`, [ids[1]])
check('I19', 'What was rejected on the sheet is held apart (grade R), the rest usable (grade A)', graded.find((g) => g.grade === 'A')?.q === 35 && graded.find((g) => g.grade === 'R')?.q === 3, JSON.stringify(graded))
check('I20', 'Their stickers were made, ready to print', (await stickers(ids[0])) > 0 && (await stickers(ids[1])) > 0)
const audits = Number((await q(`SELECT COUNT(*)::int n FROM audit_logs WHERE "entityId" = ANY($1) AND action='APPROVE'`, [[ids[0], ids[1]]]))[0].n)
check('I21', 'Each approval is in the audit trail', audits === 2, `audits ${audits}`)

// Twice is once.
const ledgerBefore = (await ledgerRows(ids[0])) + (await ledgerRows(ids[1]))
const twice = await call('POST', '/inventory/customer-grn/post-many', { ids: [ids[0], ids[1]] })
check('I22', 'Approving them again books nothing: both refused as already in stock', twice.status === 200 && (twice.body?.data?.approved ?? []).length === 0 && (twice.body?.data?.refused ?? []).every((r) => /already/.test(r.message)), err(twice))
check('I23', 'No second set of ledger rows', (await ledgerRows(ids[0])) + (await ledgerRows(ids[1])) === ledgerBefore)

// With the customer back on, the one left goes in.
const rest = await call('POST', '/inventory/customer-grn/post-many', { ids: [ids[2]] })
check('I24', 'The refused one goes in once its customer is switched back on', rest.status === 200 && (rest.body?.data?.approved ?? []).length === 1 && (await grn(ids[2])).status === 'POSTED', err(rest))

// A wrong one goes back to receiving, not to QC.
const back = await call('POST', `/inventory/customer-grn/${ids[3]}/send-back`, { reason: 'Wrong challan number on the sheet', to: 'RECEIVING' })
check('I25', 'A wrong imported receipt goes back to receiving as a draft', back.status === 200 && (await grn(ids[3])).status === 'DRAFT', err(back))

// The single approve still works on a QC-checked receipt; post-many is the same rule.
const single = await call('POST', `/inventory/customer-grn/${ids[3]}/post`, {})
check('I26', 'A draft cannot be approved one at a time either', single.status === 409 && single.body?.code === 'QC_FIRST', err(single))

console.log(`\n${pass} passed, ${fail} failed`)
await db.end()
await exit(fail ? 1 : 0)
