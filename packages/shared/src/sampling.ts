/**
 * A round is one style, one milestone and one frozen technical version. It
 * holds several colours, each in some sizes: the buyer's tech pack asks for a
 * set, not for one garment.
 */
/** The step names of the making route before routes named a process (legacy rounds). */
export const SAMPLE_STAGES = ['Cutting', 'Stitching', 'Finishing'] as const
export const SAMPLE_DECISIONS = ['APPROVED', 'CHANGES_REQUIRED', 'REJECTED'] as const
export const SAMPLE_STATES = [
  'DRAFT',
  'RELEASED',
  'QC_FAILED',
  'QC_PASSED',
  'SUBMITTED',
  ...SAMPLE_DECISIONS,
] as const
export const SAMPLE_STATE_LABEL: Record<string, string> = {
  DRAFT: 'Draft specification',
  RELEASED: 'Being made',
  QC_FAILED: 'QC failed',
  QC_PASSED: 'Ready to send',
  SUBMITTED: 'With the buyer',
  APPROVED: 'Buyer approved',
  CHANGES_REQUIRED: 'Changes required',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
}
/** What a process does to the garment, as the Operation master says (ProcessKind). */
export const PROCESS_KINDS = [
  'CUTTING',
  'STITCHING',
  'FINISHING',
  'QC',
  'PACKING',
  'OTHER',
] as const
export type ProcessKind = (typeof PROCESS_KINDS)[number]
/** Done on our own floor, or given to an outside unit (StepExecution). */
export const STEP_EXECUTIONS = ['IN_HOUSE', 'OUTSOURCED'] as const
export type StepExecution = (typeof STEP_EXECUTIONS)[number]

/**
 * Who gets a material for the sample. We buy most of it for the sample alone;
 * some buyers send their own fabric or labels. Stock ownership follows from
 * it: what we buy is ours (OWNED), what the buyer sends stays theirs
 * (CUSTOMER_OWNED). Plain codes so the database can check them.
 */
export const SAMPLE_MATERIAL_SOURCES = ['PURCHASE', 'BUYER_SUPPLIED'] as const
export type SampleMaterialSource = (typeof SAMPLE_MATERIAL_SOURCES)[number]
export const SAMPLE_MATERIAL_SOURCE_LABEL: Record<SampleMaterialSource, string> = {
  PURCHASE: 'We buy it',
  BUYER_SUPPLIED: 'Buyer sends it',
}
/** The item types a sample material can be: never a garment or a part-made one. */
export const SAMPLE_MATERIAL_TYPES = [
  'RAW_MATERIAL',
  'TRIM',
  'PACKING_MATERIAL',
  'CONSUMABLE',
] as const
export type SampleMaterialType = (typeof SAMPLE_MATERIAL_TYPES)[number]

/** One colour of the round and how many pieces of each size are made in it. */
export interface SampleColourRow {
  /** As the style spells it. Blank only while a draft row is still being filled in. */
  colour: string
  sizes: Array<{ sizeId: string; qty: number }>
}
/** One measurement point for one size, the same for every colour. */
export interface SampleMeasurement {
  name: string
  sizeId: string
  target: number
  tolerance: number
  unit: 'cm' | 'in'
}
/** One step of the round's making route, taken from the Operation master. */
export interface SampleRouteStep {
  /** '' only on a step from before routes named a process, or a draft row not yet picked. */
  operationId: string
  /** The operation's name unless the merchandiser named the step otherwise. */
  name: string
  kind: ProcessKind
  departmentId: string
  execution: StepExecution
  /** The floor contractor who takes the step, for an in-house step. */
  contractorId: string | null
  /** The outside unit (a supplier) the step goes to, for a step done outside. */
  vendorId: string | null
  instructions: string
}
/**
 * One line of the sample BOM. The lines are rows of their own (sample
 * materials) from the first draft save, so a purchase can be linked to a line
 * before the round is released; the specification carries a copy of them,
 * with their ids, in the order they are listed.
 */
