import { prisma } from '@ld-erp/database'
import { logger } from '../utils/logger'
import type { AuthRequest } from '../middleware/auth'

/**
 * Writes one row to the audit trail.
 *
 * Auditing must never take down the request that triggered it, so failures are
 * logged and swallowed rather than thrown — a lost audit row is bad, a failed
 * customer update because of a lost audit row is worse.
 */
export async function writeAuditLog(
  req: AuthRequest,
  entry: {
    module: string
    action: 'CREATE' | 'UPDATE' | 'DELETE' | 'APPROVE' | 'REJECT' | 'EXPORT'
    entityType: string
    entityId: string
    before?: unknown
    after?: unknown
  },
): Promise<void> {
  if (!req.user) return

  try {
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        module: entry.module,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: toJson(entry.before),
        after: toJson(entry.after),
        ipAddress: req.ip ?? null,
      },
    })
  } catch (err) {
    logger.error(
      `Audit write failed for ${entry.entityType}:${entry.entityId} — ${(err as Error).message}`,
    )
  }
}

/**
 * Prisma's Json column rejects `undefined` and cannot serialise the Decimal and
 * Date instances that fill the master models. Both define toJSON, so a JSON
 * round-trip normalises them; BigInt does not, hence the explicit replacer.
 */
function toJson(value: unknown): object | undefined {
  if (value === undefined || value === null) return undefined
  return JSON.parse(
    JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? val.toString() : val)),
  )
}
