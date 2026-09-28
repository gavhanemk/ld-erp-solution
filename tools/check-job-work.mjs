/**
 * Drives a customer's material in, and our own fabric out to an outside unit and
 * back, end to end against a running API.
 *
 *   pnpm dev:api
 *   node tools/check-job-work.mjs --write-test-data
 *
 * IT CREATES REAL DOCUMENTS with real numbers off the real series — a customer
 * receipt, a job work challan and a return, some left cancelled. None of it can
 * be deleted afterwards. Run it against a demo database, never one anybody is
 * working in.
 *
 * What it is really checking is the one rule that matters here: a customer's
 * material is held apart from our own and never reaches the stock value, and our
 * fabric at a job worker is still ours.
 */

if (!process.argv.includes('--write-test-data')) {
  console.log('\n  This creates documents that cannot be deleted.')
  console.log('  Run it only against a demo database:\n')
  console.log('      node tools/check-job-work.mjs --write-test-data\n')
  process.exit(1)
}

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

/** One row of the stock screen, for a given ownership. */
const stockRow = async (itemId, warehouseId, ownership = 'OWNED') => {
  const r = await call('GET', `/inventory/stock?itemId=${itemId}&warehouseId=${warehouseId}`)
  return (r.json?.data ?? []).find(
    (x) => x.warehouseId === warehouseId && x.ownership === ownership
  )
}
const qtyOf = async (...a) => (await stockRow(...a))?.qty ?? 0

const login = await call('POST', '/auth/login', {
  email: 'admin@ldcottonmills.com',
  password: 'Admin@123',
})
token = login.json?.data?.accessToken ?? login.json?.accessToken
check('sign in', !!token, login.json)
if (!token) process.exit(1)

const [customers, suppliers, items, warehouses] = await Promise.all([
  call('GET', '/masters/customers?limit=1&active=true'),
  call('GET', '/masters/suppliers?limit=1&active=true'),
  call('GET', '/masters/items?limit=3&active=true'),
  call('GET', '/masters/warehouses?limit=5&active=true'),
])

const customer = customers.json?.data?.[0]
const worker = suppliers.json?.data?.[0]
const theirItem = items.json?.data?.[0]
const ourItem = items.json?.data?.[1]
const store = warehouses.json?.data?.[0]
const jobStore = warehouses.json?.data?.[1]

check(
  'found a customer, a job worker, items and two stores',
  !!(customer && worker && theirItem && ourItem && store && jobStore),
  {
    customer: customer?.name,
    worker: worker?.name,
    store: store?.name,
    jobStore: jobStore?.name,
  }
)
if (!(customer && worker && theirItem && ourItem && store && jobStore)) process.exit(1)

console.log(`\n  customer: ${customer.name}   job worker: ${worker.name}`)
console.log(`  their material: ${theirItem.name}   our fabric: ${ourItem.name}\n`)

// ── a customer's material comes in ─────────────────────────────────────────
const ourBefore = await qtyOf(theirItem.id, store.id, 'OWNED')
const theirBefore = await qtyOf(theirItem.id, store.id, 'CUSTOMER_OWNED')

const grn = await call('POST', '/inventory/customer-grn', {
  customerId: customer.id,
  warehouseId: store.id,
  challanNumber: 'THEIR-CH-001',
  vehicleNo: 'MH04AB1234',
  notes: 'End-to-end test of customer material in',
  lines: [{ itemId: theirItem.id, challanQty: 100, receivedQty: 98, markings: 'Lot 7, navy' }],
})
check('customer receipt saves', grn.status === 201, grn.json)
console.log(`        message: ${grn.json?.message}`)

const receipt = grn.json?.data
check(
  `it has a real number (${receipt?.grnNumber})`,
  /^CGRN-\d{4}-\d+$/.test(receipt?.grnNumber ?? '')
)
check(
  'it says the delivery was short of their challan',
  /do not match their challan|does not match/.test(grn.json?.message ?? ''),
  grn.json?.message
)

const theirAfter = await qtyOf(theirItem.id, store.id, 'CUSTOMER_OWNED')
check(
  `their material is on hand (${theirBefore} -> ${theirBefore + 98})`,
  theirAfter === theirBefore + 98
)
check(
  'our own balance of the same item did not move',
  (await qtyOf(theirItem.id, store.id, 'OWNED')) === ourBefore
)

const row = await stockRow(theirItem.id, store.id, 'CUSTOMER_OWNED')
check('the stock screen names whose it is', row?.ownerName === customer.name, row?.ownerName)
check('it carries no value to us', Number(row?.value) === 0, {
  value: row?.value,
  rate: row?.avgRate,
})

const val = await call('GET', '/inventory/valuation')
const inValuation = JSON.stringify(val.json?.data ?? {}).includes(customer.name)
check('it stays out of the stock valuation', !inValuation)

// ── it can be asked for and issued, which is the whole point ───────────────
const depts = await call('GET', '/masters/departments?limit=1&active=true')
const dept = depts.json?.data?.[0]

const mr = await call('POST', '/inventory/requisitions', {
  departmentId: dept.id,
  warehouseId: store.id,
  notes: 'Cutting the customer material',
  lines: [
    {
      itemId: theirItem.id,
      requestedQty: 10,
      ownership: 'CUSTOMER_OWNED',
      ownerCustomerId: customer.id,
      purpose: 'End-to-end test',
    },
  ],
})
check('a requisition can ask for the customer material', mr.status === 201, mr.json?.message)

