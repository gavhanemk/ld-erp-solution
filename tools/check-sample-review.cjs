// Sampling phase 6: QC colour by colour, sending samples to the buyer on a Sample Delivery
// Challan, the buyer's word colour by colour, and the next round making only what must be made
// again. HTTP + real PostgreSQL checks on the local pilot only. No .env loading.
const assert = require('node:assert/strict')
process.env.DATABASE_URL ||= 'postgresql://postgres@127.0.0.1:55439/lderp_sampling?schema=ld_erp'
const target = new URL(process.env.DATABASE_URL)
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/lderp_sampling')
  throw Error('Review checks require local lderp_sampling')
process.env.DIRECT_URL = process.env.DATABASE_URL
process.env.SAMPLING_ENABLED = 'true'
process.env.NODE_ENV = 'test'
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
process.env.STORAGE_DRIVER = 'local'
process.env.LOCAL_STORAGE_SECRET = 'check-review-only-' + nodeCrypto.randomBytes(24).toString('hex')
const checkFiles = path.join(__dirname, '..', '.local-sampling', 'check-files-review')
fs.mkdirSync(checkFiles, { recursive: true })
const fileRoot = fs.mkdtempSync(path.join(checkFiles, 'run-'))
process.env.LOCAL_STORAGE_DIR = fileRoot
require('./register-ts.cjs')
require('express-async-errors')
const express = require('express')
const { prisma: db } = require('../packages/database/src/index.ts')
const sampling = require('../apps/api/src/routes/sampling.routes.ts').default
const purchase = require('../apps/api/src/routes/purchase.routes.ts').default
const { makingLedger } = require('../packages/shared/src/sampleMaking.ts')
const { colourOutcomes } = require('../packages/shared/src/sampleReview.ts')
const { ZodError } = require('zod')

