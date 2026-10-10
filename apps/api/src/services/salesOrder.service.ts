import type { Prisma, PrismaClient, SalesOrderStatus } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Orders the mill has promised and not yet finished. A draft is not promised,
 * and a completed or cancelled order owes the customer nothing more.
 */
export const OPEN_ORDER_STATUSES: SalesOrderStatus[] = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED']

export interface CreditPosition {
  customerName: string
  /** Null when no limit is set on the customer, which means no limit. */
  limit: number | null
  creditDays: number
  isBlacklisted: boolean
  /** Balance still due on unpaid and part-paid invoices. */
  unpaid: number
  /** The part of `unpaid` already past its due date. */
  overdue: number
  /** Confirmed orders not yet invoiced: money the customer will owe. */
  openOrders: number
  /** Money received and not yet applied to an invoice: an advance, which offsets the rest. */
  onAccount: number
}

/**
 * What a customer owes, and is about to owe, against their credit limit.
 *
 * `excludeOrderId` leaves out the order being judged, so approving an order
 * does not count it twice — once as itself and once as an open order.
 */
export async function creditPosition(
  db: Db,
  customerId: string,
  excludeOrderId?: string,
): Promise<CreditPosition> {
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    select: { name: true, creditLimit: true, creditDays: true, isBlacklisted: true },
  })
  if (!customer) throw new AppError('Customer not found', 404, 'NOT_FOUND')

  const [invoices, orders, advance] = await Promise.all([
    db.salesInvoice.findMany({
      where: { customerId, status: { in: ['UNPAID', 'PARTIAL'] } },
      select: { balanceAmount: true, dueDate: true },
    }),
    db.salesOrder.findMany({
      where: {
        customerId,
        status: { in: OPEN_ORDER_STATUSES },
        ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
      },
      select: {
        totalAmount: true,
        invoices: { where: { status: { not: 'CANCELLED' } }, select: { totalAmount: true } },
      },
    }),
    db.paymentReceipt.aggregate({ where: { customerId, status: 'POSTED' }, _sum: { onAccount: true } }),
  ])

  const now = Date.now()
  let unpaid = 0
  let overdue = 0
  for (const inv of invoices) {
    const balance = Number(inv.balanceAmount)
    unpaid += balance
    if (inv.dueDate && inv.dueDate.getTime() < now) overdue += balance
  }

  // An order half invoiced is half in `unpaid` already; only the rest is still
  // to come.
  const openOrders = orders.reduce((sum, o) => {
    const invoiced = o.invoices.reduce((s, i) => s + Number(i.totalAmount), 0)
    return sum + Math.max(0, Number(o.totalAmount) - invoiced)
  }, 0)

  return {
    customerName: customer.name,
    limit: customer.creditLimit != null ? Number(customer.creditLimit) : null,
    creditDays: customer.creditDays,
    isBlacklisted: customer.isBlacklisted,
    unpaid: round2(unpaid),
    overdue: round2(overdue),
    openOrders: round2(openOrders),
    onAccount: round2(Number(advance._sum.onAccount ?? 0)),
  }
}

export interface CreditCheck extends CreditPosition {
  orderValue: number
  /** Unpaid + open orders + this order, less any advance on account. */
  exposure: number
  overLimit: boolean
  /** True when approving needs a manager's release: over the limit, or blacklisted. */
  needsRelease: boolean
}

/** The position with one more order added, and whether that crosses the line. */
export function checkCredit(position: CreditPosition, orderValue: number): CreditCheck {
  const exposure = round2(position.unpaid + position.openOrders + orderValue - position.onAccount)
  const overLimit = position.limit != null && exposure > position.limit
  return {
    ...position,
    orderValue: round2(orderValue),
    exposure,
    overLimit,
    needsRelease: overLimit || position.isBlacklisted,
  }
}

/** The warning an approver reads before releasing the order, figures included. */
export function creditWarning(c: CreditCheck): string {
  const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
  const why = c.isBlacklisted
    ? `${c.customerName} is marked blacklisted`
    : `${c.customerName} would go over their credit limit of ${rupees(c.limit ?? 0)}`
  const overdue = c.overdue > 0 ? ` (${rupees(c.overdue)} overdue)` : ''
  const advance = c.onAccount > 0 ? `, less ${rupees(c.onAccount)} paid in advance` : ''
  return (
    `${why}. Unpaid invoices ${rupees(c.unpaid)}${overdue}, other open orders ${rupees(c.openOrders)}, ` +
    `this order ${rupees(c.orderValue)}${advance}: ${rupees(c.exposure)} in all. ` +
    `Approving it needs a reason for releasing it.`
  )
}

interface ConfirmOptions {
  /** The Admin may release a credit hold on an order they raised themselves. */
  admin: boolean
  /** Whether the person confirming holds sales:approve. */
  canApprove: boolean
  /** Required to release a credit hold at the moment of confirming. */
  creditReleaseReason?: string | null
}

export type ConfirmOutcome =
  | { outcome: 'CONFIRMED'; released: boolean; credit: CreditCheck }
  | { outcome: 'HELD'; credit: CreditCheck }

/**
 * Confirm a draft: the order is final and the customer is promised it.
 *
 * Most orders need nobody's approval — this is the standard ERP flow, draft
 * then confirm, as the business asked on 10 Oct 2026. A manager is brought in
 * only when there is a reason: the customer is over their credit limit or
 * blacklisted (the answer of 9 Oct). Then:
 *
 *   - someone who may release it (the Admin, or an approver who did not raise
 *     the order) confirms it with a reason, kept on the order — without the
 *     reason this answers CREDIT_HOLD with the figures, so the screen can ask;
 *   - anyone else's order goes on credit hold: `sentForApprovalAt` is set and
 *     it waits in Pending Approvals, where approveSalesOrder decides it.
 *
 * Takes the transaction it runs in, so saving a new order and confirming it
 * are one act: an order refused here leaves no number behind.
 */
