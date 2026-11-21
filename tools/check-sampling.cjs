// HTTP + real PostgreSQL regression checks. No .env loading or shared data.
const assert = require('node:assert/strict')
process.env.DATABASE_URL ||= 'postgresql://postgres@127.0.0.1:55439/lderp_sampling?schema=ld_erp'
const target = new URL(process.env.DATABASE_URL)
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/lderp_sampling')
  throw Error('Sampling checks require local lderp_sampling')
process.env.DIRECT_URL = process.env.DATABASE_URL
process.env.SAMPLING_ENABLED = 'true'
process.env.NODE_ENV = 'test'
// Sample files go to a fresh folder under .local-sampling/check-files-sampling,
// removed at the end, through the pilot's local-disk driver. The links are
// signed with a key made for this run only; LOCAL_STORAGE_BASE_URL is set once
// the server below knows its port. Nothing can reach cloud storage.
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
process.env.STORAGE_DRIVER = 'local'
process.env.LOCAL_STORAGE_SECRET =
  'check-sampling-only-' + nodeCrypto.randomBytes(24).toString('hex')
const checkFiles = path.join(__dirname, '..', '.local-sampling', 'check-files-sampling')
fs.mkdirSync(checkFiles, { recursive: true })
const fileRoot = fs.mkdtempSync(path.join(checkFiles, 'run-'))
process.env.LOCAL_STORAGE_DIR = fileRoot
require('./register-ts.cjs')
require('express-async-errors')
const express = require('express')
const { prisma: db } = require('../packages/database/src/index.ts')
const routes = require('../apps/api/src/routes/sampling.routes.ts').default
const localFiles = require('../apps/api/src/routes/localFiles.routes.ts').default
const masters = require('../apps/api/src/routes/master.routes.ts').default
const quotations = require('../apps/api/src/routes/quotation.routes.ts').default
const purchase = require('../apps/api/src/routes/purchase.routes.ts').default
const { makingLedger } = require('../packages/shared/src/sampleMaking.ts')
const { colourOutcomes, pointsFor } = require('../packages/shared/src/sampleReview.ts')
const { ZodError } = require('zod')
let passed = 0,
  server
