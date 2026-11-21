// Sampling phase 7: what a sample cost — material at what the request paid, labour and outside
// charges, other charges and couriers, finalising the costs and reopening them, and who sees them.
// HTTP + real PostgreSQL checks on the local pilot only. No .env loading.
const assert = require('node:assert/strict')
process.env.DATABASE_URL ||= 'postgresql://postgres@127.0.0.1:55439/lderp_sampling?schema=ld_erp'
const target = new URL(process.env.DATABASE_URL)
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/lderp_sampling')
  throw Error('Cost checks require local lderp_sampling')
process.env.DIRECT_URL = process.env.DATABASE_URL
process.env.SAMPLING_ENABLED = 'true'
process.env.NODE_ENV = 'test'
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
process.env.STORAGE_DRIVER = 'local'
process.env.LOCAL_STORAGE_SECRET = 'check-cost-only-' + nodeCrypto.randomBytes(24).toString('hex')
const checkFiles = path.join(__dirname, '..', '.local-sampling', 'check-files-cost')
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
  const M = 'sample-size-M'
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
  // White M ×2, 2.5 m of fabric a piece: 5 m.
  const spec = {
    milestone: 'Fit sample',
    styleId: 'sample-style',
    construction: 'Straight seam.',
    techPackRef: 'EXAMPLE-TECH-v1',
    patternRef: 'EXAMPLE-PATTERN-v1',
    colours: [{ colour: 'White', sizes: [{ sizeId: M, qty: 2 }] }],
    measurements: [{ name: 'Chest', sizeId: M, target: 50, tolerance: 0.5, unit: 'cm' }],
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
    notes: 'Fictional cost check',
  }
  const newRequest = async (title) =>
    (
      await call('POST', '/sampling', {
        clientKey: crypto.randomUUID(),
        title: `${title} ${stamp}`,
        customerId: 'sample-buyer',
        brandId: 'sample-brand',
        owner: 'Test manager',
        brief: 'Two sample shirts, costed.',
        buyerRef: 'EXAMPLE-REF',
        requiredAt: null,
      })
    ).body.data
  let doc = await newRequest('Cost check')
  const act = async (action, data = {}, status = 200, perms, roundId = doc.rounds[0].id) => {
    const r = await call('POST', `/sampling/${doc.id}/actions`, { version: doc.version, roundId, action, data }, perms)
    expect(r, status)
    if (status === 200) doc = r.body.data
    return r
  }
  await act('LINK_STYLE', { styleId: 'sample-style' })
  await act('RELEASE', spec)
  // Bought at ₹100 less 10%: ₹90 a metre to the request, whatever the store carries it at.
  // Six metres for the five needed (the mill's minimum): one is left in the sample store.
  const fabric = doc.rounds[0].materials[0]
  const po = await call('POST', '/purchase/orders', {
    supplierId: 'sample-fabric-mill',
    poType: 'ITEM_LEVEL',
    deliveryWarehouseId: SAMPLE_STORE,
    lines: [
      {
        itemId: 'sample-fabric',
        qty: 6,
        unitRate: 100,
        discount: 10,
        gstRate: 5,
        sampleMaterialId: fabric.id,
        sampleOverReason: 'Mill minimum',
      },
    ],
  })
  expect(po, 201)
  expect(await call('PATCH', `/purchase/orders/${po.body.data.id}/send`), 200)
  expect(
    await call('POST', '/purchase/grn', {
      poId: po.body.data.id,
      challanNo: `CH-COST-${stamp}`,
      challanDate: today,
      lines: po.body.data.lines.map((l) => ({ poLineId: l.id, warehouseId: SAMPLE_STORE, receivedQty: +l.qty })),
    }),
    201
  )
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  await act('MATERIAL', { materialId: fabric.id, kind: 'ISSUE', qty: 5, reason: 'For the sample', warehouseId: SAMPLE_STORE })
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
  await act('STEP_LABOUR', { stageId: cut.id, amount: 200, note: 'Cutter' })
  await act('STEP_LABOUR', { stageId: sti.id, amount: 600, note: 'Tailor' })
  // Other charges: testing for the round, the pattern for the whole request.
  const charge = (over) => ({ kind: 'TESTING', description: 'Colour fastness test', amount: 350, billRef: 'LAB-7', ...over })
  const noAmount = await act('ADD_CHARGE', charge({ amount: 0, roundId: doc.rounds[0].id }), 400)
  const badKind = await act('ADD_CHARGE', charge({ kind: 'FREIGHT', roundId: doc.rounds[0].id }), 400)
  await act('ADD_CHARGE', charge({ roundId: doc.rounds[0].id }))
  await act('ADD_CHARGE', charge({ kind: 'PATTERN', description: 'Pattern made by CAD', amount: 500, billRef: '' }))
  const testing = doc.charges.find((c) => c.kind === 'TESTING')
  await act('QC', { notes: 'Inspected', colours: [{ colour: 'White', actuals: [50], cells: [{ sizeId: M, passed: 2 }] }] })
  await act('DISPATCH', {
    cells: [{ colour: 'White', sizeId: M, qty: 2 }],
    recipient: 'Example Buyer',
    mode: 'COURIER',
    courier: 'Example Courier',
    awb: 'AWB-C1',
    courierCharge: 120,
  })
  check('charges are kept with their kind and amount, a round’s or the request’s', () => {
    assert.equal(noAmount.status, 400)
    assert.equal(badKind.status, 400)
    assert.deepEqual(
      doc.charges.map((c) => [c.kind, +c.amount, !!c.roundId]),
      [
        ['TESTING', 350, true],
        ['PATTERN', 500, false],
      ]
    )
  })

  // ── The cost sheet ──────────────────────────────────────────────────────────
  const held = await act('FINALISE_COST', { notes: 'Too early' }, 409)
  await act('MATERIAL', { materialId: fabric.id, kind: 'USE', qty: 4.5, reason: 'Cut into the pieces' })
  await act('MATERIAL', { materialId: fabric.id, kind: 'WASTE', qty: 0.5, reason: 'Cutting waste' })
  // The metre left over: kept for a next round until the buyer decides, closed out before the costs are final.
  const leftover = await act('FINALISE_COST', { notes: 'Too early' }, 409)
  const notSettled = await act(
    'CLOSE_MATERIAL',
    { itemId: 'sample-fabric', warehouseId: SAMPLE_STORE, qty: 1, kind: 'MOVED', toWarehouseId: GENERAL_STORE, reason: 'Good for bulk' },
    409
  )
  const sheet = await call('GET', `/sampling/${doc.id}/cost`)
  const notApprover = await call('GET', `/sampling/${doc.id}/cost`, undefined, 'sampling:view,sampling:edit')
  check('the sheet costs material at what the request paid, labour by step, charges and couriers', () => {
    assert.equal(held.body.code, 'MATERIAL_HELD')
    expect(sheet, 200)
    const s = sheet.body.data.live
    const r = s.rounds[0]
    assert.deepEqual(
      r.materials.map((m) => [m.item.name, m.consumed, m.rate, m.basis, m.amount]),
      [['Example Cotton', 5, 90, 'PURCHASE', 450]]
    )
    assert.deepEqual(r.labourLines.map((l) => [l.kind, l.amount]), [
      ['LABOUR', 200],
      ['LABOUR', 600],
    ])
    assert.deepEqual(r.miscLines.map((l) => [l.kind, l.amount, l.fromChallan]), [
      ['TESTING', 350, false],
      ['COURIER', 120, true],
    ])
    assert.deepEqual([r.material, r.labour, r.misc, r.total, r.pieces, r.perPiece], [450, 800, 470, 1720, 2, 860])
    assert.deepEqual(s.requestCharges.map((c) => [c.kind, c.amount]), [['PATTERN', 500]])
    assert.deepEqual([s.material, s.labour, s.misc, s.total, s.pieces, s.perPiece], [450, 800, 970, 2220, 2, 1110])
    assert.equal(sheet.body.data.finalised, null)
    assert.equal(notApprover.status, 403)
    assert.deepEqual(s.notCosted, [{ item: 'Example Cotton', qty: 1, unit: 'mtr' }])
  })
  await act('DECIDE', {
    buyerName: 'Example buyer',
    evidence: 'EXAMPLE-EMAIL',
    colours: [{ colour: 'White', result: 'APPROVED', conditions: '' }],
  })
  // Moved to a general store at what it is carried at: not a cost of the sample.
  await act('CLOSE_MATERIAL', {
    itemId: 'sample-fabric',
    warehouseId: SAMPLE_STORE,
    qty: 1,
    kind: 'MOVED',
    toWarehouseId: GENERAL_STORE,
    reason: 'Good for bulk',
  })
  check('the costs are finalised only once what is left in the sample store is closed out', () => {
    assert.equal(leftover.body.code, 'LEFTOVERS')
    assert.match(leftover.body.message, /1 mtr of Example Cotton/)
    assert.equal(notSettled.body.code, 'NOT_SETTLED')
  })

  // ── Finalised: nothing that costs changes until reopened ────────────────────
  await act('FINALISE_COST', { notes: 'Sent with the samples' })
  const lockedLabour = await act('STEP_LABOUR', { stageId: cut.id, amount: 250 }, 409)
  const lockedCharge = await act('ADD_CHARGE', charge({ amount: 10 }), 409)
  const lockedCourier = await act('DISPATCH_CHARGE', { dispatchId: doc.rounds[0].dispatches[0].id, courierCharge: 150 }, 409)
  const lockedUndo = await act(
    'MAKING_UNDO',
    { kind: 'WORK', id: doc.rounds[0].works.at(-1).id, reason: 'Testing the cost lock' },
    409
  )
  const again = await act('FINALISE_COST', {}, 409)
  // A challan whose courier charge is on the sheet is not cancelled under it.
  const lockedCancel = await act(
    'DISPATCH_CANCEL',
    { dispatchId: doc.rounds[0].dispatches[0].id, reason: 'Testing the cost lock' },
    409
  )
  const finalised = (await call('GET', `/sampling/${doc.id}/cost`)).body.data.finalised
  const viewOnly = await call('GET', `/sampling/${doc.id}`, undefined, 'sampling:view')
  const editor = await call('GET', `/sampling/${doc.id}`, undefined, 'sampling:view,sampling:edit')
  check('finalised costs are kept as they stood and lock everything that costs', () => {
    for (const r of [lockedLabour, lockedCharge, lockedCourier, lockedUndo, lockedCancel])
      assert.equal(r.body.code, 'COST_FINAL')
    assert.equal(again.body.code, 'COST_FINAL')
    assert.equal(finalised.sheet.total, 2220)
    assert.equal(finalised.sheet.notes, 'Sent with the samples')
    assert.equal(finalised.by, 'Test manager')
    assert.ok(doc.costFinalisedAt)
    // The sheet is for approvers and accounts; the charges' amounts for those who record them.
    assert.equal(viewOnly.body.data.costSheet, null)
    assert.equal(editor.body.data.costSheet, null)
    assert.equal(+editor.body.data.charges[0].amount, 350)
    assert.equal('amount' in viewOnly.body.data.charges[0], false)
    const fin = viewOnly.body.data.events.find((e) => e.action === 'FINALISE_COST')
    assert.equal(fin.detail.data.total, undefined)
  })
  const printed = await call('GET', `/sampling/${doc.id}/cost/print?kind=charges`)
  const sheetPrint = await call('GET', `/sampling/${doc.id}/cost/print`)
  const printViewer = await call('GET', `/sampling/${doc.id}/cost/print?kind=charges`, undefined, 'sampling:view')
  check('the buyer’s statement and the cost sheet print from the finalised sheet', () => {
    expect(printed, 200)
    assert.equal(printed.body.data.template.title, 'SAMPLE CHARGES')
    assert.equal(printed.body.data.sheet.total, 2220)
    assert.ok(printed.body.data.finalised)
    assert.equal(sheetPrint.body.data.template.title, 'SAMPLE COST SHEET')
    assert.equal(printViewer.status, 403)
  })

  // ── Reopened: the courier's bill came, and the test is put on another round ─
  const noReason = await act('REOPEN_COST', { reason: '' }, 400)
  const notApproverReopen = await act('REOPEN_COST', { reason: 'Courier bill' }, 403, 'sampling:view,sampling:edit')
  await act('REOPEN_COST', { reason: 'Courier bill came' })
  await act('DISPATCH_CHARGE', { dispatchId: doc.rounds[0].dispatches[0].id, courierCharge: 150, reason: 'Bill came' })
  const removeShort = await act('REMOVE_CHARGE', { chargeId: testing.id, reason: '' }, 400)
  await act('REMOVE_CHARGE', { chargeId: testing.id, reason: 'Billed to the buyer directly' })
  const live = (await call('GET', `/sampling/${doc.id}/cost`)).body.data
  check('reopened costs change again; a removed charge counts for nothing', () => {
    assert.equal(noReason.status, 400)
    assert.equal(notApproverReopen.status, 403)
    assert.equal(live.finalised, null)
    assert.equal(doc.costFinalisedAt, null)
    assert.deepEqual([live.live.misc, live.live.total, live.live.perPiece], [650, 1900, 950])
    assert.ok(doc.charges.find((c) => c.id === testing.id).removedAt)
  })
  // Cancelled: its costs are still recorded and finalised as it stopped.
  await act('CANCEL', 'Buyer dropped the style')
  await act('ADD_CHARGE', charge({ kind: 'OTHER', description: 'Late courier bill', amount: 80 }))
  await act('FINALISE_COST', { notes: 'As it stopped' })
  check('a cancelled request still takes its late bills, and its costs are finalised as it stopped', () => {
    assert.ok(doc.cancelledAt)
    assert.ok(doc.costFinalisedAt)
    assert.equal(doc.events[0].action, 'FINALISE_COST')
    assert.equal(doc.events[0].detail.data.total, 1980)
  })

  console.log(`\n${passed} cost checks passed on local lderp_sampling. Shared database never accessed.`)
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
