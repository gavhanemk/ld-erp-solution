import {
  SAMPLE_ATTACHMENT_KINDS,
  SAMPLE_ATTACHMENT_KIND_LABEL,
  SAMPLE_MATERIAL_TYPES,
  cellCount,
  SAMPLE_CHARGE_LABEL,
  type SampleChargeKind,
  SAMPLE_DECISION_LABEL,
  SAMPLE_DISPATCH_MODE_LABEL,
  type SampleDecisionResult,
  type SampleDispatchMode,
  colourOutcomes,
  coloursToCarry,
  colourKey,
  handoverReady,
  makingLedger,
  makingStarted,
  piecesFor,
  type MakingStep,
  sampleOrdered,
  sampleReceived,
  sampleToBuy,
  type SampleLineCover,
  type SampleOrderLine,
  sizesInUse,
  totalPieces,
  type SampleAttachment,
  type SampleAttachmentKind,
  type SampleItemOption,
  type SampleMaterialType,
  type SampleRequestStyle,
  type SampleSpecContext,
  type SampleSpecification,
} from '@ld-erp/shared'
import type {
  Lookups,
  LookupStyle,
  SampleEvent,
  SampleMaterial,
  SampleRequest,
  SampleRound,
} from './types'
import { gapsByTab, joinAnd, plural, pointsOf, releaseGaps, SPEC_TABS } from './specRules'

export const SAMPLE_SECTIONS = [
  {
    key: 'Brief',
    title: 'Request & tech pack',
    description: 'Buyer brief, tech-pack files and the style to sample',
  },
  {
    key: 'Technical',
    title: 'Technical review & pattern',
    description: 'Style, sizes, measurements and plan',
  },
  {
    key: 'Sourcing',
    title: 'Sourcing',
    description: 'Buy what the sample needs, into the sample store',
  },
  {
    key: 'Materials',
    title: 'Material preparation',
    description: 'Issue, consumption and returns',
  },
  {
    key: 'Making',
    title: 'Sample making',
    description: 'Each step by colour and size, outside units and labour',
  },
  { key: 'Quality', title: 'QC & measurements', description: 'Workmanship and tolerance checks' },
  {
    key: 'Buyer review',
    title: 'Buyer submission & review',
    description: 'Feedback, approval or another round',
  },
  {
    key: 'Costing',
    title: 'Costing',
    description: 'Charges, the cost sheet and the buyer’s statement',
  },
  { key: 'Handover', title: 'Production handover', description: 'Approved package and acceptance' },
] as const
export type SampleSection = (typeof SAMPLE_SECTIONS)[number]['key'] | 'History'
const round3 = (v: number) => Math.round(v * 1000) / 1000
export const materialHeld = (m: SampleMaterial) =>
  round3(+m.issuedQty - +m.usedQty - +m.wasteQty - +m.returnedQty)
/**
 * The lines short of their plan while the first step is being made: not all
 * issued, or given back to the store since. The server holds the first step
 * back on exactly these (STEP_WORK, JOB_SEND).
 */
const shortLines = (round: Pick<SampleRound, 'materials'>) =>
  round.materials.filter(
    (m) =>
      // A waived line is not needed (WAIVE_MATERIAL).
      !m.waivedAt &&
      (+m.issuedQty < +m.plannedQty || round3(+m.issuedQty - +m.returnedQty) < +m.plannedQty)
  )
/** Why the round cannot be made yet: '' once it can. Only the first step waits on material. */
export function makingBlocker(round: Pick<SampleRound, 'state' | 'stages' | 'materials'>) {
  if (round.state === 'DRAFT') return 'Release the specification before making starts.'
  if (!round.stages[0]?.completedAt && shortLines(round).length)
    return 'Issue all planned materials, or waive what is not needed, before the first step is made. Material given back cannot be counted.'
  return ''
}

/**
 * Several colours or sizes in one round make it a set: made, inspected, sent
 * and decided colour by colour and size by size.
 */
export const isSampleSet = (spec: Pick<SampleSpecification, 'colours'>) => cellCount(spec) > 1

// ── Making, cell by cell (phase 5) ────────────────────────────────────────────

type MakingRoundView = Pick<SampleRound, 'specification' | 'stages'> &
  Partial<Pick<SampleRound, 'works' | 'transfers' | 'jobWorks'>>
/** Where every colour and size of every step stands, summed as the server sums it. */
export const makingOf = (round: MakingRoundView) =>
  makingLedger({
    specification: round.specification,
    stages: round.stages,
    works: round.works ?? [],
    transfers: round.transfers ?? [],
    jobWorks: round.jobWorks ?? [],
  })
const pieces = (n: number) => plural(n, 'piece')
/** The units a step's pieces are with now, by their challans. */
function unitsHolding(round: MakingRoundView, stageId: string) {
  const names = (round.jobWorks ?? [])
    .filter((j) => j.stageId === stageId && !j.cancelledAt)
    .map((j) => j.vendor?.name ?? 'the outside unit')
  return joinAnd([...new Set(names)]) || 'the outside unit'
}
export type MakingTodoKind = 'RECEIVE' | 'WORK' | 'SEND' | 'JOB_SEND' | 'JOB_WAIT'
/**
 * What there is to do at one step now, most pressing first: pieces to count
 * in, to work on, to hand on or send out, or with the unit. Empty when the
 * step has nothing waiting on it.
 */
export function stepTodos(
  round: MakingRoundView,
  steps: MakingStep[],
  i: number
): Array<{ kind: MakingTodoKind; text: string }> {
  const step = steps[i]
  const before = round.stages[i - 1]
  const next = round.stages[i + 1]
  const t = step.total
  const out: Array<{ kind: MakingTodoKind; text: string }> = []
  if (step.wholeStep) return out
  if (step.outside) {
    if (t.toSend > 0)
      out.push({
        kind: 'JOB_SEND',
        text: before
          ? `${pieces(t.toSend)} done at ${before.name} to send out to the unit.`
          : `${pieces(t.toSend)} to send out to the unit.`,
      })
    if (t.atUnit > 0)
      out.push({
        kind: 'JOB_WAIT',
        text: `${pieces(t.atUnit)} with ${unitsHolding(round, step.stageId)}: receive them when they come back.`,
      })
  } else {
    if (t.coming > 0)
      out.push({
        kind: 'RECEIVE',
        text: `${pieces(t.coming)} sent from ${before?.name ?? 'the step before'} to count in.`,
      })
    if (t.here > 0) out.push({ kind: 'WORK', text: `${pieces(t.here)} here to work on.` })
  }
  if (t.ready > 0 && next)
    out.push(
      next.execution === 'OUTSOURCED'
        ? { kind: 'JOB_SEND', text: `${pieces(t.ready)} done here to send out for ${next.name}.` }
        : { kind: 'SEND', text: `${pieces(t.ready)} done here to hand on to ${next.name}.` }
    )
  return out
}
/**
 * A step's state in a word or two, for its badge. Done when every piece that
 * reached it is worked; while some of those still wait to go on, it says so.
 */
export function stepStatus(step: MakingStep, hasNext = false) {
  if (step.wholeStep) return step.complete ? 'Recorded whole' : 'Not started'
  if (step.complete) return hasNext && step.total.ready > 0 ? 'Done, to hand on' : 'Done'
  return step.started ? 'In progress' : 'Not started'
}
/** The next thing to do on the route: the first step with something waiting on it. */
export function makingNext(round: MakingRoundView, steps = makingOf(round)) {
  for (let i = 0; i < steps.length; i++) {
    // Pieces with a unit wait; anything else on the route comes first.
    const doable = stepTodos(round, steps, i).filter((x) => x.kind !== 'JOB_WAIT')
    if (!doable.length) continue
    const name = round.stages[i].name
    const next = round.stages[i + 1]
    const kind = doable[0].kind
    return {
      title:
        kind === 'RECEIVE'
          ? `Count in pieces at ${name}`
          : kind === 'WORK'
            ? `Record work at ${name}`
            : kind === 'SEND'
              ? `Hand pieces on to ${next?.name ?? 'the next step'}`
              : `Send pieces out for ${steps[i].outside ? name : (next?.name ?? 'the next step')}`,
      description: `${name}: ${doable.map((x) => x.text).join(' ')}`,
    }
  }
  const waiting = steps.findIndex((_, i) =>
    stepTodos(round, steps, i).some((x) => x.kind === 'JOB_WAIT')
  )
  if (waiting >= 0)
    return {
      title: `Waiting for ${unitsHolding(round, steps[waiting].stageId)}`,
      description: `${round.stages[waiting].name}: ${stepTodos(round, steps, waiting)
        .map((x) => x.text)
        .join(' ')}`,
    }
  return null
}

