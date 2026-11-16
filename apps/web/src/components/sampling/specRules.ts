/**
 * The specification editor's own rules, apart from its screens so the checks
 * (tools/check-sampling-ui.cjs) can run them without a browser: how the editor
 * holds a round's specification while it is being typed, the colour and size
 * grid's totals, which tab answers each gap, and what taking a colour or a size
 * off the round takes with it.
 *
 * The arithmetic is the shared one (@ld-erp/shared), which the server runs on
 * every save, so the quantities and gaps on screen are the ones it will keep.
 */
import {
  lineRequiredQty,
  repeatedBomLines,
  requiredQtyFor,
  sampleSpecGaps,
  sizesInUse,
  totalPieces,
  SAMPLE_DUPLICATE_LINE,
  type SampleBomLine,
  type SampleColourRow,
  type SampleItemOption,
  type SampleMaterialSource,
  type SampleMeasurement,
  type SampleRouteStep,
  type SampleSpecContext,
  type SampleSpecGap,
  type SampleSpecSection,
  type SampleSpecification,
} from '@ld-erp/shared'
import type { Lookups, LookupOperation } from './types'

// ── Tabs ─────────────────────────────────────────────────────────────────────

export type SpecTab = 'style' | 'measurements' | 'materials' | 'route' | 'review'
export const SPEC_TABS: ReadonlyArray<{ key: SpecTab; title: string; hint: string }> = [
  {
    key: 'style',
    title: 'Style & colours',
    hint: 'The documents to follow, and how many pieces of each colour and size to make.',
  },
  {
    key: 'measurements',
    title: 'Measurements',
    hint: 'The points QC measures, with a target for each size. Every colour is measured alike.',
  },
  {
    key: 'materials',
    title: 'Materials',
    hint: 'Everything one piece uses. The quantity the round needs is worked out from the pieces.',
  },
  {
    key: 'route',
    title: 'Route',
    hint: 'The processes the sample goes through, in order, and who does each one.',
  },
  {
    key: 'review',
    title: 'Review & release',
    hint: 'What is still missing. Release freezes this round and starts the making.',
  },
]
/** The tab that fixes each part of the specification the gaps name. */
export const GAP_TAB: Record<SampleSpecSection, SpecTab> = {
  style: 'style',
  details: 'style',
  colours: 'style',
  measurements: 'measurements',
  materials: 'materials',
  route: 'route',
}
export function gapsByTab(gaps: SampleSpecGap[]) {
  const out: Record<SpecTab, SampleSpecGap[]> = {
    style: [],
    measurements: [],
    materials: [],
    route: [],
    review: [],
  }
  for (const g of gaps) out[GAP_TAB[g.section]].push(g)
  return out
}

// ── The specification as the editor holds it ─────────────────────────────────
//
// Numbers stay as typed (text) until saved: a box that turned "1." into 1 at
// every key press could never be given a decimal point. Each row carries a key
// of its own, so a row added or moved mid-list keeps its own boxes.

/** One colour of the grid: its pieces by size. */
export interface GridRow {
  colour: string
  qty: Record<string, number>
}
/** One measurement point across the sizes: a row of the points × sizes matrix. */
export interface MeasurePoint {
  key: string
  name: string
  tolerance: string
  unit: 'cm' | 'in'
  /** Target by size id, as typed; blank is not measured for that size. */
  targets: Record<string, string>
}
export interface EditLine {
  key: string
  /** The material row's own id once saved: sent back unchanged, so the row stays the same row. */
  id?: string
  component: string
  itemId: string
  colour: string | null
  departmentId: string | null
  qtyPerPiece: string
  wastagePct: string
  requiredOverride: boolean
  /** Only read while overridden; otherwise the quantity is worked out. */
  requiredQty: string
  overrideReason: string
  source: SampleMaterialSource
  estRate: string
  remarks: string
}
export type EditStep = SampleRouteStep & { key: string }
export interface SpecDraft {
  milestone: string
  styleId: string
  construction: string
  techPackRef: string
  patternRef: string
  notes: string
  /** The sizes this round makes: the grid's columns that are switched on. */
  sizeIds: string[]
  colours: GridRow[]
  points: MeasurePoint[]
  lines: EditLine[]
  route: EditStep[]
}
export type SpecDetail = 'milestone' | 'construction' | 'techPackRef' | 'patternRef' | 'notes'

