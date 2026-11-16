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
  const spec = {
    milestone: 'Fit sample',
    styleId: 'sample-style',
    color: 'White',
    construction: 'Straight seam, inspect workmanship.',
    techPackRef: 'EXAMPLE-TECH-v1',
    patternRef: 'EXAMPLE-PATTERN-v1',
    sizes: [{ sizeId: 'sample-size-M', qty: 2 }],
    measurements: [
      { name: 'Chest', sizeId: 'sample-size-M', target: 50, tolerance: 0.5, unit: 'cm' },
    ],
    stages: ['Cutting', 'Stitching', 'Finishing'],
    materials: [
      { itemId: 'sample-fabric', warehouseId: 'sample-store', qty: 5, ownership: 'OWNED' },
    ],
    notes: 'Fictional local test only',
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
  await action('RELEASE', {}, 400)
  await action('SAVE_DRAFT', { construction: 'Work in progress' }, 403, 'sampling:view')
  await action('SAVE_DRAFT', {
    milestone: 'Early fit sample',
    construction: 'Work in progress',
    materials: [{ itemId: '', warehouseId: '', qty: 0, ownership: 'OWNED' }],
  })
  await action('SAVE_DRAFT', { techPackRef: 'Draft document reference' })
  r = await call('GET', `/${doc.id}`)
  check('partial draft persists across reopening without discarding earlier fields', () => {
    assert.equal(r.body.data.rounds[0].specification.construction, 'Work in progress')
    assert.equal(r.body.data.rounds[0].specification.techPackRef, 'Draft document reference')
    assert.equal(r.body.data.rounds[0].specification.materials[0].qty, 0)
    assert.equal(r.body.data.rounds[0].state, 'DRAFT')
  })
  await action('RELEASE', {}, 400)
  check('incomplete drafts create no material or making records', () => {
    assert.equal(doc.rounds[0].materials.length, 0)
    assert.equal(doc.rounds[0].stages.length, 0)
  })
  await action('SAVE_DRAFT', { styleId: 'missing-style' }, 409)
  await action(
    'SAVE_DRAFT',
    { materials: [{ itemId: 'missing-item', warehouseId: '', qty: 0, ownership: 'OWNED' }] },
    409
  )
  await action('SAVE_DRAFT', { sizes: [{ sizeId: '', qty: -1 }] }, 400)
  await action('SAVE_DRAFT', { state: 'APPROVED' }, 400)
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
  await action('UPDATE_REQUEST', requestEdit)
  await action('SAVE_SPEC', { ...spec, sizes: [...spec.sizes, ...spec.sizes] }, 400)
  await action('SAVE_SPEC', { ...spec, color: 'Not a style colour' }, 409)
  await action('SAVE_SPEC', spec)
  await action('RELEASE', {}, 403, 'sampling:view,sampling:edit')
  await action('RELEASE')
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
    assert.deepEqual(doc.rounds[0].specification, spec)
  })
  await action('SAVE_SPEC', spec, 409)
  let round = doc.rounds[0],
    mat = round.materials[0]
  await action(
    'STAGE',
    {
      stageId: round.stages[0].id,
      doneQty: 2,
      rejectedQty: 0,
      responsible: 'Cutter',
      reference: '',
      notes: 'Test cutting',
    },
    409
  )
  await action('MATERIAL', { materialId: mat.id, kind: 'ISSUE', qty: 6, reason: 'Too much' }, 409)
  await action(
    'MATERIAL',
    { materialId: mat.id, kind: 'ISSUE', qty: 5, reason: 'Issue for sample' },
    403,
    'sampling:view,sampling:edit'
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
  // Issuing needs inventory edit as well as sampling edit, and no desk below
  // Admin holds both, so until issuing from the Sample Store is reworked
  // (phase 4) only Admin issues sample material. Recorded here so the gap is
  // known rather than found in testing, and so a change to it is deliberate.
  const issueForSample = { materialId: mat.id, kind: 'ISSUE', qty: 5, reason: 'Issue for sample' }
  const merchIssue = await action('MATERIAL', issueForSample, 403, merchGrants.join(','))
  const storeIssue = await action('MATERIAL', issueForSample, 403, storeGrants.join(','))
  check('until phase 4 neither merchandiser nor store login can issue sample material', () => {
    assert.equal(merchIssue.body.code, 'FORBIDDEN')
    assert.match(merchIssue.body.message, /inventory edit/)
    assert.equal(storeIssue.status, 403)
  })
  const stock = await db.stockLedger.aggregate({
    where: { itemId: 'sample-fabric', warehouseId: 'sample-store' },
    _sum: { inQty: true, outQty: true },
  })
  await action('MATERIAL', {
    materialId: mat.id,
    kind: 'ISSUE',
    qty: 5,
    reason: 'Issue for sample',
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
  const stepData = {
    doneQty: 2,
    rejectedQty: 0,
    responsible: 'Example operator',
    reference: 'Test work',
    notes: 'All pieces accounted for',
  }
  await action('STAGE', { ...stepData, stageId: round.stages[1].id }, 409)
  await action('STAGE', { ...stepData, stageId: round.stages[0].id, doneQty: 3 }, 409)
  for (const stage of round.stages) await action('STAGE', { ...stepData, stageId: stage.id })
  await action('MATERIAL', { materialId: mat.id, kind: 'USE', qty: 4, reason: 'Four metres used' })
  await action(
    'MATERIAL',
    { materialId: mat.id, kind: 'RETURN', qty: 2, reason: 'Too much return' },
    409
  )
  await action('MATERIAL', { materialId: mat.id, kind: 'RETURN', qty: 1, reason: 'Unused metre' })
  const stockAfter = await db.stockLedger.aggregate({
    where: { itemId: 'sample-fabric', warehouseId: 'sample-store' },
    _sum: { inQty: true, outQty: true },
  })
  check('use is not deducted again; return restores original value', () => {
    assert.equal(+stockAfter._sum.outQty - +stock._sum.outQty, 5)
    assert.equal(+stockAfter._sum.inQty - +stock._sum.inQty, 1)
  })
  await action(
    'SUBMIT',
    { qty: 1, recipient: 'Buyer', reference: 'Signed slip', notes: 'One retained' },
    409
  )
  await action('QC', { actuals: [], passedQty: 2, notes: 'Missing measurements' }, 409)
  await action('QC', { actuals: [52], passedQty: 2, notes: 'Chest outside tolerance' })
  check('failed measurements do not release sample for submission', () =>
    assert.equal(doc.rounds[0].state, 'RELEASED')
  )
  await action('QC', {
    actuals: [50.2],
    passedQty: 2,
    notes: 'Measurements and workmanship accepted',
  })
  await action(
    'SUBMIT',
    { qty: 3, recipient: 'Buyer', reference: 'Signed slip', notes: 'Too many' },
    409
  )
  await action('SUBMIT', {
    qty: 1,
    recipient: 'Buyer',
    reference: 'EXAMPLE-SUBMISSION',
    notes: 'One retained by sample room',
  })
  await action(
    'DECIDE',
    {
      result: 'APPROVED',
      buyerName: 'Example buyer',
      evidence: 'EXAMPLE-EMAIL',
      conditions: 'Change collar',
    },
    409
  )
  await action('DECIDE', {
    result: 'CHANGES_REQUIRED',
    buyerName: 'Example buyer',
    evidence: 'EXAMPLE-EMAIL',
    conditions: 'Change collar',
  })
  const oldRound = doc.rounds[0]
  await action(
    'HANDOVER',
    { bomId: 'sample-bom', routingId: 'sample-route', notes: 'Cannot approve' },
    409
  )
  await action('NEW_ROUND', 'Revise collar after buyer feedback')
  await action('UPDATE_REQUEST', { ...requestEdit, customerId: null }, 409)
  check('new round preserves prior decision and frozen specification', () => {
    assert.equal(doc.rounds[0].revision, 2)
    assert.equal(doc.rounds[1].decision.conditions, 'Change collar')
    assert.deepEqual(doc.rounds[1].specification, spec)
  })
  await action('SAVE_SPEC', { ...spec, patternRef: 'EXAMPLE-PATTERN-v2' })
  await action('RELEASE')
  round = doc.rounds[0]
  mat = round.materials[0]
  await action('MATERIAL', {
    materialId: mat.id,
    kind: 'ISSUE',
    qty: 5,
    reason: 'Second sample round',
  })
  for (const stage of round.stages) await action('STAGE', { ...stepData, stageId: stage.id })
  await action('QC', { actuals: [50], passedQty: 2, notes: 'QC accepted' })
  await action('SUBMIT', {
    qty: 1,
    recipient: 'Buyer',
    reference: 'EXAMPLE-SUBMISSION-2',
    notes: 'One retained',
  })
  await action('DECIDE', {
    result: 'APPROVED',
    buyerName: 'Example buyer',
    evidence: 'Unconditional acceptance EXAMPLE-EMAIL-2',
    conditions: '',
  })
  await action(
    'HANDOVER',
    { bomId: 'sample-bom', routingId: 'sample-route', notes: 'Bulk package' },
    409
  )
  await action('MATERIAL', {
    materialId: mat.id,
    kind: 'USE',
    qty: 5,
    reason: 'Accounted sample consumption',
  })
  await action(
    'HANDOVER',
    { bomId: 'missing', routingId: 'sample-route', notes: 'Bulk package' },
    409
  )
  await action('HANDOVER', {
    bomId: 'sample-bom',
    routingId: 'sample-route',
    notes: 'Approved pattern v2 and technical pack v1',
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
    materials: spec.materials.map((x) => ({ ...x, ownership: 'CUSTOMER_OWNED' })),
  })
  await action('RELEASE')
  mat = doc.rounds[0].materials[0]
  await action(
    'MATERIAL',
    { materialId: mat.id, kind: 'ISSUE', qty: 5, reason: 'Buyer owns no stock here' },
    400
  )
  check('buyer-owned issue cannot draw our stock', () =>
    assert.equal(+doc.rounds[0].materials[0].issuedQty, 0)
  )
  await action('CANCEL', 'No buyer material available; nothing issued')
  const cancelWithStock = await call('POST', '', {
    ...payload,
    clientKey: crypto.randomUUID(),
    title: title + ' reconciliation',
  })
  doc = cancelWithStock.body.data
  await action('RELEASE', spec)
  mat = doc.rounds[0].materials[0]
  await action('MATERIAL', {
    materialId: mat.id,
    kind: 'ISSUE',
    qty: 5,
    reason: 'Issued to sample room',
  })
  await action('CANCEL', 'Cannot cancel while material remains held', 409)
  await action('MATERIAL', {
    materialId: mat.id,
    kind: 'RETURN',
    qty: 5,
    reason: 'All unused material returned',
  })
  await action('STAGE', { ...stepData, stageId: doc.rounds[0].stages[0].id }, 409)
  await action('CANCEL', 'No pieces made; all material returned')
  check('cancellation does not delete material or event history', () =>
    assert.equal(doc.rounds[0].materials.length, 1)
  )

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
    sizes: [
      { sizeId: 'sample-size-M', qty: 1 },
      { sizeId: 'sample-size-L', qty: 1 },
    ],
    measurements: [
      ...spec.measurements,
      { ...spec.measurements[0], sizeId: 'sample-size-L', target: 51 },
    ],
  })
  const setRound = doc.rounds[0]
  mat = setRound.materials[0]
  await action('MATERIAL', {
    materialId: mat.id,
    kind: 'ISSUE',
    qty: 5,
    reason: 'Material for size set',
  })
  await action(
    'STAGE',
    { ...stepData, stageId: setRound.stages[0].id, doneQty: 1, rejectedQty: 1 },
    409
  )
  for (const stage of setRound.stages) await action('STAGE', { ...stepData, stageId: stage.id })
  await action('QC', { actuals: [50, 51], passedQty: 1, notes: 'Partial size set' }, 409)
  await action('QC', { actuals: [50, 51], passedQty: 2, notes: 'All sizes inspected' })
  await action(
    'SUBMIT',
    { qty: 1, recipient: 'Buyer', reference: 'EXAMPLE-SET', notes: 'Partial set' },
    409
  )
  await action('SUBMIT', {
    qty: 2,
    recipient: 'Buyer',
    reference: 'EXAMPLE-SET',
    notes: 'Complete set',
  })
  await action('DECIDE', {
    result: 'CHANGES_REQUIRED',
    buyerName: 'Example buyer',
    evidence: 'EXAMPLE-FEEDBACK',
    conditions: 'Revise fit',
  })
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
  /** A version one behind, as a second window would send it: refused, nothing changed. */
  const staleRefused = async (actionName, data) => {
    const before = doc.version
    const r = await call('POST', `/${doc.id}/actions`, {
      version: doc.version - 1,
      action: actionName,
      data,
    })
    assert.equal(r.status, 409, `${actionName}: ${JSON.stringify(r.body)}`)
    assert.equal(r.body.code, 'STALE_SAMPLE')
    assert.equal((await db.sampleRequest.findUnique({ where: { id: doc.id } })).version, before)
    passed++
    console.log('PASS ' + actionName + ' from a stale window refused atomically')
  }
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
  await action('SAVE_DRAFT', {
    color: 'Navy',
    sizes: [{ sizeId: 'sample-size-M', qty: 2 }],
    measurements: [{ ...spec.measurements[0] }],
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
    assert.equal(doc.rounds[0].specification.color, '')
    assert.deepEqual(doc.rounds[0].specification.sizes, [{ sizeId: 'sample-size-M', qty: 2 }])
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
  await action('SAVE_DRAFT', { color: 'Navy' })

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
  await action('UPDATE_STYLE', { sizeGroupId: 'sample-chest-sizes' })
  check('a size run changed before release drops sizes the draft can no longer use', () => {
    assert.equal(doc.style.sizeGroupId, 'sample-chest-sizes')
    assert.deepEqual(doc.rounds[0].specification.sizes, [])
    assert.deepEqual(doc.rounds[0].specification.measurements, [])
    assert.equal(doc.rounds[0].specification.color, 'Navy')
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
    color: 'Navy',
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
  await db.sampleRound.update({ where: { id: releasedRound.id }, data: { state: 'APPROVED' } })
  doc = (await call('GET', `/${doc.id}`)).body.data
  const noHandover = await action(
    'HANDOVER',
    { bomId: 'sample-bom', routingId: 'sample-route', notes: 'Bulk package' },
    409
  )
  await db.sampleRound.update({ where: { id: releasedRound.id }, data: { state: 'RELEASED' } })
  doc = (await call('GET', `/${doc.id}`)).body.data
  check('a style made in sampling is not handed over, and the refusal says why', () => {
    assert.equal(noHandover.body.code, 'STYLE_IN_DEVELOPMENT')
    assert.match(noHandover.body.message, /later update/)
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
