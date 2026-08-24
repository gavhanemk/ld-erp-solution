import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import type { Prisma } from '@prisma/client'

/**
 * Allocates the next document number for a document type.
 *
 * The counter is bumped with an atomic `increment` inside the caller's
 * transaction, so two people saving an order at the same moment cannot be
 * handed the same number. The previous implementation built the number from
 * `Math.random()`, which could collide and ignored the series the user had
 * configured in Settings entirely.
 */
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  docType: string,
): Promise<string> {
  const company = await tx.company.findFirst({ select: { id: true, currentFY: true } })
  if (!company) {
    throw new AppError('Company profile is not set up yet', 409, 'NO_COMPANY')
  }

  const series = await tx.numberSeries.findFirst({
    where: { companyId: company.id, docType, isActive: true },
    // Where a series exists for more than one year, the newest one wins.
    orderBy: { financialYear: 'desc' },
  })

  if (!series) {
    throw new AppError(
      `No numbering is set up for ${docType}. Add one in Settings → Company → Document numbering.`,
      409,
      'NO_NUMBER_SERIES',
    )
  }

  const updated = await tx.numberSeries.update({
    where: { id: series.id },
    data: { lastNumber: { increment: 1 } },
    select: { prefix: true, separator: true, financialYear: true, lastNumber: true, padding: true },
  })

  return [
    updated.prefix,
    updated.financialYear,
    String(updated.lastNumber).padStart(updated.padding, '0'),
  ].join(updated.separator)
}

/**
 * Works out whether a sale is inside the state or across it.
 *
 * Place of supply is decided by the two-digit GST state code, never by the
 * state name. Comparing names against a code — which is what this used to do
 * against a `COMPANY_STATE_CODE=GJ` environment variable — never matched, so
 * every sale was taxed as IGST including local ones.
 */
export async function resolvePlaceOfSupply(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<{ companyStateCode: string; placeOfSupplyCode: string; isIntraState: boolean }> {
  const [company, customer] = await Promise.all([
    tx.company.findFirst({ select: { stateCode: true, gstin: true } }),
    tx.customer.findUnique({
      where: { id: customerId },
      select: { billingStateCode: true, shippingStateCode: true, gstin: true, name: true },
    }),
  ])

  if (!customer) throw new AppError('Customer not found', 404, 'NOT_FOUND')

  // The GSTIN's first two digits are the state code, so it is a reliable
  // fallback while the dedicated columns are still being filled in.
  const companyState = company?.stateCode || company?.gstin?.slice(0, 2)
  if (!companyState) {
    throw new AppError(
      'Your company GST state code is not set. Add it in Settings → Company, or the tax on every invoice will be wrong.',
      409,
      'NO_COMPANY_STATE',
    )
  }

  // Goods are taxed where they are delivered, so shipping wins over billing.
  const placeOfSupply =
    customer.shippingStateCode || customer.billingStateCode || customer.gstin?.slice(0, 2)

  if (!placeOfSupply) {
    throw new AppError(
      `No GST state code on ${customer.name}. Set it on the customer, or the tax split cannot be decided.`,
      409,
      'NO_PLACE_OF_SUPPLY',
    )
  }

  return {
    companyStateCode: companyState,
    placeOfSupplyCode: placeOfSupply,
    isIntraState: companyState === placeOfSupply,
  }
}

/** Rounds a bill to the nearest rupee, returning the adjustment applied. */
export function applyRoundOff(total: number): { rounded: number; roundOff: number } {
  const rounded = Math.round(total)
  return { rounded, roundOff: Number((rounded - total).toFixed(2)) }
}