export async function confirmOrHold(
  db: Prisma.TransactionClient,
  id: string,
  userId: string,
  opts: ConfirmOptions,
): Promise<ConfirmOutcome> {
  const order = await db.salesOrder.findUnique({ where: { id } })
  if (!order) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  if (order.status !== 'DRAFT') {
    throw new AppError(`${order.soNumber} is ${statusWords(order.status)} already`, 409, 'NOT_DRAFT')
  }
  if (order.sentForApprovalAt) {
    throw new AppError(
      `${order.soNumber} is on credit hold, waiting for a manager in Pending Approvals`,
      409,
      'ON_HOLD',
    )
  }

  const credit = checkCredit(await creditPosition(db, order.customerId, order.id), Number(order.totalAmount))
  const now = new Date()

  if (!credit.needsRelease) {
    await db.salesOrder.update({
      where: { id },
      data: { status: 'CONFIRMED', approvedById: userId, approvedAt: now },
    })
    return { outcome: 'CONFIRMED', released: false, credit }
  }

  const mayRelease = opts.admin || (opts.canApprove && order.createdById !== userId)
  const reason = opts.creditReleaseReason?.trim()
  if (mayRelease && !reason) throw new AppError(creditWarning(credit), 409, 'CREDIT_HOLD')
  if (mayRelease) {
    await db.salesOrder.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        approvedById: userId,
        approvedAt: now,
        creditReleasedById: userId,
        creditReleasedAt: now,
        creditReleaseReason: reason,
      },
    })
    return { outcome: 'CONFIRMED', released: true, credit }
  }

  await db.salesOrder.update({ where: { id }, data: { sentForApprovalAt: now } })
  return { outcome: 'HELD', credit }
}

/** What the person who pressed Confirm is told. */
export function confirmMessage(soNumber: string, r: ConfirmOutcome): string {
  if (r.outcome === 'HELD') {
    return `${soNumber} is on credit hold: ${
      r.credit.isBlacklisted ? `${r.credit.customerName} is blacklisted` : `${r.credit.customerName} is over their credit limit`
    }. It has gone to a manager to OK in Pending Approvals.`
  }
  return r.released ? `${soNumber} confirmed, credit hold released` : `${soNumber} confirmed`
}

interface ApproveOptions {
  /** The Admin may approve an order they raised, as on requisitions. */
  admin?: boolean
  /** Required when the customer is over their limit or blacklisted. */
  creditReleaseReason?: string | null
}

/**
 * Approve an order on credit hold — the only orders that wait for one. The
 * one place the rules live, so the dashboard and the assistant cannot drift
 * apart:
 *
 *   - only a held draft can be approved — not a cancelled or already-confirmed
 *     one, nor a draft still being typed (that is confirmed, not approved);
 *   - the person who raised it cannot approve it (the Admin excepted);
 *   - a customer over their credit limit, or blacklisted, is not a hard stop:
 *     the approver releases it with a reason, which is kept on the order.
 */
export async function approveSalesOrder(id: string, userId: string, opts: ApproveOptions = {}) {
  const before = await prisma.salesOrder.findUnique({ where: { id } })
  if (!before) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  if (before.status !== 'DRAFT' || before.approvedAt) {
    throw new AppError(
      `${before.soNumber} is ${statusWords(before.status)}, so it cannot be approved`,
      409,
      'NOT_DRAFT',
    )
  }
  if (!before.sentForApprovalAt) {
    throw new AppError(
      `${before.soNumber} is not waiting for anyone: confirm it from the order itself`,
      409,
      'NOT_SENT',
    )
  }
  if (before.createdById === userId && !opts.admin) {
    throw new AppError(
      'You raised this order, so somebody else has to approve it.',
      403,
      'SELF_APPROVAL',
    )
  }

  const credit = checkCredit(
    await creditPosition(prisma, before.customerId, before.id),
    Number(before.totalAmount),
  )
  const reason = opts.creditReleaseReason?.trim()
  if (credit.needsRelease && !reason) {
    throw new AppError(creditWarning(credit), 409, 'CREDIT_HOLD')
  }

  const now = new Date()
  const after = await prisma.salesOrder.update({
    where: { id },
    data: {
      status: 'CONFIRMED',
      approvedById: userId,
      approvedAt: now,
      ...(credit.needsRelease && {
        creditReleasedById: userId,
        creditReleasedAt: now,
        creditReleaseReason: reason,
      }),
    },
  })
  return { before, after, credit }
}

/**
 * Refuse a draft sales order. It is cancelled, with who refused it and why;
 * a cancelled order that was never approved is one that was rejected.
 */
export async function rejectSalesOrder(id: string, userId: string, reason: string) {
  const before = await prisma.salesOrder.findUnique({ where: { id } })
  if (!before) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  if (before.status !== 'DRAFT') {
    throw new AppError(
      `${before.soNumber} is ${statusWords(before.status)}, so it cannot be rejected. Cancel or short-close it instead.`,
      409,
      'NOT_DRAFT',
    )
  }

  const after = await prisma.salesOrder.update({
    where: { id },
    data: { status: 'CANCELLED', cancelledById: userId, cancelledAt: new Date(), cancelReason: reason },
  })
  return { before, after }
}

function statusWords(status: SalesOrderStatus): string {
  return status.toLowerCase().replace(/_/g, ' ')
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
