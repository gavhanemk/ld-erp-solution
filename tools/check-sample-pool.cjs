// Sampling phase 4: the request's own material in the sample store (its pool), issuing from it,
// lines not needed after all, and leftovers closed out.
// HTTP + real PostgreSQL checks on the local pilot only. No .env loading, no shared data.
const assert = require('node:assert/strict')
process.env.DATABASE_URL ||= 'postgresql://postgres@127.0.0.1:55439/lderp_sampling?schema=ld_erp'
const target = new URL(process.env.DATABASE_URL)
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/lderp_sampling')
  throw Error('Pool checks require local lderp_sampling')
process.env.DIRECT_URL = process.env.DATABASE_URL
process.env.SAMPLING_ENABLED = 'true'
process.env.NODE_ENV = 'test'
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
process.env.STORAGE_DRIVER = 'local'
process.env.LOCAL_STORAGE_SECRET = 'check-pool-only-' + nodeCrypto.randomBytes(24).toString('hex')
const checkFiles = path.join(__dirname, '..', '.local-sampling', 'check-files-pool')
fs.mkdirSync(checkFiles, { recursive: true })
const fileRoot = fs.mkdtempSync(path.join(checkFiles, 'run-'))
process.env.LOCAL_STORAGE_DIR = fileRoot
require('./register-ts.cjs')
require('express-async-errors')
const express = require('express')
const { prisma: db } = require('../packages/database/src/index.ts')
const sampling = require('../apps/api/src/routes/sampling.routes.ts').default
const purchase = require('../apps/api/src/routes/purchase.routes.ts').default
const qc = require('../apps/api/src/routes/grn-qc.routes.ts').default
const { MOVEMENT_DOC_JOIN } = require('../apps/api/src/services/movementDocs.service.ts')
const { bucketOf, documentNumbers } = require('../apps/api/src/reports/definitions/inventory-shared.ts')
const { ZodError } = require('zod')

let passed = 0,
  server
const check = (label, fn) => {
  fn()
  passed++
  console.log('PASS ' + label)
}
const SAMPLE_STORE = 'sample-room-store'
const GENERAL_STORE = 'sample-store'

