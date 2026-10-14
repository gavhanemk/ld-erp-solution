import type { FlowTransfer } from './types'

/**
 * A transfer's state in plain words. On our floor a transfer waits to be
 * counted in where it arrives; to an outside unit it is with the unit until
 * the unit sends the pieces back.
 */
export function transferStatus(t: Pick<FlowTransfer, 'status' | 'isRework'> & { vendor: { name: string } | null }): { label: string; cls: string } {
  if (t.status === 'CANCELLED') return { label: 'Cancelled', cls: 'badge-neutral' }
  if (t.vendor) {
    if (t.status === 'RECEIVED') return { label: 'Back from the unit', cls: 'badge-success' }
    if (t.status === 'PARTLY_RECEIVED') return { label: 'Partly back', cls: 'badge-warning' }
    return { label: t.isRework ? 'With the unit, to put right' : 'With the unit', cls: 'badge-purple' }
  }
  if (t.status === 'RECEIVED') return { label: 'Received', cls: 'badge-success' }
  if (t.status === 'PARTLY_RECEIVED') return { label: 'Partly counted in', cls: 'badge-warning' }
  if (t.status === 'DISCREPANCY') return { label: 'Short — to settle', cls: 'badge-danger' }
  return { label: 'Waiting to be counted in', cls: 'badge-info' }
}
