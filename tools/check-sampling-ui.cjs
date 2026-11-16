// Workflow presentation checks; no database, server or browser access.
require('./register-ts.cjs')
const assert = require('node:assert/strict')
const {
  sampleFlow,
  makingBlocker,
  SAMPLE_SECTIONS,
  STYLE_FIXED_TEXT,
  styleRules,
  withRequestStyle,
  addColours,
  fileCounts,
  fileScope,
  filesFullText,
  draftLoss,
  eventLabel,
  eventNote,
  styleChanges,
} = require('../apps/web/src/components/sampling/samplingFlow.ts')
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
// The request has its style here; a request without one is checked further down.
const request = { styleId: 'style-1', rounds: [round], cancelledAt: null, cancelReason: null }
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

// ── Request & tech pack (phase 1) ──────────────────────────────────────────
const draft = (styleId = '', color = '') => ({
  id: 'draft',
  revision: 1,
  state: 'DRAFT',
  specification: { styleId, color, stages: ['Cutting', 'Stitching'] },
  stages: [],
  materials: [],
  qc: null,
  handover: null,
})
check('the first section is named Request & tech pack', () =>
  assert.equal(SAMPLE_SECTIONS[0].title, 'Request & tech pack')
)
check('a new request without a style opens Request & tech pack', () => {
  const flow = sampleFlow({ styleId: null, rounds: [draft()], cancelledAt: null })
  assert.equal(flow.section, 'Brief')
  assert.match(flow.title, /tech pack/)
  assert.equal(flow.steps.find((s) => s.key === 'Brief').status, 'Current')
  assert.equal(flow.steps.find((s) => s.key === 'Technical').status, 'Upcoming')
})
check('a draft whose request has its style goes on to the specification', () => {
  const flow = sampleFlow({ styleId: 'dev', rounds: [draft('dev')], cancelledAt: null })
  assert.equal(flow.section, 'Technical')
  assert.equal(flow.steps.find((s) => s.key === 'Brief').status, 'Complete')
})
check('a released legacy request without a style is not sent back to the brief', () => {
  const released = { ...draft('old'), state: 'RELEASED', stages: [{ completedAt: null }] }
  released.materials = [{ plannedQty: '1', issuedQty: '0', returnedQty: '0' }]
  assert.equal(
    sampleFlow({ styleId: null, rounds: [released], cancelledAt: null }).section,
    'Materials'
  )
})
const devStyle = {
  id: 'dev',
  code: 'EX-SH-2701',
  name: 'Poplin shirt',
  stage: 'DEVELOPMENT',
  brandId: 'brand',
  category: 'Shirt',
  season: 'SS-27',
  sizeGroupId: 'run-a',
  colors: ['White', 'Navy'],
  isActive: true,
}
check('an open request may make, change and edit its development style', () => {
  const rules = styleRules({ style: devStyle, rounds: [draft('dev', 'White')], cancelledAt: null })
  assert.deepEqual(
    [rules.fixed, rules.editBlocked, rules.sizeRunFixed, rules.sampledColours],
    ['', '', '', []]
  )
})
check('a production style is changed in the Styles master, not from sampling', () =>
  assert.match(
    styleRules({
      style: { ...devStyle, stage: 'PRODUCTION' },
      rounds: [draft()],
      cancelledAt: null,
    }).editBlocked,
    /Masters → Styles/
  )
)
check('a released round fixes the style, its size run and the colour it was made in', () => {
  const made = { ...draft('dev', 'navy'), id: 'made', state: 'RELEASED' }
  const rules = styleRules({ style: devStyle, rounds: [draft('dev'), made], cancelledAt: null })
  assert.equal(rules.fixed, STYLE_FIXED_TEXT)
  assert.equal(rules.editBlocked, '')
  assert.match(rules.sizeRunFixed, /EX-SH-2701/)
  assert.deepEqual(rules.sampledColours, ['navy'])
})
check('a cancelled or handed-over request offers no style action', () => {
  const cancelled = styleRules({ style: devStyle, rounds: [draft()], cancelledAt: '2026-11-16' })
  assert.match(cancelled.fixed, /cancelled/)
  assert.match(cancelled.editBlocked, /cancelled/)
  const handed = styleRules({
    style: devStyle,
    rounds: [{ ...draft('dev'), state: 'APPROVED', handover: {} }],
    cancelledAt: null,
  })
  assert.match(handed.fixed, /handover/)
  assert.match(handed.editBlocked, /handover/)
})
check('lookups carry the request’s style as it is now', () => {
  const lookups = { styles: [{ ...devStyle, colors: ['White'] }], sizes: [] }
  assert.deepEqual(withRequestStyle(lookups, devStyle).styles[0].colors, ['White', 'Navy'])
  assert.equal(withRequestStyle({ styles: [], sizes: [] }, devStyle).styles[0].code, 'EX-SH-2701')
  assert.equal(withRequestStyle(lookups, null), lookups)
})
check('colours are added once each, however they are capitalised', () => {
  assert.deepEqual(addColours(['White'], ' Navy, Sky Blue ,').colours, [
    'White',
    'Navy',
    'Sky Blue',
  ])
  const twice = addColours(['White'], 'white')
  assert.deepEqual(twice.colours, ['White'])
  assert.match(twice.problem, /already listed/)
  const full = Array.from({ length: 30 }, (_, i) => `C${i}`)
  assert.match(addColours(full, 'One more').problem, /30 colours/)
})
check('files are counted by kind and named by what they are filed against', () => {
  const counts = fileCounts([{ kind: 'TECH_PACK' }, { kind: 'PHOTO' }, { kind: 'TECH_PACK' }])
  assert.equal(counts.TECH_PACK, 2)
  assert.equal(counts.PHOTO, 1)
  assert.equal(counts.DISPATCH, 0)
  const rounds = [{ id: 'r2', revision: 2 }]
  assert.equal(fileScope({ roundId: null }, rounds), 'Whole request')
  assert.equal(fileScope({ roundId: 'r2' }, rounds), 'Round 2')
})
check('history reads file and style actions in words', () => {
  assert.equal(eventLabel('CREATE_STYLE'), 'Development style created')
  const at = (action, data) => ({ id: '1', action, createdAt: '', detail: { data } })
  const rounds = [{ id: 'r1', revision: 1 }]
  assert.equal(
    eventNote(at('ATTACH', { fileName: 'pack.pdf', kind: 'TECH_PACK', roundId: null }), rounds),
    'pack.pdf · Tech pack · Whole request'
  )
  assert.equal(
    eventNote(at('LINK_STYLE', { before: null, after: { code: 'EX-SH-2701' } }), rounds),
    'No style → EX-SH-2701'
  )
  assert.deepEqual(
    styleChanges(
      { name: 'A', colors: ['White'], sizeGroupId: 'run-a' },
      { name: 'A', colors: ['White', 'Navy'], sizeGroupId: 'run-b' },
      (id) => id.toUpperCase()
    ),
    ['Size run: RUN-A → RUN-B', 'Colours: White → White, Navy']
  )
})