export interface SampleBomLine {
  /** The row's id. Absent only for a line not saved yet. */
  id?: string
  /** Which part of the garment it goes into: Body, Collar, Placket. */
  component: string
  itemId: string
  /** Null: every colour of the round. Otherwise one of the round's colours. */
  colour: string | null
  /** Who draws it from the store; blank takes the item's own department. */
  departmentId: string | null
  qtyPerPiece: number
  wastagePct: number
  /** Worked out by requiredQtyFor, unless typed by hand (requiredOverride). */
  requiredQty: number
  requiredOverride: boolean
  /** Why the quantity was typed by hand. */
  overrideReason: string
  source: SampleMaterialSource
  /** What we expect to pay for one unit, before anything is bought. */
  estRate: number | null
  remarks: string
}
export interface SampleSpecification {
  milestone: string
  styleId: string
  construction: string
  techPackRef: string
  patternRef: string
  /** The colour x size grid. */
  colours: SampleColourRow[]
  /** Per size, shared by every colour. */
  measurements: SampleMeasurement[]
  route: SampleRouteStep[]
  /** A copy of the round's material rows, kept by the server. */
  materials: SampleBomLine[]
  notes: string
}

/** An item as the sample BOM's picker shows it. */
export interface SampleItemOption {
  id: string
  code: string
  name: string
  type: SampleMaterialType
  /** UOM has no code of its own: code is its symbol (m, pcs). */
  uom: { id: string; code: string; name: string; symbol: string } | null
  departmentId: string | null
  standardRate: number | null
}

// ── One arithmetic for the grid and the BOM, used by the API and the screens ──

const sameColour = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
const num = (v: unknown) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
// What a production BOM stores for one garment: the per-piece quantity with
// its wastage, to 4 places (master.routes priceBomLines, effectiveQty =
// round(qty × (1 + wastage/100), 4) with toFixed).
const round4 = (v: number) => Number(v.toFixed(4))
// How manufacturing.service materialPlan rounds what an order needs: round3,
// Math.round(n × 1000) / 1000.
const round3 = (v: number) => Math.round(v * 1000) / 1000

/** The sizes the round makes: any size with pieces in any colour, in the order first listed. */
export function sizesInUse(spec: Pick<SampleSpecification, 'colours'>): string[] {
  const seen: string[] = []
  for (const row of spec.colours)
    for (const z of row.sizes)
      if (z.sizeId && num(z.qty) > 0 && !seen.includes(z.sizeId)) seen.push(z.sizeId)
  return seen
}
/** Pieces of one colour, or of the whole round when colour is null (a line for every colour). */
export function piecesFor(
  spec: Pick<SampleSpecification, 'colours'>,
  colour: string | null
): number {
  const rows = colour?.trim()
    ? spec.colours.filter((r) => sameColour(r.colour, colour))
    : spec.colours
  return rows.reduce((t, r) => t + r.sizes.reduce((s, z) => s + num(z.qty), 0), 0)
}
export function totalPieces(spec: Pick<SampleSpecification, 'colours'>): number {
  return piecesFor(spec, null)
}
/** Colour x size cells with pieces in them: more than one means the round is a set. */
export function cellCount(spec: Pick<SampleSpecification, 'colours'>): number {
  const cells = new Set<string>()
  for (const row of spec.colours)
    for (const z of row.sizes)
      if (num(z.qty) > 0) cells.add(`${row.colour.trim().toLowerCase()}|${z.sizeId}`)
  return cells.size
}
/**
 * How much of a material the round needs: its pieces (of the line's colour,
 * or of every colour) × the quantity one piece takes with its wastage. The
 * per-piece figure is rounded to 4 places as a production BOM stores it
 * (effectiveQty), and the total to 3 as manufacturing.service materialPlan
 * rounds an order's need (round3), so the sample BOM and the production BOM
 * made from it at handover ask the store for the same quantity.
 */