let seq = 0
const nextKey = (prefix: string) => `${prefix}${++seq}`
const num = (v: string) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
/** A stored figure as the box shows it; nothing for 0 where 0 means "not entered". */
const shown = (v: number, blankZero = false) => (blankZero && !v ? '' : String(v))
const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()

/** Cuts what is typed to `dp` decimal places, as the server keeps them (and refuses more). */
export function limitDecimals(value: string, dp: number) {
  const at = value.indexOf('.')
  if (at < 0) return value
  return dp > 0 ? value.slice(0, at + 1 + dp) : value.slice(0, at)
}

export const newPoint = (unit: 'cm' | 'in' = 'cm'): MeasurePoint => ({
  key: nextKey('p'),
  name: '',
  tolerance: '',
  unit,
  targets: {},
})
export const newLine = (): EditLine => ({
  key: nextKey('l'),
  component: '',
  itemId: '',
  colour: null,
  departmentId: null,
  qtyPerPiece: '',
  wastagePct: '',
  requiredOverride: false,
  requiredQty: '',
  overrideReason: '',
  source: 'PURCHASE',
  estRate: '',
  remarks: '',
})
export const newStep = (): EditStep => ({
  key: nextKey('s'),
  operationId: '',
  name: '',
  kind: 'OTHER',
  departmentId: '',
  execution: 'IN_HOUSE',
  contractorId: null,
  vendorId: null,
  instructions: '',
})
export const stepsOf = (route: SampleRouteStep[]): EditStep[] =>
  route.map((s) => ({ ...s, key: nextKey('s') }))

/**
 * The flat measurement list as rows of the matrix: one row per point name,
 * with a target per size. A point taken twice for the same size (only an old
 * round can hold one) becomes a second row, so nothing typed is lost; the
 * gaps then say it is measured twice. A point listed with different
 * tolerances for different sizes takes the first: the matrix keeps one
 * tolerance per point.
 */
export function pointsOf(list: SampleMeasurement[]): MeasurePoint[] {
  const points: MeasurePoint[] = []
  for (const m of list) {
    let p = points.find((x) => sameText(x.name, m.name) && (!m.sizeId || !(m.sizeId in x.targets)))
    if (!p) {
      p = {
        key: nextKey('p'),
        name: m.name,
        tolerance: shown(m.tolerance),
        unit: m.unit,
        targets: {},
      }
      points.push(p)
    }
    if (m.sizeId) p.targets[m.sizeId] = shown(m.target)
  }
  return points
}
/**
 * The matrix as the flat list the specification keeps: a point's targets in
 * the grid's size order. A named point with no target yet is kept as one
 * entry with no size, so a draft does not lose it; the gaps ask for its sizes.
 * A row with neither a name nor a target is nothing and is left out.
 */
export function flattenPoints(points: MeasurePoint[], sizeIds: string[]): SampleMeasurement[] {
  const rank = (id: string) => {
    const at = sizeIds.indexOf(id)
    return at < 0 ? sizeIds.length : at
  }
  const out: SampleMeasurement[] = []
  for (const p of points) {
    const filled = Object.entries(p.targets)
      .filter(([, v]) => v.trim() !== '')
      .sort((a, b) => rank(a[0]) - rank(b[0]))
    if (!p.name.trim() && !filled.length) continue
    // In the order the shared shape lists them, so a saved list compares as equal.
    const entry = (sizeId: string, target: number): SampleMeasurement => ({
      name: p.name,
      sizeId,
      target,
      tolerance: num(p.tolerance),
      unit: p.unit,
    })
    if (!filled.length) out.push(entry('', 0))
    for (const [sizeId, target] of filled) out.push(entry(sizeId, num(target)))
  }
  return out
}

/**
 * A line with nothing in it, never saved: left out rather than kept as an
 * empty row. Anything picked counts, a colour, department or source as much as
 * a material: a line left out is lost at the next save, and would shift the
 * line numbers the gaps give against the grid's.
 */
