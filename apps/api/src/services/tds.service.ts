import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

type Db = PrismaClient | Prisma.TransactionClient

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The financial year a date falls in: 1 April to 31 March.
 *
 * TDS limits are counted per payee per financial year, so "this year so far"
 * means since the last 1 April, not since 1 January.
 */
export function financialYear(date: Date): { start: Date; end: Date; label: string } {
  const y = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1
  return {
    start: new Date(y, 3, 1),
    end: new Date(y + 1, 3, 1),
    label: `${y}-${String((y + 1) % 100).padStart(2, '0')}`,
  }
}

/** One section's terms as they stood on a date. */
export interface TdsTerms {
  sectionId: string
  section: string
  label: string
  /** The ordinary rate. */
  rate: number
  /** The rate when the payee has no PAN, if accounts has set one. */
  noPanRate: number | null
  singleLimit: number | null
  yearlyLimit: number | null
  /** The day these terms started. */
  effectiveFrom: Date | null
}

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? null : Number(v))

/**
 * Picks the terms in force on `date` out of a section's history.
 *
 * The latest row starting on or before the date. A date before the first row
 * takes the first row — a bill dated before anybody recorded the history is
 * still better priced at the oldest known rate than at none — and a section
 * with no history at all falls back to the rate on the section itself.
 */
export function termsOn(
  section: {
    id: string
    section: string
    label: string
    rate: Prisma.Decimal | number
    rates?: Array<{
      effectiveFrom: Date
      rate: Prisma.Decimal | number
      noPanRate: Prisma.Decimal | number | null
      singleLimit: Prisma.Decimal | number | null
      yearlyLimit: Prisma.Decimal | number | null
    }>
  },
  date: Date
): TdsTerms {
  const history = [...(section.rates ?? [])].sort(
    (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime()
  )
  const inForce =
    [...history].reverse().find((r) => r.effectiveFrom.getTime() <= date.getTime()) ?? history[0]

  return {
    sectionId: section.id,
    section: section.section,
    label: section.label,
    rate: Number(inForce?.rate ?? section.rate),
    noPanRate: num(inForce?.noPanRate),
    singleLimit: num(inForce?.singleLimit),
    yearlyLimit: num(inForce?.yearlyLimit),
    effectiveFrom: inForce?.effectiveFrom ?? null,
  }
}

/** The section and its terms on a date, or a clear refusal. */
export async function sectionTermsOn(db: Db, sectionId: string, date: Date): Promise<TdsTerms> {
  const section = await db.tdsSection.findUnique({
    where: { id: sectionId },
    include: { rates: true },
  })
  if (!section) throw new AppError('That TDS section no longer exists', 400, 'BAD_TDS_SECTION')
  return termsOn(section, date)
}

/**
 * The rate to deduct at: the no-PAN rate when the payee has given no PAN and
 * accounts has set one, the ordinary rate otherwise.
 */
export const rateFor = (terms: TdsTerms, payeeHasPan: boolean) =>
  !payeeHasPan && terms.noPanRate != null ? terms.noPanRate : terms.rate

/**
 * TDS on a taxable value, to the rupee.
 *
 * Worked on the value before GST, and rounded to the nearest rupee as tax
 * deducted is — the old ERP showed ₹282 on ₹28,154 at 1%, not ₹281.54.
 */
export const tdsOn = (taxable: number, rate: number) => Math.round((taxable * rate) / 100)

/**
 * What has been billed by this supplier so far this financial year, for the
 * limit check on an expense bill.
 *
 * Counts every live bill of theirs that is either under this section or is an
 * expense bill (nothing received against it) — a contractor's bills below the
 * limit carry no section at all, and leaving them out would keep the yearly
 * total under the limit forever. Value before GST, as the limits are.
 */
export async function billedThisYear(
  db: Db,
  opts: { supplierId: string; sectionId?: string | null; date: Date; excludeBillId?: string | null }
): Promise<{ taxable: number; bills: number; year: string }> {
  const fy = financialYear(opts.date)
  const where: Prisma.PurchaseInvoiceWhereInput = {
    supplierId: opts.supplierId,
    status: { not: 'CANCELLED' },
    billDate: { gte: fy.start, lt: fy.end },
    ...(opts.excludeBillId ? { id: { not: opts.excludeBillId } } : {}),
    OR: [
      ...(opts.sectionId ? [{ tdsSectionId: opts.sectionId }] : []),
      { lines: { none: { grnLineId: { not: null } } } },
    ],
  }
  const agg = await db.purchaseInvoice.aggregate({
    where,
    _sum: { taxableAmount: true },
    _count: { _all: true },
  })
  return {
    taxable: round2(Number(agg._sum.taxableAmount ?? 0)),
    bills: agg._count._all,
    year: fy.label,
  }
}
