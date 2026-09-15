/**
 * Drives a stock transfer and a stock adjustment end to end against a running
 * API, and checks that each one leaves a real document behind rather than a
 * ledger row tagged with the clock.
 *
 *   pnpm dev:api
 *   node tools/check-stock-documents.mjs --write-test-data
 *
 * IT CREATES REAL DOCUMENTS. One transfer note, one adjustment, and a second
 * transfer that is left cancelled — all with real numbers off the real series,
 * and none of them can be deleted afterwards. Run it against a demo database,
 * never one anybody is working in.
 */

if (!process.argv.includes('--write-test-data')) {
  console.log('\n  This creates a stock transfer and an adjustment that cannot be deleted.')
  console.log('  Run it only against a demo database:\n')
  console.log('      node tools/check-stock-documents.mjs --write-test-data\n')
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

const stockOf = async (itemId, warehouseId) => {
  const r = await call('GET', `/inventory/stock?itemId=${itemId}&warehouseId=${warehouseId}`)
  const row = (r.json?.data ?? []).find((x) => x.warehouseId === warehouseId)
  return row ? row.qty : 0
}

const login = await call('POST', '/auth/login', {
  email: 'admin@ldcottonmills.com',
  password: 'Admin@123',
})
token = login.json?.data?.accessToken ?? login.json?.accessToken
check('sign in', !!token, login.json)
if (!token) process.exit(1)

// ── find an item that actually has stock, and two stores ───────────────────
const stock = await call('GET', '/inventory/stock')
const owned = (stock.json?.data ?? []).filter((r) => r.ownership === 'OWNED' && r.qty > 20)
const warehouses = await call('GET', '/masters/warehouses?limit=10&active=true')

const source = owned[0]
const other = (warehouses.json?.data ?? []).find((w) => w.id !== source?.warehouseId)
check('found stock to move and a second store', !!(source && other), {
  item: source?.itemName,
  from: source?.warehouseName,
  to: other?.name,
})
if (!source || !other) process.exit(1)

const fromId = source.warehouseId
const toId = other.id
const itemId = source.itemId

const beforeFrom = await stockOf(itemId, fromId)
const beforeTo = await stockOf(itemId, toId)
console.log(
  `\n  ${source.itemName}: ${beforeFrom} in ${source.warehouseName}, ${beforeTo} in ${other.name}\n`
)

// ── a transfer becomes a numbered document ─────────────────────────────────
const tr = await call('POST', '/inventory/transfers', {
  fromWarehouseId: fromId,
  toWarehouseId: toId,
  notes: 'End-to-end test of the transfer note',
  lines: [{ itemId, qty: 10 }],
})
check('transfer saves', tr.status === 201, tr.json)
console.log(`        message: ${tr.json?.message}`)

const transfer = tr.json?.data
check(
  `it has a real number, not a timestamp (${transfer?.transferNumber})`,
  /^STN-\d{4}-\d+$/.test(transfer?.transferNumber ?? ''),
  transfer?.transferNumber
)
check(
  'the document remembers what the stock was carried at',
  transfer?.lines?.[0]?.unitRate !== null && transfer?.lines?.[0]?.unitRate !== undefined,
  transfer?.lines?.[0]
)

check(
  `stock left the source (${beforeFrom} -> ${beforeFrom - 10})`,
  (await stockOf(itemId, fromId)) === beforeFrom - 10
)
check(
  `stock reached the destination (${beforeTo} -> ${beforeTo + 10})`,
  (await stockOf(itemId, toId)) === beforeTo + 10
)

// ── the ledger points at the document, not at a timestamp ──────────────────
const led = await call('GET', `/inventory/ledger?itemId=${itemId}&type=TRANSFER&limit=5`)
const row = (led.json?.data ?? [])[0]
check('the ledger row points at the transfer record', row?.referenceId === transfer?.id, {
  referenceId: row?.referenceId,
  transferId: transfer?.id,
})

// ── it can be listed and opened, which was the whole point ─────────────────
const list = await call('GET', '/inventory/transfers?limit=10')
check(
  'transfers can be listed',
  (list.json?.data ?? []).some((t) => t.id === transfer.id),
  list.json?.pagination
)

const one = await call('GET', `/inventory/transfers/${transfer.id}`)
check('one transfer can be opened', one.status === 200 && one.json?.data?.id === transfer.id)

// ── cancelling walks the goods back ────────────────────────────────────────
const cancel = await call('PATCH', `/inventory/transfers/${transfer.id}/cancel`, {
  reason: 'End-to-end test of the cancel path',
})
check('transfer cancels', cancel.status === 200, cancel.json)
console.log(`        message: ${cancel.json?.message}`)

check(`source is whole again (${beforeFrom})`, (await stockOf(itemId, fromId)) === beforeFrom)
check(`destination is back to ${beforeTo}`, (await stockOf(itemId, toId)) === beforeTo)

const twice = await call('PATCH', `/inventory/transfers/${transfer.id}/cancel`, {
  reason: 'Trying to cancel it a second time',
})
check('it cannot be cancelled twice', twice.status === 400, twice.json?.code)

// ── an adjustment becomes a numbered document too ──────────────────────────
const book = await stockOf(itemId, fromId)
const adj = await call('POST', '/inventory/adjustments', {
  warehouseId: fromId,
  reason: 'End-to-end test of the count sheet',
  lines: [{ itemId, countedQty: book - 3 }],
})
check('adjustment saves', adj.status === 201, adj.json)
console.log(`        message: ${adj.json?.message}`)

const adjustment = adj.json?.data
check(
  `it has a real number (${adjustment?.adjustmentNumber})`,
  /^ADJ-\d{4}-\d+$/.test(adjustment?.adjustmentNumber ?? '')
)
check(
  'it records what the book said against what was counted',
  Number(adjustment?.lines?.[0]?.bookQty) === book &&
    Number(adjustment?.lines?.[0]?.countedQty) === book - 3,
  adjustment?.lines?.[0]
)
check(
  `stock follows the count (${book} -> ${book - 3})`,
  (await stockOf(itemId, fromId)) === book - 3
)

const adjList = await call('GET', '/inventory/adjustments?limit=10')
check(
  'adjustments can be listed',
  (adjList.json?.data ?? []).some((a) => a.id === adjustment.id)
)

// ── a count that matches still leaves a record ─────────────────────────────
const now = await stockOf(itemId, fromId)
const noChange = await call('POST', '/inventory/adjustments', {
  warehouseId: fromId,
  reason: 'Counted and everything matched',
  lines: [{ itemId, countedQty: now }],
})
check('a count that matched is still recorded', noChange.status === 201, noChange.json?.message)
console.log(`        message: ${noChange.json?.message}`)
check('and it moved no stock', (await stockOf(itemId, fromId)) === now)

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
