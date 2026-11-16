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
const flow = require('../apps/web/src/components/sampling/samplingFlow.ts')
let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('PASS ' + name)
}
// A route of named processes, as the editor saves it: cutting, stitching, finishing, then others.
const routeOf = (...names) =>
  names.map((name, i) => ({
    operationId: `op-${i}`,
    name,
    kind: ['CUTTING', 'STITCHING', 'FINISHING'][i] ?? 'OTHER',
    departmentId: 'dept',
    execution: 'IN_HOUSE',
    contractorId: null,
    vendorId: null,
    instructions: '',
  }))
// A saved specification in today's shape (spec v2).
const specOf = (over = {}) => ({
  milestone: 'Proto',
  styleId: '',
  construction: '',
  techPackRef: '',
  patternRef: '',
  colours: [],
  measurements: [],
  route: routeOf('Cutting', 'Stitching', 'Finishing'),
  materials: [],
  notes: '',
  ...over,
})
const round = {
  id: 'round-1',
  revision: 1,
  state: 'DRAFT',
  // One colour in one size: two pieces, one cell.
  specification: specOf({ colours: [{ colour: 'White', sizes: [{ sizeId: 'm', qty: 2 }] }] }),
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
round.stages = round.specification.route.map((s, i) => ({
  id: String(i),
  name: s.name,
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
const draft = (styleId = '', colour = '') => ({
  id: 'draft',
  revision: 1,
  state: 'DRAFT',
  specification: specOf({
    styleId,
    colours: colour ? [{ colour, sizes: [] }] : [],
    route: routeOf('Cutting', 'Stitching'),
  }),
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
    { id: 'm', code: 'M', sizeGroupId: 'run-a' },
    { id: 'l', code: 'L', sizeGroupId: 'run-a' },
    { id: '40', code: '40', sizeGroupId: 'run-b' },
  ]
  const round = draft('dev')
  // Navy 1 M + 2 L, White 1 M (and L ticked), and a row whose colour is not picked yet.
  round.specification.colours = [
    {
      colour: 'Navy',
      sizes: [
        { sizeId: 'm', qty: 1 },
        { sizeId: 'l', qty: 2 },
      ],
    },
    {
      colour: 'White',
      sizes: [
        { sizeId: 'm', qty: 1 },
        { sizeId: 'l', qty: 0 },
      ],
    },
    { colour: '', sizes: [{ sizeId: '', qty: 0 }] },
  ]
  round.specification.measurements = [
    { name: 'Chest', sizeId: 'm' },
    { name: 'Chest', sizeId: 'l' },
    { name: 'Sleeve', sizeId: '' },
  ]
  // The rows decide once the round has any: one line for every colour, two Navy-only, one White.
  round.materials = [{ colour: null }, { colour: 'Navy' }, { colour: 'navy' }, { colour: 'White' }]
  round.specification.materials = [{ colour: 'White' }]
  const request = { rounds: [round] }
  assert.equal(draftLoss(request, { colors: ['navy', 'WHITE'], sizeGroupId: 'run-a' }, sizes), '')
  // A colour the style lacks goes with its pieces and its own lines; lines for every colour stay.
  assert.equal(
    draftLoss(request, { colors: ['White'], sizeGroupId: 'run-a' }, sizes),
    'Round 1’s draft will lose colour Navy (3 pieces); 2 material lines for Navy.'
  )
  // Another size run: the colours that stay lose their sizes, and the measurements on them.
  assert.equal(
    draftLoss(request, { colors: ['White', 'Navy'], sizeGroupId: 'run-b' }, sizes),
    'Round 1’s draft will lose sizes M and L; 2 measurements.'
  )
  // No style: every named colour goes, so do all their own lines.
  assert.equal(
    draftLoss(request, null, sizes),
    'Round 1’s draft will lose colours Navy and White (4 pieces); 2 measurements; 3 material lines for Navy and White.'
  )
  // Sizes without codes are counted instead.
  assert.equal(
    draftLoss(
      request,
      { colors: ['White', 'Navy'], sizeGroupId: 'run-b' },
      sizes.map(({ code, ...z }) => z)
    ),
    'Round 1’s draft will lose 2 sizes; 2 measurements.'
  )
  // A draft never saved since the rows came reads its own lines.
  const unsaved = { ...round, materials: [] }
  assert.equal(
    draftLoss({ rounds: [unsaved] }, { colors: ['Navy'], sizeGroupId: 'run-a' }, sizes),
    'Round 1’s draft will lose colour White (1 piece); 1 material line for White.'
  )
  assert.equal(draftLoss({ rounds: [{ ...round, state: 'RELEASED' }] }, null, sizes), '')
})
check('what a style change cleared is said in the history', () => {
  const at = (action, data) => ({ id: '1', action, createdAt: '', detail: { data } })
  const refit = [
    {
      revision: 2,
      coloursDropped: 1,
      sizesDropped: 2,
      measurementsDropped: 4,
      materialsDropped: 1,
    },
  ]
  assert.equal(
    flow.refitText(refit),
    'Round 2’s draft lost 1 colour, 2 size quantities, 4 measurements and 1 material line.'
  )
  // A refit that cleared nothing says nothing.
  assert.equal(
    flow.refitText([
      {
        revision: 1,
        coloursDropped: 0,
        sizesDropped: 0,
        measurementsDropped: 0,
        materialsDropped: 0,
      },
    ]),
    ''
  )
  assert.equal(flow.refitText(undefined), '')
  assert.equal(
    eventNote(at('LINK_STYLE', { before: { code: 'A' }, after: { code: 'B' }, refit }), []),
    'A → B · Round 2’s draft lost 1 colour, 2 size quantities, 4 measurements and 1 material line.'
  )
  assert.equal(
    eventNote(
      at('NEW_ROUND', { fromRevision: 1, reason: 'Buyer wants a longer body', materials: 3 }),
      []
    ),
    'From round 1 · 3 material lines carried over · Reason: Buyer wants a longer body'
  )
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

// ── Specification editor (phase 2): specRules ─────────────────────────────
const spec2 = require('../apps/web/src/components/sampling/specRules.ts')
const shared = require('@ld-erp/shared')
const run = ['s', 'm', 'l', 'xl']
const step = (operationId, name, kind, extra = {}) => ({
  operationId,
  name,
  kind,
  departmentId: `dept-${kind.toLowerCase()}`,
  execution: 'IN_HOUSE',
  contractorId: null,
  vendorId: null,
  instructions: '',
  ...extra,
})
const bom = (over) => ({
  component: '',
  itemId: '',
  colour: null,
  departmentId: null,
  qtyPerPiece: 0,
  wastagePct: 0,
  requiredQty: 0,
  requiredOverride: false,
  overrideReason: '',
  source: 'PURCHASE',
  estRate: null,
  remarks: '',
  ...over,
})
// Two colours: White 2 M + 1 L, Navy 1 M + 0 L. Four pieces, three cells.
const sample = () => ({
  milestone: 'Fit sample',
  styleId: 'dev',
  construction: 'Single-needle side seams',
  techPackRef: 'TP-27-01',
  patternRef: 'PAT v2',
  colours: [
    {
      colour: 'White',
      sizes: [
        { sizeId: 'm', qty: 2 },
        { sizeId: 'l', qty: 1 },
      ],
    },
    {
      colour: 'Navy',
      sizes: [
        { sizeId: 'm', qty: 1 },
        { sizeId: 'l', qty: 0 },
      ],
    },
  ],
  measurements: [
    { name: 'Chest', sizeId: 'm', target: 52, tolerance: 1, unit: 'cm' },
    { name: 'Chest', sizeId: 'l', target: 54, tolerance: 1, unit: 'cm' },
    { name: 'Length', sizeId: 'm', target: 74.5, tolerance: 1.5, unit: 'cm' },
  ],
  route: [
    step('op-cut', 'Cutting', 'CUTTING'),
    step('op-sti', 'Stitching', 'STITCHING'),
    step('op-emb', 'Embroidery', 'OTHER', { execution: 'OUTSOURCED', vendorId: 'sup-emb' }),
    step('op-qc', 'Checking', 'QC'),
  ],
  materials: [
    // 4 pieces × round4(1.25 × 1.04) = 4 × 1.3
    bom({
      id: 'row-1',
      component: 'Body',
      itemId: 'fab',
      departmentId: 'dept-cutting',
      qtyPerPiece: 1.25,
      wastagePct: 4,
      requiredQty: 5.2,
      estRate: 180,
    }),
    // Navy only: 1 piece × 7
    bom({
      id: 'row-2',
      component: 'Placket',
      itemId: 'btn',
      colour: 'Navy',
      qtyPerPiece: 7,
      requiredQty: 7,
    }),
    bom({
      id: 'row-3',
      component: 'Neck',
      itemId: 'lab',
      colour: 'White',
      qtyPerPiece: 1,
      requiredOverride: true,
      requiredQty: 10,
      overrideReason: 'Minimum order of labels',
      estRate: 2.5,
    }),
  ],
  notes: '',
})
const ctxOf = (hasBuyer = true) => ({
  style: { colors: ['White', 'Navy', 'Sky'], sizeIds: run },
  sizes: run.map((id) => ({ id, code: id.toUpperCase() })),
  hasBuyer,
})
check('the editor keeps a saved round exactly as the server has it', () => {
  const s = sample()
  const draft = spec2.fromSpec(s, { runSizeIds: run })
  assert.deepEqual(draft.sizeIds, ['m', 'l'])
  assert.deepEqual(spec2.toSpec(draft), s)
  // Every line goes back with its own row id.
  assert.deepEqual(
    spec2.toSpec(draft).materials.map((m) => m.id),
    ['row-1', 'row-2', 'row-3']
  )
  // Opened and not touched is no change: the editor reads the saved round the same way.
  const saved = spec2.toSpec(spec2.fromSpec(s, { runSizeIds: run }))
  assert.deepEqual(spec2.changedTabs(spec2.toSpec(draft), saved), {
    style: false,
    measurements: false,
    materials: false,
    route: false,
    review: false,
  })
})
check('a round with no colours yet starts with the whole size run switched on', () => {
  const draft = spec2.fromSpec({ ...sample(), colours: [] }, { runSizeIds: run })
  assert.deepEqual(draft.sizeIds, run)
  assert.deepEqual(spec2.toSpec(draft).colours, [])
  // A save keeps the sizes switched on while there is still no colour.
  const kept = spec2.fromSpec(
    { ...sample(), colours: [] },
    { runSizeIds: run, previous: { ...draft, sizeIds: ['m'] } }
  )
  assert.deepEqual(kept.sizeIds, ['m'])
})
check('rows keep their keys through a save, so the cursor stays put', () => {
  const before = spec2.fromSpec(sample(), { runSizeIds: run })
  const after = spec2.fromSpec(sample(), { runSizeIds: run, previous: before })
  assert.deepEqual(
    after.lines.map((l) => l.key),
    before.lines.map((l) => l.key)
  )
  assert.deepEqual(
    after.route.map((s) => s.key),
    before.route.map((s) => s.key)
  )
  assert.deepEqual(
    after.points.map((p) => p.key),
    before.points.map((p) => p.key)
  )
})
check('grid totals are the shared count of pieces', () => {
  const draft = spec2.fromSpec(sample(), { runSizeIds: run })
  const t = spec2.gridTotals(draft)
  assert.deepEqual(t.rows, [3, 1])
  assert.deepEqual(t.cols, { m: 3, l: 1 })
  assert.equal(t.total, 4)
  assert.equal(t.total, shared.totalPieces(spec2.toSpec(draft)))
  assert.deepEqual(spec2.gridColumns(run, draft.sizeIds), [
    { sizeId: 's', on: false, inRun: true },
    { sizeId: 'm', on: true, inRun: true },
    { sizeId: 'l', on: true, inRun: true },
    { sizeId: 'xl', on: false, inRun: true },
  ])
  // A size from outside the run (an old round's) shows at the end, to take off.
  assert.deepEqual(spec2.gridColumns(run, ['m', 'old']).at(-1), {
    sizeId: 'old',
    on: true,
    inRun: false,
  })
})
check('pieces are whole numbers from 0 to 1000', () => {
  let draft = spec2.fromSpec(sample(), { runSizeIds: run })
  draft = spec2.setPieces(draft, 1, 'l', '2500')
  assert.equal(draft.colours[1].qty.l, 1000)
  draft = spec2.setPieces(draft, 1, 'l', '')
  assert.equal(draft.colours[1].qty.l, 0)
})
check(
  'a size switched on takes its place in the run; switched off it takes its pieces and targets',
  () => {
    let draft = spec2.fromSpec(sample(), { runSizeIds: run })
    draft = spec2.addSize(draft, 's', run)
    assert.deepEqual(draft.sizeIds, ['s', 'm', 'l'])
    assert.deepEqual(
      spec2.toSpec(draft).colours[0].sizes.map((z) => z.sizeId),
      ['s', 'm', 'l']
    )
    assert.deepEqual(spec2.sizeRemoval(draft, 'm'), { pieces: 3, targets: 2 })
    assert.equal(
      spec2.sizeRemovalText('M', spec2.sizeRemoval(draft, 'm')),
      'Size M has 3 pieces and 2 measurement targets. Taking the size off this round clears them.'
    )
    assert.equal(spec2.sizeRemovalText('S', spec2.sizeRemoval(draft, 's')), '')
    const off = spec2.toSpec(spec2.removeSize(draft, 'm'))
    assert.ok(off.colours.every((r) => r.sizes.every((z) => z.sizeId !== 'm')))
    assert.ok(off.measurements.every((m) => m.sizeId !== 'm'))
    assert.equal(shared.totalPieces(off), 1)
  }
)
check('taking a colour off says what goes with it and takes its own lines only', () => {
  const draft = spec2.fromSpec(sample(), { runSizeIds: run })
  const loss = spec2.colourRemoval(draft, 1)
  assert.equal(loss.colour, 'Navy')
  assert.equal(loss.pieces, 1)
  assert.deepEqual(
    loss.lines.map((l) => l.id),
    ['row-2']
  )
  const names = { btn: 'Horn button 18L', fab: 'Poplin 40s', lab: 'Woven label' }
  assert.equal(
    spec2.colourRemovalText(loss, (id) => names[id]),
    'Navy has 1 piece and 1 material line for Navy only (Placket: Horn button 18L). Taking Navy off this round removes them.'
  )
  const after = spec2.toSpec(spec2.removeColour(draft, 1))
  assert.deepEqual(
    after.colours.map((r) => r.colour),
    ['White']
  )
  // Lines for every colour, and White's own, stay.
  assert.deepEqual(
    after.materials.map((m) => m.id),
    ['row-1', 'row-3']
  )
  // Nothing typed against it: nothing to ask.
  const empty = spec2.addColour(draft, 'Sky')
  assert.equal(spec2.colourRemovalText(spec2.colourRemoval(empty, 2)), '')
  assert.deepEqual(spec2.coloursToAdd(['White', 'navy', 'Sky'], draft), ['Sky'])
})
check('measurements become a points × sizes matrix and back', () => {
  const points = spec2.pointsOf(sample().measurements)
  assert.deepEqual(
    points.map((p) => [p.name, p.tolerance, p.targets]),
    [
      ['Chest', '1', { m: '52', l: '54' }],
      ['Length', '1.5', { m: '74.5' }],
    ]
  )
  assert.deepEqual(spec2.flattenPoints(points, ['m', 'l']), sample().measurements)
  // A named point with no target yet is kept, with no size; an empty row is nothing.
  const kept = spec2.flattenPoints(
    [...points, { ...spec2.newPoint(), name: 'Sleeve' }, spec2.newPoint()],
    ['m', 'l']
  )
  assert.deepEqual(kept.at(-1), { name: 'Sleeve', tolerance: 0, unit: 'cm', sizeId: '', target: 0 })
  assert.equal(kept.length, 4)
  assert.equal(spec2.pointsOf(kept).length, 3)
  // A point measured twice for one size (an old round) stays as a second row.
  const twice = spec2.pointsOf([
    ...sample().measurements,
    { name: 'chest', sizeId: 'm', target: 53, tolerance: 1, unit: 'cm' },
  ])
  assert.equal(twice.length, 3)
})
check('the matrix shows the sizes made, and a size measured but not made, to clear', () => {
  let draft = spec2.fromSpec(sample(), { runSizeIds: run })
  draft = spec2.setPieces(spec2.setPieces(draft, 0, 'l', '0'), 1, 'l', '0')
  assert.deepEqual(spec2.measureColumns(draft), [
    { sizeId: 'm', made: true },
    { sizeId: 'l', made: false },
  ])
  const cleared = spec2.clearTargets(draft, 'l')
  assert.deepEqual(spec2.measureColumns(cleared), [{ sizeId: 'm', made: true }])
  assert.ok(spec2.toSpec(cleared).measurements.every((m) => m.sizeId === 'm'))
})
check('a line’s quantity is the shared one unless typed by hand', () => {
  const draft = spec2.fromSpec(sample(), { runSizeIds: run })
  const spec = spec2.toSpec(draft)
  for (const m of spec.materials) assert.equal(m.requiredQty, shared.lineRequiredQty(m, spec))
  // More Navy pieces: the Navy-only line follows, the hand-typed one does not.
  const more = spec2.toSpec(spec2.setPieces(draft, 1, 'm', '3'))
  assert.equal(more.materials[1].requiredQty, 21)
  assert.equal(more.materials[2].requiredQty, 10)
  assert.equal(more.materials[0].requiredQty, shared.requiredQtyFor(more.materials[0], more))
  // A reason belongs to a typed quantity only; worked out, it is White's 3 pieces × 1.
  const auto = spec2.bomLineOf({ ...draft.lines[2], requiredOverride: false }, spec)
  assert.equal(auto.overrideReason, '')
  assert.equal(auto.requiredQty, 3)
})
check('a new line left empty is not saved; a saved one is kept even when emptied', () => {
  const draft = spec2.fromSpec(sample(), { runSizeIds: run })
  const lines = [...draft.lines, spec2.newLine()]
  assert.equal(spec2.toSpec({ ...draft, lines }).materials.length, 3)
  const emptied = { ...spec2.newLine(), id: 'row-9' }
  assert.equal(spec2.toSpec({ ...draft, lines: [emptied] }).materials[0].id, 'row-9')
  assert.equal(spec2.lineHasData(spec2.newLine()), false)
  assert.equal(spec2.lineHasData({ ...spec2.newLine(), component: 'Body' }), true)
  // So is an empty new step.
  assert.equal(spec2.toSpec({ ...draft, route: [...draft.route, spec2.newStep()] }).route.length, 4)
})
check('typed figures keep only the places the server takes', () => {
  assert.equal(spec2.limitDecimals('1.234567', 4), '1.2345')
  assert.equal(spec2.limitDecimals('12.5', 2), '12.5')
  assert.equal(spec2.limitDecimals('7.', 3), '7.')
  assert.equal(spec2.limitDecimals('7.9', 0), '7')
  assert.equal(spec2.limitDecimals('42', 2), '42')
})
check('picking a material fills its department and expected rate, not over what was typed', () => {
  const fab = { id: 'fab', departmentId: 'dept-cut', standardRate: 180 }
  const thread = { id: 'thr', departmentId: 'dept-sti', standardRate: null }
  const line = spec2.lineWithItem(spec2.newLine(), fab)
  assert.deepEqual([line.itemId, line.departmentId, line.estRate], ['fab', 'dept-cut', '180'])
  // Another material: the first one's defaults go with it.
  const swapped = spec2.lineWithItem(line, thread, fab)
  assert.deepEqual([swapped.itemId, swapped.departmentId, swapped.estRate], ['thr', 'dept-sti', ''])
  // What somebody typed stays.
  const typed = spec2.lineWithItem(
    { ...line, departmentId: 'dept-fin', estRate: '175' },
    thread,
    fab
  )
  assert.deepEqual([typed.departmentId, typed.estRate], ['dept-fin', '175'])
})
check('repeated lines and the expected material cost', () => {
  const spec = sample()
  spec.materials.push(bom({ component: 'body ', itemId: 'fab', qtyPerPiece: 1 }))
  const twice = spec2.duplicateLines(spec.materials)
  assert.deepEqual([...twice.keys()], [3])
  assert.equal(twice.get(3), shared.SAMPLE_DUPLICATE_LINE)
  assert.equal(spec2.DUPLICATE_LINE_TEXT, shared.SAMPLE_DUPLICATE_LINE)
  // 5.2 × 180 + 10 × 2.5; the buttons have no rate yet.
  assert.deepEqual(spec2.materialCost(sample()), { total: 961, unrated: 1 })
  assert.equal(spec2.lineCost(sample().materials[1], sample()), null)
})
check('the route is cut first and once, and a route with no check is said', () => {
  assert.deepEqual(spec2.routeRules(sample().route), {
    problems: [],
    noCheck: false,
    steps: ['', '', '', ''],
  })
  const late = [step('op-sti', 'Stitching', 'STITCHING'), step('op-cut', 'Cutting', 'CUTTING')]
  const r = spec2.routeRules(late)
  assert.deepEqual(r.problems, [spec2.ROUTE_TEXT.cuttingFirst])
  assert.deepEqual(r.steps, [spec2.ROUTE_TEXT.firstStep, spec2.ROUTE_TEXT.laterCut])
  assert.equal(r.noCheck, true)
  const twiceCut = spec2.routeRules([
    step('a', 'Cutting', 'CUTTING'),
    step('b', 'Recut', 'CUTTING'),
  ])
  assert.deepEqual(twiceCut.problems, [spec2.ROUTE_TEXT.oneCutting])
  // A step with no process yet is no kind: a legacy "Cutting" name does not count.
  assert.deepEqual(spec2.routeRules([{ ...step('', 'Cutting', 'CUTTING') }]).problems, [
    spec2.ROUTE_TEXT.cuttingFirst,
  ])
  assert.equal(
    spec2.ROUTE_TEXT.noCheck,
    'There is no quality check on this route, so pieces go to finished goods without one.'
  )
})
check('picking a process fills the step from the Operation master', () => {
  const wash = {
    id: 'op-wsh',
    code: 'WSH',
    name: 'Washing',
    kind: 'OTHER',
    departmentId: 'dept-wsh',
    defaultExecution: 'OUTSOURCED',
    instructions: 'Enzyme wash',
    sortOrder: 50,
  }
  const emb = {
    id: 'op-emb',
    code: 'EMB',
    name: 'Embroidery',
    kind: 'OTHER',
    departmentId: 'dept-emb',
    defaultExecution: 'OUTSOURCED',
    instructions: null,
    sortOrder: 40,
  }
  const s = spec2.stepWithOperation({ ...spec2.newStep(), contractorId: 'c1' }, wash)
  assert.deepEqual(
    [s.operationId, s.name, s.kind, s.departmentId, s.execution, s.contractorId, s.instructions],
    ['op-wsh', 'Washing', 'OTHER', 'dept-wsh', 'OUTSOURCED', null, 'Enzyme wash']
  )
  // A name of its own stays when the process changes; the old process's own does not.
  const named = spec2.stepWithOperation({ ...s, name: 'Stone wash' }, emb, wash)
  assert.deepEqual([named.name, named.instructions], ['Stone wash', ''])
  assert.equal(spec2.stepWithOperation(s, emb, wash).name, 'Embroidery')
  const inHouse = spec2.stepDoneAt({ ...s, vendorId: 'sup' }, 'IN_HOUSE')
  assert.deepEqual(
    [inHouse.execution, inHouse.vendorId, inHouse.contractorId],
    ['IN_HOUSE', null, null]
  )
})
check('each gap opens the tab that fixes it', () => {
  const sections = ['style', 'details', 'colours', 'measurements', 'materials', 'route']
  assert.deepEqual(
    sections.map((s) => spec2.GAP_TAB[s]),
    ['style', 'style', 'style', 'measurements', 'materials', 'route']
  )
  assert.deepEqual(
    spec2.SPEC_TABS.map((t) => t.title),
    ['Style & colours', 'Measurements', 'Materials', 'Route', 'Review & release']
  )
  const empty = shared.normaliseSpec({})
  const byTab = spec2.gapsByTab(spec2.releaseGaps(empty, ctxOf()))
  assert.ok(byTab.style.length && byTab.materials.length && byTab.route.length)
  assert.equal(byTab.review.length, 0)
})
check('a complete round has nothing left; release gaps add the cutting rule', () => {
  assert.deepEqual(spec2.releaseGaps(sample(), ctxOf()), [])
  const late = { ...sample(), route: [...sample().route.slice(1), sample().route[0]] }
  const gaps = spec2.releaseGaps(late, ctxOf())
  assert.deepEqual(gaps, [{ section: 'route', message: spec2.ROUTE_TEXT.cuttingFirst }])
  // Without a buyer, material the buyer sends is a gap on the materials tab.
  const sent = sample()
  sent.materials[0].source = 'BUYER_SUPPLIED'
  assert.deepEqual(spec2.gapsByTab(spec2.releaseGaps(sent, ctxOf(false))).materials.length, 1)
})
check('the review sums the round up', () => {
  const sum = spec2.specSummary(sample())
  assert.deepEqual(sum, {
    colours: ['White', 'Navy'],
    pieces: 4,
    sizeIds: ['m', 'l'],
    lines: 3,
    cost: 961,
    unrated: 1,
    steps: ['Cutting', 'Stitching', 'Embroidery', 'Checking'],
  })
})
check('a change shows on its own tab only', () => {
  const draft = spec2.fromSpec(sample(), { runSizeIds: run })
  const s = spec2.toSpec(draft)
  const moved = spec2.toSpec({ ...draft, route: spec2.moveRow(draft.route, 1, 1) })
  assert.deepEqual(spec2.changedTabs(moved, s), {
    style: false,
    measurements: false,
    materials: false,
    route: true,
    review: false,
  })
  assert.deepEqual(spec2.moveRow([1, 2, 3], 0, -1), [1, 2, 3])
  assert.deepEqual(spec2.moveRow([1, 2, 3], 2, -1), [1, 3, 2])
  const typed = spec2.toSpec({ ...draft, colours: spec2.setPieces(draft, 0, 'm', '5').colours })
  assert.equal(spec2.changedTabs(typed, s).style, true)
})
check('an old round opens in the editor as one colour row and named steps', () => {
  const old = shared.normaliseSpec({
    milestone: 'Proto',
    styleId: 'dev',
    color: 'White',
    sizes: [{ sizeId: 'm', qty: 2 }],
    stages: ['Cutting', 'Stitching'],
    materials: [{ itemId: 'fab', warehouseId: 'w', qty: 3, ownership: 'OWNED' }],
    measurements: [],
  })
  const draft = spec2.fromSpec(old, { runSizeIds: run })
  assert.deepEqual(draft.colours, [{ colour: 'White', qty: { m: 2 } }])
  assert.deepEqual(
    draft.route.map((s) => [s.operationId, s.name]),
    [
      ['', 'Cutting'],
      ['', 'Stitching'],
    ]
  )
  const line = spec2.toSpec(draft).materials[0]
  assert.deepEqual(
    [line.requiredOverride, line.requiredQty, line.overrideReason],
    [true, 3, 'Planned before the material table']
  )
})

// ── Phase 2 (web, part 2): the workspace, the record and the flow on spec v2 ──
const serverText = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '../apps/api/src/services/sampling.service.ts'),
  'utf8'
)
// The sizes of the run the part-1 fixtures use, as the lookups list them.
const runSizes = run.map((id) => ({ id, code: id.toUpperCase(), sizeGroupId: 'run-x' }))
const v2Request = (spec, over = {}) => ({
  styleId: 'dev',
  style: { ...devStyle, colors: ['White', 'Navy', 'Sky'], sizeGroupId: 'run-x' },
  customerId: 'buyer',
  cancelledAt: null,
  rounds: [{ ...draft('dev'), specification: spec }],
  ...over,
})
// A released round of the part-1 sample: two colours, four pieces in three cells.
const releasedSet = () => ({
  id: 'set',
  revision: 1,
  state: 'RELEASED',
  specification: sample(),
  stages: sample().route.map((s, i) => ({
    id: `st-${i}`,
    sequence: i + 1,
    name: s.name,
    completedAt: null,
    doneQty: null,
  })),
  materials: [
    {
      id: 'row-1',
      itemId: 'fab',
      colour: null,
      source: 'PURCHASE',
      warehouseId: null,
      warehouse: null,
      plannedQty: '5.2',
      issuedQty: '0',
      usedQty: '0',
      wasteQty: '0',
      returnedQty: '0',
    },
  ],
  qc: null,
  handover: null,
})
check('a draft says what its saved specification still needs, tab by tab', () => {
  // Without the size list, a draft only says where to go.
  const bare = sampleFlow(v2Request(sample()))
  assert.equal(bare.section, 'Technical')
  assert.equal(bare.title, 'Prepare the sample specification')
  // Complete: release is next.
  const ready = sampleFlow(v2Request(sample()), undefined, runSizes)
  assert.equal(ready.section, 'Technical')
  assert.equal(ready.title, 'Release round 1 for sampling')
  assert.deepEqual(flow.draftGaps(v2Request(sample()), { specification: sample() }, runSizes), [])
  // Two lines short of a process: the route tab is named with its count.
  const open = { ...sample(), materials: [], route: sample().route.map((s) => ({ ...s })) }
  open.route[1].operationId = ''
  const left = sampleFlow(v2Request(open), undefined, runSizes)
  assert.equal(left.title, 'Prepare the sample specification')
  assert.equal(
    left.description,
    'The saved draft still has items to finish under Materials (1) and Route (1). Save as you go, and release once nothing is left.'
  )
  // Material the buyer sends needs a buyer on the request.
  const sent = sample()
  sent.materials[0].source = 'BUYER_SUPPLIED'
  assert.match(
    sampleFlow(v2Request(sent, { customerId: null }), undefined, runSizes).description,
    /Materials \(1\)/
  )
  // A colour the style no longer has is a gap too.
  assert.match(
    sampleFlow(
      v2Request(sample(), { style: { ...devStyle, colors: ['White'], sizeGroupId: 'run-x' } }),
      undefined,
      runSizes
    ).description,
    /Style & colours/
  )
})
check('several colours or sizes go through making, QC and the buyer as one set', () => {
  const set = releasedSet()
  assert.equal(flow.isSampleSet(set.specification), true)
  assert.equal(
    flow.isSampleSet({ colours: [{ colour: 'White', sizes: [{ sizeId: 'm', qty: 3 }] }] }),
    false
  )
  // The first step takes every piece of the grid; the next what the step before finished.
  assert.equal(flow.stageInput(set, 0), 4)
  Object.assign(set.stages[0], { completedAt: '2026-11-16', doneQty: 4 })
  assert.equal(flow.stageInput(set, 1), 4)
  // The words are the server's own.
  for (const words of Object.values(flow.SET_TEXT)) assert.ok(serverText.includes(words), words)
  assert.ok(serverText.includes(flow.NO_ITEM_TEXT))
  set.materials[0].issuedQty = '5.2'
  const making = sampleFlow({ ...v2Request(sample()), rounds: [set] })
  assert.equal(making.section, 'Making')
  assert.match(making.title, /Record stitching/)
  assert.ok(making.description.endsWith(flow.SET_TEXT.stage))
  set.stages.forEach((s) => {
    s.completedAt = '2026-11-16'
    s.doneQty = 4
  })
  assert.match(sampleFlow({ ...v2Request(sample()), rounds: [set] }).description, /whole set/)
  set.state = 'QC_PASSED'
  assert.ok(
    sampleFlow({ ...v2Request(sample()), rounds: [set] }).description.startsWith(
      flow.SET_TEXT.submit
    )
  )
})
check(
  'material still to issue says how many lines and that the first issue names the store',
  () => {
    const set = releasedSet()
    set.materials.push({
      ...set.materials[0],
      id: 'row-2',
      plannedQty: '7',
      issuedQty: '7',
      warehouseId: 'w1',
      warehouse: { name: 'Example Store' },
    })
    const f = sampleFlow({ ...v2Request(sample()), rounds: [set] })
    assert.equal(f.section, 'Materials')
    assert.match(f.description, /1 of 2 material lines is not fully issued yet\./)
    assert.match(f.description, /Pick the store at each line’s first issue\./)
    set.materials[0].warehouseId = 'w1'
    assert.doesNotMatch(
      sampleFlow({ ...v2Request(sample()), rounds: [set] }).description,
      /Pick the store/
    )
  }
)
check('what each material line can record, and why not', () => {
  const set = releasedSet()
  const line = set.materials[0]
  // The first issue names the store.
  let a = flow.materialActions(set, line)
  assert.deepEqual(a.kinds, ['ISSUE'])
  assert.deepEqual([a.remaining, a.held, a.needsStore, a.why], [5.2, 0, true, ''])
  assert.equal(flow.storeNote(line), '')
  // Issued in part: the store is fixed, the rest is issued from there, and returns go back.
  Object.assign(line, { issuedQty: '3', warehouseId: 'w1', warehouse: { name: 'Example Store' } })
  a = flow.materialActions(set, line)
  assert.deepEqual(a.kinds, ['ISSUE', 'USE', 'WASTE', 'RETURN'])
  assert.deepEqual([a.remaining, a.held, a.needsStore], [2.2, 3, false])
  assert.equal(
    flow.storeNote(line),
    'This material was issued from Example Store. Issue the rest from there, and return it there.'
  )
  assert.equal(
    flow.storeNote({ ...line, issuedQty: '0' }),
    'This material is planned from Example Store. Issue it from there.'
  )
  // Making has started: no more issues, only what is held.
  set.stages[0].completedAt = '2026-11-16'
  assert.deepEqual(flow.materialActions(set, line).kinds, ['USE', 'WASTE', 'RETURN'])
  assert.match(
    flow.materialActions(set, { ...line, issuedQty: '0' }).why,
    /^Issue materials before making starts/
  )
  // A line with no material picked cannot be issued, and says why.
  const none = flow.materialActions(releasedSet(), { ...line, itemId: null, issuedQty: '0' })
  assert.deepEqual([none.kinds, none.why], [[], flow.NO_ITEM_TEXT])
  // Handed over: frozen.
  assert.match(flow.materialActions({ ...set, handover: {} }, line).why, /handed over/)
  // Fully used: nothing left.
  assert.equal(
    flow.materialActions(set, { ...line, issuedQty: '5.2', usedQty: '5.2' }).why,
    'Issued in full and accounted for.'
  )
})
check('the handover offers BOMs for every colour or one of the round’s colours', () => {
  const boms = [
    { id: 'b-all', styleId: 'dev', color: null, version: '1' },
    { id: 'b-navy', styleId: 'dev', color: 'navy ', version: '2' },
    { id: 'b-sky', styleId: 'dev', color: 'Sky', version: '3' },
    { id: 'b-other', styleId: 'other', color: null, version: '1' },
  ]
  assert.deepEqual(
    flow.handoverBoms(boms, sample()).map((b) => b.id),
    ['b-all', 'b-navy']
  )
})
check('the record shows the colour × size grid with its totals', () => {
  const grid = flow.colourGrid(sample(), ['s', 'l', 'm'])
  // In the size run's order, only the sizes made.
  assert.deepEqual(grid.sizeIds, ['l', 'm'])
  assert.deepEqual(
    grid.rows.map((r) => [r.colour, r.qty, r.total]),
    [
      ['White', { m: 2, l: 1 }, 3],
      ['Navy', { m: 1, l: 0 }, 1],
    ]
  )
  assert.deepEqual([grid.cols, grid.total], [{ l: 1, m: 3 }, 4])
  assert.equal(flow.colourSummary(sample()), 'White, Navy · 4 pcs')
  assert.equal(flow.colourSummary({ colours: [] }), 'No colours yet')
  assert.equal(
    flow.colourSummary({ colours: [{ colour: 'Sky', sizes: [{ sizeId: 'm', qty: 1 }] }] }),
    'Sky · 1 pc'
  )
})
check('measurements print as points × sizes, a made size with no target showing empty', () => {
  const spec = sample()
  spec.colours[0].sizes.push({ sizeId: 'xl', qty: 1 })
  const m = flow.measureMatrix(spec, run)
  assert.deepEqual(m.sizeIds, ['m', 'l', 'xl'])
  assert.deepEqual(m.points, [
    { name: 'Chest', tolerance: 1, unit: 'cm', targets: { m: 52, l: 54 } },
    { name: 'Length', tolerance: 1.5, unit: 'cm', targets: { m: 74.5 } },
  ])
})
check('each step says its process, department, where it is done and who does it', () => {
  const lookups = {
    operations: [{ id: 'op-emb', name: 'Embroidery' }],
    departments: [{ id: 'dept-emb', name: 'Embroidery' }],
    contractors: [{ id: 'c1', name: 'Ramesh tailors' }],
    jobWorkers: [{ id: 'sup-emb', name: 'Example Embroidery Works' }],
  }
  const outside = flow.stepFacts(
    {
      operationId: 'op-emb',
      departmentId: 'dept-emb',
      execution: 'OUTSOURCED',
      contractorId: null,
      vendorId: 'sup-emb',
      instructions: ' Logo on the left chest ',
    },
    lookups
  )
  assert.deepEqual(outside, {
    process: 'Embroidery',
    department: 'Embroidery',
    outside: true,
    doneAt: 'Outside unit',
    who: 'Example Embroidery Works',
    instructions: 'Logo on the left chest',
  })
  const floor = flow.stepFacts(
    {
      ...outside,
      operationId: 'op-emb',
      departmentId: 'gone',
      execution: 'IN_HOUSE',
      contractorId: 'c1',
      vendorId: null,
      instructions: null,
    },
    lookups
  )
  assert.deepEqual(
    [floor.doneAt, floor.who, floor.department],
    ['Our floor', 'Ramesh tailors', 'Department no longer in use']
  )
  assert.equal(flow.stepFacts({ ...floor, contractorId: null }, lookups).who, 'Any contractor')
  // A step released before routes named a process has only its name.
  const legacy = flow.stepFacts(
    {
      operationId: null,
      departmentId: null,
      execution: 'IN_HOUSE',
      contractorId: null,
      vendorId: null,
      instructions: null,
    },
    lookups
  )
  assert.deepEqual([legacy.process, legacy.department], ['', ''])
})
check('a line’s material comes from its own row, then the item list', () => {
  const set = releasedSet()
  set.materials[0].item = { name: 'Poplin 40s', code: 'FAB-1', uom: { symbol: 'm' } }
  const items = [{ id: 'btn', code: 'TRM-1', name: 'Horn button 18L', uom: { symbol: 'pcs' } }]
  assert.deepEqual(flow.lineItem({ id: 'row-1', itemId: 'fab' }, set, items), {
    name: 'Poplin 40s',
    code: 'FAB-1',
    uom: 'm',
  })
  // A line of an old round has no id: its row is found by its material.
  assert.equal(flow.lineItem({ itemId: 'fab' }, set, items).name, 'Poplin 40s')
  assert.equal(flow.lineItem({ id: 'new', itemId: 'btn' }, set, items).uom, 'pcs')
  assert.equal(flow.lineItem({ itemId: 'gone' }, set, items).name, 'Material no longer in use')
  assert.equal(flow.lineItem({ itemId: '' }, set, items).name, 'No material picked')
  assert.deepEqual([flow.lineColour(null), flow.lineColour(' Navy ')], ['All colours', 'Navy'])
})
check('every colour of a released round stays on the style', () => {
  const made = { ...releasedSet(), specification: { ...sample(), styleId: 'dev' } }
  const rules = styleRules({ style: devStyle, rounds: [draft('dev'), made], cancelledAt: null })
  assert.deepEqual(rules.sampledColours, ['White', 'Navy'])
  // A round released before the colour grid reads as one colour row (normaliseSpec).
  const old = {
    ...made,
    specification: shared.normaliseSpec({ styleId: 'dev', color: 'Sky', sizes: [], stages: [] }),
  }
  assert.deepEqual(
    styleRules({ style: devStyle, rounds: [old], cancelledAt: null }).sampledColours,
    ['Sky']
  )
})
// ── Phase 2 review fixes ─────────────────────────────────────────────────────
check('a line for every colour and one for a single colour of the same part and material clash', () => {
  // Body / Poplin for every colour, then Body / Poplin for Navy: Navy twice.
  const both = sample()
  both.materials.push(bom({ component: 'Body', itemId: 'fab', colour: 'Navy', qtyPerPiece: 1.3 }))
  const dup = spec2.duplicateLines(both.materials)
  assert.deepEqual([...dup.keys()], [3])
  assert.match(dup.get(3), /^The line for every colour already gives Navy this material/)
  assert.ok(
    shared
      .sampleSpecGaps(both, ctxOf())
      .some((g) => g.section === 'materials' && g.message === `Line 4: ${dup.get(3)}`)
  )
  // The other way round: a colour's own line first, then one for every colour.
  const rev = [
    bom({ component: 'Body', itemId: 'fab', colour: 'White', qtyPerPiece: 1 }),
    bom({ component: 'body', itemId: 'fab', qtyPerPiece: 1 }),
  ]
  const d2 = spec2.duplicateLines(rev)
  assert.deepEqual([...d2.keys()], [1])
  assert.match(d2.get(1), /^White already has its own line of this material for this part/)
  // A colour each, another part, or another material: no clash.
  const fine = [
    bom({ component: 'Body', itemId: 'fab', colour: 'White' }),
    bom({ component: 'Body', itemId: 'fab', colour: 'Navy' }),
    bom({ component: 'Collar', itemId: 'fab' }),
    bom({ component: 'Body', itemId: 'btn' }),
  ]
  assert.equal(spec2.duplicateLines(fine).size, 0)
})
check('a quantity typed by hand still says how much one piece takes', () => {
  const s = sample()
  s.materials[2].qtyPerPiece = 0
  assert.deepEqual(
    shared.sampleSpecGaps(s, ctxOf()).map((g) => g.message),
    ['Line 3: enter how much one piece takes.']
  )
})
check('a point with no target yet asks for its targets, not for a size to pick', () => {
  const s = sample()
  s.measurements.push({ name: 'Sleeve', sizeId: '', target: 0, tolerance: 0, unit: 'cm' })
  s.measurements.push({ name: '', sizeId: 'm', target: 30, tolerance: 0, unit: 'cm' })
  const said = shared
    .sampleSpecGaps(s, ctxOf())
    .filter((g) => g.section === 'measurements')
    .map((g) => g.message)
  assert.ok(said.includes('Sleeve: type its target for each size made.'), said.join(' | '))
  assert.ok(said.includes('Name every measurement point.'))
  assert.ok(!said.some((m) => /pick its size/.test(m)))
})
check('the measurement limit counts points; targets may be every point for every size', () => {
  assert.equal(shared.SAMPLE_MEASURE_MAX_POINTS, 200)
  assert.equal(shared.SAMPLE_MEASURE_MAX_ENTRIES, 6000)
  // 26 points in 8 sizes is 208 targets: a normal chart, nothing to say.
  const sizes8 = ['xs', 's', 'm', 'l', 'xl', '2xl', '3xl', '4xl']
  const points = Array.from({ length: 26 }, (_, i) => ({
    ...spec2.newPoint(),
    name: `Point ${i + 1}`,
    targets: Object.fromEntries(sizes8.map((z) => [z, '50'])),
  }))
  assert.equal(spec2.flattenPoints(points, sizes8).length, 208)
  const chart = { ...sample(), measurements: spec2.flattenPoints(points, sizes8) }
  assert.ok(!shared.sampleSpecGaps(chart, ctxOf()).some((g) => /^Up to/.test(g.message)))
  const many = Array.from({ length: 201 }, (_, i) => ({
    name: `P${i}`,
    sizeId: 'm',
    target: 1,
    tolerance: 0,
    unit: 'cm',
  }))
  assert.ok(
    shared
      .sampleSpecGaps({ ...sample(), measurements: many }, ctxOf())
      .some((g) => g.message === 'Up to 200 measurement points in one round.')
  )
})
check('a line or step with only a pick in it is kept, so nothing goes and the numbers hold', () => {
  const draft = spec2.fromSpec(sample(), { runSizeIds: run })
  const colourOnly = { ...spec2.newLine(), colour: 'Navy' }
  const kept = spec2.toSpec({ ...draft, lines: [colourOnly, ...draft.lines] })
  assert.equal(kept.materials.length, 4)
  assert.equal(kept.materials[0].colour, 'Navy')
  // Read back after the save, it is still a line, and the gaps number it as the grid does.
  assert.equal(spec2.fromSpec(kept, { runSizeIds: run }).lines.length, 4)
  assert.ok(shared.sampleSpecGaps(kept, ctxOf()).some((g) => g.message === 'Line 1: pick the material.'))
  for (const pick of [{ departmentId: 'dept-fin' }, { source: 'BUYER_SUPPLIED' }])
    assert.equal(spec2.blankLine({ ...spec2.newLine(), ...pick }), false)
  assert.equal(spec2.blankLine(spec2.newLine()), true)
  const outside = { ...spec2.newStep(), execution: 'OUTSOURCED' }
  assert.equal(spec2.toSpec({ ...draft, route: [...draft.route, outside] }).route.length, 5)
  assert.equal(spec2.blankStep({ ...spec2.newStep(), departmentId: 'dept-fin' }), false)
  assert.equal(spec2.blankStep(spec2.newStep()), true)
})
check('material the buyer sends is not in the estimated cost, and takes no rate', () => {
  const pair = {
    colours: sample().colours,
    materials: [
      // 4 pieces × 1.3 m the buyer sends, rated 180 all the same: not ours to pay.
      bom({ component: 'Body', itemId: 'fab', qtyPerPiece: 1.3, source: 'BUYER_SUPPLIED', estRate: 180 }),
      // 4 pieces × 7 buttons at 1.5.
      bom({ component: 'Placket', itemId: 'btn', qtyPerPiece: 7, estRate: 1.5 }),
    ],
  }
  assert.deepEqual(spec2.materialCost(pair), { total: 42, unrated: 0 })
  assert.equal(spec2.lineCost(pair.materials[0], pair), null)
  // A buyer line with no rate is not one "with no expected rate".
  pair.materials[0].estRate = null
  assert.deepEqual(spec2.materialCost(pair), { total: 42, unrated: 0 })
  const fab = { id: 'fab', departmentId: 'dept-cut', standardRate: 180 }
  const sent = spec2.lineWithItem({ ...spec2.newLine(), source: 'BUYER_SUPPLIED' }, fab)
  assert.equal(sent.estRate, '')
  const bought = spec2.lineWithItem(spec2.newLine(), fab)
  assert.equal(bought.estRate, '180')
  // Switched to the buyer, the filled-in rate goes; a typed one stays; bought again, it comes back.
  assert.equal(spec2.lineWithSource(bought, 'BUYER_SUPPLIED', fab).estRate, '')
  assert.equal(spec2.lineWithSource({ ...bought, estRate: '175' }, 'BUYER_SUPPLIED', fab).estRate, '175')
  assert.equal(spec2.lineWithSource(sent, 'PURCHASE', fab).estRate, '180')
  assert.equal(spec2.lineWithSource(sent, 'PURCHASE', fab).source, 'PURCHASE')
  assert.equal(spec2.MATERIAL_COST_LABEL, 'Estimated cost of what we buy')
})
check('rates show in full, to 4 places, the same on screen and on paper', () => {
  assert.equal(spec2.rateFigure(0.0125), '0.0125')
  assert.equal(spec2.rateFigure(1250), '1,250.00')
  assert.equal(spec2.rateFigure(3604.5), '3,604.50')
})
const liveMasters = () => ({
  items: ['fab', 'btn', 'lab'].map((id) => ({ id })),
  operations: ['op-cut', 'op-sti', 'op-emb', 'op-qc'].map((id) => ({ id })),
  departments: ['dept-cutting', 'dept-stitching', 'dept-other', 'dept-qc'].map((id) => ({ id })),
  contractors: [{ id: 'tailor' }],
  jobWorkers: [{ id: 'sup-emb' }],
})
check('anything switched off in the masters since it was picked is a gap, by line and step', () => {
  assert.deepEqual(spec2.masterGaps(sample(), liveMasters()), [])
  assert.deepEqual(spec2.releaseGaps(sample(), ctxOf(), liveMasters()), [])
  const off = sample()
  off.materials[1].departmentId = 'dept-old'
  off.route[1].contractorId = 'tailor-gone'
  const live = liveMasters()
  live.items = live.items.filter((i) => i.id !== 'lab')
  live.operations = live.operations.filter((o) => o.id !== 'op-emb')
  live.jobWorkers = []
  assert.deepEqual(
    spec2.masterGaps(off, live).map((g) => [g.section, g.message]),
    [
      ['materials', 'Line 2: its department is no longer in use. Pick another, or leave it blank for the item’s own.'],
      ['materials', 'Line 3: Neck uses a material that is no longer in use. Pick another.'],
      ['route', 'Step 2: that contractor is no longer in use. Pick another.'],
      ['route', 'Step 3: that process is no longer in use. Pick another.'],
      ['route', 'Step 3: that outside unit is no longer in use. Pick another.'],
    ]
  )
  // The review lists them too, so it never says Ready while every save would be refused.
  assert.equal(spec2.releaseGaps(off, ctxOf(), live).length, 5)
  // A process in use whose department was switched off: pick another process.
  live.departments = live.departments.filter((d) => d.id !== 'dept-stitching')
  assert.ok(
    spec2
      .masterGaps(sample(), { ...liveMasters(), departments: live.departments })
      .some((g) => g.message === 'Step 2: its process’s department is no longer in use. Pick another process.')
  )
})
check('a step with a process is done by that process’s department, however it was saved', () => {
  const s = sample()
  // Embroidery given another department, as a round saved before the rule could be.
  s.route[2].departmentId = 'dept-fin'
  const ops = [
    { id: 'op-cut', departmentId: 'dept-cutting' },
    { id: 'op-sti', departmentId: 'dept-stitching' },
    { id: 'op-emb', departmentId: 'dept-emb' },
    { id: 'op-qc', departmentId: 'dept-qc' },
  ]
  const d = spec2.fromSpec(s, { runSizeIds: run, operations: ops })
  assert.equal(d.route[2].departmentId, 'dept-emb')
  // Opened, it is no change to save; the next save sends the process's department.
  const saved = spec2.toSpec(spec2.fromSpec(s, { runSizeIds: run, operations: ops }))
  assert.equal(spec2.changedTabs(spec2.toSpec(d), saved).route, false)
  assert.equal(spec2.toSpec(d).route[2].departmentId, 'dept-emb')
  // A step with no process keeps its own; without the list nothing changes.
  const legacy = { ...s, route: [{ ...s.route[0], operationId: '', departmentId: 'dept-x' }] }
  assert.equal(
    spec2.fromSpec(legacy, { runSizeIds: run, operations: ops }).route[0].departmentId,
    'dept-x'
  )
  assert.equal(spec2.fromSpec(s, { runSizeIds: run }).route[2].departmentId, 'dept-fin')
})
check('the picker keeps what was found or added, and a round’s own materials in use', () => {
  const a = {
    id: 'a',
    code: 'FAB-1',
    name: 'Poplin',
    type: 'RAW_MATERIAL',
    uom: null,
    departmentId: null,
    standardRate: null,
  }
  const b = { ...a, id: 'b', code: 'TRM-9', name: 'Horn button' }
  assert.deepEqual(
    spec2.mergeItems([a], [b, a]).map((i) => i.id),
    ['b', 'a']
  )
  const list = [a]
  assert.equal(spec2.mergeItems(list, [a]), list)
  assert.equal(spec2.itemNamed([a, b], ' horn BUTTON ').id, 'b')
  assert.equal(spec2.itemNamed([a, b], 'trm-9').id, 'b')
  assert.equal(spec2.itemNamed([a, b], 'Horn'), undefined)
  const set = releasedSet()
  set.materials[0].item = {
    id: 'fab',
    code: 'FAB-1',
    name: 'Poplin 40s',
    type: 'RAW_MATERIAL',
    isActive: true,
    departmentId: 'dept-cut',
    standardRate: '180.0000',
    uom: { id: 'u-m', name: 'Metre', symbol: 'm' },
  }
  // One switched off since is not offered: the line says so instead.
  set.materials.push({
    ...set.materials[0],
    id: 'row-2',
    itemId: 'old',
    item: { ...set.materials[0].item, id: 'old', isActive: false },
  })
  assert.deepEqual(flow.roundItems(set), [
    {
      id: 'fab',
      code: 'FAB-1',
      name: 'Poplin 40s',
      type: 'RAW_MATERIAL',
      uom: { id: 'u-m', code: 'm', name: 'Metre', symbol: 'm' },
      departmentId: 'dept-cut',
      standardRate: 180,
    },
  ])
})
console.log(`${passed} Sampling UI workflow checks passed.`)