const check = (label, fn) => {
  fn()
  passed++
  console.log('PASS ' + label)
}
async function main() {
  const [{ db: dbName }] = await db.$queryRaw`SELECT current_database() AS db`
  assert.equal(dbName, 'lderp_sampling')
  const api = express()
  // Ahead of the JSON parser, as in index.ts: a file is stored as the bytes sent.
  api.use('/api/local-files', localFiles)
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
  api.use('/sampling', routes)
  api.use('/masters', masters)
  api.use('/quotations', quotations)
  api.use('/purchase', purchase)
  api.use((err, req, res, next) =>
    res
      .status(err.statusCode ?? (err instanceof ZodError ? 400 : 500))
      .json({ message: err.message, code: err.code })
  )
  server = api.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const base = `${origin}/sampling`
  process.env.LOCAL_STORAGE_BASE_URL = `${origin}/api/local-files`
  const call = async (method, path = '', body, perms) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(perms !== undefined ? { 'x-permissions': perms } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: r.status, body: await r.json() }
  }
  const title = 'Local sampling regression ' + Date.now(),
    payload = {
      clientKey: crypto.randomUUID(),
      title,
      customerId: 'sample-buyer',
      brandId: 'sample-brand',
      owner: 'Test manager',
      brief: 'Two white sample shirts; buyer review before bulk.',
      buyerRef: 'EXAMPLE-REF',
      requiredAt: null,
    }
  let r = await call('POST', '', payload, 'sampling:view')
  check('create requires its own permission', () => assert.equal(r.status, 403))
  const originalEnv = process.env.DIRECT_URL
  process.env.DIRECT_URL = 'postgresql://blocked.invalid/shared'
  r = await call('GET')
  check('pilot refuses a non-local direct database URL before querying', () =>
    assert.equal(r.status, 404)
  )
  process.env.DIRECT_URL = originalEnv
  process.env.NODE_ENV = 'production'
  r = await call('GET')
  check('pilot disabled in production', () => assert.equal(r.status, 404))
  process.env.NODE_ENV = 'test'
  r = await call('POST', '', payload)
  check('create request and initial draft', () => assert.equal(r.status, 201))
  let doc = r.body.data
  const created = doc
  r = await call('POST', '', payload)
  check('repeated create keeps the same request', () => assert.equal(r.body.data.id, created.id))
  // The pilot's processes, for making routes. A step names its process; the
  // server fills in its name, kind and department.
  const opOf = Object.fromEntries(
    (
      await db.operation.findMany({
        where: { code: { in: ['EX-CUT', 'OP-STI', 'OP-EMB', 'OP-WSH', 'OP-FIN', 'OP-QC'] } },
      })
    ).map((o) => [o.code, o])
  )
  const step = (code, extra = {}) => ({
    operationId: opOf[code].id,
    name: '',
    kind: opOf[code].kind,
    departmentId: '',
    execution: 'IN_HOUSE',
    contractorId: null,
    vendorId: null,
    instructions: '',
    ...extra,
  })
  /** A sample BOM line: 2.5 m of the example cotton a piece, for every colour, bought by us. */
  const line = (extra = {}) => ({
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
    construction: 'Straight seam, inspect workmanship.',
    techPackRef: 'EXAMPLE-TECH-v1',
    patternRef: 'EXAMPLE-PATTERN-v1',
    colours: [{ colour: 'White', sizes: [{ sizeId: 'sample-size-M', qty: 2 }] }],
    measurements: [
      { name: 'Chest', sizeId: 'sample-size-M', target: 50, tolerance: 0.5, unit: 'cm' },
    ],
    route: [step('EX-CUT'), step('OP-STI'), step('OP-FIN')],
    // Two pieces at 2.5 m: 5 m planned.
    materials: [line()],
    notes: 'Fictional local test only',
  }
  // A sample's material is bought for it and issued from the sample store (phase 4).
  const store = 'sample-room-store'
  const generalStore = 'sample-store'
  /** Any route of the test server, by its full path. */
  const callAt = async (method, url, body) => {
    const r = await fetch(origin + url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: r.status, body: await r.json() }
  }
  let paperNo = 0
  /**
   * Buys what the latest round still needs (its needs, after anything an
   * earlier round left) and receives it into the sample store, at ₹100 a unit:
   * a sample issues only what it bought.
   */
  const stockSample = async () => {
    const needs = (await call('GET', `/needs?requestId=${doc.id}`)).body.data.needs
    if (!needs.length) return
    const po = await callAt('POST', '/purchase/orders', {
      supplierId: 'sample-fabric-mill',
      poType: 'NONE',
      deliveryWarehouseId: store,
      lines: needs.map((n) => ({
        itemId: n.item.id,
        qty: n.toBuy,
        unitRate: 100,
        gstRate: 5,
        sampleMaterialId: n.sampleMaterialId,
      })),
    })
    assert.equal(po.status, 201, JSON.stringify(po.body))
    assert.equal((await callAt('PATCH', `/purchase/orders/${po.body.data.id}/send`)).status, 200)
    const grn = await callAt('POST', '/purchase/grn', {
      poId: po.body.data.id,
      challanNo: `CH-SMP-${Date.now()}-${++paperNo}`,
      challanDate: new Date().toISOString().slice(0, 10),
      lines: po.body.data.lines.map((l) => ({ poLineId: l.id, warehouseId: store, receivedQty: +l.qty })),
    })
    assert.equal(grn.status, 201, JSON.stringify(grn.body))
    doc = (await call('GET', `/${doc.id}`)).body.data
  }
  const action = async (action, data = {}, expected = 200, perms, roundId = doc.rounds[0].id) => {
    const before = doc.version
    const result = await call(
      'POST',
      `/${doc.id}/actions`,
      { version: doc.version, roundId, action, data },
      perms
    )
    assert.equal(result.status, expected, `${action}: ${JSON.stringify(result.body)}`)
    if (expected === 200) doc = result.body.data
    else
      assert.equal((await db.sampleRequest.findUnique({ where: { id: doc.id } })).version, before)
    passed++
    console.log('PASS ' + action + ' ' + (expected === 200 ? 'accepted' : 'refused atomically'))
    return result
  }
  /** A version one behind, as a second window would send it: refused, nothing changed. */
  const staleRefused = async (actionName, data, roundId) => {
    const before = doc.version
    const r = await call('POST', `/${doc.id}/actions`, {
      version: doc.version - 1,
      ...(roundId ? { roundId } : {}),
      action: actionName,
      data,
    })
    assert.equal(r.status, 409, `${actionName}: ${JSON.stringify(r.body)}`)
    assert.equal(r.body.code, 'STALE_SAMPLE')
    assert.equal((await db.sampleRequest.findUnique({ where: { id: doc.id } })).version, before)
    passed++
    console.log('PASS ' + actionName + ' from a stale window refused atomically')
  }
  /**
   * Makes the latest round through its whole route (phase 5): at each step every piece
   * there is done, then handed on to the next and counted in there; an outside step's
   * pieces go to its unit on a challan and all come back accepted.
   */
  /**
   * QC as the inspector records it (phase 6): every colour that finished, every point of
   * the sizes it finished read (at its target unless `read` says otherwise), every
   * finished piece passed.
   */
  const qcData = (read = (m) => m.target, notes = 'Inspected') => {
    const r = doc.rounds[0]
    const last = makingLedger(r).at(-1).cells.filter((c) => c.done > 0)
    return {
      notes,
      colours: [...new Set(last.map((c) => c.colour))].map((colour) => {
        const cells = last.filter((c) => c.colour === colour)
        return {
          colour,
          actuals: pointsFor(r.specification, cells.map((c) => c.sizeId)).map(read),
          cells: cells.map((c) => ({ sizeId: c.sizeId, passed: c.done })),
        }
      }),
    }
  }
  /** A Sample Delivery Challan for whatever passed QC and is not sent yet. */
  const sendAll = (extra = {}) => ({
    cells: colourOutcomes(doc.rounds[0]).flatMap((o) => o.toSend),
    recipient: 'Example buyer',
    mode: 'HAND',
    ...extra,
  })
  /** The buyer's word on every colour that passed QC. */
  const decideAll = (result, conditions = '') => ({
    buyerName: 'Example buyer',
    evidence: 'EXAMPLE-EMAIL',
    colours: colourOutcomes(doc.rounds[0])
      .filter((o) => o.qc === 'PASSED')
      .map((o) => ({ colour: o.colour, result, conditions })),
  })
  const makeAll = async () => {
    const latest = () => doc.rounds[0]
    const ledger = () => makingLedger(latest())
    const cellsOf = (list, pick) =>
      list.filter((c) => pick(c) > 0).map((c) => ({ colour: c.colour, sizeId: c.sizeId, qty: pick(c) }))
    for (let i = 0; i < latest().stages.length; i++) {
      const st = latest().stages[i]
      if (st.execution === 'OUTSOURCED') {
        const out = cellsOf(ledger()[i].cells, (c) => c.toSend)
        if (out.length) {
          await action('JOB_SEND', {
            stageId: st.id,
            vendorId: st.vendorId ?? 'sample-embroidery-unit',
            cells: out,
            sentBy: 'Example operator',
          })
          const job = latest().jobWorks.at(-1)
          await action('JOB_RETURN', {
            jobWorkId: job.id,
            cells: out.map(({ qty, ...c }) => ({ ...c, accepted: qty, rejected: 0 })),
            receivedBy: 'Example operator',
          })
        }
      } else {
        for (const t of latest().transfers.filter((x) => x.toStageId === st.id && !x.receivedOn && !x.undoneAt))
          await action('STEP_RECEIVE', { transferId: t.id, cells: t.cells, receivedBy: 'Example operator' })
        const here = cellsOf(ledger()[i].cells, (c) => c.here)
        if (here.length)
          await action('STEP_WORK', {
            stageId: st.id,
            cells: here.map(({ qty, ...c }) => ({ ...c, done: qty, rejected: 0 })),
            doneBy: 'Example operator',
          })
      }
      const next = latest().stages[i + 1]
      const ready = cellsOf(ledger()[i].cells, (c) => c.ready)
      if (next && next.execution !== 'OUTSOURCED' && ready.length)
        await action('STEP_SEND', { fromStageId: st.id, cells: ready, sentBy: 'Example operator' })
    }
  }
  const template = await call('GET', '/route-template', undefined, 'sampling:view')
  check('a new request starts on the usual route from the Operation master', () => {
    assert.equal(template.status, 200)
    assert.deepEqual(
      template.body.data.map((s) => s.kind),
      ['CUTTING', 'STITCHING', 'FINISHING', 'QC']
    )
    assert.equal(template.body.data[0].operationId, opOf['EX-CUT'].id)
    assert.deepEqual(created.rounds[0].specification.route, template.body.data)
    assert.deepEqual(created.rounds[0].specification.colours, [])
    assert.equal(created.rounds[0].specification.color, undefined)
  })
  await action('RELEASE', {}, 400)
  await action('SAVE_DRAFT', { construction: 'Work in progress' }, 403, 'sampling:view')
  await action('SAVE_DRAFT', {
    milestone: 'Early fit sample',
    construction: 'Work in progress',
    materials: [line({ component: '', itemId: '', qtyPerPiece: 0 })],
  })
  await action('SAVE_DRAFT', { techPackRef: 'Draft document reference' })
  r = await call('GET', `/${doc.id}`)
  check('partial draft persists across reopening without discarding earlier fields', () => {
    assert.equal(r.body.data.rounds[0].specification.construction, 'Work in progress')
    assert.equal(r.body.data.rounds[0].specification.techPackRef, 'Draft document reference')
    assert.equal(r.body.data.rounds[0].specification.materials[0].qtyPerPiece, 0)
    assert.equal(r.body.data.rounds[0].state, 'DRAFT')
  })
  await action('RELEASE', {}, 400)
  check('an incomplete draft keeps its unfinished BOM line as a row, and no making records', () => {
    assert.equal(doc.rounds[0].materials.length, 1)
    assert.equal(doc.rounds[0].materials[0].itemId, null)
    assert.equal(+doc.rounds[0].materials[0].plannedQty, 0)
    assert.equal(doc.rounds[0].materials[0].id, doc.rounds[0].specification.materials[0].id)
    assert.equal(doc.rounds[0].stages.length, 0)
  })
  await action('SAVE_DRAFT', { styleId: 'missing-style' }, 409)
  await action('SAVE_DRAFT', { materials: [line({ itemId: 'missing-item' })] }, 409)
  await action('SAVE_DRAFT', { colours: [{ colour: '', sizes: [{ sizeId: '', qty: -1 }] }] }, 400)
  await action('SAVE_DRAFT', { state: 'APPROVED' }, 400)
  // The shape before the colour grid is not accepted from a screen any more.
  await action('SAVE_DRAFT', { color: 'White' }, 400)
  await staleRefused('SAVE_DRAFT', { notes: 'From a second window' })
  const { clientKey: omittedClientKey, ...requestFields } = payload
  const requestEdit = {
    ...requestFields,
    title: title + ' corrected',
    owner: 'Updated owner',
    requiredAt: '2026-12-01',
    reason: 'Buyer clarified the request',
  }
  await action('UPDATE_REQUEST', { ...requestEdit, reason: '' }, 400)
  await action('UPDATE_REQUEST', requestEdit, 403, 'sampling:view')
  await action('UPDATE_REQUEST', { ...requestEdit, customerId: 'missing-buyer' }, 409)
  await action('UPDATE_REQUEST', { ...requestEdit, customerId: null })
  check('request edit updates details and records before/after values', () => {
    assert.equal(doc.customerId, null)
    assert.equal(doc.title, requestEdit.title)
    assert.equal(doc.requiredAt.slice(0, 10), '2026-12-01')
    assert.equal(doc.events[0].detail.data.before.customerId, 'sample-buyer')
    assert.equal(doc.events[0].detail.data.after.customerId, null)
    assert.equal(doc.events[0].detail.data.reason, requestEdit.reason)
  })
  // No buyer on the request now: material the buyer sends cannot be planned.
  const noBuyer = await action(
    'SAVE_SPEC',
    { ...spec, materials: [line({ source: 'BUYER_SUPPLIED' })] },
    400
  )
  check('material the buyer sends needs a buyer on the request', () => {
    assert.equal(noBuyer.body.code, 'SPEC_INCOMPLETE')
    assert.match(noBuyer.body.message, /buyer on the request/)
  })
  await action('UPDATE_REQUEST', requestEdit)
  const twice = await action(
    'SAVE_SPEC',
    {
      ...spec,
      colours: [{ colour: 'White', sizes: [...spec.colours[0].sizes, ...spec.colours[0].sizes] }],
    },
    400
  )
  const notStyle = await action(
    'SAVE_SPEC',
    { ...spec, colours: [{ ...spec.colours[0], colour: 'Not a style colour' }] },
    409
  )
  check('a size twice in a colour, or a colour the style lacks, is refused', () => {
    assert.match(twice.body.message, /same size twice/)
    assert.equal(notStyle.body.code, 'NOT_STYLE_COLOUR')
  })
  await action('SAVE_SPEC', spec, 403, 'sampling:view')
  await staleRefused('SAVE_SPEC', spec)
  await action('SAVE_SPEC', spec)
  await action('RELEASE', {}, 403, 'sampling:view,sampling:edit')
  await staleRefused('RELEASE', {})
  const released = await action('RELEASE')
  const releasedSpec = doc.rounds[0].specification
  check('release makes each step from its process, and warns of a route with no check', () => {
    assert.deepEqual(
      doc.rounds[0].stages.map((s) => [
        s.sequence,
        s.operationId,
        s.kind,
        s.departmentId,
        s.execution,
      ]),
      ['EX-CUT', 'OP-STI', 'OP-FIN'].map((c, i) => [
        i + 1,
        opOf[c].id,
        opOf[c].kind,
        opOf[c].departmentId,
        'IN_HOUSE',
      ])
    )
    assert.deepEqual(
      doc.rounds[0].stages.map((s) => s.name),
      ['EX-CUT', 'OP-STI', 'OP-FIN'].map((c) => opOf[c].name)
    )
    assert.deepEqual(
      releasedSpec.route.map((s) => s.name),
      ['EX-CUT', 'OP-STI', 'OP-FIN'].map((c) => opOf[c].name)
    )
    assert.ok(released.body.warnings.some((w) => /no quality check/.test(w)))
    assert.equal(+doc.rounds[0].materials[0].plannedQty, 5)
    assert.equal(doc.rounds[0].materials[0].warehouseId, null)
    assert.equal(releasedSpec.materials[0].id, doc.rounds[0].materials[0].id)
  })
  await action('SAVE_DRAFT', { construction: 'Must stay frozen' }, 409)
  await action('UPDATE_REQUEST', { ...requestEdit, customerId: null }, 409)
  await action('UPDATE_REQUEST', { ...requestEdit, brandId: 'different-brand' }, 409)
  await action('UPDATE_REQUEST', {
    ...requestEdit,
    requiredAt: null,
    reason: 'Delivery date to be confirmed',
  })
  check('administrative edits preserve released technical specification', () => {
    assert.equal(doc.requiredAt, null)
    assert.deepEqual(doc.rounds[0].specification, releasedSpec)
  })
  await action('SAVE_SPEC', spec, 409)
  await stockSample()
  let round = doc.rounds[0],
    mat = round.materials[0]
  const cutWhite = (stage, done) => ({
    stageId: stage.id,
    cells: [{ colour: 'White', sizeId: 'sample-size-M', done, rejected: 0 }],
    doneBy: 'Cutter',
  })
  await action('STEP_WORK', cutWhite(round.stages[0], 2), 409)
  const tooMuch = await action(
    'MATERIAL',
    { materialId: mat.id, kind: 'ISSUE', qty: 6, reason: 'Too much', warehouseId: store },
    409
  )
  check('no more is issued than the request bought and holds in the sample store', () => {
    assert.equal(tooMuch.body.code, 'POOL_SHORT')
    assert.match(tooMuch.body.message, /Only 5 mtr of Example Cotton bought for this request is in Example Sample Store/)
    assert.deepEqual(
      doc.pool.stores.map((s) => [s.itemId, s.warehouseId, s.received, s.issued, s.available]),
      [['sample-fabric', store, 5, 0, 5]]
    )
    assert.deepEqual(doc.pool.lines[mat.id], { remaining: 5, fromPool: 5, awaited: 0, toBuy: 0 })
  })
  await action(
    'MATERIAL',
    { materialId: mat.id, kind: 'ISSUE', qty: 5, reason: 'Issue for sample' },
    403,
    'sampling:view'
  )
  // Pilot roles as the fixtures made them, read from the database.
  const grantsOf = async (name) =>
    (
      await db.rolePermission.findMany({
        where: { role: { name } },
        select: { permission: { select: { module: true, action: true } } },
      })
    )
      .map((g) => `${g.permission.module}:${g.permission.action}`)
      .sort()
  const merchGrants = await grantsOf('Merchandiser'),
    storeGrants = await grantsOf('Local Store')
  // A sample store is Sampling's own (phase 4): sampling rights issue from it,
  // so the merchandiser does; the store login, with no sampling rights, does not.
  const issueForSample = { materialId: mat.id, kind: 'ISSUE', qty: 5, reason: 'Issue for sample' }
  const merchIssue = await action('MATERIAL', issueForSample, 400, merchGrants.join(','))
  const storeIssue = await action('MATERIAL', issueForSample, 403, storeGrants.join(','))
  check('the merchandiser issues sample material; the store login cannot', () => {
    // Past the permission check, stopped only for the store it has not named.
    assert.equal(merchIssue.body.code, 'STORE_REQUIRED')
    assert.equal(storeIssue.status, 403)
  })
  const stock = await db.stockLedger.aggregate({
    where: { itemId: 'sample-fabric', warehouseId: store },
    _sum: { inQty: true, outQty: true },
  })
  // The store is named at the first issue, kept on the line, and no other is taken after it.
  const issue5 = { materialId: mat.id, kind: 'ISSUE', qty: 5, reason: 'Issue for sample' }
  const noStore = await action('MATERIAL', issue5, 400)
  await action('MATERIAL', { ...issue5, warehouseId: 'missing-store' }, 409)
  const fromGeneral = await action('MATERIAL', { ...issue5, warehouseId: generalStore }, 409)
  await staleRefused('MATERIAL', { ...issue5, warehouseId: store }, round.id)
  await action('MATERIAL', { ...issue5, warehouseId: store })
  const otherStore = await action(
    'MATERIAL',
    { ...issue5, qty: 0.001, warehouseId: generalStore },
    409
  )
  check('the first issue needs its sample store, keeps it on the line, and refuses another later', () => {
    assert.equal(noStore.body.code, 'STORE_REQUIRED')
    assert.equal(fromGeneral.body.code, 'NOT_SAMPLE_STORE')
    assert.match(fromGeneral.body.message, /Example Store is a general store/)
    assert.equal(doc.rounds[0].materials[0].warehouseId, store)
    assert.equal(doc.rounds[0].materials[0].warehouse.name, 'Example Sample Store')
    assert.equal(otherStore.body.code, 'OTHER_STORE')
    assert.match(otherStore.body.message, /issued from Example Sample Store. Issue the rest from there/)
  })
  const outgoing = await db.stockLedger.findMany({
    where: { referenceType: 'SAMPLING', referenceId: round.id },
  })
  check('one inventory movement for the issue at stock valuation', () => {
    assert.equal(outgoing.length, 1)
    assert.equal(+outgoing[0].outQty, 5)
    assert.equal(+outgoing[0].unitRate, 100)
  })
  const stale = await call('POST', `/${doc.id}/actions`, {
    version: doc.version - 1,
    roundId: round.id,
    action: 'MATERIAL',
    data: { materialId: mat.id, kind: 'ISSUE', qty: 5, reason: 'Retry' },
  })
  check('stale retry cannot issue twice', () => assert.equal(stale.status, 409))
  // Nothing has reached stitching yet; cutting has two pieces, not three.
  await action('STEP_WORK', cutWhite(round.stages[1], 2), 409)
  await action('STEP_WORK', cutWhite(round.stages[0], 3), 409)
  await makeAll()
  await action('MATERIAL', { materialId: mat.id, kind: 'USE', qty: 4, reason: 'Four metres used' })
  await action(
    'MATERIAL',
    { materialId: mat.id, kind: 'RETURN', qty: 2, reason: 'Too much return' },
    409
  )
  await action(
    'MATERIAL',
    {
      materialId: mat.id,
      kind: 'RETURN',
      qty: 1,
      reason: 'Wrong store',
      warehouseId: generalStore,
    },
    409
  )
  await action('MATERIAL', { materialId: mat.id, kind: 'RETURN', qty: 1, reason: 'Unused metre' })
  const stockAfter = await db.stockLedger.aggregate({
    where: { itemId: 'sample-fabric', warehouseId: store },
    _sum: { inQty: true, outQty: true },
  })
  check('use is not deducted again; return restores original value', () => {
    assert.equal(+stockAfter._sum.outQty - +stock._sum.outQty, 5)
    assert.equal(+stockAfter._sum.inQty - +stock._sum.inQty, 1)
  })
  const whiteM = (qty) => [{ colour: 'White', sizeId: 'sample-size-M', qty }]
  await action('DISPATCH', { ...sendAll(), cells: whiteM(1) }, 409)
  await action(
    'QC',
    { ...qcData(), colours: qcData().colours.map((c) => ({ ...c, actuals: [] })) },
    409
  )
  await action('QC', qcData(() => 52, 'Chest outside tolerance'))
  check('failed measurements leave nothing to send to the buyer', () =>
    assert.equal(doc.rounds[0].state, 'QC_FAILED')
  )
  await action('QC', qcData(() => 50.2, 'Measurements and workmanship accepted'))
  await action('DISPATCH', { ...sendAll(), cells: whiteM(3) }, 409)
  await action('DISPATCH', { ...sendAll(), cells: whiteM(1), notes: 'One retained by sample room' })
  await action('DECIDE', decideAll('APPROVED', 'Change collar'), 409)
  await action('DECIDE', decideAll('CHANGES_REQUIRED', 'Change collar'))
  const oldRound = doc.rounds[0]
  await action(
    'HANDOVER',
    { boms: [{ colour: 'White', bomId: 'sample-bom' }], routingId: 'sample-route', notes: 'Cannot approve' },
    409
  )
  await action('NEW_ROUND', 'Revise collar after buyer feedback', 403, 'sampling:view')
  await staleRefused('NEW_ROUND', 'Revise collar after buyer feedback', oldRound.id)
  await action('NEW_ROUND', 'Revise collar after buyer feedback')
  await action('UPDATE_REQUEST', { ...requestEdit, customerId: null }, 409)
  const copiedRows = doc.rounds[0].materials
  const copiedLines = doc.rounds[0].specification.materials
  check('new round preserves prior decision and frozen specification', () => {
    assert.equal(doc.rounds[0].revision, 2)
    assert.equal(doc.rounds[1].decision.conditions, 'White: Change collar')
    assert.deepEqual(doc.rounds[1].specification, releasedSpec)
  })
  check('a new round copies the BOM lines into rows of its own, nothing issued, no store', () => {
    assert.equal(copiedRows.length, 1)
    assert.notEqual(copiedRows[0].id, oldRound.materials[0].id)
    assert.deepEqual(
      copiedLines.map((l) => l.id),
      copiedRows.map((m) => m.id)
    )
    const { id: newId, ...copied } = copiedLines[0]
    const { id: oldId, ...was } = releasedSpec.materials[0]
    assert.deepEqual(copied, was)
    assert.equal(+copiedRows[0].plannedQty, 5)
    assert.equal(+copiedRows[0].issuedQty, 0)
    assert.equal(copiedRows[0].warehouseId, null)
    assert.equal(+oldRound.materials[0].issuedQty, 5)
  })
  // Saved again with the copied line's id: the same row, kept.
  await action('SAVE_SPEC', { ...doc.rounds[0].specification, patternRef: 'EXAMPLE-PATTERN-v2' })
  await action('RELEASE')
  round = doc.rounds[0]
  mat = round.materials[0]
  check('saving the new round kept its copied row', () => assert.equal(mat.id, copiedRows[0].id))
  // Round 1 gave back a metre to the sample store: round 2 buys only the other four.
  check('what an earlier round left in the sample store serves the next', () => {
    assert.deepEqual(doc.pool.lines[mat.id], { remaining: 5, fromPool: 1, awaited: 0, toBuy: 4 })
  })
  await stockSample()
  await action('MATERIAL', {
    materialId: mat.id,
    kind: 'ISSUE',
    qty: 5,
    reason: 'Second sample round',
    warehouseId: store,
  })
  await makeAll()
  await action('QC', qcData(undefined, 'QC accepted'))
  await action('DISPATCH', { ...sendAll(), cells: whiteM(1), notes: 'One retained' })
  await action('DECIDE', decideAll('APPROVED'))
  const costFirst = await action(
    'HANDOVER',
    { boms: [{ colour: 'White', bomId: 'sample-bom' }], routingId: 'sample-route', notes: 'Bulk package' },
    409
  )
  check('handover waits for the costs to be finalised', () => assert.equal(costFirst.body.code, 'COST_NOT_FINAL'))
  await action('FINALISE_COST', { notes: 'Too early' }, 409)
  await action('MATERIAL', {
    materialId: mat.id,
    kind: 'USE',
    qty: 5,
    reason: 'Accounted sample consumption',
  })
  await action('FINALISE_COST', { notes: 'Costs agreed' }, 403, 'sampling:view,sampling:edit')
  await action('FINALISE_COST', { notes: 'Costs agreed' })
  await action(
    'HANDOVER',
    { boms: [{ colour: 'White', bomId: 'missing' }], routingId: 'sample-route', notes: 'Bulk package' },
    409
  )
  // One choice for each approved colour: none left out, none the buyer did not approve.
  const noColour = await action('HANDOVER', { boms: [{ colour: 'Blue', bomId: null }], routingId: 'sample-route', notes: 'Bulk package' }, 409)
  const colourTwice = await action(
    'HANDOVER',
    { boms: [{ colour: 'White', bomId: 'sample-bom' }, { colour: 'white', bomId: null }], routingId: 'sample-route', notes: 'Bulk package' },
    409
  )
  const badRouting = await action('HANDOVER', { boms: [{ colour: 'White', bomId: 'sample-bom' }], routingId: 'sample-route', routingId: 'missing', notes: 'Bulk package' }, 409)
  check('the handover names each approved colour once, and a routing that fits', () => {
    assert.equal(noColour.body.code, 'HANDOVER_COLOURS')
    assert.match(noColour.body.message, /White/)
    assert.equal(colourTwice.body.code, 'HANDOVER_COLOURS')
    assert.equal(badRouting.body.code, 'HANDOVER_ROUTING')
  })
  await action('HANDOVER', {
    boms: [{ colour: 'White', bomId: 'sample-bom' }], routingId: 'sample-route',
    notes: 'Approved pattern v2 and technical pack v1',
  })
  check('a re-sample of a production style goes over with the BOM Masters approved', () => {
    const h = doc.rounds[0].handover
    assert.deepEqual(
      h.boms.map((b) => [b.colour, b.bomId, b.made]),
      [['White', 'sample-bom', false]]
    )
    assert.equal(h.routing.id, 'sample-route')
    assert.equal(h.style.promoted, false)
    assert.deepEqual(doc.handoverBoms.map((b) => [b.colour, b.approved && b.approved.id]), [['White', 'sample-bom']])
  })
  await action('UPDATE_REQUEST', requestEdit, 409)
  await action('ACCEPT_HANDOVER', {}, 403, 'sampling:view,sampling:edit')
  await action('ACCEPT_HANDOVER')
  await action('ACCEPT_HANDOVER', {}, 409)
  await action('NEW_ROUND', 'Another milestone after handover', 409)
  const handedOver = doc
  check('a request begun without a style takes the style its first round was released in', () =>
    assert.equal(handedOver.styleId, 'sample-style')
  )
  const bulkOrders = await db.manufacturingOrder.count(),
    garments = await db.garment.count()
  check('no manufacturing orders or saleable garments created by sampling', () => {
    assert.equal(bulkOrders, 0)
    assert.equal(garments, 0)
  })
  r = await call('GET', `/${doc.id}`, undefined, 'sampling:view')
  check('cost figures hidden without accounts access', () =>
    assert.equal(r.body.data.rounds[0].materials[0].issuedValue, undefined)
  )
  r = await call('GET', `/${doc.id}/print`, undefined, 'sampling:view')
  check('print includes all rounds and the company header without financial values', () => {
    assert.equal(r.status, 200)
    assert.equal(r.body.data.request.rounds.length, 2)
    assert.equal(r.body.data.company.name, 'Example Garment Workshop')
    assert.equal(r.body.data.request.rounds[0].materials[0].issuedValue, undefined)
    assert.equal(r.body.data.company.bankAccount, undefined)
  })
  r = await call('GET', `/${doc.id}/print`, undefined, 'inventory:view')
  check('print requires sampling view permission', () => assert.equal(r.status, 403))
  r = await call('GET', `?view=Handover&q=${encodeURIComponent(title)}`)
  check('handover queue reflects latest round', () => assert.equal(r.body.pagination.total, 1))
  r = await call('GET', '?export=true', undefined, 'sampling:view')
  check('register export checked on server', () => assert.equal(r.status, 403))
  const events = await db.sampleEvent.findMany({
    where: { requestId: doc.id },
    orderBy: { version: 'asc' },
  })
  check('continuous immutable event history', () =>
    assert.deepEqual(
      events.map((e) => e.version),
      Array.from({ length: doc.version }, (_, i) => i + 1)
    )
  )

  // Independent requests exercise retries, cancellation, stock ownership and isolation.
  const concurrentPayload = {
    ...payload,
    clientKey: crypto.randomUUID(),
    title: title + ' concurrency',
  }
  const createdTwice = await Promise.all([
    call('POST', '', concurrentPayload),
    call('POST', '', concurrentPayload),
  ])
  check('concurrent create is idempotent', () => {
    assert.equal(createdTwice[0].status, 201)
    assert.equal(createdTwice[1].status, 201)
    assert.equal(createdTwice[0].body.data.id, createdTwice[1].body.data.id)
  })
  doc = createdTwice[0].body.data
  const sameCommand = {
    version: doc.version,
    roundId: doc.rounds[0].id,
    action: 'SAVE_SPEC',
    data: spec,
  }
  const race = await Promise.all([
    call('POST', `/${doc.id}/actions`, sameCommand),
    call('POST', `/${doc.id}/actions`, sameCommand),
  ])
  check('two concurrent edits commit once', () =>
    assert.deepEqual(race.map((x) => x.status).sort(), [200, 409])
  )
  doc = race.find((x) => x.status === 200).body.data
  await action('CANCEL', 'Development called off; no pieces or materials issued')
  await action('UPDATE_REQUEST', requestEdit, 409)
  await action('RELEASE', {}, 409)
  check('cancelled request retained with its reason', () => assert.ok(doc.cancelReason))
  const newRequest = await call('POST', '', {
    ...payload,
    clientKey: crypto.randomUUID(),
    title: title + ' buyer material',
  })
  doc = newRequest.body.data
  await action('SAVE_SPEC', {
    ...spec,
    materials: spec.materials.map((x) => ({ ...x, source: 'BUYER_SUPPLIED' })),
  })
  await action('RELEASE')
  mat = doc.rounds[0].materials[0]
  await action(
    'MATERIAL',
    {
      materialId: mat.id,
      kind: 'ISSUE',
      qty: 5,
      reason: 'Buyer owns no stock here',
      warehouseId: store,
    },
    400
  )
  await action(
    'MATERIAL',
    {
      materialId: mat.id,
      kind: 'ISSUE',
      qty: 5,
      reason: 'Not from a general store either',
      warehouseId: generalStore,
    },
    409
  )
  check('material the buyer sends is the buyer’s stock, and cannot draw ours', () => {
    assert.equal(doc.rounds[0].materials[0].source, 'BUYER_SUPPLIED')
    assert.equal(doc.rounds[0].materials[0].ownership, 'CUSTOMER_OWNED')
    assert.equal(+doc.rounds[0].materials[0].issuedQty, 0)
  })
  await action('CANCEL', 'No buyer material available; nothing issued')
  const cancelWithStock = await call('POST', '', {
    ...payload,
    clientKey: crypto.randomUUID(),
    title: title + ' reconciliation',
  })
  doc = cancelWithStock.body.data
  await action('RELEASE', spec)
  await stockSample()
  mat = doc.rounds[0].materials[0]
  await action('MATERIAL', {
    materialId: mat.id,
    kind: 'ISSUE',
    qty: 5,
    reason: 'Issued to sample room',
    warehouseId: store,
  })
  await action('CANCEL', 'Cannot cancel while material remains held', 409)
  await action('MATERIAL', {
    materialId: mat.id,
    kind: 'RETURN',
    qty: 5,
    reason: 'All unused material returned',
  })
  await action('STEP_WORK', cutWhite(doc.rounds[0].stages[0], 2), 409)
  await action('CANCEL', 'No pieces made; all material returned')
  check('cancellation does not delete material or event history', () =>
    assert.equal(doc.rounds[0].materials.length, 1)
  )
  // What it bought is still in the sample store: closed out after the cancellation.
  const leftBefore = await db.stockLedger.aggregate({
    where: { itemId: 'sample-fabric', warehouseId: generalStore },
    _sum: { inQty: true, outQty: true },
  })
  const closeTooMuch = await action(
    'CLOSE_MATERIAL',
    { itemId: 'sample-fabric', warehouseId: store, qty: 6, kind: 'USED', reason: 'All of it' },
    409
  )
  const closeToSample = await action(
    'CLOSE_MATERIAL',
    {
      itemId: 'sample-fabric',
      warehouseId: store,
      qty: 2,
      kind: 'MOVED',
      toWarehouseId: store,
      reason: 'Not into a sample store',
    },
    409
  )
  await action('CLOSE_MATERIAL', {
    itemId: 'sample-fabric',
    warehouseId: store,
    qty: 2,
    kind: 'MOVED',
    toWarehouseId: generalStore,
    reason: 'Good for bulk',
  })
  await action('CLOSE_MATERIAL', {
    itemId: 'sample-fabric',
    warehouseId: store,
    qty: 3,
    kind: 'USED',
    reason: 'Cut-offs used for trials',
  })
  const leftAfter = await db.stockLedger.aggregate({
    where: { itemId: 'sample-fabric', warehouseId: generalStore },
    _sum: { inQty: true, outQty: true },
  })
  check('leftovers are closed out after a cancellation: moved to a general store, or used', () => {
    assert.equal(closeTooMuch.body.code, 'POOL_SHORT')
    assert.equal(closeToSample.body.code, 'BAD_STORE')
    assert.equal(doc.state, 'CANCELLED')
    assert.deepEqual(
      doc.pool.stores.map((s) => [s.received, s.issued, s.closed, s.available]),
      [[5, 0, 5, 0]]
    )
    assert.deepEqual(
      doc.closeOuts.map((c) => [c.kind, +c.qty, c.toWarehouseId]),
      [
        ['USED', 3, null],
        ['MOVED', 2, generalStore],
      ]
    )
    assert.equal(+leftAfter._sum.inQty - +leftBefore._sum.inQty, 2)
  })

  // A size-set approval must cover every size; old rounds still need material reconciliation.
  doc = (
    await call('POST', '', {
      ...payload,
      clientKey: crypto.randomUUID(),
      title: title + ' size set',
    })
  ).body.data
  await action('RELEASE', {
    ...spec,
    colours: [
      {
        colour: 'White',
        sizes: [
          { sizeId: 'sample-size-M', qty: 1 },
          { sizeId: 'sample-size-L', qty: 1 },
        ],
      },
    ],
    measurements: [
      ...spec.measurements,
      { ...spec.measurements[0], sizeId: 'sample-size-L', target: 51 },
    ],
  })
  await stockSample()
  const setRound = doc.rounds[0]
  mat = setRound.materials[0]
  await action('MATERIAL', {
    materialId: mat.id,
    kind: 'ISSUE',
    qty: 5,
    reason: 'Material for size set',
    warehouseId: store,
  })
  await makeAll()
  // Each size is read on its own points: one reading short is refused.
  await action(
    'QC',
    { ...qcData(), colours: qcData().colours.map((c) => ({ ...c, actuals: c.actuals.slice(1) })) },
    409
  )
  await action('QC', qcData(undefined, 'All sizes inspected'))
  await action('DISPATCH', { ...sendAll(), cells: [{ colour: 'White', sizeId: 'sample-size-L', qty: 2 }] }, 409)
  await action('DISPATCH', sendAll({ notes: 'Complete set' }))
  await action('DECIDE', decideAll('CHANGES_REQUIRED', 'Revise fit'))
  await action('NEW_ROUND', 'Revise the complete size set after feedback')
  await action('CANCEL', 'Development stopped; earlier round still holds material', 409)
  await action(
    'MATERIAL',
    { materialId: mat.id, kind: 'USE', qty: 4, reason: 'Earlier round consumption' },
    200,
    undefined,
    setRound.id
  )
  await action(
    'MATERIAL',
    { materialId: mat.id, kind: 'RETURN', qty: 1, reason: 'Earlier round unused material' },
    200,
    undefined,
    setRound.id
  )
  await action('CANCEL', 'Buyer cancelled development; sample garments retained for reference')

  // Two colours in one round go through making, QC and submission as one set.
  doc = (
    await call('POST', '', {
      ...payload,
      clientKey: crypto.randomUUID(),
      title: title + ' two colours',
    })
  ).body.data
  await action('RELEASE', {
    ...spec,
    colours: [
      { colour: 'White', sizes: [{ sizeId: 'sample-size-M', qty: 1 }] },
      { colour: 'blue', sizes: [{ sizeId: 'sample-size-M', qty: 1 }] },
    ],
  })
  const pairRound = doc.rounds[0]
  check('a two-colour round takes the style’s spelling and plans for both colours', () => {
    assert.deepEqual(
      pairRound.specification.colours.map((c) => c.colour),
      ['White', 'Blue']
    )
    assert.equal(+pairRound.materials[0].plannedQty, 5)
  })
  await stockSample()
  await action('MATERIAL', {
    materialId: pairRound.materials[0].id,
    kind: 'ISSUE',
    qty: 5,
    reason: 'Material for two colours',
    warehouseId: store,
  })
  await makeAll()
  check('a two-colour round is made colour by colour through every step', () =>
    assert.deepEqual(
      doc.rounds[0].stages.map((s) => [s.doneQty, s.rejectedQty, !!s.completedAt]),
      doc.rounds[0].stages.map(() => [2, 0, true])
    )
  )
  // Every colour that finished is inspected: one left out is refused.
  await action('QC', { ...qcData(), colours: qcData().colours.slice(0, 1) }, 409)
  await action('QC', qcData(undefined, 'Both colours inspected'))
  await action('DISPATCH', sendAll({ notes: 'Both colours' }))
  await action('DECIDE', decideAll('APPROVED'))
  await action('MATERIAL', {
    materialId: pairRound.materials[0].id,
    kind: 'USE',
    qty: 5,
    reason: 'Both colours made',
  })
  // The example BOM is for White, which this round made; one for a colour it
  // did not make is refused. Checked on a Blue-only round below.
  await action('CANCEL', 'Local two-colour check complete; pieces kept for reference')
  doc = (
    await call('POST', '', {
      ...payload,
      clientKey: crypto.randomUUID(),
      title: title + ' blue only',
    })
  ).body.data
  await action('RELEASE', {
    ...spec,
    colours: [{ colour: 'Blue', sizes: [{ sizeId: 'sample-size-M', qty: 2 }] }],
  })
  const blueRound = doc.rounds[0]
  // Approved as a whole round was before colours were decided one by one.
  await db.sampleRound.update({
    where: { id: blueRound.id },
    data: {
      state: 'APPROVED',
      decision: { result: 'APPROVED', buyerName: 'Example buyer', evidence: 'EXAMPLE', conditions: '' },
    },
  })
  // Costs taken as final, so the BOM is what is checked.
  await db.$executeRaw`UPDATE ld_erp.sample_requests SET "costSheet" = '{}'::jsonb, "costFinalisedAt" = now() WHERE id = ${doc.id}`
  doc = (await call('GET', `/${doc.id}`)).body.data
  const blueBom = await action(
    'HANDOVER',
    { boms: [{ colour: 'Blue', bomId: 'sample-bom' }], routingId: 'sample-route', notes: 'White BOM for a blue round' },
    409
  )
  await db.$executeRaw`UPDATE ld_erp.sample_requests SET "costSheet" = NULL, "costFinalisedAt" = NULL WHERE id = ${doc.id}`
  await db.sampleRound.update({ where: { id: blueRound.id }, data: { state: 'RELEASED' } })
  await db.$executeRaw`UPDATE ld_erp.sample_rounds SET decision = NULL WHERE id = ${blueRound.id}`
  doc = (await call('GET', `/${doc.id}`)).body.data
  check('a handover BOM must be for every colour or one the buyer approved', () =>
    assert.equal(blueBom.body.code, 'HANDOVER_BOM', JSON.stringify(blueBom.body))
  )
  await action('CANCEL', 'Local colour check complete; nothing issued')

  doc = (
    await call('POST', '', {
      ...payload,
      clientKey: crypto.randomUUID(),
      title: title + ' draft conflict',
    })
  ).body.data
  const competingEdits = await Promise.all([
    call('POST', `/${doc.id}/actions`, {
      version: doc.version,
      roundId: doc.rounds[0].id,
      action: 'SAVE_DRAFT',
      data: { construction: 'Concurrent draft' },
    }),
    call('POST', `/${doc.id}/actions`, {
      version: doc.version,
      action: 'UPDATE_REQUEST',
      data: requestEdit,
    }),
  ])
  check('concurrent draft and request edits commit once without losing history', () =>
    assert.deepEqual(competingEdits.map((r) => r.status).sort(), [200, 409])
  )
  doc = competingEdits.find((r) => r.status === 200).body.data
  await action('CANCEL', 'Local concurrency test complete; no material issued')

  // Pilot masters the merchandiser workflow builds on. Expected values are written out here
  // rather than read from the fixtures, so a wrong grant in the fixtures fails instead of passing.
  check('merchandiser role holds exactly its sampling, purchase, stock and masters rights', () =>
    assert.deepEqual(merchGrants, [
      'dashboard:view',
      'inventory:view',
      'masters:view',
      'purchase:create',
      'purchase:edit',
      'purchase:view',
      'sampling:approve',
      'sampling:create',
      'sampling:edit',
      'sampling:export',
      'sampling:view',
    ])
  )
  check('store role buys and moves stock but has no sampling rights', () => {
    for (const g of ['inventory:approve', 'inventory:edit', 'purchase:create', 'purchase:edit'])
      assert.ok(storeGrants.includes(g), g)
    assert.equal(storeGrants.filter((g) => g.startsWith('sampling:')).length, 0)
  })
  const logins = await db.user.findMany({
    where: { email: { in: ['merch@example.com', 'store@example.com'] } },
    select: { email: true, status: true, role: { select: { name: true } } },
  })
  check('merchandiser and store logins carry their own roles', () =>
    assert.deepEqual(
      Object.fromEntries(logins.map((u) => [u.email, `${u.role.name} ${u.status}`])),
      { 'merch@example.com': 'Merchandiser ACTIVE', 'store@example.com': 'Local Store ACTIVE' }
    )
  )
  const asMerch = await call('GET', '', undefined, merchGrants.join(',')),
    asStore = await call('GET', '', undefined, storeGrants.join(','))
  check('merchandiser opens the sampling register; the store login is refused', () => {
    assert.equal(asMerch.status, 200)
    assert.equal(asStore.status, 403)
  })
  const company = await db.company.findUnique({ where: { id: 'sample-company' } })
  check('company has the GST state a purchase order is taxed from', () => {
    assert.equal(company.stateCode, '27')
    assert.equal(company.gstin?.slice(0, 2), '27')
  })
  const suppliers = await db.supplier.findMany({
    where: { code: { in: ['EX-SUP-TRIMS', 'EX-SUP-FABRIC', 'EX-SUP-EMB'] }, isActive: true },
  })
  check('registered same-state suppliers and an embroidery job worker exist', () => {
    assert.deepEqual(
      Object.fromEntries(suppliers.map((s) => [s.code, `${s.name} ${s.category}`])),
      {
        'EX-SUP-TRIMS': 'Example Trims Supplier TRIM',
        'EX-SUP-FABRIC': 'Example Fabric Mill FABRIC',
        'EX-SUP-EMB': 'Example Embroidery Unit SERVICE',
      }
    )
    for (const s of suppliers) {
      assert.equal(s.stateCode, '27', s.code)
      assert.equal(s.gstin?.slice(0, 2), '27', s.code)
      assert.ok(s.address, s.code)
    }
  })
  const items = await db.item.findMany({
    where: { code: { in: ['EX-FAB-002', 'EX-TRM-001', 'EX-TRM-002', 'EX-THR-001'] } },
    select: { code: true, type: true, taxRate: { select: { rate: true } } },
  })
  check('sample fabric, trims and thread carry the GST rate the order form fills in', () =>
    assert.deepEqual(
      Object.fromEntries(items.map((i) => [i.code, `${i.type} ${Number(i.taxRate?.rate)}`])),
      {
        'EX-FAB-002': 'RAW_MATERIAL 5',
        'EX-TRM-001': 'TRIM 12',
        'EX-TRM-002': 'TRIM 12',
        'EX-THR-001': 'CONSUMABLE 12',
      }
    )
  )
  const processes = await db.operation.findMany({
    where: { code: { in: ['EX-CUT', 'OP-STI', 'OP-EMB', 'OP-WSH', 'OP-FIN', 'OP-QC'] } },
    select: {
      id: true,
      code: true,
      kind: true,
      defaultExecution: true,
      isActive: true,
      department: { select: { isActive: true } },
    },
  })
  check('sample processes carry their kind and where they are usually done', () => {
    assert.deepEqual(
      Object.fromEntries(processes.map((o) => [o.code, `${o.kind} ${o.defaultExecution}`])),
      {
        'EX-CUT': 'CUTTING IN_HOUSE',
        'OP-STI': 'STITCHING IN_HOUSE',
        'OP-EMB': 'OTHER OUTSOURCED',
        'OP-WSH': 'FINISHING OUTSOURCED',
        'OP-FIN': 'FINISHING IN_HOUSE',
        'OP-QC': 'QC IN_HOUSE',
      }
    )
    for (const o of processes) assert.ok(o.isActive && o.department.isActive, o.code)
  })
  const tailor = await db.contractor.findUnique({ where: { code: 'EX-CON-001' } })
  check('sample tailor takes stitching', () =>
    assert.ok(tailor?.operationIds.includes(processes.find((o) => o.code === 'OP-STI').id))
  )
  const sampleStore = await db.warehouse.findUnique({ where: { code: 'EX-SAMPLE-STORE' } })
  check('a sample store exists apart from the general store', () => {
    assert.equal(sampleStore?.name, 'Example Sample Store')
    assert.ok(sampleStore.isActive)
    assert.notEqual(sampleStore.id, 'sample-store')
  })
  const pilotDocTypes = ['ENQ', 'GRN', 'JW', 'MR', 'PB', 'PO', 'STN']
  const series = await db.numberSeries.findMany({
    where: { companyId: 'sample-company', docType: { in: pilotDocTypes }, isActive: true },
  })
  check('pilot documents are numbered within the 16-character limit', () => {
    assert.deepEqual([...new Set(series.map((s) => s.docType))].sort(), pilotDocTypes)
    for (const s of series) {
      const next = [s.prefix, s.financialYear, String(s.lastNumber + 1).padStart(s.padding, '0')]
        .filter((part) => part !== '')
        .join(s.separator)
      assert.ok(next.length <= 16 && /^[A-Za-z0-9/-]*$/.test(next), next)
    }
  })

  // ── Phase 1: the buyer's tech pack, and the style made for a sample ──────────
  const viewOnly = 'sampling:view'
  const merch = merchGrants.join(',')
  /** The browser's two steps: a link, then the bytes sent straight to it. */
  const upload = async (requestId, fileName, text, extra = {}, perms) => {
    const link = await call(
      'POST',
      `/${requestId}/attachments/upload-url`,
      { fileName, sizeBytes: Buffer.byteLength(text), ...extra },
      perms
    )
    assert.equal(link.status, 200, JSON.stringify(link.body))
    const sent = await fetch(link.body.data.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: text,
    })
    assert.equal(sent.status, 200, await sent.text())
    return link.body.data.storagePath
  }
  const onDisk = (storagePath) => fs.existsSync(path.join(fileRoot, ...storagePath.split('/')))
  const stamp = String(Date.now()).slice(-7)
  const buyerStyleRef = 'BUYER-ST-' + stamp

  doc = (
    await call('POST', '', {
      ...payload,
      clientKey: crypto.randomUUID(),
      title: title + ' tech pack intake',
      buyerStyleRef,
      season: 'SS-27',
      garmentCategory: 'Shirt',
    })
  ).body.data
  check('request keeps the tech pack details and starts with no style and no files', () => {
    assert.equal(doc.buyerStyleRef, buyerStyleRef)
    assert.equal(doc.season, 'SS-27')
    assert.equal(doc.garmentCategory, 'Shirt')
    assert.equal(doc.styleId, null)
    assert.equal(doc.style, null)
    assert.deepEqual(doc.attachments, [])
  })
  const intakeEdit = {
    ...requestFields,
    title: title + ' tech pack intake',
    buyerStyleRef: buyerStyleRef + 'A',
    season: 'SS-27',
    garmentCategory: 'Shirt',
    reason: 'Buyer revised their style number',
  }
  await action('UPDATE_REQUEST', intakeEdit)
  check('tech pack details are edited with before and after in the history', () => {
    assert.equal(doc.buyerStyleRef, buyerStyleRef + 'A')
    assert.equal(doc.events[0].detail.data.before.buyerStyleRef, buyerStyleRef)
    assert.equal(doc.events[0].detail.data.after.buyerStyleRef, buyerStyleRef + 'A')
  })
  const { buyerStyleRef: _ref, season: _season, garmentCategory: _cat, ...olderScreen } = intakeEdit
  await action('UPDATE_REQUEST', { ...olderScreen, owner: 'Intake owner', reason: 'Owner only' })
  check('an edit that leaves the tech pack details out keeps them', () => {
    assert.equal(doc.owner, 'Intake owner')
    assert.equal(doc.buyerStyleRef, buyerStyleRef + 'A')
    assert.equal(doc.season, 'SS-27')
    assert.equal(doc.events[0].detail.data.after.garmentCategory, 'Shirt')
  })
  r = await call('GET', `?q=${encodeURIComponent(buyerStyleRef + 'A')}`)
  check('register finds a request by the buyer’s style number', () => {
    assert.equal(r.body.pagination.total, 1)
    assert.equal(r.body.data[0].buyerStyleRef, buyerStyleRef + 'A')
    assert.equal(r.body.data[0].style, null)
  })
  await action('SAVE_DRAFT', { construction: 'Kept through the style change' })

  // The request makes its own style: no masters rights, kept in sampling.
  const newStyle = {
    name: 'Buyer camp shirt ' + stamp,
    sizeGroupId: 'sample-sizes',
    colors: ['Navy'],
  }
  await action('CREATE_STYLE', newStyle, 403, viewOnly)
  await action('CREATE_STYLE', { ...newStyle, colors: [] }, 400)
  await action('CREATE_STYLE', { ...newStyle, colors: ['Navy', 'navy'] }, 400)
  await action('CREATE_STYLE', { ...newStyle, sizeGroupId: 'missing-run' }, 409)
  await action('CREATE_STYLE', { ...newStyle, stage: 'PRODUCTION' }, 400)
  // The garment goes into the code for good: a box emptied on purpose is not
  // filled again from the request, and no garment at all is refused.
  const noGarment = await action('CREATE_STYLE', { ...newStyle, category: null }, 400)
  check('a style is not made without its garment, nor with one the person cleared', () =>
    assert.equal(noGarment.body.code, 'CATEGORY_REQUIRED')
  )
  await staleRefused('CREATE_STYLE', newStyle)
  // The code is shown before saving, to sampling rights alone.
  const codeAsked = `/${doc.id}/next-style-code?category=Shirt&season=SS-27`
  const preview = await call('GET', codeAsked, undefined, merch)
  const previewViewOnly = await call('GET', codeAsked, undefined, viewOnly)
  const beforeStyle = doc.version
  await action('CREATE_STYLE', newStyle, 200, merch)
  const devStyle = await db.style.findUnique({ where: { id: doc.styleId } })
  check('the merchandiser sees the code the style will get before making it', () => {
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.equal(preview.body.data.code, devStyle.code)
    assert.equal(previewViewOnly.status, 403)
  })
  check('the merchandiser makes a development style for the request', () => {
    assert.equal(devStyle.stage, 'DEVELOPMENT')
    assert.match(devStyle.code, /^EX-SH-27\d{2,}$/)
    assert.equal(devStyle.brandId, 'sample-brand')
    assert.equal(devStyle.brandType, 'CUSTOM')
    assert.equal(devStyle.category, 'Shirt')
    assert.equal(devStyle.season, 'SS-27')
    assert.equal(devStyle.sizeGroupId, 'sample-sizes')
    assert.deepEqual(devStyle.colors, ['Navy'])
    assert.equal(doc.style.code, devStyle.code)
    assert.equal(doc.style.stage, 'DEVELOPMENT')
    assert.equal(doc.version, beforeStyle + 1)
    assert.equal(doc.events[0].action, 'CREATE_STYLE')
    assert.equal(doc.events[0].detail.data.code, devStyle.code)
    assert.equal(doc.rounds[0].specification.styleId, devStyle.id)
    assert.equal(doc.rounds[0].specification.construction, 'Kept through the style change')
  })
  const styleAudit = () =>
    db.auditLog.findMany({
      where: { entityType: 'Style', entityId: devStyle.id },
      orderBy: { createdAt: 'asc' },
    })
  const madeAudit = await styleAudit()
  check('the style made from the request is in the Styles audit trail, in full', () => {
    assert.equal(madeAudit.length, 1)
    assert.equal(madeAudit[0].module, 'masters')
    assert.equal(madeAudit[0].action, 'CREATE')
    assert.equal(madeAudit[0].after.code, devStyle.code)
    assert.equal(madeAudit[0].after.stage, 'DEVELOPMENT')
  })
  await action('CREATE_STYLE', { ...newStyle, name: 'A second style' }, 409)
  r = await call('GET', `?q=${encodeURIComponent(devStyle.code)}`)
  check('register finds the request by its style code and shows the style', () => {
    assert.equal(r.body.pagination.total, 1)
    assert.deepEqual(r.body.data[0].style, {
      code: devStyle.code,
      name: devStyle.name,
      stage: 'DEVELOPMENT',
    })
  })
  r = await call('GET', '/lookups')
  check('lookups carry each style’s stage and the size runs a new style can use', () => {
    assert.equal(r.body.data.styles.find((x) => x.id === devStyle.id).stage, 'DEVELOPMENT')
    assert.equal(r.body.data.styles.find((x) => x.id === 'sample-style').stage, 'PRODUCTION')
    assert.ok(r.body.data.sizeGroups.some((x) => x.id === 'sample-chest-sizes'))
  })

  // The round's specification follows the request's style.
  const thread = line({
    component: 'Seams',
    itemId: 'sample-thread',
    qtyPerPiece: 0.0125,
    wastagePct: 2.5,
  })
  await action('SAVE_DRAFT', {
    colours: [{ colour: 'navy', sizes: [{ sizeId: 'sample-size-M', qty: 2 }] }],
    measurements: [{ ...spec.measurements[0] }],
    materials: [line({ colour: 'Navy' }), thread],
  })
  check('a draft colour takes the style’s spelling, and its lines their quantities', () => {
    assert.deepEqual(doc.rounds[0].specification.colours[0].colour, 'Navy')
    assert.deepEqual(
      doc.rounds[0].specification.materials.map((l) => l.requiredQty),
      [5, 0.026]
    )
  })
  await action('SAVE_DRAFT', { styleId: 'sample-style' }, 409)

  // Linking: same brand only, any stage, and only while nothing is released.
  await action('LINK_STYLE', { styleId: 'sample-style' }, 403, viewOnly)
  await action('LINK_STYLE', { styleId: 'sample-style-other' }, 409)
  await action('LINK_STYLE', { styleId: 'missing-style' }, 409)
  await action('LINK_STYLE', { styleId: devStyle.id }, 409)
  await staleRefused('LINK_STYLE', { styleId: 'sample-style' })
  await action('LINK_STYLE', { styleId: 'sample-style' })
  check('linking a production style for a re-sample clears what no longer fits the draft', () => {
    assert.equal(doc.styleId, 'sample-style')
    assert.equal(doc.rounds[0].specification.styleId, 'sample-style')
    // Navy is not the shirt's: the colour goes with its own line; the line for
    // every colour stays, with nothing to make yet. Size M is in the shirt's run.
    assert.deepEqual(doc.rounds[0].specification.colours, [])
    assert.equal(doc.rounds[0].specification.measurements.length, 1)
    assert.deepEqual(
      doc.rounds[0].specification.materials.map((l) => [l.itemId, l.requiredQty]),
      [['sample-thread', 0]]
    )
    assert.equal(doc.rounds[0].materials.length, 1)
    assert.deepEqual(doc.events[0].detail.data.refit, [
      {
        revision: 1,
        coloursDropped: 1,
        sizesDropped: 0,
        measurementsDropped: 0,
        materialsDropped: 1,
      },
    ])
    assert.deepEqual(doc.events[0].detail.data.before, {
      id: devStyle.id,
      code: devStyle.code,
      stage: 'DEVELOPMENT',
    })
  })
  const inProduction = await action('UPDATE_STYLE', { colors: ['White', 'Blue', 'Green'] }, 409)
  const shirtColours = (await db.style.findUnique({ where: { id: 'sample-style' } })).colors
  check('a production style is changed in Masters, not from a sample request', () => {
    assert.equal(inProduction.body.code, 'STYLE_IN_PRODUCTION')
    assert.deepEqual(shirtColours, ['White', 'Blue'])
  })
  await action('LINK_STYLE', { styleId: devStyle.id })
  await action('SAVE_DRAFT', {
    colours: [{ colour: 'Navy', sizes: [{ sizeId: 'sample-size-M', qty: 2 }] }],
  })

  // Changing the request's own development style.
  await action('UPDATE_STYLE', { colors: ['Navy', 'Olive'] }, 403, viewOnly)
  await action('UPDATE_STYLE', {}, 400)
  await staleRefused('UPDATE_STYLE', { colors: ['Navy', 'Olive'] })
  await action('UPDATE_STYLE', { colors: ['Navy', 'Olive'] }, 200, merch)
  check('a colour is added to the development style with before and after', () => {
    assert.deepEqual(doc.style.colors, ['Navy', 'Olive'])
    assert.deepEqual(doc.events[0].detail.data.before.colors, ['Navy'])
    assert.deepEqual(doc.events[0].detail.data.after.colors, ['Navy', 'Olive'])
  })
  const changedAudit = (await styleAudit()).at(-1)
  check('and the change is in the Styles audit trail with the style before and after', () => {
    assert.equal(changedAudit.module, 'masters')
    assert.equal(changedAudit.action, 'UPDATE')
    assert.deepEqual(changedAudit.before.colors, ['Navy'])
    assert.deepEqual(changedAudit.after.colors, ['Navy', 'Olive'])
  })
  // Olive is planned with a label of its own, then taken off the style.
  await action('SAVE_DRAFT', {
    colours: [
      { colour: 'Navy', sizes: [{ sizeId: 'sample-size-M', qty: 2 }] },
      { colour: 'Olive', sizes: [{ sizeId: 'sample-size-M', qty: 1 }] },
    ],
    materials: [
      ...doc.rounds[0].specification.materials,
      line({ component: 'Neck', itemId: 'sample-label', colour: 'Olive', qtyPerPiece: 1 }),
    ],
  })
  const beforeOlive = doc.rounds[0].specification.materials
  await action('UPDATE_STYLE', { colors: ['Navy'] })
  const oliveLabel = await db.sampleMaterial.findUnique({ where: { id: beforeOlive[1].id } })
  check('a colour taken off the style takes its rows with it from the draft', () => {
    assert.deepEqual(
      doc.rounds[0].specification.colours.map((c) => c.colour),
      ['Navy']
    )
    assert.deepEqual(
      doc.rounds[0].specification.materials.map((l) => l.id),
      [beforeOlive[0].id]
    )
    // The thread is worked out again for Navy's two pieces alone.
    assert.equal(doc.rounds[0].specification.materials[0].requiredQty, 0.026)
    assert.equal(oliveLabel, null)
    assert.deepEqual(doc.events[0].detail.data.refit, [
      {
        revision: 1,
        coloursDropped: 1,
        sizesDropped: 0,
        measurementsDropped: 0,
        materialsDropped: 1,
      },
    ])
  })
  await action('UPDATE_STYLE', { sizeGroupId: 'sample-chest-sizes' })
  check('a size run changed before release drops sizes the draft can no longer use', () => {
    assert.equal(doc.style.sizeGroupId, 'sample-chest-sizes')
    assert.deepEqual(doc.rounds[0].specification.colours, [{ colour: 'Navy', sizes: [] }])
    assert.deepEqual(doc.rounds[0].specification.measurements, [])
    assert.equal(doc.events[0].detail.data.refit[0].sizesDropped, 1)
    assert.equal(doc.events[0].detail.data.refit[0].measurementsDropped, 1)
  })
  await action('UPDATE_STYLE', { sizeGroupId: 'sample-sizes', name: devStyle.name + ' v2' })

  // Files: the tech pack for the whole request, a photo for a round.
  const techPack = 'Fictional tech pack for a local check only.'
  await action(
    'ATTACH',
    { fileName: 'x.pdf', storagePath: `samples/${doc.id}/x.pdf`, kind: 'TECH_PACK' },
    403,
    viewOnly
  )
  r = await call(
    'POST',
    `/${doc.id}/attachments/upload-url`,
    { fileName: 'tech.pdf', sizeBytes: 10, kind: 'TECH_PACK' },
    viewOnly
  )
  check('a view-only login cannot ask for an upload link', () => assert.equal(r.status, 403))
  r = await call('POST', `/${doc.id}/attachments/upload-url`, {
    fileName: 'tech.pdf',
    sizeBytes: 10,
    kind: 'SKETCH',
  })
  check('an unknown kind of file is refused', () => assert.equal(r.status, 400))
  r = await call('POST', `/${doc.id}/attachments/upload-url`, {
    fileName: 'huge.pdf',
    sizeBytes: 50 * 1024 * 1024 + 1,
    kind: 'TECH_PACK',
  })
  check('a file over 50MB is refused before it is sent', () => assert.equal(r.status, 400))
  const techPath = await upload(
    doc.id,
    'Buyer tech pack.pdf',
    techPack,
    { kind: 'TECH_PACK' },
    merch
  )
  const techFile = { fileName: 'Buyer tech pack.pdf', storagePath: techPath, kind: 'TECH_PACK' }
  await staleRefused('ATTACH', techFile)
  await action('ATTACH', { ...techFile, kind: 'SKETCH' }, 400)
  const neverSent = await action(
    'ATTACH',
    { ...techFile, storagePath: `samples/${doc.id}/abc-never-sent.pdf` },
    400
  )
  const replayed = await action(
    'ATTACH',
    { ...techFile, storagePath: `samples/${created.id}/abc-tech.pdf` },
    400
  )
  check('a file never sent, or sent for another request, is not filed', () => {
    assert.equal(neverSent.body.code, 'UPLOAD_NOT_FOUND')
    assert.equal(replayed.body.code, 'WRONG_DOCUMENT')
  })
  await action('ATTACH', { ...techFile, storagePath: `samples/${doc.id}/../abc-tech.pdf` }, 400)
  await action('ATTACH', { ...techFile, storagePath: `sales-orders/${doc.id}/abc-tech.pdf` }, 400)
  await action('ATTACH', { ...techFile, roundId: 'missing-round' }, 409)
  const beforeAttach = doc.version
  await action('ATTACH', techFile, 200, merch)
  const filed = doc.attachments[0]
  check('the tech pack is filed with the size storage measured and an ATTACH event', () => {
    assert.equal(doc.attachments.length, 1)
    assert.equal(filed.kind, 'TECH_PACK')
    assert.equal(filed.roundId, null)
    assert.equal(filed.sizeBytes, Buffer.byteLength(techPack))
    assert.equal(filed.mimeType, 'application/pdf')
    assert.equal(filed.uploadedBy.id, 'sample-user')
    assert.equal(doc.version, beforeAttach + 1)
    assert.equal(doc.events[0].action, 'ATTACH')
    assert.equal(doc.events[0].detail.data.storagePath, techPath)
    assert.equal(doc.events[0].detail.data.sizeBytes, Buffer.byteLength(techPack))
  })
  const attachAudit = await db.auditLog.findFirst({
    where: { module: 'sampling', entityType: 'SampleRequest', entityId: doc.id },
    orderBy: { createdAt: 'desc' },
  })
  check('the audit row names the file’s own round, not the round on screen', () => {
    assert.equal(attachAudit.after.action, 'ATTACH')
    assert.equal(attachAudit.after.roundId, null)
  })
  await action('ATTACH', techFile, 409)
  // Other spellings of a filed path. Cloud storage reads "x.pdf#" and
  // "x.pdf?x" as x.pdf, and a Windows disk ignores capitals, so each would be a
  // second row on the kept file, and removing that row would delete the file.
  const slash = techPath.lastIndexOf('/')
  const techName = techPath.slice(slash + 1)
  const dash = techName.indexOf('-')
  const shouted =
    techPath.slice(0, slash + 1) + techName.slice(0, dash + 1) + techName.slice(dash + 1).toUpperCase()
  const aliasOf = (storagePath) => ({ ...techFile, storagePath, kind: 'OTHER' })
  const fragment = await action('ATTACH', aliasOf(techPath + '#'), 400)
  const query = await action('ATTACH', aliasOf(techPath + '?x'), 400)
  const capitals = await action('ATTACH', aliasOf(shouted), 409)
  check('another spelling of a filed path is refused, and the file stays', () => {
    assert.equal(fragment.body.code, 'BAD_STORAGE_PATH')
    assert.equal(query.body.code, 'BAD_STORAGE_PATH')
    assert.equal(capitals.body.code, 'ALREADY_ATTACHED')
    assert.equal(doc.attachments.length, 1)
    assert.equal(onDisk(techPath), true)
  })
  // A second row on one file, as one could be filed before that was refused:
  // removing it leaves the file for the row that still names it.
  const alias = await db.sampleAttachment.create({
    data: {
      requestId: doc.id,
      kind: 'OTHER',
      fileName: 'alias.pdf',
      storagePath: shouted,
      sizeBytes: 1,
      uploadedById: 'sample-user',
    },
  })
  doc = (await call('GET', `/${doc.id}`)).body.data
  await action('DETACH', { attachmentId: alias.id, reason: 'Second row on one file' })
  check('removing a second row on one file does not delete the file', () => {
    assert.equal(onDisk(techPath), true)
    assert.deepEqual(
      doc.attachments.map((x) => x.id),
      [filed.id]
    )
  })
  r = await call('GET', `/attachments/${filed.id}/link`, undefined, viewOnly)
  const download = await fetch(r.body.data.url)
  const downloaded = await download.text()
  check('a view-only login opens the tech pack through a signed link', () => {
    assert.equal(r.status, 200)
    assert.equal(download.status, 200)
    assert.equal(downloaded, techPack)
  })
  r = await call('GET', `/${doc.id}/attachments`)
  check('the file list says the tech pack can still be removed before release', () => {
    assert.equal(r.body.data.length, 1)
    assert.equal(r.body.data[0].removable, true)
    assert.equal(r.body.data[0].lockedReason, null)
  })
  const draftRound = doc.rounds[0]
  const photoPath = await upload(doc.id, 'first fit.pdf', 'Fictional fit photo', {
    kind: 'PHOTO',
    roundId: draftRound.id,
  })
  await action('ATTACH', {
    fileName: 'first fit.pdf',
    storagePath: photoPath,
    kind: 'PHOTO',
    roundId: draftRound.id,
  })
  const draftPhoto = doc.attachments.find((x) => x.storagePath === photoPath)
  r = await call('GET', `/${doc.id}/attachments?roundId=${draftRound.id}&kind=PHOTO`)
  const requestLevel = await call('GET', `/${doc.id}/attachments?roundId=none`)
  check('files list by round and kind, and for the whole request', () => {
    assert.deepEqual(
      r.body.data.map((x) => x.id),
      [draftPhoto.id]
    )
    assert.deepEqual(
      requestLevel.body.data.map((x) => x.id),
      [filed.id]
    )
    assert.equal(doc.events[0].detail.roundId, draftRound.id)
  })
  await action('DETACH', { attachmentId: draftPhoto.id, reason: 'x' }, 403, viewOnly)
  await action('DETACH', { attachmentId: draftPhoto.id, reason: '' }, 400)
  await action('DETACH', { attachmentId: 'missing-file', reason: 'Wrong file' }, 404)
  await staleRefused('DETACH', { attachmentId: draftPhoto.id, reason: 'Wrong photo' })
  await action('DETACH', { attachmentId: draftPhoto.id, reason: 'Wrong photo' }, 200, merch)
  check('a draft round’s file is removed: row, then the file itself, with its reason', () => {
    assert.equal(
      doc.attachments.some((x) => x.id === draftPhoto.id),
      false
    )
    assert.equal(onDisk(photoPath), false)
    assert.equal(doc.events[0].action, 'DETACH')
    assert.equal(doc.events[0].detail.data.reason, 'Wrong photo')
  })

  // Five of a kind per request, counted again under the request's lock.
  const others = []
  for (let i = 1; i <= 5; i++) {
    const p = await upload(doc.id, `note ${i}.pdf`, `Fictional note ${i}`, { kind: 'OTHER' })
    await action('ATTACH', { fileName: `note ${i}.pdf`, storagePath: p, kind: 'OTHER' })
    others.push(doc.attachments.find((x) => x.storagePath === p))
  }
  r = await call('POST', `/${doc.id}/attachments/upload-url`, {
    fileName: 'note 6.pdf',
    sizeBytes: 10,
    kind: 'OTHER',
  })
  check('a sixth file of one kind is refused before it is sent', () => {
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'TOO_MANY_FILES')
  })
  const sixth = await upload(doc.id, 'note 6.pdf', 'Fictional note 6')
  const sixthRefused = await action(
    'ATTACH',
    { fileName: 'note 6.pdf', storagePath: sixth, kind: 'OTHER' },
    409
  )
  check('and refused again when filed, while other kinds are still allowed', () =>
    assert.equal(sixthRefused.body.code, 'TOO_MANY_FILES')
  )
  // Five for the whole request, and five for each round.
  r = await call('POST', `/${doc.id}/attachments/upload-url`, {
    fileName: 'note 6.pdf',
    sizeBytes: 10,
    kind: 'OTHER',
    roundId: draftRound.id,
  })
  await action('ATTACH', {
    fileName: 'note 6.pdf',
    storagePath: sixth,
    kind: 'OTHER',
    roundId: draftRound.id,
  })
  const roundNote = doc.attachments.find((x) => x.storagePath === sixth)
  check('the sixth of a kind is filed against a round, which counts its own five', () => {
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(roundNote.roundId, draftRound.id)
  })
  const patternPath = await upload(doc.id, 'pattern v1.pdf', 'Fictional pattern', {
    kind: 'PATTERN',
    roundId: draftRound.id,
  })
  await action('ATTACH', {
    fileName: 'pattern v1.pdf',
    storagePath: patternPath,
    kind: 'PATTERN',
    roundId: draftRound.id,
  })
  const releasedPattern = doc.attachments.find((x) => x.storagePath === patternPath)

  // Release freezes the files the round had, and the tech pack it followed.
  await action('RELEASE', {
    ...spec,
    styleId: doc.styleId,
    colours: [{ colour: 'Navy', sizes: [{ sizeId: 'sample-size-M', qty: 2 }] }],
    techPackRef: 'Buyer tech pack on file',
  })
  await action('LINK_STYLE', { styleId: 'sample-style' }, 409)
  await action('LINK_STYLE', { styleId: null }, 409)
  await action('CREATE_STYLE', newStyle, 409)
  const kept = await action(
    'DETACH',
    { attachmentId: filed.id, reason: 'Buyer sent a newer one' },
    409
  )
  const keptPattern = await action(
    'DETACH',
    { attachmentId: releasedPattern.id, reason: 'Pattern changed' },
    409
  )
  check('the tech pack and the round’s pattern stay once it is released, file and all', () => {
    assert.equal(kept.body.code, 'FILE_KEPT')
    assert.equal(keptPattern.body.code, 'FILE_KEPT')
    assert.equal(onDisk(techPath), true)
    assert.equal(onDisk(patternPath), true)
  })
  const releasedRound = doc.rounds[0]
  const fitPath = await upload(doc.id, 'released fit.pdf', 'Fictional fit photo 2', {
    kind: 'PHOTO',
    roundId: releasedRound.id,
  })
  await action('ATTACH', {
    fileName: 'released fit.pdf',
    storagePath: fitPath,
    kind: 'PHOTO',
    roundId: releasedRound.id,
  })
  const releasedPhoto = doc.attachments.find((x) => x.storagePath === fitPath)
  const newerPath = await upload(doc.id, 'Buyer tech pack v2.pdf', 'Fictional tech pack v2', {
    kind: 'TECH_PACK',
  })
  await action('ATTACH', {
    fileName: 'Buyer tech pack v2.pdf',
    storagePath: newerPath,
    kind: 'TECH_PACK',
  })
  const newerTech = doc.attachments.find((x) => x.storagePath === newerPath)
  r = await call('GET', `/${doc.id}/attachments`)
  check('what a round was released with is kept; a file added after it can still go', () => {
    const byId = Object.fromEntries(r.body.data.map((x) => [x.id, x]))
    assert.equal(byId[filed.id].removable, false)
    assert.match(byId[filed.id].lockedReason, /tech pack/)
    assert.equal(byId[releasedPattern.id].removable, false)
    assert.equal(byId[roundNote.id].removable, false)
    assert.equal(byId[releasedPhoto.id].removable, true)
    assert.equal(byId[newerTech.id].removable, true)
    assert.equal(byId[others[1].id].removable, true)
    // The request itself carries the same answer, so no second call is needed.
    assert.equal(doc.attachments.find((x) => x.id === filed.id).removable, false)
    assert.equal(doc.attachments.find((x) => x.id === others[1].id).lockedReason, null)
  })
  await action(
    'DETACH',
    { attachmentId: releasedPhoto.id, reason: 'Another buyer’s photo' },
    200,
    merch
  )
  check('a wrong photo filed after release is removed, file and all', () => {
    assert.equal(
      doc.attachments.some((x) => x.id === releasedPhoto.id),
      false
    )
    assert.equal(onDisk(fitPath), false)
  })
  await action('DETACH', { attachmentId: others[0].id, reason: 'Duplicate note' })

  // What a released round was made in stays true of the style.
  await action('UPDATE_STYLE', { colors: ['Olive'] }, 409)
  await action('UPDATE_STYLE', { sizeGroupId: 'sample-chest-sizes' }, 409)
  await action('UPDATE_STYLE', { colors: ['Navy'] })
  await action('UPDATE_STYLE', { colors: ['Navy', 'Sand'] })
  check('after release a colour can be added, or one never sampled taken off', () =>
    assert.deepEqual(doc.style.colors, ['Navy', 'Sand'])
  )
  r = await call('GET', `/${doc.id}/print`, undefined, viewOnly)
  check('the printed record names the style and lists files by name and kind only', () => {
    assert.equal(r.body.data.request.style.code, devStyle.code)
    const printed = r.body.data.request.attachments.find((x) => x.id === filed.id)
    assert.equal(printed.fileName, 'Buyer tech pack.pdf')
    assert.equal(printed.kindLabel, 'Tech pack')
    assert.equal(printed.storagePath, undefined)
  })

  // Masters: the stage filter, and no way to set the stage by hand.
  const styleList = async (query) => {
    const res = await fetch(`${origin}/masters/styles?${query}`)
    return res.json()
  }
  const q = `q=${encodeURIComponent(devStyle.code)}`
  const inSampling = await styleList(`${q}&stage=DEVELOPMENT`)
  const forOrders = await styleList(`${q}&stage=PRODUCTION`)
  const everything = await styleList(q)
  const shirt = await styleList('q=EX-SH-2601&stage=PRODUCTION')
  check('the Styles list filters by stage, and lists both when no stage is asked', () => {
    assert.equal(inSampling.pagination.total, 1)
    assert.equal(inSampling.data[0].stage, 'DEVELOPMENT')
    assert.equal(forOrders.pagination.total, 0)
    assert.equal(everything.pagination.total, 1)
    assert.equal(shirt.data[0].stage, 'PRODUCTION')
  })
  let res = await fetch(`${origin}/masters/styles/${devStyle.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage: 'PRODUCTION' }),
  })
  const stillSampling = await db.style.findUnique({ where: { id: devStyle.id } })
  check('the Styles master cannot promote a style out of sampling', () => {
    assert.equal(res.status, 200)
    assert.equal(stillSampling.stage, 'DEVELOPMENT')
  })
  // What sampling relies on is changed from the request, where its rules,
  // lock and history apply; the master edits only the rest.
  const editStyle = async (method, body) => {
    const sent = await fetch(`${origin}/masters/styles/${devStyle.id}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: sent.status, body: await sent.json() }
  }
  const mastersRefused = [
    await editStyle('PATCH', { colors: ['Navy'] }),
    await editStyle('PATCH', { sizeGroupId: 'sample-chest-sizes' }),
    await editStyle('PATCH', { brandId: 'sample-brand-other' }),
    await editStyle('PATCH', { isActive: false }),
    await editStyle('DELETE'),
  ]
  // The full form sends every field: unchanged ones are no change.
  const cosmetic = await editStyle('PATCH', {
    fit: 'Relaxed',
    colors: stillSampling.colors,
    sizeGroupId: stillSampling.sizeGroupId,
    brandId: stillSampling.brandId,
    isActive: true,
  })
  const afterMasters = await db.style.findUnique({ where: { id: devStyle.id } })
  check('the Styles master leaves brand, size run, colours and switching off to the request', () => {
    for (const x of mastersRefused) {
      assert.equal(x.status, 409, JSON.stringify(x.body))
      assert.equal(x.body.code, 'STYLE_IN_SAMPLING')
    }
    assert.equal(cosmetic.status, 200, JSON.stringify(cosmetic.body))
    assert.equal(afterMasters.fit, 'Relaxed')
    assert.deepEqual(afterMasters.colors, stillSampling.colors)
    assert.equal(afterMasters.sizeGroupId, 'sample-sizes')
    assert.equal(afterMasters.brandId, 'sample-brand')
    assert.equal(afterMasters.isActive, true)
  })
  res = await fetch(`${origin}/masters/styles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Hand-made style ' + stamp,
      brandId: 'sample-brand',
      category: 'Shirt',
      stage: 'DEVELOPMENT',
    }),
  })
  const handMade = (await res.json()).data
  check('nor make a style that is in sampling', () => {
    assert.equal(res.status, 201)
    assert.equal(handMade.stage, 'PRODUCTION')
  })
  await db.style.delete({ where: { id: handMade.id } })

  // Production refuses a style still in sampling.
  const pcs = await db.uOM.findUnique({ where: { symbol: 'pcs' } })
  const itemsBefore = await db.item.count({ where: { styleId: devStyle.id } })
  res = await fetch(`${origin}/masters/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Sampling style garment ' + stamp,
      type: 'FINISHED_GOOD',
      categoryId: 'sample-category',
      uomId: pcs.id,
      styleId: devStyle.id,
      color: 'Navy',
    }),
  })
  const itemRefusal = await res.json()
  check('a finished-goods item cannot be made for a style in sampling', () => {
    assert.equal(res.status, 409, JSON.stringify(itemRefusal))
    assert.equal(itemRefusal.code, 'STYLE_IN_DEVELOPMENT')
    assert.match(itemRefusal.message, /still in sampling/)
  })
  res = await fetch(`${origin}/masters/bom`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      styleId: devStyle.id,
      color: 'Navy',
      lines: [{ componentItemId: 'sample-fabric', qtyPerUnit: 2 }],
    }),
  })
  const bomRefusal = await res.json()
  const madeForIt = {
    items: await db.item.count({ where: { styleId: devStyle.id } }),
    boms: await db.bOM.count({ where: { styleId: devStyle.id } }),
  }
  check('nor a production BOM, and nothing is saved for it', () => {
    assert.equal(res.status, 409, JSON.stringify(bomRefusal))
    assert.equal(bomRefusal.code, 'STYLE_IN_DEVELOPMENT')
    assert.deepEqual(madeForIt, { items: itemsBefore, boms: 0 })
  })
  const { createRouting } = require('../apps/api/src/services/routing.service.ts')
  const cutting = await db.operation.findUnique({ where: { code: 'EX-CUT' } })
  const routeRefusal = await db
    .$transaction((tx) =>
      createRouting(
        tx,
        {
          name: 'Sampling style route ' + stamp,
          styleId: devStyle.id,
          steps: [
            {
              sequence: 1,
              operationId: cutting.id,
              departmentId: cutting.departmentId,
              execution: 'IN_HOUSE',
              skip: 'NEVER',
            },
          ],
        },
        'sample-user'
      )
    )
    .catch((e) => e)
  check('nor a production routing', () => assert.equal(routeRefusal.code, 'STYLE_IN_DEVELOPMENT'))
  const { routingsByStyle } = require('../apps/api/src/services/routingOverview.service.ts')
  const waitingForRoutes = await routingsByStyle(db, { q: devStyle.code, page: 1, limit: 10 })
  res = await fetch(`${origin}/quotations/styles`)
  const quotable = (await res.json()).data
  check('production pickers leave out a style still in sampling', () => {
    assert.equal(waitingForRoutes.total, 0)
    assert.equal(
      quotable.some((x) => x.id === devStyle.id),
      false
    )
    assert.ok(quotable.some((x) => x.id === 'sample-style'))
  })
  // A style number typed on a line, for a garment item with no style of its own.
  const { prepareOrder } = require('../apps/api/src/routes/sales.routes.ts')
  const styleless = await db.item.create({
    data: {
      code: 'EX-FG-T' + stamp,
      name: 'Styleless garment ' + stamp,
      type: 'FINISHED_GOOD',
      categoryId: 'sample-category',
      uomId: pcs.id,
    },
  })
  const typedRefusal = await db
    .$transaction((tx) =>
      prepareOrder(tx, {
        customerId: 'sample-buyer',
        brandId: 'sample-brand',
        orderDate: new Date(),
        lines: [
          {
            itemId: styleless.id,
            styleCode: ' ' + devStyle.code.toLowerCase(),
            totalQty: 1,
            unitPrice: 100,
          },
        ],
      })
    )
    .catch((e) => e)
  await db.item.delete({ where: { id: styleless.id } })
  check('an order or quotation line cannot name a style in sampling by its typed code', () => {
    assert.equal(typedRefusal.code, 'STYLE_IN_DEVELOPMENT', String(typedRefusal))
    assert.match(typedRefusal.message, new RegExp(devStyle.code))
  })
  // An approved round of a style made in sampling has nothing to hand over yet.
  await db.sampleRound.update({
    where: { id: releasedRound.id },
    data: {
      state: 'APPROVED',
      decision: { result: 'APPROVED', buyerName: 'Example buyer', evidence: 'EXAMPLE', conditions: '' },
    },
  })
  doc = (await call('GET', `/${doc.id}`)).body.data
  const noHandover = await action(
    'HANDOVER',
    { boms: [{ colour: 'White', bomId: null }], routingId: null, notes: 'Bulk package' },
    409
  )
  await db.sampleRound.update({ where: { id: releasedRound.id }, data: { state: 'RELEASED' } })
  await db.$executeRaw`UPDATE ld_erp.sample_rounds SET decision = NULL WHERE id = ${releasedRound.id}`
  doc = (await call('GET', `/${doc.id}`)).body.data
  // Handed over like any other since phase 8 (tools/check-sample-handover.cjs), once its costs are final.
  check('a style made in sampling waits only for its costs to be handed over', () => {
    assert.equal(noHandover.body.code, 'COST_NOT_FINAL')
  })

  // A style in sampling belongs to the open request developing it.
  const intake = doc
  doc = (
    await call('POST', '', {
      ...payload,
      clientKey: crypto.randomUUID(),
      title: title + ' second request on a developing style',
    })
  ).body.data
  const taken = await action('LINK_STYLE', { styleId: devStyle.id }, 409)
  check('another request cannot take a style a request is still developing', () => {
    assert.equal(taken.body.code, 'STYLE_TAKEN')
    assert.match(taken.body.message, new RegExp(intake.number))
  })
  await action('CANCEL', 'Local check: style belongs to another request; nothing issued')
  doc = intake

  // A cancelled request keeps its files and takes no more.
  await action('CANCEL', 'Buyer dropped the style; no material issued')
  r = await call('POST', `/${doc.id}/attachments/upload-url`, {
    fileName: 'late.pdf',
    sizeBytes: 10,
    kind: 'OTHER',
  })
  check('a cancelled request gives no upload link', () => assert.equal(r.status, 409))
  await action('ATTACH', { ...techFile, storagePath: sixth }, 409)
  await action('DETACH', { attachmentId: others[1].id, reason: 'Tidy up' }, 409)
  await action('UPDATE_STYLE', { colors: ['Navy', 'Sand', 'Rust'] }, 409)
  check('cancelling keeps every file on the request', () => {
    // Tech pack and its newer version, four notes, the round's note and pattern.
    assert.equal(doc.attachments.length, 8)
    assert.equal(onDisk(techPath), true)
  })
  const intakeEvents = await db.sampleEvent.findMany({
    where: { requestId: doc.id },
    orderBy: { version: 'asc' },
  })
  check('every intake action left one event, in order', () =>
    assert.deepEqual(
      intakeEvents.map((e) => e.version),
      Array.from({ length: doc.version }, (_, i) => i + 1)
    )
  )

  // A handed-over request is frozen for files and style alike.
  doc = (await call('GET', `/${handedOver.id}`)).body.data
  r = await call('POST', `/${doc.id}/attachments/upload-url`, {
    fileName: 'late.pdf',
    sizeBytes: 10,
    kind: 'OTHER',
  })
  check('a handed-over request gives no upload link', () => assert.equal(r.status, 409))
  await action(
    'ATTACH',
    { fileName: 'late.pdf', storagePath: `samples/${doc.id}/abc-late.pdf`, kind: 'OTHER' },
    409
  )
  await action('UPDATE_STYLE', { colors: ['White'] }, 409)

  // Brand, unlinking, and a style whose own request was cancelled.
  const openRequest = async (suffix) =>
    (
      await call('POST', '', {
        ...payload,
        clientKey: crypto.randomUUID(),
        title: title + suffix,
      })
    ).body.data
  doc = await openRequest(' re-sample')
  await action('LINK_STYLE', { styleId: null }, 409)
  await action('LINK_STYLE', { styleId: devStyle.id })
  check('once the request developing it is cancelled, its style can be linked', () =>
    assert.equal(doc.style.stage, 'DEVELOPMENT')
  )
  // Two open requests on one style in sampling, as could happen before only
  // one could link it: neither may change it while the other is open.
  const resample = doc
  const earlier = await openRequest(' linked before the rule')
  await db.sampleRequest.update({ where: { id: earlier.id }, data: { styleId: devStyle.id } })
  const shared = await action('UPDATE_STYLE', { colors: [...doc.style.colors, 'Teal'] }, 409)
  check('a style two open requests sample is changed from neither', () => {
    assert.equal(shared.body.code, 'STYLE_SHARED')
    assert.match(shared.body.message, new RegExp(earlier.number))
  })
  doc = (await call('GET', `/${earlier.id}`)).body.data
  await action('CANCEL', 'Local check: second request on one style; nothing issued')
  doc = (await call('GET', `/${resample.id}`)).body.data
  await action('UPDATE_STYLE', { colors: [...doc.style.colors, 'Teal'] })
  check('with the other request closed, the one left changes the style', () =>
    assert.ok(doc.style.colors.includes('Teal'))
  )
  await action('UPDATE_REQUEST', { ...requestEdit, brandId: 'sample-brand-other' }, 409)
  await action('LINK_STYLE', { styleId: null })
  check('taking the style off clears it from the draft', () => {
    assert.equal(doc.styleId, null)
    assert.equal(doc.rounds[0].specification.styleId, '')
  })
  await action('UPDATE_REQUEST', {
    ...requestEdit,
    brandId: 'sample-brand-other',
    reason: 'Buyer moved the style to their outlet label',
  })
  await action('LINK_STYLE', { styleId: 'sample-style-other' })
  check('with no style, the brand can change and a style of the new brand is linked', () => {
    assert.equal(doc.brandId, 'sample-brand-other')
    assert.equal(doc.style.code, 'EO-TS-2601')
  })
  await action('CANCEL', 'Local re-sample check complete; nothing issued')

  // A request released before requests named their own style (phase 0).
  doc = await openRequest(' released before it named its style')
  await action('SAVE_SPEC', spec)
  await action('RELEASE')
  const legacyRound = doc.rounds[0]
  const forgetStyle = () =>
    db.sampleRequest.update({ where: { id: doc.id }, data: { styleId: null } })
  await forgetStyle()
  const backfill = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'packages/database/prisma/migrations/20261116110000_sampling_request_style_backfill/migration.sql'
    ),
    'utf8'
  )
  await db.$executeRawUnsafe(backfill)
  const backfilled = await db.sampleRequest.findUnique({ where: { id: doc.id } })
  check('the backfill gives such a request the style its released round was made in', () =>
    assert.equal(backfilled.styleId, 'sample-style')
  )
  await forgetStyle()
  doc = (await call('GET', `/${doc.id}`)).body.data
  const otherStyle = await action('LINK_STYLE', { styleId: devStyle.id }, 409)
  await action('LINK_STYLE', { styleId: 'sample-style' })
  check('it may still take the style its rounds were made in, and no other', () => {
    assert.equal(otherStyle.body.code, 'STYLE_FIXED')
    assert.equal(doc.styleId, 'sample-style')
  })
  await forgetStyle()
  await db.sampleRound.update({ where: { id: legacyRound.id }, data: { state: 'CHANGES_REQUIRED' } })
  doc = (await call('GET', `/${doc.id}`)).body.data
  await action('NEW_ROUND', 'Buyer asked for a longer sleeve')
  check('its next round gives it that style, so the round can be prepared', () => {
    assert.equal(doc.styleId, 'sample-style')
    assert.equal(doc.rounds[0].specification.styleId, 'sample-style')
    assert.equal(doc.events[0].detail.data.styleId, 'sample-style')
  })
  await action('CANCEL', 'Local legacy check complete; nothing issued')

  // ── Phase 2: the colour x size grid, the sample BOM and the making route ────
  doc = await openRequest(' grid, BOM and route')
  await action('LINK_STYLE', { styleId: 'sample-style' })
  const finishingDept = (await db.department.findUnique({ where: { code: 'FIN' } })).id
  const grid = [
    {
      colour: 'White',
      sizes: [
        { sizeId: 'sample-size-M', qty: 2 },
        { sizeId: 'sample-size-L', qty: 1 },
      ],
    },
    { colour: 'Blue', sizes: [{ sizeId: 'sample-size-M', qty: 2 }] },
  ]
  const chest = [
    { name: 'Chest', sizeId: 'sample-size-M', target: 50, tolerance: 0.5, unit: 'cm' },
    { name: 'Chest', sizeId: 'sample-size-L', target: 52, tolerance: 0.5, unit: 'cm' },
  ]
  const bom = [
    // Every colour, five pieces: 1.25 m with 5% wastage is 1.3125 m a piece, 6.5625 m in all.
    line({ qtyPerPiece: 1.25, wastagePct: 5 }),
    // Blue's two pieces: 7 buttons with 10% spare.
    line({
      component: 'Front',
      itemId: 'sample-button',
      colour: 'Blue',
      qtyPerPiece: 7,
      wastagePct: 10,
    }),
    // White's three pieces.
    line({ component: 'Neck', itemId: 'sample-label', colour: 'White', qtyPerPiece: 1 }),
    line({ component: 'Seams', itemId: 'sample-thread', qtyPerPiece: 0.0125, wastagePct: 2.5 }),
    // No department given: Finishing draws polybags.
    line({ component: 'Packing', itemId: 'sample-polybag', qtyPerPiece: 1 }),
  ]
  await action('SAVE_DRAFT', { colours: grid, measurements: chest, materials: bom }, 403, viewOnly)
  await action('SAVE_DRAFT', { colours: grid, measurements: chest, materials: bom }, 200, merch)
  const ids1 = doc.rounds[0].specification.materials.map((l) => l.id)
  check('a multi-colour grid saves, and each line works out its quantity for its colours', () => {
    assert.deepEqual(doc.rounds[0].specification.colours, grid)
    assert.deepEqual(
      doc.rounds[0].specification.materials.map((l) => l.requiredQty),
      [6.563, 15.4, 3, 0.064, 5]
    )
    assert.deepEqual(
      doc.rounds[0].materials.map((m) => [m.id, +m.plannedQty, m.sequence]),
      ids1.map((id, i) => [id, [6.563, 15.4, 3, 0.064, 5][i], i + 1])
    )
    assert.equal(doc.rounds[0].specification.materials[4].departmentId, finishingDept)
    assert.equal(doc.rounds[0].specification.materials[0].departmentId, null)
    assert.ok(ids1.every(Boolean))
  })
  // Second save: one line changed, one added. Third: one dropped. Ids stay put.
  const cur = () => doc.rounds[0].specification.materials
  await action('SAVE_DRAFT', {
    materials: [
      { ...cur()[0], qtyPerPiece: 1.5 },
      ...cur().slice(1),
      line({ component: 'Collar', qtyPerPiece: 0.3 }),
    ],
  })
  const ids2 = cur().map((l) => l.id)
  check('an edited line keeps its row, a new line gets one, and one cloth may go into two parts', () => {
    assert.deepEqual(ids2.slice(0, 5), ids1)
    assert.equal(ids2.length, 6)
    assert.ok(!ids1.includes(ids2[5]))
    assert.equal(cur()[0].requiredQty, 7.875)
    assert.equal(cur()[5].requiredQty, 1.5)
  })
  const labelId = ids1[2]
  await action('SAVE_DRAFT', { materials: cur().filter((l) => l.id !== labelId) })
  const droppedLabel = await db.sampleMaterial.findUnique({ where: { id: labelId } })
  check('a dropped line loses its row and no other', () => {
    assert.deepEqual(
      cur().map((l) => l.id),
      ids2.filter((id) => id !== labelId)
    )
    assert.equal(droppedLabel, null)
    assert.equal(doc.rounds[0].materials.length, 5)
  })
  // A grid change alone works every line out again, rows and all.
  await action('SAVE_DRAFT', {
    colours: [
      {
        colour: 'White',
        sizes: [
          { sizeId: 'sample-size-M', qty: 3 },
          { sizeId: 'sample-size-L', qty: 1 },
        ],
      },
      grid[1],
    ],
  })
  check('more pieces in the grid raise every line for those colours, ids unchanged', () => {
    assert.deepEqual(
      cur().map((l) => l.id),
      ids2.filter((id) => id !== labelId)
    )
    assert.equal(cur()[0].requiredQty, 9.45)
    assert.equal(cur()[1].requiredQty, 15.4)
    assert.equal(+doc.rounds[0].materials[0].plannedQty, 9.45)
  })
  const foreign = await action(
    'SAVE_DRAFT',
    { materials: [{ ...cur()[0], id: handedOver.rounds[0].materials[0].id }] },
    409
  )
  const duplicate = await action(
    'SAVE_DRAFT',
    { materials: [...cur(), line({ qtyPerPiece: 2 })] },
    409
  )
  const notRound = await action(
    'SAVE_DRAFT',
    { materials: [...cur(), line({ component: 'Sleeve', colour: 'Black' })] },
    409
  )
  const notStyleColour = await action(
    'SAVE_DRAFT',
    { colours: [...doc.rounds[0].specification.colours, { colour: 'Green', sizes: [] }] },
    409
  )
  const wrongTailor = await action(
    'SAVE_DRAFT',
    { route: [step('EX-CUT', { contractorId: 'sample-tailor' }), step('OP-STI'), step('OP-FIN')] },
    400
  )
  // Body cloth for every colour is already Blue's: a Blue line of it would plan Blue twice,
  // and so would a line for every colour beside Blue's own buttons.
  const overlap = await action(
    'SAVE_DRAFT',
    { materials: [...cur(), line({ colour: 'Blue', qtyPerPiece: 1.4 })] },
    409
  )
  const overlapBack = await action(
    'SAVE_DRAFT',
    { materials: [...cur(), line({ component: 'Front', itemId: 'sample-button', qtyPerPiece: 7 })] },
    409
  )
  // A step is done by its process's own department, as every routing is.
  const wrongDept = await action(
    'SAVE_DRAFT',
    {
      route: [
        step('EX-CUT'),
        step('OP-STI'),
        step('OP-EMB', { departmentId: finishingDept }),
        step('OP-FIN'),
      ],
    },
    409
  )
  check('a line of another round, a line twice, a colour off the grid or the style: refused', () => {
    assert.equal(foreign.body.code, 'NOT_THIS_ROUND')
    assert.equal(foreign.body.message, 'That material line is not on this round.')
    assert.equal(duplicate.body.code, 'DUPLICATE_MATERIAL')
    assert.equal(
      duplicate.body.message,
      'Line 6: Each material appears once for each part and colour.'
    )
    assert.equal(notRound.body.code, 'NOT_ROUND_COLOUR')
    assert.match(notRound.body.message, /^Line 6: Black is not one of this round/)
    assert.equal(notStyleColour.body.code, 'NOT_STYLE_COLOUR')
    assert.equal(wrongTailor.body.code, 'STEP_CONTRACTOR_MISMATCH')
  })
  check('a line for every colour and one for a colour of the same part and material: refused', () => {
    assert.equal(overlap.body.code, 'DUPLICATE_MATERIAL')
    assert.match(
      overlap.body.message,
      /^Line 6: The line for every colour already gives Blue this material for this part\./
    )
    assert.equal(overlapBack.body.code, 'DUPLICATE_MATERIAL')
    assert.match(overlapBack.body.message, /^Line 6: Blue already has its own line of this material/)
  })
  check('a step given another department than its process’s is refused, as a routing is', () => {
    assert.equal(wrongDept.body.code, 'STEP_DEPARTMENT_MISMATCH')
    assert.match(wrongDept.body.message, /^Step 3: Embroidery is an? .*operation, not Finishing\./)
  })
  // Typed by hand: a draft may leave the reason for later; release may not.
  await action('SAVE_DRAFT', {
    materials: [
      ...cur(),
      line({
        component: 'Spare',
        itemId: 'sample-fabric-2',
        requiredOverride: true,
        requiredQty: 1.5,
      }),
    ],
  })
  check('a quantity typed by hand is kept as typed', () => {
    assert.equal(cur()[5].requiredQty, 1.5)
    assert.equal(cur()[5].requiredOverride, true)
    assert.equal(+doc.rounds[0].materials[5].plannedQty, 1.5)
  })
  const details = {
    construction: 'Two colours, one set',
    techPackRef: 'EX-TP-2',
    patternRef: 'EX-PT-2',
  }
  const full = (over = {}) => ({ ...doc.rounds[0].specification, ...details, ...over })
  const refused = async (label, over, code, pattern) => {
    const res = await action('RELEASE', full(over), 400)
    check(label, () => {
      assert.equal(res.body.code, code, JSON.stringify(res.body))
      if (pattern) assert.match(res.body.message, pattern)
    })
  }
  await refused(
    'a quantity typed by hand needs its reason at release',
    {},
    'SPEC_INCOMPLETE',
    /typed by hand/
  )
  const withReason = cur().map((l, i) =>
    i === 5 ? { ...l, overrideReason: 'Buyer asked for a spare length' } : l
  )
  await refused(
    'a colour with no pieces is refused at release',
    {
      materials: withReason,
      colours: [
        doc.rounds[0].specification.colours[0],
        { colour: 'Blue', sizes: [{ sizeId: 'sample-size-M', qty: 0 }] },
      ],
    },
    'SPEC_INCOMPLETE',
    /Blue has no pieces/
  )
  await refused(
    'a size made with no measurement is refused',
    { materials: withReason, measurements: [chest[0]] },
    'SPEC_INCOMPLETE',
    /Add measurements for size L/
  )
  await refused(
    'a measurement of a size not made is refused',
    {
      materials: withReason,
      measurements: [...chest, { ...chest[0], sizeId: 'sample-size-S' }],
    },
    'SPEC_INCOMPLETE',
    /size S, which this round does not make/
  )
  await refused(
    'a quantity typed by hand still says how much one piece takes',
    { materials: withReason.map((l, i) => (i === 5 ? { ...l, qtyPerPiece: 0 } : l)) },
    'SPEC_INCOMPLETE',
    /Line 6: enter how much one piece takes/
  )
  await refused(
    'a line for every colour beside one for a colour is a gap at release',
    { materials: [...withReason, line({ colour: 'Blue', qtyPerPiece: 1.4 })] },
    'SPEC_INCOMPLETE',
    /Line 7: The line for every colour already gives Blue/
  )
  const withMaterials = (route) => ({ materials: withReason, route })
  await refused(
    'a route that does not start with cutting is refused',
    withMaterials([step('OP-STI'), step('EX-CUT'), step('OP-FIN')]),
    'CUTTING_FIRST'
  )
  await refused(
    'a route that cuts twice is refused',
    withMaterials([step('EX-CUT'), step('OP-STI'), step('EX-CUT', { name: 'Recut' })]),
    'ONE_CUTTING'
  )
  await refused(
    'a route with no stitching is refused',
    withMaterials([step('EX-CUT'), step('OP-FIN')]),
    'SPEC_INCOMPLETE',
    /stitching/
  )
  await refused(
    'a step done outside needs its unit',
    withMaterials([
      step('EX-CUT'),
      step('OP-STI'),
      step('OP-EMB', { execution: 'OUTSOURCED' }),
      step('OP-FIN'),
    ]),
    'SPEC_INCOMPLETE',
    /done outside\. Pick the unit/
  )
  await refused(
    'a contractor who does not take the process is refused',
    withMaterials([
      step('EX-CUT', { contractorId: 'sample-tailor' }),
      step('OP-STI'),
      step('OP-FIN'),
    ]),
    'STEP_CONTRACTOR_MISMATCH'
  )
  const routeOut = [
    step('EX-CUT'),
    step('OP-STI', { contractorId: 'sample-tailor', instructions: 'Single needle' }),
    step('OP-EMB', { execution: 'OUTSOURCED', vendorId: 'sample-embroidery-unit' }),
    step('OP-FIN'),
  ]
  const draftIds = cur().map((l) => l.id)
  const gridRelease = await action('RELEASE', full(withMaterials(routeOut)))
  const out = doc.rounds[0]
  const stageOf = (s) => [
    s.operationId,
    s.kind,
    s.departmentId,
    s.execution,
    s.contractorId,
    s.vendorId,
  ]
  check('release makes the route’s steps with who does each, and keeps the BOM rows', () => {
    assert.ok(gridRelease.body.warnings.some((w) => /no quality check/.test(w)))
    const dept = (c) => opOf[c].departmentId
    assert.deepEqual(out.stages.map(stageOf), [
      [opOf['EX-CUT'].id, 'CUTTING', dept('EX-CUT'), 'IN_HOUSE', null, null],
      [opOf['OP-STI'].id, 'STITCHING', dept('OP-STI'), 'IN_HOUSE', 'sample-tailor', null],
      [opOf['OP-EMB'].id, 'OTHER', dept('OP-EMB'), 'OUTSOURCED', null, 'sample-embroidery-unit'],
      [opOf['OP-FIN'].id, 'FINISHING', dept('OP-FIN'), 'IN_HOUSE', null, null],
    ])
    assert.equal(out.stages[1].instructions, 'Single needle')
    assert.deepEqual(
      out.materials.map((m) => m.id),
      draftIds
    )
    assert.equal(out.specification.materials[5].overrideReason, 'Buyer asked for a spare length')
  })
  await action('SAVE_DRAFT', { notes: 'Frozen now' }, 409)

  // A department a released step or a BOM line names is kept: Masters refuses
  // to delete it and says why, rather than blank the record.
  const spareDept = await db.department.create({
    data: {
      code: 'EX-DEL-' + stamp,
      name: 'Example department to delete ' + stamp,
      companyId: company.id,
    },
  })
  const [madeStep, madeLine] = [out.stages[0], out.materials[0]]
  await db.sampleStage.update({ where: { id: madeStep.id }, data: { departmentId: spareDept.id } })
  await db.sampleMaterial.update({ where: { id: madeLine.id }, data: { departmentId: spareDept.id } })
  const deptUses = await (
    await fetch(`${origin}/masters/departments/${spareDept.id}/delete-check`)
  ).json()
  const deptDelete = await fetch(`${origin}/masters/departments/${spareDept.id}?permanent=true`, {
    method: 'DELETE',
  })
  const deptRefusal = await deptDelete.json()
  const keptStep = await db.sampleStage.findUnique({ where: { id: madeStep.id } })
  const keptLine = await db.sampleMaterial.findUnique({ where: { id: madeLine.id } })
  await db.sampleStage.update({
    where: { id: madeStep.id },
    data: { departmentId: madeStep.departmentId },
  })
  await db.sampleMaterial.update({
    where: { id: madeLine.id },
    data: { departmentId: madeLine.departmentId },
  })
  const unusedDelete = await fetch(`${origin}/masters/departments/${spareDept.id}?permanent=true`, {
    method: 'DELETE',
  })
  check('a department a sample step or material line names is not deleted, and says why', () => {
    assert.deepEqual(deptUses.data.refuse, ['1 sample making step', '1 sample material line'])
    assert.equal(deptDelete.status, 409)
    assert.equal(deptRefusal.code, 'IN_USE')
    assert.match(deptRefusal.message, /1 sample making step/)
    assert.match(deptRefusal.message, /1 sample material line/)
    assert.equal(keptStep.departmentId, spareDept.id)
    assert.equal(keptLine.departmentId, spareDept.id)
    // Once nothing names it, it goes.
    assert.equal(unusedDelete.status, 200)
  })

  // The routings the request's style could take, and one of them as route rows.
  r = await call('GET', `/${doc.id}/routings`, undefined, viewOnly)
  const fullRouting = r.body.data.find((x) => x.id === 'sample-route-full')
  const rows = await call('GET', `/${doc.id}/routings/sample-route-full/steps`, undefined, viewOnly)
  const noRouting = await call('GET', `/${doc.id}/routings/missing-routing/steps`)
  const notAllowed = await call('GET', `/${doc.id}/routings`, undefined, 'inventory:view')
  check('the style’s routings are offered, and one comes back as route rows without rates', () => {
    assert.equal(r.status, 200)
    assert.equal(fullRouting.applies, 'STYLE')
    assert.equal(fullRouting.problem, null)
    assert.equal(fullRouting.steps, 5)
    assert.ok(r.body.data.some((x) => x.id === 'sample-route'))
    assert.deepEqual(
      rows.body.data.map((s) => s.kind),
      ['CUTTING', 'STITCHING', 'OTHER', 'FINISHING', 'QC']
    )
    assert.equal(rows.body.data[1].contractorId, 'sample-tailor')
    assert.equal(rows.body.data[2].execution, 'OUTSOURCED')
    assert.equal(rows.body.data[2].vendorId, 'sample-embroidery-unit')
    assert.equal(rows.body.data[0].name, opOf['EX-CUT'].name)
    assert.equal(
      rows.body.data.some((s) => 'ratePerPiece' in s),
      false
    )
    assert.equal(noRouting.status, 404)
    assert.equal(notAllowed.status, 403)
  })
  await action('CANCEL', 'Local grid check complete; nothing issued')

  // A round saved before the colour grid, put back as it was by raw SQL.
  doc = await openRequest(' saved before the colour grid')
  const legacy = {
    milestone: 'Old fit sample',
    styleId: 'sample-style',
    color: 'White',
    construction: 'As before',
    techPackRef: 'OLD-TP',
    patternRef: 'OLD-PT',
    sizes: [{ sizeId: 'sample-size-M', qty: 2 }],
    measurements: spec.measurements,
    stages: ['Cutting', 'Stitching', 'Finishing'],
    materials: [
      { itemId: 'sample-fabric', warehouseId: 'sample-store', qty: 5, ownership: 'OWNED' },
    ],
    notes: '',
  }
  const legacyRoundId = doc.rounds[0].id
  await db.$executeRaw`UPDATE ld_erp.sample_rounds SET specification = ${JSON.stringify(
    legacy
  )}::jsonb WHERE id = ${legacyRoundId}`
  doc = (await call('GET', `/${doc.id}`)).body.data
  const printedLegacy = (await call('GET', `/${doc.id}/print`, undefined, viewOnly)).body.data
  const readBack = doc.rounds[0].specification
  check('a round saved before the colour grid reads in the new shape', () => {
    assert.deepEqual(readBack.colours, [{ colour: 'White', sizes: legacy.sizes }])
    assert.deepEqual(
      readBack.route.map((s) => [s.name, s.kind, s.operationId]),
      [
        ['Cutting', 'CUTTING', ''],
        ['Stitching', 'STITCHING', ''],
        ['Finishing', 'FINISHING', ''],
      ]
    )
    assert.deepEqual(readBack.materials, [
      {
        component: '',
        itemId: 'sample-fabric',
        colour: null,
        departmentId: null,
        qtyPerPiece: 0,
        wastagePct: 0,
        requiredQty: 5,
        requiredOverride: true,
        overrideReason: 'Planned before the material table',
        source: 'PURCHASE',
        estRate: null,
        remarks: '',
      },
    ])
    assert.equal(readBack.color, undefined)
    assert.deepEqual(printedLegacy.request.rounds[0].specification, readBack)
  })
  await action('RELEASE', {}, 400)
  await action('SAVE_DRAFT', { notes: 'Opened after the colour grid' })
  const rewritten = (await db.sampleRound.findUnique({ where: { id: legacyRoundId } }))
    .specification
  const legacyRows = await db.sampleMaterial.findMany({ where: { roundId: legacyRoundId } })
  check('and is saved in the new shape, its material becoming a row', () => {
    for (const old of ['color', 'sizes', 'stages']) assert.equal(old in rewritten, false, old)
    assert.deepEqual(rewritten.colours, readBack.colours)
    assert.equal(legacyRows.length, 1)
    assert.equal(rewritten.materials[0].id, legacyRows[0].id)
    assert.equal(+legacyRows[0].plannedQty, 5)
    assert.equal(legacyRows[0].requiredOverride, true)
    assert.equal(legacyRows[0].warehouseId, null)
    assert.equal(rewritten.notes, 'Opened after the colour grid')
  })
  await action('CANCEL', 'Local legacy-shape check complete; nothing issued')

  // A material the tech pack names that we have never bought, added from the request.
  const quick = {
    name: 'Shell button 15L ' + stamp,
    type: 'TRIM',
    categoryId: 'sample-category-trims',
    uomId: pcs.id,
    standardRate: 2.5,
  }
  const quickViewOnly = await call('POST', '/items', quick, viewOnly)
  const quickPart = await call('POST', '/items', { ...quick, type: 'SEMI_FINISHED' }, merch)
  // A code typed by hand, or the item sent switched off, is ignored here.
  const quickMade = await call('POST', '/items', { ...quick, code: 'MY-OWN-1', isActive: false }, merch)
  const quickRow = await db.item.findUnique({
    where: { id: quickMade.body.data?.id ?? '' },
    select: { code: true, isActive: true },
  })
  const quickTwice = await call(
    'POST',
    '/items',
    { ...quick, name: ' ' + quick.name.toUpperCase() },
    merch
  )
  const quickAudit = await db.auditLog.findFirst({
    where: { entityType: 'Item', entityId: quickMade.body.data?.id },
  })
  check('a merchandiser adds a trim by the item master’s rules, coded from its category', () => {
    assert.equal(quickViewOnly.status, 403)
    assert.equal(quickPart.status, 400)
    assert.equal(quickPart.body.code, 'ITEM_TYPE_NOT_ALLOWED')
    assert.equal(quickMade.status, 201, JSON.stringify(quickMade.body))
    const made = quickMade.body.data
    assert.match(made.code, /^SAM-\d{3,}$/)
    assert.equal(quickRow.code, made.code)
    assert.equal(quickRow.isActive, true)
    assert.deepEqual(
      {
        type: made.type,
        uom: made.uom,
        standardRate: made.standardRate,
        departmentId: made.departmentId,
      },
      {
        type: 'TRIM',
        uom: { id: pcs.id, code: 'pcs', name: pcs.name, symbol: 'pcs' },
        standardRate: 2.5,
        departmentId: null,
      }
    )
    assert.equal(quickTwice.status, 400)
    assert.match(quickTwice.body.message, /already exists/)
    assert.equal(quickAudit.module, 'masters')
    assert.equal(quickAudit.action, 'CREATE')
    assert.equal(quickAudit.after.code, made.code)
  })
  const found = await call(
    'GET',
    `/items/search?q=${encodeURIComponent('shell BUTTON 15l ' + stamp)}`,
    undefined,
    viewOnly
  )
  const listed = await call('GET', '/items/search?limit=50', undefined, viewOnly)
  check('the BOM picker finds it, and lists only materials, trims, packing and consumables', () => {
    assert.deepEqual(
      found.body.data.map((x) => x.id),
      [quickMade.body.data.id]
    )
    assert.ok(listed.body.data.length > 0)
    for (const x of listed.body.data)
      assert.ok(['RAW_MATERIAL', 'TRIM', 'PACKING_MATERIAL', 'CONSUMABLE'].includes(x.type), x.type)
  })
  // Masters → Items adds by the same rules, and answers as it always has.
  res = await fetch(`${origin}/masters/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...quick, name: 'Masters trim ' + stamp }),
  })
  const mastersMade = await res.json()
  const mastersTwice = await fetch(`${origin}/masters/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...quick, name: 'masters TRIM ' + stamp }),
  })
  check('Masters → Items still adds an item with its category, unit and code', () => {
    assert.equal(res.status, 201, JSON.stringify(mastersMade))
    assert.match(mastersMade.data.code, /^SAM-\d{3,}$/)
    assert.equal(mastersMade.data.category.name, 'Sample Trims')
    assert.equal(mastersMade.data.uom.symbol, 'pcs')
    assert.ok('taxRate' in mastersMade.data)
    assert.equal(mastersTwice.status, 400)
  })

  // ── Phase 2 review fixes ────────────────────────────────────────────────────
  // The limits a round's text and chart keep, read from the schema itself.
  const schemas = require('../apps/api/src/schemas/sampling.schemas.ts')
  const firstIssue = (r) => (r.success ? '' : r.error.issues[0].message)
  const longPart = schemas.sampleDraftPatchSchema.safeParse({
    materials: [{ component: 'P'.repeat(61) }],
  })
  const longWords = schemas.sampleDraftPatchSchema.safeParse({
    route: [{ operationId: '', instructions: 'W'.repeat(501) }],
  })
  const longName = schemas.sampleDraftPatchSchema.safeParse({
    route: [{ operationId: '', name: 'N'.repeat(200) }],
  })
  const overChart = schemas.sampleDraftPatchSchema.safeParse({
    measurements: Array.from({ length: 6001 }, (_, i) => ({
      name: `P${i % 150}`,
      sizeId: `s${i}`,
      target: 1,
      tolerance: 0,
      unit: 'cm',
    })),
  })
  const overPoints = schemas.sampleDraftPatchSchema.safeParse({
    measurements: Array.from({ length: 201 }, (_, i) => ({
      name: `P${i}`,
      sizeId: 'm',
      target: 1,
      tolerance: 0,
      unit: 'cm',
    })),
  })
  const overQc = schemas.sampleQcSchema.safeParse({
    colours: [{ colour: 'White', actuals: Array(6001).fill(1), cells: [], notes: '' }],
    notes: 'Too many readings',
  })
  check('a round’s text keeps to the masters it becomes, and its chart limits are plain', () => {
    assert.equal(firstIssue(longPart), 'Keep this to 60 characters')
    assert.equal(firstIssue(longWords), 'Keep this to 500 characters')
    assert.equal(longName.success, true)
    assert.equal(
      firstIssue(overChart),
      'Up to 6000 measurement targets in one round (points × sizes). Use fewer points or sizes.'
    )
    assert.equal(firstIssue(overPoints), 'Up to 200 measurement points in one round.')
    assert.equal(firstIssue(overQc), 'Up to 6000 readings for one colour.')
  })

  // A full chart (101 points in two sizes: 202 targets) and a process named at
  // more than a step name used to take: saved, released and checked.
  const longOp = await db.operation.create({
    data: {
      code: 'EX-LONG-' + stamp,
      name:
        'Enzyme stone wash with silicone softener, tumble dry and hand finish for denim shirts ' +
        stamp,
      kind: 'OTHER',
      defaultExecution: 'IN_HOUSE',
      departmentId: opOf['OP-EMB'].departmentId,
      sortOrder: 990,
    },
  })
  const twoSizes = ['sample-size-M', 'sample-size-L']
  const bigChart = Array.from({ length: 101 }, (_, i) =>
    twoSizes.map((sizeId) => ({
      name: `Point ${i + 1}`,
      sizeId,
      target: 50,
      tolerance: 1,
      unit: 'cm',
    }))
  ).flat()
  const longStep = {
    operationId: longOp.id,
    name: '',
    kind: 'OTHER',
    departmentId: '',
    execution: 'IN_HOUSE',
    contractorId: null,
    vendorId: null,
    instructions: '',
  }
  const chartGrid = [{ colour: 'White', sizes: twoSizes.map((sizeId) => ({ sizeId, qty: 1 })) }]
  doc = await openRequest(' full chart and a long process name')
  await action('LINK_STYLE', { styleId: 'sample-style' })
  await action('SAVE_DRAFT', {
    colours: chartGrid,
    measurements: bigChart,
    route: [step('EX-CUT'), step('OP-STI'), longStep, step('OP-FIN')],
    materials: [line()],
  })
  // The step took the process's own long name; this save sends it back.
  await action('SAVE_DRAFT', { notes: 'Saved again with the long step name' })
  const chartDraft = doc.rounds[0].specification
  check('a chart of more than 200 targets and a long process name save as a draft', () => {
    assert.ok(longOp.name.length > 80)
    assert.equal(chartDraft.measurements.length, 202)
    assert.equal(chartDraft.route[2].name, longOp.name)
    assert.equal(chartDraft.notes, 'Saved again with the long step name')
  })
  await action('RELEASE', {
    ...spec,
    colours: chartGrid,
    measurements: chartDraft.measurements,
    route: chartDraft.route,
    materials: chartDraft.materials,
  })
  await stockSample()
  const chartRound = doc.rounds[0]
  await action('MATERIAL', {
    materialId: chartRound.materials[0].id,
    kind: 'ISSUE',
    qty: 5,
    reason: 'Material for the full chart',
    warehouseId: store,
  })
  await makeAll()
  await action('QC', qcData(undefined, 'Every point of the chart measured'))
  check('it is released with the long step name, and QC takes a reading for every target', () => {
    assert.equal(chartRound.stages[2].name, longOp.name)
    assert.equal(doc.rounds[0].state, 'QC_PASSED')
    assert.equal(doc.rounds[0].qc.results.length, 202)
  })
  await action('MATERIAL', {
    materialId: chartRound.materials[0].id,
    kind: 'RETURN',
    qty: 5,
    reason: 'Chart check: material back to the store',
  })
  await action('CANCEL', 'Local full-chart check complete; nothing kept')
  await db.operation.update({ where: { id: longOp.id }, data: { isActive: false } })

  // Masters switched off since they were picked: each save names the line,
  // and a new round clears a dead department back to the item's own.
  const offDept = await db.department.create({
    data: {
      code: 'EX-OFF-' + stamp,
      name: 'Example department switched off ' + stamp,
      companyId: company.id,
    },
  })
  const offTrim = (await call('POST', '/items', { ...quick, name: 'Trim switched off ' + stamp }, merch))
    .body.data
  doc = await openRequest(' masters switched off')
  await action('LINK_STYLE', { styleId: 'sample-style' })
  await action('SAVE_DRAFT', {
    colours: [{ colour: 'White', sizes: [{ sizeId: 'sample-size-M', qty: 2 }] }],
    materials: [
      line(),
      line({
        component: 'Packing',
        itemId: 'sample-polybag',
        qtyPerPiece: 1,
        departmentId: offDept.id,
      }),
      line({ component: 'Front', itemId: offTrim.id, qtyPerPiece: 6 }),
    ],
  })
  await db.department.update({ where: { id: offDept.id }, data: { isActive: false } })
  await db.item.update({ where: { id: offTrim.id }, data: { isActive: false } })
  const offDeptSave = await action('SAVE_DRAFT', { notes: 'Only the notes changed' }, 409)
  const deptCleared = doc.rounds[0].specification.materials.map((l, i) =>
    i === 1 ? { ...l, departmentId: null } : l
  )
  const offItemSave = await action('SAVE_DRAFT', { materials: deptCleared }, 409)
  check('a department or material switched off since is refused by its line', () => {
    assert.equal(offDeptSave.body.code, 'BAD_DEPARTMENT')
    assert.match(offDeptSave.body.message, /^Line 2: pick a department that is still in use/)
    assert.equal(offItemSave.body.code, 'ITEM_NOT_IN_USE')
    assert.match(offItemSave.body.message, /^Line 3: the material for Front is no longer in use/)
  })
  await db.sampleRound.update({
    where: { id: doc.rounds[0].id },
    data: { state: 'CHANGES_REQUIRED' },
  })
  doc = (await call('GET', `/${doc.id}`)).body.data
  await action('NEW_ROUND', 'Buyer asked for another fit')
  const carried = doc.rounds[0].specification.materials
  check('a new round takes the item’s own department for one switched off since', () => {
    assert.equal(doc.rounds[0].revision, 2)
    assert.equal(carried[1].departmentId, finishingDept)
    assert.equal(
      doc.rounds[0].materials.find((m) => m.id === carried[1].id).departmentId,
      finishingDept
    )
    // The material is carried as it was, for the editor to flag and the next save to refuse.
    assert.equal(carried[2].itemId, offTrim.id)
  })
  await action('CANCEL', 'Local masters check complete; nothing issued')

  console.log(`\n${passed} checks passed on local lderp_sampling. Shared database never accessed.`)
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