let passed = 0,
  server,
  // Put back on the example style at the end, however the run ends.
  restoreStyle = null
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
  const M = 'sample-size-M',
    L = 'sample-size-L'

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
  // The example style in the colours sampled here; put back as it was at the end.
  const style = await db.style.findUnique({ where: { id: 'sample-style' }, select: { colors: true } })
  const wanted = ['White', 'Blue', 'Black'].filter((c) => !style.colors.some((x) => x.toLowerCase() === c.toLowerCase()))
  if (wanted.length) {
    restoreStyle = style.colors
    await db.style.update({ where: { id: 'sample-style' }, data: { colors: { set: [...style.colors, ...wanted] } } })
  }
  // White M ×2 and L ×1, Blue M ×1, Black M ×1: five pieces, 12.5 m of fabric.
  const spec = {
    milestone: 'Fit sample',
    styleId: 'sample-style',
    construction: 'Straight seam.',
    techPackRef: 'EXAMPLE-TECH-v1',
    patternRef: 'EXAMPLE-PATTERN-v1',
    colours: [
      { colour: 'White', sizes: [{ sizeId: M, qty: 2 }, { sizeId: L, qty: 1 }] },
      { colour: 'Blue', sizes: [{ sizeId: M, qty: 1 }] },
      { colour: 'Black', sizes: [{ sizeId: M, qty: 1 }] },
    ],
    measurements: [
      { name: 'Chest', sizeId: M, target: 50, tolerance: 0.5, unit: 'cm' },
      { name: 'Chest', sizeId: L, target: 52, tolerance: 0.5, unit: 'cm' },
      { name: 'Length', sizeId: M, target: 70, tolerance: 1, unit: 'cm' },
      { name: 'Length', sizeId: L, target: 72, tolerance: 1, unit: 'cm' },
    ],
    route: [step(opOf['EX-CUT']), step(opOf['OP-STI']), step(opOf['OP-FIN'])],
    materials: [
      {
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
      },
    ],
    notes: 'Fictional review check',
  }
  let doc = (
    await call('POST', '/sampling', {
      clientKey: crypto.randomUUID(),
      title: `Review check ${stamp}`,
      customerId: 'sample-buyer',
      brandId: 'sample-brand',
      owner: 'Test manager',
      brief: 'Three colours sent to the buyer, decided colour by colour.',
      buyerRef: 'EXAMPLE-REF',
      requiredAt: null,
    })
  ).body.data
  const act = async (action, data = {}, status = 200, perms) => {
    const r = await call('POST', `/sampling/${doc.id}/actions`, { version: doc.version, roundId: doc.rounds[0].id, action, data }, perms)
    expect(r, status)
    if (status === 200) doc = r.body.data
    return r
  }
  await act('LINK_STYLE', { styleId: 'sample-style' })
  await act('RELEASE', spec)
  // Bought, received into the sample store and issued.
  const fabric = doc.rounds[0].materials[0]
  const po = await call('POST', '/purchase/orders', {
    supplierId: 'sample-fabric-mill',
    poType: 'NONE',
    deliveryWarehouseId: SAMPLE_STORE,
    lines: [{ itemId: 'sample-fabric', qty: 12.5, unitRate: 100, gstRate: 5, sampleMaterialId: fabric.id }],
  })
  expect(po, 201)
  expect(await call('PATCH', `/purchase/orders/${po.body.data.id}/send`), 200)
  expect(
    await call('POST', '/purchase/grn', {
      poId: po.body.data.id,
      challanNo: `CH-REVIEW-${stamp}`,
      challanDate: today,
      lines: po.body.data.lines.map((l) => ({ poLineId: l.id, warehouseId: SAMPLE_STORE, receivedQty: +l.qty })),
    }),
    201
  )
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  await act('MATERIAL', { materialId: fabric.id, kind: 'ISSUE', qty: 12.5, reason: 'For the sample', warehouseId: SAMPLE_STORE })
  // Made through the route: every piece done, handed on and counted in.
  const ledger = () => makingLedger(doc.rounds[0])
  const qty = (list, pick) =>
    list.filter((c) => pick(c) > 0).map((c) => ({ colour: c.colour, sizeId: c.sizeId, qty: pick(c) }))
  for (let i = 0; i < doc.rounds[0].stages.length; i++) {
    const st = doc.rounds[0].stages[i]
    for (const t of doc.rounds[0].transfers.filter((x) => x.toStageId === st.id && !x.receivedOn))
      await act('STEP_RECEIVE', { transferId: t.id, cells: t.cells, receivedBy: 'Example operator' })
    const here = qty(ledger()[i].cells, (c) => c.here)
    await act('STEP_WORK', {
      stageId: st.id,
      cells: here.map(({ qty: n, ...c }) => ({ ...c, done: n, rejected: 0 })),
      doneBy: 'Example operator',
    })
    if (doc.rounds[0].stages[i + 1])
      await act('STEP_SEND', { fromStageId: st.id, cells: qty(ledger()[i].cells, (c) => c.ready), sentBy: 'Example operator' })
  }
  const outcomes = () => colourOutcomes(doc.rounds[0])
  const status = () => Object.fromEntries(outcomes().map((o) => [o.colour, o.status]))

  // ── QC, colour by colour ────────────────────────────────────────────────────
  const white = (over = {}) => ({
    colour: 'White',
    actuals: [50, 52, 70, 72],
    cells: [
      { sizeId: M, passed: 2 },
      { sizeId: L, passed: 1 },
    ],
    ...over,
  })
  const one = (colour, actuals = [50, 70], over = {}) => ({ colour, actuals, cells: [{ sizeId: M, passed: 1 }], ...over })
  const qc = (colours, notes = 'Inspected') => ({ notes, colours })
  const leftOut = await act('QC', qc([white(), one('Blue')]), 409)
  const shortReadings = await act('QC', qc([white({ actuals: [50, 70] }), one('Blue'), one('Black')]), 409)
  const tooMany = await act('QC', qc([white({ cells: [{ sizeId: M, passed: 3 }, { sizeId: L, passed: 1 }] }), one('Blue'), one('Black')]), 409)
  const noSize = await act('QC', qc([white(), one('Blue'), one('Black', [50, 70], { cells: [{ sizeId: L, passed: 1 }] })]), 409)
  const viewer = await act('QC', qc([white(), one('Blue'), one('Black')]), 403, 'sampling:view,sampling:edit')
  // Blue's chest is out of tolerance: Blue fails, White and Black go to the buyer.
  await act('QC', qc([white(), one('Blue', [51, 70], { notes: 'Chest 1 cm over' }), one('Black')], 'Blue out on chest'))
  check('QC reads each colour on the points of the sizes it finished; a colour out of tolerance fails alone', () => {
    assert.equal(leftOut.body.code, 'QC_COLOURS')
    assert.match(leftOut.body.message, /Inspect Black too/)
    assert.equal(shortReadings.body.code, 'QC_READINGS')
    assert.match(shortReadings.body.message, /Measure every point of White: 4 readings/)
    assert.equal(tooMany.body.code, 'QC_CELLS')
    assert.equal(noSize.body.code, 'QC_CELLS')
    assert.equal(viewer.status, 403)
    assert.equal(doc.rounds[0].state, 'QC_PASSED')
    assert.deepEqual(status(), { White: 'TO_SEND', Blue: 'QC_FAILED', Black: 'TO_SEND' })
    assert.equal(doc.rounds[0].qc.passedQty, 4)
    assert.equal(doc.rounds[0].qc.results.length, 8)
    assert.equal(doc.rounds[0].qc.colours.find((c) => c.colour === 'Blue').results[0].pass, false)
  })

  // ── Sent to the buyer on a Sample Delivery Challan ──────────────────────────
  const send = (cells, over = {}) => ({
    cells,
    recipient: 'Example Buyer',
    address: 'Example address',
    mode: 'COURIER',
    courier: 'Example Courier',
    awb: 'AWB-1',
    courierCharge: 120,
    ...over,
  })
  const W = (sizeId, n) => ({ colour: 'White', sizeId, qty: n })
  const failedOne = await act('DISPATCH', send([{ colour: 'Blue', sizeId: M, qty: 1 }]), 409)
  const overSend = await act('DISPATCH', send([W(M, 3)]), 409)
  const noCourier = await act('DISPATCH', send([W(M, 1)], { courier: '' }), 400)
  const backNotReturnable = await act('DISPATCH', send([W(M, 1)], { expectedBack: today }), 400)
  const series = await db.numberSeries.findFirst({ where: { docType: 'SDC' } })
  await act('DISPATCH', send([W(M, 2), { colour: 'Black', sizeId: M, qty: 1 }]))
  const first = doc.rounds[0].dispatches[0]
  const reinspect = await act('QC', qc([white(), one('Blue'), one('Black')]), 409)
  check('only what passed QC is sent, no more than passed, on the SDC series', () => {
    assert.equal(failedOne.body.code, 'NOT_PASSED')
    assert.equal(overSend.body.code, 'NOT_TO_SEND')
    assert.match(overSend.body.message, /Only 2 of White · M passed QC/)
    assert.equal(noCourier.status, 400)
    assert.equal(backNotReturnable.status, 400)
    assert.ok(first.number.startsWith(series.prefix), first.number)
    assert.equal(doc.rounds[0].state, 'SUBMITTED')
    assert.deepEqual(status(), { White: 'SENT', Blue: 'QC_FAILED', Black: 'SENT' })
    assert.deepEqual(outcomes().find((o) => o.colour === 'White').toSend, [W(L, 1)])
    assert.equal(reinspect.body.code, 'QC_CLOSED')
  })
  // Sent by mistake: cancelled, the round is back to ready to send.
  const noReason = await act('DISPATCH_CANCEL', { dispatchId: first.id, reason: '' }, 400)
  await act('DISPATCH_CANCEL', { dispatchId: first.id, reason: 'Wrong courier booked' })
  check('a challan sent by mistake is cancelled, its pieces to send again', () => {
    assert.equal(noReason.status, 400)
    assert.ok(doc.rounds[0].dispatches[0].cancelledAt)
    assert.equal(doc.rounds[0].state, 'QC_PASSED')
    assert.deepEqual(status(), { White: 'TO_SEND', Blue: 'QC_FAILED', Black: 'TO_SEND' })
  })
  await act('DISPATCH', send([W(M, 2), W(L, 1)], { awb: 'AWB-2', returnable: true, expectedBack: today, declaredValue: 1500 }))
  // Black is not wanted after all: dropped unsent, by us, not the buyer.
  const decide = (colours) => ({ buyerName: 'Example buyer', evidence: 'EXAMPLE-EMAIL', colours })
  const unseen = await act('DECIDE', decide([{ colour: 'Black', result: 'REJECTED', conditions: '' }]), 409)
  const dropShort = await act('DROP_COLOUR', { colour: 'Black', reason: 'no' }, 400)
  const dropViewer = await act('DROP_COLOUR', { colour: 'Black', reason: 'Buyer dropped black' }, 403, 'sampling:view,sampling:edit')
  await act('DROP_COLOUR', { colour: 'Black', reason: 'Buyer dropped black' })
  const dropAgain = await act('DROP_COLOUR', { colour: 'Black', reason: 'Buyer dropped black' }, 409)
  // White's challan cancelled with Black decided: the round stays with the buyer, QC stands.
  await act('DISPATCH_CANCEL', { dispatchId: doc.rounds[0].dispatches[1].id, reason: 'Booked twice' })
  const reinspectDecided = await act('QC', qc([white(), one('Blue'), one('Black')]), 409)
  check('a colour not sent is dropped, not rejected; with a colour decided the inspection stands', () => {
    assert.equal(unseen.body.code, 'NOT_SENT')
    assert.equal(dropShort.status, 400)
    assert.equal(dropViewer.status, 403)
    assert.equal(dropAgain.body.code, 'DECIDED')
    assert.deepEqual(status(), { White: 'TO_SEND', Blue: 'QC_FAILED', Black: 'DROPPED' })
    assert.equal(doc.rounds[0].state, 'SUBMITTED')
    assert.equal(reinspectDecided.body.code, 'QC_CLOSED')
  })
  await act('DISPATCH', send([W(M, 2), W(L, 1)], { awb: 'AWB-3', returnable: true, expectedBack: today, declaredValue: 1500 }))
  const second = doc.rounds[0].dispatches[2]

  // ── The buyer's word, colour by colour ──────────────────────────────────────
  const onFailed = await act('DECIDE', decide([{ colour: 'Blue', result: 'APPROVED', conditions: '' }]), 409)
  const onDropped = await act('DECIDE', decide([{ colour: 'Black', result: 'APPROVED', conditions: '' }]), 409)
  const withConditions = await act('DECIDE', decide([{ colour: 'White', result: 'APPROVED', conditions: 'Shorter sleeve' }]), 409)
  const changesSaidNothing = await act('DECIDE', decide([{ colour: 'White', result: 'CHANGES_REQUIRED', conditions: '' }]), 409)
  const notApprover = await act('DECIDE', decide([{ colour: 'White', result: 'APPROVED', conditions: '' }]), 403, 'sampling:view,sampling:edit')
  await act('DECIDE', decide([{ colour: 'white', result: 'APPROVED', conditions: '' }]))
  const decidedChallan = await act('DISPATCH_CANCEL', { dispatchId: second.id, reason: 'Too late to cancel' }, 409)
  check('the buyer decides on what was sent; with every colour that passed decided, a failed one makes it changed', () => {
    assert.equal(onFailed.body.code, 'NOT_PASSED')
    assert.equal(onDropped.body.code, 'NOT_SENT')
    assert.equal(withConditions.body.code, 'CONDITIONS')
    assert.equal(changesSaidNothing.body.code, 'CONDITIONS')
    assert.equal(notApprover.status, 403)
    // Decided: the round has left the buyer, and its challans stand.
    assert.match(decidedChallan.body.message, /once the buyer has decided, it stands/)
    // Blue failed QC and is not dropped: it is made again, so the round is changed.
    assert.deepEqual(status(), { White: 'APPROVED', Blue: 'QC_FAILED', Black: 'DROPPED' })
    assert.equal(doc.rounds[0].state, 'CHANGES_REQUIRED')
    assert.equal(doc.rounds[0].decision.result, 'CHANGES_REQUIRED')
    assert.equal(doc.events[0].action, 'DECIDE')
    assert.deepEqual(doc.events[0].detail.data.colours, [{ colour: 'White', result: 'APPROVED', conditions: '' }])
  })

  // ── Viewers and the printed challan ─────────────────────────────────────────
  const viewOnly = await call('GET', `/sampling/${doc.id}`, undefined, 'sampling:view')
  const printed = await call('GET', `/sampling/dispatch/${second.id}/print`)
  check('the challan prints with the buyer and the pieces; what sending cost is not for viewers', () => {
    assert.equal('courierCharge' in viewOnly.body.data.rounds[0].dispatches[1], false)
    assert.equal(+doc.rounds[0].dispatches[1].courierCharge, 120)
    expect(printed, 200)
    const p = printed.body.data
    assert.equal(p.dispatch.number, second.number)
    assert.deepEqual(p.dispatch.cells, [W(M, 2), W(L, 1)])
    assert.equal(p.dispatch.round.request.customer.name, 'Example Buyer')
    assert.equal(p.dispatch.round.milestone, 'Fit sample')
    assert.equal(+p.dispatch.declaredValue, 1500)
    assert.equal('courierCharge' in p.dispatch, false)
    assert.ok(p.template.title)
  })

  // ── The next round makes only what must be made again ───────────────────────
  await act('NEW_ROUND', 'Blue made again after QC')
  const next = doc.rounds[0]
  check('the next round carries the colour that failed QC, its sizes and measurements', () => {
    assert.equal(next.revision, 2)
    assert.deepEqual(next.specification.colours, [{ colour: 'Blue', sizes: [{ sizeId: M, qty: 1 }] }])
    assert.deepEqual(next.specification.measurements.map((m) => [m.name, m.sizeId]), [
      ['Chest', M],
      ['Length', M],
    ])
    assert.equal(+next.materials[0].plannedQty, 2.5)
    assert.equal(doc.rounds[1].state, 'CHANGES_REQUIRED')
    assert.deepEqual(doc.events[0].detail.data.colours, ['Blue'])
  })
  // Round 1's fabric was all made into the pieces; the request is closed to keep the register tidy.
  await call('POST', `/sampling/${doc.id}/actions`, {
    version: doc.version,
    roundId: doc.rounds[1].id,
    action: 'MATERIAL',
    data: { materialId: fabric.id, kind: 'USE', qty: 12.5, reason: 'Made into the samples' },
  }).then((r) => {
    expect(r, 200)
    doc = r.body.data
  })
  await act('CANCEL', 'Review check complete')

  // ── A QC that fails every colour ────────────────────────────────────────────
  const failing = (await call('POST', '/sampling', {
    clientKey: crypto.randomUUID(),
    title: `Review check all failing ${stamp}`,
    customerId: 'sample-buyer',
    brandId: 'sample-brand',
    owner: 'Test manager',
    brief: 'One colour that fails QC.',
    buyerRef: 'EXAMPLE-REF',
    requiredAt: null,
  })).body.data
  doc = failing
  await act('LINK_STYLE', { styleId: 'sample-style' })
  await act('RELEASE', {
    ...spec,
    colours: [{ colour: 'White', sizes: [{ sizeId: M, qty: 1 }] }],
    measurements: spec.measurements.filter((m) => m.sizeId === M),
  })
  // As the earlier making screen left it: every step recorded whole.
  await db.sampleStage.updateMany({
    where: { roundId: doc.rounds[0].id },
    data: { wholeStep: true, doneQty: 1, rejectedQty: 0, completedAt: new Date() },
  })
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  await act('QC', qc([one('White', [55, 70])], 'Chest far out'))
  const sendFailed = await act('DISPATCH', send([W(M, 1)]), 409)
  check('a QC that fails every colour leaves the round QC failed, with nothing to send', () => {
    assert.equal(doc.rounds[0].state, 'QC_FAILED')
    assert.equal(doc.state, 'QC_FAILED')
    assert.equal(sendFailed.body.code, 'NOT_READY_TO_SEND')
  })
  // Pressed and measured again: it passes.
  await act('QC', qc([one('White', [50, 70])], 'Pressed and measured again'))
  check('a failed QC is recorded again once put right', () => assert.equal(doc.rounds[0].state, 'QC_PASSED'))
  await act('CANCEL', 'Review check complete')

  // ── Nothing finished: the inspection records it, and the round fails QC ──────
  doc = (await call('POST', '/sampling', {
    clientKey: crypto.randomUUID(),
    title: `Review check nothing finished ${stamp}`,
    customerId: 'sample-buyer',
    brandId: 'sample-brand',
    owner: 'Test manager',
    brief: 'Every piece rejected in making.',
    buyerRef: 'EXAMPLE-REF',
    requiredAt: null,
  })).body.data
  await act('LINK_STYLE', { styleId: 'sample-style' })
  await act('RELEASE', {
    ...spec,
    colours: [{ colour: 'White', sizes: [{ sizeId: M, qty: 1 }] }],
    measurements: spec.measurements.filter((m) => m.sizeId === M),
  })
  await db.sampleStage.updateMany({
    where: { roundId: doc.rounds[0].id },
    data: { wholeStep: true, doneQty: 0, rejectedQty: 1, completedAt: new Date() },
  })
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  await act('QC', qc([], 'Every piece rejected in making'))
  check('with nothing finished, QC records it and the round fails QC', () => {
    assert.equal(doc.rounds[0].state, 'QC_FAILED')
    assert.deepEqual(status(), { White: 'NOT_FINISHED' })
  })
  await act('CANCEL', 'Review check complete')

  console.log(`\n${passed} review checks passed on local lderp_sampling. Shared database never accessed.`)
}
main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    if (restoreStyle) await db.style.update({ where: { id: 'sample-style' }, data: { colors: { set: restoreStyle } } })
    if (server) await new Promise((resolve) => server.close(resolve))
    await db.$disconnect()
    fs.rmSync(fileRoot, { recursive: true, force: true })
  })
