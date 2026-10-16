import type { Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'

/*
 * A customer's material is used only for that customer's work.
 *
 * The stock ledger already keeps every owner's balance apart, so customer A's
 * cloth can never leave as our own or as B's. What it cannot know is what the
 * cloth is FOR. That is said by the document sending it — a requisition, its
 * issue, a job-work challan — through the order it names, and this is where
 * that order is checked against the material's owner, on the server, before
 * any stock moves:
 *
 *   - the order must be named: customer material with no order is refused
 *     (receiving it without an order stays allowed — that is the gate);
 *   - it must be a job-work order, because only a job-work order's cutting,
 *     finished goods and dispatch keep the result the customer's;
 *   - it must be the material owner's own order, and not cancelled;
 *   - a manufacturing order and a sales order named together must agree.
 */

export interface OwnedLine {
  itemId: string
  ownership?: string | null
  ownerCustomerId?: string | null
}

export interface OrderFor {
  id: string
  soNumber: string
  customerId: string
  customerName: string
  isJobWork: boolean
  status: string
}

/**
 * The sales order a document is for: the one it names, or its manufacturing
 * order's. Refuses an MO and an SO that point at different orders.
 */
export async function orderOf(tx: Prisma.TransactionClient, ctx: { soId?: string | null; moId?: string | null }): Promise<OrderFor | null> {
  const select = { id: true, soNumber: true, customerId: true, isJobWork: true, status: true, customer: { select: { name: true } } } as const
  const [so, mo] = await Promise.all([
    ctx.soId ? tx.salesOrder.findUnique({ where: { id: ctx.soId }, select }) : null,
    ctx.moId ? tx.manufacturingOrder.findUnique({ where: { id: ctx.moId }, select: { moNumber: true, soId: true, so: { select } } }) : null,
  ])
  if (ctx.soId && !so) throw new AppError('That sales order does not exist', 404, 'NOT_FOUND')
  if (ctx.moId && !mo) throw new AppError('That manufacturing order does not exist', 404, 'NOT_FOUND')
  if (so && mo?.so && mo.so.id !== so.id) {
    throw new AppError(`${mo.moNumber} is for ${mo.so.soNumber}, not ${so.soNumber}. Pick the order it is really for.`, 400, 'WRONG_ORDER')
  }
  const o = so ?? mo?.so ?? null
  return o ? { id: o.id, soNumber: o.soNumber, customerId: o.customerId, customerName: o.customer.name, isJobWork: o.isJobWork, status: o.status } : null
}

/**
 * Refuses, before anything is written, any customer-owned line whose owner is
 * not the customer of the job-work order the document is for. Returns that
 * order (or null when the document names none and has no customer material).
 */
export async function assertOwnersFitOrder(
  tx: Prisma.TransactionClient,
  ctx: { soId?: string | null; moId?: string | null; doc: string },
  lines: OwnedLine[],
): Promise<OrderFor | null> {
  const order = await orderOf(tx, ctx)
  const theirs = lines.filter((l) => l.ownership === 'CUSTOMER_OWNED')
  if (!theirs.length) return order

  // Named only when something is wrong, so a good document costs no extra reads.
  const describe = async (l: OwnedLine) => {
    const [item, owner] = await Promise.all([
      tx.item.findUnique({ where: { id: l.itemId }, select: { name: true } }),
      l.ownerCustomerId ? tx.customer.findUnique({ where: { id: l.ownerCustomerId }, select: { name: true } }) : null,
    ])
    return { item: item?.name ?? 'This item', owner: owner?.name ?? 'a customer' }
  }

  const ownerless = theirs.find((l) => !l.ownerCustomerId)
  if (ownerless) {
    const d = await describe(ownerless)
    throw new AppError(`${d.item} is marked as a customer's material but no customer is named. Say whose it is.`, 400, 'NO_STOCK_OWNER')
  }
  if (!order) {
    const d = await describe(theirs[0])
    throw new AppError(
      `${d.item} is ${d.owner}'s material, so it can only go to one of ${d.owner}'s job-work orders. Say which order this ${ctx.doc} is for.`,
      400,
      'NEEDS_ORDER',
    )
  }
  const wrong = theirs.find((l) => l.ownerCustomerId !== order.customerId)
  if (wrong) {
    const d = await describe(wrong)
    throw new AppError(
      `${d.item} is ${d.owner}'s material, but ${order.soNumber} is ${order.customerName}'s order. A customer's material is used only for that customer's work.`,
      400,
      'WRONG_OWNER',
    )
  }
  if (!order.isJobWork) {
    const d = await describe(theirs[0])
    throw new AppError(
      `${order.soNumber} is not a job-work order, so ${d.owner}'s material cannot be used on it: what is made from it would be booked as ours.`,
      400,
      'NOT_JOB_WORK',
    )
  }
  if (order.status === 'CANCELLED') {
    throw new AppError(`${order.soNumber} was cancelled, so ${order.customerName}'s material cannot go to it.`, 400, 'ORDER_CANCELLED')
  }
  return order
}