export const blankLine = (l: EditLine) =>
  !l.id &&
  !l.itemId &&
  !l.component.trim() &&
  !l.qtyPerPiece.trim() &&
  !l.wastagePct.trim() &&
  !l.estRate.trim() &&
  !l.remarks.trim() &&
  !l.requiredOverride &&
  !l.colour &&
  !l.departmentId &&
  l.source === 'PURCHASE'
export const blankStep = (s: SampleRouteStep) =>
  !s.operationId &&
  !s.name.trim() &&
  !s.instructions.trim() &&
  !s.contractorId &&
  !s.vendorId &&
  !s.departmentId &&
  s.execution === 'IN_HOUSE'

/** A line as the specification keeps it, its quantity worked out unless typed by hand. */
export function bomLineOf(l: EditLine, spec: Pick<SampleSpecification, 'colours'>): SampleBomLine {
  const line: SampleBomLine = {
    ...(l.id ? { id: l.id } : {}),
    component: l.component,
    itemId: l.itemId,
    colour: l.colour?.trim() ? l.colour : null,
    departmentId: l.departmentId || null,
    qtyPerPiece: num(l.qtyPerPiece),
    wastagePct: num(l.wastagePct),
    requiredQty: 0,
    requiredOverride: l.requiredOverride,
    // A reason belongs to a quantity typed by hand, as the server keeps it.
    overrideReason: l.requiredOverride ? l.overrideReason : '',
    source: l.source,
    estRate: l.estRate.trim() === '' ? null : num(l.estRate),
    remarks: l.remarks,
  }
  line.requiredQty = l.requiredOverride ? num(l.requiredQty) : requiredQtyFor(line, spec)
  return line
}

/** What is on screen, as the specification the server is sent. */
export function toSpec(d: SpecDraft): SampleSpecification {
  const colours: SampleColourRow[] = d.colours.map((r) => ({
    colour: r.colour,
    sizes: d.sizeIds.map((sizeId) => ({ sizeId, qty: r.qty[sizeId] ?? 0 })),
  }))
  return {
    milestone: d.milestone,
    styleId: d.styleId,
    construction: d.construction,
    techPackRef: d.techPackRef,
    patternRef: d.patternRef,
    colours,
    measurements: flattenPoints(d.points, d.sizeIds),
    route: d.route.filter((s) => !blankStep(s)).map(({ key: _key, ...s }) => s),
    materials: d.lines.filter((l) => !blankLine(l)).map((l) => bomLineOf(l, { colours })),
    notes: d.notes,
  }
}

/**
 * A saved specification as the editor holds it. `runSizeIds` is the style's
 * size run in order: the grid's sizes follow it, and a round with no colours
 * yet starts with every size of the run switched on. Rows of `previous` (the
 * screen before a save) lend their keys by position, so saving does not throw
 * the cursor out of the box it was in. With `operations` (the processes in
 * use), a step with a process takes that process's department, as the route
 * shows it and the server keeps it, however it was saved before.
 */
export function fromSpec(
  spec: SampleSpecification,
  opts: {
    runSizeIds: string[]
    previous?: SpecDraft | null
    operations?: Array<Pick<LookupOperation, 'id' | 'departmentId'>>
  }
): SpecDraft {
  const prev = opts.previous
  const listed: string[] = []
  for (const r of spec.colours)
    for (const z of r.sizes) if (!listed.includes(z.sizeId)) listed.push(z.sizeId)
  const sizeIds = spec.colours.length
    ? [
        ...opts.runSizeIds.filter((id) => listed.includes(id)),
        // Sizes outside the run (an old round's) stay, at the end, until taken off.
        ...listed.filter((id) => !opts.runSizeIds.includes(id)),
      ]
    : (prev?.sizeIds ?? opts.runSizeIds)
  const keyed = <T extends { key: string }>(rows: T[], before?: T[]) =>
    before && before.length === rows.length
      ? rows.map((r, i) => ({ ...r, key: before[i].key }))
      : rows
  const lines: EditLine[] = spec.materials.map((m) => ({
    key: nextKey('l'),
    ...(m.id ? { id: m.id } : {}),
    component: m.component,
    itemId: m.itemId,
    colour: m.colour,
    departmentId: m.departmentId,
    qtyPerPiece: shown(m.qtyPerPiece, true),
    wastagePct: shown(m.wastagePct, true),
    requiredOverride: m.requiredOverride,
    requiredQty: m.requiredOverride ? shown(m.requiredQty, true) : '',
    overrideReason: m.overrideReason,
    source: m.source,
    estRate: m.estRate === null ? '' : shown(m.estRate),
    remarks: m.remarks,
  }))
  return {
    milestone: spec.milestone,
    styleId: spec.styleId,
    construction: spec.construction,
    techPackRef: spec.techPackRef,
    patternRef: spec.patternRef,
    notes: spec.notes,
    sizeIds,
    colours: spec.colours.map((r) => ({
      colour: r.colour,
      qty: Object.fromEntries(r.sizes.map((z) => [z.sizeId, z.qty])),
    })),
    points: keyed(pointsOf(spec.measurements), prev?.points),
    lines: keyed(lines, prev?.lines),
    route: keyed(stepsOf(processDepartments(spec.route, opts.operations)), prev?.route),
  }
}
/** Each step with a process in use done by that process's own department. */
export function processDepartments<T extends SampleRouteStep>(
  route: T[],
  operations?: Array<Pick<LookupOperation, 'id' | 'departmentId'>>
): T[] {
  if (!operations) return route
  const own = new Map(operations.map((o) => [o.id, o.departmentId]))
  return route.map((s) => {
    const dept = s.operationId ? own.get(s.operationId) : undefined
    return dept && dept !== s.departmentId ? { ...s, departmentId: dept } : s
  })
}

