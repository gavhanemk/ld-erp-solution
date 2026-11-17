import {
  SAMPLE_ATTACHMENT_KINDS,
  SAMPLE_ATTACHMENT_KIND_LABEL,
  SAMPLE_MATERIAL_TYPES,
  cellCount,
  piecesFor,
  sampleOrdered,
  sampleReceived,
  sampleToBuy,
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
  { key: 'Making', title: 'Sample making', description: 'Cutting, stitching and finishing' },
  { key: 'Quality', title: 'QC & measurements', description: 'Workmanship and tolerance checks' },
  {
    key: 'Buyer review',
    title: 'Buyer submission & review',
    description: 'Feedback, approval or another round',
  },
  { key: 'Handover', title: 'Production handover', description: 'Approved package and acceptance' },
] as const
export type SampleSection = (typeof SAMPLE_SECTIONS)[number]['key'] | 'History'
const round3 = (v: number) => Math.round(v * 1000) / 1000
export const materialHeld = (m: SampleMaterial) =>
  round3(+m.issuedQty - +m.usedQty - +m.wasteQty - +m.returnedQty)
/**
 * The lines still short of their plan before making step `index`: not all
 * issued, or, before the first step, given back to the store since. The
 * server holds the steps back on exactly these (STAGE).
 */
const shortLines = (round: Pick<SampleRound, 'materials'>, index: number) =>
  round.materials.filter(
    (m) =>
      +m.issuedQty < +m.plannedQty ||
      (index === 0 && round3(+m.issuedQty - +m.returnedQty) < +m.plannedQty)
  )
export function makingBlocker(round: SampleRound, index: number) {
  if (round.state === 'DRAFT') return 'Release the specification before making starts.'
  if (round.stages.slice(0, index).some((s) => !s.completedAt))
    return 'Complete the preceding making step first.'
  if (shortLines(round, index).length)
    return 'Issue all planned materials before recording the first making step. Returned material cannot be counted as available.'
  return ''
}

/**
 * Several colours or sizes in one round make it a set. Nothing on the round
 * says which colour or size a rejected piece was, so the set goes through
 * making, QC and the buyer whole, and the server refuses anything less
 * (STAGE, QC, SUBMIT). The words are the server's own.
 */
