/**
 * QC, the buyer's samples and the buyer's word, colour by colour (phase 6).
 *
 * QC measures each colour on the points of the sizes it finished and passes
 * pieces size by size; a colour passes when every point is within tolerance
 * and at least one piece passed. What passed goes to the buyer on Sample
 * Delivery Challans. The buyer decides on each colour sent; a colour may
 * instead be dropped by the merchandiser (not sent, or failed QC and not to
 * be made again). The round has a verdict once every colour that passed QC
 * has a word. A colour that failed QC, or that the buyer wants changed, goes
 * into the next round unless dropped.
 *
 * Rounds recorded before colours were inspected one by one (one inspection,
 * one submission and one decision for the whole set) are read in today's
 * shape by normaliseQc and normaliseDecision, so every reader sees one shape.
 * The server and the screens use these same functions.
 */
import { cellKey, gridCells, makingLedger, qtyCells, type MakingInput, type MakingQtyCell } from './sampleMaking'
import type { SampleMeasurement, SampleSpecification } from './sampling'

/** One key per colour, as the grid compares colours (case and spaces aside). */
export const colourKey = (colour: string) => colour.trim().toLowerCase()

/** The buyer's word on a colour they saw. */
export const SAMPLE_DECISION_RESULTS = ['APPROVED', 'CHANGES_REQUIRED', 'REJECTED'] as const
export type SampleDecisionResult = (typeof SAMPLE_DECISION_RESULTS)[number]
export const SAMPLE_DECISION_LABEL: Record<SampleDecisionResult, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUIRED: 'Changes required',
  REJECTED: 'Rejected',
}
/** What a colour ends as: the buyer's word, or dropped by us (DROP_COLOUR). */
export type SampleColourResult = SampleDecisionResult | 'DROPPED'
export const SAMPLE_COLOUR_RESULT_LABEL: Record<SampleColourResult, string> = {
  ...SAMPLE_DECISION_LABEL,
  DROPPED: 'Dropped',
}
/** The least the buyer's changes, or a reason to drop a colour, may say. */
export const SAMPLE_CHANGES_MIN = 5
/** How a Sample Delivery Challan goes. */
export const SAMPLE_DISPATCH_MODES = ['COURIER', 'HAND', 'TRANSPORT'] as const
export type SampleDispatchMode = (typeof SAMPLE_DISPATCH_MODES)[number]
export const SAMPLE_DISPATCH_MODE_LABEL: Record<SampleDispatchMode, string> = {
  COURIER: 'Courier',
  HAND: 'By hand',
  TRANSPORT: 'Transport',
}

/** A measurement read on a piece, against its target. */
export interface SampleQcResult extends SampleMeasurement {
  actual: number
  pass: boolean
  /** The colour it was read on; absent on an inspection of the whole set. */
  colour?: string
}
export interface SampleQcColour {
  colour: string
  passed: boolean
  results: SampleQcResult[]
  /** Each size the colour finished: how many finished, and how many passed workmanship. */
  cells: Array<{ sizeId: string; finished: number; passed: number }>
  notes: string
}
export interface SampleQc {
  /** At least one colour passed: the round goes to the buyer with what passed. */
  passed: boolean
  /** Pieces that passed, in the colours that passed. */
  passedQty: number
  notes: string
  by?: string
  at?: string | Date
  colours: SampleQcColour[]
  /** Every reading, colour by colour, for the printed record. */
  results: SampleQcResult[]
  /** Read from an inspection of the whole set, before colours were inspected one by one. */
  whole?: boolean
}

/** Within tolerance, as QC has always judged it. */
export const withinTolerance = (m: Pick<SampleMeasurement, 'target' | 'tolerance'>, actual: number) =>
  Math.abs(actual - m.target) <= m.tolerance + 1e-8

/** The points a colour is measured on: the specification's, for the sizes it finished. */
export const pointsFor = (spec: Pick<SampleSpecification, 'measurements'>, sizeIds: string[]) =>
  spec.measurements.filter((m) => sizeIds.includes(m.sizeId))

const num = (v: unknown) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const coloursOf = (spec: Pick<SampleSpecification, 'colours'>) => [
  ...new Map(gridCells(spec).map((c) => [colourKey(c.colour), c.colour])).values(),
]

/**
 * A round's QC in today's shape. One recorded before colours were inspected
 * one by one judged the whole set on one set of readings: every colour takes
 * that verdict, each size passing what finished there (`finished`, the last
 * making step's pieces; the plan when the round has no making record), and
 * one colour in one size the pieces passed.
 */