export function requiredQtyFor(
  line: Pick<SampleBomLine, 'colour' | 'qtyPerPiece' | 'wastagePct'>,
  spec: Pick<SampleSpecification, 'colours'>
): number {
  const perPiece = round4(num(line.qtyPerPiece) * (1 + num(line.wastagePct) / 100))
  return round3(piecesFor(spec, line.colour) * perPiece)
}
/** The quantity a line stands for: typed by hand when overridden, else worked out. */
export function lineRequiredQty(
  line: Pick<
    SampleBomLine,
    'colour' | 'qtyPerPiece' | 'wastagePct' | 'requiredQty' | 'requiredOverride'
  >,
  spec: Pick<SampleSpecification, 'colours'>
): number {
  return line.requiredOverride ? round3(num(line.requiredQty)) : requiredQtyFor(line, spec)
}

/** Which part of the specification a gap is in, so a screen can open that part. */
export type SampleSpecSection =
  'style' | 'colours' | 'measurements' | 'materials' | 'route' | 'details'
export interface SampleSpecGap {
  section: SampleSpecSection
  message: string
}
export interface SampleSpecContext {
  /** The request's style; leave out to skip the checks that need it. */
  style?: { colors: string[]; sizeIds: string[] } | null
  /** Size codes, to name a size in words. */
  sizes?: Array<{ id: string; code: string }>
  /** Whether the request names a buyer, who can send material. */
  hasBuyer: boolean
}
/** Shortest reason accepted for a quantity typed by hand. */
export const OVERRIDE_REASON_MIN = 5
/** The making route of a round: no fewer, no more steps. */
export const SAMPLE_ROUTE_MIN_STEPS = 2
export const SAMPLE_ROUTE_MAX_STEPS = 20
/** Said when two lines are the same material for the same part and colour. */
export const SAMPLE_DUPLICATE_LINE = 'Each material appears once for each part and colour.'
/**
 * Measurement points a round can have: the rows of the points × sizes matrix.
 * The flat list QC reads holds one target per point per size, so it may hold
 * every point for the 30 sizes a colour can have.
 */
export const SAMPLE_MEASURE_MAX_POINTS = 200
export const SAMPLE_MEASURE_MAX_ENTRIES = SAMPLE_MEASURE_MAX_POINTS * 30

/**
 * The lines that repeat an earlier one, by position, each with why. A line for
 * every colour already counts each colour's pieces, so a line of the same part
 * and material for one colour beside it (either way round) would plan, buy and
 * issue that colour's material twice, and give its production BOM the line
 * twice at handover. The later line of each pair is the one named.
 */
export function repeatedBomLines(
  lines: Array<Pick<SampleBomLine, 'component' | 'itemId' | 'colour'>>
): Map<number, string> {
  const exact = new Set<string>()
  // Per part and material: whether a line is for every colour, and the first one-colour line.
  const groups = new Map<string, { every: boolean; one: string | null }>()
  const out = new Map<number, string>()
  lines.forEach((l, i) => {
    const itemId = l.itemId.trim()
    if (!itemId) return
    const group = `${l.component.trim().toLowerCase()}|${itemId}`
    const colour = (l.colour ?? '').trim()
    const key = `${group}|${colour.toLowerCase()}`
    const g = groups.get(group) ?? { every: false, one: null }
    if (exact.has(key)) out.set(i, SAMPLE_DUPLICATE_LINE)
    else if (!colour && g.one)
      out.set(
        i,
        `${g.one} already has its own line of this material for this part, so a line for every colour would count it twice. Give each colour its own line instead.`
      )
    else if (colour && g.every)
      out.set(
        i,
        `The line for every colour already gives ${colour} this material for this part. Change that line, or give each colour its own line.`
      )
    exact.add(key)
    if (!colour) g.every = true
    else if (!g.one) g.one = colour
    groups.set(group, g)
  })
  return out
}

