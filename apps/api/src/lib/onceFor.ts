import { Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'

/**
 * Runs a stock-changing request once for the id its screen sent with it.
 *
 * A scanner's trailing Enter, a double tap, or a phone retrying on a weak
 * signal sends the same request again. The id is written first, inside the
 * request's own transaction, into a table where it is the primary key:
 *
 *   - the first copy writes it, does the work, and stores its answer;
 *   - a copy arriving at the same moment waits on that key until the first
 *     finishes, then finds it and gets the stored answer — no second movement;
 *   - if the first fails and rolls back, its key goes with it, so a genuine
 *     retry after an error is free to run.
 *
 * Without an id the work simply runs, as every request did before.
 */
export async function onceFor<T extends Prisma.InputJsonValue>(
  tx: Prisma.TransactionClient,
  requestId: string | null | undefined,
  kind: string,
  userId: string | null,
  run: () => Promise<T>,
): Promise<{ result: T; repeat: boolean }> {
  if (!requestId) return { result: await run(), repeat: false }
  const wrote = await tx.$executeRaw`
    INSERT INTO ld_erp.stock_requests (id, kind, "userId") VALUES (${requestId}, ${kind}, ${userId})
    ON CONFLICT (id) DO NOTHING`
  if (wrote === 0) {
    const first = await tx.stockRequest.findUnique({ where: { id: requestId } })
    if (!first || first.kind !== kind) {
      throw new AppError('That request id was already used for something else. Reload the screen and try again.', 409, 'REQUEST_ID_REUSED')
    }
    return { result: first.result as T, repeat: true }
  }
  const result = await run()
  await tx.stockRequest.update({ where: { id: requestId }, data: { result } })
  return { result, repeat: false }
}