/** Which tabs hold changes not saved yet: one dot each. */
export function changedTabs(now: SampleSpecification, saved: SampleSpecification) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const details = (s: SampleSpecification) => [
    s.milestone,
    s.styleId,
    s.construction,
    s.techPackRef,
    s.patternRef,
    s.notes,
    s.colours,
  ]
  return {
    style: !same(details(now), details(saved)),
    measurements: !same(now.measurements, saved.measurements),
    materials: !same(now.materials, saved.materials),
    route: !same(now.route, saved.route),
    review: false,
  } satisfies Record<SpecTab, boolean>
}

/** A row moved one place up (-1) or down (1); the list as it was at either end. */
export function moveRow<T>(rows: T[], index: number, dir: -1 | 1): T[] {
  const to = index + dir
  if (to < 0 || to >= rows.length) return rows
  const next = [...rows]
  ;[next[index], next[to]] = [next[to], next[index]]
  return next
}

// ── The colour × size grid ───────────────────────────────────────────────────

/** Pieces by colour row and by size, and the round's total. */
export function gridTotals(d: Pick<SpecDraft, 'colours' | 'sizeIds'>) {
  const rows = d.colours.map((r) => d.sizeIds.reduce((t, id) => t + (r.qty[id] ?? 0), 0))
  const cols: Record<string, number> = {}
  for (const id of d.sizeIds) cols[id] = d.colours.reduce((t, r) => t + (r.qty[id] ?? 0), 0)
  return { rows, cols, total: rows.reduce((a, b) => a + b, 0) }
}
/**
 * The grid's columns: the style's whole size run in order, each switched on
 * or off for this round, then any size switched on that is not in the run
 * (only an old round has one), so it can be seen and taken off.
 */