/**
 * What still stops a round being released, in plain words, one per problem.
 * The screen lists them before release and the server refuses release with
 * them. The master-data checks (an item, process, department, contractor or
 * unit switched off since it was picked) and the cutting rule of every route
 * need the masters: the server makes them on every save, and the editor makes
 * them from its lookups (specRules releaseGaps). Pure: no lookups beyond `ctx`.
 */
export function sampleSpecGaps(spec: SampleSpecification, ctx: SampleSpecContext): SampleSpecGap[] {
  const gaps: SampleSpecGap[] = []
  const add = (section: SampleSpecSection, message: string) => gaps.push({ section, message })
  const sizeName = (id: string) => ctx.sizes?.find((z) => z.id === id)?.code ?? id

  if (!spec.styleId) add('style', 'Make or link the style this request samples.')
  if (!spec.milestone.trim()) add('details', 'Name the milestone, such as Fit sample.')
  if (!spec.construction.trim()) add('details', 'Describe how the sample is made.')
  if (!spec.techPackRef.trim()) add('details', 'Give the tech pack reference.')
  if (!spec.patternRef.trim()) add('details', 'Give the pattern reference.')

  // The grid.
  const named = spec.colours.filter((r) => r.colour.trim())
  if (!named.length) add('colours', 'Add at least one colour to make.')
  if (spec.colours.some((r) => !r.colour.trim()))
    add('colours', 'Pick the colour for every row of the colour and size grid.')
  const runSizes = ctx.style ? new Set(ctx.style.sizeIds) : null
  const listed = new Set<string>()
  for (const row of named) {
    const c = row.colour.trim()
    if (ctx.style && !ctx.style.colors.some((x) => sameColour(x, c)))
      add(
        'colours',
        `${c} is not one of the style’s colours. Add it to the style first, or pick another.`
      )
    if (listed.has(c.toLowerCase()))
      add('colours', `${c} is listed twice. Put all its sizes in one row.`)
    listed.add(c.toLowerCase())
    if (piecesFor({ colours: [row] }, null) <= 0)
      add('colours', `${c} has no pieces. Enter how many of each size, or take the colour off.`)
    const ids = row.sizes.map((z) => z.sizeId).filter(Boolean)
    if (new Set(ids).size !== ids.length) add('colours', `${c} has the same size twice.`)
  }
  if (spec.colours.some((r) => r.sizes.some((z) => !z.sizeId)))
    add('colours', 'Pick the size for every quantity in the grid.')
  if (
    runSizes &&
    spec.colours.some((r) => r.sizes.some((z) => z.sizeId && !runSizes.has(z.sizeId)))
  )
    add('colours', 'Every size must be from the style’s size run.')

  // Measurements: every size made is measured, and nothing else is.
  const made = sizesInUse(spec)
  if (spec.measurements.some((m) => !m.name.trim()))
    add('measurements', 'Name every measurement point.')
  // A point named with no target yet is kept with no size; the matrix's sizes
  // are its columns, so the fix is a target typed under each size, not a pick.
  const unsized = new Set<string>()
  for (const m of spec.measurements) {
    const name = m.name.trim()
    if (!name || m.sizeId || unsized.has(name.toLowerCase())) continue
    unsized.add(name.toLowerCase())
    add('measurements', `${name}: type its target for each size made.`)
  }
  const points = new Set(spec.measurements.map((m) => m.name.trim().toLowerCase()))
  if (points.size > SAMPLE_MEASURE_MAX_POINTS)
    add('measurements', `Up to ${SAMPLE_MEASURE_MAX_POINTS} measurement points in one round.`)
  if (spec.measurements.length > SAMPLE_MEASURE_MAX_ENTRIES)
    add(
      'measurements',
      `Up to ${SAMPLE_MEASURE_MAX_ENTRIES} measurement targets in one round (points × sizes). Use fewer points or sizes.`
    )
  for (const sizeId of made)
    if (!spec.measurements.some((m) => m.sizeId === sizeId))
      add('measurements', `Add measurements for size ${sizeName(sizeId)}.`)
  const measured = new Set<string>()
  for (const m of spec.measurements) {
    if (!m.sizeId || !m.name.trim()) continue
    if (!made.includes(m.sizeId))
      add(
        'measurements',
        `${m.name} is measured for size ${sizeName(m.sizeId)}, which this round does not make. Remove it, or add pieces of that size.`
      )
    const key = `${m.name.trim().toLowerCase()}|${m.sizeId}`
    if (measured.has(key))
      add('measurements', `${m.name} is measured twice for size ${sizeName(m.sizeId)}.`)
    measured.add(key)
  }

  // The sample BOM.
  if (!spec.materials.length) add('materials', 'Add the materials the sample needs.')
  const repeated = repeatedBomLines(spec.materials)
  spec.materials.forEach((l, i) => {
    const at = `Line ${i + 1}:`
    if (!l.itemId) add('materials', `${at} pick the material.`)
    if (!l.component.trim())
      add('materials', `${at} say which part of the garment it is for, such as Body or Collar.`)
    if (l.colour?.trim() && !named.some((r) => sameColour(r.colour, l.colour)))
      add('materials', `${at} ${l.colour} is not one of this round’s colours.`)
    // A total typed by hand replaces the round's figure, not what one piece
    // takes: costing per piece and the production BOM made at handover
    // (qtyPerUnit, never nought) still need it.
    if (!(num(l.qtyPerPiece) > 0)) add('materials', `${at} enter how much one piece takes.`)
    if (l.requiredOverride) {
      if (!(num(l.requiredQty) > 0)) add('materials', `${at} enter the quantity needed.`)
      if (l.overrideReason.trim().length < OVERRIDE_REASON_MIN)
        add(
          'materials',
          `${at} say why the quantity is typed by hand (${OVERRIDE_REASON_MIN} characters or more).`
        )
    } else if (num(l.qtyPerPiece) > 0 && !(requiredQtyFor(l, spec) > 0))
      add(
        'materials',
        `${at} works out to no quantity. Check its colour and how much one piece takes.`
      )
    if (l.source === 'BUYER_SUPPLIED' && !ctx.hasBuyer)
      add('materials', `${at} material the buyer sends needs a buyer on the request.`)
    const repeat = repeated.get(i)
    if (repeat) add('materials', `${at} ${repeat}`)
  })

  // The making route. Cutting first and only once is every route's rule, and
  // the server checks it with the routing master's own check.
  if (spec.route.length < SAMPLE_ROUTE_MIN_STEPS)
    add('route', 'The making route needs at least two steps, starting with cutting.')
  if (spec.route.length > SAMPLE_ROUTE_MAX_STEPS)
    add('route', `The making route can have up to ${SAMPLE_ROUTE_MAX_STEPS} steps.`)
  if (spec.route.length && !spec.route.some((s) => s.kind === 'STITCHING'))
    add('route', 'Add a stitching step: every sample is stitched.')
  const stepNames = new Set<string>()
  spec.route.forEach((s, i) => {
    const at = `Step ${i + 1}:`
    if (!s.operationId) add('route', `${at} pick the process.`)
    const name = s.name.trim().toLowerCase()
    if (name && stepNames.has(name))
      add('route', `${at} ${s.name} appears twice. Name the step so the two can be told apart.`)
    if (name) stepNames.add(name)
    if (s.execution === 'OUTSOURCED') {
      if (!s.vendorId)
        add('route', `${at} ${s.name || 'this step'} is done outside. Pick the unit it goes to.`)
      if (s.contractorId)
        add('route', `${at} a step done outside has no floor contractor. Clear the contractor.`)
    } else if (s.vendorId)
      add(
        'route',
        `${at} an in-house step goes to no outside unit. Clear the unit, or mark the step as done outside.`
      )
  })
  return gaps
}

