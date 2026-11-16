/**
 * Checks buying in packs (Item "Bought in": 1 box = 20 pcs) against a running
 * API and the demo database (lderp_demo) only. Refuses any other database.
 * Each run makes its own ZZTEST item, named with the time. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-buy-units-api.ts
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 500)}` : ''}`)
}
type Res = { status: number; body: any }
let token = ''
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  let j: any = null
  try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
const okay = (r: Res) => r.status >= 200 && r.status < 300
const near = (a: number, b: number) => Math.abs(a - b) < 0.006

async function main() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) { console.error('Set E2E_EMAIL and E2E_PASSWORD.'); process.exitCode = 2; return }
  const [{ current_database: dbName }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (dbName !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  token = (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())).accessToken
  if (!token) throw new Error('login failed')

  const units = (await call('GET', '/masters/uoms?limit=100')).body.data as Array<{ id: string; symbol: string }>
  const u = (s: string) => units.find((x) => x.symbol === s)!
  const cats = (await call('GET', '/masters/item-categories?limit=200')).body.data as Array<{ id: string; parentId: string | null }>
  const leaf = cats.find((c) => c.parentId) ?? cats[0]
  const stamp = Date.now().toString().slice(-6)
  const item = (await call('POST', '/masters/items', { name: `ZZTEST Button ${stamp}`, type: 'TRIM', categoryId: leaf.id, uomId: u('pcs').id })).body.data as { id: string }
  const store = ((await call('GET', '/masters/warehouses?limit=50')).body.data as Array<{ id: string; name: string }>).find((w) => w.name === 'Store')!
  const supplier = ((await call('GET', '/masters/suppliers?limit=5')).body.data as Array<{ id: string }>)[0]

  // ── Bought in ──
  const same = await call('PATCH', `/masters/items/${item.id}/buy-units`, { units: [{ uomId: u('pcs').id, factor: 1 }] })
  check('Bought in: its own unit is refused as a pack', same.status === 400 && same.body?.code === 'SAME_UNIT', same)
  const set = await call('PATCH', `/masters/items/${item.id}/buy-units`, { units: [{ uomId: u('box').id, factor: 20, isDefault: true }, { uomId: u('grs').id, factor: 144 }] })
  check('Bought in: box of 20 (usual) and gross of 144 saved', okay(set) && set.body?.data?.length === 2, set)
  const listed = (await call('GET', `/masters/items/${item.id}`)).body.data
  check('Item reads back its packs, the usual one first', listed?.buyUnits?.[0]?.uom?.symbol === 'box' && listed?.buyUnits?.[0]?.isDefault === true, listed?.buyUnits)

  // ── Purchase order in boxes ──
  const poBody = (lines: unknown[]) => ({ supplierId: supplier.id, deliveryWarehouseId: store.id, lines })
  const notPack = await call('POST', '/purchase/orders', poBody([{ itemId: item.id, uomId: u('set').id, qty: 2, unitRate: 99, gstRate: 12 }]))
  check('PO: a unit the item is not bought in is refused', notPack.status === 400 && notPack.body?.code === 'NOT_A_PACK', notPack)
  const halfBox = await call('POST', '/purchase/orders', poBody([{ itemId: item.id, uomId: u('box').id, qty: 2.5, unitRate: 99, gstRate: 12 }]))
  check('PO: 2.5 boxes refused (boxes are whole)', halfBox.status === 400 && halfBox.body?.code === 'QTY_NOT_IN_UNIT', halfBox)
  const po = await call('POST', '/purchase/orders', poBody([{ itemId: item.id, uomId: u('box').id, qty: 2, unitRate: 99, gstRate: 12 }]))
  check('PO: 2 boxes at ₹99 a box saved', okay(po), po)
  const pl = po.body?.data?.lines?.[0]
  check('PO line stores 40 pcs, the box and its size 20', Number(pl?.qty) === 40 && pl?.uomId === u('box').id && Number(pl?.uomFactor) === 20, pl)
  check('PO line is worth ₹198 (2 boxes × ₹99), not ₹3,960', near(Number(pl?.amount), 198), pl?.amount)
  check('PO total is ₹198 + 12% GST = ₹221.76 → ₹222', near(Number(po.body?.data?.totalAmount), 222) || near(Number(po.body?.data?.totalAmount), 221.76), po.body?.data?.totalAmount)
  check('PO pending is 40 pcs', Number(pl?.pendingQty) === 40, pl?.pendingQty)
  const sent = await call('PATCH', `/purchase/orders/${po.body.data.id}/send`, {})
  if (!okay(sent)) console.log('  (note) sending the PO:', sent.status, sent.body?.message)

  // ── Goods receipt: 1 box, then 25 loose pieces ──
  const grnBody = (lines: unknown[]) => ({ poId: po.body.data.id, challanNo: `ZZ-${stamp}-${Math.random().toString(36).slice(2, 6)}`, challanDate: new Date().toISOString(), lines })
  const halfIn = await call('POST', '/purchase/grn', grnBody([{ poLineId: pl.id, warehouseId: store.id, receivedQty: 0.5 }]))
  check('GRN: 0.5 box refused', halfIn.status === 400 && halfIn.body?.code === 'QTY_NOT_IN_UNIT', halfIn)
  const g1 = await call('POST', '/purchase/grn', grnBody([{ poLineId: pl.id, warehouseId: store.id, receivedQty: 1 }]))
  check('GRN: 1 box received', okay(g1), g1)
  const g1l = g1.body?.data?.lines?.[0]
  check('GRN line: 20 pcs, in boxes of 20, worth ₹99', Number(g1l?.receivedQty) === 20 && Number(g1l?.uomFactor) === 20 && near(Number(g1l?.amount), 99), g1l)
  const stock1 = await prisma.stockLedger.findMany({ where: { itemId: item.id, referenceType: 'GRN' }, select: { inQty: true, unitRate: true } })
  check('Stock: 20 pcs in, at ₹4.95 a piece (₹99 ÷ 20)', stock1.length === 1 && Number(stock1[0].inQty) === 20 && near(Number(stock1[0].unitRate), 4.95), stock1)
  const g2 = await call('POST', '/purchase/grn', grnBody([{ poLineId: pl.id, warehouseId: store.id, receivedQty: 20, inStockUnit: true }]))
  check('GRN: 20 loose pieces received against the box order', okay(g2), g2)
  const poAfter = (await call('GET', `/purchase/orders/${po.body.data.id}`)).body.data
  check('PO: 40 of 40 pcs received (1 box + 20 loose), nothing pending', Number(poAfter?.lines?.[0]?.receivedQty) === 40 && Number(poAfter?.lines?.[0]?.pendingQty) === 0, poAfter?.lines?.[0])

  // ── Bill: 2 boxes against the first receipt is more than came (1 box) ──
  const billBody = (lines: unknown[]) => ({ supplierId: supplier.id, supplierInvoiceNo: `ZZB-${stamp}-${Math.random().toString(36).slice(2, 6)}`, supplierInvoiceDate: new Date().toISOString(), lines })
  const overBill = await call('POST', '/purchase/bills', billBody([{ itemId: item.id, grnLineId: g1l.id, uomId: u('box').id, qty: 2, unitPrice: 99, gstRate: 12 }]))
  check('Bill: 2 boxes against a receipt of 1 box is refused (40 > 20 pcs)', overBill.status >= 400, overBill)
  const bill = await call('POST', '/purchase/bills', billBody([{ itemId: item.id, grnLineId: g1l.id, uomId: u('box').id, qty: 1, unitPrice: 99, gstRate: 12 }]))
  check('Bill: 1 box at ₹99 against that receipt', okay(bill), bill)
  const bl = bill.body?.data?.lines?.[0]
  check('Bill line: 20 pcs in boxes of 20, taxable ₹99', Number(bl?.qty) === 20 && Number(bl?.uomFactor) === 20 && near(Number(bl?.taxableValue), 99), bl)
  const g2l = g2.body?.data?.lines?.[0]
  const looseBill = await call('POST', '/purchase/bills', billBody([{ itemId: item.id, grnLineId: g2l?.id, qty: 20, unitPrice: 4.95, gstRate: 12 }]))
  check('Bill: the 20 loose pcs billed in pieces at ₹4.95 (no rate difference with ₹99 a box)', okay(looseBill) && near(Number(looseBill.body?.data?.lines?.[0]?.taxableValue), 99), looseBill.body?.data?.lines?.[0] ?? looseBill)
  const direct = await call('POST', '/purchase/bills', billBody([{ itemId: item.id, uomId: u('grs').id, qty: 1, unitPrice: 600, gstRate: 12 }]))
  check('Bill without a receipt: 1 gross at ₹600 → 144 pcs, taxable ₹600', okay(direct) && Number(direct.body?.data?.lines?.[0]?.qty) === 144 && near(Number(direct.body?.data?.lines?.[0]?.taxableValue), 600), direct.body?.data?.lines?.[0] ?? direct)

  // ── Return 10 pcs against the box bill: worth half a box ──
  const ret = await call('POST', '/purchase/returns', { billId: bill.body.data.id, returnDate: new Date().toISOString(), reasonNote: 'ZZTEST', lines: [{ billLineId: bl.id, warehouseId: store.id, qty: 10, reason: 'QUALITY_REJECTION' }] })
  check('Return: 10 pcs back against the box bill', okay(ret), ret)
  const rl = ret.body?.data?.lines?.[0]
  check('Return line keeps the bill pack: 10 pcs at ₹99 a box of 20', Number(rl?.qty) === 10 && Number(rl?.uomFactor) === 20, rl)
  const note = ret.body?.data?.notes?.[0] ?? ret.body?.data?.debitNote ?? null
  const noteRow = await prisma.purchaseNote.findFirst({ where: { returnId: ret.body?.data?.id }, select: { taxableAmount: true, lines: { select: { qty: true, uomFactor: true, taxableValue: true } } } })
  check('Its debit note: 10 pcs = half a box, taxable ₹49.50', !!noteRow && near(Number(noteRow.taxableAmount), 49.5), noteRow ?? note)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
