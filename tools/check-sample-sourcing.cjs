// Sampling phase 3, sourcing: buying for a sample, the sample store and its guards.
// HTTP + real PostgreSQL checks on the local pilot only. No .env loading, no shared data.
const assert = require('node:assert/strict')
process.env.DATABASE_URL ||= 'postgresql://postgres@127.0.0.1:55439/lderp_sampling?schema=ld_erp'
const target = new URL(process.env.DATABASE_URL)
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/lderp_sampling')
  throw Error('Sourcing checks require local lderp_sampling')
process.env.DIRECT_URL = process.env.DATABASE_URL
process.env.SAMPLING_ENABLED = 'true'
process.env.NODE_ENV = 'test'
// Nothing here stores a file, but the sampling routes load the storage driver: local disk only.
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
process.env.STORAGE_DRIVER = 'local'
process.env.LOCAL_STORAGE_SECRET = 'check-sourcing-only-' + nodeCrypto.randomBytes(24).toString('hex')
const checkFiles = path.join(__dirname, '..', '.local-sampling', 'check-files-sourcing')
fs.mkdirSync(checkFiles, { recursive: true })
const fileRoot = fs.mkdtempSync(path.join(checkFiles, 'run-'))
process.env.LOCAL_STORAGE_DIR = fileRoot
require('./register-ts.cjs')
require('express-async-errors')
const express = require('express')
const { prisma: db } = require('../packages/database/src/index.ts')
const sampling = require('../apps/api/src/routes/sampling.routes.ts').default
const purchase = require('../apps/api/src/routes/purchase.routes.ts').default
const inventory = require('../apps/api/src/routes/inventory.routes.ts').default
const masters = require('../apps/api/src/routes/master.routes.ts').default
const { reorderStatus } = require('../apps/api/src/services/stock.service.ts')
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
    req.user = {
      id: 'sample-user',
      name: 'Test manager',
      role: 'Admin',
      roleId: 'local',
      email: 'sampler@example.com',
    }
    if (req.headers['x-permissions'] !== undefined)
      req.user = {
        ...req.user,
        role: 'Test operator',
        permissions: String(req.headers['x-permissions']).split(','),
      }
    next()
  })
  api.use('/sampling', sampling)
  api.use('/purchase', purchase)
  api.use('/inventory', inventory)
  api.use('/masters', masters)
  api.use((err, req, res, next) =>
    res
      .status(err.statusCode ?? (err instanceof ZodError ? 400 : 500))
      .json({ message: err.message, code: err.code })
  )
  server = api.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const call = async (method, url, body, perms) => {
    const r = await fetch(origin + url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(perms !== undefined ? { 'x-permissions': perms } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: r.status, body: await r.json() }
  }
  const expect = (r, status, code) => {
    assert.equal(r.status, status, JSON.stringify(r.body))
    if (code) assert.equal(r.body.code, code, JSON.stringify(r.body))
  }

  // ── The sample store ────────────────────────────────────────────────────────
  const stores = await call('GET', '/masters/warehouses?limit=100')
  const sampleRoom = stores.body.data.find((w) => w.id === SAMPLE_STORE)
  check('the pilot’s sample store is marked as one; the example store is general', () => {
    expect(stores, 200)
    assert.equal(sampleRoom.purpose, 'SAMPLING')
    assert.equal(stores.body.data.find((w) => w.id === GENERAL_STORE).purpose, 'GENERAL')
  })
  const stamp = Date.now()
  const holding = await call('PATCH', `/masters/warehouses/${GENERAL_STORE}`, { purpose: 'SAMPLING' })
  const spare = await call('POST', '/masters/warehouses', {
    name: 'Check sample shelf ' + stamp,
    purpose: 'SAMPLING',
  })
  const spareBack = await call('PATCH', `/masters/warehouses/${spare.body.data?.id}`, { purpose: 'GENERAL' })
  process.env.SAMPLING_ENABLED = 'false'
  const off = await call('POST', '/masters/warehouses', { name: 'Check shelf off ' + stamp, purpose: 'SAMPLING' })
  process.env.SAMPLING_ENABLED = 'true'
  const badPurpose = await call('POST', '/masters/warehouses', { name: 'Check shelf bad ' + stamp, purpose: 'BULK' })
  check('a store changes over only while empty, and becomes a sample store only with sampling on', () => {
    expect(holding, 409, 'STORE_HOLDS_STOCK')
    assert.match(holding.body.message, /still holds stock/)
    expect(spare, 201)
    assert.equal(spare.body.data.purpose, 'SAMPLING')
    expect(spareBack, 200)
    assert.equal(spareBack.body.data.purpose, 'GENERAL')
    expect(off, 400, 'SAMPLING_OFF')
    expect(badPurpose, 400)
  })
  await db.warehouse.update({ where: { id: spare.body.data.id }, data: { isActive: false } })

  // ── A request whose round needs three materials ─────────────────────────────
  const opOf = Object.fromEntries(
    (await db.operation.findMany({ where: { code: { in: ['EX-CUT', 'OP-STI', 'OP-FIN'] } } })).map(
      (o) => [o.code, o]
    )
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
  // Two pieces: 5 m of fabric and 12 buttons bought; the buyer sends the labels.
  const spec = {
    milestone: 'Fit sample',
    styleId: 'sample-style',
    construction: 'Straight seam.',
    techPackRef: 'EXAMPLE-TECH-v1',
    patternRef: 'EXAMPLE-PATTERN-v1',
    colours: [{ colour: 'White', sizes: [{ sizeId: 'sample-size-M', qty: 2 }] }],
    measurements: [{ name: 'Chest', sizeId: 'sample-size-M', target: 50, tolerance: 0.5, unit: 'cm' }],
    route: [step('EX-CUT'), step('OP-STI'), step('OP-FIN')],
    materials: [
      line(),
      line({ component: 'Front', itemId: 'sample-button', qtyPerPiece: 6 }),
      line({ component: 'Neck', itemId: 'sample-label', qtyPerPiece: 1, source: 'BUYER_SUPPLIED' }),
    ],
    notes: 'Fictional sourcing check',
  }
  let doc = (
    await call('POST', '/sampling', {
      clientKey: crypto.randomUUID(),
      title: 'Sourcing check ' + stamp,
      customerId: 'sample-buyer',
      brandId: 'sample-brand',
      owner: 'Test manager',
      brief: 'Two sample shirts, bought for the sample.',
      buyerRef: 'EXAMPLE-REF',
      requiredAt: null,
    })
  ).body.data
  const act = async (action, data = {}, status = 200) => {
    const r = await call('POST', `/sampling/${doc.id}/actions`, {
      version: doc.version,
      roundId: doc.rounds[0].id,
      action,
      data,
    })
    expect(r, status)
    if (status === 200) doc = r.body.data
    return r
  }
  await act('LINK_STYLE', { styleId: 'sample-style' })
  await act('SAVE_DRAFT', spec)
  const draftFabric = doc.rounds[0].materials[0]
  const fabricItem = await db.item.findUnique({ where: { id: 'sample-fabric' }, include: { taxRate: true } })
  const order = (lines, extra = {}) => ({
    supplierId: 'sample-fabric-mill',
    poType: 'NONE',
    deliveryWarehouseId: SAMPLE_STORE,
    ...extra,
    lines,
  })
  const pol = (itemId, qty, extra = {}) => ({ itemId, qty, unitRate: 100, gstRate: 5, ...extra })
  const draftOrder = await call(
    'POST',
    '/purchase/orders',
    order([pol('sample-fabric', 5, { sampleMaterialId: draftFabric.id })])
  )
  const draftNeeds = await call('GET', `/sampling/needs?requestId=${doc.id}`)
  check('a draft round’s material is not bought yet', () => {
    expect(draftOrder, 409, 'SAMPLE_NOT_OPEN')
    assert.match(draftOrder.body.message, /not released yet/)
    expect(draftNeeds, 200)
    assert.equal(draftNeeds.body.data.needs.length, 0)
  })
  // As the editor sends it: the saved lines with their ids, so they are kept, not made again.
  await act('SAVE_SPEC', { ...spec, materials: doc.rounds[0].specification.materials })
  await act('RELEASE')
  const [fabric, button, label] = doc.rounds[0].materials
  check('release keeps the lines a draft saved, so an order can name them', () => {
    assert.equal(fabric.id, draftFabric.id)
    assert.deepEqual([+fabric.plannedQty, +button.plannedQty, +label.plannedQty], [5, 12, 2])
    assert.deepEqual(fabric.orders, [])
  })

  // ── What the sample needs bought ────────────────────────────────────────────
  const needs = await call('GET', `/sampling/needs?requestId=${doc.id}`)
  const purchaseNeeds = await call('GET', `/purchase/sample-needs?requestId=${doc.id}`, undefined, 'purchase:view')
  const noPurchase = await call('GET', '/purchase/sample-needs', undefined, 'sampling:view')
  const noSampling = await call('GET', '/sampling/needs', undefined, 'purchase:view')
  check('needs list what is bought, not what the buyer sends, for Sampling and for Purchase', () => {
    expect(needs, 200)
    assert.deepEqual(
      needs.body.data.needs.map((n) => [n.sampleMaterialId, n.requiredQty, n.orderedQty, n.toBuy]),
      [
        [fabric.id, 5, 0, 5],
        [button.id, 12, 0, 12],
      ]
    )
    const n = needs.body.data.needs[0]
    assert.equal(n.requestNumber, doc.number)
    assert.equal(n.item.code, 'EX-FAB-001')
    assert.equal(n.component, 'Body')
    assert.equal(n.style.id, 'sample-style')
    assert.ok(needs.body.data.sampleStores.some((w) => w.id === SAMPLE_STORE))
    assert.ok(!needs.body.data.sampleStores.some((w) => w.id === GENERAL_STORE))
    expect(purchaseNeeds, 200)
    assert.deepEqual(purchaseNeeds.body.data, needs.body.data)
    expect(noPurchase, 403)
    expect(noSampling, 403)
  })
  if (fabricItem.taxRate) {
    check('a need carries its item’s GST rate for the order line', () =>
      assert.ok(needs.body.data.needs[0].item.taxRate)
    )
  }

  // ── Raising the order ───────────────────────────────────────────────────────
  const refusals = {
    wrongItem: await call('POST', '/purchase/orders', order([pol('sample-fabric-2', 5, { sampleMaterialId: fabric.id })])),
    buyerSends: await call('POST', '/purchase/orders', order([pol('sample-label', 2, { sampleMaterialId: label.id })])),
    service: await call(
      'POST',
      '/purchase/orders',
      order([pol('sample-fabric', 5, { sampleMaterialId: fabric.id })], { isService: true })
    ),
    twice: await call(
      'POST',
      '/purchase/orders',
      order([
        pol('sample-fabric', 2, { sampleMaterialId: fabric.id }),
        pol('sample-fabric', 3, { sampleMaterialId: fabric.id }),
      ])
    ),
    over: await call('POST', '/purchase/orders', order([pol('sample-fabric', 6, { sampleMaterialId: fabric.id })])),
    missing: await call('POST', '/purchase/orders', order([pol('sample-fabric', 1, { sampleMaterialId: 'missing-line' })])),
    toCustomer: await call(
      'POST',
      '/purchase/orders',
      order([pol('sample-fabric', 5, { sampleMaterialId: fabric.id })], { deliveryWarehouseId: null, deliveryCustomerId: 'sample-buyer' })
    ),
  }
  process.env.SAMPLING_ENABLED = 'false'
  refusals.off = await call('POST', '/purchase/orders', order([pol('sample-fabric', 5, { sampleMaterialId: fabric.id })]))
  const offNeeds = await call('GET', '/purchase/sample-needs')
  process.env.SAMPLING_ENABLED = 'true'
  check('an order line buys for a sample only for its own material, bought, once, within need', () => {
    expect(refusals.wrongItem, 400, 'SAMPLE_WRONG_ITEM')
    expect(refusals.buyerSends, 400, 'SAMPLE_BUYER_SENDS')
    expect(refusals.service, 400, 'SAMPLE_ON_SERVICE')
    expect(refusals.twice, 400, 'SAMPLE_LINE_TWICE')
    expect(refusals.over, 400, 'SAMPLE_OVER_ORDER')
    assert.match(refusals.over.body.message, /still needs 5/)
    expect(refusals.missing, 400, 'BAD_SAMPLE_LINE')
    expect(refusals.toCustomer, 400, 'SAMPLE_TO_CUSTOMER')
    expect(refusals.off, 400, 'SAMPLING_OFF')
    expect(offNeeds, 200)
    assert.deepEqual(offNeeds.body.data, { needs: [], sampleStores: [] })
  })
  // 6 m for the 5 the sample needs, with the reason; the buttons in full; and thread for the
  // general store on the same order.
  const po = await call(
    'POST',
    '/purchase/orders',
    order([
      pol('sample-fabric', 6, { sampleMaterialId: fabric.id, sampleOverReason: 'Mill cuts whole metres only' }),
      pol('sample-button', 12, { unitRate: 2, sampleMaterialId: button.id, sampleOverReason: 'Not over, dropped' }),
      pol('sample-thread', 2, { unitRate: 50 }),
    ])
  )
  check('the order keeps each line’s sample, and a reason only where it orders more', () => {
    expect(po, 201)
    const [f, b, t] = po.body.data.lines
    assert.equal(f.sampleMaterialId, fabric.id)
    assert.equal(f.sampleOverReason, 'Mill cuts whole metres only')
    assert.equal(f.sampleMaterial.round.request.number, doc.number)
    assert.equal(f.sampleMaterial.component, 'Body')
    assert.equal(b.sampleMaterialId, button.id)
    assert.equal(b.sampleOverReason, null)
    assert.equal(t.sampleMaterialId, null)
  })
  const poId = po.body.data.id
  let after = await call('GET', `/sampling/needs?requestId=${doc.id}&includeDone=true`)
  const secondOver = await call('POST', '/purchase/orders', order([pol('sample-fabric', 1, { sampleMaterialId: fabric.id })]))
  check('what is on order is taken off the need; a second order for a line in full needs a reason', () => {
    assert.deepEqual(
      after.body.data.needs.map((n) => [n.orderedQty, n.toBuy, n.orders.map((o) => o.poNumber)]),
      [
        [6, 0, [po.body.data.poNumber]],
        [12, 0, [po.body.data.poNumber]],
      ]
    )
    expect(secondOver, 400, 'SAMPLE_OVER_ORDER')
    assert.match(secondOver.body.message, /already on order in full/)
  })
  const unchanged = (await call('GET', `/sampling/needs?requestId=${doc.id}`)).body.data.needs
  check('a line on order in full drops off the list to buy from', () => assert.equal(unchanged.length, 0))

  // Editing the order rebuilds its lines: each keeps its sample, checked against the other orders only.
  const editLines = (fabricQty, buttonQty, buttonReason) => [
    pol('sample-fabric', fabricQty, { sampleMaterialId: fabric.id, sampleOverReason: 'Mill cuts whole metres only' }),
    pol('sample-button', buttonQty, { unitRate: 2, sampleMaterialId: button.id, ...(buttonReason ? { sampleOverReason: buttonReason } : {}) }),
    pol('sample-thread', 2, { unitRate: 50 }),
  ]
  const editOver = await call('PATCH', `/purchase/orders/${poId}`, { lines: editLines(5, 13) })
  const edited = await call('PATCH', `/purchase/orders/${poId}`, { lines: editLines(5, 12) })
  check('an edit carries every sample link through, and drops a reason no longer needed', () => {
    expect(editOver, 400, 'SAMPLE_OVER_ORDER')
    assert.match(editOver.body.message, /still needs 12/)
    expect(edited, 200)
    const [f, b] = edited.body.data.lines
    assert.equal(f.sampleMaterialId, fabric.id)
    assert.equal(f.sampleOverReason, null)
    assert.equal(+f.qty, 5)
    assert.equal(b.sampleMaterialId, button.id)
  })
  const sent = await call('PATCH', `/purchase/orders/${poId}/send`)
  expect(sent, 200)
  const [fabricLine, buttonLine, threadLine] = sent.body.data.lines

  // ── Receiving it ─────────────────────────────────────────────────────────────
  const inSampleStore = async (itemId) => {
    const s = await db.stockLedger.aggregate({
      where: { itemId, warehouseId: SAMPLE_STORE },
      _sum: { inQty: true, outQty: true },
    })
    return +(s._sum.inQty ?? 0) - +(s._sum.outQty ?? 0)
  }
  // Earlier runs leave their own stock behind: everything below is measured from here.
  const fabricBefore = await inSampleStore('sample-fabric')
  const buttonBefore = await inSampleStore('sample-button')
  const paper = { challanNo: 'CH-' + stamp, challanDate: new Date().toISOString().slice(0, 10) }
  const receive = (lines) => call('POST', '/purchase/grn', { poId, ...paper, lines })
  const toGeneral = await receive([{ poLineId: fabricLine.id, warehouseId: GENERAL_STORE, receivedQty: 5 }])
  const threadToSample = await receive([{ poLineId: threadLine.id, warehouseId: SAMPLE_STORE, receivedQty: 2 }])
  const grn = await receive([
    { poLineId: fabricLine.id, warehouseId: SAMPLE_STORE, receivedQty: 5 },
    { poLineId: buttonLine.id, warehouseId: SAMPLE_STORE, receivedQty: 10 },
    { poLineId: threadLine.id, warehouseId: GENERAL_STORE, receivedQty: 2 },
  ])
  const fabricHeld = await inSampleStore('sample-fabric')
  check('a sample’s material is received into a sample store, and nothing else is', () => {
    expect(toGeneral, 409, 'SAMPLE_GOODS_TO_SAMPLE_STORE')
    expect(threadToSample, 409, 'SAMPLE_STORE')
    expect(grn, 201)
    assert.equal(fabricHeld - fabricBefore, 5)
  })
  const grnId = grn.body.data.id
  const correctToGeneral = await call('PATCH', `/purchase/grn/${grnId}`, {
    ...paper,
    editReason: 'Moving it to the bulk store',
    lines: [
      { poLineId: fabricLine.id, warehouseId: GENERAL_STORE, receivedQty: 5 },
      { poLineId: buttonLine.id, warehouseId: SAMPLE_STORE, receivedQty: 10 },
      { poLineId: threadLine.id, warehouseId: GENERAL_STORE, receivedQty: 2 },
    ],
  })
  check('correcting a receipt cannot move a sample’s material out to a general store', () => {
    expect(correctToGeneral, 409, 'SAMPLE_GOODS_TO_SAMPLE_STORE')
  })
  assert.equal(await inSampleStore('sample-fabric'), fabricBefore + 5)
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  check('the request shows each line’s orders and what arrived, without rates', () => {
    const [f, b] = doc.rounds[0].materials
    assert.deepEqual(
      f.orders.map((o) => [o.poNumber, o.status, o.supplierName, o.qty, o.receivedQty, o.shortClosed]),
      [[sent.body.data.poNumber, 'PARTIALLY_RECEIVED', 'Example Fabric Mill', 5, 5, false]]
    )
    assert.equal(b.orders[0].receivedQty, 10)
    assert.equal(f.orders[0].unitRate, undefined)
    assert.equal(f.poLines, undefined)
  })

  // A line closed short orders only what came: the rest is to buy again.
  const short = await call('PATCH', `/purchase/orders/${poId}/lines/${buttonLine.id}/short-close`, {
    reason: 'Supplier has no more of this button',
  })
  expect(short, 200)
  after = await call('GET', `/sampling/needs?requestId=${doc.id}`)
  check('a line closed short counts only what arrived, so the rest is to buy again', () => {
    assert.deepEqual(
      after.body.data.needs.map((n) => [n.sampleMaterialId, n.orderedQty, n.receivedQty, n.toBuy]),
      [[button.id, 10, 10, 2]]
    )
  })
  // A cancelled order buys nothing: its quantity goes back to the need.
  const extra = await call(
    'POST',
    '/purchase/orders',
    order([pol('sample-button', 2, { unitRate: 2, sampleMaterialId: button.id })], { supplierId: 'sample-trims-supplier' })
  )
  expect(extra, 201)
  const covered = (await call('GET', `/sampling/needs?requestId=${doc.id}`)).body.data.needs
  const cancelled = await call('PATCH', `/purchase/orders/${extra.body.data.id}/cancel`, { reason: 'Raised twice' })
  expect(cancelled, 200)
  const back = (await call('GET', `/sampling/needs?requestId=${doc.id}`)).body.data.needs
  check('a cancelled order gives its quantity back to the sample', () => {
    assert.equal(covered.length, 0)
    assert.deepEqual(back.map((n) => [n.sampleMaterialId, n.toBuy]), [[button.id, 2]])
  })

  // ── The sample store is kept apart ──────────────────────────────────────────
  const dept = await db.department.findFirst({ where: { isActive: true } })
  const mr = await call('POST', '/inventory/requisitions', {
    departmentId: dept.id,
    lines: [{ itemId: 'sample-fabric', requestedQty: 1, warehouseId: SAMPLE_STORE }],
  })
  const transferOut = await call('POST', '/inventory/transfers', {
    fromWarehouseId: SAMPLE_STORE,
    toWarehouseId: GENERAL_STORE,
    lines: [{ itemId: 'sample-fabric', qty: 1 }],
  })
  const transferIn = await call('POST', '/inventory/transfers', {
    fromWarehouseId: GENERAL_STORE,
    toWarehouseId: SAMPLE_STORE,
    lines: [{ itemId: 'sample-fabric', qty: 1 }],
  })
  check('a requisition, or a transfer in or out, cannot use a sample store', () => {
    expect(mr, 409, 'SAMPLE_STORE')
    assert.match(mr.body.message, /Example Sample Store is a sample store/)
    expect(transferOut, 409, 'SAMPLE_STORE')
    assert.match(transferOut.body.message, /A stock transfer cannot move stock in or out of it/)
    expect(transferIn, 409, 'SAMPLE_STORE')
  })
  assert.equal(await inSampleStore('sample-fabric'), fabricBefore + 5)
  // Reordering counts general stock only: the 10 buttons in the sample store are not stock to sell from.
  const buttonItem = await db.item.findUnique({ where: { id: 'sample-button' } })
  await db.item.update({ where: { id: 'sample-button' }, data: { reorderLevel: 1 } })
  const [reorder] = await reorderStatus(db, { itemId: 'sample-button' })
  await db.item.update({ where: { id: 'sample-button' }, data: { reorderLevel: buttonItem.reorderLevel } })
  const generalButtons = await db.stockLedger.aggregate({
    where: { itemId: 'sample-button', warehouse: { purpose: 'GENERAL' } },
    _sum: { inQty: true, outQty: true },
  })
  check('reordering does not count material held for samples', () =>
    assert.equal(reorder.onHand, +(generalButtons._sum.inQty ?? 0) - +(generalButtons._sum.outQty ?? 0))
  )

  // Sampling issues its own material from the sample store.
  await act('MATERIAL', {
    materialId: button.id,
    kind: 'ISSUE',
    qty: 10,
    reason: 'For the sample',
    warehouseId: SAMPLE_STORE,
  })
  check('Sampling issues what it bought from the sample store', () => {
    assert.equal(+doc.rounds[0].materials[1].issuedQty, 10)
  })
  assert.equal(await inSampleStore('sample-button'), buttonBefore)

  // Two go back to the sample store (Sampling may return there), the rest are used.
  await act('MATERIAL', { materialId: button.id, kind: 'RETURN', qty: 2, reason: 'Two spare' })
  await act('MATERIAL', { materialId: button.id, kind: 'USE', qty: 8, reason: 'Sewn on' })
  assert.equal(await inSampleStore('sample-button'), buttonBefore + 2)
  // Two more buttons ordered from another supplier: reopening the first order's closed
  // line would then order more than the sample needs, with no reason, so it stays closed.
  const late = await call(
    'POST',
    '/purchase/orders',
    order([pol('sample-button', 2, { unitRate: 2, sampleMaterialId: button.id })], { supplierId: 'sample-trims-supplier' })
  )
  expect(late, 201)
  const reopen = await call('PATCH', `/purchase/orders/${poId}/lines/${buttonLine.id}/reopen`)
  check('a sample line closed short is not reopened past what the sample still needs', () => {
    expect(reopen, 409, 'SAMPLE_OVER_ORDER')
    assert.match(reopen.body.message, /Leave it closed/)
  })
  // One of the two arrives, then the order is called off: the one that came still counts.
  expect(await call('PATCH', `/purchase/orders/${late.body.data.id}/send`), 200)
  const lateLine = late.body.data.lines[0]
  expect(
    await call('POST', '/purchase/grn', {
      poId: late.body.data.id,
      ...paper,
      lines: [{ poLineId: lateLine.id, warehouseId: SAMPLE_STORE, receivedQty: 1 }],
    }),
    201
  )
  expect(await call('PATCH', `/purchase/orders/${late.body.data.id}/cancel`, { reason: 'Supplier stopped' }), 200)
  const partly = (await call('GET', `/sampling/needs?requestId=${doc.id}`)).body.data.needs
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  check('an order cancelled after part of it came counts what came, and shows as cancelled', () => {
    assert.deepEqual(
      partly.map((n) => [n.sampleMaterialId, n.orderedQty, n.receivedQty, n.toBuy]),
      [[button.id, 11, 11, 1]]
    )
    const cancelledOrder = doc.rounds[0].materials[1].orders.find((o) => o.poId === late.body.data.id)
    assert.equal(cancelledOrder.status, 'CANCELLED')
    assert.equal(cancelledOrder.cancelled, true)
  })
  // The service's own rules, straight: an indent and a sample on one line; and a return or
  // a note that would move a sample's material outside the sample store, or other goods in.
  const { assertSampleLines, assertSampleStoreLines } = require('../apps/api/src/services/sampleSourcing.service.ts')
  const refusedWith = async (fn) => {
    try {
      await db.$transaction(fn)
      return null
    } catch (e) {
      return e.code
    }
  }
  const grnLineOf = Object.fromEntries(grn.body.data.lines.map((l) => [l.poLineId, l.id]))
  const both = await refusedWith((tx) =>
    assertSampleLines(tx, [{ itemId: 'sample-button', qty: 1, sampleMaterialId: button.id, mrLineId: 'any-indent-line' }], {
      isService: false,
    })
  )
  const fabricOut = await refusedWith((tx) =>
    assertSampleStoreLines(tx, [{ warehouseId: GENERAL_STORE, grnLineId: grnLineOf[fabricLine.id], itemName: 'Example Cotton' }])
  )
  const threadIn = await refusedWith((tx) =>
    assertSampleStoreLines(tx, [{ warehouseId: SAMPLE_STORE, grnLineId: grnLineOf[threadLine.id], itemName: 'Thread' }])
  )
  const freeIn = await refusedWith((tx) =>
    assertSampleStoreLines(tx, [{ warehouseId: SAMPLE_STORE, itemName: 'Thread' }])
  )
  const fabricBack = await refusedWith((tx) =>
    assertSampleStoreLines(tx, [{ warehouseId: SAMPLE_STORE, grnLineId: grnLineOf[fabricLine.id], itemName: 'Example Cotton' }])
  )
  check('a line is for an indent or a sample, and returns and notes keep a sample’s material in its store', () => {
    assert.equal(both, 'SAMPLE_AND_INDENT')
    assert.equal(fabricOut, 'SAMPLE_GOODS_TO_SAMPLE_STORE')
    assert.equal(threadIn, 'SAMPLE_STORE')
    assert.equal(freeIn, 'SAMPLE_STORE')
    assert.equal(fabricBack, null)
  })
  // The last button, on an order still open when the request is cancelled.
  const last = await call(
    'POST',
    '/purchase/orders',
    order([pol('sample-button', 1, { unitRate: 2, sampleMaterialId: button.id })], { supplierId: 'sample-trims-supplier' })
  )
  expect(last, 201)
  // A cancelled request is bought for no more.
  await act('CANCEL', 'Local sourcing check complete')
  const lastFix = await call('PATCH', `/purchase/orders/${last.body.data.id}`, {
    lines: [pol('sample-button', 1, { unitRate: 2.5, sampleMaterialId: button.id })],
  })
  const lastMore = await call('PATCH', `/purchase/orders/${last.body.data.id}`, {
    lines: [pol('sample-button', 2, { unitRate: 2.5, sampleMaterialId: button.id, sampleOverReason: 'Want a spare one' })],
  })
  const binned = await call('DELETE', `/purchase/orders/${last.body.data.id}`)
  const restored = await call('POST', `/purchase/recycle-bin/${last.body.data.id}/restore`)
  check('an order placed while the sample was open can be corrected, not grown, nor brought back from the bin', () => {
    expect(lastFix, 200)
    assert.equal(+lastFix.body.data.lines[0].unitRate, 2.5)
    assert.equal(lastFix.body.data.lines[0].sampleMaterialId, button.id)
    expect(lastMore, 409, 'SAMPLE_NOT_OPEN')
    assert.match(lastMore.body.message, /can keep the 1 pcs of Horn button 18L brown it had for it, but not order more/)
    expect(binned, 200)
    expect(restored, 409, 'SAMPLE_NOT_OPEN')
    assert.match(restored.body.message, /cannot be put back: .* is cancelled, so nothing is bought for it\. Raise a new order/)
  })
  const afterCancel = await call(
    'POST',
    '/purchase/orders',
    order([pol('sample-button', 2, { unitRate: 2, sampleMaterialId: button.id })])
  )
  const cancelledNeeds = await call('GET', `/sampling/needs?requestId=${doc.id}`)
  check('a cancelled request’s needs drop off and nothing more is ordered for it', () => {
    expect(afterCancel, 409, 'SAMPLE_NOT_OPEN')
    assert.match(afterCancel.body.message, /is cancelled/)
    assert.equal(cancelledNeeds.body.data.needs.length, 0)
  })

  console.log(`\n${passed} sourcing checks passed on local lderp_sampling. Shared database never accessed.`)
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