async function main() {
  const [{ db: dbName }] = await db.$queryRaw`SELECT current_database() AS db`
  assert.equal(dbName, 'lderp_sampling')
  const api = express()
  api.use(express.json())
  api.use((req, res, next) => {
    req.user = { id: 'sample-user', name: 'Test manager', role: 'Admin', roleId: 'local', email: 'sampler@example.com' }
    next()
  })
  api.use('/sampling', sampling)
  api.use('/purchase/qc', qc)
  api.use('/purchase', purchase)
  api.use((err, req, res, next) =>
    res.status(err.statusCode ?? (err instanceof ZodError ? 400 : 500)).json({ message: err.message, code: err.code })
  )
  server = api.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const call = async (method, url, body) => {
    const r = await fetch(origin + url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: r.status, body: await r.json() }
  }
  const expect = (r, status, code) => {
    assert.equal(r.status, status, JSON.stringify(r.body))
    if (code) assert.equal(r.body.code, code, JSON.stringify(r.body))
  }
  const stamp = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  let paper = 0

  // ── A request needing 5 m of fabric and 12 buttons ──────────────────────────
  const opOf = Object.fromEntries(
    (await db.operation.findMany({ where: { code: { in: ['EX-CUT', 'OP-STI', 'OP-FIN'] } } })).map((o) => [o.code, o])
  )
  const step = (code) => ({
    operationId: opOf[code].id,
    name: '',
    kind: opOf[code].kind,
    departmentId: '',
    execution: 'IN_HOUSE',
    contractorId: null,
    vendorId: null,
    instructions: '',
  })
  const line = (extra) => ({
    component: 'Body',
    itemId: 'sample-fabric',
    colour: null,
    departmentId: null,
    qtyPerPiece: 2.5,
    wastagePct: 0,
    requiredQty: 0,
    requiredOverride: false,
    overrideReason: '',
    source: 'PURCHASE',
    estRate: null,
    remarks: '',
    ...extra,
  })
  const spec = {
    milestone: 'Fit sample',
    styleId: 'sample-style',
    construction: 'Straight seam.',
    techPackRef: 'EXAMPLE-TECH-v1',
    patternRef: 'EXAMPLE-PATTERN-v1',
    colours: [{ colour: 'White', sizes: [{ sizeId: 'sample-size-M', qty: 2 }] }],
    measurements: [{ name: 'Chest', sizeId: 'sample-size-M', target: 50, tolerance: 0.5, unit: 'cm' }],
    route: [step('EX-CUT'), step('OP-STI'), step('OP-FIN')],
    materials: [line(), line({ component: 'Front', itemId: 'sample-button', qtyPerPiece: 6 })],
    notes: 'Fictional pool check',
  }
  let doc = (
    await call('POST', '/sampling', {
      clientKey: crypto.randomUUID(),
      title: 'Pool check ' + stamp,
      customerId: 'sample-buyer',
      brandId: 'sample-brand',
      owner: 'Test manager',
      brief: 'Two sample shirts, issued from what was bought for them.',
      buyerRef: 'EXAMPLE-REF',
      requiredAt: null,
    })
  ).body.data
  const act = async (action, data = {}, status = 200, roundId = doc.rounds[0].id) => {
    const r = await call('POST', `/sampling/${doc.id}/actions`, { version: doc.version, roundId, action, data })
    expect(r, status)
    if (status === 200) doc = r.body.data
    return r
  }
  await act('LINK_STYLE', { styleId: 'sample-style' })
  await act('RELEASE', spec)
  const [fabric, button] = doc.rounds[0].materials
  const needsOf = async () => (await call('GET', `/sampling/needs?requestId=${doc.id}`)).body.data.needs
  /** Orders the given needs (sample line → qty) and receives them in full into the sample store. */
  const buy = async (lines) => {
    const po = await call('POST', '/purchase/orders', {
      supplierId: 'sample-fabric-mill',
      poType: 'NONE',
      deliveryWarehouseId: SAMPLE_STORE,
      lines: lines.map(([m, qty]) => ({ itemId: m.itemId, qty, unitRate: 100, gstRate: 5, sampleMaterialId: m.id })),
    })
    expect(po, 201)
    expect(await call('PATCH', `/purchase/orders/${po.body.data.id}/send`), 200)
    const grn = await call('POST', '/purchase/grn', {
      poId: po.body.data.id,
      challanNo: `CH-POOL-${stamp}-${++paper}`,
      challanDate: today,
      lines: po.body.data.lines.map((l) => ({ poLineId: l.id, warehouseId: SAMPLE_STORE, receivedQty: +l.qty })),
    })
    expect(grn, 201)
    doc = (await call('GET', `/sampling/${doc.id}`)).body.data
    return grn.body.data
  }
  const grn = await buy([
    [fabric, 5],
    [button, 12],
  ])
  const fabricGrnLine = grn.lines.find((l) => l.itemId === 'sample-fabric')
  const pooled = () =>
    Object.fromEntries(doc.pool.stores.map((s) => [s.itemId, [s.received, s.issued, s.closed, s.available]]))
  check('what was received for the request is its own, in the sample store', () => {
    assert.deepEqual(pooled(), { 'sample-fabric': [5, 0, 0, 5], 'sample-button': [12, 0, 0, 12] })
    assert.deepEqual(doc.pool.lines[fabric.id], { remaining: 5, fromPool: 5, awaited: 0, toBuy: 0 })
  })

  // ── A quality check holds 2 m back as rejected: 3 m left to issue, 2 to buy ─
  const check1 = await call('POST', '/purchase/qc', {
    grnId: grn.id,
    lines: [{ grnLineId: fabricGrnLine.id, rejectedQty: 2, reasonCode: 'QUALITY_REJECTION', reason: 'Shade' }],
  })
  expect(check1, 201)
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  let needs = await needsOf()
  const tooMuch = await act(
    'MATERIAL',
    { materialId: fabric.id, kind: 'ISSUE', qty: 4, reason: 'More than is good', warehouseId: SAMPLE_STORE },
    409
  )
  check('rejected goods leave the pool and show as still to buy', () => {
    assert.deepEqual(pooled()['sample-fabric'], [3, 0, 0, 3])
    assert.deepEqual(doc.pool.lines[fabric.id], { remaining: 5, fromPool: 3, awaited: 0, toBuy: 2 })
    assert.deepEqual(needs.map((n) => [n.sampleMaterialId, n.toBuy]), [[fabric.id, 2]])
    assert.equal(tooMuch.body.code, 'POOL_SHORT')
  })
  // One metre used after all: back in the pool.
  const qcId = (await db.inwardQC.findFirst({ where: { grnId: grn.id }, orderBy: { createdAt: 'desc' } })).id
  expect(
    await call('POST', `/purchase/qc/${qcId}/use`, { grnLineId: fabricGrnLine.id, qty: 1, reason: 'Close enough shade' }),
    200
  )
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  needs = await needsOf()
  check('rejected goods used after all come back to the pool', () => {
    assert.deepEqual(pooled()['sample-fabric'], [4, 0, 0, 4])
    assert.deepEqual(needs.map((n) => [n.sampleMaterialId, n.toBuy]), [[fabric.id, 1]])
  })
  // The last metre bought and received; ordering more than that asks why.
  const over = await call('POST', '/purchase/orders', {
    supplierId: 'sample-fabric-mill',
    poType: 'NONE',
    deliveryWarehouseId: SAMPLE_STORE,
    lines: [{ itemId: 'sample-fabric', qty: 2, unitRate: 100, gstRate: 5, sampleMaterialId: fabric.id }],
  })
  check('the pool decides what may be ordered without a reason', () => {
    expect(over, 400, 'SAMPLE_OVER_ORDER')
    assert.match(over.body.message, /still needs 1 mtr after what it holds and has on order/)
  })
  const lastGrn = await buy([[fabric, 1]])
  check('received in full, the line is covered by the pool', () =>
    assert.deepEqual(doc.pool.lines[fabric.id], { remaining: 5, fromPool: 5, awaited: 0, toBuy: 0 })
  )

  // ── A line not needed after all ─────────────────────────────────────────────
  const stageData = (stage) => ({
    stageId: stage.id,
    cells: [{ colour: 'White', sizeId: 'sample-size-M', done: 2, rejected: 0 }],
    doneBy: 'Cutter',
  })
  await act('MATERIAL', { materialId: fabric.id, kind: 'ISSUE', qty: 5, reason: 'For the sample', warehouseId: SAMPLE_STORE })
  // Another sample's fabric on the same shelf (put there directly, as if received for it).
  await db.stockLedger.create({
    data: {
      itemId: 'sample-fabric',
      warehouseId: SAMPLE_STORE,
      transactionType: 'OPENING',
      referenceType: 'POOL_CHECK_FIXTURE',
      referenceId: 'other-sample-' + stamp,
      inQty: 3,
      outQty: 0,
      closingStock: 3,
      unitRate: 100,
    },
  })
  // All 5 m are issued: the last receipt cannot now be cancelled or cut back on another
  // sample's fabric, though the shelf still holds enough.
  const cancelLast = await call('PATCH', `/purchase/grn/${lastGrn.id}/cancel`, { reason: 'Supplier took it back' })
  const cutLast = await call('PATCH', `/purchase/grn/${lastGrn.id}`, {
    editReason: 'Only half came',
    challanNo: lastGrn.challanNo,
    challanDate: today,
    lines: [{ poLineId: lastGrn.lines[0].poLineId, warehouseId: SAMPLE_STORE, receivedQty: 0.5 }],
  })
  check('a receipt a sample has issued cannot be cancelled or cut back on another sample’s stock', () => {
    expect(cancelLast, 409, 'SAMPLE_MATERIAL_USED')
    assert.match(cancelLast.body.message, new RegExp(`Cancelling ${lastGrn.grnNumber} would take 1 mtr of Example Cotton that ${doc.number} has already issued`))
    expect(cutLast, 409, 'SAMPLE_MATERIAL_USED')
  })
  const blocked = await act('STEP_WORK', stageData(doc.rounds[0].stages[0]), 409)
  const noReason = await act('WAIVE_MATERIAL', { materialId: button.id }, 400)
  const issuedFull = await act('WAIVE_MATERIAL', { materialId: fabric.id, reason: 'Not needed' }, 409)
  await act('WAIVE_MATERIAL', { materialId: button.id, reason: 'Buyer dropped the buttons' })
  const waived = doc.rounds[0].materials.find((m) => m.id === button.id)
  const issueWaived = await act(
    'MATERIAL',
    { materialId: button.id, kind: 'ISSUE', qty: 1, reason: 'Waived', warehouseId: SAMPLE_STORE },
    409
  )
  check('a line not needed is waived with its reason, and making can start without it', () => {
    assert.match(blocked.body.message, /waive what is not needed/)
    assert.equal(noReason.status, 400)
    assert.match(issuedFull.body.message, /issued in full/)
    assert.ok(waived.waivedAt)
    assert.equal(waived.waivedReason, 'Buyer dropped the buttons')
    assert.equal(waived.waivedBy, 'Test manager')
    assert.equal(issueWaived.body.code, 'LINE_WAIVED')
    assert.deepEqual(doc.pool.lines[button.id], { remaining: 0, fromPool: 0, awaited: 0, toBuy: 0 })
  })
  await act('WAIVE_MATERIAL', { materialId: button.id, undo: true })
  check('a waiver can be taken off before making starts', () =>
    assert.equal(doc.rounds[0].materials.find((m) => m.id === button.id).waivedAt, null)
  )
  await act('WAIVE_MATERIAL', { materialId: button.id, reason: 'Buyer dropped the buttons' })
  await act('STEP_WORK', stageData(doc.rounds[0].stages[0]))
  const lateUndo = await act('WAIVE_MATERIAL', { materialId: button.id, undo: true }, 409)
  const earlyClose = await act(
    'CLOSE_MATERIAL',
    { itemId: 'sample-button', warehouseId: SAMPLE_STORE, qty: 1, kind: 'USED', reason: 'Too early' },
    409
  )
  check('nothing is waived once making starts, nor closed out before the buyer decides', () => {
    assert.match(lateUndo.body.message, /before making starts/)
    assert.equal(earlyClose.body.code, 'NOT_SETTLED')
  })

  // ── The ledger names the sample ─────────────────────────────────────────────
  const roundId = doc.rounds[0].id
  const [row] = await db.$queryRaw`
    SELECT p.doc, p."partyName" FROM ld_erp.stock_ledger s ${MOVEMENT_DOC_JOIN}
    WHERE s."referenceType" = 'SAMPLING' AND s."referenceId" = ${roundId} LIMIT 1`
  const numbers = await documentNumbers(db, [{ referenceType: 'SAMPLING', referenceId: roundId }])
  check('a sample’s stock movements name the request and its buyer', () => {
    assert.equal(row.doc, doc.number)
    assert.equal(row.partyName, 'Example Buyer')
    assert.equal(numbers.get(roundId), doc.number)
    assert.equal(bucketOf('RETURN', 'SAMPLING'), 'issue')
    assert.equal(bucketOf('RETURN', 'PurchaseReturn'), 'purchase')
  })

  // ── Leftovers after the buyer decides ───────────────────────────────────────
  await db.sampleRound.update({ where: { id: roundId }, data: { state: 'APPROVED' } })
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  const before = await db.stockLedger.aggregate({
    where: { itemId: 'sample-button', warehouseId: GENERAL_STORE },
    _sum: { inQty: true },
  })
  await act('CLOSE_MATERIAL', {
    itemId: 'sample-button',
    warehouseId: SAMPLE_STORE,
    qty: 10,
    kind: 'MOVED',
    toWarehouseId: GENERAL_STORE,
    reason: 'Good for the bulk order',
  })
  await act('CLOSE_MATERIAL', { itemId: 'sample-button', warehouseId: SAMPLE_STORE, qty: 2, kind: 'USED', reason: 'Spares sewn on' })
  const leftRows = await db.stockLedger.findMany({
    where: { referenceType: 'SAMPLING', referenceId: roundId, warehouseId: SAMPLE_STORE, itemId: 'sample-button' },
  })
  const after = await db.stockLedger.aggregate({
    where: { itemId: 'sample-button', warehouseId: GENERAL_STORE },
    _sum: { inQty: true },
  })
  check('leftovers of an approved round are closed out, and leave the pool', () => {
    assert.deepEqual(pooled()['sample-button'], [12, 0, 12, 0])
    assert.equal(+after._sum.inQty - +before._sum.inQty, 10)
    assert.deepEqual(
      doc.closeOuts.map((c) => [c.kind, +c.qty]),
      [
        ['USED', 2],
        ['MOVED', 10],
      ]
    )
    // At what the sample store carries buttons at, as the ledger moved them.
    for (const c of doc.closeOuts) {
      const moved = leftRows.find((r) => Math.abs(+r.outQty - +c.qty) < 1e-9)
      assert.ok(moved, 'its movement')
      assert.equal(+c.value, Math.round(+c.qty * +moved.unitRate * 100) / 100)
    }
  })

  console.log(`\n${passed} pool checks passed on local lderp_sampling. Shared database never accessed.`)
}
main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    await db.$disconnect()
    fs.rmSync(fileRoot, { recursive: true, force: true })
  })