/**
 * What the release check would say of the saved draft, with the request's
 * style and buyer as they are now: the same list the editor's review shows
 * (shared gaps and the cutting rules), from the specification last saved.
 */
export function specContext(
  request: Pick<SampleRequest, 'style' | 'customerId'>,
  sizes: Lookups['sizes']
): SampleSpecContext {
  const style = request.style
  return {
    // The register sends a style without its colours; nothing is checked against that.
    style:
      style && Array.isArray(style.colors)
        ? {
            colors: style.colors,
            sizeIds: style.sizeGroupId
              ? sizes.filter((z) => z.sizeGroupId === style.sizeGroupId).map((z) => z.id)
              : [],
          }
        : null,
    sizes,
    hasBuyer: !!request.customerId,
  }
}
export const draftGaps = (
  request: Pick<SampleRequest, 'style' | 'customerId'>,
  round: Pick<SampleRound, 'specification'>,
  sizes: Lookups['sizes']
) => releaseGaps(round.specification, specContext(request, sizes))

export function sampleFlow(
  request: SampleRequest,
  round = request.rounds[0],
  /** The size list: with it, a draft says what its saved specification still lacks. */
  sizes?: Lookups['sizes']
) {
  let section: SampleSection = 'Technical',
    title = 'Prepare the sample specification'
  let description = 'Work through the four setup sections, then review and release this round.'
  let targetRoundId = round.id
  // The specification follows the request's style, so a draft without one
  // starts where the tech pack is read and the style is made or chosen.
  if (round.state === 'DRAFT' && !request.styleId && everReleased(request)) {
    // Released before requests named their style: only that one style is open.
    section = 'Brief'
    title = 'Confirm the style for this request'
    description =
      'Earlier rounds were made in a style this request does not name yet. Use that style for the request in Request & tech pack, then prepare this round’s specification.'
  } else if (round.state === 'DRAFT' && !request.styleId) {
    section = 'Brief'
    title = 'Add the tech pack and set the style'
    description =
      'Attach the buyer’s tech pack, then create a development style for this request or use an existing one. The specification is prepared on that style.'
  } else if (round.state === 'DRAFT' && sizes) {
    // The tabs of the editor that still have something to finish, as its review lists them.
    const byTab = gapsByTab(draftGaps(request, round, sizes))
    const open = SPEC_TABS.filter((t) => byTab[t.key].length)
    if (!open.length) {
      title = `Release round ${round.revision} for sampling`
      description =
        'The saved specification has everything a release needs. Review it, then release it: that freezes it and starts material issue and making. Releasing needs sampling approval.'
    } else
      description = `The saved draft still has items to finish under ${joinAnd(open.map((t) => `${t.title} (${byTab[t.key].length})`))}. Save as you go, and release once nothing is left.`
  } else if (round.state === 'RELEASED') {
    // Where the round's records have it, as QC reads it (a step recorded whole
    // that rejected everything leaves the steps after it nothing to record).
    const made = makingOf(round)
    const index = made.findIndex((s) => !s.complete)
    const set = isSampleSet(round.specification)
    if (index >= 0) {
      const blocker = makingBlocker(round)
      const short = shortLines(round)
      const next = blocker ? null : makingNext(round)
      // Before anything can be issued, what is bought has to be ordered and arrive.
      const buying = blocker ? buyingOpen(round, request) : []
      section = buying.length ? 'Sourcing' : blocker ? 'Materials' : 'Making'
      title = buying.length
        ? buying.some((m) => lineSourcing(m, coverOf(request, round, m)).status === 'TO_ORDER')
          ? 'Buy the sample’s material'
          : 'Receive the sample’s material'
        : blocker
          ? 'Prepare material for making'
          : (next?.title ?? `Record ${round.stages[index].name.toLowerCase()}`)
      description = buying.length
        ? sourcingText(buying, request, round)
        : blocker
        ? [
            blocker,
            short.every((m) => +m.issuedQty < +m.plannedQty)
              ? `${short.length} of ${plural(round.materials.length, 'material line')} ${short.length === 1 ? 'is' : 'are'} not fully issued yet.`
              : `${short.length} of ${plural(round.materials.length, 'material line')} ${short.length === 1 ? 'is' : 'are'} short of the plan: issue again what was given back.`,
            // Each line's store is named at its first issue (STORE_REQUIRED).
            short.some((m) => !m.warehouseId) ? 'Pick the store at each line’s first issue.' : '',
          ]
            .filter(Boolean)
            .join(' ')
        : (next?.description ??
          'Record the work at each step colour by colour and size by size, and hand what is done on to the next step.')
    } else if (made.length && made.at(-1)!.total.done === 0 && !round.qc) {
      section = 'Quality'
      title = 'Nothing finished to inspect'
      description =
        'Every piece was rejected in making. Record the inspection as failed, then start a new round to make it again, or cancel the request.'
    } else {
      section = 'Quality'
      // A failed inspection from before failing had a state of its own.
      title = round.qc?.passed === false ? 'Resolve the QC findings' : 'Inspect the finished sample'
      description =
        round.qc?.passed === false
          ? 'Record a corrected inspection or start a new round. The failed inspection stays in the history.'
          : set
            ? 'Measure each colour on the points of the sizes it finished, and pass its pieces size by size. A colour out of tolerance fails on its own; the rest go to the buyer.'
            : 'Enter actual measurements and confirm workmanship before sending the sample to the buyer.'
    }
  } else if (round.state === 'QC_FAILED') {
    section = 'Quality'
    title = 'Resolve the QC findings'
    description =
      'No colour passed QC. Put the pieces right and record a corrected inspection, or start a new round to make them again. The failed inspection stays in the history.'
  } else if (
    round.state === 'REJECTED' &&
    handoverReady(request.rounds).ready &&
    !round.handover &&
    !request.costFinalisedAt
  ) {
    // Material accounted for, leftovers closed out, then the costs.
    const unreconciled = request.rounds.find((r) => r.materials.some((m) => materialHeld(m) > 0))
    if (unreconciled) {
      section = 'Materials'
      targetRoundId = unreconciled.id
      title = `Reconcile material on round ${unreconciled.revision}`
      description = 'Record used, wasted and returned quantities before the costs are finalised.'
    } else if (leftovers(request).length) {
      section = 'Materials'
      title = 'Close out what is left in the sample store'
      description = leftoverText(request)
    } else {
      section = 'Costing'
      title = 'Finalise what the sample cost'
      description = COSTING_TEXT
    }
  } else if (round.state === 'REJECTED' && handoverReady(request.rounds).ready) {
    // Rejected here, approved in an earlier round: that colour goes on to handover.
    section = 'Handover'
    ;({ title, description } = handoverWords(request, round))
    const approved = handoverReady(request.rounds).approved
    if (!round.handover)
      description = `${joinAnd(approved)} ${approved.length === 1 ? 'is' : 'are'} approved in an earlier round and every other colour has ended. ${HANDOVER_FLOW_TEXT}`
    if (round.handover?.acceptedAt && leftovers(request).length) {
      section = 'Materials'
      title = 'Close out what is left in the sample store'
      description = leftoverText(request)
    }
  } else if (round.state === 'QC_PASSED' || round.state === 'SUBMITTED') {
    const outcomes = colourOutcomes(round)
    const toSend = outcomes.filter((o) => !o.decision && o.toSend.length)
    const waiting = outcomes.filter((o) => o.qc === 'PASSED' && !o.decision)
    // Failed QC or finished nothing, and not dropped: made again.
    const failed = outcomes.filter((o) => o.qc === 'FAILED' && !o.decision)
    section = 'Buyer review'
    title =
      round.state === 'QC_PASSED'
        ? 'Send the samples to the buyer'
        : waiting.some((o) => o.sent.length)
          ? 'Record the buyer’s decision'
          : 'Send the rest to the buyer'
    description = [
      toSend.length
        ? `${joinAnd(toSend.map((o) => `${plural(o.toSend.reduce((t, c) => t + c.qty, 0), 'piece')} of ${o.colour}`))} passed QC and ${toSend.length === 1 && toSend[0].toSend.reduce((t, c) => t + c.qty, 0) === 1 ? 'is' : 'are'} still to send, on a Sample Delivery Challan.`
        : '',
      round.state === 'SUBMITTED' && waiting.length
        ? `The buyer’s word is awaited on ${joinAnd(waiting.map((o) => o.colour))}; record it colour by colour as it comes.`
        : '',
      failed.length
        ? `${joinAnd(failed.map((o) => o.colour))} ${failed.every((o) => o.status === 'NOT_FINISHED') ? 'finished nothing' : 'failed QC'} and ${failed.length === 1 ? 'is' : 'are'} made again in the next round, unless dropped.`
        : '',
    ]
      .filter(Boolean)
      .join(' ')
  } else if (['CHANGES_REQUIRED', 'REJECTED'].includes(round.state)) {
    const carry = coloursToCarry(colourOutcomes(round))
    section = 'Buyer review'
    title = 'Review feedback and start a new round'
    description = `Keep this round as the record of the buyer’s decision. A new round makes ${joinAnd(carry)} again, from this round’s specification.`
  } else if (round.state === 'APPROVED') {
    const unreconciled = request.rounds.find((r) => r.materials.some((m) => materialHeld(m) > 0))
    section = 'Handover'
    ;({ title, description } = handoverWords(request, round))
    if (!round.handover && unreconciled) {
      section = 'Materials'
      targetRoundId = unreconciled.id
      title = `Reconcile material on round ${unreconciled.revision}`
      description = 'Record used, wasted and returned quantities before preparing the handover.'
    } else if (!round.handover && !request.costFinalisedAt && leftovers(request).length) {
      // Closed out before the costs are final: a leftover used in the sample is a cost.
      section = 'Materials'
      title = 'Close out what is left in the sample store'
      description = leftoverText(request)
    } else if (!round.handover && !request.costFinalisedAt) {
      section = 'Costing'
      title = 'Finalise what the sample cost'
      description = COSTING_TEXT
    } else if (round.handover?.acceptedAt && leftovers(request).length) {
      // Handed over and accepted: what is left is the one thing still open.
      section = 'Materials'
      title = 'Close out what is left in the sample store'
      description = leftoverText(request)
    } else if (leftovers(request).length) {
      description = [description, leftoverText(request)].filter(Boolean).join(' ')
    }
  }
  if (request.cancelledAt) {
    section = 'History'
    title = 'Request cancelled'
    const reason = (request.cancelReason || 'This request is closed').trim()
    description = [/[.!?]$/.test(reason) ? reason : `${reason}.`, leftoverText(request)]
      .filter(Boolean)
      .join(' ')
  }
  const completed: Record<string, boolean> = {
    Brief: !!request.styleId || round.state !== 'DRAFT',
    Technical: round.state !== 'DRAFT',
    Sourcing: round.state !== 'DRAFT' && buyingOpen(round, request).length === 0,
    Materials:
      round.materials.length > 0 &&
      round.materials.every((m) => !!m.waivedAt || +m.issuedQty >= +m.plannedQty),
    Making: round.stages.length > 0 && makingOf(round).every((s) => s.complete),
    Quality: !!round.qc?.passed,
    'Buyer review': round.state === 'APPROVED' || handoverReady(request.rounds).ready,
    Costing: !!request.costFinalisedAt,
    Handover: !!round.handover?.acceptedAt,
  }
  return {
    section,
    title,
    description,
    targetRoundId,
    steps: SAMPLE_SECTIONS.map((s) => ({
      ...s,
      status: request.cancelledAt
        ? completed[s.key]
          ? 'Complete'
          : 'Closed'
        : s.key === section && !round.handover?.acceptedAt
          ? round.state === 'SUBMITTED' &&
            !colourOutcomes(round).some((o) => !o.decision && o.toSend.length > 0)
            ? 'Waiting'
            : 'Current'
          : completed[s.key]
            ? 'Complete'
            : 'Upcoming',
    })),
  }
}

