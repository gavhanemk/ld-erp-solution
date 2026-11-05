/**
 * How a manufacturing order's status reads, in one place, for the list, the
 * detail and the order screens that show it.
 */
export interface StatusLook {
  label: string
  cls: string
}

/** In workflow order, so the filter reads like the shop floor. */
export const MO_STATUS: Record<string, StatusLook> = {
  DRAFT: { label: 'Draft', cls: 'badge-info' },
  RELEASED: { label: 'Released', cls: 'badge-warning' },
  CUTTING: { label: 'Cutting', cls: 'badge-purple' },
  STITCHING: { label: 'Stitching', cls: 'badge-warning' },
  FINISHING: { label: 'Finishing', cls: 'badge-warning' },
  QC: { label: 'QC', cls: 'badge-info' },
  PACKING: { label: 'Packing', cls: 'badge-info' },
  COMPLETED: { label: 'Completed', cls: 'badge-success' },
  CLOSED: { label: 'Closed', cls: 'badge-neutral' },
}

export const moStatus = (status: string): StatusLook => MO_STATUS[status] ?? { label: status, cls: 'badge-neutral' }

/**
 * Where a manufacturing order stands: the server's `stage`. Its own status
 * says only draft, released, completed or closed, and "released" covers
 * everything from asking for materials to packing, so the list and its
 * window show this instead. In the order the work goes; the same steps as
 * the window's tabs. Amber where production has to act, purple while the
 * store has it, teal once it is on the floor, green only when it is done.
 */
export const MO_STAGE: Record<string, StatusLook & { hint: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral', hint: 'Not released to the floor yet' },
  NOT_ASKED: { label: 'Materials not asked', cls: 'badge-warning', hint: 'Released, but nobody has asked the store for its materials yet' },
  ASKED: { label: 'Materials asked', cls: 'badge-purple', hint: 'Requisitions raised; the store has not issued anything yet' },
  PART_ISSUED: { label: 'Part issued', cls: 'badge-warning', hint: 'The store has issued some of its materials, not all of them in full' },
  ISSUED: { label: 'Materials issued', cls: 'badge-info', hint: 'Every material issued in full; ready for cutting' },
  IN_PRODUCTION: { label: 'In production', cls: 'badge-info', hint: 'Cutting recorded; the pieces are moving through their stages' },
  PACKING: { label: 'Packing', cls: 'badge-info', hint: 'Some pieces packed into finished goods, not all yet' },
  COMPLETED: { label: 'Completed', cls: 'badge-success', hint: 'All pieces packed' },
  CLOSED: { label: 'Closed', cls: 'badge-neutral', hint: 'Closed with a reason' },
}

/** Its stage, or its status where the server sent none. */
export const moStage = (stage: string | null | undefined, status: string): StatusLook & { hint?: string } =>
  (stage ? MO_STAGE[stage] : undefined) ?? moStatus(status)

/**
 * The floor's progress worth a second badge beside the stage: what needs a
 * look, or every piece through. "Not started" and "In progress" only repeat
 * the stage.
 */
export const FLOOR_NOTE = new Set(['QC_PENDING', 'REWORK', 'DISCREPANCY', 'DONE'])

/** Released and not finished: the floor has it in hand. */
export const LIVE_MO = ['RELEASED', 'CUTTING', 'STITCHING', 'FINISHING', 'QC', 'PACKING']