// ── Phase 1 review fixes ────────────────────────────────────────────────────
check('a request released before it named its style is offered that style back', () => {
  const made = { ...draft('old', 'White'), id: 'made', revision: 1, state: 'CHANGES_REQUIRED' }
  const next = { ...draft('old', 'White'), id: 'next', revision: 2 }
  const legacy = { styleId: null, style: null, rounds: [next, made], cancelledAt: null }
  const rules = styleRules(legacy)
  assert.equal(rules.releasedStyleId, 'old')
  assert.equal(rules.fixed, STYLE_FIXED_TEXT)
  assert.equal(rules.closed, '')
  const flow = sampleFlow(legacy)
  assert.equal(flow.section, 'Brief')
  assert.match(flow.title, /Confirm the style/)
  // A request with its own style has nothing to be offered back.
  assert.equal(styleRules({ ...legacy, style: devStyle }).releasedStyleId, '')
})
check('an approved round of a style made in sampling is kept, not handed over', () => {
  const approved = { ...draft('dev', 'White'), state: 'APPROVED' }
  const flow = sampleFlow({ styleId: 'dev', style: devStyle, rounds: [approved], cancelledAt: null })
  assert.equal(flow.section, 'Handover')
  assert.match(flow.title, /record/)
  assert.match(flow.description, /EX-SH-2701 is a new style made in sampling/)
  const resample = sampleFlow({
    styleId: 'dev',
    style: { ...devStyle, stage: 'PRODUCTION' },
    rounds: [approved],
    cancelledAt: null,
  })
  assert.match(resample.title, /production package/)
})
check('changing the style says first what the draft would lose', () => {
  const sizes = [
    { id: 'm', sizeGroupId: 'run-a' },
    { id: 'l', sizeGroupId: 'run-a' },
    { id: '40', sizeGroupId: 'run-b' },
  ]
  const round = draft('dev', 'Navy')
  round.specification.sizes = [
    { sizeId: 'm', qty: 1 },
    { sizeId: 'l', qty: 1 },
    { sizeId: '', qty: 0 },
  ]
  round.specification.measurements = [
    { name: 'Chest', sizeId: 'm' },
    { name: 'Chest', sizeId: 'l' },
  ]
  const request = { rounds: [round] }
  assert.equal(draftLoss(request, { colors: ['navy'], sizeGroupId: 'run-a' }, sizes), '')
  assert.equal(
    draftLoss(request, { colors: ['White'], sizeGroupId: 'run-b' }, sizes),
    'Round 1’s colour Navy, 2 sizes and 2 measurement points will be cleared.'
  )
  assert.equal(
    draftLoss(request, null, sizes),
    'Round 1’s colour Navy, 2 sizes and 2 measurement points will be cleared.'
  )
  assert.equal(
    draftLoss(request, { colors: ['White', 'Navy'], sizeGroupId: 'run-b' }, sizes),
    'Round 1’s 2 sizes and 2 measurement points will be cleared.'
  )
  assert.equal(draftLoss({ rounds: [{ ...round, state: 'RELEASED' }] }, null, sizes), '')
})
check('five files of a kind fit the whole request and each round, said plainly when full', () => {
  const rounds = [{ id: 'r2', revision: 2 }]
  const five = (roundId, removable) =>
    Array.from({ length: 5 }, () => ({ kind: 'PHOTO', roundId, removable }))
  assert.equal(filesFullText(five('r2', false), 'PHOTO', '', rounds), '')
  assert.equal(filesFullText(five('r2', false), 'TECH_PACK', 'r2', rounds), '')
  assert.match(
    filesFullText(five('r2', false), 'PHOTO', 'r2', rounds),
    /^Round 2 already has 5 photo files, kept as the record of what was made\. File the new one against the whole request or a later round\.$/
  )
  const oneRemovable = [
    ...five(null, false).slice(1),
    { kind: 'PHOTO', roundId: null, removable: true },
  ]
  assert.match(
    filesFullText(oneRemovable, 'PHOTO', '', rounds),
    /^The whole request already has 5 photo files\. Remove one/
  )
})
console.log(`${passed} Sampling UI workflow checks passed.`)