export function gridColumns(runSizeIds: string[], sizeIds: string[]) {
  return [
    ...runSizeIds.map((sizeId) => ({ sizeId, on: sizeIds.includes(sizeId), inRun: true })),
    ...sizeIds
      .filter((id) => !runSizeIds.includes(id))
      .map((sizeId) => ({ sizeId, on: true, inRun: false })),
  ]
}
/** A size switched on, in its place in the run. */
export function addSize(d: SpecDraft, sizeId: string, runSizeIds: string[]): SpecDraft {
  if (d.sizeIds.includes(sizeId)) return d
  const on = [...d.sizeIds, sizeId]
  return {
    ...d,
    sizeIds: [
      ...runSizeIds.filter((id) => on.includes(id)),
      ...on.filter((id) => !runSizeIds.includes(id)),
    ],
  }
}
/** What switching a size off clears: its pieces in every colour and its measurement targets. */
export function sizeRemoval(d: SpecDraft, sizeId: string) {
  return {
    pieces: d.colours.reduce((t, r) => t + (r.qty[sizeId] ?? 0), 0),
    targets: d.points.filter((p) => (p.targets[sizeId] ?? '').trim() !== '').length,
  }
}
export function sizeRemovalText(code: string, loss: { pieces: number; targets: number }) {
  const parts = [
    loss.pieces && plural(loss.pieces, 'piece'),
    loss.targets && plural(loss.targets, 'measurement target'),
  ].filter((x): x is string => !!x)
  if (!parts.length) return ''
  const them = loss.pieces + loss.targets === 1 ? 'it' : 'them'
  return `Size ${code} has ${joinAnd(parts)}. Taking the size off this round clears ${them}.`
}
export function removeSize(d: SpecDraft, sizeId: string): SpecDraft {
  const drop = <T>(rec: Record<string, T>) => {
    const next = { ...rec }
    delete next[sizeId]
    return next
  }
  return {
    ...d,
    sizeIds: d.sizeIds.filter((id) => id !== sizeId),
    colours: d.colours.map((r) => ({ ...r, qty: drop(r.qty) })),
    points: d.points.map((p) => ({ ...p, targets: drop(p.targets) })),
  }
}
/** Pieces of one colour and size: whole numbers, 0 to 1000, as the server takes them. */
export function setPieces(d: SpecDraft, row: number, sizeId: string, typed: string): SpecDraft {
  const qty = Math.min(1000, Math.max(0, Math.trunc(num(typed))))
  return {
    ...d,
    colours: d.colours.map((r, i) => (i === row ? { ...r, qty: { ...r.qty, [sizeId]: qty } } : r)),
  }
}
/** The style's colours not in the grid yet, for the "Add a colour" list. */
export const coloursToAdd = (styleColours: string[], d: Pick<SpecDraft, 'colours'>) =>
  styleColours.filter((c) => !d.colours.some((r) => sameText(r.colour, c)))
export const addColour = (d: SpecDraft, colour: string): SpecDraft => ({
  ...d,
  colours: [...d.colours, { colour, qty: {} }],
})
/** A colour picked for a row that had none (only an old round has one). */
export const nameColour = (d: SpecDraft, row: number, colour: string): SpecDraft => ({
  ...d,
  colours: d.colours.map((r, i) => (i === row ? { ...r, colour } : r)),
})
/** The material lines that are for one colour only. */
const linesFor = (d: Pick<SpecDraft, 'lines'>, colour: string) =>
  colour.trim() ? d.lines.filter((l) => l.colour && sameText(l.colour, colour)) : []
/**
 * What taking a colour off the round takes with it: its pieces, and the
 * material lines that are for that colour only. The server refuses a line
 * whose colour is not in the grid, so they go in the same save.
 */
export function colourRemoval(d: SpecDraft, row: number) {
  const r = d.colours[row]
  const colour = r?.colour ?? ''
  return {
    colour,
    pieces: r ? d.sizeIds.reduce((t, id) => t + (r.qty[id] ?? 0), 0) : 0,
    lines:
      r && !d.colours.some((x, i) => i !== row && sameText(x.colour, colour))
        ? linesFor(d, colour)
        : [],
  }
}
/** Says what goes, naming each line by its part and material; '' when nothing goes. */
export function colourRemovalText(
  loss: { colour: string; pieces: number; lines: EditLine[] },
  itemName: (id: string) => string = () => ''
) {
  const parts = [
    loss.pieces && plural(loss.pieces, 'piece'),
    loss.lines.length && `${plural(loss.lines.length, 'material line')} for ${loss.colour} only`,
  ].filter((x): x is string => !!x)
  if (!parts.length) return ''
  const named = loss.lines
    .map((l) => [l.component.trim(), itemName(l.itemId)].filter(Boolean).join(': '))
    .filter(Boolean)
  const which = named.length ? ` (${named.join(', ')})` : ''
  const them = loss.pieces + loss.lines.length === 1 ? 'it' : 'them'
  const colour = loss.colour.trim()
  return `${colour || 'This row'} has ${joinAnd(parts)}${which}. Taking ${colour || 'the row'} off this round removes ${them}.`
}
export function removeColour(d: SpecDraft, row: number): SpecDraft {
  const gone = new Set(colourRemoval(d, row).lines.map((l) => l.key))
  return {
    ...d,
    colours: d.colours.filter((_, i) => i !== row),
    lines: d.lines.filter((l) => !gone.has(l.key)),
  }
}

