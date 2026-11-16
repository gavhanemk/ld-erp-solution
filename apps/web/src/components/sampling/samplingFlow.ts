import {
  SAMPLE_ATTACHMENT_KINDS,
  SAMPLE_ATTACHMENT_KIND_LABEL,
  type SampleAttachment,
  type SampleAttachmentKind,
  type SampleRequestStyle,
} from '@ld-erp/shared'
import type {
  Lookups,
  LookupStyle,
  SampleEvent,
  SampleMaterial,
  SampleRequest,
  SampleRound,
} from './types'

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
export const materialHeld = (m: SampleMaterial) =>
  Math.round((+m.issuedQty - +m.usedQty - +m.wasteQty - +m.returnedQty) * 1000) / 1000
export function makingBlocker(round: SampleRound, index: number) {
  if (round.state === 'DRAFT') return 'Release the specification before making starts.'
  if (round.stages.slice(0, index).some((s) => !s.completedAt))
    return 'Complete the preceding making step first.'
  if (
    round.materials.some(
      (m) =>
        +m.issuedQty < +m.plannedQty ||
        (index === 0 && Math.round((+m.issuedQty - +m.returnedQty) * 1000) / 1000 < +m.plannedQty)
    )
  )
    return 'Issue all planned materials before recording the first making step. Returned material cannot be counted as available.'
  return ''
}
export function sampleFlow(request: SampleRequest, round = request.rounds[0]) {
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
  } else if (round.state === 'RELEASED') {
    const index = round.stages.findIndex((s) => !s.completedAt)
    if (index >= 0) {
      const blocker = makingBlocker(round, index)
      section = blocker ? 'Materials' : 'Making'
      title = blocker
        ? 'Prepare material for making'
        : `Record ${round.stages[index].name.toLowerCase()}`
      description =
        blocker ||
        'Record the completed quantity, rejected pieces and responsible person for this step.'
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
          : 'Enter actual measurements and confirm workmanship before sending the sample to the buyer.'
    }
  } else if (round.state === 'QC_PASSED') {
    section = 'Buyer review'
    title = 'Submit the sample to the buyer'
    description = 'Record the pieces sent, recipient and courier or handover reference.'
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
      : 'Link the approved BOM and production route, then record production acceptance.'
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
  const sampledColours: string[] = []
  for (const r of sampled) {
    const colour = r.specification.color.trim()
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
 * no style): its colour when the style lacks it, the sizes outside the
 * style's size run, and the measurement points taken on them. The server
 * clears exactly these when the style changes, so the screen asks first.
 * '' when nothing would be lost.
 */
export function draftLoss(
  request: Pick<SampleRequest, 'rounds'>,
  style: { colors: string[]; sizeGroupId: string | null } | null,
  sizes: Array<{ id: string; sizeGroupId: string }>
) {
  const draft = request.rounds.find((r) => r.state === 'DRAFT')
  if (!draft) return ''
  const s = draft.specification
  const run = new Set(
    style?.sizeGroupId ? sizes.filter((z) => z.sizeGroupId === style.sizeGroupId).map((z) => z.id) : []
  )
  const fits = (sizeId: string) => !sizeId || run.has(sizeId)
  const colour = s.color.trim()
  const lostColour =
    colour && !style?.colors.some((c) => c.toLowerCase() === colour.toLowerCase()) ? colour : ''
  const lostSizes = s.sizes.filter((x) => !fits(x.sizeId)).length
  const lostPoints = s.measurements.filter((x) => !fits(x.sizeId)).length
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const parts = [
    lostColour && `colour ${lostColour}`,
    lostSizes && plural(lostSizes, 'size'),
    lostPoints && plural(lostPoints, 'measurement point'),
  ].filter((x): x is string => !!x)
  if (!parts.length) return ''
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  return `Round ${draft.revision}’s ${list} will be cleared.`
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
 * The detail line under a history entry for the file and style actions; null
 * for actions whose entry says enough on its own or is drawn elsewhere.
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
    case 'CREATE_STYLE':
      return [text(d.code), text(d.name), Array.isArray(d.colors) ? d.colors.join(', ') : '']
        .filter(Boolean)
        .join(' · ')
    case 'LINK_STYLE':
      return `${code(d.before)} → ${code(d.after)}`
    case 'UPDATE_STYLE': {
      const changes = styleChanges(d.before, d.after, sizeRun)
      return `${text(d.code)}${changes.length ? `: ${changes.join('; ')}` : ''}`
    }
    default:
      return null
  }
}