/**
 * Any saved specification as it reads now. Rounds saved before the colour and
 * size grid hold { color, sizes, stages, materials: [{ itemId, warehouseId,
 * qty, ownership }] }: the colour and its sizes become one row of the grid (a
 * blank colour stays blank), each step name a route step with no process yet,
 * and each material a line whose planned quantity stands as typed by hand.
 * Everything is written back in this shape on the next save. A released
 * round keeps its sample_stages rows as the record of how it was made.
 */
export function normaliseSpec(raw: unknown): SampleSpecification {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  const list = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []
  const sizes = (v: unknown) => list(v).map((z) => ({ sizeId: text(z.sizeId), qty: num(z.qty) }))
  const kindOf = (v: unknown, name: string): ProcessKind => {
    if (PROCESS_KINDS.includes(v as ProcessKind)) return v as ProcessKind
    // A legacy step is only a name: the three the pilot offered say what they are.
    const legacy = name.trim().toUpperCase()
    return (['CUTTING', 'STITCHING', 'FINISHING'] as const).find((k) => k === legacy) ?? 'OTHER'
  }
  const isV1 = !Array.isArray(s.colours) && ('color' in s || 'sizes' in s || 'stages' in s)

  const colours: SampleColourRow[] = isV1
    ? text(s.color).trim() || list(s.sizes).length
      ? [{ colour: text(s.color).trim(), sizes: sizes(s.sizes) }]
      : []
    : list(s.colours).map((r) => ({ colour: text(r.colour), sizes: sizes(r.sizes) }))

  const route: SampleRouteStep[] = isV1
    ? (Array.isArray(s.stages) ? s.stages : []).map((name) => ({
        operationId: '',
        name: text(name),
        kind: kindOf(undefined, text(name)),
        departmentId: '',
        execution: 'IN_HOUSE' as const,
        contractorId: null,
        vendorId: null,
        instructions: '',
      }))
    : list(s.route).map((r) => ({
        operationId: text(r.operationId),
        name: text(r.name),
        kind: kindOf(r.kind, text(r.name)),
        departmentId: text(r.departmentId),
        execution: r.execution === 'OUTSOURCED' ? 'OUTSOURCED' : 'IN_HOUSE',
        contractorId: text(r.contractorId) || null,
        vendorId: text(r.vendorId) || null,
        instructions: text(r.instructions),
      }))

  const materials: SampleBomLine[] = list(s.materials).map((m) =>
    'qty' in m && !('qtyPerPiece' in m)
      ? {
          component: '',
          itemId: text(m.itemId),
          colour: null,
          departmentId: null,
          qtyPerPiece: 0,
          wastagePct: 0,
          requiredQty: num(m.qty),
          requiredOverride: true,
          overrideReason: 'Planned before the material table',
          source: m.ownership === 'CUSTOMER_OWNED' ? 'BUYER_SUPPLIED' : 'PURCHASE',
          estRate: null,
          remarks: '',
        }
      : {
          ...(text(m.id) ? { id: text(m.id) } : {}),
          component: text(m.component),
          itemId: text(m.itemId),
          colour: text(m.colour) || null,
          departmentId: text(m.departmentId) || null,
          qtyPerPiece: num(m.qtyPerPiece),
          wastagePct: num(m.wastagePct),
          requiredQty: num(m.requiredQty),
          requiredOverride: m.requiredOverride === true,
          overrideReason: text(m.overrideReason),
          source: m.source === 'BUYER_SUPPLIED' ? 'BUYER_SUPPLIED' : 'PURCHASE',
          estRate:
            m.estRate === null || m.estRate === undefined || m.estRate === ''
              ? null
              : num(m.estRate),
          remarks: text(m.remarks),
        }
  )

  return {
    milestone: text(s.milestone),
    styleId: text(s.styleId),
    construction: text(s.construction),
    techPackRef: text(s.techPackRef),
    patternRef: text(s.patternRef),
    colours,
    measurements: list(s.measurements).map((m) => ({
      name: text(m.name),
      sizeId: text(m.sizeId),
      target: num(m.target),
      tolerance: num(m.tolerance),
      unit: m.unit === 'in' ? 'in' : 'cm',
    })),
    route,
    materials,
    notes: text(s.notes),
  }
}

