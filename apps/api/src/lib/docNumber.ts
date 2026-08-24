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
/**
 * Rule 46(b) of the CGST Rules caps an invoice number at sixteen characters and
 * allows only letters, numerals, hyphen and slash. Nothing else — no full stop,
 * no underscore, no space. The same limit is applied to every document type so
 * one habit covers all of them.
 */
export const MAX_DOC_NUMBER_LENGTH = 16
export const DOC_NUMBER_ALLOWED = /^[A-Za-z0-9/-]*$/

/** The Indian financial year a date falls in, as the short token, e.g. 2627. */
export function financialYearOf(date: Date, startMonth = 4): string {
  const startYear = date.getMonth() + 1 >= startMonth ? date.getFullYear() : date.getFullYear() - 1
  return `${String(startYear).slice(2)}${String(startYear + 1).slice(2)}`
}

/** "2026-27" and "2627" mean the same year; compare them on a common footing. */
function normaliseFy(fy: string): string {
  const long = fy.match(/^(\d{4})-(\d{2})$/)
  return long ? `${long[1].slice(2)}${long[2]}` : fy
}

export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  docType: string,
  /** The date on the document. A back-dated one belongs to its own year's series. */
  documentDate: Date = new Date(),
): Promise<string> {
  const company = await tx.company.findFirst({
    select: { id: true, currentFY: true, fyStartMonth: true },
  })
  if (!company) {
    throw new AppError('Company profile is not set up yet', 409, 'NO_COMPANY')
  }

  const wantedFy = financialYearOf(documentDate, company.fyStartMonth ?? 4)

  const candidates = await tx.numberSeries.findMany({
    where: { companyId: company.id, docType, isActive: true },
  })

  if (candidates.length === 0) {
    throw new AppError(
      `No numbering is set up for ${docType}. Add one in Settings → Company → Document numbering.`,
      409,
      'NO_NUMBER_SERIES',
    )
  }

  // Match the document's own financial year. Sorting by the stored string used
  // to decide this, which broke as soon as "2026-27" and "2627" were mixed:
  // lexically "2026-27" ranks below "2526", so the older series silently won.
  const series =
    candidates.find((c) => normaliseFy(c.financialYear) === wantedFy) ??
    candidates.find((c) => normaliseFy(c.financialYear) === normaliseFy(company.currentFY ?? '')) ??
    [...candidates].sort((a, b) => normaliseFy(b.financialYear).localeCompare(normaliseFy(a.financialYear)))[0]

  const updated = await tx.numberSeries.update({
    where: { id: series.id },
    data: { lastNumber: { increment: 1 } },
    select: { prefix: true, separator: true, financialYear: true, lastNumber: true, padding: true },
  })

  const number = formatDocumentNumber(updated)

  // Refusing here is better than issuing a number that a GST officer can
  // reject. The settings screen validates the same rule when the series is
  // saved, so this should never fire in practice.
  if (number.length > MAX_DOC_NUMBER_LENGTH) {
    throw new AppError(
      `"${number}" is ${number.length} characters. A document number may not exceed ${MAX_DOC_NUMBER_LENGTH}. Shorten the prefix in Settings → Company → Document numbering.`,
      409,
      'DOC_NUMBER_TOO_LONG',
    )
  }
  if (!DOC_NUMBER_ALLOWED.test(number)) {
    throw new AppError(
      `"${number}" contains a character that is not allowed. Only letters, numbers, hyphen and slash may appear in a document number.`,
      409,
      'DOC_NUMBER_INVALID',
    )
  }

  return number
}

/** Builds the printed number from a series. Shared with the settings preview. */
export function formatDocumentNumber(series: {
  prefix: string
  separator: string
  financialYear: string
  lastNumber: number
  padding: number
}): string {
  return [
    series.prefix,
    series.financialYear,
    String(series.lastNumber).padStart(series.padding, '0'),
  ].join(series.separator)
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
