import type { Prisma, PrismaClient } from '@prisma/client'
import type { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { checkRouteSteps } from './route.service'
import type { createRoutingSchema, routingStepSchema, updateRoutingSchema } from '../schemas/master.schemas'

/**
 * The routing master: making, changing and deleting a routing, behind Masters
 * → Routings. The handlers in master.routes only parse, audit and answer; the
 * rules live here, so tools/check-routing-master.ts can run them on the shared
 * database and roll back.
 *
 * Since 15 Oct 2026 nobody types a routing's code — it is made from the style
 * (RT-<style code>) — and a routing names the fabric it is cut from, picked
 * from the fabric items in stock. Every save records who made it.
 */

type Db = PrismaClient | Prisma.TransactionClient
type Tx = Prisma.TransactionClient
type CreateRouting = z.infer<typeof createRoutingSchema>
type UpdateRouting = z.infer<typeof updateRoutingSchema>
type StepInput = z.infer<typeof routingStepSchema>

const person = { select: { id: true, name: true } } as const

export const routingInclude = {
  style: { select: { id: true, code: true, name: true } },
  fabric: { select: { id: true, code: true, name: true, uom: { select: { symbol: true } } } },
  createdBy: person,
  updatedBy: person,
  steps: {
    orderBy: { sequence: 'asc' as const },
    include: {
      operation: { select: { id: true, name: true, code: true, kind: true } },
      department: { select: { id: true, name: true } },
      workstation: { select: { id: true, name: true, type: true } },
      contractor: { select: { id: true, name: true } },
    },
  },
  _count: { select: { mos: true, boms: true } },
} satisfies Prisma.RoutingInclude

// ─── Fabric ───────────────────────────────────────────────────

/**
 * Fabric is what is filed under a category named for it, or under one of its
 * sub-categories (Fabric → Cotton). The same rule the cutting and job-card
 * screens use to tell cloth from trims.
 */
export const fabricItemWhere = {
  OR: [
    { category: { name: { contains: 'fabric', mode: 'insensitive' } } },
    { category: { parent: { name: { contains: 'fabric', mode: 'insensitive' } } } },
  ],
} satisfies Prisma.ItemWhereInput

export interface FabricOption {
  id: string
  code: string
  name: string
  uom: string
  /** Ours, in every store together — the figure the Stock screen shows. */
  onHand: number
  /** Customers' cloth in our godown for job work. Not ours, so apart. */
  customers: number
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * The fabrics the routing form offers: every fabric item that has stock
 * records, with what is on hand now, those with stock first. Read from the
 * stock ledger, as Inventory → Stock is, so the two never disagree.
 */
export async function fabricStock(db: Db): Promise<FabricOption[]> {
  const rows = await db.$queryRaw<Array<{ id: string; code: string; name: string; uom: string; onHand: number; customers: number }>>`
    SELECT i.id, i.code, i.name, u.symbol AS "uom",
           COALESCE(SUM(s."inQty" - s."outQty") FILTER (WHERE s."ownership" = 'OWNED'), 0)::float8 AS "onHand",
           COALESCE(SUM(s."inQty" - s."outQty") FILTER (WHERE s."ownership" <> 'OWNED'), 0)::float8 AS "customers"
    FROM ld_erp.items i
    JOIN ld_erp.uom u ON u.id = i."uomId"
    JOIN ld_erp.item_categories c ON c.id = i."categoryId"
    LEFT JOIN ld_erp.item_categories p ON p.id = c."parentId"
    JOIN ld_erp.stock_ledger s ON s."itemId" = i.id
    WHERE i."isActive" = true
      AND (c.name ILIKE '%fabric%' OR p.name ILIKE '%fabric%')
    GROUP BY i.id, i.code, i.name, u.symbol`
  return rows
    .map((r) => ({ ...r, onHand: round3(r.onHand), customers: round3(r.customers) }))
    .sort((a, b) => Number(b.onHand + b.customers > 0) - Number(a.onHand + a.customers > 0) || a.name.localeCompare(b.name))
}

/** The item picked as the fabric is one, and still in use — unless the routing has it already. */
async function assertFabric(db: Db, itemId: string, current?: string | null) {
  const item = await db.item.findUnique({ where: { id: itemId }, select: { id: true, name: true, isActive: true } })
  if (!item) throw new AppError('That fabric no longer exists. Pick another.', 400, 'INVALID_FABRIC')
  const isFabric = await db.item.count({ where: { id: itemId, ...fabricItemWhere } })
  if (!isFabric) throw new AppError(`${item.name} is not a fabric. Pick one filed under Fabric in the item master.`, 400, 'NOT_A_FABRIC')
  if (!item.isActive && itemId !== current) throw new AppError(`${item.name} is no longer in use. Pick another fabric.`, 400, 'FABRIC_INACTIVE')
}

// ─── The code ─────────────────────────────────────────────────

/** Letters, numbers, dot, dash and slash: what a master code may hold. */
const codePart = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9./-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')

/**
 * The code a routing is given: RT- and its style's code, its category, or ANY
 * — with -2, -3 when the style has more than one. Codes are 30 characters at
 * most, so a long style code is cut to leave room for the number.
 */
export async function routingCode(db: Db, target: { styleId: string | null; category: string | null }, exceptId?: string) {
  let what = 'ANY'
  if (target.styleId) {
    const style = await db.style.findUnique({ where: { id: target.styleId }, select: { code: true } })
    what = style?.code ?? 'STYLE'
  } else if (target.category) {
    what = target.category
  }
  const base = `RT-${codePart(what) || 'ROUTING'}`.slice(0, 26).replace(/-$/, '')
  const taken = new Set(
    (await db.routing.findMany({ where: { code: { startsWith: base }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { code: true } })).map((r) => r.code),
  )
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

// ─── Steps ────────────────────────────────────────────────────

/** A step as saved: what the database takes. */
const stepRow = (s: StepInput) => ({
  sequence: s.sequence,
  operationId: s.operationId,
  departmentId: s.departmentId,
  workstationId: s.workstationId ?? null,
  contractorId: s.contractorId ?? null,
  smv: s.smv ?? null,
  ratePerPiece: s.ratePerPiece ?? null,
  isQcStep: s.isQcStep,
  execution: s.execution,
  skip: s.skip,
  instructions: s.instructions?.trim() || null,
})

/** The steps as a comparable string, so a save that changes nothing keeps the version. */
const stepsSignature = (steps: Array<ReturnType<typeof stepRow>>) =>
  JSON.stringify(
    [...steps]
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => [s.operationId, s.departmentId, s.workstationId, s.smv == null ? null : Number(s.smv), s.ratePerPiece == null ? null : Number(s.ratePerPiece), s.isQcStep, s.execution, s.skip, s.instructions, s.contractorId ?? null]),
  )

const ordered = <T extends { sequence: number }>(steps: T[]) => [...steps].sort((a, b) => a.sequence - b.sequence)

/**
 * Prisma would reject a bad id with a foreign-key error that means nothing to
 * the person filling in the form, so the references are checked up front.
 */
/**
 * A step's contractor must still be there and must do that step's process:
 * a stitching contractor is not picked for cutting.
 */
async function assertContractorsFit(db: Db, steps: Array<{ operationId: string; contractorId?: string | null }>): Promise<void> {
  const ids = [...new Set(steps.map((s) => s.contractorId).filter(Boolean))] as string[]
  if (!ids.length) return
  const found = await db.contractor.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, operationId: true, operation: { select: { name: true } } } })
  const byId = new Map(found.map((c) => [c.id, c]))
  steps.forEach((step, i) => {
    if (!step.contractorId) return
    const c = byId.get(step.contractorId)
    if (!c) throw new AppError(`Step ${i + 1}: that contractor is no longer in the Routing Masters.`, 400, 'INVALID_CONTRACTOR')
    if (c.operationId !== step.operationId) {
      throw new AppError(`Step ${i + 1}: ${c.name} does ${c.operation.name}, not this step's process. Pick one of its own contractors, or leave it empty.`, 400, 'STEP_CONTRACTOR_MISMATCH')
    }
  })
}