/**
 * What a file on a sample request is. The buyer's tech pack arrives first and
 * is filed against the request itself; photos, patterns, approvals and courier
 * slips usually belong to one round. Kept as plain codes so the database can
 * check them (sample_attachment_kind) and every screen labels them alike.
 */
export const SAMPLE_ATTACHMENT_KINDS = [
  'TECH_PACK',
  'PATTERN',
  'PHOTO',
  'APPROVAL',
  'DISPATCH',
  'OTHER',
] as const
export type SampleAttachmentKind = (typeof SAMPLE_ATTACHMENT_KINDS)[number]
export const SAMPLE_ATTACHMENT_KIND_LABEL: Record<SampleAttachmentKind, string> = {
  TECH_PACK: 'Tech pack',
  PATTERN: 'Pattern',
  PHOTO: 'Photo',
  APPROVAL: 'Buyer approval',
  DISPATCH: 'Dispatch slip',
  OTHER: 'Other',
}

/** One file kept against a sample request, or against one of its rounds. */
export interface SampleAttachment {
  id: string
  requestId: string
  /** Null for a file of the whole request, such as the buyer's tech pack. */
  roundId: string | null
  kind: SampleAttachmentKind
  fileName: string
  storagePath: string
  mimeType: string | null
  sizeBytes: number
  uploadedById: string
  uploadedBy?: { id: string; name: string } | null
  createdAt: string
  /** Sent by the file list: false once the file is kept as part of the record. */
  removable?: boolean
  /** Why it can no longer be removed, in words; null while it can. */
  lockedReason?: string | null
}