// ── Measurements ─────────────────────────────────────────────────────────────

/**
 * The matrix's columns: the sizes the round makes, in the grid's order, then
 * any size that still has targets but no pieces, marked so it can be cleared
 * (release refuses a size measured but not made).
 */
export function measureColumns(d: Pick<SpecDraft, 'colours' | 'sizeIds' | 'points'>) {
  const totals = gridTotals(d).cols
  const made = d.sizeIds.filter((id) => totals[id] > 0)
  const stale: string[] = []
  for (const p of d.points)
    for (const [id, v] of Object.entries(p.targets))
      if (v.trim() !== '' && !made.includes(id) && !stale.includes(id)) stale.push(id)
  const rank = (id: string) => {
    const at = d.sizeIds.indexOf(id)
    return at < 0 ? d.sizeIds.length : at
  }
  stale.sort((a, b) => rank(a) - rank(b))
  return [
    ...made.map((sizeId) => ({ sizeId, made: true })),
    ...stale.map((sizeId) => ({ sizeId, made: false })),
  ]
}
/** Clears one size's targets from every point: a size measured but no longer made. */
export const clearTargets = (d: SpecDraft, sizeId: string): SpecDraft => ({
  ...d,
  points: d.points.map((p) => {
    const targets = { ...p.targets }
    delete targets[sizeId]
    return { ...p, targets }
  }),
})
/** Whether removing a point loses anything typed, so the screen asks first. */
export const pointHasData = (p: MeasurePoint) =>
  !!p.name.trim() || !!p.tolerance.trim() || Object.values(p.targets).some((v) => v.trim() !== '')

// ── Materials ────────────────────────────────────────────────────────────────

/**
 * A line given a material: the item's department and expected rate fill the
 * line's own unless somebody changed them from the last material's. Material
 * the buyer sends costs us nothing, so it takes no rate.
 */
export function lineWithItem(
  line: EditLine,
  item: Pick<SampleItemOption, 'id' | 'departmentId' | 'standardRate'> | undefined,
  before?: Pick<SampleItemOption, 'departmentId' | 'standardRate'>
): EditLine {
  if (!item) return { ...line, itemId: '' }
  const deptUntouched = !line.departmentId || line.departmentId === before?.departmentId
  const rateUntouched =
    line.estRate.trim() === '' ||
    (before?.standardRate != null && num(line.estRate) === before.standardRate)
  const itemRate =
    item.standardRate == null || line.source === 'BUYER_SUPPLIED' ? '' : String(item.standardRate)
  return {
    ...line,
    itemId: item.id,
    departmentId: deptUntouched ? item.departmentId : line.departmentId,
    estRate: rateUntouched ? itemRate : line.estRate,
  }
}
/**
 * A line whose source changes: sent by the buyer, the rate its material filled
 * in goes (we pay nothing for it); bought again, an empty rate takes the
 * material's own. A rate somebody typed stays either way.
 */
export function lineWithSource(
  line: EditLine,
  source: SampleMaterialSource,
  item?: Pick<SampleItemOption, 'standardRate'>
): EditLine {
  const std = item?.standardRate ?? null
  const typed = line.estRate.trim()
  if (source === 'BUYER_SUPPLIED' && std !== null && typed !== '' && num(typed) === std)
    return { ...line, source, estRate: '' }
  if (source === 'PURCHASE' && std !== null && typed === '')
    return { ...line, source, estRate: String(std) }
  return { ...line, source }
}
/**
 * The lines that repeat an earlier one, by position, with why: the same part
 * and material for a colour twice, or a line for every colour beside one for a
 * single colour (the shared rule the gaps and the server apply).
 */
export const duplicateLines = (lines: SampleBomLine[]) => repeatedBomLines(lines)
export const DUPLICATE_LINE_TEXT = SAMPLE_DUPLICATE_LINE
/**
 * A line's expected cost: the quantity it stands for at its expected rate;
 * null with no rate, and for material the buyer sends, which costs us nothing.
 */
