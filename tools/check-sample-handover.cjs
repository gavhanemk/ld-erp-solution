// Sampling phase 8: the handover to bulk — a style made in sampling becomes a production style,
// each approved colour gets a draft BOM priced at what the sample paid, the style gets a routing
// made from the sample's route, and production accepts once Masters has approved the BOMs.
// HTTP + real PostgreSQL checks on the local pilot only. No .env loading.
const assert = require('node:assert/strict')
process.env.DATABASE_URL ||= 'postgresql://postgres@127.0.0.1:55439/lderp_sampling?schema=ld_erp'
const target = new URL(process.env.DATABASE_URL)
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/lderp_sampling')
  throw Error('Handover checks require local lderp_sampling')
process.env.DIRECT_URL = process.env.DATABASE_URL
process.env.SAMPLING_ENABLED = 'true'
process.env.NODE_ENV = 'test'
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
process.env.STORAGE_DRIVER = 'local'
process.env.LOCAL_STORAGE_SECRET = 'check-handover-only-' + nodeCrypto.randomBytes(24).toString('hex')
const checkFiles = path.join(__dirname, '..', '.local-sampling', 'check-files-handover')
fs.mkdirSync(checkFiles, { recursive: true })
const fileRoot = fs.mkdtempSync(path.join(checkFiles, 'run-'))
process.env.LOCAL_STORAGE_DIR = fileRoot
require('./register-ts.cjs')
require('express-async-errors')
const express = require('express')
const { prisma: db } = require('../packages/database/src/index.ts')
const sampling = require('../apps/api/src/routes/sampling.routes.ts').default
const purchase = require('../apps/api/src/routes/purchase.routes.ts').default
const masters = require('../apps/api/src/routes/master.routes.ts').default
const { nextVersionAfter } = require('../apps/api/src/services/bom.service.ts')
const { handoverBomStatus } = require('../apps/api/src/services/sampleHandover.service.ts')
const { makingLedger } = require('../packages/shared/src/sampleMaking.ts')
const { ZodError } = require('zod')

let passed = 0,
  server
const check = (label, fn) => {
  fn()
  passed++
  console.log('PASS ' + label)
}
const SAMPLE_STORE = 'sample-room-store'

