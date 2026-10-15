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
export interface AuditEntry {
  module: string
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'APPROVE' | 'REJECT' | 'EXPORT'
  entityType: string
  entityId: string
  before?: unknown
  after?: unknown
}

export async function writeAuditLog(req: AuthRequest, entry: AuditEntry): Promise<void> {
  if (!req.user) return
  await recordAudit(req.user.id, req.ip ?? null, entry)
}

/**
 * The same row, for code that has a person but not a request.
 *
 * The assistant writes through here. The user id on the row is the person who
 * confirmed the change, never the assistant — because that is who decided it.
 * What the assistant adds is a note in `after` saying the change came through
 * the chat, so a trail somebody reads next year says how as well as what.
 */
export async function recordAudit(
  userId: string,
  ipAddress: string | null,
  entry: AuditEntry,
): Promise<void> {
  const write = () =>
    prisma.auditLog.create({
      data: {
        userId,
        module: entry.module,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: toJson(entry.before),
        after: toJson(entry.after),
        ipAddress,
      },
    })
  try {
    await write()
  } catch (first) {
    // A dropped connection is the usual cause: one more try a moment later.
    try {
      await new Promise((r) => setTimeout(r, 500))
      await write()
      return
    } catch (err) {
      logger.error(
        `Audit write failed for ${entry.entityType}:${entry.entityId} — ${(err as Error).message} (first try: ${(first as Error).message})`,
      )
      await tellAdmins(entry, (err as Error).message)
    }
  }
}

/**
 * A change that went through with no audit row is something an administrator
 * should hear about, not only the server log: a bell notification to each,
 * naming the record, so it can be looked at while people still remember it.
 */
async function tellAdmins(entry: AuditEntry, why: string) {
  try {
    const admins = await prisma.user.findMany({ where: { role: { name: 'Admin' }, status: 'ACTIVE' }, select: { id: true } })
    if (!admins.length) return
    await prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        channel: 'IN_APP' as const,
        type: 'AUDIT_MISSED',
        title: 'A change was not written to the audit trail',
        message: `${entry.action.toLowerCase()} of ${entry.entityType} ${entry.entityId} (${entry.module}) was saved, but its audit entry could not be: ${why.slice(0, 200)}`,
        metadata: { module: entry.module, entityType: entry.entityType, entityId: entry.entityId },
      })),
    })
  } catch (err) {
    logger.error(`Could not tell the admins about a missed audit entry — ${(err as Error).message}`)
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