export function lineCost(l: SampleBomLine, spec: Pick<SampleSpecification, 'colours'>) {
  if (l.source === 'BUYER_SUPPLIED' || l.estRate === null) return null
  return Math.round(lineRequiredQty(l, spec) * l.estRate * 100) / 100
}
/**
 * What we expect to pay for the round's material, and how many of the lines we
 * buy have no rate yet. Material the buyer sends is neither.
 */
export function materialCost(spec: Pick<SampleSpecification, 'colours' | 'materials'>) {
  let total = 0
  let unrated = 0
  for (const l of spec.materials) {
    if (l.source === 'BUYER_SUPPLIED') continue
    const cost = lineCost(l, spec)
    if (cost === null) unrated++
    else total += cost
  }
  return { total: Math.round(total * 100) / 100, unrated }
}
/** What the cost total is called wherever it is shown, on screen and on paper. */
export const MATERIAL_COST_LABEL = 'Estimated cost of what we buy'
/**
 * An expected rate as it is kept: to 4 places when it has them, 2 at least,
 * with Indian grouping. One figure on screen and in print, never shortened.
 */
export const rateFigure = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
/**
 * The materials the picker offers: the list read with the page, then any found
 * or added since, each once, in name order.
 */
export function mergeItems(list: SampleItemOption[], more: SampleItemOption[]) {
  const seen = new Set(list.map((i) => i.id))
  const added: SampleItemOption[] = []
  for (const i of more)
    if (!seen.has(i.id)) {
      seen.add(i.id)
      added.push(i)
    }
  return added.length ? [...list, ...added].sort((a, b) => a.name.localeCompare(b.name)) : list
}
/** A material whose name or code is what was typed, however it is capitalised. */
export function itemNamed(items: SampleItemOption[], typed: string) {
  const t = typed.trim().toLowerCase()
  if (!t) return undefined
  return items.find((i) => i.name.trim().toLowerCase() === t || i.code.trim().toLowerCase() === t)
}
/** Whether removing a line loses anything typed, so the screen asks first. */
export const lineHasData = (l: EditLine) => !!l.id || !blankLine(l)

// ── The making route ─────────────────────────────────────────────────────────

/**
 * A step given a process: its kind, department and where it is usually done
 * come from the Operation master, and its name and instructions too unless
 * somebody wrote their own over the last process's.
 */
export function stepWithOperation(
  step: EditStep,
  op: LookupOperation,
  before?: Pick<LookupOperation, 'name' | 'instructions'>
): EditStep {
  const ownName = !!step.name.trim() && !sameText(step.name, before?.name)
  const ownWords = !!step.instructions.trim() && !sameText(step.instructions, before?.instructions)
  return {
    ...step,
    operationId: op.id,
    kind: op.kind,
    name: ownName ? step.name : op.name,
    departmentId: op.departmentId,
    execution: op.defaultExecution,
    contractorId: null,
    vendorId: null,
    instructions: ownWords ? step.instructions : (op.instructions ?? ''),
  }
}
/** Done on our floor or outside: who takes it goes with it. */
export const stepDoneAt = (step: EditStep, execution: SampleRouteStep['execution']): EditStep => ({
  ...step,
  execution,
  contractorId: null,
  vendorId: null,
})
/** In the routing master's words: every route is cut first, and once. */
export const ROUTE_TEXT = {
  cuttingFirst: 'Start with cutting: that is where the pieces are made.',
  oneCutting: 'Cut once: only one cutting step.',
  // As the server's route check warns (checkRouteSteps), word for word.
  noCheck: 'There is no quality check on this route, so pieces go to finished goods without one.',
  firstStep: 'The first step is cutting.',
  laterCut: 'Cutting is done once, as the first step.',
} as const
/**
 * The route rules every routing keeps, which the server applies on save and
 * release (checkRouteSteps) and the shared gaps leave to it: cutting first and
 * only once, and a warning, not a stop, when nothing checks the pieces. A step
 * counts by its process; one with no process yet is no kind at all.
 */