export function normaliseQc(
  raw: unknown,
  spec: Pick<SampleSpecification, 'colours'>,
  finished?: MakingQtyCell[]
): SampleQc | null {
  if (!raw || typeof raw !== 'object') return null
  const q = raw as Record<string, unknown>
  if (Array.isArray(q.colours)) return q as unknown as SampleQc
  const results = (Array.isArray(q.results) ? q.results : []) as SampleQcResult[]
  const passed = q.passed === true
  const grid = gridCells(spec)
  const single = grid.length === 1
  const made = (c: MakingQtyCell) =>
    finished ? (finished.find((f) => cellKey(f) === cellKey(c))?.qty ?? 0) : c.qty
  return {
    passed,
    passedQty: num(q.passedQty),
    notes: String(q.notes ?? ''),
    by: typeof q.by === 'string' ? q.by : undefined,
    at: (q.at as string | undefined) ?? undefined,
    results,
    whole: true,
    colours: coloursOf(spec).map((colour) => ({
      colour,
      passed,
      results,
      cells: grid
        .filter((c) => colourKey(c.colour) === colourKey(colour))
        .map((c) => ({
          sizeId: c.sizeId,
          finished: made(c),
          passed: passed ? Math.min(made(c), single ? num(q.passedQty) : made(c)) : 0,
        })),
      notes: '',
    })),
  }
}

/** A colour's outcome: the buyer's word on it, or dropped by us. */
export interface SampleColourDecision {
  colour: string
  result: SampleColourResult
  /** What the buyer wants changed or said; why it was dropped; none on an approval. */
  conditions: string
  /** Who at the buyer decided; none on a colour we dropped. */
  buyerName: string
  evidence: string
  at?: string | Date
  recordedBy?: string
}
export interface SampleDecision {
  /** By colour key. */
  colours: Record<string, SampleColourDecision>
  /** The round's verdict, once every colour has one; with the last decision's buyer and evidence. */
  result?: SampleDecisionResult
  buyerName?: string
  evidence?: string
  conditions?: string
  at?: string | Date
  recordedBy?: string
}
/** A round's decision in today's shape: one made on the whole set before is every colour's. */
export function normaliseDecision(
  raw: unknown,
  spec: Pick<SampleSpecification, 'colours'>
): SampleDecision | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (d.colours && typeof d.colours === 'object') return d as unknown as SampleDecision
  const result = d.result as SampleDecisionResult
  if (!SAMPLE_DECISION_RESULTS.includes(result)) return null
  const one = {
    result,
    conditions: String(d.conditions ?? ''),
    buyerName: String(d.buyerName ?? ''),
    evidence: String(d.evidence ?? ''),
    at: d.at as string | undefined,
    recordedBy: d.recordedBy as string | undefined,
  }
  return {
    ...one,
    colours: Object.fromEntries(coloursOf(spec).map((colour) => [colourKey(colour), { ...one, colour }])),
  }
}

/** Where one colour of a round stands. */
export type SampleColourStatus =
  | 'DRAFT'
  | 'MAKING'
  | 'NOT_FINISHED'
  | 'QC_FAILED'
  | 'TO_SEND'
  | 'SENT'
  | SampleColourResult
export const SAMPLE_COLOUR_STATUS_LABEL: Record<SampleColourStatus, string> = {
  DRAFT: 'Being specified',
  MAKING: 'Being made',
  NOT_FINISHED: 'Nothing finished',
  QC_FAILED: 'Failed QC',
  TO_SEND: 'Passed QC, to send',
  SENT: 'With the buyer',
  ...SAMPLE_COLOUR_RESULT_LABEL,
}
export interface SampleColourOutcome {
  colour: string
  key: string
  /** FAILED too for a colour that finished nothing (status NOT_FINISHED). */
  qc: 'PASSED' | 'FAILED' | null
  /** Pieces that passed QC, size by size (none when the colour failed). */
  passed: MakingQtyCell[]
  /** Sent to the buyer on the round's live challans, or on its submission before challans. */
  sent: MakingQtyCell[]
  /** Passed and not sent yet. */
  toSend: MakingQtyCell[]
  decision: SampleColourDecision | null
  status: SampleColourStatus
}
type When = string | Date | null | undefined
export interface SampleReviewRound {
  state: string
  specification: Pick<SampleSpecification, 'colours' | 'measurements'>
  qc: unknown
  submission?: unknown
  decision: unknown
  dispatches?: Array<{ cells: unknown; cancelledAt?: When }>
  /** The making record: with it, an inspection of the whole set counts what finished. */
  stages?: MakingInput['stages']
  works?: MakingInput['works']
  transfers?: MakingInput['transfers']
  jobWorks?: MakingInput['jobWorks']
}
const add = (cells: MakingQtyCell[], c: MakingQtyCell) => {
  const was = cells.find((x) => cellKey(x) === cellKey(c))
  if (was) was.qty += c.qty
  else cells.push({ ...c })
}
/** What the round's last making step finished, cell by cell; undefined without a making record. */
function finishedOf(round: SampleReviewRound): MakingQtyCell[] | undefined {
  if (!round.stages?.length) return undefined
  const last = makingLedger({
    specification: round.specification,
    stages: round.stages,
    works: round.works ?? [],
    transfers: round.transfers ?? [],
    jobWorks: round.jobWorks ?? [],
  }).at(-1)
  return last?.cells.map((c) => ({ colour: c.colour, sizeId: c.sizeId, qty: c.done }))
}

