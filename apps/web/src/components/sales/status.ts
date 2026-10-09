/**
 * How a sales document's status reads, in one place.
 *
 * The order list, its phone cards, the detail and the dashboard all show the
 * same status, and a second copy of this table is how two screens end up
 * calling one order two different things. The badge meanings are the design
 * rules' (docs/02-design-rules.md): info a draft, warning waiting or under
 * way, success approved or done, danger refused or late, neutral cancelled.
 */

export interface StatusLook {
  label: string
  cls: string
}

export const SALES_ORDER_STATUS: Record<string, StatusLook> = {
  DRAFT: { label: 'Draft', cls: 'badge-info' },
  CONFIRMED: { label: 'Confirmed', cls: 'badge-success' },
  IN_PRODUCTION: { label: 'In production', cls: 'badge-warning' },
  PARTIALLY_DISPATCHED: { label: 'Part dispatched', cls: 'badge-warning' },
  COMPLETED: { label: 'Completed', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

/** Orders promised and not yet finished: the ones that can be late. */
export const OPEN_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED']

/**
 * One order's status as it should read. The stored status says DRAFT both for
 * an order still being typed and for one sent and waiting on a manager, and
 * CANCELLED both for a refused draft and a called-off order; the dates tell
 * them apart.
 */
export function salesOrderStatus(order: {
  status: string
  sentForApprovalAt?: string | null
  approvedAt?: string | null
}): StatusLook {
  if (order.status === 'DRAFT' && order.sentForApprovalAt) {
    return { label: 'Waiting approval', cls: 'badge-warning' }
  }
  if (order.status === 'CANCELLED' && !order.approvedAt && order.sentForApprovalAt) {
    return { label: 'Rejected', cls: 'badge-danger' }
  }
  return SALES_ORDER_STATUS[order.status] ?? { label: order.status, cls: 'badge-neutral' }
}
