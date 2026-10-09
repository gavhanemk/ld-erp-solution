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

  const [invoices, orders] = await Promise.all([
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
  }
}

export interface CreditCheck extends CreditPosition {
  orderValue: number
  /** Unpaid + open orders + this order. */
  exposure: number
  overLimit: boolean
  /** True when approving needs a manager's release: over the limit, or blacklisted. */
  needsRelease: boolean
}

/** The position with one more order added, and whether that crosses the line. */
export function checkCredit(position: CreditPosition, orderValue: number): CreditCheck {
  const exposure = round2(position.unpaid + position.openOrders + orderValue)
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
  return (
    `${why}. Unpaid invoices ${rupees(c.unpaid)}${overdue}, other open orders ${rupees(c.openOrders)}, ` +
    `this order ${rupees(c.orderValue)}: ${rupees(c.exposure)} in all. ` +
    `Approving it needs a reason for releasing it.`
  )
}

interface ApproveOptions {
  /** The Admin may approve an order they raised, as on requisitions. */
  admin?: boolean
  /** Required when the customer is over their limit or blacklisted. */
  creditReleaseReason?: string | null
}

/**
 * Approve a draft sales order. The one place the rules live, so the dashboard
 * and the assistant cannot drift apart:
 *
 *   - only a draft can be approved — not a cancelled or already-confirmed one;
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

  // Until the order has columns of its own for the release, it is written
  // into the notes the way a rejection is, so it is never lost.
  const notes = credit.needsRelease
    ? appendLine(before.notes, `Credit released on approval: ${reason}`)
    : before.notes

  const after = await prisma.salesOrder.update({
    where: { id },
    data: { status: 'CONFIRMED', approvedById: userId, approvedAt: new Date(), notes },
  })
  return { before, after, credit }
}

/** Refuse a draft sales order. The order is cancelled and the reason kept. */
export async function rejectSalesOrder(id: string, reason: string) {
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
    data: { status: 'CANCELLED', notes: appendLine(before.notes, `Rejected: ${reason}`) },
  })
  return { before, after }
}

function statusWords(status: SalesOrderStatus): string {
  return status.toLowerCase().replace(/_/g, ' ')
}

/** Keeps whatever the order already said and adds one line under it. */
function appendLine(existing: string | null, line: string): string {
  return existing ? `${existing}\n${line}` : line
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