/** Each colour of the round, in the grid's order, and where it stands. */
export function colourOutcomes(round: SampleReviewRound): SampleColourOutcome[] {
  const qc = normaliseQc(round.qc, round.specification, finishedOf(round))
  const decision = normaliseDecision(round.decision, round.specification)
  const live = (round.dispatches ?? []).filter((d) => !d.cancelledAt)
  const sentAll: MakingQtyCell[] = []
  for (const d of live) for (const c of qtyCells(d.cells)) add(sentAll, c)
  // Sent whole before challans: whatever passed went with the submission.
  const submittedWhole = !!round.submission && !live.length
  return coloursOf(round.specification).map((colour) => {
    const key = colourKey(colour)
    const inspected = qc?.colours.find((c) => colourKey(c.colour) === key)
    // QC that left a colour out found nothing of it finished.
    const verdict = qc ? (inspected?.passed ? 'PASSED' : 'FAILED') : null
    const passed: MakingQtyCell[] =
      verdict === 'PASSED'
        ? inspected!.cells.filter((c) => c.passed > 0).map((c) => ({ colour, sizeId: c.sizeId, qty: c.passed }))
        : []
    const sent = submittedWhole
      ? passed.map((c) => ({ ...c }))
      : sentAll.filter((c) => colourKey(c.colour) === key).map((c) => ({ ...c, colour }))
    const toSend = passed
      .map((c) => ({ ...c, qty: c.qty - (sent.find((s) => cellKey(s) === cellKey(c))?.qty ?? 0) }))
      .filter((c) => c.qty > 0)
    const decided = decision?.colours[key] ?? null
    const status: SampleColourStatus = decided
      ? decided.result
      : verdict === 'FAILED'
        ? inspected
          ? 'QC_FAILED'
          : 'NOT_FINISHED'
        : sent.some((c) => c.qty > 0)
          ? 'SENT'
          : verdict === 'PASSED'
            ? 'TO_SEND'
            : round.state === 'DRAFT'
              ? 'DRAFT'
              : 'MAKING'
    return { colour, key, qc: verdict, passed, sent, toSend, decision: decided, status }
  })
}

const dropped = (o: SampleColourOutcome) => o.decision?.result === 'DROPPED'
/** A colour to make again: the buyer wants it changed, or it failed QC and was not dropped. */
const again = (o: SampleColourOutcome) =>
  o.decision?.result === 'CHANGES_REQUIRED' || (o.qc !== 'PASSED' && !o.decision)

/**
 * The round's verdict once every colour that passed QC has a word: changes
 * required while any colour is to be made again; else approved if any
 * colour is; else rejected. Dropped colours count for nothing. Null while a
 * colour still waits.
 */
export function roundVerdict(outcomes: SampleColourOutcome[]): SampleDecisionResult | null {
  if (outcomes.some((o) => o.qc === 'PASSED' && !o.decision)) return null
  if (outcomes.some(again)) return 'CHANGES_REQUIRED'
  if (outcomes.some((o) => o.decision?.result === 'APPROVED')) return 'APPROVED'
  return 'REJECTED'
}

/**
 * The colours the next round makes: those to make again; for the next
 * milestone after an approval, the approved ones; else every colour not dropped.
 */
export function coloursToCarry(outcomes: SampleColourOutcome[]): string[] {
  const remake = outcomes.filter(again)
  if (remake.length) return remake.map((o) => o.colour)
  const approved = outcomes.filter((o) => o.decision?.result === 'APPROVED')
  if (approved.length) return approved.map((o) => o.colour)
  const kept = outcomes.filter((o) => !dropped(o))
  return (kept.length ? kept : outcomes).map((o) => o.colour)
}

/**
 * Each colour the request has sampled, where its latest round left it, with
 * that round's revision. Rounds are given latest first, as the request lists them.
 */
export function requestColours(
  rounds: Array<SampleReviewRound & { revision: number }>
): Array<SampleColourOutcome & { revision: number }> {
  const seen = new Map<string, SampleColourOutcome & { revision: number }>()
  for (const r of rounds)
    for (const o of colourOutcomes(r)) if (!seen.has(o.key)) seen.set(o.key, { ...o, revision: r.revision })
  return [...seen.values()]
}

/**
 * Whether the request is ready to hand over: every colour it sampled has
 * ended, approved, rejected or dropped, and at least one is approved — in
 * whichever round. With the approved colours, which a handover BOM may be for.
 */
export function handoverReady(rounds: Array<SampleReviewRound & { revision: number }>) {
  const colours = requestColours(rounds)
  const ended = (s: SampleColourStatus) => s === 'APPROVED' || s === 'REJECTED' || s === 'DROPPED'
  const approved = colours.filter((c) => c.status === 'APPROVED').map((c) => c.colour)
  return {
    ready: colours.length > 0 && colours.every((c) => ended(c.status)) && approved.length > 0,
    approved,
  }
}
