import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * The rules an enquiry has to keep, in one place.
 *
 * Two of them do all the work:
 *
 *   1. **An enquiry's status is derived, never stored as an opinion.** It is
 *      read back from what actually exists — is there a live order on it, is
 *      there a PI recorded, has it been sent — in the same way a receipt's
 *      billed state is read off its bills rather than written onto it. That is
 *      what makes cancelling an order put its quantity back on the enquiry
 *      immediately, with nothing to remember to undo.
 *
 *   2. **An enquiry is a question, not a purchase.** Nothing here reduces what
 *      an indent still needs ordered, and nothing here makes goods receivable.
 *      An enquiry that leaked into either would tell the mill it had bought
 *      something nobody has agreed to sell.
 *
 * `CLOSED` is the one status that is not derived: it is a decision somebody
 * took, so it survives until somebody reopens it.
 */

/**
 * What counts as an order standing on an enquiry.
 *
 * Cancelled and binned orders do not. An order raised in error and cancelled
 * the same afternoon must leave the enquiry exactly as it found it — otherwise
 * the quantity it claimed is stranded, quoted but unorderable, and the buyer's
 * only way out is to raise a second enquiry for goods already quoted.
 */
export const LIVE_ORDER: Prisma.PurchaseOrderWhereInput = {
  status: { not: 'CANCELLED' },
  deletedAt: null,
}

/** How much of each enquiry line has been placed on a live order. */
export async function orderedQtyByEnquiryLine(
  tx: Prisma.TransactionClient,
  enquiryId: string
): Promise<Map<string, number>> {
  const rows = await tx.purchaseOrderLine.groupBy({
    by: ['enquiryLineId'],
    where: { enquiryLine: { enquiryId }, po: LIVE_ORDER },
    _sum: { qty: true },
  })
  const out = new Map<string, number>()
  for (const r of rows) {
    if (r.enquiryLineId) out.set(r.enquiryLineId, Number(r._sum.qty ?? 0))
  }
  return out
}

/**
 * Puts the enquiry's status back in step with what exists.
 *
 * Called after anything that could change the answer: a PI recorded, an order
 * raised, an order cancelled, an order binned or restored. Deliberately does
 * not touch a CLOSED enquiry — that was a decision, and quietly reopening it
 * because an order got cancelled would resurrect a document somebody had
 * finished with.
 */
export async function syncEnquiryStatus(
  tx: Prisma.TransactionClient,
  enquiryId: string
): Promise<void> {
  const enquiry = await tx.purchaseEnquiry.findUnique({
    where: { id: enquiryId },
    select: { id: true, status: true, sentAt: true, piNumber: true },
  })
  if (!enquiry || enquiry.status === 'CLOSED') return

  const ordered = await tx.purchaseOrder.count({
    where: { enquiryId, ...LIVE_ORDER },
  })

  const next =
    ordered > 0 ? 'ORDERED' : enquiry.piNumber ? 'QUOTED' : enquiry.sentAt ? 'SENT' : 'DRAFT'

  if (next !== enquiry.status) {
    await tx.purchaseEnquiry.update({ where: { id: enquiryId }, data: { status: next } })
  }
}

/**
 * Refuses to cancel, close or bin an enquiry that an order is standing on.
 *
 * The same test the rest of purchase uses: does this change leave every other
 * document still true? A purchase order carries its enquiry's PI number as the
 * reference its price is defended with, so an enquiry dropped out from under a
 * live order leaves that order quoting a document nobody can produce.
 *
 * The way out is stated in the message rather than left to be discovered one
 * refusal later — cancel the order, and the enquiry frees itself, because the
 * status is derived rather than stored.
 */
export async function refuseIfOrdered(
  tx: Prisma.TransactionClient,
  enquiry: { id: string; enquiryNumber: string },
  what: 'closed' | 'deleted'
): Promise<void> {
  const orders = await tx.purchaseOrder.findMany({
    where: { enquiryId: enquiry.id, ...LIVE_ORDER },
    select: { poNumber: true },
    orderBy: { poNumber: 'asc' },
  })
  if (orders.length === 0) return

  const which = orders.map((o) => o.poNumber).join(', ')
  throw new AppError(
    `${enquiry.enquiryNumber} cannot be ${what} — ${orders.length > 1 ? 'orders' : 'order'} ` +
      `${which} ${orders.length > 1 ? 'were' : 'was'} raised from it. ` +
      `Cancel ${orders.length > 1 ? 'those orders' : which} first if the enquiry is wrong.`,
    409,
    'ENQUIRY_ORDERED'
  )
}

/**
 * Refuses an edit that would leave an order claiming more than the enquiry
 * quotes.
 *
 * Editing is left open on purpose, exactly as correcting a goods receipt is. An
 * enquiry for 1,240 with 600 ordered can have the other 640 corrected without
 * touching that order; refusing every edit would force cancelling a correct
 * order to fix a typing mistake unrelated to it, and that is how corrections
 * stop being made.
 *
 * What is refused is narrower and is the part that would actually break: a line
 * an order was raised from being removed, or cut below what has already been
 * placed against it.
 */
export async function assertEditKeepsOrdersTrue(
  tx: Prisma.TransactionClient,
  enquiry: { id: string; enquiryNumber: string },
  keptLines: Array<{ id?: string | null; qty: number }>
): Promise<void> {
  const ordered = await orderedQtyByEnquiryLine(tx, enquiry.id)
  if (ordered.size === 0) return

  const kept = new Map<string, number>()
  for (const l of keptLines) {
    if (l.id) kept.set(l.id, (kept.get(l.id) ?? 0) + l.qty)
  }

  const existing = await tx.purchaseEnquiryLine.findMany({
    where: { enquiryId: enquiry.id },
    select: { id: true, item: { select: { code: true, name: true } } },
  })
  const nameOf = new Map(existing.map((l) => [l.id, `${l.item.code} ${l.item.name}`]))

  for (const [lineId, placed] of ordered) {
    if (placed <= 0) continue
    const item = nameOf.get(lineId) ?? 'a line'
    const now = kept.get(lineId)

    if (now === undefined) {
      throw new AppError(
        `${item} cannot be removed from ${enquiry.enquiryNumber} — ${placed} of it has already ` +
          `been ordered. Cancel that order first, or leave the line and correct its quantity.`,
        409,
        'ENQUIRY_LINE_ORDERED'
      )
    }
    // A hair of tolerance: quantities carry three decimals and a figure that
    // round-trips through the browser can come back a fraction short of itself.
    if (now < placed - 0.0005) {
      throw new AppError(
        `${item} cannot be cut to ${now} on ${enquiry.enquiryNumber} — ${placed} has already been ` +
          `ordered against it. Cancel that order first if the quantity is wrong.`,
        409,
        'ENQUIRY_BELOW_ORDERED'
      )
    }
  }
}
