import type { SampleMaterial, SampleRequest, SampleRound } from './types'

export const SAMPLE_SECTIONS = [
  { key: 'Brief', title: 'Request & buyer brief', description: 'Requirements, owner and due date' },
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
  if (round.state === 'RELEASED') {
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
    Brief: true,
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