export function routeRules(route: Array<Pick<SampleRouteStep, 'operationId' | 'kind'>>) {
  const kinds = route.map((s) => (s.operationId ? s.kind : undefined))
  const problems: string[] = []
  if (route.length && kinds[0] !== 'CUTTING') problems.push(ROUTE_TEXT.cuttingFirst)
  if (kinds.filter((k) => k === 'CUTTING').length > 1) problems.push(ROUTE_TEXT.oneCutting)
  return {
    problems,
    noCheck: route.length > 0 && !kinds.includes('QC'),
    /** What is wrong with each step's process, for its box. */
    steps: kinds.map((k, i) =>
      i === 0 && route.length && k !== undefined && k !== 'CUTTING'
        ? ROUTE_TEXT.firstStep
        : i > 0 && k === 'CUTTING'
          ? ROUTE_TEXT.laterCut
          : ''
    ),
  }
}
/** Whether the route has steps a template or routing would replace. */
export const routeHasSteps = (route: SampleRouteStep[]) => route.some((s) => !blankStep(s))

// ── Review ───────────────────────────────────────────────────────────────────

/** The masters in use, as the editor's lookups list them. */
export type LiveMasters = Pick<
  Lookups,
  'items' | 'operations' | 'departments' | 'contractors' | 'jobWorkers'
>
/**
 * What the masters have switched off since a line or step was filled in: a
 * material, process, department, contractor or outside unit no longer in use.
 * The server refuses every save that names one (a copied round can carry one
 * over), and the editor's lists hold only what is in use, so the editor says
 * so first, numbering lines and steps as the gaps do.
 */
export function masterGaps(spec: SampleSpecification, live: LiveMasters): SampleSpecGap[] {
  const gaps: SampleSpecGap[] = []
  const ids = (list: Array<{ id: string }>) => new Set(list.map((x) => x.id))
  const items = ids(live.items)
  const ops = ids(live.operations)
  const depts = ids(live.departments)
  const contractors = ids(live.contractors)
  const units = ids(live.jobWorkers)
  spec.materials.forEach((l, i) => {
    const at = `Line ${i + 1}:`
    if (l.itemId && !items.has(l.itemId))
      gaps.push({
        section: 'materials',
        message: `${at} ${l.component.trim() || 'it'} uses a material that is no longer in use. Pick another.`,
      })
    if (l.departmentId && !depts.has(l.departmentId))
      gaps.push({
        section: 'materials',
        message: `${at} its department is no longer in use. Pick another, or leave it blank for the item’s own.`,
      })
  })
  spec.route.forEach((s, i) => {
    const at = `Step ${i + 1}:`
    const opLive = !!s.operationId && ops.has(s.operationId)
    if (s.operationId && !opLive)
      gaps.push({ section: 'route', message: `${at} that process is no longer in use. Pick another.` })
    if (s.departmentId && !depts.has(s.departmentId))
      gaps.push({
        section: 'route',
        message: opLive
          ? `${at} its process’s department is no longer in use. Pick another process.`
          : `${at} its department is no longer in use. Pick another.`,
      })
    if (s.contractorId && !contractors.has(s.contractorId))
      gaps.push({ section: 'route', message: `${at} that contractor is no longer in use. Pick another.` })
    if (s.vendorId && !units.has(s.vendorId))
      gaps.push({ section: 'route', message: `${at} that outside unit is no longer in use. Pick another.` })
  })
  return gaps
}
/**
 * Everything that stops the release: the shared gaps, which the server
 * refuses with; the route's cutting rules, which it refuses with too; and,
 * given the masters in use, anything picked that has been switched off since,
 * which it refuses every save with. The review says Ready only with none.
 */
export function releaseGaps(
  spec: SampleSpecification,
  ctx: SampleSpecContext,
  live?: LiveMasters
): SampleSpecGap[] {
  return [
    ...sampleSpecGaps(spec, ctx),
    ...routeRules(spec.route).problems.map((message) => ({ section: 'route' as const, message })),
    ...(live ? masterGaps(spec, live) : []),
  ]
}
/** The round in figures, for the review. */
export function specSummary(spec: SampleSpecification) {
  const colours = spec.colours.filter((r) => r.colour.trim())
  const cost = materialCost(spec)
  return {
    colours: colours.map((r) => r.colour),
    pieces: totalPieces(spec),
    sizeIds: sizesInUse(spec),
    lines: spec.materials.length,
    cost: cost.total,
    unrated: cost.unrated,
    steps: spec.route.map((s) => s.name || 'Unnamed step'),
  }
}

// ── Words ────────────────────────────────────────────────────────────────────

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
export const joinAnd = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