async function assertRoutingRefsExist(
  db: Db,
  steps: Array<{ operationId: string; departmentId: string; workstationId?: string | null; contractorId?: string | null }>,
  styleId: string | null,
): Promise<void> {
  await assertContractorsFit(db, steps)
  if (styleId) {
    const style = await db.style.findUnique({ where: { id: styleId }, select: { id: true } })
    if (!style) throw new AppError('That style no longer exists', 400, 'INVALID_STYLE')
  }

  const operationIds = [...new Set(steps.map((s) => s.operationId))]
  const departmentIds = [...new Set(steps.map((s) => s.departmentId))]
  const workstationIds = [...new Set(steps.map((s) => s.workstationId).filter(Boolean))] as string[]

  const [operations, departments, workstations] = await Promise.all([
    db.operation.findMany({
      where: { id: { in: operationIds } },
      select: { id: true, name: true, departmentId: true },
    }),
    db.department.findMany({ where: { id: { in: departmentIds } }, select: { id: true, name: true } }),
    workstationIds.length
      ? db.workstation.findMany({
          where: { id: { in: workstationIds } },
          select: { id: true, name: true, departmentId: true },
        })
      : Promise.resolve([]),
  ])

  if (operations.length !== operationIds.length) {
    throw new AppError('One of the operations no longer exists', 400, 'INVALID_OPERATION')
  }
  if (departments.length !== departmentIds.length) {
    throw new AppError('One of the departments no longer exists', 400, 'INVALID_DEPARTMENT')
  }
  if (workstations.length !== workstationIds.length) {
    throw new AppError('One of the workstations no longer exists', 400, 'INVALID_WORKSTATION')
  }

  // A step is done by one department, with that department's operation on
  // that department's machine. A cutting operation booked to Accounts, on a
  // stitching workstation, used to save, and the floor's piece-rates and
  // loading were then worked out against the wrong department.
  // Names for every department involved, the operations' and workstations'
  // own as well as the steps', so a message can say which one it should be.
  const involved = [...new Set([...operations.map((o) => o.departmentId), ...workstations.map((w) => w.departmentId)])]
  const named = await db.department.findMany({ where: { id: { in: involved } }, select: { id: true, name: true } })
  const deptName = new Map([...departments, ...named].map((d) => [d.id, d.name]))
  const op = new Map(operations.map((o) => [o.id, o]))
  const ws = new Map(workstations.map((w) => [w.id, w]))
  steps.forEach((step, i) => {
    const here = deptName.get(step.departmentId) ?? 'this department'
    const o = op.get(step.operationId)!
    if (o.departmentId !== step.departmentId) {
      throw new AppError(
        `Step ${i + 1}: ${o.name} is a ${deptName.get(o.departmentId) ?? 'different department'} operation, not ${here}. Pick the department it belongs to, or another operation.`,
        400,
        'STEP_DEPARTMENT_MISMATCH',
      )
    }
    const w = step.workstationId ? ws.get(step.workstationId) : undefined
    if (w && w.departmentId !== step.departmentId) {
      throw new AppError(
        `Step ${i + 1}: ${w.name} is not a ${here} workstation. Pick one of ${here}'s, or leave it empty.`,
        400,
        'STEP_WORKSTATION_MISMATCH',
      )
    }
  })
}

