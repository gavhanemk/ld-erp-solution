// Sales, quotation to cash — scenario tests against the DEMO API (E2E_API, default 5101) and DEMO database (lderp_demo) only.
//
// Each run makes its own quotations, orders, finished goods, challans,
// invoices, receipts and credit notes, so it can run again and again. The
// garments are LD Cotton Mills styles: Kingsley Twill Chino in Khaki
// (LD-TR-2602, HSN 6203) and the Bexley Stripe Shirt in Grey Stripe
// (LD-SH-2604, HSN 6205: 5%, or 18% above ₹2,500 a piece). They are sold to
// Orient Overseas Sourcing (Maharashtra, the company's own state: CGST + SGST)
// and Metro Menswear Wholesale (Delhi: IGST). A test customer of its own,
// ZZTEST Credit Watch Buyer, made once through the masters API, carries the
// credit-limit and blacklist cases. Every money figure is worked out here the
// way the business prices it and compared with what the API saved. SQL only
// reads, but for one step that moves an invoice's dates back to stand in for
// time passing; everything else is written through the API, as a user would.
//
// NOTE lines are observations for the reader. They are not checks and do not count.
import { API, WEB, demoDb, adminLogin, staffLogins, exit } from '../lib/demo.mjs'
const db = await demoDb()
const q = async (sql, p = []) => (await db.query(sql, p)).rows
if ((await q(`SELECT current_database() d`))[0].d !== 'lderp_demo') { console.log('not the demo database'); process.exit(1) }
const ADMIN = await adminLogin(db)
const { KEEPER, SALES } = await staffLogins(ADMIN)
if (!ADMIN || !KEEPER || !SALES) { console.log('login failed'); process.exit(1) }
const RUN = String(Date.now() % 1000000)
const call = async (m, p, b, tok = ADMIN) => {
  const r = await fetch(`${API}${p}`, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: b ? JSON.stringify(b) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
let pass = 0, fail = 0, skip = 0
const check = (id, name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${name}${extra && !ok ? `  — ${extra}` : ''}`) }
const skipped = (id, name, why) => { skip++; console.log(`SKIP  ${id.padEnd(5)} ${name}  — ${why}`) }
const note = (id, text) => console.log(`NOTE  ${id.padEnd(5)} ${text}`)
const err = (r) => `${r.status} ${r.body?.code ?? ''} ${(r.body?.message ?? JSON.stringify(r.body?.errors ?? '')).slice(0, 240)}`
const must = (r, what) => { if (!r || r.status >= 300) { console.log(`setup failed: ${what}: ${r ? err(r) : 'nothing to work on'}`); process.exit(1) } return r.body.data }
const one = async (sql, p, what) => { const r = (await q(sql, p))[0]; if (!r) { console.log(`setup failed: ${what} is not in the demo`); process.exit(1) } return r }

const r2 = (n) => Math.round(n * 100) / 100
const N = (v) => Number(v ?? 0)
const near = (a, b, tol = 0.005) => Math.abs(N(a) - N(b)) <= tol
const sum = (xs, f = (x) => x) => xs.reduce((s, x) => s + f(x), 0)
// Dates relative to today, at local noon.
const day = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(12, 0, 0, 0); return d }
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ── Setup: the demo's masters, looked up by name ──
const STORE = await one(`SELECT id, name FROM warehouses WHERE name = 'Store' AND "isActive"`, [], 'the store named "Store"')
const garment = (code, style, colour) => one(
  `SELECT i.id, i.code, i.name, i."hsnCode" hsn, s.code style, s."brandType" brand, s."sizeGroupId" grp,
     (SELECT b."costPerPiece"::float8 FROM bom b WHERE b."styleId" = s.id AND b.status = 'APPROVED' AND lower(b.color) = lower($3) ORDER BY b."approvedAt" DESC NULLS LAST LIMIT 1) cost
   FROM items i JOIN styles s ON s.id = i."styleId" WHERE i.code = $1 AND s.code = $2 AND i."isActive"`, [code, style, colour], `${code} (${style})`)
const TRO = await garment('TRO-001', 'LD-TR-2602', 'Khaki'), SHI = await garment('SHI-002', 'LD-SH-2604', 'Grey Stripe')
if ([TRO, SHI].some((g) => g.brand !== 'LD_COTTON_MILLS')) { console.log('setup failed: a test garment is not an LD Cotton Mills style'); process.exit(1) }
// A plain LD shirt with no style and no size run: sold by the piece, valued at its standard rate.
const FGS = await one(`SELECT id, code, name, "hsnCode" hsn, "standardRate"::float8 std FROM items WHERE code = 'FG-SHRT-001' AND type = 'FINISHED_GOOD' AND "styleId" IS NULL AND "isActive" AND name NOT ILIKE '%vhagar%'`, [], 'FG-SHRT-001')
const sizesOf = async (grp) => Object.fromEntries((await q(`SELECT code, id FROM sizes WHERE "sizeGroupId" = $1`, [grp])).map((r) => [r.code, r.id]))
const TS = await sizesOf(TRO.grp), SS = await sizesOf(SHI.grp)
const customer = (name) => one(`SELECT id, name, "billingStateCode" state, "creditDays" days, gstin FROM customers WHERE name = $1 AND "isActive" AND NOT "isBlacklisted"`, [name], name)
const ORIENT = await customer('Orient Overseas Sourcing'), METRO = await customer('Metro Menswear Wholesale')
const BANK = await one(`SELECT id FROM bank_accounts WHERE "accountName" = 'LD Cotton Mills — Current' AND "isActive"`, [], 'the current account')
const TRANSPORT = await one(`SELECT id, "defaultGstRate"::float8 rate FROM charge_types WHERE name = 'Transport Charges' AND "isActive" AND "applyOnSale"`, [], 'Transport Charges')
const CO = await one(`SELECT "stateCode" state, gstin, "bankAccount", "bankIFSC" FROM company LIMIT 1`, [], 'the company')
const HSN = Object.fromEntries((await q(`SELECT code, "gstRate"::float8 rate, "priceLimit"::float8 lim, "rateAbove"::float8 above FROM hsn_codes WHERE "isActive"`)).map((h) => [h.code, h]))
const rateFor = (code, perPiece) => { const h = HSN[code]; return h.lim != null && h.above != null && perPiece > h.lim ? h.above : h.rate }
const userId = async (email) => (await one(`SELECT id FROM users WHERE lower(email) = $1`, [email], email)).id
const SALES_ID = await userId('zztest.sales@ldcottonmills.com')
const ADMIN_ID = await userId(process.env.E2E_EMAIL.toLowerCase())
if (ORIENT.state !== CO.state || METRO.state === CO.state) { console.log(`setup failed: expected Orient in the company's state (${CO.state}) and Metro outside it`); process.exit(1) }

// The test customer for the credit cases: made once, reset every run.
const CW_NAME = 'ZZTEST Credit Watch Buyer', CW_LIMIT = 20000
let CW = (await q(`SELECT id FROM customers WHERE name = $1`, [CW_NAME]))[0]
if (!CW) {
  CW = must(await call('POST', '/masters/customers', { name: CW_NAME, type: 'DOMESTIC', billingAddress: 'Demo test customer for the credit-limit and blacklist cases', billingCity: 'Bhiwandi', billingStateCode: '27', creditLimit: CW_LIMIT, creditDays: 30 }), 'the test customer')
  console.log(`setup: made the test customer ${CW_NAME}`)
}
must(await call('PATCH', `/masters/customers/${CW.id}`, { isActive: true, isBlacklisted: false, creditLimit: CW_LIMIT, creditDays: 30 }), 'reset the test customer')
// Orders an earlier, interrupted run left open would count against its limit.
for (const o of await q(`SELECT id FROM sales_orders WHERE "customerId" = $1 AND status IN ('CONFIRMED','IN_PRODUCTION','PARTIALLY_DISPATCHED')`, [CW.id])) {
  await call('POST', `/sales/orders/${o.id}/cancel`, { reason: 'Left open by an earlier test run' })
}

// Reads: stock by size, a series' last number, an invoice as stored.
const bal = async (itemId, sizeId, grade = 'A', wh = STORE.id) =>
  Number((await q(`SELECT COALESCE(SUM("inQty"-"outQty"),0)::float8 b FROM stock_ledger WHERE "itemId"=$1 AND "warehouseId"=$2 AND "sizeId" IS NOT DISTINCT FROM $3 AND grade=$4 AND ownership='OWNED'`, [itemId, wh, sizeId, grade]))[0].b)
const series = async (doc) => Number((await q(`SELECT "lastNumber" n FROM number_series WHERE "docType"=$1 AND "isActive" ORDER BY "financialYear" DESC LIMIT 1`, [doc]))[0]?.n ?? -1)
const invRow = async (id) => (await q(`SELECT status, "totalAmount"::float8 total, "paidAmount"::float8 paid, "tdsAmount"::float8 tds, "creditedAmount"::float8 credited, "balanceAmount"::float8 balance FROM sales_invoices WHERE id=$1`, [id]))[0]
const getOrder = async (id) => (await call('GET', `/sales/orders/${id}`)).body?.data
const lineOf = (order, itemId) => order?.lines?.find((l) => l.itemId === itemId)
const sizeOf = (line, sizeId) => line?.sizes?.find((s) => s.sizeId === sizeId)
const sizes = (map, codes) => Object.entries(codes).map(([code, qty]) => ({ sizeId: map[code], qty }))

// The business's pricing, worked out independently of the API.
// A charge billed with the goods takes the goods' rate, shared across their
// rates by taxable value, the biggest share taking the rounding paisa.
function chargeParts(amount, goods) {
  const by = new Map()
  for (const g of goods) if (g.taxable > 0) by.set(g.rate, (by.get(g.rate) ?? 0) + g.taxable)
  const total = sum([...by.values()])
  const parts = [...by.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([rate, t]) => ({ rate, amount: r2((amount * t) / total) }))
  const drift = r2(amount - sum(parts, (x) => x.amount))
  if (drift) parts[0].amount = r2(parts[0].amount + drift)
  return parts.filter((x) => x.amount !== 0)
}
const taxParts = (parts, intra) => parts.map((x) => { const tax = (x.amount * x.rate) / 100; return { cgst: intra ? r2(tax / 2) : 0, sgst: intra ? r2(tax / 2) : 0, igst: intra ? 0 : r2(tax) } })
function priceOrder({ lines, discountAmount = 0, charges = [], intra }) {
  const lt = lines.map((l) => l.qty * l.price * (1 - (l.disc ?? 0) / 100))
  const subtotal = r2(sum(lt))
  const discount = r2(Math.min(discountAmount, subtotal))
  const taxable = r2(subtotal - discount)
  const f = subtotal > 0 ? taxable / subtotal : 1
  const rates = lines.map((l) => rateFor(l.hsn, l.price * (1 - (l.disc ?? 0) / 100) * f))
  let cgst = 0, sgst = 0, igst = 0
  lines.forEach((_, i) => { const tax = (lt[i] * f * rates[i]) / 100; if (intra) { cgst += tax / 2; sgst += tax / 2 } else igst += tax })
  const goods = lines.map((_, i) => ({ taxable: lt[i] * f, rate: rates[i] }))
  const ch = charges.map((c) => { const t = taxParts(chargeParts(c.amount, goods), intra); return { amount: c.amount, cgst: r2(sum(t, (x) => x.cgst)), sgst: r2(sum(t, (x) => x.sgst)), igst: r2(sum(t, (x) => x.igst)) } })
  cgst = r2(cgst + sum(ch, (c) => c.cgst)); sgst = r2(sgst + sum(ch, (c) => c.sgst)); igst = r2(igst + sum(ch, (c) => c.igst))
  const raw = taxable + r2(sum(ch, (c) => c.amount)) + cgst + sgst + igst
  const total = Math.round(raw)
  return { subtotal, discount, taxable, rates, cgst, sgst, igst, total, roundOff: Number((total - raw).toFixed(2)) }
}
function priceInvoice({ lines, orderSubtotal, orderDiscount, charges = [], intra }) {
  const gross = lines.map((l) => r2(l.qty * l.price * (1 - (l.disc ?? 0) / 100)))
  const subtotal = r2(sum(gross))
  const discount = orderSubtotal > 0 ? r2(Math.min(subtotal, (orderDiscount * subtotal) / orderSubtotal)) : 0
  const taxable = r2(subtotal - discount)
  const f = subtotal > 0 ? taxable / subtotal : 1
  const ls = lines.map((l, i) => { const tv = r2(gross[i] * f); const tax = (tv * l.rate) / 100; return { key: l.key, tv, cgst: intra ? r2(tax / 2) : 0, sgst: intra ? r2(tax / 2) : 0, igst: intra ? 0 : r2(tax) } })
  const goods = ls.map((l, i) => ({ taxable: l.tv, rate: lines[i].rate }))
  const ch = charges.flatMap((c) => taxParts(chargeParts(c.amount, goods), intra).map((t, k, all) => ({ amount: k === 0 ? c.amount : 0, ...t })))
  const cgst = r2(sum(ls, (l) => l.cgst) + sum(ch, (c) => c.cgst)), sgst = r2(sum(ls, (l) => l.sgst) + sum(ch, (c) => c.sgst)), igst = r2(sum(ls, (l) => l.igst) + sum(ch, (c) => c.igst))
  const raw = taxable + r2(sum(ch, (c) => c.amount)) + cgst + sgst + igst
  const total = Math.round(raw)
  return { subtotal, discount, taxable, lines: ls, cgst, sgst, igst, total, roundOff: Number((total - raw).toFixed(2)) }
}
const showMoney = (saved, want, keys) => keys.map((k) => `${k} ${N(saved?.[k])}/${want[k]}`).join(', ')

console.log(`setup: run ${RUN}; ${TRO.code} ${TRO.name}, ${SHI.code} ${SHI.name}; ${ORIENT.name} (${ORIENT.state}), ${METRO.name} (${METRO.state}); store ${STORE.name}\n`)

// ════════════════ Q. Quotations ════════════════
const qa = await call('POST', '/sales/quotations', { customerId: ORIENT.id, customerRef: `ORS-ENQ-${RUN}`, validUntil: day(15).toISOString(), lines: [{ itemId: SHI.id, qty: 50, unitPrice: 450 }] }, SALES)
const QA = qa.body?.data
const qaWant = priceOrder({ lines: [{ qty: 50, price: 450, hsn: SHI.hsn }], intra: true })
check('Q1', 'a quotation is saved as a draft by the sales user', qa.status === 201 && QA?.status === 'DRAFT', err(qa))
check('Q1', `priced as an order is: ₹22,500 at 5% (HSN ${SHI.hsn}), CGST + SGST, ₹${qaWant.total}`, QA && near(QA.taxableAmount, qaWant.taxable) && near(QA.cgst, qaWant.cgst) && near(QA.sgst, qaWant.sgst) && N(QA.igst) === 0 && near(QA.totalAmount, qaWant.total) && N(QA.lines?.[0]?.gstRate) === 5 && QA.lines?.[0]?.hsnCode === SHI.hsn, JSON.stringify(QA && { t: QA.taxableAmount, c: QA.cgst, s: QA.sgst, i: QA.igst, tot: QA.totalAmount, r: QA.lines?.[0]?.gstRate }))
check('Q1', `each line keeps the BOM cost per piece (₹${SHI.cost})`, QA && near(QA.lines?.[0]?.bomCost, SHI.cost), JSON.stringify(QA?.lines?.[0]?.bomCost))
const qaSent = await call('POST', `/sales/quotations/${QA?.id}/sent`, {}, SALES)
check('Q2', 'marked sent', qaSent.status === 200 && qaSent.body?.data?.status === 'SENT' && !!qaSent.body?.data?.sentAt, err(qaSent))
const qaLost = await call('POST', `/sales/quotations/${QA?.id}/lost`, { reason: 'Buyer took a cheaper offer' }, SALES)
check('Q3', 'marked lost, with why', qaLost.status === 200 && qaLost.body?.data?.status === 'LOST' && qaLost.body?.data?.lostReason === 'Buyer took a cheaper offer' && !!qaLost.body?.data?.decidedAt, err(qaLost))
const qaLost2 = await call('POST', `/sales/quotations/${QA?.id}/lost`, { reason: 'Again' }, SALES)
const qaEdit = await call('PATCH', `/sales/quotations/${QA?.id}`, { customerId: ORIENT.id, lines: [{ itemId: SHI.id, qty: 50, unitPrice: 440 }] }, SALES)
check('Q4', 'a lost quotation cannot be lost again or changed', qaLost2.status === 409 && qaEdit.status === 409 && qaEdit.body?.code === 'DECIDED', `${err(qaLost2)} / ${err(qaEdit)}`)
const soBefore = await series('SO')
const fromLost = await call('POST', '/sales/orders', { customerId: ORIENT.id, quotationId: QA?.id, lines: [{ itemId: SHI.id, totalQty: 10, unitPrice: 450, sizes: sizes(SS, { M: 10 }) }] }, SALES)
check('Q5', 'an order cannot be made from a lost quotation, and takes no number', fromLost.status === 409 && fromLost.body?.code === 'QUOTE_LOST' && (await series('SO')) === soBefore, err(fromLost))

// The quotation that is won: two garments, a bill discount, one shirt priced above ₹2,500.
const QB_LINES = [{ itemId: TRO.id, qty: 60, unitPrice: 520 }, { itemId: SHI.id, qty: 30, unitPrice: 2600 }]
const qb = await call('POST', '/sales/quotations', { customerId: ORIENT.id, send: true, customerRef: `ORS-ENQ2-${RUN}`, validUntil: day(15).toISOString(), discountAmount: 1000, terms: 'Ex-works Bhiwandi. 60 days credit.', lines: QB_LINES }, SALES)
const QB = qb.body?.data
const qbWant = priceOrder({ lines: [{ qty: 60, price: 520, hsn: TRO.hsn }, { qty: 30, price: 2600, hsn: SHI.hsn }], discountAmount: 1000, intra: true })
check('Q6', 'a second quotation is saved and marked sent in one go', qb.status === 201 && QB?.status === 'SENT', err(qb))
const qbRate = (itemId) => N(QB?.lines?.find((l) => l.itemId === itemId)?.gstRate)
check('Q6', `the shirt at ₹2,600 a piece (₹${r2(2600 * qbWant.taxable / qbWant.subtotal)} after the bill discount) takes 18%; the chino (HSN ${TRO.hsn}) 5%`, qbRate(SHI.id) === 18 && qbRate(TRO.id) === 5, `shirt ${qbRate(SHI.id)}%, chino ${qbRate(TRO.id)}%`)
check('Q6', `its totals: taxable ₹${qbWant.taxable}, CGST ₹${qbWant.cgst}, SGST ₹${qbWant.sgst}, total ₹${qbWant.total}`, QB && near(QB.taxableAmount, qbWant.taxable) && near(QB.cgst, qbWant.cgst) && near(QB.sgst, qbWant.sgst) && near(QB.totalAmount, qbWant.total) && near(QB.roundOff, qbWant.roundOff), JSON.stringify(QB && { t: QB.taxableAmount, c: QB.cgst, s: QB.sgst, tot: QB.totalAmount, ro: QB.roundOff }))

// The HSN price slab, on quotations (priced by the same function as orders, no stock needed).
const qc = await call('POST', '/sales/quotations', { customerId: METRO.id, lines: [{ itemId: SHI.id, qty: 10, unitPrice: 2800, discount: 15 }, { itemId: SHI.id, qty: 10, unitPrice: 2501 }, { itemId: SHI.id, qty: 10, unitPrice: 2500 }] }, SALES)
const QC = qc.body?.data
const qcRates = (QC?.lines ?? []).sort((a, b) => a.sortOrder - b.sortOrder).map((l) => N(l.gstRate))
const qcWant = priceOrder({ lines: [{ qty: 10, price: 2800, disc: 15, hsn: SHI.hsn }, { qty: 10, price: 2501, hsn: SHI.hsn }, { qty: 10, price: 2500, hsn: SHI.hsn }], intra: false })
check('Q7', 'HSN 6205 slab: ₹2,800 less 15% (₹2,380) is 5%, ₹2,501 is 18%, exactly ₹2,500 is 5%', qc.status === 201 && qcRates.join() === '5,18,5', `${err(qc)} rates ${qcRates.join()}`)
check('Q7', `Delhi buyer: all IGST (₹${qcWant.igst}), no CGST/SGST`, QC && near(QC.igst, qcWant.igst) && N(QC.cgst) === 0 && N(QC.sgst) === 0, JSON.stringify(QC && { c: QC.cgst, s: QC.sgst, i: QC.igst }))
const qd = await call('POST', '/sales/quotations', { customerId: METRO.id, discountAmount: 2000, lines: [{ itemId: SHI.id, qty: 10, unitPrice: 2600 }] }, SALES)
check('Q7', 'a bill discount that brings ₹2,600 down to ₹2,400 a piece takes it back to 5%', qd.status === 201 && N(qd.body?.data?.lines?.[0]?.gstRate) === 5, `${err(qd)} rate ${qd.body?.data?.lines?.[0]?.gstRate}`)
// The chino's HSN, 6203, carries the same slab (added 19 Oct 2026).
const qe = await call('POST', '/sales/quotations', { customerId: METRO.id, lines: [{ itemId: TRO.id, qty: 10, unitPrice: 2600 }] }, SALES)
check('Q7', `trousers (HSN ${TRO.hsn}) at ₹2,600 a piece are 18%, the same slab as shirts`, qe.status === 201 && N(qe.body?.data?.lines?.[0]?.gstRate) === 18, `${err(qe)} rate ${qe.body?.data?.lines?.[0]?.gstRate}`)
for (const x of [QC, qd.body?.data, qe.body?.data]) if (x?.id) await call('POST', `/sales/quotations/${x.id}/lost`, { reason: 'Test quotation for the price slab' }, SALES)

// ════════════════ O. The sales order from the won quotation ════════════════
const SO1_SIZES = { [TRO.id]: { 30: 10, 32: 20, 34: 20, 36: 10 }, [SHI.id]: { S: 5, M: 10, L: 10, XL: 5 } }
const so1Body = (extra = {}) => ({
  customerId: ORIENT.id, quotationId: QB?.id, reference: QB?.quoteNumber, customerPORef: `ORS-PO-${RUN}`, customerPODate: day(-1).toISOString(), deliveryDate: day(20).toISOString(),
  discountAmount: 1000, charges: [{ chargeTypeId: TRANSPORT.id, amount: 500 }], terms: QB?.terms,
  // As the order form fills it from the quotation: its rates, split into sizes.
  lines: QB_LINES.map((l) => ({ itemId: l.itemId, totalQty: l.qty, unitPrice: Number(QB?.lines?.find((x) => x.itemId === l.itemId)?.unitPrice ?? l.unitPrice), sizes: sizes(l.itemId === TRO.id ? TS : SS, SO1_SIZES[l.itemId]) })),
  ...extra,
})
const so1Want = priceOrder({ lines: [{ qty: 60, price: 520, hsn: TRO.hsn }, { qty: 30, price: 2600, hsn: SHI.hsn }], discountAmount: 1000, charges: [{ amount: 500, rate: TRANSPORT.rate }], intra: true })
const wrongQuote = await call('POST', '/sales/orders', { ...so1Body(), customerId: METRO.id }, SALES)
check('O1', "another customer's quotation cannot be made into an order", wrongQuote.status === 400 && wrongQuote.body?.code === 'WRONG_CUSTOMER', err(wrongQuote))
const so1r = await call('POST', '/sales/orders', so1Body(), SALES)
let SO1 = so1r.body?.data
check('O2', 'the order is saved as a draft from the quotation', so1r.status === 201 && SO1?.status === 'DRAFT' && SO1?.quotationId === QB?.id, err(so1r))
const qbAfter = (await call('GET', `/sales/quotations/${QB?.id}`)).body?.data
check('O2', 'the quotation is marked won and points at the order', qbAfter?.status === 'WON' && qbAfter?.orders?.some((o) => o.id === SO1?.id), JSON.stringify(qbAfter && { s: qbAfter.status, o: qbAfter.orders }))
check('O2', "the quotation's rates and GST rates carry onto the order lines", QB_LINES.every((l) => { const ql = QB?.lines?.find((x) => x.itemId === l.itemId), ol = lineOf(SO1, l.itemId); return ol && near(ol.unitPrice, ql?.unitPrice) && near(ol.gstRate, ql?.gstRate) }), JSON.stringify(SO1?.lines?.map((l) => ({ p: l.unitPrice, g: l.gstRate }))))
check('O2', 'same goods, same discount: the order taxable equals the quotation taxable', SO1 && near(SO1.taxableAmount, QB?.taxableAmount) && near(SO1.discountAmount, QB?.discountAmount), `${SO1?.taxableAmount} vs ${QB?.taxableAmount}`)
check('O3', `order totals with ₹500 transport at the goods' rates (5% and 18%, by value): CGST ₹${so1Want.cgst}, SGST ₹${so1Want.sgst}, total ₹${so1Want.total} (round-off ${so1Want.roundOff})`, SO1 && near(SO1.cgst, so1Want.cgst) && near(SO1.sgst, so1Want.sgst) && N(SO1.igst) === 0 && near(SO1.totalAmount, so1Want.total) && near(SO1.roundOff, so1Want.roundOff) && SO1.placeOfSupplyCode === CO.state, JSON.stringify(SO1 && { c: SO1.cgst, s: SO1.sgst, i: SO1.igst, t: SO1.totalAmount, ro: SO1.roundOff, pos: SO1.placeOfSupplyCode }))
const so1Edit = await call('PATCH', `/sales/orders/${SO1?.id}`, so1Body({ notes: `Pack 10 to a carton (run ${RUN})` }), SALES)
check('O4', 'a draft is edited whole and stays a draft', so1Edit.status === 200 && so1Edit.body?.data?.status === 'DRAFT' && so1Edit.body?.data?.notes?.includes(RUN), err(so1Edit))
const so1c = await call('POST', `/sales/orders/${SO1?.id}/confirm`, {}, SALES)
check('O5', 'confirmed by the sales user: within the credit limit, no manager needed', so1c.status === 200 && so1c.body?.data?.status === 'CONFIRMED' && so1c.body?.data?.approvedById === SALES_ID && !so1c.body?.data?.creditReleasedAt, err(so1c))
const so1c2 = await call('POST', `/sales/orders/${SO1?.id}/confirm`, {}, SALES)
const so1p = await call('PATCH', `/sales/orders/${SO1?.id}`, so1Body(), SALES)
check('O5', 'a confirmed order is not confirmed again nor edited in place', so1c2.status === 409 && so1p.status === 409 && so1p.body?.code === 'NOT_DRAFT', `${err(so1c2)} / ${err(so1p)}`)
SO1 = await getOrder(SO1?.id)
if (!SO1 || SO1.status !== 'CONFIRMED') { console.log('setup failed: the main order did not confirm'); process.exit(1) }
const L1 = lineOf(SO1, TRO.id), L2 = lineOf(SO1, SHI.id)
// A quotation becomes one order; an expired one has its price agreed again first.
const twice = await call('POST', '/sales/orders', { ...so1Body(), charges: [] }, SALES)
check('O5', `${QB?.quoteNumber}, already ${SO1.soNumber}, is not made into a second order`, twice.status === 409 && twice.body?.code === 'QUOTE_USED' && (twice.body?.message ?? '').includes(SO1.soNumber), err(twice))
if (twice.status === 201) await call('POST', `/sales/orders/${twice.body.data.id}/cancel`, { reason: 'Second order from one quotation, a test probe' }, SALES)
const qxBody = { customerId: ORIENT.id, quoteDate: day(-30).toISOString(), validUntil: day(-20).toISOString(), lines: [{ itemId: SHI.id, qty: 5, unitPrice: 470 }] }
const qx = await call('POST', '/sales/quotations', { ...qxBody, send: true }, SALES)
const fromQx = () => call('POST', '/sales/orders', { customerId: ORIENT.id, quotationId: qx.body?.data?.id, lines: [{ itemId: SHI.id, totalQty: 5, unitPrice: 470, sizes: sizes(SS, { L: 5 }) }] }, SALES)
const expiredTry = await fromQx()
check('O5', `${qx.body?.data?.quoteNumber}, valid until ${ymd(day(-20))}, is not made into an order while expired`, qx.status === 201 && expiredTry.status === 409 && expiredTry.body?.code === 'QUOTE_EXPIRED', err(expiredTry))
if (expiredTry.status === 201) await call('POST', `/sales/orders/${expiredTry.body.data.id}/cancel`, { reason: 'Order from an expired quotation, a test probe' }, SALES)
const extended = await call('PATCH', `/sales/quotations/${qx.body?.data?.id}`, { ...qxBody, validUntil: day(7).toISOString() }, SALES)
const fromExpired = await fromQx()
const qxAfter = (await call('GET', `/sales/quotations/${qx.body?.data?.id}`, null, SALES)).body?.data
check('O5', 'once its valid-until date is moved on, it becomes an order and is marked won', extended.status === 200 && fromExpired.status === 201 && qxAfter?.status === 'WON', `${err(extended)} / ${err(fromExpired)}`)
if (fromExpired.status === 201) await call('POST', `/sales/orders/${fromExpired.body.data.id}/cancel`, { reason: 'Order from a re-dated quotation, a test probe' }, SALES)

// ════════════════ H. Credit hold: a warning for a manager, not a block ════════════════
const ctx = await call('GET', `/sales/customers/${CW.id}/context?value=50000`, null, SALES)
check('H1', `the order form is told a ₹50,000 order takes ${CW_NAME} over its ₹${CW_LIMIT} limit`, ctx.status === 200 && ctx.body?.data?.credit?.overLimit === true && ctx.body?.data?.credit?.needsRelease === true && ctx.body?.data?.placeOfSupply?.isIntraState === true, err(ctx))
must(await call('PATCH', `/masters/customers/${CW.id}`, { isBlacklisted: true }), 'blacklist the test customer')
const ch1r = await call('POST', '/sales/orders', { customerId: CW.id, confirm: true, lines: [{ itemId: TRO.id, totalQty: 10, unitPrice: 500, sizes: sizes(TS, { 32: 10 }) }] }, SALES)
const CH1 = ch1r.body?.data
check('H2', 'a small order for a blacklisted customer is saved, not refused, and goes on credit hold', ch1r.status === 201 && CH1?.status === 'DRAFT' && !!CH1?.sentForApprovalAt && /credit hold/i.test(ch1r.body?.message ?? '') && /blacklisted/i.test(ch1r.body?.message ?? ''), `${err(ch1r)} ${ch1r.body?.message ?? ''}`)
const dash1 = await call('GET', '/sales/dashboard', null, SALES)
check('H3', 'the sales dashboard lists it as waiting on credit hold', dash1.status === 200 && JSON.stringify(dash1.body?.data?.now ?? {}).includes(CH1?.id ?? '@@'), err(dash1))
const selfOk = await call('POST', `/approvals/SO/${CH1?.id}/approve`, { creditReleaseReason: 'My own order, releasing it' }, SALES)
check('H4', 'whoever raised it cannot release it', selfOk.status === 403 && selfOk.body?.code === 'SELF_APPROVAL', err(selfOk))
const noWhy = await call('POST', `/approvals/SO/${CH1?.id}/approve`, {})
check('H5', 'a manager approving it is first shown the warning and asked why', noWhy.status === 409 && noWhy.body?.code === 'CREDIT_HOLD' && /blacklisted/i.test(noWhy.body?.message ?? ''), err(noWhy))
const rel1 = await call('POST', `/approvals/SO/${CH1?.id}/approve`, { creditReleaseReason: 'Paid in advance by RTGS, MD agreed' })
check('H6', 'released by the manager with a reason: confirmed, the release kept on the order', rel1.status === 200 && rel1.body?.data?.status === 'CONFIRMED' && rel1.body?.data?.creditReleaseReason === 'Paid in advance by RTGS, MD agreed' && rel1.body?.data?.creditReleasedById === ADMIN_ID, err(rel1))
must(await call('PATCH', `/masters/customers/${CW.id}`, { isBlacklisted: false }), 'take the test customer off the blacklist')
const ch2r = await call('POST', '/sales/orders', { customerId: CW.id, confirm: true, lines: [{ itemId: SHI.id, totalQty: 40, unitPrice: 600, sizes: sizes(SS, { M: 40 }) }] }, SALES)
const CH2 = ch2r.body?.data
check('H7', `an order taking the customer over its ₹${CW_LIMIT} limit goes on credit hold, not refused`, ch2r.status === 201 && CH2?.status === 'DRAFT' && !!CH2?.sentForApprovalAt && /over their credit limit/i.test(ch2r.body?.message ?? ''), `${err(ch2r)} ${ch2r.body?.message ?? ''}`)
const ch2e = await call('PATCH', `/sales/orders/${CH2?.id}`, { customerId: CW.id, lines: [{ itemId: SHI.id, totalQty: 10, unitPrice: 600, sizes: sizes(SS, { M: 10 }) }] }, SALES)
check('H7', 'while on hold it cannot be edited down to slip under the limit', ch2e.status === 409 && ch2e.body?.code === 'ON_HOLD', err(ch2e))
const rel2 = await call('POST', `/approvals/SO/${CH2?.id}/approve`, { creditReleaseReason: 'Old customer, cheque in hand' })
check('H8', 'released by the manager with a reason', rel2.status === 200 && rel2.body?.data?.status === 'CONFIRMED' && !!rel2.body?.data?.creditReleasedAt, err(rel2))
const ch3r = await call('POST', '/sales/orders', { customerId: CW.id, lines: [{ itemId: TRO.id, totalQty: 50, unitPrice: 500, sizes: sizes(TS, { 34: 50 }) }] })
const CH3 = ch3r.body?.data
const c3a = await call('POST', `/sales/orders/${CH3?.id}/confirm`, {}, SALES)
check('H9', 'a manager confirming someone else\'s over-limit order is warned with the figures first', c3a.status === 409 && c3a.body?.code === 'CREDIT_HOLD' && /₹/.test(c3a.body?.message ?? '') && /credit limit/i.test(c3a.body?.message ?? ''), err(c3a))
const c3b = await call('POST', `/sales/orders/${CH3?.id}/confirm`, { creditReleaseReason: 'Advance received against proforma' }, SALES)
check('H9', 'and confirms it with a reason: released by them', c3b.status === 200 && c3b.body?.data?.status === 'CONFIRMED' && c3b.body?.data?.creditReleasedById === SALES_ID, err(c3b))

// Cancelling, with a reason.
const kc = await call('POST', `/sales/orders/${CH1?.id}/cancel`, { reason: 'Customer called it off' }, KEEPER)
check('O6', 'the store keeper cannot cancel an order', kc.status === 403, err(kc))
const shortWhy = await call('POST', `/sales/orders/${CH1?.id}/cancel`, { reason: 'no' }, SALES)
check('O6', 'a cancel needs a reason of a few words', shortWhy.status === 400, err(shortWhy))
const cx1 = await call('POST', `/sales/orders/${CH1?.id}/cancel`, { reason: 'Customer called it off on the phone' }, SALES)
check('O7', 'a confirmed order is cancelled by a manager, with the reason kept', cx1.status === 200 && cx1.body?.data?.status === 'CANCELLED' && cx1.body?.data?.cancelReason === 'Customer called it off on the phone' && cx1.body?.data?.cancelledById === SALES_ID, err(cx1))
for (const o of [CH2, CH3]) if (o?.id) await call('POST', `/sales/orders/${o.id}/cancel`, { reason: 'Test order for the credit hold' }, SALES)
const ch5r = await call('POST', '/sales/orders', { customerId: CW.id, confirm: true, lines: [{ itemId: SHI.id, totalQty: 50, unitPrice: 600, sizes: sizes(SS, { L: 50 }) }] }, SALES)
const rej = await call('POST', `/approvals/SO/${ch5r.body?.data?.id}/reject`, { reason: 'Customer has three cheques returned this year' })
check('O7', 'a held order can be turned down in Pending Approvals instead: cancelled, with the reason', ch5r.status === 201 && !!ch5r.body?.data?.sentForApprovalAt && rej.status === 200 && rej.body?.data?.status === 'CANCELLED' && rej.body?.data?.cancelReason?.includes('cheques returned') && !rej.body?.data?.approvedAt, `${err(ch5r)} / ${err(rej)}`)
const dr = await call('POST', '/sales/orders', { customerId: ORIENT.id, lines: [{ itemId: SHI.id, totalQty: 5, unitPrice: 450, sizes: sizes(SS, { L: 5 }) }] }, SALES)
const drx = await call('POST', `/sales/orders/${dr.body?.data?.id}/cancel`, { reason: 'Entered twice by mistake' }, SALES)
check('O7', 'a draft is cancelled the same way', dr.status === 201 && drx.status === 200 && drx.body?.data?.status === 'CANCELLED', `${err(dr)} / ${err(drx)}`)
// An order confirmed within the limit, then amended far over it.
const ch4r = await call('POST', '/sales/orders', { customerId: CW.id, confirm: true, lines: [{ itemId: TRO.id, totalQty: 2, unitPrice: 500, sizes: sizes(TS, { 32: 2 }) }] }, SALES)
const CH4 = ch4r.body?.data
const amend4 = (qty, extra = {}, tok = ADMIN) =>
  call('POST', `/sales/orders/${CH4?.id}/amend`, { customerId: CW.id, reason: 'Buyer increased the quantity', lines: [{ id: CH4?.lines?.[0]?.id, itemId: TRO.id, totalQty: qty, unitPrice: 500, sizes: sizes(TS, { 32: qty }) }], ...extra }, tok)
const own4 = await amend4(100, {}, SALES)
check('H10', 'raising a confirmed order over the credit limit: whoever raised it is told a manager has to make the change', ch4r.status === 201 && CH4?.status === 'CONFIRMED' && own4.status === 409 && own4.body?.code === 'CREDIT_LIMIT' && /credit limit/i.test(own4.body?.message ?? ''), `${err(ch4r)} / ${err(own4)}`)
const noWhy4 = await amend4(100)
check('H10', 'a manager making it is shown the figures and asked why first', noWhy4.status === 409 && noWhy4.body?.code === 'CREDIT_HOLD' && /₹/.test(noWhy4.body?.message ?? ''), err(noWhy4))
const am4 = await amend4(100, { creditReleaseReason: 'Buyer paid half in advance' })
const a4 = am4.body?.data
check('H10', 'with a reason the change is saved and the release kept on the order', am4.status === 200 && a4?.status === 'CONFIRMED' && a4?.version === 2 && a4?.creditReleaseReason === 'Buyer paid half in advance' && a4?.creditReleasedById === ADMIN_ID, err(am4))
const down4 = await amend4(2, { reason: 'Buyer went back to two pieces' }, SALES)
check('H10', 'a change that lowers the value is never stopped', down4.status === 200 && down4.body?.data?.version === 3, err(down4))

// ════════════════ D. Finished goods in, and dispatch ════════════════
const FG1_LINES = [...Object.entries({ 30: 12, 32: 10, 34: 5, 36: 10 }).map(([s, n]) => ({ itemId: TRO.id, sizeId: TS[s], qty: n })), ...Object.entries({ S: 5, M: 5, L: 4 }).map(([s, n]) => ({ itemId: SHI.id, sizeId: SS[s], qty: n }))]
const FG2_LINES = [{ itemId: TRO.id, sizeId: TS[32], qty: 11 }, { itemId: SHI.id, sizeId: SS.M, qty: 4 }, { itemId: SHI.id, sizeId: SS.L, qty: 4 }, { itemId: FGS.id, qty: 5 }]
const salesFg = await call('POST', '/finished-goods', { warehouseId: STORE.id, lines: FG2_LINES }, SALES)
check('D1', 'the sales user cannot put goods into the store (no inventory:create)', salesFg.status === 403, err(salesFg))
const stock0 = {}
for (const [g, map] of [[TRO, TS], [SHI, SS]]) for (const [code, id] of Object.entries(map)) stock0[`${g.id}|${id}`] = await bal(g.id, id)
const fg1 = await call('POST', '/finished-goods', { warehouseId: STORE.id, soId: SO1.id, notes: `Packed for ${SO1.soNumber}`, lines: FG1_LINES }, KEEPER)
const fg2 = await call('POST', '/finished-goods', { warehouseId: STORE.id, notes: 'Packed for stock', lines: FG2_LINES }, KEEPER)
const FG1 = must(fg1, 'finished goods in against the order'), FG2 = must(fg2, 'finished goods in for stock')
const fgRate = (fg, itemId) => N(fg.lines.find((l) => l.itemId === itemId)?.unitRate)
check('D2', `the store keeper puts packed pieces in by size: ${FG1.fgrNumber} against ${SO1.soNumber}, ${FG2.fgrNumber} for stock`, fg1.status === 201 && fg2.status === 201 && FG1.soId === SO1.id)
check('D2', `valued at the approved BOM cost per piece: chino ₹${TRO.cost}, shirt ₹${SHI.cost}`, near(fgRate(FG1, TRO.id), TRO.cost) && near(fgRate(FG1, SHI.id), SHI.cost) && FG1.lines.every((l) => l.rateSource === 'BOM'), `${fgRate(FG1, TRO.id)} / ${fgRate(FG1, SHI.id)}`)
check('D2', `a garment with no BOM and no sizes goes in by the piece at its standard rate (${FGS.code} ₹${FGS.std})`, near(fgRate(FG2, FGS.id), FGS.std) && FG2.lines.find((l) => l.itemId === FGS.id)?.rateSource === 'STANDARD' && !FG2.lines.find((l) => l.itemId === FGS.id)?.sizeId, JSON.stringify(FG2.lines.find((l) => l.itemId === FGS.id)))
const stk = async (g, code) => bal(g.id, (g === TRO ? TS : SS)[code])
const s0 = (g, code) => stock0[`${g.id}|${(g === TRO ? TS : SS)[code]}`]
check('D2', 'stock by size went up by what was packed', (await stk(TRO, 30)) === s0(TRO, 30) + 12 && (await stk(TRO, 32)) === s0(TRO, 32) + 21 && (await stk(SHI, 'M')) === s0(SHI, 'M') + 9 && (await stk(SHI, 'L')) === s0(SHI, 'L') + 8, `T30 ${await stk(TRO, 30)} (was ${s0(TRO, 30)}), T32 ${await stk(TRO, 32)} (was ${s0(TRO, 32)})`)

const dcBody = (soId, lines, extra = {}) => ({ soId, warehouseId: STORE.id, dispatch: true, transporter: 'Shree Ganesh Roadways', vehicleNumber: 'mh04ab1234', lrNumber: `LR-${RUN}`, cartons: 3, ...extra, lines })
const before1 = { t30: await stk(TRO, 30), t32: await stk(TRO, 32), sS: await stk(SHI, 'S'), sM: await stk(SHI, 'M') }
const dc1r = await call('POST', '/sales/challans', dcBody(SO1.id, [{ soLineId: L1.id, sizes: sizes(TS, { 30: 5, 32: 10 }) }, { soLineId: L2.id, sizes: sizes(SS, { S: 5, M: 5 }) }], { eWayBillNumber: `EWB${RUN}01` }), SALES)
const DC1 = must(dc1r, 'the first challan')
check('D3', `${DC1.dcNumber} dispatched: 15 chinos and 10 shirts`, dc1r.status === 201 && DC1.status === 'DISPATCHED' && DC1.vehicleNumber === 'MH04AB1234', `${DC1.status} ${DC1.vehicleNumber}`)
check('D3', 'stock by size went down by exactly what was sent', (await stk(TRO, 30)) === before1.t30 - 5 && (await stk(TRO, 32)) === before1.t32 - 10 && (await stk(SHI, 'S')) === before1.sS - 5 && (await stk(SHI, 'M')) === before1.sM - 5)
SO1 = await getOrder(SO1.id)
check('D3', 'the order shows each line and size sent and pending, and is part dispatched', SO1.status === 'PARTIALLY_DISPATCHED' && N(lineOf(SO1, TRO.id).deliveredQty) === 15 && N(lineOf(SO1, TRO.id).pendingQty) === 45 && N(sizeOf(lineOf(SO1, TRO.id), TS[30]).deliveredQty) === 5 && N(lineOf(SO1, SHI.id).pendingQty) === 20, JSON.stringify(SO1.lines.map((l) => [l.deliveredQty, l.pendingQty])))
const dcBefore = await series('DC')
const overNo = await call('POST', '/sales/challans', dcBody(SO1.id, [{ soLineId: L1.id, sizes: sizes(TS, { 30: 7 }) }]), SALES)
check('D4', 'more than the order still wants in a size (7 of size 30, 5 pending) is stopped without a note', overNo.status === 400 && overNo.body?.code === 'OVER_NEEDS_NOTE' && /size 30/.test(overNo.body?.message ?? ''), err(overNo))
const t34 = await stk(TRO, 34)
const tooMany = await call('POST', '/sales/challans', dcBody(SO1.id, [{ soLineId: L1.id, sizes: sizes(TS, { 34: t34 + 1 }), overNote: 'Testing the stock check' }]), SALES)
check('D5', `more than is in stock (${t34 + 1} of size 34, ${t34} on hand) is refused, naming the size`, tooMany.status === 400 && tooMany.body?.code === 'INSUFFICIENT_STOCK' && /size 34/.test(tooMany.body?.message ?? ''), err(tooMany))
const noSize = await call('POST', '/sales/challans', dcBody(SO1.id, [{ soLineId: L1.id, sizes: sizes(TS, { 28: 1 }) }]), SALES)
check('D5', 'a size the order does not carry is refused', noSize.status === 400 && noSize.body?.code === 'SIZE_NOT_ORDERED', err(noSize))
check('D5', 'refused challans take no number and move no stock', (await series('DC')) === dcBefore && (await stk(TRO, 34)) === t34)
const dc2r = await call('POST', '/sales/challans', dcBody(SO1.id, [{ soLineId: L1.id, sizes: sizes(TS, { 30: 7, 36: 10 }), overNote: 'Buyer asked for 2 extra in size 30 on the phone' }, { soLineId: L2.id, sizes: sizes(SS, { L: 4 }) }], { eWayBillNumber: `EWB${RUN}02` }), SALES)
const DC2 = must(dc2r, 'the second challan')
check('D6', `${DC2.dcNumber}: sending more than pending is allowed with a note, and the note is kept`, dc2r.status === 201 && DC2.lines.some((l) => l.overNote?.includes('2 extra')))
SO1 = await getOrder(SO1.id)
const l1 = lineOf(SO1, TRO.id)
const sizePending = sum(l1.sizes, (s) => Math.max(0, N(s.qty) - N(s.deliveredQty)))
check('D6', 'size 30 shows 12 sent against 10 ordered', N(sizeOf(l1, TS[30]).deliveredQty) === 12)
if (N(l1.pendingQty) !== sizePending) note('D6', `after the over-send the chino line says ${N(l1.pendingQty)} pending but its sizes say ${sizePending} (size 30 over by 2 is netted against sizes 32/34). The order book and short-close read the line figure; the challan form reads the sizes.`)
// A draft, dispatched later, then cancelled: the pieces come back.
const dcd = await call('POST', '/sales/challans', dcBody(SO1.id, [{ soLineId: L1.id, sizes: sizes(TS, { 34: 5 }) }], { dispatch: false }), SALES)
const DCX = dcd.body?.data
const t34a = await stk(TRO, 34)
check('D7', 'a challan saved as a draft moves no stock', dcd.status === 201 && DCX?.status === 'DRAFT' && t34a === t34, err(dcd))
const notYet = await call('POST', '/sales/invoices', { dcId: DCX?.id }, SALES)
check('D7', 'a draft challan cannot be invoiced', notYet.status === 409 && notYet.body?.code === 'NOT_DISPATCHED', err(notYet))
const dxs = await call('POST', `/sales/challans/${DCX?.id}/dispatch`, {}, SALES)
const dxs2 = await call('POST', `/sales/challans/${DCX?.id}/dispatch`, {}, SALES)
check('D7', 'dispatched from the draft: 5 of size 34 leave; a second dispatch is refused', dxs.status === 200 && dxs.body?.data?.status === 'DISPATCHED' && (await stk(TRO, 34)) === t34 - 5 && dxs2.status === 409, `${err(dxs)} / ${err(dxs2)}`)
const rateOut = Number((await q(`SELECT "unitRate"::float8 r FROM stock_ledger WHERE "referenceId"=$1 AND "outQty">0 LIMIT 1`, [DCX?.id]))[0]?.r)
const dxc = await call('POST', `/sales/challans/${DCX?.id}/cancel`, { reason: 'Wrong carton loaded, came back' }, SALES)
const back = (await q(`SELECT "inQty"::float8 q, "unitRate"::float8 r, grade, "sizeId" FROM stock_ledger WHERE "referenceId"=$1 AND "referenceType"='DELIVERY_CHALLAN_CANCEL'`, [DCX?.id]))
SO1 = await getOrder(SO1.id)
check('D8', 'cancelling a dispatched challan puts the pieces back by size, at the rate they left at', dxc.status === 200 && dxc.body?.data?.status === 'CANCELLED' && (await stk(TRO, 34)) === t34 && back.length === 1 && back[0].q === 5 && back[0].grade === 'A' && back[0].sizeId === TS[34] && near(back[0].r, rateOut), `${err(dxc)} ${JSON.stringify(back)} out at ${rateOut}`)
check('D8', 'and takes them off the order again', N(sizeOf(lineOf(SO1, TRO.id), TS[34]).deliveredQty) === 0 && N(lineOf(SO1, TRO.id).deliveredQty) === 32)
const dcy = await call('POST', '/sales/challans', dcBody(SO1.id, [{ soLineId: L2.id, sizes: sizes(SS, { M: 1 }) }], { dispatch: false }), SALES)
const dcyx = await call('POST', `/sales/challans/${dcy.body?.data?.id}/cancel`, { reason: 'Not needed after all' }, SALES)
check('D8', 'a draft challan is simply called off', dcyx.status === 200 && dcyx.body?.data?.status === 'CANCELLED' && Number((await q(`SELECT COUNT(*)::int n FROM stock_ledger WHERE "referenceId"=$1`, [dcy.body?.data?.id]))[0].n) === 0, err(dcyx))

// ════════════════ A. Amending the confirmed order ════════════════
const amendBody = (lines, extra = {}) => ({ ...so1Body(), quotationId: undefined, reason: 'Buyer revised the PO', lines, ...extra })
const L2now = lineOf(SO1, SHI.id)
const below = await call('POST', `/sales/orders/${SO1.id}/amend`, amendBody([{ id: L1.id, itemId: TRO.id, totalQty: 60, unitPrice: 520, sizes: sizes(TS, SO1_SIZES[TRO.id]) }, { id: L2.id, itemId: SHI.id, totalQty: 12, unitPrice: 2600, sizes: sizes(SS, { S: 5, M: 5, L: 2 }) }]), SALES)
check('A1', `a line cannot go below what has been sent (shirts: ${N(L2now.deliveredQty)} sent)`, below.status === 409 && below.body?.code === 'BELOW_DELIVERED', err(below))
const other = await call('POST', `/sales/orders/${SO1.id}/amend`, amendBody([{ id: L1.id, itemId: TRO.id, totalQty: 60, unitPrice: 520, sizes: sizes(TS, SO1_SIZES[TRO.id]) }, { id: L2.id, itemId: SHI.id, totalQty: 30, unitPrice: 2600, sizes: sizes(SS, SO1_SIZES[SHI.id]) }], { customerId: METRO.id }), SALES)
check('A1', 'the customer cannot change on an amendment', other.status === 400 && other.body?.code === 'CUSTOMER_CHANGED', err(other))
const AM_TRO = { 30: 12, 32: 20, 34: 20, 36: 10 }
const am = await call('POST', `/sales/orders/${SO1.id}/amend`, amendBody([{ id: L1.id, itemId: TRO.id, totalQty: 62, unitPrice: 530, sizes: sizes(TS, AM_TRO) }, { id: L2.id, itemId: SHI.id, totalQty: 30, unitPrice: 2600, sizes: sizes(SS, SO1_SIZES[SHI.id]) }]), SALES)
const AM = am.body?.data
check('A2', 'amended (chino 60 → 62 to cover the extra size 30, ₹520 → ₹530): now version 2', am.status === 200 && AM?.version === 2 && AM?.status === 'PARTIALLY_DISPATCHED', err(am))
const rev = await call('GET', `/sales/orders/${SO1.id}/revisions/1`, null, SALES)
const revTro = rev.body?.data?.snapshot?.lines?.find((l) => l.itemId === TRO.id)
check('A2', 'version 1 is kept whole, with its reason: 60 chinos at ₹520', rev.status === 200 && rev.body?.data?.reason === 'Buyer revised the PO' && N(revTro?.totalQty) === 60 && N(revTro?.unitPrice) === 520, err(rev))
SO1 = await getOrder(SO1.id)
check('A2', 'what was sent stays on the amended line: 32 sent, 30 pending, size 30 still 12 sent', N(lineOf(SO1, TRO.id).deliveredQty) === 32 && N(lineOf(SO1, TRO.id).pendingQty) === 30 && N(sizeOf(lineOf(SO1, TRO.id), TS[30]).deliveredQty) === 12 && lineOf(SO1, TRO.id).id === L1.id, JSON.stringify(lineOf(SO1, TRO.id) && { d: lineOf(SO1, TRO.id).deliveredQty, p: lineOf(SO1, TRO.id).pendingQty }))

// ════════════════ I. Invoices from the challans ════════════════
const kInv = await call('POST', '/sales/invoices', { dcId: DC1.id }, KEEPER)
check('I1', 'the store keeper cannot raise an invoice', kInv.status === 403, err(kInv))
const prep1 = await call('GET', `/sales/invoices/prepare?dcId=${DC1.id}`, null, SALES)
const p1 = prep1.body?.data
check('I2', 'the invoice form opens with the challan at the order\'s rates and the transport still to bill', prep1.status === 200 && p1.isIntraState === true && p1.lines.some((l) => l.item.id === TRO.id && N(l.unitPrice) === 530) && p1.charges.some((c) => c.chargeTypeId === TRANSPORT.id && N(c.amount) === 500), err(prep1))
const so1Now = SO1
const inv1r = await call('POST', '/sales/invoices', { dcId: DC1.id, charges: p1?.charges?.map((c) => ({ chargeTypeId: c.chargeTypeId, amount: N(c.amount) })), eWayBillNumber: `EWB${RUN}01`, eWayBillDate: day(0).toISOString() }, SALES)
const INV1 = must(inv1r, 'the first invoice')
// What the invoice should say: the challan's pieces at the order line's rate as it stands (the amendment made the chino ₹530).
const inv1Want = priceInvoice({ lines: [{ key: TRO.id, qty: 15, price: N(lineOf(so1Now, TRO.id).unitPrice), rate: N(lineOf(so1Now, TRO.id).gstRate) }, { key: SHI.id, qty: 10, price: N(lineOf(so1Now, SHI.id).unitPrice), rate: N(lineOf(so1Now, SHI.id).gstRate) }], orderSubtotal: N(so1Now.subtotal), orderDiscount: N(so1Now.discountAmount), charges: [{ amount: 500, rate: TRANSPORT.rate }], intra: true })
const il = (inv, itemId) => inv?.lines?.find((l) => l.itemId === itemId)
check('I3', `${INV1.invoiceNumber}: each line at the order line's rate and GST rate (chino ₹530 at 5%, shirt ₹2,600 at 18%)`, N(il(INV1, TRO.id)?.unitPrice) === 530 && N(il(INV1, TRO.id)?.gstRate) === 5 && N(il(INV1, SHI.id)?.unitPrice) === 2600 && N(il(INV1, SHI.id)?.gstRate) === 18 && il(INV1, SHI.id)?.hsnCode === SHI.hsn && il(INV1, TRO.id)?.hsnCode === TRO.hsn, JSON.stringify(INV1.lines.map((l) => [l.unitPrice, l.gstRate, l.hsnCode])))
check('I3', `the order's ₹1,000 discount shared by this invoice's part: ₹${inv1Want.discount}; taxable ₹${inv1Want.taxable}`, near(INV1.discountAmount, inv1Want.discount) && near(INV1.taxableAmount, inv1Want.taxable) && near(INV1.subtotal, inv1Want.subtotal), showMoney(INV1, { subtotal: inv1Want.subtotal, discountAmount: inv1Want.discount, taxableAmount: inv1Want.taxable }, ['subtotal', 'discountAmount', 'taxableAmount']))
check('I3', `same state: CGST ₹${inv1Want.cgst} + SGST ₹${inv1Want.sgst}, no IGST; total ₹${inv1Want.total}, round-off ${inv1Want.roundOff}`, near(INV1.cgst, inv1Want.cgst) && near(INV1.sgst, inv1Want.sgst) && N(INV1.igst) === 0 && near(INV1.totalAmount, inv1Want.total) && near(INV1.roundOff, inv1Want.roundOff) && INV1.lines.every((l) => N(l.igst) === 0), showMoney(INV1, { cgst: inv1Want.cgst, sgst: inv1Want.sgst, igst: 0, totalAmount: inv1Want.total, roundOff: inv1Want.roundOff }, ['cgst', 'sgst', 'igst', 'totalAmount', 'roundOff']))
check('I3', 'each line\'s taxable value and tax as worked out here', inv1Want.lines.every((w) => { const s = il(INV1, w.key); return s && near(s.taxableValue, w.tv) && near(s.cgst, w.cgst) && near(s.sgst, w.sgst) }), JSON.stringify(INV1.lines.map((l) => [l.taxableValue, l.cgst, l.sgst])))
check('I3', `unpaid, balance the whole ₹${inv1Want.total}, due in ${ORIENT.days} days, the e-way bill on it`, INV1.status === 'UNPAID' && near(INV1.balanceAmount, INV1.totalAmount) && Math.round((new Date(INV1.dueDate) - new Date(INV1.invoiceDate)) / 864e5) === ORIENT.days && INV1.eWayBillNumber === `EWB${RUN}01` && !!INV1.eWayBillDate)
const lineTaxable = r2(sum(INV1.lines, (l) => N(l.taxableValue)))
check('I4', 'the lines\' taxable values add up to the invoice\'s taxable value', near(lineTaxable, INV1.taxableAmount), `lines ${lineTaxable} vs invoice ${N(INV1.taxableAmount)}`)
const again = await call('POST', '/sales/invoices', { dcId: DC1.id }, SALES)
check('I5', 'a challan is billed once', again.status === 409 && again.body?.code === 'ALREADY_INVOICED', err(again))
const dcInv = await call('POST', `/sales/challans/${DC1.id}/cancel`, { reason: 'Trying to cancel a billed challan' }, SALES)
check('I5', 'a billed challan cannot be cancelled while its invoice stands', dcInv.status === 409 && dcInv.body?.code === 'INVOICED', err(dcInv))
const prep2 = (await call('GET', `/sales/invoices/prepare?dcId=${DC2.id}`, null, SALES)).body?.data
check('I6', 'the second invoice of the order is offered no transport: it was billed on the first', prep2 && prep2.charges.length === 0, JSON.stringify(prep2?.charges))
const inv2r = await call('POST', '/sales/invoices', { dcId: DC2.id }, SALES)
const INV2 = must(inv2r, 'the second invoice')
const inv2Want = priceInvoice({ lines: [{ key: TRO.id, qty: 17, price: 530, rate: 5 }, { key: SHI.id, qty: 4, price: 2600, rate: 18 }], orderSubtotal: N(so1Now.subtotal), orderDiscount: N(so1Now.discountAmount), intra: true })
check('I6', `${INV2.invoiceNumber}: 17 chinos (the over-sent 2 included) and 4 shirts, total ₹${inv2Want.total}`, near(il(INV2, TRO.id)?.qty, 17) && near(INV2.totalAmount, inv2Want.total) && near(INV2.cgst, inv2Want.cgst), showMoney(INV2, { totalAmount: inv2Want.total, cgst: inv2Want.cgst }, ['totalAmount', 'cgst']))
note('I6', `${DC2.dcNumber} left the store while the chino was ₹520; the amendment to ₹530 came after, and ${INV2.invoiceNumber} bills it at ₹530: an invoice always takes the order line's rate as it stands when billed.`)

// Another state: Delhi, all IGST. Three garments, one sold by the piece with no sizes, and a ₹100 bill discount.
const SO2_LINES = [{ itemId: TRO.id, totalQty: 6, unitPrice: 600, sizes: sizes(TS, { 32: 6 }) }, { itemId: SHI.id, totalQty: 8, unitPrice: 2500, sizes: sizes(SS, { M: 4, L: 4 }) }, { itemId: FGS.id, totalQty: 5, unitPrice: 745 }]
const so2r = await call('POST', '/sales/orders', { customerId: METRO.id, confirm: true, customerPORef: `MMW-${RUN}`, deliveryDate: day(10).toISOString(), discountAmount: 100, lines: SO2_LINES }, SALES)
const SO2 = must(so2r, 'the Delhi order')
const so2Want = priceOrder({ lines: [{ qty: 6, price: 600, hsn: TRO.hsn }, { qty: 8, price: 2500, hsn: SHI.hsn }, { qty: 5, price: 745, hsn: FGS.hsn }], discountAmount: 100, intra: false })
check('I7', `${SO2.soNumber} to Delhi: confirmed, every line 5%, all IGST (₹${so2Want.igst}), total ₹${so2Want.total}`, SO2.status === 'CONFIRMED' && SO2.lines.every((l) => N(l.gstRate) === 5) && near(SO2.igst, so2Want.igst) && N(SO2.cgst) === 0 && N(SO2.sgst) === 0 && near(SO2.totalAmount, so2Want.total) && SO2.placeOfSupplyCode === METRO.state, JSON.stringify({ g: SO2.lines.map((l) => l.gstRate), i: SO2.igst, c: SO2.cgst, t: SO2.totalAmount }))
const so2Dc = (extra) => dcBody(SO2.id, [{ soLineId: lineOf(SO2, TRO.id).id, sizes: sizes(TS, { 32: 6 }) }, { soLineId: lineOf(SO2, SHI.id).id, sizes: sizes(SS, { M: 4, L: 4 }) }, { soLineId: lineOf(SO2, FGS.id).id, qty: 5 }], extra)
const fgsBefore = await bal(FGS.id, null)
const dc3d = await call('POST', '/sales/challans', so2Dc({ dispatch: false, eWayBillNumber: `EWB${RUN}03` }), SALES)
const dc3p = await call('PATCH', `/sales/challans/${dc3d.body?.data?.id}`, so2Dc({ eWayBillNumber: `EWB${RUN}03`, transporter: 'VRL Logistics' }), SALES)
const DC3 = must(dc3p, 'the Delhi challan')
const so2After = await getOrder(SO2.id)
check('I7', `${DC3.dcNumber}: draft changed and dispatched in one save; everything sent, so the order is completed`, DC3.status === 'DISPATCHED' && DC3.transporter === 'VRL Logistics' && so2After.status === 'COMPLETED', `${DC3.status} ${so2After.status}`)
check('I7', `${FGS.code}, which has no sizes, leaves the store by the piece (5)`, (await bal(FGS.id, null)) === fgsBefore - 5)
const inv3r = await call('POST', '/sales/invoices', { dcId: DC3.id }, SALES)
const INV3 = must(inv3r, 'the Delhi invoice')
const inv3Want = priceInvoice({ lines: [{ key: TRO.id, qty: 6, price: 600, rate: 5 }, { key: SHI.id, qty: 8, price: 2500, rate: 5 }, { key: FGS.id, qty: 5, price: 745, rate: 5 }], orderSubtotal: N(SO2.subtotal), orderDiscount: N(SO2.discountAmount), intra: false })
check('I7', `${INV3.invoiceNumber}: IGST ₹${inv3Want.igst} only, place of supply ${METRO.state}, total ₹${inv3Want.total}`, near(INV3.igst, inv3Want.igst) && N(INV3.cgst) === 0 && N(INV3.sgst) === 0 && near(INV3.totalAmount, inv3Want.total) && INV3.placeOfSupplyCode === METRO.state && INV3.lines.every((l) => N(l.cgst) === 0 && N(l.igst) > 0), showMoney(INV3, { igst: inv3Want.igst, cgst: 0, totalAmount: inv3Want.total }, ['igst', 'cgst', 'totalAmount']))
const line3Taxable = r2(sum(INV3.lines, (l) => N(l.taxableValue)))
check('I7', 'with the bill discount shared over three lines, the lines\' taxable values still add up to the invoice\'s taxable value', near(line3Taxable, INV3.taxableAmount), `lines ₹${line3Taxable} vs invoice taxable ₹${N(INV3.taxableAmount)} (lines ${INV3.lines.map((l) => N(l.taxableValue)).join(' + ')})`)
const kCx = await call('POST', `/sales/invoices/${INV3.id}/cancel`, { reason: 'Wrong buyer address' }, KEEPER)
check('I8', 'the store keeper cannot cancel an invoice (needs sales:approve)', kCx.status === 403, err(kCx))
const stockBeforeInvCx = await stk(SHI, 'M')
const cx3 = await call('POST', `/sales/invoices/${INV3.id}/cancel`, { reason: 'Wrong buyer address on it' }, SALES)
const waiting = (await call('GET', '/sales/invoices/waiting', null, SALES)).body?.data ?? []
const dc3Now = (await call('GET', `/sales/challans/${DC3.id}`, null, SALES)).body?.data
check('I8', 'cancelled by a manager: it owes nothing, and the challan is back waiting to be invoiced', cx3.status === 200 && cx3.body?.data?.status === 'CANCELLED' && N(cx3.body?.data?.balanceAmount) === 0 && waiting.some((w) => w.id === DC3.id), err(cx3))
check('I8', 'the challan itself stays dispatched and no stock moves back (the goods are still with the buyer)', dc3Now?.status === 'DISPATCHED' && (await stk(SHI, 'M')) === stockBeforeInvCx && (await getOrder(SO2.id)).status === 'COMPLETED')
// An invoice cannot be dated ahead, as receipts and credit notes cannot.
const future = await call('POST', '/sales/invoices', { dcId: DC3.id, invoiceDate: day(3).toISOString() }, SALES)
check('I8', `an invoice dated ${ymd(day(3))}, three days ahead, is refused`, future.status === 400 && future.body?.code === 'FUTURE_DATE', err(future))
if (future.status === 201) await call('POST', `/sales/invoices/${future.body.data.id}/cancel`, { reason: 'Future-dated probe, cancelled by the test' }, SALES)
const prep3 = (await call('GET', `/sales/invoices/prepare?dcId=${DC3.id}`, null, SALES)).body?.data
check('I8', 'the invoice form is told today and the last invoice, so its date box can hold to them', !!prep3?.dateRange?.today && prep3?.dateRange?.lastInvoice?.day <= prep3?.dateRange?.today && !!prep3?.dateRange?.yearStart, JSON.stringify(prep3?.dateRange))
const inv3b = await call('POST', '/sales/invoices', { dcId: DC3.id, billingAddress:'Metro Menswear Wholesale, Karol Bagh, New Delhi 110005' }, SALES)
const INV3B = must(inv3b, 'the Delhi challan billed again')
check('I8', `billed again on a new number, ${INV3B.invoiceNumber}`, inv3b.status === 201 && INV3B.invoiceNumber !== INV3.invoiceNumber && near(INV3B.totalAmount, inv3Want.total))

// An old invoice for the ageing: order and challan dated 44 days back.
const so3r = await call('POST', '/sales/orders', { customerId: ORIENT.id, confirm: true, orderDate: day(-45).toISOString(), deliveryDate: day(-41).toISOString(), customerPORef: `ORS-OLD-${RUN}`, lines: [{ itemId: TRO.id, totalQty: 5, unitPrice: 500, sizes: sizes(TS, { 32: 5 }) }] }, SALES)
const SO3 = must(so3r, 'the back-dated order')
const DC4 = must(await call('POST', '/sales/challans', dcBody(SO3.id, [{ soLineId: SO3.lines[0].id, sizes: sizes(TS, { 32: 5 }) }], { dcDate: day(-44).toISOString() }), SALES), 'the back-dated challan')
const early = await call('POST', '/sales/invoices', { dcId: DC4.id, invoiceDate: day(-50).toISOString() }, SALES)
check('I9', 'an invoice cannot be dated before its order', early.status === 400 && early.body?.code === 'BEFORE_ORDER', err(early))
const backDated = await call('POST', '/sales/invoices', { dcId: DC4.id, invoiceDate: day(-44).toISOString(), dueDate: day(-40).toISOString() }, SALES)
check('I9', `nor before the year's last invoice, so the numbers stay in date order (${ymd(day(-44))} is refused)`, backDated.status === 400 && backDated.body?.code === 'BEFORE_LAST_INVOICE' && /date order/.test(backDated.body?.message ?? ''), err(backDated))
if (backDated.status === 201) await call('POST', `/sales/invoices/${backDated.body.data.id}/cancel`, { reason: 'Back-dated probe, cancelled by the test' }, SALES)
const INV4 = must(await call('POST', '/sales/invoices', { dcId: DC4.id }, SALES), 'the invoice for the ageing')
check('I9', `${INV4.invoiceNumber}, dated today: ₹2,500 + 5% = ₹2,625`, near(INV4.totalAmount, 2625) && ymd(new Date(INV4.invoiceDate)) === ymd(day(0)))
// A test cannot wait 44 days: the invoice is moved back in the demo database, as if it had been raised then and fallen due 40 days ago.
await db.query(`UPDATE sales_invoices SET "invoiceDate" = $2, "dueDate" = $3 WHERE id = $1`, [INV4.id, day(-44), day(-40)])

// ════════════════ P. Payments received ════════════════
const kR = await call('POST', '/sales/receipts', { customerId: ORIENT.id, mode: 'CASH', amount: 100 }, KEEPER)
check('P1', 'the store keeper cannot record a receipt', kR.status === 403, err(kR))
const noRef = await call('POST', '/sales/receipts', { customerId: ORIENT.id, mode: 'NEFT', bankAccountId: BANK.id, amount: 100 }, SALES)
check('P1', 'an NEFT receipt needs its UTR', noRef.status === 400, err(noRef))
const r1 = await call('POST', '/sales/receipts', { customerId: ORIENT.id, mode: 'NEFT', bankAccountId: BANK.id, referenceNo: `UTR${RUN}1`, amount: 10000, allocations: [{ invoiceId: INV1.id, amount: 10000 }] }, SALES)
const R1 = must(r1, 'the part payment')
let i1 = await invRow(INV1.id)
check('P2', `${R1.receiptNumber}: ₹10,000 part payment on ${INV1.invoiceNumber} — part paid, balance ₹${r2(N(INV1.totalAmount) - 10000)}`, i1.status === 'PARTIAL' && i1.paid === 10000 && near(i1.balance, N(INV1.totalAmount) - 10000) && N(R1.onAccount) === 0, JSON.stringify(i1))
const cxPaid = await call('POST', `/sales/invoices/${INV1.id}/cancel`, { reason: 'Trying to cancel a paid invoice' }, SALES)
check('P2', 'an invoice with money against it cannot be cancelled', cxPaid.status === 409 && cxPaid.body?.code === 'HAS_PAYMENTS', err(cxPaid))
const rcBefore = await series('RCPT')
const over = await call('POST', '/sales/receipts', { customerId: ORIENT.id, mode: 'NEFT', bankAccountId: BANK.id, referenceNo: `UTR${RUN}X`, amount: 99999, allocations: [{ invoiceId: INV1.id, amount: i1.balance + 1 }] }, SALES)
const overR = await call('POST', '/sales/receipts', { customerId: ORIENT.id, mode: 'CASH', amount: 100, allocations: [{ invoiceId: INV1.id, amount: 200 }] }, SALES)
const wrongCust = await call('POST', '/sales/receipts', { customerId: METRO.id, mode: 'CASH', amount: 100, allocations: [{ invoiceId: INV1.id, amount: 100 }] }, SALES)
check('P3', 'refused: more than the invoice owes, more than was received, another customer\'s invoice; no number taken', over.status === 400 && over.body?.code === 'OVERPAYMENT' && overR.status === 400 && wrongCust.status === 400 && wrongCust.body?.code === 'WRONG_CUSTOMER' && (await series('RCPT')) === rcBefore, `${err(over)} / ${err(overR)} / ${err(wrongCust)}`)
const TDS = r2(N(INV1.taxableAmount) * 0.001)
const cashOn1 = r2(i1.balance - TDS)
const r2r = await call('POST', '/sales/receipts', { customerId: ORIENT.id, mode: 'RTGS', bankAccountId: BANK.id, referenceNo: `UTR${RUN}2`, amount: r2(cashOn1 + 5000), allocations: [{ invoiceId: INV1.id, amount: cashOn1, tdsAmount: TDS }, { invoiceId: INV2.id, amount: 5000 }] }, SALES)
const R2 = must(r2r, 'the receipt across two invoices')
i1 = await invRow(INV1.id)
let i2 = await invRow(INV2.id)
check('P4', `${R2.receiptNumber}: one RTGS settles the rest of ${INV1.invoiceNumber} (₹${TDS} TDS deducted by the buyer) and ₹5,000 of ${INV2.invoiceNumber}`, i1.status === 'PAID' && i1.balance === 0 && near(i1.tds, TDS) && near(i1.paid, 10000 + cashOn1) && i2.status === 'PARTIAL' && i2.paid === 5000 && near(i2.balance, N(INV2.totalAmount) - 5000), `${JSON.stringify(i1)} ${JSON.stringify(i2)}`)
check('P4', 'the receipt records the TDS and leaves nothing on account', near(R2.tdsAmount, TDS) && N(R2.onAccount) === 0 && R2.allocations.length === 2, JSON.stringify({ tds: R2.tdsAmount, on: R2.onAccount }))
const onAcc = async (cid) => Number((await q(`SELECT (COALESCE((SELECT SUM("onAccount") FROM payment_receipts WHERE "customerId"=$1 AND status='POSTED'),0) + COALESCE((SELECT SUM("onAccount") FROM credit_notes WHERE "customerId"=$1 AND status='ISSUED'),0))::float8 v`, [cid]))[0].v)
const held0 = await onAcc(ORIENT.id)
const r3r = await call('POST', '/sales/receipts', { customerId: ORIENT.id, mode: 'CASH', amount: 3000, notes: 'Advance against the next lot' }, SALES)
const R3 = must(r3r, 'the advance')
const oi = (await call('GET', `/sales/receipts/open-invoices?customerId=${ORIENT.id}`, null, SALES)).body?.data
check('P5', `${R3.receiptNumber}: ₹3,000 advance with no invoice stays on account`, N(R3.onAccount) === 3000 && R3.allocations.length === 0 && near(oi?.onAccount, r2(Number((await q(`SELECT COALESCE(SUM("onAccount"),0)::float8 v FROM payment_receipts WHERE "customerId"=$1 AND status='POSTED'`, [ORIENT.id]))[0].v))), JSON.stringify({ on: R3.onAccount, form: oi?.onAccount }))
const ctxO = (await call('GET', `/sales/customers/${ORIENT.id}/context`, null, SALES)).body?.data?.credit
check('P5', 'the credit check counts it as paid in advance', near(ctxO?.onAccount, held0 + 3000), `${ctxO?.onAccount} vs ${held0 + 3000}`)
const alloc = await call('POST', `/sales/receipts/${R3.id}/allocate`, { allocations: [{ invoiceId: INV2.id, amount: 2000 }] }, SALES)
i2 = await invRow(INV2.id)
check('P6', `₹2,000 of the advance applied to ${INV2.invoiceNumber} later; ₹1,000 still on account`, alloc.status === 200 && N(alloc.body?.data?.onAccount) === 1000 && i2.paid === 7000, `${err(alloc)} ${JSON.stringify(i2)}`)
const allocTooMuch = await call('POST', `/sales/receipts/${R3.id}/allocate`, { allocations: [{ invoiceId: INV2.id, amount: 1500 }] }, SALES)
check('P6', 'no more can be applied than is on account', allocTooMuch.status === 400 && allocTooMuch.body?.code === 'MORE_THAN_ON_ACCOUNT', err(allocTooMuch))
const r4r = await call('POST', '/sales/receipts', { customerId: ORIENT.id, mode: 'CHEQUE', chequeNo: `${RUN}`.slice(-6).padStart(6, '0'), chequeDate: day(0).toISOString(), bankAccountId: BANK.id, amount: 4000, allocations: [{ invoiceId: INV2.id, amount: 4000 }] }, SALES)
const R4 = must(r4r, 'the cheque')
i2 = await invRow(INV2.id)
check('P7', `${R4.receiptNumber}: a cheque settles its invoice when recorded, marked not yet cleared`, R4.isChequeCleared === false && !R4.clearedAt && i2.paid === 11000, JSON.stringify({ c: R4.isChequeCleared, paid: i2.paid }))
const clr = await call('POST', `/sales/receipts/${R4.id}/cleared`, {}, SALES)
const clr2 = await call('POST', `/sales/receipts/${R4.id}/cleared`, {}, SALES)
check('P7', 'marked cleared when the bank credits it; not twice', clr.status === 200 && clr.body?.data?.isChequeCleared === true && !!clr.body?.data?.clearedAt && clr2.status === 409, `${err(clr)} / ${err(clr2)}`)
const r5r = await call('POST', '/sales/receipts', { customerId: ORIENT.id, mode: 'CHEQUE', chequeNo: '0' + `${RUN}`.slice(-5), chequeDate: day(0).toISOString(), amount: 1500, allocations: [{ invoiceId: INV4.id, amount: 1500 }] }, SALES)
const R5 = must(r5r, 'the cheque that bounces')
let i4 = await invRow(INV4.id)
check('P8', `${R5.receiptNumber}: ₹1,500 cheque against ${INV4.invoiceNumber}, part paid`, i4.status === 'PARTIAL' && i4.paid === 1500)
const kRev = await call('POST', `/sales/receipts/${R5.id}/reverse`, { reason: 'Cheque returned unpaid' }, KEEPER)
check('P8', 'the store keeper cannot reverse a receipt', kRev.status === 403, err(kRev))
const rev5 = await call('POST', `/sales/receipts/${R5.id}/reverse`, { reason: 'Cheque returned: funds insufficient' }, SALES)
const rev5b = await call('POST', `/sales/receipts/${R5.id}/reverse`, { reason: 'Again' }, SALES)
i4 = await invRow(INV4.id)
check('P8', 'the bounced cheque is reversed with its reason: the invoice is owed in full again; not reversed twice', rev5.status === 200 && rev5.body?.data?.status === 'REVERSED' && rev5.body?.data?.reversalReason?.includes('insufficient') && i4.status === 'UNPAID' && i4.paid === 0 && near(i4.balance, 2625) && rev5b.status === 409, `${err(rev5)} ${JSON.stringify(i4)}`)
// What Orient owes, as the outstanding screen ages it.
const owedDb = Number((await q(`SELECT COALESCE(SUM("balanceAmount"),0)::float8 v FROM sales_invoices WHERE "customerId"=$1 AND status IN ('UNPAID','PARTIAL')`, [ORIENT.id]))[0].v)
const out = await call('GET', `/sales/receipts/outstanding?q=${encodeURIComponent('Orient Overseas')}`, null, SALES)
const orow = out.body?.data?.find((r) => r.customer.id === ORIENT.id)
const old = orow?.invoices?.find((i) => i.id === INV4.id)
check('P9', `outstanding: ${ORIENT.name} owes ₹${owedDb.toLocaleString('en-IN')} on open invoices, less ₹${(await onAcc(ORIENT.id)).toLocaleString('en-IN')} held`, out.status === 200 && orow && near(orow.total, owedDb) && near(orow.onAccount, await onAcc(ORIENT.id)) && near(orow.net, owedDb - (await onAcc(ORIENT.id))), `${err(out)} ${JSON.stringify(orow && { t: orow.total, on: orow.onAccount, net: orow.net })}`)
check('P9', `ageing: ${INV4.invoiceNumber} is 40 days past due, in the 31–60 bucket; ${INV2.invoiceNumber} not yet due`, old?.daysOverdue === 40 && orow?.buckets?.d60 >= 2625 && orow?.invoices?.some((i) => i.id === INV2.id && i.daysOverdue === 0) && !orow?.invoices?.some((i) => i.id === INV1.id), JSON.stringify({ days: old?.daysOverdue, b: orow?.buckets }))
const ctxO2 = (await call('GET', `/sales/customers/${ORIENT.id}/context`, null, SALES)).body?.data?.credit
check('P9', 'the credit position agrees: unpaid and overdue', ctxO2 && near(ctxO2.unpaid, owedDb) && ctxO2.overdue >= 2625, JSON.stringify(ctxO2 && { u: ctxO2.unpaid, o: ctxO2.overdue }))
const so = (await call('GET', '/sales/outstanding', null, SALES)).body?.data ?? []
check('P9', 'the open-invoice list carries the part-paid and unpaid ones, not the paid one', so.some((i) => i.id === INV2.id) && so.some((i) => i.id === INV4.id) && !so.some((i) => i.id === INV1.id))

// ════════════════ C. Credit notes and sales returns ════════════════
const kCn = await call('POST', '/sales/credit-notes', { invoiceId: INV2.id, type: 'RETURN', warehouseId: STORE.id, reason: 'Damaged', lines: [{ invoiceLineId: il(INV2, TRO.id).id, sizes: sizes(TS, { 36: 1 }) }] }, KEEPER)
check('C1', 'the store keeper cannot raise a credit note', kCn.status === 403, err(kCn))
const cprep = (await call('GET', `/sales/credit-notes/prepare?invoiceId=${INV2.id}`, null, SALES)).body?.data
const cpl = cprep?.lines?.find((l) => l.invoiceLineId === il(INV2, TRO.id).id)
check('C2', 'the return form shows what was invoiced by size and offers the challan\'s store', cpl && cpl.sizes.some((s) => s.sizeId === TS[36] && s.invoiced === 10) && cprep.defaultStoreId === STORE.id, JSON.stringify(cpl?.sizes))
const tooBack = await call('POST', '/sales/credit-notes', { invoiceId: INV2.id, type: 'RETURN', warehouseId: STORE.id, reason: 'Damaged', lines: [{ invoiceLineId: il(INV2, TRO.id).id, sizes: sizes(TS, { 36: 11 }) }] }, SALES)
check('C3', 'more cannot come back than was invoiced in that size', tooBack.status === 400 && tooBack.body?.code === 'MORE_THAN_INVOICED', err(tooBack))
const t36 = await stk(TRO, 36)
i2 = await invRow(INV2.id)
const cn1r = await call('POST', '/sales/credit-notes', { invoiceId: INV2.id, type: 'RETURN', warehouseId: STORE.id, reason: 'Stitching fault on 2 pieces', lines: [{ invoiceLineId: il(INV2, TRO.id).id, sizes: sizes(TS, { 36: 2 }) }] }, SALES)
const CN1 = must(cn1r, 'the sales return')
const per = N(il(INV2, TRO.id).taxableValue) / N(il(INV2, TRO.id).qty)
const cnTax = r2(2 * per), cnTot = Math.round(cnTax + 2 * r2((cnTax * 5) / 200))
const cnIn = (await q(`SELECT "inQty"::float8 q, "unitRate"::float8 r, grade, "warehouseId" w FROM stock_ledger WHERE "referenceId"=$1 AND "referenceType"='CREDIT_NOTE'`, [CN1.id]))
check('C4', `${CN1.noteNumber}: 2 chinos back at what the invoice charged (₹${r2(per)} each): taxable ₹${cnTax}, 5% split CGST/SGST, ₹${cnTot}`, near(CN1.taxableAmount, cnTax) && near(CN1.totalAmount, cnTot) && near(CN1.cgst, CN1.sgst) && N(CN1.igst) === 0, JSON.stringify({ t: CN1.taxableAmount, tot: CN1.totalAmount }))
check('C4', `the pieces are back in ${STORE.name}, size 36, grade A, at the BOM cost ₹${TRO.cost} (not the selling price)`, (await stk(TRO, 36)) === t36 + 2 && cnIn.length === 1 && cnIn[0].grade === 'A' && cnIn[0].w === STORE.id && near(cnIn[0].r, TRO.cost), JSON.stringify(cnIn))
const i2c = await invRow(INV2.id)
check('C4', `${INV2.invoiceNumber} is credited ₹${cnTot} and owes that much less`, near(i2c.credited, i2.credited + cnTot) && near(i2c.balance, i2.balance - cnTot) && i2c.status === 'PARTIAL', `${JSON.stringify(i2)} → ${JSON.stringify(i2c)}`)
const tooBack2 = await call('POST', '/sales/credit-notes', { invoiceId: INV2.id, type: 'RETURN', warehouseId: STORE.id, reason: 'More damaged', lines: [{ invoiceLineId: il(INV2, TRO.id).id, sizes: sizes(TS, { 36: 9 }) }] }, SALES)
check('C5', 'what has come back already counts: 9 more of size 36 is refused (8 left)', tooBack2.status === 400 && tooBack2.body?.code === 'MORE_THAN_INVOICED', err(tooBack2))
const kCnx = await call('POST', `/sales/credit-notes/${CN1.id}/cancel`, { reason: 'Raised by mistake' }, KEEPER)
check('C6', 'the store keeper cannot cancel a credit note', kCnx.status === 403, err(kCnx))
const cnx = await call('POST', `/sales/credit-notes/${CN1.id}/cancel`, { reason: 'Pieces were fine, raised by mistake' }, SALES)
const cnx2 = await call('POST', `/sales/credit-notes/${CN1.id}/cancel`, { reason: 'Again please' }, SALES)
const i2x = await invRow(INV2.id)
check('C6', 'cancelled: the 2 pieces leave the store again and the invoice owes what it did before; not twice', cnx.status === 200 && cnx.body?.data?.status === 'CANCELLED' && (await stk(TRO, 36)) === t36 && near(i2x.credited, i2.credited) && near(i2x.balance, i2.balance) && cnx2.status === 409, `${err(cnx)} ${JSON.stringify(i2x)}`)
const heldA = await onAcc(ORIENT.id)
const cn2r = await call('POST', '/sales/credit-notes', { invoiceId: INV1.id, type: 'ADJUSTMENT', reason: 'Rate difference agreed after billing', lines: [{ invoiceLineId: il(INV1, TRO.id).id, amount: 100 }] }, SALES)
const CN2 = must(cn2r, 'the rate-difference credit note')
const i1c = await invRow(INV1.id)
check('C7', `${CN2.noteNumber}: ₹100 + 5% on the paid ${INV1.invoiceNumber} moves no stock; all ₹105 stays with the customer as credit`, near(CN2.totalAmount, 105) && N(CN2.onAccount) === 105 && i1c.status === 'PAID' && i1c.credited === 0 && Number((await q(`SELECT COUNT(*)::int n FROM stock_ledger WHERE "referenceId"=$1`, [CN2.id]))[0].n) === 0, JSON.stringify({ t: CN2.totalAmount, on: CN2.onAccount, inv: i1c }))
check('C7', 'that credit shows on the customer\'s outstanding as held', near(await onAcc(ORIENT.id), heldA + 105) && near((await call('GET', `/sales/receipts/outstanding?q=${encodeURIComponent('Orient Overseas')}`, null, SALES)).body?.data?.find((r) => r.customer.id === ORIENT.id)?.onAccount, heldA + 105))
const i2pre = await invRow(INV2.id)
const kApply = await call('POST', `/sales/credit-notes/${CN2.id}/apply`, { allocations: [{ invoiceId: INV2.id, amount: 50 }] }, KEEPER)
check('C8', 'the store keeper cannot apply credit', kApply.status === 403, err(kApply))
const tooMuch = await call('POST', `/sales/credit-notes/${CN2.id}/apply`, { allocations: [{ invoiceId: INV2.id, amount: 106 }] }, SALES)
check('C8', `no more than the ₹105 ${CN2.noteNumber} holds can be applied`, tooMuch.status === 400 && tooMuch.body?.code === 'MORE_THAN_HELD', err(tooMuch))
const metroInv = await call('POST', `/sales/credit-notes/${CN2.id}/apply`, { allocations: [{ invoiceId: INV3B.id, amount: 10 }] }, SALES)
check('C8', "nor set against another customer's invoice", metroInv.status === 400 && metroInv.body?.code === 'WRONG_CUSTOMER', err(metroInv))
const applied = await call('POST', `/sales/credit-notes/${CN2.id}/apply`, { allocations: [{ invoiceId: INV2.id, amount: 50 }] }, SALES)
const i2ap = await invRow(INV2.id)
check('C8', `₹50 of it set against ${INV2.invoiceNumber}: the invoice owes ₹50 less, the note holds ₹55`, applied.status === 200 && near(applied.body?.data?.onAccount, 55) && near(i2ap.credited, i2pre.credited + 50) && near(i2ap.balance, i2pre.balance - 50) && applied.body?.data?.allocations?.some((a) => a.invoice?.invoiceNumber === INV2.invoiceNumber), `${err(applied)} ${JSON.stringify(i2ap)}`)
check('C8', 'the credit held on the outstanding goes down by the same ₹50', near(await onAcc(ORIENT.id), heldA + 55))
const metroM = await stk(SHI, 'M'), fgsB = await bal(FGS.id, null)
const cn3r = await call('POST', '/sales/credit-notes', { invoiceId: INV3B.id, type: 'RETURN', warehouseId: STORE.id, reason: 'Wrong shade in one piece each', lines: [{ invoiceLineId: il(INV3B, SHI.id).id, sizes: sizes(SS, { M: 1 }) }, { invoiceLineId: il(INV3B, FGS.id).id, qty: 1 }] }, SALES)
const CN3 = must(cn3r, 'the Delhi return')
const fgsIn = (await q(`SELECT "unitRate"::float8 r FROM stock_ledger WHERE "referenceId"=$1 AND "itemId"=$2`, [CN3.id, FGS.id]))[0]
check('C8', `${CN3.noteNumber} for the Delhi buyer: IGST only; a shirt back in size M, and one ${FGS.code} back by the piece at its standard rate`, N(CN3.igst) > 0 && N(CN3.cgst) === 0 && (await stk(SHI, 'M')) === metroM + 1 && (await bal(FGS.id, null)) === fgsB + 1 && near(fgsIn?.r, FGS.std), JSON.stringify({ i: CN3.igst, c: CN3.cgst, fgsRate: fgsIn?.r }))
const cx3b = await call('POST', `/sales/invoices/${INV3B.id}/cancel`, { reason: 'Trying to cancel a credited invoice' }, SALES)
check('C8', 'an invoice with a credit note against it cannot be cancelled', cx3b.status === 409 && cx3b.body?.code === 'HAS_CREDIT_NOTES', err(cx3b))

// ════════════════ S. Short-close ════════════════
const book = await call('GET', `/reports/sales-order-book/run?q=${encodeURIComponent(SO1.soNumber)}`, null, SALES)
check('S1', `the order book lists ${SO1.soNumber} with pieces still to send`, book.status === 200 && book.body?.data?.rows?.some((r) => r.soNumber === SO1.soNumber && r.pending > 0), err(book))
const kSc = await call('POST', `/sales/orders/${SO1.id}/short-close`, { reason: 'Buyer does not want the balance' }, KEEPER)
check('S2', 'the store keeper cannot short-close an order', kSc.status === 403, err(kSc))
if (CH4?.id) {
  const nothing = await call('POST', `/sales/orders/${CH4.id}/short-close`, { reason: 'Nothing sent yet' }, SALES)
  check('S2', 'an order with nothing made or sent is cancelled, not short-closed', nothing.status === 409 && nothing.body?.code === 'NOTHING_STARTED', err(nothing))
  await call('POST', `/sales/orders/${CH4.id}/cancel`, { reason: 'Test order for the amendment' }, SALES)
}
const sc = await call('POST', `/sales/orders/${SO1.id}/short-close`, { reason: 'Buyer does not want the balance this season' }, SALES)
const SO1c = await getOrder(SO1.id)
check('S3', 'short-closed by a manager at what was sent: completed, nothing pending, the reason kept', sc.status === 200 && SO1c.status === 'COMPLETED' && SO1c.lines.every((l) => N(l.pendingQty) === 0) && SO1c.shortCloseReason?.includes('this season') && SO1c.shortClosedById === SALES_ID && N(lineOf(SO1c, TRO.id).deliveredQty) === 32, err(sc))
const after = await call('POST', '/sales/challans', dcBody(SO1.id, [{ soLineId: L1.id, sizes: sizes(TS, { 32: 1 }) }]), SALES)
const cxDone = await call('POST', `/sales/orders/${SO1.id}/cancel`, { reason: 'Trying to cancel a closed order' }, SALES)
check('S3', 'nothing more goes against it, and it cannot be cancelled now', after.status === 409 && after.body?.code === 'ORDER_NOT_OPEN' && cxDone.status === 409, `${err(after)} / ${err(cxDone)}`)
const book2 = await call('GET', `/reports/sales-order-book/run?q=${encodeURIComponent(SO1.soNumber)}`, null, SALES)
check('S3', 'and it leaves the order book', book2.status === 200 && !book2.body?.data?.rows?.some((r) => r.soNumber === SO1.soNumber))

// ════════════════ K. Who may do what ════════════════
const kq = await call('POST', '/sales/quotations', { customerId: ORIENT.id, lines: [{ itemId: SHI.id, qty: 1, unitPrice: 450 }] }, KEEPER)
const ko = await call('POST', '/sales/orders', { customerId: ORIENT.id, lines: [{ itemId: SHI.id, totalQty: 1, unitPrice: 450, sizes: sizes(SS, { M: 1 }) }] }, KEEPER)
const kd = await call('POST', '/sales/challans', dcBody(SO2.id, [{ soLineId: lineOf(SO2, TRO.id).id, sizes: sizes(TS, { 32: 1 }) }]), KEEPER)
check('K1', 'the store keeper cannot quote, order or dispatch', kq.status === 403 && ko.status === 403 && kd.status === 403, `${kq.status}/${ko.status}/${kd.status}`)
const kv = await call('GET', '/sales/invoices', null, KEEPER)
const ka = await call('POST', `/sales/receipts/${R3.id}/allocate`, { allocations: [{ invoiceId: INV2.id, amount: 1 }] }, KEEPER)
check('K1', 'but can read invoices (sales:view), and cannot apply an advance', kv.status === 200 && ka.status === 403, `${kv.status}/${ka.status}`)
const sv = await call('GET', `/finished-goods/stock?itemIds=${TRO.id}&warehouseId=${STORE.id}`, null, SALES)
// The list carries only sizes with stock; each figure must be the ledger's.
const svRows = sv.body?.data ?? []
const svOk = (await Promise.all(svRows.map(async (r) => r.grade !== 'A' || (await bal(TRO.id, r.sizeId)) === r.qty))).every(Boolean)
const t34Now = await stk(TRO, 34)
check('K2', 'the sales user reads finished-goods stock by size (inventory:view), matching the ledger — and did every sales step above', sv.status === 200 && svOk && (t34Now > 0 ? svRows.some((r) => r.sizeId === TS[34] && r.grade === 'A' && r.qty === t34Now) : true), `${err(sv)} ${JSON.stringify(svRows.map((r) => [r.sizeId === TS[34] ? '34' : r.sizeId, r.grade, r.qty]))} ledger 34: ${t34Now}`)

// ════════════════ R. Prints, dashboard, reports ════════════════
const pr = async (path) => call('GET', path, null, SALES)
const pSo = (await pr(`/sales/orders/${SO1.id}/print`)).body?.data
check('R1', 'order print: company and customer GSTIN, HSN on lines, total in words, CGST + SGST', pSo?.company?.gstin === CO.gstin && pSo?.order?.customer?.gstin === ORIENT.gstin && pSo?.order?.lines?.every((l) => l.hsnCode) && /rupees/i.test(pSo?.totalInWords ?? '') && pSo?.taxMode === 'CGST_SGST' && !!pSo?.placeOfSupplyState, JSON.stringify(pSo && { g: pSo.company?.gstin, w: pSo.totalInWords, t: pSo.taxMode, pos: pSo.placeOfSupplyState }))
const pQt = (await pr(`/sales/quotations/${QB.id}/print`)).body?.data
check('R2', 'quotation print: number, customer GSTIN, HSN, total in words', pQt?.quote?.quoteNumber === QB.quoteNumber && pQt?.quote?.customer?.gstin === ORIENT.gstin && pQt?.quote?.lines?.every((l) => l.hsnCode) && /rupees/i.test(pQt?.totalInWords ?? ''), JSON.stringify(pQt && { w: pQt.totalInWords }))
const pDc = (await pr(`/sales/challans/${DC1.id}/print`)).body?.data
const dcValue = r2(15 * 530 + 10 * 2600)
check('R3', `challan print: e-way bill, vehicle, LR, transporter, HSN, value of goods (₹${dcValue}) in words`, pDc?.challan?.eWayBillNumber === `EWB${RUN}01` && pDc?.challan?.vehicleNumber === 'MH04AB1234' && !!pDc?.challan?.lrNumber && !!pDc?.challan?.transporter && pDc?.challan?.lines?.every((l) => l.item?.hsnCode) && near(pDc?.value, dcValue) && /rupees/i.test(pDc?.valueInWords ?? '') && pDc?.challan?.customer?.gstin === ORIENT.gstin, JSON.stringify(pDc && { v: pDc.value, e: pDc.challan?.eWayBillNumber }))
if (pDc && !near(pDc.value, r2(N(INV1.taxableAmount)))) note('R3', `${DC1.dcNumber} prints the goods at ₹${pDc.value} (order rate, before the order's bill discount) while ${INV1.invoiceNumber} bills them at ₹${N(INV1.taxableAmount)} taxable: the e-way bill value on the challan is not the invoice value.`)
const pInv = (await pr(`/sales/invoices/${INV1.id}/print`)).body?.data
const hs = pInv?.hsnSummary ?? []
check('R4', 'invoice print: GSTINs, place of supply, e-way bill no. and date, total and tax in words', pInv?.company?.gstin === CO.gstin && pInv?.invoice?.customer?.gstin === ORIENT.gstin && !!pInv?.placeOfSupplyState && pInv?.invoice?.eWayBillNumber === `EWB${RUN}01` && !!pInv?.invoice?.eWayBillDate && /rupees/i.test(pInv?.totalInWords ?? '') && /rupees/i.test(pInv?.taxInWords ?? '') && pInv?.taxMode === 'CGST_SGST', JSON.stringify(pInv && { w: pInv.totalInWords, tw: pInv.taxInWords }))
const inv1Charges = r2(sum(INV1.charges ?? [], (c) => N(c.amount)))
check('R4', `invoice print: HSN-wise tax summary (${TRO.hsn} at 5%, ${SHI.hsn} at 18%), the transport counted under its goods`, hs.some((h) => h.hsn === TRO.hsn && h.rate === 5) && hs.some((h) => h.hsn === SHI.hsn && h.rate === 18) && !hs.some((h) => /transport/i.test(h.hsn)) && near(sum(hs, (h) => h.taxable), r2(N(INV1.taxableAmount) + inv1Charges), 0.02) && near(sum(hs, (h) => h.cgst + h.sgst + h.igst), r2(N(INV1.cgst) + N(INV1.sgst) + N(INV1.igst)), 0.03), JSON.stringify(hs))
check('R4', `the transport on ${INV1.invoiceNumber} is split by the goods' rates: one row at 5%, one at 18%`, (INV1.charges ?? []).filter((c) => c.chargeTypeId === TRANSPORT.id).map((c) => N(c.gstRate)).sort((a, b) => a - b).join() === '5,18', JSON.stringify(INV1.charges))
check('R4', 'invoice print: the company\'s bank details for payment', !!pInv?.company?.bankAccount && !!pInv?.company?.bankIFSC && pInv?.company?.bankAccount === CO.bankAccount, JSON.stringify(pInv?.company && { a: pInv.company.bankAccount, i: pInv.company.bankIFSC, show: pInv.template?.showBankDetails }))
if (pInv && pInv.template?.showBankDetails === false) note('R4', 'the INV template in Settings → Documents has bank details switched off, so the printed invoice will not show them.')
const pCn = (await pr(`/sales/credit-notes/${CN2.id}/print`)).body?.data
check('R5', 'credit note print: the invoice it reduces, HSN, total in words', pCn?.note?.invoice?.invoiceNumber === INV1.invoiceNumber && pCn?.note?.lines?.every((l) => l.hsnCode) && /rupees/i.test(pCn?.totalInWords ?? '') && pCn?.company?.gstin === CO.gstin, JSON.stringify(pCn && { i: pCn.note?.invoice?.invoiceNumber, w: pCn.totalInWords }))
const pR = (await pr(`/sales/receipts/${R2.id}/print`)).body?.data
check('R6', 'receipt print: amount in words and the invoices settled', /rupees/i.test(pR?.amountInWords ?? '') && pR?.receipt?.allocations?.length === 2, JSON.stringify(pR && { w: pR.amountInWords }))
const pages = [['sales-order', SO1.id], ['quotation', QB.id], ['delivery-challan', DC1.id], ['sales-invoice', INV1.id], ['credit-note', CN2.id], ['payment-receipt', R2.id]]
for (const [page, id] of pages) {
  let st = 0, html = ''
  try { const r = await fetch(`${WEB}/print/${page}/${id}`); st = r.status; html = await r.text() } catch (e) { html = e.message }
  check('R7', `web print page /print/${page}/<id> opens (200)`, st === 200 && /<html/i.test(html), `${st} ${html.slice(0, 120)}`)
}
const dash = await call('GET', `/sales/dashboard?from=${ymd(day(-60))}&to=${ymd(day(0))}`, null, SALES)
check('R8', 'the sales dashboard runs for the last 60 days', dash.status === 200 && dash.body?.data?.kpis?.invoiced?.invoices > 0 && dash.body?.data?.now?.receivables?.value >= 0, err(dash))
for (const p of ['/sales/orders/summary', '/sales/invoices/summary', '/sales/receipts/summary', '/sales/quotations/summary']) {
  const r = await call('GET', p, null, SALES)
  check('R8', `${p} answers`, r.status === 200, err(r))
}
const list = (await call('GET', '/reports', null, SALES)).body?.data ?? []
const salesReports = list.filter((r) => r.module === 'sales').map((r) => r.id)
check('R9', `the report picker offers the sales reports (${salesReports.length})`, salesReports.length >= 7, salesReports.join(', '))
const range = `from=${ymd(day(-60))}&to=${ymd(day(0))}`
const runs = {}
for (const id of salesReports) {
  const r = await call('GET', `/reports/${id}/run?${range}`, null, SALES)
  runs[id] = r.body?.data
  check('R9', `report ${id} runs`, r.status === 200 && Array.isArray(r.body?.data?.rows), err(r))
  const x = await fetch(`${API}/reports/${id}/export?${range}`, { headers: { authorization: `Bearer ${SALES}` } })
  check('R9', `report ${id} downloads as Excel`, x.status === 200 && /spreadsheetml/.test(x.headers.get('content-type') ?? '') && (await x.arrayBuffer()).byteLength > 3000, `${x.status}`)
}
const reg = runs['sales-register']?.rows ?? []
check('R10', `sales register: ${INV1.invoiceNumber}'s two lines, taxable as invoiced; the cancelled ${INV3.invoiceNumber} left out`, reg.filter((r) => r.invoiceNumber === INV1.invoiceNumber).length === 2 && near(sum(reg.filter((r) => r.invoiceNumber === INV1.invoiceNumber), (r) => r.taxable), lineTaxable) && !reg.some((r) => r.invoiceNumber === INV3.invoiceNumber))
const dreg = runs['sales-dispatch-register']?.rows ?? []
check('R10', `dispatch register: ${DC1.dcNumber} billed on ${INV1.invoiceNumber}; the cancelled challan left out`, dreg.some((r) => r.dcNumber === DC1.dcNumber && String(r.invoice ?? '').includes(INV1.invoiceNumber)) && !dreg.some((r) => r.dcNumber === DCX?.dcNumber), JSON.stringify(dreg.filter((r) => r.dcNumber === DC1.dcNumber).slice(0, 1)))
const ret = runs['sales-returns-register']?.rows ?? []
check('R10', `returns register: ${CN2.noteNumber} and ${CN3.noteNumber} in, the cancelled ${CN1.noteNumber} out`, ret.some((r) => r.noteNumber === CN2.noteNumber) && ret.some((r) => r.noteNumber === CN3.noteNumber) && !ret.some((r) => r.noteNumber === CN1.noteNumber))
const ageRows = (await call('GET', `/reports/sales-customer-outstanding/run?customerId=${ORIENT.id}`, null, SALES)).body?.data?.rows ?? []
check('R10', `customer outstanding report: ${INV4.invoiceNumber} in "31–60 days", 40 days overdue`, ageRows.some((r) => r.invoiceNumber === INV4.invoiceNumber && r.bucket === '31–60 days' && r.daysOverdue === 40 && near(r.balance, 2625)), JSON.stringify(ageRows.find((r) => r.invoiceNumber === INV4.invoiceNumber)))
const hsnRows = runs['sales-hsn-summary']?.rows ?? []
const from = new Date(`${ymd(day(-60))}T00:00:00`), to = new Date(`${ymd(day(0))}T23:59:59.999`)
const [g] = await q(`SELECT
   (SELECT COALESCE(SUM(l.cgst+l.sgst+l.igst),0) FROM sales_invoice_lines l JOIN sales_invoices i ON i.id=l."invoiceId" WHERE i.status<>'CANCELLED' AND i."invoiceDate" BETWEEN $1 AND $2)::float8 lines,
   (SELECT COALESCE(SUM(c.cgst+c.sgst+c.igst),0) FROM sales_invoice_charges c JOIN sales_invoices i ON i.id=c."invoiceId" WHERE i.status<>'CANCELLED' AND i."invoiceDate" BETWEEN $1 AND $2)::float8 charges,
   (SELECT COALESCE(SUM(l.cgst+l.sgst+l.igst),0) FROM credit_note_lines l JOIN credit_notes n ON n.id=l."noteId" WHERE n.status='ISSUED' AND n."noteDate" BETWEEN $1 AND $2)::float8 credits`, [from, to])
const hsnTax = r2(sum(hsnRows, (r) => r.cgst + r.sgst + r.igst))
check('R10', `HSN summary: ${SHI.hsn} at 18% and ${TRO.hsn} at 5% present`, hsnRows.some((r) => r.hsnCode === SHI.hsn && near(r.rate, 0.18)) && hsnRows.some((r) => r.hsnCode === TRO.hsn && near(r.rate, 0.05)), JSON.stringify(hsnRows.map((r) => [r.hsnCode, r.rate])))
check('R10', `HSN summary covers all GST invoiced in the period, charges included (₹${r2(g.lines + g.charges - g.credits)})`, near(hsnTax, r2(g.lines + g.charges - g.credits), 0.05), `report ₹${hsnTax} leaves out ₹${r2(g.charges)} GST on invoice charges (transport, packing)`)

// ════════════════ Tidy: what this run left owed is paid, the extra credit cancelled ════════════════
const i2beforeTidy = await invRow(INV2.id)
const cnTidy = await call('POST', `/sales/credit-notes/${CN2.id}/cancel`, { reason: 'Test credit note, tidied at the end of the run' }, SALES)
const i2afterTidy = await invRow(INV2.id)
check('T1', 'a rate-difference credit note is cancelled: the credit held goes back to nothing', cnTidy.status === 200 && N(cnTidy.body?.data?.onAccount) === 0, err(cnTidy))
check('T1', `and the ₹50 it set against ${INV2.invoiceNumber} comes off it again`, near(i2afterTidy.credited, i2beforeTidy.credited - 50) && (i2beforeTidy.status === 'PAID' || near(i2afterTidy.balance, i2beforeTidy.balance + 50)), `${JSON.stringify(i2beforeTidy)} → ${JSON.stringify(i2afterTidy)}`)
const settled = []
for (const [cid, invs, adv] of [[ORIENT.id, [INV2, INV4], R3], [METRO.id, [INV3B], null]]) {
  const owe = []
  for (const inv of invs) { const r = await invRow(inv.id); if (r.balance > 0) owe.push({ invoiceId: inv.id, amount: r.balance }) }
  let fromAdv = 0
  if (adv && owe.length) {
    const left = N((await q(`SELECT "onAccount"::float8 v FROM payment_receipts WHERE id=$1`, [adv.id]))[0].v)
    fromAdv = Math.min(left, owe[0].amount)
    if (fromAdv > 0) must(await call('POST', `/sales/receipts/${adv.id}/allocate`, { allocations: [{ invoiceId: owe[0].invoiceId, amount: fromAdv }] }, SALES), 'apply the rest of the advance')
    owe[0].amount = r2(owe[0].amount - fromAdv)
  }
  const pay = owe.filter((o) => o.amount > 0)
  // Delhi first hands over a post-dated cheque, a fortnight ahead: it is held.
  if (cid === METRO.id && pay.length) {
    const amount = r2(sum(pay, (o) => o.amount))
    const pdcBody = { customerId: cid, mode: 'PDC', amount, bankAccountId: BANK.id, chequeNo: '7' + `${RUN}`.slice(-5), chequeDate: day(15).toISOString() }
    const withInv = await call('POST', '/sales/receipts', { ...pdcBody, allocations: pay }, SALES)
    check('T3', `a cheque dated ${ymd(day(15))} cannot settle invoices yet`, withInv.status === 400 && withInv.body?.code === 'CHEQUE_HELD', err(withInv))
    const before = await Promise.all(invs.map((i) => invRow(i.id)))
    const ctxBefore = (await call('GET', `/sales/customers/${cid}/context?value=0`, null, SALES)).body?.data?.credit
    const pdcR = await call('POST', '/sales/receipts', pdcBody, SALES)
    const PDC = must(pdcR, 'the post-dated cheque')
    const after = await Promise.all(invs.map((i) => invRow(i.id)))
    const ctxAfter = (await call('GET', `/sales/customers/${cid}/context?value=0`, null, SALES)).body?.data?.credit
    check('T3', `${PDC.receiptNumber} is recorded and held: the invoices still owe the same`, /held until/i.test(pdcR.body?.message ?? '') && near(PDC.onAccount, amount) && after.every((s, k) => s.status === before[k].status && near(s.balance, before[k].balance)), `${pdcR.body?.message} ${JSON.stringify(after)}`)
    check('T3', 'the credit check does not count it before its date', near(ctxAfter?.onAccount, ctxBefore?.onAccount), JSON.stringify({ b: ctxBefore?.onAccount, a: ctxAfter?.onAccount }))
    const early = await call('POST', `/sales/receipts/${PDC.id}/allocate`, { allocations: pay }, SALES)
    const earlyClear = await call('POST', `/sales/receipts/${PDC.id}/cleared`, {}, SALES)
    check('T3', 'it cannot be applied, nor marked cleared, before its date', early.status === 409 && early.body?.code === 'CHEQUE_HELD' && earlyClear.status === 409 && earlyClear.body?.code === 'CHEQUE_HELD', `${err(early)} / ${err(earlyClear)}`)
    must(await call('POST', `/sales/receipts/${PDC.id}/reverse`, { reason: 'Test cheque, taken back at the end of the run' }, SALES), 'take the test cheque back')
    settled.push(`${PDC.receiptNumber} (post-dated, reversed)`)
  }
  const settle = pay.length ? must(await call('POST', '/sales/receipts', { customerId: cid, amount: r2(sum(pay, (o) => o.amount)), allocations: pay, bankAccountId: BANK.id, mode: 'NEFT', referenceNo: `UTR${RUN}Z${cid.slice(-3)}` }, SALES), 'the settling receipt') : null
  if (settle) settled.push(settle.receiptNumber)
  const states = await Promise.all(invs.map((i) => invRow(i.id)))
  check('T2', `${invs.map((i) => i.invoiceNumber).join(', ')} paid in full at the end of the run`, states.every((s) => s.status === 'PAID' && s.balance === 0), JSON.stringify(states))
}

const nos = (...xs) => xs.filter(Boolean).join(', ')
console.log(`\ndocuments made by this run:
  quotations   ${nos(`${QA?.quoteNumber} (lost)`, `${QB?.quoteNumber} (won)`, qc.body?.data?.quoteNumber, qd.body?.data?.quoteNumber, qe.body?.data?.quoteNumber, qx.body?.data?.quoteNumber && `${qx.body.data.quoteNumber} (expired)`)}
  orders       ${nos(`${SO1.soNumber} (main, short-closed)`, `${SO2.soNumber} (Delhi)`, `${SO3.soNumber} (back-dated)`, CH1?.soNumber, CH2?.soNumber, CH3?.soNumber, CH4?.soNumber, ch5r.body?.data?.soNumber && `${ch5r.body.data.soNumber} (rejected)`, dr.body?.data?.soNumber, twice.body?.data?.soNumber, fromExpired?.body?.data?.soNumber)}
  goods in     ${nos(FG1.fgrNumber, FG2.fgrNumber)}
  challans     ${nos(DC1.dcNumber, DC2.dcNumber, DCX?.dcNumber && `${DCX.dcNumber} (cancelled)`, dcy.body?.data?.dcNumber && `${dcy.body.data.dcNumber} (draft, cancelled)`, `${DC3.dcNumber} (Delhi)`, `${DC4.dcNumber} (back-dated)`)}
  invoices     ${nos(INV1.invoiceNumber, INV2.invoiceNumber, `${INV3.invoiceNumber} (cancelled)`, future.body?.data?.invoiceNumber && `${future.body.data.invoiceNumber} (future-dated, cancelled)`, INV3B.invoiceNumber, `${INV4.invoiceNumber} (aged 44 days)`)}
  receipts     ${nos(R1.receiptNumber, R2.receiptNumber, R3.receiptNumber, R4.receiptNumber, `${R5.receiptNumber} (reversed)`, ...settled)}
  credit notes ${nos(`${CN1.noteNumber} (cancelled)`, `${CN2.noteNumber} (cancelled)`, CN3.noteNumber)}`)
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`)
await db.end()
await exit(fail ? 1 : 0)
