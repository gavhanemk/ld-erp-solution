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

/** Released and not finished: the floor has it in hand. */
export const LIVE_MO = ['RELEASED', 'CUTTING', 'STITCHING', 'FINISHING', 'QC', 'PACKING']
