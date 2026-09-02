import { Router } from 'express'
import type { ZodTypeAny } from 'zod'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from './audit'
import { isGeneratedCode, withGeneratedCode } from './masterCode'

export interface CrudOptions {
  /** Prisma delegate name, e.g. 'customer' for prisma.customer. */
  model: string
  /** Permission module these routes are guarded by, e.g. 'masters'. */
  module: string
  /** Name recorded in the audit trail, e.g. 'Customer'. */
  entityType: string
  createSchema: ZodTypeAny
  updateSchema: ZodTypeAny
  /** String columns matched against ?q= (case-insensitive contains). */
  searchFields?: string[]
  /** Columns accepted in ?sort=; anything else is rejected rather than passed to Prisma. */
  sortableFields?: string[]
  defaultSort?: { field: string; order: 'asc' | 'desc' }
  /** Relations to include on list and detail responses. */
  include?: Record<string, unknown>
  /**
   * Masters are referenced by transactions forever, so deleting one would
   * orphan history. Setting isActive=false is the default; models without the
   * column must opt out.
   */
  softDelete?: boolean
  /**
   * Fields merged into the body before validation when the client did not
   * supply them. Used for owner keys the user should never have to type, such
   * as companyId on a single-entity install.
   */
  injectOnCreate?: () => Promise<Record<string, unknown>>
}

const MAX_PAGE_SIZE = 200

/**
 * Builds the standard master-data REST surface for one model:
 *
 *   GET    /            list with pagination, search, sort and active filter
 *   GET    /:id         single record
 *   POST   /            create
 *   PATCH  /:id         partial update
 *   DELETE /:id         deactivate (or hard delete when softDelete is false)
 *
 * Every write is permission-checked and written to the audit trail.
 */
export function crudRouter(options: CrudOptions): Router {
  const {
    model,
    module,
    entityType,
    createSchema,
    updateSchema,
    searchFields = ['name'],
    sortableFields = ['createdAt', 'name'],
    defaultSort = { field: 'createdAt', order: 'desc' },
    include,
    softDelete = true,
    injectOnCreate,
  } = options

  const router = Router({ mergeParams: true })

  // The factory is generic over 56 models, so the delegate is reached
  // dynamically. Prisma's per-model types cannot be expressed here.
  const delegate = () => (prisma as unknown as Record<string, any>)[model]

  router.get('/', requirePermission(module, 'view'), async (req: AuthRequest, res) => {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || 25))
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

    const sortField = typeof req.query.sort === 'string' ? req.query.sort : defaultSort.field
    if (!sortableFields.includes(sortField)) {
      throw new AppError(
        `Cannot sort by '${sortField}'. Allowed: ${sortableFields.join(', ')}`,
        400,
        'INVALID_SORT',
      )
    }
    const sortOrder = req.query.order === 'asc' ? 'asc' : defaultSort.order

    const where: Record<string, unknown> = {}

    // ?active=true|false filters; omitting it returns both.
    if (req.query.active === 'true') where.isActive = true
    else if (req.query.active === 'false') where.isActive = false

    if (q && searchFields.length > 0) {
      where.OR = searchFields.map((field) => ({
        [field]: { contains: q, mode: 'insensitive' },
      }))
    }

    const [rows, total] = await Promise.all([
      delegate().findMany({
        where,
        include,
        orderBy: { [sortField]: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
      }),
      delegate().count({ where }),
    ])

    res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    })
  })

  router.get('/:id', requirePermission(module, 'view'), async (req: AuthRequest, res) => {
    const row = await delegate().findUnique({ where: { id: req.params.id }, include })
    if (!row) throw new AppError(`${entityType} not found`, 404, 'NOT_FOUND')
    res.json({ success: true, data: row })
  })

  router.post('/', requirePermission(module, 'create'), async (req: AuthRequest, res) => {
    let body = req.body

    if (injectOnCreate) {
      const defaults = await injectOnCreate()
      // Only fill what the caller left out, so an explicit value still wins.
      const missing = Object.fromEntries(
        Object.entries(defaults).filter(([key]) => body?.[key] === undefined),
      )
      body = { ...body, ...missing }
    }

    const data = createSchema.parse(body)

    // The form no longer asks for a code, so one is made up here. Two people
    // saving at the same instant can both read the same highest number; the
    // unique constraint catches the loser and it simply takes the next one.
    let created
    if (isGeneratedCode(model) && !(data as Record<string, unknown>).code) {
      created = await withGeneratedCode(model, data as Record<string, unknown>, (withCode) =>
        delegate().create({ data: withCode, include }),
      )
    } else {
      created = await delegate().create({ data, include })
    }

    await writeAuditLog(req, {
      module,
      action: 'CREATE',
      entityType,
      entityId: created.id,
      after: created,
    })

    res.status(201).json({ success: true, data: created })
  })

  router.patch('/:id', requirePermission(module, 'edit'), async (req: AuthRequest, res) => {
    const data = updateSchema.parse(req.body)

    const before = await delegate().findUnique({ where: { id: req.params.id } })
    if (!before) throw new AppError(`${entityType} not found`, 404, 'NOT_FOUND')

    const updated = await delegate().update({ where: { id: req.params.id }, data, include })

    await writeAuditLog(req, {
      module,
      action: 'UPDATE',
      entityType,
      entityId: updated.id,
      before,
      after: updated,
    })

    res.json({ success: true, data: updated })
  })

  router.delete('/:id', requirePermission(module, 'delete'), async (req: AuthRequest, res) => {
    const before = await delegate().findUnique({ where: { id: req.params.id } })
    if (!before) throw new AppError(`${entityType} not found`, 404, 'NOT_FOUND')

    if (softDelete) {
      const updated = await delegate().update({
        where: { id: req.params.id },
        data: { isActive: false },
      })
      await writeAuditLog(req, {
        module,
        action: 'DELETE',
        entityType,
        entityId: req.params.id,
        before,
        after: updated,
      })
      return res.json({ success: true, message: `${entityType} deactivated` })
    }

    await delegate().delete({ where: { id: req.params.id } })
    await writeAuditLog(req, {
      module,
      action: 'DELETE',
      entityType,
      entityId: req.params.id,
      before,
    })
    res.json({ success: true, message: `${entityType} deleted` })
  })

  return router
}