/**
 * Where a style stands. A new style the buyer sends for sampling is made as
 * DEVELOPMENT, kept off order, BOM and production screens, and becomes
 * PRODUCTION only when its sample is approved and handed over.
 */
export const STYLE_STAGES = ['DEVELOPMENT', 'PRODUCTION'] as const
export type StyleStage = (typeof STYLE_STAGES)[number]
export const STYLE_STAGE_LABEL: Record<StyleStage, string> = {
  DEVELOPMENT: 'In sampling',
  PRODUCTION: 'Production',
}

/** The request's style, as the request detail and the register carry it. */
export interface SampleRequestStyle {
  id: string
  code: string
  name: string
  stage: StyleStage
  brandId: string | null
  category: string | null
  season: string | null
  sizeGroupId: string | null
  colors: string[]
  isActive: boolean
}

// ── Sourcing: buying for a sample (phase 3) ───────────────────────────────────

/** One purchase order line buying for a sample line, as Sampling and the order form read it. */
export interface SampleOrderLine {
  /** The order line's own id. */
  id: string
  poId: string
  poNumber: string
  /**
   * The order's status: DRAFT, SENT, PARTIALLY_RECEIVED, COMPLETED, or
   * CANCELLED for an order called off after some of it arrived (one that
   * received nothing is left out).
   */
  status: string
  supplierName: string
  poDate: string | Date | null
  deliveryDate: string | Date | null
  qty: number | string
  /** What has arrived against it, on receipts that are not cancelled. */
  receivedQty: number | string
  /** Its balance was written off as not coming: it orders only what arrived. */
  shortClosed: boolean
  /** Its order was cancelled after some of it arrived: it, too, orders only what arrived. */
  cancelled: boolean
}

/**
 * What the orders count as bought for a sample line: each line's quantity, or
 * only what arrived on a line closed short or an order cancelled after part of
 * it came (the rest is not coming). Deleted orders, and cancelled ones that
 * received nothing, are never passed in. Summed off the order lines every
 * time, never kept as a counter.
 */