// ── our fabric goes out to a job worker ────────────────────────────────────
const outBefore = await qtyOf(ourItem.id, store.id)
const atWorkerBefore = await qtyOf(ourItem.id, jobStore.id)
const sendQty = Math.min(20, outBefore)

if (sendQty <= 0) {
  console.log(`\n  skipping the job work half — no stock of ${ourItem.name} in ${store.name}\n`)
} else {
  const ch = await call('POST', '/inventory/job-work', {
    jobWorkerId: worker.id,
    process: 'dyeing — navy',
    fromWarehouseId: store.id,
    toWarehouseId: jobStore.id,
    lrNumber: 'LR-99',
    notes: 'End-to-end test of job work out',
    lines: [{ itemId: ourItem.id, qty: sendQty }],
  })
  check('job work challan saves', ch.status === 201, ch.json)
  console.log(`        message: ${ch.json?.message}`)

  const challan = ch.json?.data
  check(
    `it has a real number (${challan?.challanNumber})`,
    /^JW-\d{4}-\d+$/.test(challan?.challanNumber ?? '')
  )
  check('the line carries an HSN for the challan', 'hsnCode' in (challan?.lines?.[0] ?? {}))
  check('it remembers what the stock was carried at', challan?.lines?.[0]?.unitRate !== null)

  check(
    `stock left our store (${outBefore} -> ${outBefore - sendQty})`,
    (await qtyOf(ourItem.id, store.id)) === outBefore - sendQty
  )
  check(
    `and is still ours, at the job worker (${atWorkerBefore} -> ${atWorkerBefore + sendQty})`,
    (await qtyOf(ourItem.id, jobStore.id)) === atWorkerBefore + sendQty
  )

  // ── half comes back ──────────────────────────────────────────────────────
  const half = Math.floor(sendQty / 2)
  const ret = await call('POST', `/inventory/job-work/${challan.id}/returns`, {
    theirChallanNo: 'THEIRS-1',
    lines: [
      {
        challanLineId: challan.lines[0].id,
        consumedQty: half,
        itemId: ourItem.id,
        receivedQty: half,
        warehouseId: store.id,
      },
    ],
  })
  check('a partial return saves', ret.status === 201, ret.json)
  console.log(`        message: ${ret.json?.message}`)
  check(
    'the challan says some is still out',
    ret.json?.data?.status === 'PARTLY_BACK',
    ret.json?.data?.status
  )

  check(
    `what came back is in our store again`,
    (await qtyOf(ourItem.id, store.id)) === outBefore - sendQty + half
  )

  // ── returning more than went out is refused ──────────────────────────────
  const over = await call('POST', `/inventory/job-work/${challan.id}/returns`, {
    lines: [
      {
        challanLineId: challan.lines[0].id,
        consumedQty: sendQty,
        itemId: ourItem.id,
        receivedQty: sendQty,
        warehouseId: store.id,
      },
    ],
  })
  check(
    'returning more than went out is refused',
    over.status === 400 && over.json?.code === 'OVER_RETURN',
    over.json?.code
  )
  console.log(`        message: ${over.json?.message}`)

  // ── and a part-returned challan cannot be cancelled ──────────────────────
  const cancel = await call('PATCH', `/inventory/job-work/${challan.id}/cancel`, {
    reason: 'Trying to cancel after a partial return',
  })
  check(
    'a part-returned challan refuses cancellation',
    cancel.status === 400 && cancel.json?.code === 'ALREADY_PARTLY_BACK',
    cancel.json?.code
  )
  console.log(`        message: ${cancel.json?.message}`)

  // ── the rest comes back, closing it ──────────────────────────────────────
  const rest = await call('POST', `/inventory/job-work/${challan.id}/returns`, {
    lines: [
      {
        challanLineId: challan.lines[0].id,
        consumedQty: sendQty - half,
        itemId: ourItem.id,
        receivedQty: sendQty - half - 1,
        wastedQty: 1,
        warehouseId: store.id,
        notes: 'One unit lost in processing',
      },
    ],
  })
  check('the closing return saves', rest.status === 201, rest.json)
  check('the challan closes', rest.json?.data?.status === 'CLOSED', rest.json?.data?.status)
  console.log(`        message: ${rest.json?.message}`)

  check(
    'nothing is left at the job worker',
    (await qtyOf(ourItem.id, jobStore.id)) === atWorkerBefore
  )
  check(
    'the waste really is gone, not quietly returned',
    (await qtyOf(ourItem.id, store.id)) === outBefore - 1
  )
}

// ── cancelling the customer receipt takes their material back off ──────────
const undo = await call('PATCH', `/inventory/customer-grn/${receipt.id}/cancel`, {
  reason: 'End-to-end test of the cancel path',
})
check('customer receipt cancels', undo.status === 200, undo.json)
console.log(`        message: ${undo.json?.message}`)
check(
  `their material is off the books again (${theirBefore})`,
  (await qtyOf(theirItem.id, store.id, 'CUSTOMER_OWNED')) === theirBefore
)

const twice = await call('PATCH', `/inventory/customer-grn/${receipt.id}/cancel`, {
  reason: 'Trying to cancel it a second time',
})
check('it cannot be cancelled twice', twice.status === 400, twice.json?.code)

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
