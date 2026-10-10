import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * Called by the sales order route when an order is saved from a quotation:
 * the quotation is won, and points at the order. Refused when the quotation
 * is for someone else or already decided.
 */
export async function winQuote(tx: Prisma.TransactionClient, quotationId: string, customerId: string) {
  const quote = await tx.salesQuotation.findUnique({ where: { id: quotationId }, select: { quoteNumber: true, status: true, customerId: true } })
  if (!quote) throw new AppError('That quotation does not exist', 400, 'BAD_QUOTE')
  if (quote.customerId !== customerId) throw new AppError(`${quote.quoteNumber} is another customer's quotation`, 400, 'WRONG_CUSTOMER')
  if (quote.status === 'LOST') throw new AppError(`${quote.quoteNumber} was marked lost`, 409, 'QUOTE_LOST')
  if (quote.status !== 'WON') await tx.salesQuotation.update({ where: { id: quotationId }, data: { status: 'WON', decidedAt: new Date() } })
}

