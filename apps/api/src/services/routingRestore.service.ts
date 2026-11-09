import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { createRoutingSchema } from '../schemas/master.schemas'
import { createRouting, routingInclude } from './routing.service'

type Db = PrismaClient | Prisma.TransactionClient
type Tx = Prisma.TransactionClient

/**
 * Deleted routings, and bringing one back.
 *
 * Deleting a routing removes it and its steps for good, but the audit log
 * keeps the whole of it as it stood (DELETE, Routing, `before`: the routing
 * with its steps, lines and contractors). This reads those back, and makes a
 * routing again from one: the same name, code (when free), style or
 * category, fabric, notes and steps, with its version and its dates as they
 * were — so it takes its old place, and does not become the routing new
 * orders are offered just for being brought back. A restore is written to
 * the audit log as RESTORE against the old id, so it is offered once.
 */

interface SnapStep {
  sequence: number
  operationId: string
  departmentId: string
  workstationId: string | null
  contractorId?: string | null
  smv: string | number | null
  ratePerPiece: string | number | null
  isQcStep: boolean
  execution: 'IN_HOUSE' | 'OUTSOURCED'
  skip: 'OPTIONAL' | 'WITH_APPROVAL' | 'NEVER'
  instructions: string | null
  operation?: { name: string } | null
}

interface Snapshot {
  id: string
  code: string
  name: string
  styleId: string | null
  category: string | null
  fabricItemId: string | null
  notes: string | null
  isActive: boolean
  version: number
  createdAt: string
  updatedAt: string
  createdBy?: { id: string; name: string } | null
  updatedBy?: { id: string; name: string } | null
  style?: { code: string; name: string } | null
  fabric?: { name: string } | null
  steps: SnapStep[]
}

const num = (v: string | number | null | undefined) => (v == null || v === '' ? null : Number(v))

/** The routings deleted and not brought back, newest first. */
export async function deletedRoutings(db: Db) {
  const [deletes, restores] = await Promise.all([
    db.auditLog.findMany({
      where: { entityType: 'Routing', action: 'DELETE' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, entityId: true, before: true, createdAt: true, user: { select: { name: true } } },
    }),
    db.auditLog.findMany({ where: { entityType: 'Routing', action: 'RESTORE' }, select: { entityId: true } }),
  ])
  const back = new Set(restores.map((r) => r.entityId))
  return deletes
    .filter((d) => d.before && !back.has(d.entityId))
    .map((d) => {
      const r = d.before as unknown as Snapshot
      const steps = [...(r.steps ?? [])].sort((a, b) => a.sequence - b.sequence)
      return {
        auditId: d.id,
        routingId: d.entityId,
        name: r.name,
        code: r.code,
        version: r.version,
        style: r.style ? { code: r.style.code, name: r.style.name } : null,
        category: r.category,
        fabric: r.fabric?.name ?? null,
        steps: steps.map((s) => s.operation?.name ?? 'Process'),
        deletedAt: d.createdAt,
        deletedBy: d.user?.name ?? null,
      }
    })
}

/** Makes a deleted routing again from its copy in the audit log. */
export async function restoreRouting(tx: Tx, auditId: string, userId: string) {
  const entry = await tx.auditLog.findUnique({ where: { id: auditId }, select: { entityType: true, action: true, entityId: true, before: true } })
  if (!entry || entry.entityType !== 'Routing' || entry.action !== 'DELETE' || !entry.before) {
    throw new AppError('That deleted routing is not on record.', 404, 'NOT_FOUND')
  }
  const again = await tx.auditLog.findFirst({ where: { entityType: 'Routing', action: 'RESTORE', entityId: entry.entityId }, select: { id: true } })
  if (again) throw new AppError('That routing has been brought back already.', 409, 'ALREADY_RESTORED')
  const r = entry.before as unknown as Snapshot

  if (r.styleId && !(await tx.style.findUnique({ where: { id: r.styleId }, select: { id: true } }))) {
    throw new AppError(`${r.name} was for style ${r.style?.code ?? ''}, which no longer exists, so it cannot come back.`, 409, 'STYLE_GONE')
  }
  // A line, contractor or fabric removed since is left off; the rest comes back as it was.
  const steps = [...r.steps].sort((a, b) => a.sequence - b.sequence)
  const [units, contractors, fabric, codeTaken] = await Promise.all([
    tx.workstation.findMany({ where: { id: { in: steps.map((s) => s.workstationId).filter((x): x is string => !!x) } }, select: { id: true } }),
    tx.contractor.findMany({ where: { id: { in: steps.map((s) => s.contractorId).filter((x): x is string => !!x) } }, select: { id: true } }),
    r.fabricItemId ? tx.item.findUnique({ where: { id: r.fabricItemId }, select: { id: true } }) : Promise.resolve(null),
    tx.routing.findUnique({ where: { code: r.code }, select: { id: true } }),
  ])
  const unitIds = new Set(units.map((u) => u.id))
  const contractorIds = new Set(contractors.map((c) => c.id))

  const data = createRoutingSchema.parse({
    code: codeTaken ? undefined : r.code,
    name: r.name,
    styleId: r.styleId,
    category: r.styleId ? null : r.category,
    fabricItemId: fabric?.id ?? null,
    notes: r.notes,
    isActive: r.isActive,
    steps: steps.map((s, i) => ({
      sequence: i + 1,
      operationId: s.operationId,
      departmentId: s.departmentId,
      workstationId: s.workstationId && unitIds.has(s.workstationId) ? s.workstationId : null,
      contractorId: s.contractorId && contractorIds.has(s.contractorId) ? s.contractorId : null,
      smv: num(s.smv),
      ratePerPiece: num(s.ratePerPiece),
      isQcStep: s.isQcStep,
      execution: s.execution,
      skip: s.skip,
      instructions: s.instructions,
    })),
  })
  const { routing } = await createRouting(tx, data, userId)
  // Its version and dates as they were, so it takes its old place among the style's routings.
  const restored = await tx.routing.update({
    where: { id: routing.id },
    data: {
      version: r.version,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt),
      createdById: r.createdBy?.id ?? userId,
      updatedById: r.updatedBy?.id ?? r.createdBy?.id ?? userId,
    },
    include: routingInclude,
  })
  // Marked as brought back in the same transaction, so it is never brought back twice.
  await tx.auditLog.create({
    data: { userId, module: 'masters', action: 'RESTORE', entityType: 'Routing', entityId: entry.entityId, after: { id: restored.id, code: restored.code, name: restored.name } },
  })
  const dropped = steps.filter((s) => (s.workstationId && !unitIds.has(s.workstationId)) || (s.contractorId && !contractorIds.has(s.contractorId))).length
  return {
    oldId: entry.entityId,
    routing: restored,
    message: `${restored.name} is back${codeTaken ? ` as ${restored.code}` : ''}, with its ${restored.steps.length} steps.${
      dropped ? ` ${dropped === 1 ? 'One step' : `${dropped} steps`} lost a line or contractor removed since; set them again.` : ''
    }${r.fabricItemId && !fabric ? ' Its fabric was removed since, so it has none.' : ''}`,
  }
}