export const isSampleSet = (spec: Pick<SampleSpecification, 'colours'>) => cellCount(spec) > 1
export const SET_TEXT = {
  stage:
    'With several colours or sizes in one round, record the whole set here; take rejected pieces out in a new round.',
  qc: 'With several colours or sizes in one round, inspect and pass the whole set; take rejected pieces out in a new round.',
  submit: 'Submit the whole inspected set so the approval covers every colour and size.',
} as const
/** The pieces a making step receives: the whole grid at the first step, then what the step before finished. */
export const stageInput = (round: Pick<SampleRound, 'specification' | 'stages'>, index: number) =>
  index === 0 ? totalPieces(round.specification) : (round.stages[index - 1]?.doneQty ?? 0)

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
    const index = round.stages.findIndex((s) => !s.completedAt)
    const set = isSampleSet(round.specification)
    if (index >= 0) {
      const blocker = makingBlocker(round, index)
      const short = shortLines(round, index)
      // Before anything can be issued, what is bought has to be ordered and arrive.
      const buying = blocker ? buyingOpen(round) : []
      section = buying.length ? 'Sourcing' : blocker ? 'Materials' : 'Making'
      title = buying.length
        ? buying.some((m) => lineSourcing(m).status === 'TO_ORDER')
          ? 'Buy the sample’s material'
          : 'Receive the sample’s material'
        : blocker
          ? 'Prepare material for making'
          : `Record ${round.stages[index].name.toLowerCase()}`
      description = buying.length
        ? sourcingText(buying)
        : blocker
        ? [
            blocker,
            `${short.length} of ${plural(round.materials.length, 'material line')} ${short.length === 1 ? 'is' : 'are'} not fully issued yet.`,
            // Each line's store is named at its first issue (STORE_REQUIRED).
            short.some((m) => !m.warehouseId) ? 'Pick the store at each line’s first issue.' : '',
          ]
            .filter(Boolean)
            .join(' ')
        : set
          ? `Record who did this step and the pieces done. ${SET_TEXT.stage}`
          : 'Record the completed quantity, rejected pieces and responsible person for this step.'
    } else if (round.stages.length && round.stages.at(-1)?.doneQty === 0) {
      section = 'History'
      title = 'No sample pieces remain for QC'
      description =
        'Reconcile material, then cancel this request with the rejected-piece disposition. Create a new request if development needs to restart.'
    } else {
      section = 'Quality'
      title = round.qc?.passed === false ? 'Resolve the QC findings' : 'Inspect the finished sample'
      description =
        round.qc?.passed === false
          ? 'Record a corrected inspection or start a new round. The failed inspection stays in the history.'
          : set
            ? 'Enter actual measurements and confirm workmanship of the whole set, every colour and size, before sending it to the buyer.'
            : 'Enter actual measurements and confirm workmanship before sending the sample to the buyer.'
    }
  } else if (round.state === 'QC_PASSED') {
    section = 'Buyer review'
    title = 'Submit the sample to the buyer'
    description = isSampleSet(round.specification)
      ? `${SET_TEXT.submit} Record the recipient and the courier or handover reference.`
      : 'Record the pieces sent, recipient and courier or handover reference.'
  } else if (round.state === 'SUBMITTED') {
    section = 'Buyer review'
    title = 'Awaiting buyer feedback'
    description = 'Record the buyer’s decision and its supporting reference when feedback arrives.'
  } else if (['CHANGES_REQUIRED', 'REJECTED'].includes(round.state)) {
    section = 'Buyer review'
    title = 'Review feedback and start a new round'
    description =
      'Keep this round as the record of the buyer’s decision. Carry the specification into a new round for corrections.'
  } else if (round.state === 'APPROVED') {
    const unreconciled = request.rounds.find((r) => r.materials.some((m) => materialHeld(m) > 0))
    section = 'Handover'
    title = round.handover?.acceptedAt
      ? 'Handover accepted'
      : round.handover
        ? 'Awaiting production acceptance'
        : 'Prepare the approved production package'
    description = round.handover?.acceptedAt
      ? 'The approved sample record is ready for production planning.'
      : 'Link an approved BOM of this style, for every colour or for one of this round’s colours, and the production route, then record production acceptance.'
    const madeHere = developmentStyleOf(request, round)
    if (!round.handover && madeHere) {
      title = 'Keep the approved round as the record'
      description = developmentHandoverText(madeHere.code)
    }
    if (!round.handover && unreconciled) {
      section = 'Materials'
      targetRoundId = unreconciled.id
      title = `Reconcile material on round ${unreconciled.revision}`
      description = 'Record used, wasted and returned quantities before preparing the handover.'
    }
  }
  if (request.cancelledAt) {
    section = 'History'
    title = 'Request cancelled'
    description = request.cancelReason || 'This request is closed.'
  }
  const completed: Record<string, boolean> = {
    Brief: !!request.styleId || round.state !== 'DRAFT',
    Technical: round.state !== 'DRAFT',
    Sourcing: round.state !== 'DRAFT' && buyingOpen(round).length === 0,
    Materials:
      round.materials.length > 0 && round.materials.every((m) => +m.issuedQty >= +m.plannedQty),
    Making: round.stages.length > 0 && round.stages.every((s) => !!s.completedAt),
    Quality: !!round.qc?.passed,
    'Buyer review': round.state === 'APPROVED',
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
          ? round.state === 'SUBMITTED'
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
 * The round's style when it is one made in sampling: it has no BOM or route
 * and cannot be given one yet, so there is nothing to hand over to production.
 */
export function developmentStyleOf(
  request: Pick<SampleRequest, 'style'>,
  round: Pick<SampleRound, 'specification'>
) {
  const style = request.style
  return style?.stage === 'DEVELOPMENT' && style.id === round.specification.styleId ? style : null
}
export const developmentHandoverText = (code: string) =>
  `${code} is a new style made in sampling. Handing it over to production comes in a later update; keep the approved round as the record.`

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
 */
export function lineItem(
  line: { id?: string; itemId: string },
  round: Pick<SampleRound, 'materials'>,
  items: Lookups['items']
) {
  const row =
    (line.id && round.materials.find((m) => m.id === line.id)) ||
    (line.itemId ? round.materials.find((m) => m.itemId === line.itemId) : undefined)
  if (row?.item)
    return { name: row.item.name, code: row.item.code, uom: row.item.uom?.symbol ?? '' }
  const item = line.itemId ? items.find((i) => i.id === line.itemId) : undefined
  if (item) return { name: item.name, code: item.code, uom: item.uom?.symbol ?? '' }
  return {
    name: line.itemId ? 'Material no longer in use' : 'No material picked',
    code: '',
    uom: '',
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
  round: Pick<SampleRound, 'state' | 'stages' | 'handover'>,
  m: SampleMaterial
) {
  const remaining = round3(Math.max(0, +m.plannedQty - +m.issuedQty))
  const held = materialHeld(m)
  const issueOpen = round.state === 'RELEASED' && !round.stages.some((s) => s.completedAt)
  const kinds: MaterialKind[] = []
  if (!round.handover) {
    if (m.itemId && issueOpen && remaining > 0) kinds.push('ISSUE')
    if (held > 0) kinds.push('USE', 'WASTE', 'RETURN')
  }
  const why = kinds.length
    ? ''
    : round.handover
      ? 'This round is handed over; its material record is frozen.'
      : !m.itemId
        ? NO_ITEM_TEXT
        : round.state === 'DRAFT'
          ? 'Issued once the round is released.'
          : remaining > 0
            ? 'Issue materials before making starts; extra needs require a new round.'
            : 'Issued in full and accounted for.'
  return { kinds, remaining, held, why, needsStore: kinds.includes('ISSUE') && !m.warehouseId }
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
// ── Sourcing (phase 3) ────────────────────────────────────────────────────────

/** Where one line of the sample BOM stands with its buying. */
export type SourcingStatus = 'BUYER' | 'NO_ITEM' | 'TO_ORDER' | 'ON_ORDER' | 'RECEIVED' | 'ISSUED'
export const SOURCING_STATUS_LABEL: Record<SourcingStatus, string> = {
  BUYER: 'Buyer sends it',
  NO_ITEM: 'No material picked',
  TO_ORDER: 'To order',
  ON_ORDER: 'On order',
  RECEIVED: 'Received',
  ISSUED: 'Issued',
}
/**
 * How far buying has got for one line, summed off its orders as the server
 * sums them (sampleOrdered: a line closed short counts only what arrived).
 * A line already issued in full needs nothing more bought, however it was
 * stocked.
 */
export function lineSourcing(m: Pick<SampleMaterial, 'source' | 'itemId' | 'plannedQty' | 'issuedQty' | 'orders'>) {
  const orders = m.orders ?? []
  const required = +m.plannedQty
  const ordered = sampleOrdered(orders)
  const received = sampleReceived(orders)
  const toBuy = sampleToBuy(required, orders, m.issuedQty)
  const status: SourcingStatus =
    m.source === 'BUYER_SUPPLIED'
      ? 'BUYER'
      : !m.itemId
        ? 'NO_ITEM'
        : +m.issuedQty >= required
          ? 'ISSUED'
          : received >= required
            ? 'RECEIVED'
            : toBuy > 0
              ? 'TO_ORDER'
              : 'ON_ORDER'
  return { required, ordered, received, toBuy, status }
}
/** The bought lines of a released round still to order or to arrive. */
export const buyingOpen = (round: Pick<SampleRound, 'state' | 'materials'>) =>
  round.state === 'RELEASED'
    ? round.materials.filter((m) => ['TO_ORDER', 'ON_ORDER'].includes(lineSourcing(m).status))
    : []
/** The next-action words for the lines still being bought. */
export function sourcingText(lines: SampleMaterial[]) {
  const toOrder = lines.filter((m) => lineSourcing(m).status === 'TO_ORDER').length
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

/** Approved BOMs the round can be handed over with: this style's, for every colour or one the round made. */
export function handoverBoms(
  boms: Lookups['boms'],
  spec: Pick<SampleSpecification, 'styleId' | 'colours'>
) {
  const made = new Set(spec.colours.map((c) => c.colour.trim().toLowerCase()).filter(Boolean))
  return boms.filter(
    (b) => b.styleId === spec.styleId && (!b.color || made.has(b.color.trim().toLowerCase()))
  )
}

/** History lines in words rather than action codes. */
export const SAMPLE_EVENT_LABEL: Record<string, string> = {
  CREATE: 'Request created',
  UPDATE_REQUEST: 'Request details updated',
  SAVE_DRAFT: 'Draft saved',
  SAVE_SPEC: 'Specification saved',
  RELEASE: 'Released for sampling',
  MATERIAL: 'Material recorded',
  STAGE: 'Making step recorded',
  QC: 'QC recorded',
  SUBMIT: 'Submitted to the buyer',
  DECIDE: 'Buyer decision recorded',
  NEW_ROUND: 'New round started',
  HANDOVER: 'Handover prepared',
  ACCEPT_HANDOVER: 'Handover accepted',
  CANCEL: 'Request cancelled',
  ATTACH: 'File attached',
  DETACH: 'File removed',
  CREATE_STYLE: 'Development style created',
  LINK_STYLE: 'Style for this sample changed',
  UPDATE_STYLE: 'Style details changed',
}
export const eventLabel = (action: string) =>
  SAMPLE_EVENT_LABEL[action] ?? action.replaceAll('_', ' ').toLowerCase()

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
  switch (e.action) {
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