export function sampleOrdered(
  lines: Array<Pick<SampleOrderLine, 'qty' | 'receivedQty' | 'shortClosed'> & { cancelled?: boolean }>
) {
  return round3(
    lines.reduce((t, l) => t + (l.shortClosed || l.cancelled ? num(l.receivedQty) : num(l.qty)), 0)
  )
}
/** What has arrived for a sample line, on its orders' receipts. */
export function sampleReceived(lines: Array<Pick<SampleOrderLine, 'receivedQty'>>) {
  return round3(lines.reduce((t, l) => t + num(l.receivedQty), 0))
}
/**
 * What is still to be ordered for a line that needs `required`: never below
 * nothing. What has already been issued to the line counts as covered too,
 * whichever is more — material issued from stock before it was bought for the
 * sample is not bought again.
 */
export function sampleToBuy(
  required: number | string,
  lines: Array<Pick<SampleOrderLine, 'qty' | 'receivedQty' | 'shortClosed'> & { cancelled?: boolean }>,
  issued: number | string = 0
) {
  return round3(Math.max(0, num(required) - Math.max(sampleOrdered(lines), num(issued))))
}
/** The least a reason for ordering more than a sample line still needs may say. */
export const SAMPLE_OVER_REASON_MIN = 5

/** A line of a sample's BOM that is bought, and how far its buying has got. */
export interface SampleNeed {
  sampleMaterialId: string
  requestId: string
  requestNumber: string
  title: string
  customerName: string | null
  buyerStyleRef: string | null
  style: { id: string; code: string } | null
  requiredAt: string | Date | null
  roundId: string
  revision: number
  component: string
  /** Null: every colour of the round. */
  colour: string | null
  item: {
    id: string
    code: string
    name: string
    hsnCode: string | null
    categoryId: string | null
    uom: { symbol: string } | null
    taxRate: { id: string; rate: number | string } | null
  }
  requiredQty: number
  orderedQty: number
  receivedQty: number
  toBuy: number
  /** What the merchandiser expects one unit to cost. */
  estRate: number | null
  orders: SampleOrderLine[]
}

// ── The request's own material in the sample stores (phase 4) ─────────────────

/** One item of a request in one sample store (samplePool.service). */
export interface SamplePoolStore {
  itemId: string
  warehouseId: string
  /** What its receipts put there, net of quality-check rejects, returns to the supplier and notes. */
  received: number
  /** Issued from there to its lines, net of returns. */
  issued: number
  /** Closed out: used up in the sample, or moved to a general store. */
  closed: number
  /** What the request may still issue from there. */
  available: number
}
/** How one line of the round being made is covered. */
export interface SampleLineCover {
  /** Still to issue for making; 0 for a line of another round, waived, or issued in full. */
  remaining: number
  /** Covered by what the request already holds (or, for the buyer's material, by the buyer's stock). */
  fromPool: number
  /** Covered by its orders still to arrive. */
  awaited: number
  /** Still to buy. */
  toBuy: number
}
export interface SamplePool {
  stores: SamplePoolStore[]
  /** By sample line id. */
  lines: Record<string, SampleLineCover>
  /** The buyer's own stock of each item in the sample stores, by item id. */
  buyerStock: Record<string, number>
  /** The same, store by store: what an issue from one sample store can take. */
  buyerStores: Array<{ itemId: string; warehouseId: string; available: number }>
  /** What the round being made still has to buy of each item we buy, by item id (the sum of its lines' toBuy). */
  toBuyByItem: Record<string, number>
}
/** How a request's leftover material is closed out. */
export const SAMPLE_CLOSEOUT_KINDS = ['USED', 'MOVED'] as const
export type SampleCloseOutKind = (typeof SAMPLE_CLOSEOUT_KINDS)[number]
export const SAMPLE_CLOSEOUT_LABEL: Record<SampleCloseOutKind, string> = {
  USED: 'Used in this sample',
  MOVED: 'Moved to a general store',
}
/** The least a reason for waiving a line, or closing out leftovers, may say. */
export const SAMPLE_REASON_MIN = 5
