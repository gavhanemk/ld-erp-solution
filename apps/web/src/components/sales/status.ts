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
 * an order still being typed and for one on credit hold for a manager, and
 * CANCELLED both for a refused draft and a called-off order; the dates tell
 * them apart.
 */
export function salesOrderStatus(order: {
  status: string
  sentForApprovalAt?: string | null
  approvedAt?: string | null
}): StatusLook {
  // Only a customer over their credit limit, or blacklisted, waits for anyone.
  if (order.status === 'DRAFT' && order.sentForApprovalAt) {
    return { label: 'Credit hold', cls: 'badge-warning' }
  }
  if (order.status === 'CANCELLED' && !order.approvedAt && order.sentForApprovalAt) {
    return { label: 'Rejected', cls: 'badge-danger' }
  }
  return SALES_ORDER_STATUS[order.status] ?? { label: order.status, cls: 'badge-neutral' }
}

/**
 * A delivery challan's status. Dispatched is on its way, so it reads as under
 * way rather than done; delivered is done.
 */
export const CHALLAN_STATUS: Record<string, StatusLook> = {
  DRAFT: { label: 'Draft', cls: 'badge-info' },
  DISPATCHED: { label: 'Dispatched', cls: 'badge-warning' },
  DELIVERED: { label: 'Delivered', cls: 'badge-success' },
  RETURNED: { label: 'Returned', cls: 'badge-danger' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

export const challanStatus = (status: string): StatusLook =>
  CHALLAN_STATUS[status] ?? { label: status, cls: 'badge-neutral' }

/** A sales invoice's status: what is still owed on it. */
export const INVOICE_STATUS: Record<string, StatusLook> = {
  UNPAID: { label: 'Unpaid', cls: 'badge-warning' },
  PARTIAL: { label: 'Part paid', cls: 'badge-info' },
  PAID: { label: 'Paid', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

export const invoiceStatus = (status: string): StatusLook =>
  INVOICE_STATUS[status] ?? { label: status, cls: 'badge-neutral' }

/** How money came in, in the words on the old receipt book. */
export const PAYMENT_MODES: Array<{ value: string; label: string }> = [
  { value: 'NEFT', label: 'NEFT' },
  { value: 'RTGS', label: 'RTGS' },
  { value: 'UPI', label: 'UPI' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'PDC', label: 'Post-dated cheque' },
  { value: 'CASH', label: 'Cash' },
]
export const modeLabel = (mode: string) => PAYMENT_MODES.find((m) => m.value === mode)?.label ?? mode

/**
 * A receipt's status. A cheque not yet credited by the bank reads as such;
 * a reversed receipt (a bounced cheque, a mistake) settles nothing.
 */
export function receiptStatus(r: { status: string; mode: string; isChequeCleared: boolean }): StatusLook {
  if (r.status === 'REVERSED') return { label: 'Reversed', cls: 'badge-danger' }
  if ((r.mode === 'CHEQUE' || r.mode === 'PDC') && !r.isChequeCleared) return { label: 'Cheque to clear', cls: 'badge-warning' }
  return { label: 'Received', cls: 'badge-success' }
}
