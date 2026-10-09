import { api, can } from '@/lib/api'
import { OPEN_ORDER_STATUSES } from './status'

/**
 * What can be done to a sales order, decided in one place for the list and the
 * detail. These only decide what to offer: the server holds the same rules
 * and says why when it refuses.
 */
interface OrderLike {
  status: string
  sentForApprovalAt?: string | null
}

const isUnsentDraft = (o: OrderLike) => o.status === 'DRAFT' && !o.sentForApprovalAt

export const orderCan = {
  /** A draft changes until it is sent; after that a manager is deciding. */
  edit: (o: OrderLike) => isUnsentDraft(o) && can('sales', 'edit'),
  send: (o: OrderLike) => isUnsentDraft(o) && can('sales', 'create'),
  /** Approved and not finished: changed by amending, which keeps the old version. */
  amend: (o: OrderLike) => OPEN_ORDER_STATUSES.includes(o.status) && can('sales', 'edit'),
  /**
   * Before anything is made or sent. A draft is called off by whoever edits
   * orders; a confirmed one has been promised, so by someone who approves.
   */
  cancel: (o: OrderLike) =>
    (o.status === 'DRAFT' && can('sales', 'edit')) || (o.status === 'CONFIRMED' && can('sales', 'approve')),
  /** Once work has started: ends the order at what was sent. */
  shortClose: (o: OrderLike) => OPEN_ORDER_STATUSES.includes(o.status) && can('sales', 'approve'),
}

export type ReasonAction = 'cancel' | 'short-close'

/** The wording of the two actions that need a reason, for ReasonDialog. */
export const REASON_ACTIONS: Record<
  ReasonAction,
  { title: (n: string) => string; description: string; confirmLabel: string; placeholder: string }
> = {
  cancel: {
    title: (n) => `Cancel ${n}?`,
    description:
      'The order is called off and stays on file as cancelled, with your reason. Only before anything has been made or sent against it.',
    confirmLabel: 'Cancel order',
    placeholder: 'Buyer withdrew the PO',
  },
  'short-close': {
    title: (n) => `Short-close ${n}?`,
    description:
      'The order ends at what has been sent: every line’s remaining pieces are dropped, and what was sent stays. Use it when the buyer no longer wants the balance, or production came out short.',
    confirmLabel: 'Short-close',
    placeholder: 'Buyer agreed to take 960 of 1,000',
  },
}

export function postReasonAction(orderId: string, action: ReasonAction, reason: string) {
  return api.post<{ message?: string }>(`/sales/orders/${orderId}/${action}`, { reason })
}

export function sendForApproval(orderId: string) {
  return api.post<{ message?: string }>(`/sales/orders/${orderId}/send`, {})
}
