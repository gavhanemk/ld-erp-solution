/**
 * Drives a goods receipt end to end against a running API and checks the
 * answers: what reaches stock, what the order does, and what happens when
 * somebody receives more than was ordered.
 *
 *   pnpm dev:api
 *   node tools/check-grn.mjs --write-test-data
 *
 * IT CREATES REAL DOCUMENTS. A purchase order and two goods receipts, with
 * real numbers off the real series, and one of the receipts is left cancelled.
 * None of it can be deleted afterwards, because documents are never deleted.
 * So run it against a demo database, never one anybody is working in — which
 * is why the flag is required rather than assumed.
 */

if (!process.argv.includes('--write-test-data')) {
  console.log('\n  This creates a purchase order and two goods receipts that cannot be deleted.')
  console.log('  Run it only against a demo database:\n')
  console.log('      node tools/check-grn.mjs --write-test-data\n')
  process.exit(1)
}

// End-to-end check of the goods receipt against the running API.
const BASE = 'http://localhost:5000/api'
let token = ''
let pass = 0
let fail = 0

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}`)
    if (detail !== undefined) console.log('        ' + JSON.stringify(detail))
  }
}

const stockOf = async (itemId, warehouseId) => {
  const r = await call('GET', `/inventory/stock?itemId=${itemId}&warehouseId=${warehouseId}`)
  const row = (r.json?.data ?? []).find((x) => x.warehouseId === warehouseId)
  return row ? row.qty : 0
}

// ── sign in ────────────────────────────────────────────────────────────────
const login = await call('POST', '/auth/login', {
  email: 'admin@ldcottonmills.com',
  password: 'Admin@123',
})
token = login.json?.data?.accessToken ?? login.json?.accessToken ?? login.json?.data?.token
check('sign in', !!token, login.json)
if (!token) process.exit(1)

// ── pick the pieces we need ────────────────────────────────────────────────
const suppliers = await call('GET', '/masters/suppliers?limit=1&active=true')
const items = await call('GET', '/masters/items?limit=2&active=true')
const warehouses = await call('GET', '/masters/warehouses?limit=1&active=true')

const supplier = suppliers.json?.data?.[0]
const itemA = items.json?.data?.[0]
const itemB = items.json?.data?.[1]
const wh = warehouses.json?.data?.[0]
check('found a supplier, two items and a store', !!(supplier && itemA && itemB && wh), {
  supplier: supplier?.name,
  itemA: itemA?.name,
  itemB: itemB?.name,
  warehouse: wh?.name,
})
if (!(supplier && itemA && itemB && wh)) process.exit(1)

const beforeA = await stockOf(itemA.id, wh.id)
const beforeB = await stockOf(itemB.id, wh.id)
console.log(`\n  opening stock — ${itemA.name}: ${beforeA}, ${itemB.name}: ${beforeB}\n`)

// ── an order to receive against ────────────────────────────────────────────
const po = await call('POST', '/purchase/orders', {
  supplierId: supplier.id,
  deliveryWarehouseId: wh.id,
  notes: 'GRN end-to-end test',
  lines: [
    { itemId: itemA.id, qty: 100, unitRate: 50, gstRate: 5 },
    { itemId: itemB.id, qty: 40, unitRate: 25, gstRate: 5 },
  ],
})
check('create a purchase order', po.status === 201, po.json?.message)
const order = po.json?.data
if (!order) process.exit(1)
console.log(`  order ${order.poNumber}\n`)

const lineA = order.lines.find((l) => l.itemId === itemA.id)
const lineB = order.lines.find((l) => l.itemId === itemB.id)

// ── receiving against a draft must be refused ──────────────────────────────
const tooEarly = await call('POST', '/purchase/grn', {
  poId: order.id,
  lines: [{ poLineId: lineA.id, warehouseId: wh.id, receivedQty: 10 }],
})
check(
  'a draft order cannot be received against',
  tooEarly.status === 400 && tooEarly.json?.code === 'PO_NOT_SENT',
  tooEarly.json
)
console.log(`        message: ${tooEarly.json?.message}`)

await call('PATCH', `/purchase/orders/${order.id}/send`)

// ── first receipt: 60 arrive on line A, 5 of them rejected ─────────────────
const grn1 = await call('POST', '/purchase/grn', {
  poId: order.id,
  vehicleNo: 'MH04AB1234',
  lines: [{ poLineId: lineA.id, warehouseId: wh.id, receivedQty: 60, rejectedQty: 5 }],
})
check('first receipt saves', grn1.status === 201, grn1.json)
console.log(`        message: ${grn1.json?.message}`)

const afterA1 = await stockOf(itemA.id, wh.id)
check(`only the accepted 55 reached stock (${beforeA} -> ${afterA1})`, afterA1 === beforeA + 55, {
  beforeA,
  afterA1,
})

const po1 = await call('GET', `/purchase/orders/${order.id}`)
check('order is now partly received', po1.json?.data?.status === 'PARTIALLY_RECEIVED', po1.json?.data?.status)
const l1 = po1.json?.data?.lines.find((l) => l.id === lineA.id)
check('order line shows 55 received, 45 pending', Number(l1?.receivedQty) === 55 && Number(l1?.pendingQty) === 45, {
  received: l1?.receivedQty,
  pending: l1?.pendingQty,
})

// ── over-receipt is refused and says what is left ──────────────────────────
const over = await call('POST', '/purchase/grn', {
  poId: order.id,
  lines: [{ poLineId: lineA.id, warehouseId: wh.id, receivedQty: 100 }],
})
check('over-receipt is refused', over.status === 400 && over.json?.code === 'OVER_RECEIPT', over.json)
console.log(`        message: ${over.json?.message}`)

// ── rejecting more than arrived is refused ─────────────────────────────────
const badReject = await call('POST', '/purchase/grn', {
  poId: order.id,
  lines: [{ poLineId: lineA.id, warehouseId: wh.id, receivedQty: 5, rejectedQty: 9 }],
})
check('cannot reject more than arrived', badReject.status === 400, badReject.json?.message)

// ── second receipt completes the order ─────────────────────────────────────
const grn2 = await call('POST', '/purchase/grn', {
  poId: order.id,
  lines: [
    { poLineId: lineA.id, warehouseId: wh.id, receivedQty: 45 },
    { poLineId: lineB.id, warehouseId: wh.id, receivedQty: 40 },
  ],
})
check('second receipt saves', grn2.status === 201, grn2.json)

const po2 = await call('GET', `/purchase/orders/${order.id}`)
check('order is complete', po2.json?.data?.status === 'COMPLETED', po2.json?.data?.status)

const afterB = await stockOf(itemB.id, wh.id)
check(`second item went in (${beforeB} -> ${afterB})`, afterB === beforeB + 40, { beforeB, afterB })

// ── nothing more can be received ───────────────────────────────────────────
const done = await call('POST', '/purchase/grn', {
  poId: order.id,
  lines: [{ poLineId: lineB.id, warehouseId: wh.id, receivedQty: 1 }],
})
check('a completed order refuses more', done.status === 400 && done.json?.code === 'PO_DONE', done.json)
console.log(`        message: ${done.json?.message}`)

// ── cancelling the second receipt puts it all back ─────────────────────────
const cancel = await call('PATCH', `/purchase/grn/${grn2.json.data.id}/cancel`, {
  reason: 'End-to-end test of the cancel path',
})
check('receipt cancels', cancel.status === 200, cancel.json)
console.log(`        message: ${cancel.json?.message}`)

const afterCancelA = await stockOf(itemA.id, wh.id)
const afterCancelB = await stockOf(itemB.id, wh.id)
check(`stock came back out (${itemA.name} back to ${beforeA + 55})`, afterCancelA === beforeA + 55, afterCancelA)
check(`stock came back out (${itemB.name} back to ${beforeB})`, afterCancelB === beforeB, afterCancelB)

const po3 = await call('GET', `/purchase/orders/${order.id}`)
check('order reopened to partly received', po3.json?.data?.status === 'PARTIALLY_RECEIVED', po3.json?.data?.status)

// ── the ledger shows both legs against the receipt ─────────────────────────
const ledger = await call('GET', `/inventory/ledger?itemId=${itemA.id}&limit=10`)
const types = (ledger.json?.data ?? []).map((r) => r.transactionType)
check('a PURCHASE row and a RETURN row are on the ledger', types.includes('PURCHASE') && types.includes('RETURN'), types)

// ── listing works ──────────────────────────────────────────────────────────
const list = await call('GET', `/purchase/grn?poId=${order.id}`)
check('both receipts list against the order', list.json?.data?.length === 2, list.json?.pagination)

console.log(`\n  ${pass} passed, ${fail} failed`)
console.log(`  created: ${order.poNumber}, ${grn1.json?.data?.grnNumber}, ${grn2.json?.data?.grnNumber} (cancelled)`)
process.exit(fail === 0 ? 0 : 1)
