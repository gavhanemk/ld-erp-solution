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
  /**
   * String columns matched against ?q= (case-insensitive contains). A dotted
   * path reaches through a relation, so 'category.name' finds items by the
   * name of their category.
   */
  searchFields?: string[]
  /**
   * Query parameters the list accepts as filters, each turning its values
   * into a where clause. Several values come comma-separated and mean "any of
   * these". Nothing outside this list is ever passed to Prisma.
   */
  filters?: Record<string, CrudFilter>
  /**
   * Scalar columns GET /facets counts rows by, so a filter dropdown can show
   * how many records each choice would leave.
   */
  facets?: string[]
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

export interface CrudFilter {
  where: (values: string[]) => Record<string, unknown>
  /**
   * The facets this filter is left out of. A filter never narrows its own
   * counts: with Type = Trim picked, the Type list must still say how many
   * Raw Material there are, or the other choices all read zero.
   */
  facets?: string[]
}

const MAX_PAGE_SIZE = 200

/** 'category.parent.name' → { category: { parent: { name: leaf } } } */
function nested(path: string, leaf: unknown): Record<string, unknown> {
  return path
    .split('.')
    .reduceRight<unknown>((inner, key) => ({ [key]: inner }), leaf) as Record<string, unknown>
}

/**
 * Builds the standard master-data REST surface for one model:
 *
 *   GET    /            list with pagination, search, sort, active and other filters
 *   GET    /facets      how many records each filter choice would leave
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
    filters = {},
    facets = [],
  } = options

  const router = Router({ mergeParams: true })

  // The factory is generic over 56 models, so the delegate is reached
  // dynamically. Prisma's per-model types cannot be expressed here.
  const delegate = () => (prisma as unknown as Record<string, any>)[model]

  /**
   * The where clause for a list request: active flag, search, and every
   * filter, except those that `skipFacet` says to leave out.
   */
  const buildWhere = (req: AuthRequest, skipFacet?: string) => {
    const and: Record<string, unknown>[] = []

    // ?active=true|false filters; omitting it returns both.
    if (req.query.active === 'true') and.push({ isActive: true })
    else if (req.query.active === 'false') and.push({ isActive: false })

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q && searchFields.length > 0) {
      and.push({
        OR: searchFields.map((field) => nested(field, { contains: q, mode: 'insensitive' })),
      })
    }

    for (const [key, filter] of Object.entries(filters)) {
      if (skipFacet && filter.facets?.includes(skipFacet)) continue
      const raw = req.query[key]
      if (typeof raw !== 'string' || !raw) continue
      const values = [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))]
        .filter((v) => v.length <= 64)
        .slice(0, 50)
      if (values.length) and.push(filter.where(values))
    }

    return and.length ? { AND: and } : {}
  }

  /*
   * How many records each choice in a filter would leave, given everything
   * else on screen: the search, the other filters, the active flag.
   * Registered before /:id so "facets" is not taken for a record id.
   */
  router.get('/facets', requirePermission(module, 'view'), async (req: AuthRequest, res) => {
    const counts: Record<string, Record<string, number>> = {}
    await Promise.all(
      facets.map(async (field) => {
        const groups: Array<Record<string, unknown> & { _count: { _all: number } }> =
          await delegate().groupBy({
            by: [field],
            where: buildWhere(req, field),
            _count: { _all: true },
          })
        counts[field] = Object.fromEntries(
          // A record with nothing set is counted under 'none', so "No department"
          // can be offered as a choice of its own.
          groups.map((g) => [g[field] == null ? 'none' : String(g[field]), g._count._all]),
        )
      }),
    )
    res.json({ success: true, data: counts })
  })

  router.get('/', requirePermission(module, 'view'), async (req: AuthRequest, res) => {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || 25))

    const sortField = typeof req.query.sort === 'string' ? req.query.sort : defaultSort.field
    if (!sortableFields.includes(sortField)) {
      throw new AppError(
        `Cannot sort by '${sortField}'. Allowed: ${sortableFields.join(', ')}`,
        400,
        'INVALID_SORT',
      )
    }
    const sortOrder = req.query.order === 'asc' ? 'asc' : defaultSort.order

    const where = buildWhere(req)

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