async function main() {
  const [{ db: dbName }] = await db.$queryRaw`SELECT current_database() AS db`
  assert.equal(dbName, 'lderp_sampling')
  const api = express()
  api.use(express.json())
  api.use((req, res, next) => {
    req.user = { id: 'sample-user', name: 'Test manager', role: 'Admin', roleId: 'local', email: 'sampler@example.com' }
    if (req.headers['x-permissions'] !== undefined)
      req.user = { ...req.user, role: 'Test operator', permissions: String(req.headers['x-permissions']).split(',') }
    next()
  })
  api.use('/sampling', sampling)
  api.use('/purchase', purchase)
  api.use('/masters', masters)
  api.use((err, req, res, next) =>
    res.status(err.statusCode ?? (err instanceof ZodError ? 400 : 500)).json({ message: err.message, code: err.code })
  )
  server = api.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const call = async (method, url, body, perms) => {
    const r = await fetch(origin + url, {
      method,
      headers: { 'content-type': 'application/json', ...(perms !== undefined ? { 'x-permissions': perms } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: r.status, body: await r.json() }
  }
  const expect = (r, status, code) => {
    assert.equal(r.status, status, JSON.stringify(r.body))
    if (code) assert.equal(r.body.code, code, JSON.stringify(r.body))
  }
  const stamp = Date.now()
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
  const M = 'sample-size-M'
  const sizeRun = (await db.size.findUniqueOrThrow({ where: { id: M } })).sizeGroupId
  const opOf = Object.fromEntries(
    (await db.operation.findMany({ where: { code: { in: ['EX-CUT', 'OP-STI', 'OP-FIN'] } } })).map((o) => [o.code, o])
  )
  const step = (op) => ({
    operationId: op.id,
    name: '',
    kind: op.kind,
    departmentId: '',
    execution: 'IN_HOUSE',
    contractorId: null,
    vendorId: null,
    instructions: '',
  })
  const line = (itemId, component, qtyPerPiece, colour = null) => ({
    component,
    itemId,
    colour,
    departmentId: null,
    qtyPerPiece,
    wastagePct: 0,
    requiredQty: 0,
    requiredOverride: false,
    overrideReason: '',
    source: 'PURCHASE',
    estRate: null,
    remarks: '',
  })

  check('the next BOM version is one up from the highest whole one', () => {
    assert.equal(nextVersionAfter([]), '1.0')
    assert.equal(nextVersionAfter(['1.0', '1.1']), '2.0')
    assert.equal(nextVersionAfter(['2.0', 'draft']), '3.0')
  })

  let doc = (
    await call('POST', '/sampling', {
      clientKey: crypto.randomUUID(),
      title: `Handover check ${stamp}`,
      customerId: 'sample-buyer',
      brandId: 'sample-brand',
      owner: 'Test manager',
      brief: 'A new shirt in two colours, handed over to bulk.',
      buyerRef: 'EXAMPLE-REF',
      requiredAt: null,
    })
  ).body.data
  const act = async (action, data = {}, status = 200, perms, roundId = doc.rounds[0].id) => {
    const r = await call('POST', `/sampling/${doc.id}/actions`, { version: doc.version, roundId, action, data }, perms)
    expect(r, status)
    if (status === 200) doc = r.body.data
    return r
  }
  // A style made for the sample, in White and Navy.
  await act('CREATE_STYLE', { name: `Handover shirt ${stamp}`, category: 'Shirt', sizeGroupId: sizeRun, colors: ['White', 'Navy'], season: 'SS-27' })
  const styleId = doc.styleId
  const madeStyle = await db.style.findUniqueOrThrow({ where: { id: styleId } })
  assert.equal(madeStyle.stage, 'DEVELOPMENT')
  // White M ×2 and Navy M ×1: 2.5 m of fabric a piece, and six buttons on Navy only.
  await act('RELEASE', {
    milestone: 'Fit sample',
    styleId,
    construction: 'Straight seam.',
    techPackRef: 'EXAMPLE-TECH-v1',
    patternRef: 'EXAMPLE-PATTERN-v1',
    colours: [
      { colour: 'White', sizes: [{ sizeId: M, qty: 2 }] },
      { colour: 'Navy', sizes: [{ sizeId: M, qty: 1 }] },
    ],
    measurements: [{ name: 'Chest', sizeId: M, target: 50, tolerance: 0.5, unit: 'cm' }],
    route: [step(opOf['EX-CUT']), step(opOf['OP-STI']), step(opOf['OP-FIN'])],
    materials: [line('sample-fabric', 'Body', 2.5), line('sample-button', 'Front', 6, 'Navy')],
    notes: 'Fictional handover check',
  })
  const [fabric, button] = ['sample-fabric', 'sample-button'].map((id) => doc.rounds[0].materials.find((m) => m.itemId === id))
  // Bought for the sample: fabric at ₹100 less 10% (₹90 a metre), buttons at ₹2.
  const po = await call('POST', '/purchase/orders', {
    supplierId: 'sample-fabric-mill',
    poType: 'ITEM_LEVEL',
    deliveryWarehouseId: SAMPLE_STORE,
    lines: [
      { itemId: 'sample-fabric', qty: 7.5, unitRate: 100, discount: 10, gstRate: 5, sampleMaterialId: fabric.id },
      { itemId: 'sample-button', qty: 6, unitRate: 2, gstRate: 5, sampleMaterialId: button.id },
    ],
  })
  expect(po, 201)
  expect(await call('PATCH', `/purchase/orders/${po.body.data.id}/send`), 200)
  expect(
    await call('POST', '/purchase/grn', {
      poId: po.body.data.id,
      challanNo: `CH-HO-${stamp}`,
      challanDate: today,
      lines: po.body.data.lines.map((l) => ({ poLineId: l.id, warehouseId: SAMPLE_STORE, receivedQty: +l.qty })),
    }),
    201
  )
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  await act('MATERIAL', { materialId: fabric.id, kind: 'ISSUE', qty: 7.5, reason: 'For the sample', warehouseId: SAMPLE_STORE })
  await act('MATERIAL', { materialId: button.id, kind: 'ISSUE', qty: 6, reason: 'For the sample', warehouseId: SAMPLE_STORE })
  // Made through the route.
  const ledger = () => makingLedger(doc.rounds[0])
  const cells = (list, pick) =>
    list.filter((c) => pick(c) > 0).map((c) => ({ colour: c.colour, sizeId: c.sizeId, qty: pick(c) }))
  for (let i = 0; i < doc.rounds[0].stages.length; i++) {
    const st = doc.rounds[0].stages[i]
    for (const t of doc.rounds[0].transfers.filter((x) => x.toStageId === st.id && !x.receivedOn))
      await act('STEP_RECEIVE', { transferId: t.id, cells: t.cells, receivedBy: 'Example operator' })
    await act('STEP_WORK', {
      stageId: st.id,
      cells: cells(ledger()[i].cells, (c) => c.here).map(({ qty, ...c }) => ({ ...c, done: qty, rejected: 0 })),
      doneBy: 'Example operator',
    })
    if (doc.rounds[0].stages[i + 1])
      await act('STEP_SEND', { fromStageId: st.id, cells: cells(ledger()[i].cells, (c) => c.ready), sentBy: 'Example operator' })
  }
  const [cut, sti] = doc.rounds[0].stages
  await act('STEP_LABOUR', { stageId: cut.id, amount: 300, note: 'Cutter' })
  await act('STEP_LABOUR', { stageId: sti.id, amount: 600, note: 'Tailor' })
  await act('QC', {
    notes: 'Inspected',
    colours: [
      { colour: 'White', actuals: [50], cells: [{ sizeId: M, passed: 2 }] },
      { colour: 'Navy', actuals: [50], cells: [{ sizeId: M, passed: 1 }] },
    ],
  })
  await act('DISPATCH', {
    cells: [
      { colour: 'White', sizeId: M, qty: 2 },
      { colour: 'Navy', sizeId: M, qty: 1 },
    ],
    recipient: 'Example Buyer',
    mode: 'COURIER',
    courier: 'Example Courier',
    awb: `AWB-HO-${stamp}`,
    courierCharge: 150,
  })
  await act('DECIDE', {
    buyerName: 'Example buyer',
    evidence: 'EXAMPLE-EMAIL',
    colours: [
      { colour: 'White', result: 'APPROVED', conditions: '' },
      { colour: 'Navy', result: 'APPROVED', conditions: '' },
    ],
  })
  await act('MATERIAL', { materialId: fabric.id, kind: 'USE', qty: 7, reason: 'Cut into the pieces' })
  await act('MATERIAL', { materialId: fabric.id, kind: 'WASTE', qty: 0.5, reason: 'Cutting waste' })
  await act('MATERIAL', { materialId: button.id, kind: 'USE', qty: 6, reason: 'Sewn on' })
  const both = { boms: [{ colour: 'White', bomId: null }, { colour: 'Navy', bomId: null }], routingId: null, notes: 'Pattern v1 approved' }
  const costFirst = await act('HANDOVER', both, 409)
  await act('FINALISE_COST', { notes: 'Sent with the samples' })
  // Another style's BOM is not this one's.
  const otherBom = await act('HANDOVER', { ...both, boms: [{ colour: 'White', bomId: 'sample-bom' }, { colour: 'Navy', bomId: null }] }, 409)
  const notApprover = await act('HANDOVER', both, 403, 'sampling:view,sampling:edit')
  const ordersBefore = await db.manufacturingOrder.count()
  const handed = await act('HANDOVER', both)
  check('handover waits for the costs, takes only this style’s BOMs, and needs sampling approval', () => {
    assert.equal(costFirst.body.code, 'COST_NOT_FINAL')
    assert.equal(otherBom.body.code, 'HANDOVER_BOM')
    assert.equal(notApprover.status, 403)
  })

  // ── What the handover made ──────────────────────────────────────────────────
  const style = await db.style.findUniqueOrThrow({ where: { id: styleId } })
  const h = doc.rounds[0].handover
  const boms = await db.bOM.findMany({
    where: { styleId },
    include: { lines: { orderBy: { sortOrder: 'asc' } }, costLines: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { color: 'desc' },
  })
  const routing = await db.routing.findFirst({
    where: { styleId },
    include: { steps: { orderBy: { sequence: 'asc' } } },
  })
  check('a style made in sampling becomes a production style at handover', () => {
    assert.equal(style.stage, 'PRODUCTION')
    assert.deepEqual(h.style, { id: styleId, code: style.code, name: style.name, promoted: true })
  })
  check('the style gets a routing made from the sample’s route', () => {
    assert.ok(routing)
    assert.equal(routing.code, `RT-${style.code}`)
    assert.deepEqual(
      routing.steps.map((s) => s.operationId),
      [opOf['EX-CUT'].id, opOf['OP-STI'].id, opOf['OP-FIN'].id]
    )
    assert.deepEqual([h.routing.id, h.routing.made, h.routing.revision], [routing.id, true, 1])
    // A route with no quality check is allowed, and said.
    assert.ok(handed.body.warnings.some((w) => w.startsWith(`${routing.code}: `) && /no quality check/.test(w)), JSON.stringify(handed.body.warnings))
  })
  check('each approved colour gets a draft BOM priced at what the sample paid, with its labour and charges a piece', () => {
    assert.deepEqual(
      boms.map((b) => [b.color, b.version, b.status, b.routingId]),
      [
        ['White', '1.0', 'DRAFT', routing.id],
        ['Navy', '1.0', 'DRAFT', routing.id],
      ]
    )
    const [white, navy] = boms
    assert.deepEqual(white.lines.map((l) => [l.componentItemId, +l.qtyPerUnit, +l.unitCost, +l.totalCost]), [['sample-fabric', 2.5, 90, 225]])
    assert.deepEqual(navy.lines.map((l) => [l.componentItemId, +l.qtyPerUnit, +l.unitCost, +l.totalCost]), [
      ['sample-fabric', 2.5, 90, 225],
      ['sample-button', 6, 2, 12],
    ])
    // ₹900 of labour and ₹150 of courier for three pieces.
    assert.deepEqual(white.costLines.map((c) => [c.kind, c.name, +c.amount]), [
      ['LABOUR', 'Sample labour, round 1', 300],
      ['OVERHEAD', 'Sample charges, round 1', 50],
    ])
    assert.deepEqual([+white.totalCost, +white.costPerPiece, +navy.totalCost, +navy.costPerPiece], [225, 575, 237, 587])
    assert.match(white.notes, new RegExp(`Made from sample ${doc.number}, round 1, approved by Example buyer`))
    assert.match(navy.lines[1].notes, /The sample used 6 .* a piece/)
    assert.deepEqual(
      h.boms.map((b) => [b.colour, b.bomId, b.made, b.costPerPiece]),
      [
        ['White', white.id, true, 575],
        ['Navy', navy.id, true, 587],
      ]
    )
    assert.deepEqual(doc.handoverBoms.map((b) => [b.colour, b.status, b.approved]), [
      ['White', 'DRAFT', null],
      ['Navy', 'DRAFT', null],
    ])
  })
  const register = (await call('GET', '/sampling?limit=100', undefined, 'sampling:view')).body.data.find((r) => r.id === doc.id)
  check('the register shows only whether the handover is prepared, never its figures', () => {
    assert.deepEqual(Object.keys(register.rounds[0].handover).sort(), ['preparedAt', 'preparedBy'])
  })
  const audits = await db.auditLog.findMany({ where: { entityId: { in: [...boms.map((b) => b.id), routing.id, styleId] } } })
  const viewer = (await call('GET', `/sampling/${doc.id}`, undefined, 'sampling:view')).body.data
  check('what the handover made is audited under Masters, and its figures kept to those who see costs', () => {
    assert.deepEqual(
      audits.map((a) => `${a.module}:${a.entityType}:${a.action}`).sort(),
      // The style made for the sample, then made production at handover.
      ['masters:BOM:CREATE', 'masters:BOM:CREATE', 'masters:Routing:CREATE', 'masters:Style:CREATE', 'masters:Style:UPDATE']
    )
    const shown = viewer.rounds[0].handover
    assert.equal(shown.cost, undefined)
    assert.equal(shown.boms[0].costPerPiece, undefined)
    assert.equal('unitCost' in shown.boms[0].lines[0], false)
    assert.equal(shown.boms[0].version, '1.0')
  })

  // ── Production's acceptance waits for Masters ───────────────────────────────
  const [white, navy] = boms
  const waitBoth = await act('ACCEPT_HANDOVER', {}, 409)
  expect(await call('PATCH', `/masters/bom/${white.id}/approve`), 200)
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  const waitNavy = await act('ACCEPT_HANDOVER', {}, 409)
  expect(await call('PATCH', `/masters/bom/${navy.id}/approve`), 200)
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  const notProduction = await act('ACCEPT_HANDOVER', {}, 403, 'sampling:view,sampling:edit')
  await act('ACCEPT_HANDOVER')
  const again = await act('HANDOVER', both, 409)
  const newRound = await act('NEW_ROUND', 'Another milestone after handover', 409)
  const ordersAfter = await db.manufacturingOrder.count()
  check('production accepts once Masters has approved each colour’s BOM; no production order is made', () => {
    assert.equal(waitBoth.body.code, 'BOM_NOT_APPROVED')
    assert.match(waitBoth.body.message, /White \(v1\.0\) and Navy \(v1\.0\)/)
    assert.match(waitNavy.body.message, /for Navy \(v1\.0\)\./)
    assert.equal(notProduction.status, 403)
    const accepted = doc.rounds[0].handover
    assert.equal(accepted.acceptedBy, 'Test manager')
    assert.deepEqual(accepted.accepted.map((a) => [a.colour, a.bomId]), [
      ['White', white.id],
      ['Navy', navy.id],
    ])
    assert.equal(doc.events[0].action, 'ACCEPT_HANDOVER')
    assert.equal(again.status, 409)
    assert.equal(newRound.status, 409)
    assert.equal(ordersAfter, ordersBefore)
  })

  // ── Masters works its BOMs as before (the arithmetic moved to bom.service) ─
  const copy = await call('POST', `/masters/bom/${white.id}/copy`, { version: '2.0' })
  expect(copy, 201)
  const repriced = await call('PATCH', `/masters/bom/${copy.body.data.id}`, {
    lines: [{ componentItemId: 'sample-fabric', component: 'Body', qtyPerUnit: 2.4, wastagePercent: 5, unitCost: 90 }],
  })
  const clash = await call('POST', '/masters/bom', {
    styleId,
    color: 'White',
    version: '2.0',
    lines: [{ componentItemId: 'sample-fabric', qtyPerUnit: 2.5, unitCost: 90 }],
  })
  const fresh = await call('POST', '/masters/bom', {
    styleId,
    color: 'White',
    version: '3.0',
    lines: [{ componentItemId: 'sample-button', qtyPerUnit: 4 }],
  })
  check('Masters still prices, copies and guards versions of the BOMs the handover made', () => {
    assert.equal(copy.body.data.status, 'DRAFT')
    assert.equal(+copy.body.data.costPerPiece, 575)
    expect(repriced, 200)
    // 2.4 m at 5% wastage is 2.52 m, at ₹90.
    assert.deepEqual([+repriced.body.data.lines[0].effectiveQty, +repriced.body.data.totalCost], [2.52, 226.8])
    expect(clash, 409, 'BOM_VERSION_EXISTS')
    // No rate typed and none on the item: saved, and the missing rate named.
    expect(fresh, 201)
    assert.equal(+fresh.body.data.totalCost, 0)
    assert.match(fresh.body.message, /no rate yet — Horn button 18L brown/)
  })
  // A draft made at handover is not stood in for by a BOM approved before it.
  const draftHandover = (preparedAt) => ({
    style: { id: styleId },
    preparedAt,
    boms: [{ colour: 'White', bomId: copy.body.data.id, version: '2.0', made: true }],
  })
  const fromNow = await handoverBomStatus(db, draftHandover(new Date()))
  const fromBefore = await handoverBomStatus(db, draftHandover(new Date(Date.now() - 86400000)))
  await db.bOM.delete({ where: { id: copy.body.data.id } })
  const removedDraft = await handoverBomStatus(db, draftHandover(new Date()))
  check('a re-sample’s draft waits for its own approval, or one Masters gives the colour after the handover', () => {
    assert.deepEqual([fromNow[0].status, fromNow[0].approved], ['DRAFT', null])
    assert.equal(fromBefore[0].approved.id, white.id)
    assert.deepEqual([removedDraft[0].status, removedDraft[0].approved], ['DELETED', null])
  })
  await db.bOM.deleteMany({ where: { id: { in: [fresh.body.data.id] } } })

  console.log(`\n${passed} handover checks passed on local lderp_sampling. Shared database never accessed.`)
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