// ─── Make, change, delete ─────────────────────────────────────

export async function createRouting(tx: Tx, data: CreateRouting, userId: string) {
  const styleId = data.styleId || null
  const category = styleId ? null : data.category?.trim() || null
  await assertRoutingRefsExist(tx, data.steps, styleId)
  if (data.fabricItemId) await assertFabric(tx, data.fabricItemId)
  const warnings = await checkRouteSteps(tx, ordered(data.steps))

  const routing = await tx.routing.create({
    data: {
      code: data.code || (await routingCode(tx, { styleId, category })),
      name: data.name,
      styleId,
      category,
      fabricItemId: data.fabricItemId || null,
      notes: data.notes ?? null,
      isActive: data.isActive ?? true,
      createdById: userId,
      updatedById: userId,
      steps: { create: data.steps.map(stepRow) },
    },
    include: routingInclude,
  })
  return { routing, message: [`${routing.name} saved.`, ...warnings].join(' ') }
}

export async function updateRouting(tx: Tx, id: string, data: UpdateRouting, userId: string) {
  const before = await tx.routing.findUnique({ where: { id }, include: routingInclude })
  if (!before) throw new AppError('Routing not found', 404, 'NOT_FOUND')

  // A locked routing has orders running against it; changing the steps midway
  // would silently rewrite how work already in progress is supposed to flow.
  if (before.isLocked && data.steps) {
    throw new AppError('This routing is locked because orders are running against it. Unlock it first.', 400, 'ROUTING_LOCKED')
  }

  // Style or category: setting one clears the other.
  const styleId = data.styleId !== undefined ? data.styleId || null : data.category?.trim() ? null : before.styleId
  const category = styleId ? null : data.category !== undefined ? data.category?.trim() || null : before.category
  let warnings: string[] = []
  if (data.steps) {
    await assertRoutingRefsExist(tx, data.steps, styleId)
    warnings = await checkRouteSteps(tx, ordered(data.steps))
  } else if (styleId && styleId !== before.styleId) {
    await assertRoutingRefsExist(tx, [], styleId)
  }
  if (data.fabricItemId && data.fabricItemId !== before.fabricItemId) await assertFabric(tx, data.fabricItemId, before.fabricItemId)
  // Orders keep the steps they were given; a new version is what new orders get.
  const changed =
    !!data.steps &&
    stepsSignature(data.steps.map(stepRow)) !==
      stepsSignature(before.steps.map((s) => ({ ...s, smv: s.smv == null ? null : Number(s.smv), ratePerPiece: s.ratePerPiece == null ? null : Number(s.ratePerPiece) })))
  // The code follows the style: a routing moved to another style is renamed
  // for it. Orders and BOMs hold the routing itself, not its code.
  const moved = styleId !== before.styleId || (!styleId && (category ?? '').toLowerCase() !== (before.category ?? '').toLowerCase())
  const code = data.code || (moved ? await routingCode(tx, { styleId, category }, before.id) : undefined)

  if (data.steps) {
    await tx.routingStep.deleteMany({ where: { routingId: before.id } })
    await tx.routingStep.createMany({ data: data.steps.map((s) => ({ ...stepRow(s), routingId: before.id })) })
  }
  const routing = await tx.routing.update({
    where: { id: before.id },
    data: {
      ...(code ? { code } : {}),
      ...(data.name ? { name: data.name } : {}),
      styleId,
      category,
      ...(data.fabricItemId !== undefined ? { fabricItemId: data.fabricItemId || null } : {}),
      ...(changed ? { version: { increment: 1 } } : {}),
      ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      ...(data.isLocked !== undefined ? { isLocked: data.isLocked } : {}),
      updatedById: userId,
    },
    include: routingInclude,
  })

  const message = changed
    ? `${routing.name} is now version ${routing.version}. Orders already planned keep the steps they were given.`
    : data.isActive === false && before.isActive
      ? `${routing.name} is no longer offered on new orders. Orders that have its steps keep them.`
      : data.isActive === true && !before.isActive
        ? `${routing.name} is offered on new orders again.`
        : data.isLocked !== undefined && data.isLocked !== before.isLocked
          ? `${routing.name} is ${data.isLocked ? 'locked' : 'unlocked'}.`
          : `${routing.name} saved.`
  return { before, routing, message: [message, ...warnings].join(' ') }
}

