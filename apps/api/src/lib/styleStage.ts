import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * A style made for sampling (stage DEVELOPMENT) exists before anybody knows
 * whether the buyer will approve it. Its colours, size run and even its name
 * can still change, and it has no approved BOM or costing. So nothing that
 * commits the mill to making or selling it may use it until its sample is
 * approved and handed over, which is the only thing that makes it PRODUCTION.
 *
 * Every place that turns a style into an order, a BOM, a route, a production
 * order, finished stock or a garment tag asks here, so the refusal reads the
 * same wherever somebody meets it. Sampling itself never does.
 */
export const STYLE_IN_DEVELOPMENT = 'STYLE_IN_DEVELOPMENT'

// Says what cannot happen, not "hand the sample over first": that handover
// itself needs a production BOM, which this refusal is what stops.
export function styleInDevelopment(code: string): AppError {
  return new AppError(
    `${code} is still in sampling, so it cannot have a BOM, route or order yet.`,
    409,
    STYLE_IN_DEVELOPMENT,
  )
}

/** Refuses when any of these styles is still in sampling. Missing ids are the caller's own check. */
export async function assertStylesInProduction(
  db: Prisma.TransactionClient,
  styleIds: Array<string | null | undefined>,
): Promise<void> {
  const ids = [...new Set(styleIds.filter((x): x is string => !!x))]
  if (!ids.length) return
  const sampling = await db.style.findFirst({
    where: { id: { in: ids }, stage: 'DEVELOPMENT' },
    select: { code: true },
  })
  if (sampling) throw styleInDevelopment(sampling.code)
}
