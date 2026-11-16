// Workflow presentation checks; no database, server or browser access.
require('./register-ts.cjs')
const assert = require('node:assert/strict')
const { sampleFlow, makingBlocker } = require('../apps/web/src/components/sampling/samplingFlow.ts')
let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('PASS ' + name)
}
const round = {
  id: 'round-1',
  revision: 1,
  state: 'DRAFT',
  specification: { stages: ['Cutting', 'Stitching', 'Finishing'] },
  stages: [],
  materials: [],
  qc: null,
  handover: null,
}
const request = { rounds: [round], cancelledAt: null, cancelReason: null }
check('draft opens technical preparation', () =>
  assert.equal(sampleFlow(request).section, 'Technical')
)
round.state = 'RELEASED'
round.stages = round.specification.stages.map((name, i) => ({
  id: String(i),
  name,
  completedAt: null,
  doneQty: null,
}))
round.materials = [
  { plannedQty: '5', issuedQty: '0', usedQty: '0', wasteQty: '0', returnedQty: '0' },
]
check('released sample opens material preparation before making', () =>
  assert.equal(sampleFlow(request).section, 'Materials')
)
check('future making forms are blocked', () => assert.match(makingBlocker(round, 1), /preceding/))
round.materials[0].issuedQty = '5'
check('issued material unlocks the first making step', () => {
  assert.equal(makingBlocker(round, 0), '')
  assert.match(sampleFlow(request).title, /cutting/)
})
round.materials[0].returnedQty = '5'
check('returned material cannot leave cutting available', () =>
  assert.equal(sampleFlow(request).section, 'Materials')
)
round.materials[0].returnedQty = '1'
round.stages[0].completedAt = '2026-11-14'
round.stages[0].doneQty = 2
check('surplus return after cutting does not block stitching', () => {
  assert.equal(makingBlocker(round, 1), '')
  assert.match(sampleFlow(request).title, /stitching/)
})
round.stages.forEach((s) => {
  s.completedAt = '2026-11-14'
  s.doneQty = 2
})
check('QC opens only after the making route is complete', () =>
  assert.equal(sampleFlow(request).section, 'Quality')
)
round.qc = { passed: false }
check('failed QC requests correction instead of buyer submission', () =>
  assert.match(sampleFlow(request).title, /QC findings/)
)
round.qc = { passed: true }
round.state = 'QC_PASSED'
check('passed QC guides buyer submission', () => assert.match(sampleFlow(request).title, /Submit/))
round.state = 'SUBMITTED'
check('pending buyer review has a waiting status', () =>
  assert.equal(sampleFlow(request).steps.find((s) => s.key === 'Buyer review').status, 'Waiting')
)
round.state = 'CHANGES_REQUIRED'
check('buyer changes guide a new round', () => assert.match(sampleFlow(request).title, /new round/))
round.state = 'APPROVED'
round.materials[0].usedQty = '4'
const earlier = {
  ...round,
  id: 'earlier',
  revision: 0,
  materials: [{ ...round.materials[0], usedQty: '0' }],
}
request.rounds.push(earlier)
check('handover guidance identifies unreconciled earlier rounds', () => {
  const flow = sampleFlow(request)
  assert.equal(flow.section, 'Materials')
  assert.equal(flow.targetRoundId, earlier.id)
})
earlier.materials[0].usedQty = '4'
check('reconciled approval unlocks handover guidance', () =>
  assert.equal(sampleFlow(request).section, 'Handover')
)
round.handover = { acceptedAt: null }
check('prepared handover waits for production acceptance', () =>
  assert.match(sampleFlow(request).title, /Awaiting production/)
)
round.handover.acceptedAt = '2026-11-14'
check('accepted handover marks all stages complete', () =>
  assert.ok(sampleFlow(request).steps.every((s) => s.status === 'Complete'))
)
request.cancelledAt = '2026-11-14'
request.cancelReason = 'Buyer withdrew request'
check('cancelled request has no current action stage', () => {
  const flow = sampleFlow(request)
  assert.equal(flow.section, 'History')
  assert.ok(flow.steps.every((s) => ['Complete', 'Closed'].includes(s.status)))
})
request.cancelledAt = null
round.state = 'RELEASED'
round.handover = null
round.qc = null
round.stages.at(-1).doneQty = 0
check('zero surviving pieces do not prompt an impossible QC action', () =>
  assert.match(sampleFlow(request).title, /No sample pieces/)
)
console.log(`${passed} Sampling UI workflow checks passed.`)
