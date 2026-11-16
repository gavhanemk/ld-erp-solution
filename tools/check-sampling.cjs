// HTTP + real PostgreSQL regression checks. No .env loading or shared data.
const assert = require('node:assert/strict')
process.env.DATABASE_URL ||= 'postgresql://postgres@127.0.0.1:55439/lderp_sampling?schema=ld_erp'
const target = new URL(process.env.DATABASE_URL)
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/lderp_sampling')
  throw Error('Sampling checks require local lderp_sampling')
process.env.DIRECT_URL = process.env.DATABASE_URL
process.env.SAMPLING_ENABLED = 'true'
process.env.NODE_ENV = 'test'
require('./register-ts.cjs')
require('express-async-errors')
const express = require('express')
const { prisma: db } = require('../packages/database/src/index.ts')
const routes = require('../apps/api/src/routes/sampling.routes.ts').default
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
  api.use((err, req, res, next) =>
    res
      .status(err.statusCode ?? (err instanceof ZodError ? 400 : 500))
      .json({ message: err.message, code: err.code })
  )
  server = api.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/sampling`
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
  })