/**
 * Deletes a routing nobody has used. One an order or a BOM points at stays —
 * the order tracks against a copy of its steps, and the BOM costs its labour
 * from it — and is stopped instead, which keeps it off new orders.
 */
export async function deleteRouting(tx: Tx, id: string) {
  const before = await tx.routing.findUnique({ where: { id }, include: routingInclude })
  if (!before) throw new AppError('Routing not found', 404, 'NOT_FOUND')
  const uses = [
    before._count.mos ? `${before._count.mos} manufacturing ${before._count.mos === 1 ? 'order' : 'orders'}` : null,
    before._count.boms ? `${before._count.boms} ${before._count.boms === 1 ? 'BOM' : 'BOMs'}` : null,
  ].filter(Boolean)
  if (uses.length) {
    throw new AppError(
      `${before.name} cannot be deleted: ${uses.join(' and ')} ${before._count.mos + before._count.boms === 1 ? 'uses' : 'use'} it. Stop using it instead — they keep it, and new orders no longer get it.`,
      409,
      'ROUTING_IN_USE',
    )
  }
  if (before.isLocked) throw new AppError(`${before.name} is locked. Unlock it first, then delete it.`, 409, 'ROUTING_LOCKED')
  // Its steps go with it; notes made on a style's page keep their own copy of
  // the step's name.
  await tx.routing.delete({ where: { id: before.id } })
  return { before, message: `${before.name} deleted.` }
}
