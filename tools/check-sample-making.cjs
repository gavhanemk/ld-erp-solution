// Sampling phase 5: making a sample colour by colour and size by size — work at each step,
// hand-ons between steps, an outside unit's job work on a JW challan, labour, and taking a
// record back. HTTP + real PostgreSQL checks on the local pilot only. No .env loading.
const assert = require('node:assert/strict')
process.env.DATABASE_URL ||= 'postgresql://postgres@127.0.0.1:55439/lderp_sampling?schema=ld_erp'
const target = new URL(process.env.DATABASE_URL)
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/lderp_sampling')
  throw Error('Making checks require local lderp_sampling')
process.env.DIRECT_URL = process.env.DATABASE_URL
process.env.SAMPLING_ENABLED = 'true'
process.env.NODE_ENV = 'test'
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
process.env.STORAGE_DRIVER = 'local'
process.env.LOCAL_STORAGE_SECRET = 'check-making-only-' + nodeCrypto.randomBytes(24).toString('hex')
const checkFiles = path.join(__dirname, '..', '.local-sampling', 'check-files-making')
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

async function main() {
  const [{ db: dbName }] = await db.$queryRaw`SELECT current_database() AS db`
  assert.equal(dbName, 'lderp_sampling')
  const api = express()
  api.use(express.json())
  api.use((req, res, next) => {
    req.user = { id: 'sample-user', name: 'Test manager', role: 'Admin', roleId: 'local', email: 'sampler@example.com' }
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
  api.use((err, req, res, next) =>
    res.status(err.statusCode ?? (err instanceof ZodError ? 400 : 500)).json({ message: err.message, code: err.code })
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
  const stamp = Date.now()
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
  let paper = 0

  const opOf = Object.fromEntries(
    (await db.operation.findMany({ where: { code: { in: ['EX-CUT', 'OP-STI', 'OP-EMB', 'OP-FIN'] } } })).map((o) => [o.code, o])
  )
  // A second process in the stitching department, so a hand-on from stitching to it stays
  // in one department. Put out of use at the end.
  const pressOp = await db.operation.create({
    data: {
      code: 'EX-PRESS-' + stamp,
      name: 'Press and fold ' + stamp,
      kind: 'FINISHING',
      defaultExecution: 'IN_HOUSE',
      departmentId: opOf['OP-STI'].departmentId,
      sortOrder: 991,
    },
  })
  const step = (op, extra = {}) => ({
    operationId: op.id,
    name: '',
    kind: op.kind,
    departmentId: '',
    execution: 'IN_HOUSE',
    contractorId: null,
    vendorId: null,
    instructions: '',
    ...extra,
  })
  const fabricLine = {
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
  }
  // White M ×2, White L ×1, Blue M ×1: four pieces, 10 m of fabric.
  const grid = [
    {
      colour: 'White',
      sizes: [
        { sizeId: 'sample-size-M', qty: 2 },
        { sizeId: 'sample-size-L', qty: 1 },
      ],
    },
    { colour: 'Blue', sizes: [{ sizeId: 'sample-size-M', qty: 1 }] },
  ]
  const spec = {
    milestone: 'Fit sample',
    styleId: 'sample-style',
    construction: 'Straight seam.',
    techPackRef: 'EXAMPLE-TECH-v1',
    patternRef: 'EXAMPLE-PATTERN-v1',
    colours: grid,
    measurements: ['sample-size-M', 'sample-size-L'].map((sizeId) => ({
      name: 'Chest',
      sizeId,
      target: 50,
      tolerance: 0.5,
      unit: 'cm',
    })),
    route: [
      step(opOf['EX-CUT']),
      step(opOf['OP-EMB'], { execution: 'OUTSOURCED', vendorId: 'sample-embroidery-unit' }),
      step(opOf['OP-STI'], { contractorId: 'sample-tailor' }),
      step(pressOp),
    ],
    materials: [fabricLine],
    notes: 'Fictional making check',
  }
  const newRequest = async (title) =>
    (
      await call('POST', '/sampling', {
        clientKey: crypto.randomUUID(),
        title: `${title} ${stamp}`,
        customerId: 'sample-buyer',
        brandId: 'sample-brand',
        owner: 'Test manager',
        brief: 'Sample shirts made step by step.',
        buyerRef: 'EXAMPLE-REF',
        requiredAt: null,
      })
    ).body.data
  let doc = await newRequest('Making check')
  const act = async (action, data = {}, status = 200, perms, roundId = doc.rounds[0].id) => {
    const r = await call('POST', `/sampling/${doc.id}/actions`, { version: doc.version, roundId, action, data }, perms)
    expect(r, status)
    if (status === 200) doc = r.body.data
    return r
  }
  /** Buys and receives the line's need into the sample store, then issues it. */
  const buyAndIssue = async (line, qty) => {
    const po = await call('POST', '/purchase/orders', {
      supplierId: 'sample-fabric-mill',
      poType: 'NONE',
      deliveryWarehouseId: SAMPLE_STORE,
      lines: [{ itemId: line.itemId, qty, unitRate: 100, gstRate: 5, sampleMaterialId: line.id }],
    })
    expect(po, 201)
    expect(await call('PATCH', `/purchase/orders/${po.body.data.id}/send`), 200)
    expect(
      await call('POST', '/purchase/grn', {
        poId: po.body.data.id,
        challanNo: `CH-MAKE-${stamp}-${++paper}`,
        challanDate: today,
        lines: po.body.data.lines.map((l) => ({ poLineId: l.id, warehouseId: SAMPLE_STORE, receivedQty: +l.qty })),
      }),
      201
    )
    doc = (await call('GET', `/sampling/${doc.id}`)).body.data
    await act('MATERIAL', { materialId: line.id, kind: 'ISSUE', qty, reason: 'For the sample', warehouseId: SAMPLE_STORE })
  }
  const stages = () => doc.rounds[0].stages
  const steps = () => makingLedger(doc.rounds[0])
  const cellOf = (stepIndex, colour, sizeId) =>
    steps()[stepIndex].cells.find((c) => c.colour === colour && c.sizeId === sizeId)
  const M = 'sample-size-M',
    L = 'sample-size-L'

  await act('LINK_STYLE', { styleId: 'sample-style' })
  await act('RELEASE', spec)
  const [cut, emb, sti, press] = stages()
  check('the released route keeps its outside step and unit', () => {
    assert.deepEqual(
      stages().map((s) => [s.execution, s.wholeStep, +s.labourAmount]),
      [
        ['IN_HOUSE', false, 0],
        ['OUTSOURCED', false, 0],
        ['IN_HOUSE', false, 0],
        ['IN_HOUSE', false, 0],
      ]
    )
    assert.equal(emb.vendorId, 'sample-embroidery-unit')
    assert.equal(sti.departmentId, press.departmentId)
  })

  // ── Cutting, cell by cell ───────────────────────────────────────────────────
  const work = (stage, cells, extra = {}) => ({ stageId: stage.id, cells, doneBy: 'Ramesh', notes: '', ...extra })
  const notIssued = await act('STEP_WORK', work(cut, [{ colour: 'White', sizeId: M, done: 2, rejected: 0 }]), 409)
  check('making starts once the material is issued', () => assert.equal(notIssued.body.code, 'MATERIAL_NOT_ISSUED'))
  await buyAndIssue(doc.rounds[0].materials[0], 10)
  const nothingThere = await act('STEP_WORK', work(sti, [{ colour: 'White', sizeId: M, done: 1, rejected: 0 }]), 409)
  const outside = await act('STEP_WORK', work(emb, [{ colour: 'White', sizeId: M, done: 1, rejected: 0 }]), 409)
  const notInGrid = await act('STEP_WORK', work(cut, [{ colour: 'Red', sizeId: M, done: 1, rejected: 0 }]), 409)
  const tooMany = await act('STEP_WORK', work(cut, [{ colour: 'White', sizeId: M, done: 3, rejected: 0 }]), 409)
  const noReason = await act(
    'STEP_WORK',
    work(cut, [
      { colour: 'white', sizeId: M, done: 2, rejected: 0 },
      { colour: 'White', sizeId: L, done: 0, rejected: 1 },
    ]),
    409
  )
  const future = await act(
    'STEP_WORK',
    work(cut, [{ colour: 'White', sizeId: M, done: 2, rejected: 0 }], { workedOn: '2099-01-01' }),
    409
  )
  const stale = await call('POST', `/sampling/${doc.id}/actions`, {
    version: doc.version - 1,
    roundId: doc.rounds[0].id,
    action: 'STEP_WORK',
    data: work(cut, [{ colour: 'White', sizeId: M, done: 2, rejected: 0 }]),
  })
  const viewer = await act('STEP_WORK', work(cut, [{ colour: 'White', sizeId: M, done: 2, rejected: 0 }]), 403, 'sampling:view')
  check('work is refused where no pieces are, at an outside step, off the grid, or over what is there', () => {
    assert.equal(nothingThere.body.code, 'NOT_HERE')
    assert.match(nothingThere.body.message, /No White · M pieces are at Stitching/)
    assert.equal(outside.body.code, 'OUTSIDE_STEP')
    assert.equal(notInGrid.body.code, 'NOT_IN_GRID')
    assert.equal(tooMany.body.code, 'NOT_HERE')
    assert.match(tooMany.body.message, /Only 2 of White · M are at Example Cutting|Only 2 of White · M are at/)
    assert.equal(noReason.body.code, 'REASON_REQUIRED')
    assert.equal(future.body.code, 'BAD_DATE')
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'STALE_SAMPLE')
    assert.equal(viewer.status, 403)
  })
  await act(
    'STEP_WORK',
    work(
      cut,
      [
        { colour: 'white', sizeId: M, done: 2, rejected: 0 },
        { colour: 'White', sizeId: L, done: 0, rejected: 1 },
      ],
      { notes: 'Shade band on the L panel', workedOn: today }
    )
  )
  check('cutting records each cell; the step is not done while a cell still waits', () => {
    const w = doc.rounds[0].works[0]
    assert.deepEqual(w.cells, [
      { colour: 'White', sizeId: M, done: 2, rejected: 0 },
      { colour: 'White', sizeId: L, done: 0, rejected: 1 },
    ])
    assert.deepEqual([cellOf(0, 'White', M).ready, cellOf(0, 'White', L).rejected, cellOf(0, 'Blue', M).here], [2, 1, 1])
    assert.deepEqual([stages()[0].doneQty, stages()[0].rejectedQty, stages()[0].completedAt], [2, 1, null])
    assert.equal(doc.events[0].action, 'STEP_WORK')
    assert.equal(doc.events[0].detail.data.stage, cut.name)
  })
  // Once cutting has begun, fabric given back is issued again, not waived: what was cut took it.
  const fabric = doc.rounds[0].materials[0]
  await act('MATERIAL', { materialId: fabric.id, kind: 'RETURN', qty: 1, reason: 'Back to the shelf' })
  const waiveLate = await act('WAIVE_MATERIAL', { materialId: fabric.id, reason: 'Not needed now' }, 409)
  const cutShort = await act('STEP_WORK', work(cut, [{ colour: 'Blue', sizeId: M, done: 1, rejected: 0 }]), 409)
  await act('MATERIAL', { materialId: fabric.id, kind: 'ISSUE', qty: 1, reason: 'Issued again' })
  check('once making starts, material given back is issued again, never waived', () => {
    assert.match(waiveLate.body.message, /before making starts/)
    assert.equal(cutShort.body.code, 'MATERIAL_NOT_ISSUED')
  })

  // ── Embroidery goes out on a job-work challan ───────────────────────────────
  const toEmb = await act('STEP_SEND', { fromStageId: cut.id, cells: [{ colour: 'White', sizeId: M, qty: 2 }], sentBy: 'Ramesh' }, 409)
  const jobSend = (cells, extra = {}) => ({
    stageId: emb.id,
    vendorId: 'sample-embroidery-unit',
    cells,
    sentBy: 'Suresh',
    expectedBack: null,
    ...extra,
  })
  const overSend = await act('JOB_SEND', jobSend([{ colour: 'White', sizeId: M, qty: 3 }]), 409)
  const notOutside = await act('JOB_SEND', { ...jobSend([{ colour: 'White', sizeId: M, qty: 1 }]), stageId: sti.id }, 409)
  const series = await db.numberSeries.findFirst({ where: { docType: 'JW' } })
  await act('JOB_SEND', jobSend([{ colour: 'White', sizeId: M, qty: 2 }], { declaredValue: 500, vehicleNo: 'MH01AB1234' }))
  const firstJob = doc.rounds[0].jobWorks[0]
  check('pieces go to the unit on a challan of the job-work series, no more than are done', () => {
    assert.equal(toEmb.body.code, 'OUTSIDE_STEP')
    assert.equal(overSend.body.code, 'NOT_READY')
    assert.match(overSend.body.message, /Only 2 of White · M are done at/)
    assert.equal(notOutside.body.code, 'NOT_OUTSIDE')
    assert.ok(firstJob.number.startsWith(series.prefix), firstJob.number)
    assert.equal(firstJob.vendor.name, 'Example Embroidery Unit')
    assert.deepEqual([cellOf(0, 'White', M).ready, cellOf(1, 'White', M).atUnit], [0, 2])
    assert.equal(doc.events[0].detail.data.number, firstJob.number)
  })
  const cancelOut = await act('CANCEL', 'Dropped while pieces are out', 409)
  check('a request with pieces still at a unit is not cancelled', () => {
    assert.equal(cancelOut.body.code, 'PIECES_OUT')
    assert.match(cancelOut.body.message, new RegExp(`with Example Embroidery Unit on ${firstJob.number}`))
  })
  // Blue is cut later: cutting is then done; the store cannot issue more once it is.
  await act('STEP_WORK', work(cut, [{ colour: 'Blue', sizeId: M, done: 1, rejected: 0 }]))
  const lateIssue = await act(
    'MATERIAL',
    { materialId: doc.rounds[0].materials[0].id, kind: 'ISSUE', qty: 0.5, reason: 'Late', warehouseId: SAMPLE_STORE },
    409
  )
  check('cutting is done once every cell is accounted for', () => {
    assert.ok(stages()[0].completedAt)
    assert.deepEqual([stages()[0].doneQty, stages()[0].rejectedQty], [3, 1])
    assert.match(lateIssue.body.message, /before making starts/)
  })
  const ret = (job, cells, extra = {}) => ({ jobWorkId: job.id, cells, receivedBy: 'Suresh', chargeAmount: 0, notes: '', ...extra })
  await act('JOB_RETURN', ret(firstJob, [{ colour: 'White', sizeId: M, accepted: 1, rejected: 0 }], { theirChallanNo: 'EMB-77' }))
  const overBack = await act('JOB_RETURN', ret(firstJob, [{ colour: 'White', sizeId: M, accepted: 2, rejected: 0 }]), 409)
  const rejectNoNote = await act('JOB_RETURN', ret(firstJob, [{ colour: 'White', sizeId: M, accepted: 0, rejected: 1 }]), 409)
  await act(
    'JOB_RETURN',
    ret(firstJob, [{ colour: 'White', sizeId: M, accepted: 0, rejected: 1 }], { chargeAmount: 150.5, notes: 'Thread pulled' })
  )
  await act('JOB_SEND', jobSend([{ colour: 'Blue', sizeId: M, qty: 1 }]))
  const secondJob = doc.rounds[0].jobWorks[1]
  await act('JOB_RETURN', ret(secondJob, [{ colour: 'Blue', sizeId: M, accepted: 1, rejected: 0 }], { chargeAmount: 100 }))
  check('what comes back is accepted or rejected against what is out on the challan', () => {
    assert.equal(overBack.body.code, 'NOT_OUT')
    assert.match(overBack.body.message, new RegExp(`Only 1 of White · M is still out on ${firstJob.number}`))
    assert.equal(rejectNoNote.body.code, 'REASON_REQUIRED')
    assert.notEqual(secondJob.number, firstJob.number)
    assert.deepEqual([cellOf(1, 'White', M).done, cellOf(1, 'White', M).rejected, cellOf(1, 'Blue', M).done], [1, 1, 1])
    assert.ok(stages()[1].completedAt, 'embroidery done')
    assert.deepEqual(
      doc.rounds[0].jobWorks[0].returns.map((r) => [+r.chargeAmount, r.theirChallanNo]),
      [
        [0, 'EMB-77'],
        [150.5, null],
      ]
    )
  })
  const undoSent = await act('MAKING_UNDO', { kind: 'JOB_SEND', id: firstJob.id, reason: 'Wrong unit' }, 409)
  check('a challan with pieces back on it is not cancelled', () => assert.equal(undoSent.body.code, 'HAS_RETURNS'))
  // The unit's bill comes later: its charge is put right without touching the pieces.
  const firstBack = doc.rounds[0].jobWorks[0].returns[0]
  await act('JOB_CHARGE', { returnId: firstBack.id, chargeAmount: 75.25, reason: 'Their bill came' })
  const badCharge = await act('JOB_CHARGE', { returnId: 'no-such-receipt', chargeAmount: 1 }, 409)
  check('a unit’s charge is corrected on its own, the pieces as they were', () => {
    assert.equal(+doc.rounds[0].jobWorks[0].returns[0].chargeAmount, 75.25)
    assert.deepEqual(doc.rounds[0].jobWorks[0].returns[0].cells, firstBack.cells)
    assert.deepEqual([doc.events[0].detail.data.was, doc.events[0].detail.data.charge], [0, 75.25])
    assert.equal(badCharge.body.code, 'NOT_FOUND')
  })

  // ── Stitching is another department: what is sent is counted in there ──────
  const send = (from, cells) => ({ fromStageId: from.id, cells, sentBy: 'Suresh' })
  await act('STEP_SEND', send(emb, [{ colour: 'White', sizeId: M, qty: 1 }, { colour: 'Blue', sizeId: M, qty: 1 }]))
  const transfer = doc.rounds[0].transfers[0]
  const notCounted = await act('STEP_WORK', work(sti, [{ colour: 'White', sizeId: M, done: 1, rejected: 0 }]), 409)
  const receive = (t, cells, extra = {}) => ({ transferId: t.id, cells, receivedBy: 'Example Sample Tailor', ...extra })
  const shortNoReason = await act('STEP_RECEIVE', receive(transfer, [{ colour: 'White', sizeId: M, qty: 1 }]), 409)
  check('a hand-on to another department waits to be counted in', () => {
    assert.equal(transfer.receivedOn, null)
    assert.deepEqual([cellOf(2, 'White', M).coming, cellOf(1, 'White', M).ready], [1, 0])
    assert.equal(notCounted.body.code, 'NOT_HERE')
    assert.match(notCounted.body.message, /on the way from Embroidery: count it in first/)
    assert.equal(shortNoReason.body.code, 'REASON_REQUIRED')
  })
  await act('STEP_RECEIVE', receive(transfer, [{ colour: 'White', sizeId: M, qty: 1 }], { shortReason: 'Blue piece mislaid' }))
  check('fewer counted in than sent is short, with the reason', () => {
    const t = doc.rounds[0].transfers[0]
    assert.deepEqual(t.receivedCells, [
      { colour: 'White', sizeId: M, qty: 1 },
      { colour: 'Blue', sizeId: M, qty: 0 },
    ])
    assert.deepEqual([cellOf(2, 'Blue', M).short, cellOf(2, 'White', M).here], [1, 1])
  })
  // Found after all: the count is taken back, and the hand-on with it; sent again, counted in full.
  await act('MAKING_UNDO', { kind: 'TRANSFER', id: transfer.id, reason: 'Blue piece found on the table' })
  check('a hand-on taken back puts its pieces back where they were', () => {
    assert.ok(doc.rounds[0].transfers[0].undoneAt)
    assert.deepEqual([cellOf(1, 'Blue', M).ready, cellOf(2, 'Blue', M).short], [1, 0])
  })
  await act('STEP_SEND', send(emb, [{ colour: 'White', sizeId: M, qty: 1 }, { colour: 'Blue', sizeId: M, qty: 1 }]))
  const second = doc.rounds[0].transfers[1]
  await act('STEP_RECEIVE', receive(second, [{ colour: 'White', sizeId: M, qty: 1 }, { colour: 'Blue', sizeId: M, qty: 1 }]))
  await act('STEP_WORK', work(sti, [{ colour: 'White', sizeId: M, done: 1, rejected: 0 }, { colour: 'Blue', sizeId: M, done: 1, rejected: 0 }]))
  const undoReceived = await act('MAKING_UNDO', { kind: 'TRANSFER', id: second.id, reason: 'Testing a blocked undo' }, 409)
  check('a hand-on whose pieces were worked since is not taken back', () => {
    assert.equal(undoReceived.body.code, 'UNDO_BLOCKED')
    assert.match(undoReceived.body.message, /worked at Stitching since/)
  })

  // ── Pressing is stitching's own department: the hand-on is counted in at once ──
  await act('STEP_SEND', send(sti, [{ colour: 'White', sizeId: M, qty: 1 }, { colour: 'Blue', sizeId: M, qty: 1 }]))
  const sameDept = doc.rounds[0].transfers[2]
  const undoWork = await act('MAKING_UNDO', { kind: 'WORK', id: doc.rounds[0].works.at(-1).id, reason: 'Testing a blocked undo' }, 409)
  check('within one department the pieces arrive with the hand-on', () => {
    assert.ok(sameDept.receivedOn)
    assert.equal(sameDept.receivedBy, 'Suresh')
    assert.equal(cellOf(3, 'White', M).here, 1)
    assert.equal(undoWork.body.code, 'UNDO_BLOCKED')
  })
  // QC (phase 6): each colour read on its finished sizes' points and its pieces passed.
  const bothM = (notes) => ({
    notes,
    colours: ['White', 'Blue'].map((colour) => ({ colour, actuals: [50], cells: [{ sizeId: M, passed: 1 }] })),
  })
  const early = await act('QC', bothM('Too early'), 409)
  await act('STEP_WORK', work(press, [{ colour: 'White', sizeId: M, done: 1, rejected: 0 }, { colour: 'Blue', sizeId: M, done: 1, rejected: 0 }]))
  check('the route is done when the last step has worked every piece that reached it', () => {
    assert.match(early.body.message, /Complete the making route/)
    assert.ok(stages().every((s) => s.completedAt))
    assert.deepEqual(
      stages().map((s) => [s.doneQty, s.rejectedQty]),
      [
        [3, 1],
        [2, 1],
        [2, 0],
        [2, 0],
      ]
    )
    assert.equal(steps()[3].total.ready, 2)
  })

  // ── Labour, and who may see it ───────────────────────────────────────────────
  await act('STEP_LABOUR', { stageId: sti.id, amount: 600, note: 'Tailor, two pieces' })
  const negative = await act('STEP_LABOUR', { stageId: sti.id, amount: -1 }, 400)
  const viewOnly = await call('GET', `/sampling/${doc.id}`, undefined, 'sampling:view')
  const editor = await call('GET', `/sampling/${doc.id}`, undefined, 'sampling:view,sampling:edit')
  check('labour is the step’s, shown to those who record it, not to viewers', () => {
    assert.equal(+stages()[2].labourAmount, 600)
    assert.equal(negative.status, 400)
    assert.equal('labourAmount' in viewOnly.body.data.rounds[0].stages[2], false)
    assert.equal('chargeAmount' in viewOnly.body.data.rounds[0].jobWorks[0].returns[1], false)
    assert.equal(+editor.body.data.rounds[0].stages[2].labourAmount, 600)
    assert.equal(+editor.body.data.rounds[0].jobWorks[0].returns[1].chargeAmount, 150.5)
    // Nor in the history: the labour event says the step, not the money or who was paid.
    const seen = (r, action) => r.body.data.events.find((e) => e.action === action).detail.data
    assert.deepEqual(
      [seen(viewOnly, 'STEP_LABOUR').amount, seen(viewOnly, 'STEP_LABOUR').note, seen(viewOnly, 'JOB_CHARGE').charge],
      [undefined, undefined, undefined]
    )
    assert.deepEqual([seen(editor, 'STEP_LABOUR').amount, seen(editor, 'STEP_LABOUR').note], [600, 'Tailor, two pieces'])
  })

  // ── The challan prints ──────────────────────────────────────────────────────
  const printed = await call('GET', `/sampling/job-work/${firstJob.id}/print`)
  check('the job-work challan prints with the unit, the pieces and what came back', () => {
    expect(printed, 200)
    const p = printed.body.data
    assert.equal(p.job.number, firstJob.number)
    assert.equal(p.job.vendor.gstin, '27EXEMB0001A1Z4')
    assert.deepEqual(p.job.cells, [{ colour: 'White', sizeId: M, qty: 2 }])
    assert.equal(p.job.returns.length, 2)
    assert.equal(+p.job.declaredValue, 500)
    assert.equal(p.job.round.request.number, doc.number)
    assert.ok(p.template.title)
  })

  // ── QC closes making ────────────────────────────────────────────────────────
  await act('QC', bothM('Both made pieces inspected'))
  const afterQc = await act('STEP_WORK', work(press, [{ colour: 'White', sizeId: M, done: 1, rejected: 0 }]), 409)
  const undoAfterQc = await act('MAKING_UNDO', { kind: 'WORK', id: doc.rounds[0].works.at(-1).id, reason: 'After QC' }, 409)
  await act('STEP_LABOUR', { stageId: press.id, amount: 120 })
  check('after QC nothing more is made, but labour can still be put in', () => {
    assert.equal(afterQc.body.code, 'MAKING_CLOSED')
    assert.equal(undoAfterQc.body.code, 'MAKING_CLOSED')
    assert.equal(+stages()[3].labourAmount, 120)
    assert.equal(doc.rounds[0].state, 'QC_PASSED')
  })
  // The fabric went into the pieces; the request is closed so the pilot's register stays tidy.
  await act('MATERIAL', { materialId: doc.rounds[0].materials[0].id, kind: 'USE', qty: 10, reason: 'Made into the sample' })
  await act('CANCEL', 'Making check complete')

  // ── A step recorded whole before this, and the step after it ─────────────────
  doc = await newRequest('Making whole-step check')
  await act('LINK_STYLE', { styleId: 'sample-style' })
  await act('RELEASE', {
    ...spec,
    colours: [{ colour: 'White', sizes: [{ sizeId: M, qty: 2 }] }],
    measurements: [spec.measurements[0]],
    route: [step(opOf['EX-CUT']), step(opOf['OP-STI']), step(opOf['OP-FIN'])],
  })
  await buyAndIssue(doc.rounds[0].materials[0], 5)
  // As the earlier making screen left it: the step's figures, no cell records.
  await db.sampleStage.update({
    where: { id: stages()[0].id },
    data: { wholeStep: true, doneQty: 2, rejectedQty: 0, completedAt: new Date(), responsible: 'Cutter' },
  })
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  const onWhole = await act('STEP_WORK', work(stages()[0], [{ colour: 'White', sizeId: M, done: 1, rejected: 0 }]), 409)
  await act('STEP_WORK', work(stages()[1], [{ colour: 'White', sizeId: M, done: 1, rejected: 1 }], { notes: 'Open seam' }))
  check('a step recorded whole hands its pieces on to the next', () => {
    assert.match(onWhole.body.message, /recorded whole/)
    assert.deepEqual([steps()[0].total.done, steps()[0].total.ready, steps()[1].total.received], [2, 0, 2])
    assert.deepEqual([stages()[0].doneQty, stages()[1].doneQty, stages()[1].rejectedQty], [2, 1, 1])
    assert.ok(stages()[0].completedAt)
  })
  // Recorded whole with every piece rejected: the steps after it have nothing to record, and QC
  // reads them as done (it is refused for the pieces, not for the route).
  await db.sampleStage.update({ where: { id: stages()[1].id }, data: { wholeStep: false } })
  await db.sampleWork.updateMany({ where: { roundId: doc.rounds[0].id }, data: { undoneAt: new Date(), undoneBy: 'check', undoneReason: 'Reset for the check' } })
  await db.sampleStage.update({
    where: { id: stages()[0].id },
    data: { doneQty: 0, rejectedQty: 2 },
  })
  await db.sampleStage.updateMany({
    where: { id: { in: [stages()[1].id, stages()[2].id] } },
    data: { doneQty: null, rejectedQty: null, completedAt: null },
  })
  doc = (await call('GET', `/sampling/${doc.id}`)).body.data
  const nothingMade = await act(
    'QC',
    { notes: 'Nothing to inspect', colours: [{ colour: 'White', actuals: [50], cells: [{ sizeId: M, passed: 1 }] }] },
    409
  )
  check('steps after a whole step that rejected everything count as done', () => {
    assert.deepEqual(steps().map((s) => s.complete), [true, true, true])
    assert.match(nothingMade.body.message, /White has no finished pieces to inspect/)
  })
  await act('MATERIAL', { materialId: doc.rounds[0].materials[0].id, kind: 'USE', qty: 5, reason: 'Made into the sample' })
  await act('CANCEL', 'Whole-step check complete')

  await db.operation.update({ where: { id: pressOp.id }, data: { isActive: false } })
  console.log(`\n${passed} making checks passed on local lderp_sampling. Shared database never accessed.`)
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