/** Whether any round has left draft: from then on the buyer, brand and style are history. */
export const everReleased = (request: Pick<SampleRequest, 'rounds'>) =>
  request.rounds.some((r) => r.state !== 'DRAFT')

export const STYLE_FIXED_TEXT =
  'The style is fixed once a round has been released, as the buyer and brand are. Raise a new request to sample another style.'

/**
 * The handed-over colours production cannot take yet: no BOM of the style
 * for them is approved in Masters. A colour the request has no word on yet
 * counts as waiting. Each says what to do: approve its draft, or, once that
 * draft is retired or removed, approve another BOM for the colour.
 */
export function handoverWaiting(
  request: Pick<SampleRequest, 'handoverBoms'>,
  round: Pick<SampleRound, 'handover'>
) {
  const boms = round.handover?.boms
  if (!boms || round.handover?.acceptedAt) return []
  return boms
    .map((b) => ({ b, now: (request.handoverBoms ?? []).find((s) => colourKey(s.colour) === colourKey(b.colour)) }))
    .filter(({ now }) => !now?.approved)
    .map(({ b, now }) => ({
      colour: b.colour,
      version: b.version,
      gone: now?.status === 'DELETED' || now?.status === 'OBSOLETE',
    }))
}
/** "White (v1.0)", or the colour alone once its draft is gone. */
export const waitingName = (w: { colour: string; version: string; gone: boolean }) =>
  w.gone ? w.colour : `${w.colour} (v${w.version})`

/** Where a prepared or accepted handover stands, as the flow says it. */
function handoverWords(request: SampleRequest, round: SampleRound) {
  const waiting = handoverWaiting(request, round)
  const h = round.handover
  return {
    title: h?.acceptedAt
      ? 'Handover accepted'
      : h && waiting.length
        ? 'Waiting for Masters to approve the BOMs'
        : h
          ? 'Awaiting production acceptance'
          : 'Prepare the approved production package',
    description: h?.acceptedAt
      ? 'The approved sample record is ready for production planning.'
      : h && waiting.length
        ? `Approve a BOM for ${joinAnd(waiting.map(waitingName))} in Masters → BOMs; production accepts the handover after that.`
        : h
          ? 'Production accepts the handover into planning.'
          : HANDOVER_FLOW_TEXT,
  }
}

/** What preparing the handover does, as the flow says it. */
export const HANDOVER_FLOW_TEXT =
  'For each colour the buyer approved, make a draft BOM from the sample or pick one Masters has approved, and give the style its routing; a style made in sampling becomes a production style. Production accepts once Masters has approved the BOMs.'

/**
 * What the request's style card may offer, by the rules CREATE_STYLE,
 * LINK_STYLE and UPDATE_STYLE apply. Each reason is '' while the action is
 * open. The size run and sampled colours are judged from this request's own
 * rounds; the server also counts other requests' rounds of the same style and
 * says so if one of them holds it.
 */
export function styleRules(request: Pick<SampleRequest, 'rounds' | 'style' | 'cancelledAt'>) {
  const closed = request.cancelledAt
    ? 'This request is cancelled.'
    : request.rounds.some((r) => r.handover)
      ? 'This request has a production handover. Its details are now frozen.'
      : ''
  const style = request.style
  const sampled = style
    ? request.rounds.filter((r) => r.state !== 'DRAFT' && r.specification.styleId === style.id)
    : []
  // Every colour row of a released round, as UPDATE_STYLE counts them (pieces or not).
  const sampledColours: string[] = []
  for (const r of sampled)
    for (const row of r.specification.colours) {
      const colour = row.colour.trim()
      if (colour && !sampledColours.some((c) => c.toLowerCase() === colour.toLowerCase()))
        sampledColours.push(colour)
    }
  // Released before requests named their style: the style the first released
  // round was made in is the one LINK_STYLE still accepts.
  const firstReleased = style
    ? undefined
    : request.rounds
        .filter((r) => r.state !== 'DRAFT')
        .sort((a, b) => a.revision - b.revision)[0]
  return {
    /** Why nothing about this request can change: cancelled or handed over. */
    closed,
    /** Why a style can no longer be made, linked or taken off. */
    fixed: closed || (everReleased(request) ? STYLE_FIXED_TEXT : ''),
    /** With no style of its own after a release, the style its rounds were made in. */
    releasedStyleId: firstReleased?.specification.styleId ?? '',
    /** Why the style's own details cannot be changed from here. */
    editBlocked:
      closed ||
      (!style
        ? 'Make or link the request’s style first.'
        : style.stage !== 'DEVELOPMENT'
          ? `${style.code} is a production style. Change it in Masters → Styles.`
          : ''),
    sizeRunFixed:
      style && sampled.length
        ? `${style.code} has been sampled in its current size run, so the run stays. Make another style for a new run.`
        : '',
    /** Colours a released round was made in: they stay on the style. */
    sampledColours,
  }
}

