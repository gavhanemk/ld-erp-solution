import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

const IST = 330 * 60_000
/** A moment's calendar day in India, as YYYY-MM-DD. */
const istDay = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10)

/**
 * Called by the sales order route when an order is saved from a quotation:
 * the quotation is won, and points at the order. Refused when the quotation
 * is for someone else, was lost, has already become an order that still
 * stands, or is past its valid-until date and not yet won — the price then
 * has to be agreed again, by moving that date on the quotation first.
 */
export async function winQuote(tx: Prisma.TransactionClient, quotationId: string, customerId: string) {
  const quote = await tx.salesQuotation.findUnique({
    where: { id: quotationId },
    select: {
      quoteNumber: true,
      status: true,
      customerId: true,
      validUntil: true,
      orders: { where: { status: { not: 'CANCELLED' } }, select: { soNumber: true }, take: 1 },
    },
  })
  if (!quote) throw new AppError('That quotation does not exist', 400, 'BAD_QUOTE')
  if (quote.customerId !== customerId) throw new AppError(`${quote.quoteNumber} is another customer's quotation`, 400, 'WRONG_CUSTOMER')
  if (quote.status === 'LOST') throw new AppError(`${quote.quoteNumber} was marked lost`, 409, 'QUOTE_LOST')
  if (quote.orders.length) {
    throw new AppError(`${quote.quoteNumber} has already become ${quote.orders[0].soNumber}. Open that order instead.`, 409, 'QUOTE_USED')
  }
  if (quote.status !== 'WON' && quote.validUntil && istDay(quote.validUntil) < istDay(new Date())) {
    const on = quote.validUntil.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
    throw new AppError(
      `${quote.quoteNumber} expired on ${on}. If the price still stands, edit the quotation and move its valid-until date, then convert it.`,
      409,
      'QUOTE_EXPIRED',
    )
  }
  if (quote.status !== 'WON') await tx.salesQuotation.update({ where: { id: quotationId }, data: { status: 'WON', decidedAt: new Date() } })
}
