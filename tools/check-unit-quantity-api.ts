/**
 * Checks quantity precision by unit (UOM.decimalPlaces / Item.decimalPlaces)
 * against a running API and the demo database (lderp_demo) only. Refuses any
 * database that is not the demo. Each run makes its own ZZTEST items, named
 * with the time, so it can run again and again. From apps/api:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... E2E_API=http://localhost:5105/api npx tsx ../../tools/check-unit-quantity-api.ts
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 400)}` : ''}`)
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
  try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
const refused = (r: Res) => r.status === 400 && r.body?.code === 'QTY_NOT_IN_UNIT'
const okay = (r: Res) => r.status >= 200 && r.status < 300

export const WHOLE_MSG = 'Decimal quantities are not allowed for this item. Please enter a whole number.'

async function main() {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) {
    console.error('Set E2E_EMAIL and E2E_PASSWORD in your shell for this run.')
    process.exitCode = 2
    return
  }
  const [{ current_database: dbName }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (dbName !== 'lderp_demo') {
    console.error('Refusing to run: the database is not lderp_demo. These tests write data and run only on the local demo.')
    process.exitCode = 2
    return
  }
  const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())
  token = login.accessToken
  if (!token) throw new Error('login failed')

  // ── The units, as the migration left them ──
  const units = (await call('GET', '/masters/uoms?limit=100')).body.data as Array<{ id: string; symbol: string; decimalPlaces: number }>
  const unit = (s: string) => units.find((u) => u.symbol === s)!
  check('Units: Piece, Box, Set, Dozen, Gross are whole numbers', ['pcs', 'box', 'set', 'doz', 'grs'].every((s) => unit(s)?.decimalPlaces === 0), units)
  check('Units: Meter, Kilogram, Gram, Roll take decimals', ['mtr', 'kg', 'gm', 'roll'].every((s) => unit(s)?.decimalPlaces === 3), units)

  // ── Test items: a carton in boxes (whole), cloth in metres (decimals) ──
  const stamp = Date.now().toString().slice(-6)
  const cats = (await call('GET', '/masters/item-categories?limit=200')).body.data as Array<{ id: string; name: string; parentId: string | null }>
  const leaf = cats.find((c) => c.parentId) ?? cats[0]
  const mkItem = async (name: string, uomId: string, type = 'PACKING_MATERIAL') => {
    const r = await call('POST', '/masters/items', { name, type, categoryId: leaf.id, uomId })
    if (!okay(r)) throw new Error(`setup: ${name}: ${JSON.stringify(r.body)}`)
    return r.body.data as { id: string; code: string }
  }
  const carton = await mkItem(`ZZTEST Carton ${stamp}`, unit('box').id)
  const cloth = await mkItem(`ZZTEST Cloth ${stamp}`, unit('mtr').id, 'RAW_MATERIAL')
  const store = ((await call('GET', '/masters/warehouses?limit=50')).body.data as Array<{ id: string; name: string }>)[0]
  const dept = ((await call('GET', '/masters/departments?limit=50')).body.data as Array<{ id: string }>)[0]

  // Opening stock: 1 carton, 10.5 metres. Half a carton on opening is refused.
  const openHalf = await call('POST', '/inventory/opening', { warehouseId: store.id, lines: [{ itemId: carton.id, qty: 0.5, unitRate: 10 }] })
  check('Opening stock: 0.5 carton refused', refused(openHalf), openHalf)
  const open = await call('POST', '/inventory/opening', { warehouseId: store.id, lines: [{ itemId: carton.id, qty: 1, unitRate: 10 }, { itemId: cloth.id, qty: 10.5, unitRate: 100 }] })
  check('Opening stock: 1 carton and 10.5 metres taken', okay(open), open)

  // ── Raising ──
  const raise = (lines: Array<{ itemId: string; requestedQty: number }>) =>
    call('POST', '/inventory/requisitions', { departmentId: dept.id, lines: lines.map((l) => ({ ...l, warehouseId: store.id })) })
  const half = await raise([{ itemId: carton.id, requestedQty: 2.5 }])
  check('Raise: 2.5 cartons refused (400 QTY_NOT_IN_UNIT)', refused(half), half)
  check('Raise: the message is the one asked for', String(half.body?.message ?? '').includes(WHOLE_MSG), half.body?.message)
  const clothOk = await raise([{ itemId: cloth.id, requestedQty: 2.75 }])
  check('Raise: 2.75 metres taken', okay(clothOk), clothOk)
  const tooFine = await raise([{ itemId: cloth.id, requestedQty: 1.2345 }])
  check('Raise: 1.2345 metres refused (more than 3 places)', tooFine.status === 400, tooFine)
  const zero = await raise([{ itemId: carton.id, requestedQty: 0 }])
  check('Raise: zero refused', zero.status === 400, zero)
  const negative = await raise([{ itemId: carton.id, requestedQty: -1 }])
  check('Raise: negative refused', negative.status === 400, negative)
  const three = await raise([{ itemId: carton.id, requestedQty: 3 }])
  check('Raise: 3 cartons taken', okay(three), three)
  const mr = three.body?.data as { id: string; mrNumber: string; lines: Array<{ id: string }> }

  // ── Approving one raised before the rule (2.1 cartons, written straight in) ──
  const old = await raise([{ itemId: carton.id, requestedQty: 2 }])
  await prisma.materialRequisitionLine.updateMany({ where: { mrId: old.body.data.id }, data: { requestedQty: 2.1 } })
  const approveOld = await call('PATCH', `/inventory/requisitions/${old.body.data.id}/approve`, {})
  check('Approve: an old 2.1-carton requisition is refused, told to raise again', refused(approveOld) && /raise it again/.test(approveOld.body?.message ?? ''), approveOld)
  await call('PATCH', `/inventory/requisitions/${old.body.data.id}/reject`, { reason: 'ZZTEST fractional' })

  const approve = await call('PATCH', `/inventory/requisitions/${mr.id}/approve`, {})
  check('Approve: 3 cartons approved', okay(approve), approve)

  // ── The store: 1 on the rack, 2 to buy ──
  const lineId = mr.lines[0].id
  const buyHalf = await call('PATCH', `/inventory/requisitions/${mr.id}/plan`, { lines: [{ lineId, buyQty: 1.5 }] })
  check('Buy: 1.5 cartons on the indent refused', refused(buyHalf), buyHalf)
  const buy = await call('PATCH', `/inventory/requisitions/${mr.id}/plan`, { lines: [{ lineId, buyQty: 2 }] })
  check('Buy: 2 cartons on the indent taken', okay(buy), buy)
  const reserveHalf = await call('POST', `/inventory/requisitions/${mr.id}/reserve`, { lines: [{ lineId, warehouseId: store.id, qty: 0.5 }] })
  check('Reserve: 0.5 carton refused', refused(reserveHalf), reserveHalf)
  const issueHalf = await call('POST', `/inventory/requisitions/${mr.id}/issue`, { lines: [{ lineId, warehouseId: store.id, issueQty: 0.5 }], requestId: `zz-${stamp}-a` })
  check('Issue: 0.5 carton refused', refused(issueHalf), issueHalf)
  const issue = await call('POST', `/inventory/requisitions/${mr.id}/issue`, { lines: [{ lineId, warehouseId: store.id, issueQty: 1 }], requestId: `zz-${stamp}-b` })
  check('Issue: 1 carton issued', okay(issue), issue)

  // ── An item counted differently from its unit ──
  const loose = await call('PATCH', `/masters/items/${carton.id}`, { decimalPlaces: 1 })
  check('Item: one carton item set to 1 decimal place', okay(loose) && loose.body?.data?.decimalPlaces === 1, loose)
  const halfNow = await raise([{ itemId: carton.id, requestedQty: 2.5 }])
  check('Item override: 2.5 of it now taken', okay(halfNow), halfNow)
  const twoPlaces = await raise([{ itemId: carton.id, requestedQty: 2.25 }])
  check('Item override: 2.25 still refused (1 place)', refused(twoPlaces), twoPlaces)
  const back = await call('PATCH', `/masters/items/${carton.id}`, { decimalPlaces: null })
  check('Item: back to "as its unit"', okay(back) && back.body?.data?.decimalPlaces === null, back)
  const halfAgain = await raise([{ itemId: carton.id, requestedQty: 2.5 }])
  check('Item back to its unit: 2.5 refused again', refused(halfAgain), halfAgain)

  // ── Purchase: order, receipt, bill ──
  const supplier = ((await call('GET', '/masters/suppliers?limit=5')).body.data as Array<{ id: string }>)[0]
  const poBody = (qty: number) => ({ supplierId: supplier.id, deliveryWarehouseId: store.id, lines: [{ itemId: carton.id, qty, unitRate: 10, gstRate: 12 }] })
  const poHalf = await call('POST', '/purchase/orders', poBody(2.5))
  check('Purchase order: 2.5 cartons refused', refused(poHalf), poHalf)
  const po = await call('POST', '/purchase/orders', poBody(3))
  check('Purchase order: 3 cartons taken', okay(po), po)
  const poLine = po.body?.data?.lines?.[0]
  const poEditHalf = await call('PATCH', `/purchase/orders/${po.body?.data?.id}`, { lines: [{ itemId: carton.id, qty: 3.5, unitRate: 10, gstRate: 12 }] })
  check('Purchase order edit: 3.5 cartons refused', refused(poEditHalf), poEditHalf)
  const grnHalf = await call('POST', '/purchase/grn', { poId: po.body?.data?.id, challanNo: `ZZ-${stamp}`, challanDate: new Date().toISOString(), lines: [{ poLineId: poLine?.id, warehouseId: store.id, receivedQty: 1.5 }] })
  check('Goods receipt: 1.5 cartons received refused', refused(grnHalf), grnHalf)
  const grnPacks = await call('POST', '/purchase/grn', { poId: po.body?.data?.id, challanNo: `ZZ-${stamp}`, challanDate: new Date().toISOString(), lines: [{ poLineId: poLine?.id, warehouseId: store.id, receivedQty: 3, packQtys: [1.5, 1.5] }] })
  check('Goods receipt: packages of 1.5 cartons refused', refused(grnPacks), grnPacks)
  const billHalf = await call('POST', '/purchase/bills', {
    supplierId: supplier.id,
    supplierInvoiceNo: `ZZ-${stamp}`,
    supplierInvoiceDate: new Date().toISOString(),
    lines: [{ itemId: carton.id, qty: 2.5, unitPrice: 10, gstRate: 12 }],
  })
  check('Purchase bill: 2.5 cartons billed refused', refused(billHalf), billHalf)

  // ── Stock: in, move, count ──
  const sinHalf = await call('POST', '/inventory/stock-in', { warehouseId: store.id, source: 'OTHER', notes: 'ZZTEST unit check', lines: [{ itemId: carton.id, qty: 0.5, unitRate: 10 }] })
  check('Stock in: 0.5 carton refused', refused(sinHalf), sinHalf)
  const stores = (await call('GET', '/masters/warehouses?limit=50')).body.data as Array<{ id: string }>
  const other = stores.find((w) => w.id !== store.id)
  if (other) {
    const moveHalf = await call('POST', '/inventory/transfers', { fromWarehouseId: store.id, toWarehouseId: other.id, lines: [{ itemId: carton.id, qty: 0.5 }] })
    check('Transfer: 0.5 carton refused', refused(moveHalf), moveHalf)
  }
  const countHalf = await call('POST', '/inventory/adjustments', { warehouseId: store.id, reason: 'ZZTEST unit check count', lines: [{ itemId: carton.id, countedQty: 0.6 }] })
  check('Stock count: 0.6 carton counted refused', refused(countHalf), countHalf)
  const countMetres = await call('POST', '/inventory/adjustments', { warehouseId: store.id, reason: 'ZZTEST unit check count', lines: [{ itemId: cloth.id, countedQty: 10.25 }] })
  check('Stock count: 10.25 metres counted taken', okay(countMetres), countMetres)

  // ── An old 0.6 on the rack is put right by a whole count ──
  await prisma.stockLedger.create({
    data: { itemId: carton.id, warehouseId: store.id, transactionType: 'ADJUSTMENT', inQty: 0.6, outQty: 0, closingStock: 0.6, notes: 'ZZTEST old fraction' },
  })
  const fix = await call('POST', '/inventory/adjustments', { warehouseId: store.id, reason: 'ZZTEST put the fraction right', lines: [{ itemId: carton.id, countedQty: 1 }] })
  check('Stock count: an old 0.6 carton is put right by counting 1 (the difference may be a fraction)', okay(fix), fix)

  // ── A manufacturing order's material plan: whole units asked for whole ──
  const mos = await prisma.manufacturingOrder.findMany({ where: { status: { not: 'DRAFT' } }, select: { id: true, moNumber: true }, take: 12, orderBy: { createdAt: 'desc' } })
  let wholeRows = 0, decimalRows = 0, badRows: string[] = []
  for (const mo of mos) {
    const plan = await call('GET', `/production/orders/${mo.id}/materials`)
    for (const r of (plan.body?.data?.rows ?? []) as Array<{ item: { code: string; places: number }; required: number; toRequest: number }>) {
      if (r.item.places === 0) {
        wholeRows++
        if (!Number.isInteger(r.required) || !Number.isInteger(r.toRequest)) badRows.push(`${mo.moNumber} ${r.item.code} ${r.required}/${r.toRequest}`)
      } else decimalRows++
    }
  }
  check(`MO plan: every whole-unit material is asked for whole (${wholeRows} rows; ${decimalRows} in metres etc.)`, wholeRows > 0 && badRows.length === 0, badRows)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