/**
 * The lookups with the request's own style in them, as it is now.
 *
 * Lookups are read once when Sampling opens, so a style made or changed from
 * this request since then (a new colour, a new size run) would be missing or
 * stale in them, and the specification draws its colours and sizes from there.
 */
export function withRequestStyle(lookups: Lookups, style: SampleRequestStyle | null | undefined) {
  if (!style) return lookups
  const row: LookupStyle = {
    id: style.id,
    code: style.code,
    name: style.name,
    brandId: style.brandId,
    colors: style.colors,
    sizeGroupId: style.sizeGroupId,
    stage: style.stage,
    category: style.category,
    season: style.season,
  }
  const at = lookups.styles.findIndex((s) => s.id === style.id)
  if (at >= 0 && lookups.styles[at].sampleRequests)
    row.sampleRequests = lookups.styles[at].sampleRequests
  return {
    ...lookups,
    styles: at < 0 ? [...lookups.styles, row] : lookups.styles.map((s, i) => (i === at ? row : s)),
  }
}

export const MAX_STYLE_COLOURS = 30
/**
 * Colours typed into the chip box, added to the list: several at once when
 * separated by commas, each once however it is capitalised, as the Styles
 * master and the server have it.
 */
export function addColours(current: string[], typed: string) {
  const colours = [...current]
  for (const name of typed.split(',').map((s) => s.trim())) {
    if (!name) continue
    if (name.length > 50)
      return { colours: current, problem: 'Keep each colour name to 50 characters.' }
    if (colours.some((c) => c.toLowerCase() === name.toLowerCase()))
      return { colours: current, problem: `${name} is already listed.` }
    if (colours.length >= MAX_STYLE_COLOURS)
      return { colours: current, problem: `A style can have up to ${MAX_STYLE_COLOURS} colours.` }
    colours.push(name)
  }
  return { colours, problem: '' }
}

/** Each value once, however it is capitalised, A to Z: what a typed-in field suggests. */
export function distinctValues(values: Array<string | null | undefined>) {
  const seen = new Map<string, string>()
  for (const value of values) {
    const text = value?.trim()
    if (text && !seen.has(text.toLowerCase())) seen.set(text.toLowerCase(), text)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/** How many files of each kind a request has, every kind listed. */
export function fileCounts(files: Array<Pick<SampleAttachment, 'kind'>>) {
  const counts = Object.fromEntries(SAMPLE_ATTACHMENT_KINDS.map((k) => [k, 0])) as Record<
    SampleAttachmentKind,
    number
  >
  for (const f of files) if (f.kind in counts) counts[f.kind]++
  return counts
}

/** What a file is filed against: the whole request, or one round. */
export function fileScope(
  file: Pick<SampleAttachment, 'roundId'>,
  rounds: Array<Pick<SampleRound, 'id' | 'revision'>>
) {
  const round = file.roundId ? rounds.find((r) => r.id === file.roundId) : undefined
  return round ? `Round ${round.revision}` : 'Whole request'
}

/** Files of one kind against the whole request, and against each round. */
export const MAX_FILES_EACH = 5
/** Whether a file counts against the five of this kind filed where `roundId` says ('' the whole request). */
export const filedHere =
  (kind: SampleAttachmentKind, roundId: string) => (file: Pick<SampleAttachment, 'kind' | 'roundId'>) =>
    file.kind === kind && (file.roundId ?? '') === roundId

/**
 * What to say when no more files of this kind fit where they are being filed,
 * or '' while they do. In the server's words, and "remove one" only when one
 * can be removed.
 */
export function filesFullText(
  files: Array<Pick<SampleAttachment, 'kind' | 'roundId' | 'removable'>>,
  kind: SampleAttachmentKind,
  roundId: string,
  rounds: Array<Pick<SampleRound, 'id' | 'revision'>>
) {
  const here = files.filter(filedHere(kind, roundId))
  if (here.length < MAX_FILES_EACH) return ''
  const where = roundId ? fileScope({ roundId }, rounds) : 'The whole request'
  const what = `${MAX_FILES_EACH} ${SAMPLE_ATTACHMENT_KIND_LABEL[kind].toLowerCase()} files`
  const elsewhere = roundId ? 'the whole request or a later round' : 'the round it is for'
  return here.every((f) => f.removable === false)
    ? `${where} already has ${what}, kept as the record of what was made. File the new one against ${elsewhere}.`
    : `${where} already has ${what}. Remove one before adding another, or file the new one against ${elsewhere}.`
}

/**
 * What the draft round would lose if the request moved to this style (null:
 * no style), as the server's refit clears it (refitDrafts): each colour the
 * style lacks, with its pieces and the material lines for that colour only;
 * the sizes outside the style's size run in the colours that stay, and the
 * measurements taken on those sizes. Lines for every colour stay, their
 * quantities worked out again. The screen asks first. '' when nothing would
 * be lost.
 */
export function draftLoss(
  request: Pick<SampleRequest, 'rounds'>,
  style: { colors: string[]; sizeGroupId: string | null } | null,
  sizes: Array<{ id: string; sizeGroupId: string; code?: string }>
) {
  const draft = request.rounds.find((r) => r.state === 'DRAFT')
  if (!draft) return ''
  const s = draft.specification
  const run = new Set(
    style?.sizeGroupId
      ? sizes.filter((z) => z.sizeGroupId === style.sizeGroupId).map((z) => z.id)
      : []
  )
  const fits = (sizeId: string) => !sizeId || run.has(sizeId)
  const own = (colour: string) =>
    !!style?.colors.some((c) => c.toLowerCase() === colour.toLowerCase())
  // A row whose colour is not picked yet stays, as the server keeps it.
  const lostRows = s.colours.filter((r) => r.colour.trim() && !own(r.colour.trim()))
  const keptRows = s.colours.filter((r) => !lostRows.includes(r))
  const lostColours = lostRows.map((r) => r.colour.trim())
  const lostPieces = piecesFor({ colours: lostRows }, null)
  // A lost colour's sizes go with it; these are the ones the colours that stay lose.
  const lostSizeIds = [
    ...new Set(keptRows.flatMap((r) => r.sizes.map((z) => z.sizeId)).filter((id) => !fits(id))),
  ]
  const lostTargets = s.measurements.filter((m) => !fits(m.sizeId)).length
  const kept = new Set(keptRows.map((r) => r.colour.trim().toLowerCase()).filter(Boolean))
  // The rows decide once the round has any, as the server reads them.
  const lines: Array<{ colour: string | null }> = draft.materials.length
    ? draft.materials
    : s.materials
  const lostLines = lines.filter(
    (l) => l.colour?.trim() && !kept.has(l.colour.trim().toLowerCase())
  ).length
  const code = (id: string) => sizes.find((z) => z.id === id)?.code
  const parts = [
    lostColours.length &&
      `${lostColours.length === 1 ? 'colour' : 'colours'} ${joinAnd(lostColours)}${lostPieces ? ` (${plural(lostPieces, 'piece')})` : ''}`,
    lostSizeIds.length &&
      (lostSizeIds.every(code)
        ? `${lostSizeIds.length === 1 ? 'size' : 'sizes'} ${joinAnd(lostSizeIds.map((id) => code(id)!))}`
        : plural(lostSizeIds.length, 'size')),
    lostTargets && plural(lostTargets, 'measurement'),
    lostLines &&
      `${plural(lostLines, 'material line')} for ${lostColours.length ? joinAnd(lostColours) : 'a colour no longer on the round'}`,
  ].filter((x): x is string => !!x)
  if (!parts.length) return ''
  // Semicolons between the parts: each part may name several colours or sizes itself.
  return `Round ${draft.revision}’s draft will lose ${parts.join('; ')}.`
}

/**
 * What a style change cleared from each draft, from its event (detail.refit,
 * the server's own count), in words; '' when nothing was. The server counts
 * a size once for each colour it was entered in.
 */
export function refitText(refit: unknown) {
  if (!Array.isArray(refit)) return ''
  return refit
    .flatMap((r) => {
      const n = (key: string) => Number((r as Record<string, unknown> | null)?.[key]) || 0
      const sizes = n('sizesDropped')
      const parts = [
        n('coloursDropped') && plural(n('coloursDropped'), 'colour'),
        sizes && `${sizes} ${sizes === 1 ? 'size quantity' : 'size quantities'}`,
        n('measurementsDropped') && plural(n('measurementsDropped'), 'measurement'),
        n('materialsDropped') && plural(n('materialsDropped'), 'material line'),
      ].filter((x): x is string => !!x)
      return parts.length ? [`Round ${n('revision')}’s draft lost ${joinAnd(parts)}.`] : []
    })
    .join(' ')
}

// ── A round's specification, read only: the workspace and the printed record ──

const inOrder = (ids: string[], order: string[]) => {
  const rank = (id: string) => {
    const at = order.indexOf(id)
    return at < 0 ? order.length : at
  }
  return [...ids].sort((a, b) => rank(a) - rank(b))
}
/** The round's colours and pieces in a line: "Navy, White · 12 pcs". */
export function colourSummary(spec: Pick<SampleSpecification, 'colours'>) {
  const colours = spec.colours.map((r) => r.colour.trim()).filter(Boolean)
  return colours.length
    ? `${colours.join(', ')} · ${plural(totalPieces(spec), 'pc')}`
    : 'No colours yet'
}
/**
 * The colour × size grid with its totals: the sizes the round makes, in the
 * size run's order (`sizeOrder`, the size list's own), a row per colour.
 */
export function colourGrid(spec: Pick<SampleSpecification, 'colours'>, sizeOrder: string[] = []) {
  const sizeIds = inOrder(sizesInUse(spec), sizeOrder)
  const rows = spec.colours
    .map((r) => {
      const qty: Record<string, number> = {}
      for (const z of r.sizes)
        if (z.sizeId) qty[z.sizeId] = (qty[z.sizeId] ?? 0) + (Number(z.qty) || 0)
      return { colour: r.colour.trim(), qty, total: piecesFor({ colours: [r] }, null) }
    })
    .filter((r) => r.colour || r.total > 0)
  const cols: Record<string, number> = {}
  for (const id of sizeIds) cols[id] = rows.reduce((t, r) => t + (r.qty[id] ?? 0), 0)
  return { sizeIds, rows, cols, total: totalPieces(spec) }
}
/**
 * The measurements as points × sizes, one target a size, as the editor
 * shows them (pointsOf). The columns are the sizes made and any size
 * measured, so a made size with no targets shows as an empty column.
 */
export function measureMatrix(
  spec: Pick<SampleSpecification, 'colours' | 'measurements'>,
  sizeOrder: string[] = []
) {
  const measured = spec.measurements.map((m) => m.sizeId).filter(Boolean)
  const sizeIds = inOrder([...new Set([...sizesInUse(spec), ...measured])], sizeOrder)
  const points = pointsOf(spec.measurements).map((p) => ({
    name: p.name,
    tolerance: Number(p.tolerance) || 0,
    unit: p.unit,
    targets: Object.fromEntries(Object.entries(p.targets).map(([id, v]) => [id, Number(v)])),
  }))
  return { sizeIds, points }
}
/**
 * The materials the round's own lines name that are still in use, as the
 * BOM's picker lists them: one added after the page read its list (by someone
 * else, or in another window) is then offered and named like any other.
 */
export function roundItems(round: Pick<SampleRound, 'materials'>): SampleItemOption[] {
  const out: SampleItemOption[] = []
  for (const m of round.materials) {
    const it = m.item
    if (!m.itemId || !it || it.isActive !== true || out.some((x) => x.id === m.itemId)) continue
    if (!SAMPLE_MATERIAL_TYPES.includes(it.type as SampleMaterialType)) continue
    out.push({
      id: m.itemId,
      code: it.code,
      name: it.name,
      // Its design and colour, so the picker tells same-name materials apart.
      ...shadeFields(it),
      type: it.type as SampleMaterialType,
      uom: it.uom
        ? {
            id: it.uom.id ?? '',
            code: it.uom.symbol,
            name: it.uom.name ?? it.uom.symbol,
            symbol: it.uom.symbol,
          }
        : null,
      departmentId: it.departmentId ?? null,
      standardRate:
        it.standardRate === null || it.standardRate === undefined ? null : Number(it.standardRate),
    })
  }
  return out
}
/**
 * A BOM line's material as the round shows it: its own row's item (which
 * names one switched off since), else the item list's, else why there is none.
 * With the item's design and colour for the screen to word (itemShade in
 * lib/items, not imported here: the sampling checks run this file in Node).
 */
export function lineItem(
  line: { id?: string; itemId: string },
  round: Pick<SampleRound, 'materials'>,
  items: Lookups['items']
): { name: string; code: string; uom: string; designNo?: string; color?: string; styleId?: string } {
  const row =
    (line.id && round.materials.find((m) => m.id === line.id)) ||
    (line.itemId ? round.materials.find((m) => m.itemId === line.itemId) : undefined)
  if (row?.item)
    return { name: row.item.name, code: row.item.code, uom: row.item.uom?.symbol ?? '', ...shadeFields(row.item) }
  const item = line.itemId ? items.find((i) => i.id === line.itemId) : undefined
  if (item) return { name: item.name, code: item.code, uom: item.uom?.symbol ?? '', ...shadeFields(item) }
  return {
    name: line.itemId ? 'Material no longer in use' : 'No material picked',
    code: '',
    uom: '',
  }
}
/** An item's Design No., Colour and style, only those it has (a material with none reads as before). */
function shadeFields(i: { designNo?: string | null; color?: string | null; styleId?: string | null }) {
  return {
    ...(i.designNo ? { designNo: i.designNo } : {}),
    ...(i.color ? { color: i.color } : {}),
    ...(i.styleId ? { styleId: i.styleId } : {}),
  }
}
/** A line's colour in words: null is a line every colour uses. */
export const lineColour = (colour: string | null | undefined) => colour?.trim() || 'All colours'

/** Where a step is done, in the routing master's words. */
export const DONE_AT_LABEL = { IN_HOUSE: 'Our floor', OUTSOURCED: 'Outside unit' } as const
/**
 * A route step in words: its process, department, where it is done and who
 * does it. A step released before routes named a process has only its name.
 */
export function stepFacts(
  step: {
    operationId: string | null
    departmentId: string | null
    execution: keyof typeof DONE_AT_LABEL
    contractorId: string | null
    vendorId: string | null
    instructions: string | null
  },
  lookups: Pick<Lookups, 'operations' | 'departments' | 'contractors' | 'jobWorkers'>
) {
  const op = step.operationId
    ? lookups.operations.find((o) => o.id === step.operationId)
    : undefined
  const outside = step.execution === 'OUTSOURCED'
  return {
    /** '' for a step with no process (released before routes named one). */
    process: step.operationId ? (op?.name ?? 'Process no longer in use') : '',
    department: step.departmentId
      ? (lookups.departments.find((d) => d.id === step.departmentId)?.name ??
        'Department no longer in use')
      : '',
    outside,
    doneAt: DONE_AT_LABEL[outside ? 'OUTSOURCED' : 'IN_HOUSE'],
    /** The outside unit of a step done outside; the contractor, if named, of one on our floor. */
    who: outside
      ? step.vendorId
        ? (lookups.jobWorkers.find((v) => v.id === step.vendorId)?.name ?? 'Unit no longer in use')
        : 'No unit named'
      : step.contractorId
        ? (lookups.contractors.find((c) => c.id === step.contractorId)?.name ??
          'Contractor no longer in use')
        : 'Any contractor',
    instructions: step.instructions?.trim() ?? '',
  }
}

// ── Material on a released round ──────────────────────────────────────────────

/** Said for a line with no material picked: the server's own words (NO_ITEM). */
export const NO_ITEM_TEXT = 'This line has no material picked, so nothing can be issued against it.'
export type MaterialKind = 'ISSUE' | 'USE' | 'WASTE' | 'RETURN'
export const MATERIAL_KIND_LABEL: Record<MaterialKind, string> = {
  ISSUE: 'Issue from store',
  USE: 'Record material used',
  WASTE: 'Record waste',
  RETURN: 'Return to store',
}
/**
 * What can be recorded against one line now, by the rules MATERIAL applies:
 * an issue up to the plan while the round is released and making has not
 * started; use, waste or a return of what the line still holds. `why` says
 * why nothing can, for the line's row; `needsStore` that this issue is the
 * line's first and names its store.
 */
export function materialActions(
  round: Pick<SampleRound, 'state' | 'stages' | 'handover'> &
    Partial<Pick<SampleRound, 'works' | 'jobWorks'>>,
  m: SampleMaterial
) {
  // Still to issue, net of what came back before making (the server issues
  // past the plan from the pool; making needs the plan net of returns).
  const remaining = round3(Math.max(0, +m.plannedQty - (+m.issuedQty - +m.returnedQty)))
  const held = materialHeld(m)
  const issueOpen = round.state === 'RELEASED' && !round.stages.some((s) => s.completedAt)
  // What is out of the store on this line now; with nothing out, the line
  // may be issued from another store, which it then keeps (MATERIAL).
  const out = round3(+m.issuedQty - +m.returnedQty)
  // A line tied to a general store before sample stores, with some of it out
  // (NOT_SAMPLE_STORE): it is returned there first.
  const generalStore = !!m.warehouseId && m.warehouse?.purpose === 'GENERAL' && out > 0
  const kinds: MaterialKind[] = []
  if (!round.handover) {
    if (m.itemId && issueOpen && remaining > 0 && !m.waivedAt && !generalStore) kinds.push('ISSUE')
    if (held > 0) kinds.push('USE', 'WASTE', 'RETURN')
  }
  const why = kinds.length
    ? ''
    : round.handover
      ? 'This round is handed over; its material record is frozen.'
      : m.waivedAt
        ? `Not needed: ${m.waivedReason ?? 'waived'}.`
        : generalStore && issueOpen && remaining > 0
          ? `Issued from ${m.warehouse?.name ?? 'a general store'} before sample stores kept sample material apart. Return what is out there; then it is issued from the sample store. Or mark the rest not needed.`
          : !m.itemId
        ? NO_ITEM_TEXT
        : round.state === 'DRAFT'
          ? 'Issued once the round is released.'
          : remaining > 0
            ? 'Issue materials before making starts; extra needs require a new round.'
            : 'Issued in full and accounted for.'
  // Waived only before making starts, and only while some of it is still to issue.
  // A line is waived only before anything is made (WAIVE_MATERIAL).
  const waiveOpen = round.state === 'RELEASED' && !makingStarted(round)
  const waive = waiveOpen && !round.handover && !m.waivedAt && remaining > 0
  const unwaive = waiveOpen && !round.handover && !!m.waivedAt
  return {
    kinds,
    remaining,
    held,
    why,
    needsStore: kinds.includes('ISSUE') && (!m.warehouseId || out <= 0),
    waive,
    unwaive,
  }
}
/**
 * The store a line is tied to once its first issue named it, and why, in the
 * words the server refuses another store with (OTHER_STORE); '' before.
 */
export function storeNote(m: SampleMaterial) {
  if (!m.warehouseId) return ''
  const store = m.warehouse?.name ?? 'its store'
  return +m.issuedQty > 0
    ? `This material was issued from ${store}. Issue the rest from there, and return it there.`
    : `This material is planned from ${store}. Issue it from there.`
}
// ── The request's own material (phase 4) ─────────────────────────────────────

/** What is left of the request's own material in the sample stores. */
export const leftovers = (request: Pick<SampleRequest, 'pool'>) =>
  (request.pool?.stores ?? []).filter((s) => s.available > 0)
/** The next-action words when something is left over; '' when nothing is. */
export function leftoverText(request: Pick<SampleRequest, 'pool'>) {
  const left = leftovers(request)
  if (!left.length) return ''
  return `${plural(left.length, 'material')} bought for this request ${left.length === 1 ? 'is' : 'are'} still in the sample store. Close ${left.length === 1 ? 'it' : 'them'} out under Material preparation: used in the sample, or moved to a general store.`
}
/**
 * Why leftovers cannot be closed out yet, in the words CLOSE_MATERIAL refuses
 * with; '' once the buyer has decided, the request is handed over or cancelled.
 */
export function closeOutBlocker(
  request: Pick<SampleRequest, 'cancelledAt' | 'rounds'>
) {
  const latest = request.rounds[0]
  const settled =
    !!request.cancelledAt ||
    ['APPROVED', 'REJECTED'].includes(latest?.state ?? '') ||
    request.rounds.some((r) => r.handover)
  return settled
    ? ''
    : 'Leftover material is closed out once the buyer has decided, or the request is cancelled. Until then it is kept for the next round.'
}
/**
 * How much a line may issue now, from a sample store: what the request bought
 * and still holds there for material we buy (POOL_SHORT refuses more), or the
 * buyer's own stock in the sample stores for what the buyer sends.
 */
export function issueCap(
  request: Pick<SampleRequest, 'pool'>,
  m: Pick<SampleMaterial, 'source' | 'itemId'> &
    Partial<Pick<SampleMaterial, 'plannedQty' | 'issuedQty' | 'returnedQty'>>,
  warehouseId: string
) {
  if (!m.itemId || !warehouseId) return 0
  if (m.source === 'BUYER_SUPPLIED') {
    const here =
      request.pool?.buyerStores?.find((s) => s.itemId === m.itemId && s.warehouseId === warehouseId)
        ?.available ?? 0
    // No more of the buyer's than the line still plans for (BUYER_PLAN).
    const left =
      m.plannedQty === undefined
        ? here
        : round3(Math.max(0, +m.plannedQty - (+(m.issuedQty ?? 0) - +(m.returnedQty ?? 0))))
    return round3(Math.min(here, left))
  }
  return (
    request.pool?.stores.find((s) => s.itemId === m.itemId && s.warehouseId === warehouseId)
      ?.available ?? 0
  )
}

// ── Sourcing (phase 3) ────────────────────────────────────────────────────────

/** Where one line of the sample BOM stands with its buying. */
export type SourcingStatus =
  | 'BUYER'
  | 'NO_ITEM'
  | 'WAIVED'
  | 'TO_ORDER'
  | 'ON_ORDER'
  | 'RECEIVED'
  | 'ISSUED'
export const SOURCING_STATUS_LABEL: Record<SourcingStatus, string> = {
  BUYER: 'Buyer sends it',
  NO_ITEM: 'No material picked',
  WAIVED: 'Not needed',
  TO_ORDER: 'To order',
  ON_ORDER: 'On order',
  RECEIVED: 'Ready to issue',
  ISSUED: 'Issued',
}
/**
 * How far buying has got for one line, summed off its orders as the server
 * sums them (sampleOrdered: a line closed short counts only what arrived).
 * A line already issued in full needs nothing more bought, however it was
 * stocked.
 */
export function lineSourcing(
  m: Pick<SampleMaterial, 'source' | 'itemId' | 'plannedQty' | 'issuedQty' | 'orders'> & {
    waivedAt?: string | null
  },
  /**
   * How the request's own pool covers the line (samplePool), for a line of the
   * round being made. Without it the line is read from its own orders alone.
   */
  cover?: SampleLineCover | null
) {
  const orders = m.orders ?? []
  const required = +m.plannedQty
  const ordered = sampleOrdered(orders)
  const received = sampleReceived(orders)
  const toBuy = cover ? cover.toBuy : sampleToBuy(required, orders, m.issuedQty)
  const status: SourcingStatus =
    m.source === 'BUYER_SUPPLIED'
      ? 'BUYER'
      : !m.itemId
        ? 'NO_ITEM'
        : m.waivedAt
          ? 'WAIVED'
          : cover
            ? cover.remaining <= 0
              ? 'ISSUED'
              : toBuy > 0
                ? 'TO_ORDER'
                : cover.awaited > 0
                  ? 'ON_ORDER'
                  : 'RECEIVED'
            : +m.issuedQty >= required
              ? 'ISSUED'
              : received >= required
                ? 'RECEIVED'
                : toBuy > 0
                  ? 'TO_ORDER'
                  : 'ON_ORDER'
  return { required, ordered, received, toBuy, status }
}
/** A line's cover from the request's pool, for a line of the latest round while it is being made. */
export const coverOf = (
  request: Pick<SampleRequest, 'pool' | 'rounds'>,
  round: Pick<SampleRound, 'id' | 'state'>,
  m: Pick<SampleMaterial, 'id'>
) =>
  round.state === 'RELEASED' && request.rounds[0]?.id === round.id
    ? (request.pool?.lines[m.id] ?? null)
    : null
/** The bought lines of a released round still to order or to arrive. */
export const buyingOpen = (
  round: Pick<SampleRound, 'id' | 'state' | 'materials'>,
  request?: Pick<SampleRequest, 'pool' | 'rounds'>
) =>
  round.state === 'RELEASED'
    ? round.materials.filter((m) =>
        ['TO_ORDER', 'ON_ORDER'].includes(
          lineSourcing(m, request ? coverOf(request, round, m) : null).status
        )
      )
    : []
/** The next-action words for the lines still being bought. */
export function sourcingText(
  lines: SampleMaterial[],
  request?: Pick<SampleRequest, 'pool' | 'rounds'>,
  round?: Pick<SampleRound, 'id' | 'state'>
) {
  const toOrder = lines.filter(
    (m) =>
      lineSourcing(m, request && round ? coverOf(request, round, m) : null).status === 'TO_ORDER'
  ).length
  const onOrder = lines.length - toOrder
  // An order saved as a draft has not reached the supplier.
  const drafts = new Set(
    lines.flatMap((m) => (m.orders ?? []).filter((o) => o.status === 'DRAFT').map((o) => o.poNumber))
  ).size
  return [
    toOrder ? `${plural(toOrder, 'material line')} still to order.` : '',
    onOrder ? `${plural(onOrder, 'line')} on order, not all received yet.` : '',
    drafts ? `${plural(drafts, 'order')} still ${drafts === 1 ? 'a draft' : 'drafts'}: send ${drafts === 1 ? 'it' : 'them'} to the supplier from Purchase.` : '',
    toOrder
      ? 'Raise a purchase order for what is still to buy; it is delivered to the sample store.'
      : 'Receive it into the sample store against its purchase order when it arrives.',
  ]
    .filter(Boolean)
    .join(' ')
}
/**
 * The orders a line is bought on, as the Sourcing table lists them:
 * "PO-… · Supplier · 5 of 6 received".
 */
export function orderSummary(o: SampleOrderLine, unit = '') {
  const qty = +o.qty
  const got = +o.receivedQty
  const u = unit ? ` ${unit}` : ''
  return `${o.poNumber} · ${o.supplierName} · ${
    o.cancelled
      ? `${got}${u} received, order cancelled`
      : o.shortClosed
      ? `${got}${u} received, rest not coming`
      : got > 0
        ? `${got} of ${qty}${u} received`
        : `${qty}${u} on order`
  }${o.status === 'DRAFT' ? ' · draft, not sent yet' : ''}`
}


/** History lines in words rather than action codes. */
/** What finalising the costs asks for, before handover. */
export const COSTING_TEXT =
  'Add any charges still to come (testing, pattern, couriers), check the cost sheet, then finalise it; finalising needs sampling approval. The buyer’s Sample charges statement prints from it.'

/**
 * Why the costs cannot be finalised yet, by the rules FINALISE_COST applies;
 * '' once they can. A cancelled request is costed as it stopped.
 */
export function finaliseBlocker(request: SampleRequest) {
  if (request.costFinalisedAt) return 'The costs are finalised.'
  if (request.rounds.some((r) => r.handover)) return 'This request is handed over; its costs are frozen.'
  const latest = request.rounds[0]
  if (!request.cancelledAt) {
    if (latest.state === 'DRAFT')
      return `Round ${latest.revision} is still being prepared: finalise the costs once it is made.`
    const unmade = request.rounds
      .filter((r) => r.state !== 'DRAFT')
      .find((r) => {
        const steps = makingOf(r)
        return !steps.length || steps.some((s) => !s.complete)
      })
    if (unmade) return `Round ${unmade.revision} is still being made: finalise the costs once every step is done.`
  }
  const held = request.rounds.find((r) => r.materials.some((m) => materialHeld(m) > 0))
  if (held)
    return `Round ${held.revision} still holds material: record what was used, wasted or returned in Material preparation first.`
  if (leftovers(request).length)
    return 'Close out what is left in the sample store first, in Material preparation: once the costs are final, a leftover can no longer be counted as used.'
  return ''
}

export const SAMPLE_EVENT_LABEL: Record<string, string> = {
  CREATE: 'Request created',
  UPDATE_REQUEST: 'Request details updated',
  SAVE_DRAFT: 'Draft saved',
  SAVE_SPEC: 'Specification saved',
  RELEASE: 'Released for sampling',
  MATERIAL: 'Material recorded',
  STAGE: 'Making step recorded',
  STEP_WORK: 'Work recorded',
  STEP_SEND: 'Pieces handed on',
  STEP_RECEIVE: 'Pieces counted in',
  JOB_SEND: 'Sent to an outside unit',
  JOB_RETURN: 'Back from an outside unit',
  STEP_LABOUR: 'Labour entered',
  JOB_CHARGE: 'Unit’s charge corrected',
  MAKING_UNDO: 'Making record taken back',
  QC: 'QC recorded',
  SUBMIT: 'Submitted to the buyer',
  DISPATCH: 'Sent to the buyer',
  DISPATCH_CANCEL: 'Delivery challan cancelled',
  DECIDE: 'Buyer decision recorded',
  DROP_COLOUR: 'Colour dropped',
  ADD_CHARGE: 'Charge added',
  REMOVE_CHARGE: 'Charge removed',
  DISPATCH_CHARGE: 'Courier charge corrected',
  FINALISE_COST: 'Costs finalised',
  REOPEN_COST: 'Costs reopened',
  NEW_ROUND: 'New round started',
  HANDOVER: 'Handover prepared',
  ACCEPT_HANDOVER: 'Handover accepted',
  CANCEL: 'Request cancelled',
  ATTACH: 'File attached',
  DETACH: 'File removed',
  CREATE_STYLE: 'Development style created',
  LINK_STYLE: 'Style for this sample changed',
  UPDATE_STYLE: 'Style details changed',
  WAIVE_MATERIAL: 'Line marked not needed',
  CLOSE_MATERIAL: 'Leftover material closed out',
}
/** What a making record taken back was (MAKING_UNDO). */
export const MAKING_UNDO_LABEL = {
  WORK: 'Work',
  TRANSFER: 'Hand-on',
  JOB_SEND: 'Challan',
  JOB_RETURN: 'Receipt from the unit',
} as const
export const eventLabel = (action: string, data?: unknown) =>
  action === 'WAIVE_MATERIAL' && (data as { undo?: boolean } | undefined)?.undo
    ? 'Line needed again'
    : (SAMPLE_EVENT_LABEL[action] ?? action.replaceAll('_', ' ').toLowerCase())

const STYLE_FIELDS = [
  ['name', 'Name'],
  ['category', 'Garment category'],
  ['season', 'Season'],
  ['sizeGroupId', 'Size run'],
  ['colors', 'Colours'],
] as const

/** What an UPDATE_STYLE changed, one phrase per detail. */
export function styleChanges(
  before: unknown,
  after: unknown,
  sizeRun: (id: string) => string = (id) => id
) {
  const read = (from: unknown, key: string) => {
    const value = from && typeof from === 'object' ? (from as Record<string, unknown>)[key] : null
    if (Array.isArray(value)) return value.join(', ')
    if (typeof value !== 'string' || !value) return ''
    return key === 'sizeGroupId' ? sizeRun(value) : value
  }
  return STYLE_FIELDS.flatMap(([key, label]) => {
    const was = read(before, key),
      now = read(after, key)
    return was === now ? [] : [`${label}: ${was || '—'} → ${now || '—'}`]
  })
}

/**
 * The detail line under a history entry for the file, style and new-round
 * actions; null for actions whose entry says enough on its own or is drawn
 * elsewhere.
 */
export function eventNote(
  e: SampleEvent,
  rounds: Array<Pick<SampleRound, 'id' | 'revision'>>,
  sizeRun?: (id: string) => string
): string | null {
  const d = e.detail.data ?? {}
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  const kind = (v: unknown) =>
    SAMPLE_ATTACHMENT_KIND_LABEL[v as SampleAttachmentKind] ?? (text(v) || 'File')
  const code = (v: unknown) =>
    v && typeof v === 'object' && 'code' in v ? String((v as { code: unknown }).code) : 'No style'
  const count = (v: unknown) => (typeof v === 'number' ? v : 0)
  // Amounts are sent only to those who may see them; left out, nothing is said.
  const rupees = (v: unknown) =>
    typeof v === 'number'
      ? `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : ''
  const join = (parts: string[]) => parts.filter(Boolean).join(' · ')
  switch (e.action) {
    case 'QC':
      // Colour by colour since phase 6; before, one verdict for the set.
      return Array.isArray(d.colours)
        ? join([
            ...(d.colours as Array<{ colour?: unknown; passed?: unknown; pieces?: unknown }>).map(
              (c) =>
                `${text(c.colour)} ${c.passed ? `passed (${plural(count(c.pieces), 'piece')})` : 'failed'}`
            ),
            text(d.notes),
          ])
        : null
    case 'DISPATCH':
      return join([
        text(d.number),
        `${plural(count(d.pieces), 'piece')} to ${text(d.recipient)}`,
        SAMPLE_DISPATCH_MODE_LABEL[text(d.mode) as SampleDispatchMode] ?? '',
        [text(d.courier), text(d.awb)].filter(Boolean).join(' '),
      ])
    case 'DISPATCH_CANCEL':
      return join([text(d.number), text(d.reason) && `Reason: ${text(d.reason)}`])
    case 'ADD_CHARGE':
      return join([
        SAMPLE_CHARGE_LABEL[text(d.kind) as SampleChargeKind] ?? text(d.kind),
        text(d.description),
        typeof d.revision === 'number' ? `round ${d.revision}` : 'whole request',
        rupees(d.amount),
      ])
    case 'REMOVE_CHARGE':
      return join([
        SAMPLE_CHARGE_LABEL[text(d.kind) as SampleChargeKind] ?? text(d.kind),
        text(d.description),
        rupees(d.amount),
        text(d.reason) && `Reason: ${text(d.reason)}`,
      ])
    case 'DISPATCH_CHARGE':
      return join([
        text(d.number),
        typeof d.charge === 'number' ? `${rupees(d.was)} → ${rupees(d.charge)}` : '',
        text(d.reason),
      ])
    case 'FINALISE_COST':
      return join([
        typeof d.total === 'number' ? `Total ${rupees(d.total)}` : '',
        typeof d.perPiece === 'number' ? `${rupees(d.perPiece)} a piece` : '',
        text(d.notes),
      ])
    case 'REOPEN_COST':
      return text(d.reason) ? `Reason: ${text(d.reason)}` : null
    case 'HANDOVER': {
      // Colour by colour since phase 8; before, one linked BOM and routing.
      if (!Array.isArray(d.boms)) return text(d.notes) || null
      const boms = d.boms as Array<{ colour?: unknown; version?: unknown; made?: unknown }>
      const routing = (d.routing ?? {}) as { code?: unknown; made?: unknown }
      return join([
        d.promoted ? `${text(d.style)} made a production style` : '',
        ...boms.map((b) => `${text(b.colour)} BOM v${text(b.version)}${b.made ? ' (draft from the sample)' : ''}`),
        text(routing.code) ? `Routing ${text(routing.code)}${routing.made ? ' (from the sample)' : ''}` : '',
        text(d.notes),
      ])
    }
    case 'ACCEPT_HANDOVER':
      return Array.isArray(d.boms)
        ? join((d.boms as Array<{ colour?: unknown; version?: unknown }>).map((b) => `${text(b.colour)} BOM v${text(b.version)}`))
        : null
    case 'DROP_COLOUR':
      return join([
        text(d.colour),
        text(d.reason) && `Reason: ${text(d.reason)}`,
        typeof d.result === 'string' ? `Round: ${SAMPLE_DECISION_LABEL[d.result as SampleDecisionResult]}` : '',
      ])
    case 'DECIDE':
      return Array.isArray(d.colours)
        ? join([
            ...(d.colours as Array<{ colour?: unknown; result?: unknown; conditions?: unknown }>).map(
              (c) =>
                `${text(c.colour)}: ${SAMPLE_DECISION_LABEL[text(c.result) as SampleDecisionResult] ?? text(c.result)}${text(c.conditions) ? ` (${text(c.conditions)})` : ''}`
            ),
            text(d.buyerName) && `by ${text(d.buyerName)}`,
            typeof d.result === 'string' ? `Round: ${SAMPLE_DECISION_LABEL[d.result as SampleDecisionResult]}` : '',
          ])
        : null
    case 'STEP_WORK':
      return join([
        text(d.stage),
        `${count(d.done)} done${count(d.rejected) ? `, ${count(d.rejected)} rejected` : ''}`,
        text(d.doneBy) && `by ${text(d.doneBy)}`,
        text(d.notes),
      ])
    case 'STEP_SEND':
      return join([
        `${plural(count(d.pieces), 'piece')} from ${text(d.from)} to ${text(d.to)}`,
        d.received ? 'one department: counted in with it' : '',
        text(d.sentBy) && `by ${text(d.sentBy)}`,
      ])
    case 'STEP_RECEIVE':
      return join([
        `${plural(count(d.pieces), 'piece')} counted in at ${text(d.to)}`,
        count(d.short) ? `${count(d.short)} short: ${text(d.shortReason)}` : '',
        text(d.receivedBy) && `by ${text(d.receivedBy)}`,
      ])
    case 'JOB_SEND':
      return join([
        text(d.number),
        `${plural(count(d.pieces), 'piece')} to ${text(d.vendor)} for ${text(d.stage)}`,
      ])
    case 'JOB_RETURN':
      return join([
        text(d.number),
        `${count(d.accepted)} accepted${count(d.rejected) ? `, ${count(d.rejected)} rejected` : ''}`,
        text(d.theirChallanNo) && `their challan ${text(d.theirChallanNo)}`,
        count(d.charge) ? `charged ${rupees(d.charge)}` : '',
      ])
    case 'JOB_CHARGE':
      return join([
        text(d.number),
        text(d.stage),
        typeof d.charge === 'number' ? `${rupees(d.was)} → ${rupees(d.charge)}` : '',
        text(d.reason),
      ])
    case 'STEP_LABOUR':
      return join([
        text(d.stage),
        typeof d.amount === 'number' ? `${rupees(d.was)} → ${rupees(d.amount)}` : '',
        text(d.note),
      ])
    case 'MAKING_UNDO':
      return join([
        d.kind === 'JOB_SEND'
          ? 'Challan cancelled'
          : `${MAKING_UNDO_LABEL[text(d.kind) as keyof typeof MAKING_UNDO_LABEL] ?? 'Record'} taken back`,
        text(d.number),
        text(d.stage) || (text(d.from) && `${text(d.from)} to ${text(d.to)}`),
        text(d.reason) && `Reason: ${text(d.reason)}`,
      ])
    case 'WAIVE_MATERIAL':
      return [text(d.item), text(d.component), d.undo ? '' : text(d.reason) && `Reason: ${text(d.reason)}`]
        .filter(Boolean)
        .join(' · ')
    case 'CLOSE_MATERIAL':
      return [
        `${typeof d.qty === 'number' ? d.qty : ''} of ${text(d.item)} from ${text(d.from)}`,
        d.kind === 'MOVED' ? 'moved to a general store' : 'used in the sample',
        text(d.reason) && `Reason: ${text(d.reason)}`,
      ]
        .filter(Boolean)
        .join(' · ')
    case 'ATTACH':
      return `${text(d.fileName)} · ${kind(d.kind)} · ${fileScope({ roundId: text(d.roundId) || null }, rounds)}`
    case 'DETACH':
      return `${text(d.fileName)} · ${kind(d.kind)} · Reason: ${text(d.reason)}`
    // A style action refits the draft: what that cleared follows the change.
    case 'CREATE_STYLE':
      return [
        text(d.code),
        text(d.name),
        Array.isArray(d.colors) ? d.colors.join(', ') : '',
        refitText(d.refit),
      ]
        .filter(Boolean)
        .join(' · ')
    case 'LINK_STYLE':
      return [`${code(d.before)} → ${code(d.after)}`, refitText(d.refit)]
        .filter(Boolean)
        .join(' · ')
    case 'UPDATE_STYLE': {
      const changes = styleChanges(d.before, d.after, sizeRun)
      return [
        `${text(d.code)}${changes.length ? `: ${changes.join('; ')}` : ''}`,
        refitText(d.refit),
      ]
        .filter(Boolean)
        .join(' · ')
    }
    case 'NEW_ROUND':
      return [
        typeof d.fromRevision === 'number' ? `From round ${d.fromRevision}` : '',
        typeof d.materials === 'number'
          ? `${plural(d.materials, 'material line')} carried over`
          : '',
        text(d.reason) && `Reason: ${text(d.reason)}`,
      ]
        .filter(Boolean)
        .join(' · ')
    default:
      return null
  }
}
