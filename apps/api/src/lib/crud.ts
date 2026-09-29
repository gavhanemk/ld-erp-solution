import { Router } from 'express'
import { ZodError, type ZodTypeAny } from 'zod'
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
   * Allows DELETE /:id?permanent=true, and GET /:id/delete-check to say
   * beforehand what it would do. Keyed by relation name, every link to the
   * record and what deleting does to it: left blank, where the link is
   * optional, or moved to another record of this master (?moveTo=), where
   * it is not.
   */
  permanentDelete?: Record<string, DeleteUse>
  /**
   * Columns no two records may share, compared without regard to capitals or
   * spaces at the ends, so "Printing" and "printing " cannot both be offered
   * in one dropdown. The clash is reported under that field on the form.
   */
  uniqueFields?: string[]
  /**
   * A facet worked out by a rule of its own rather than a plain group-by:
   * given the where clause (every other filter applied), how many records
   * each value would leave. For a count that has to agree with a filter that
   * reaches through a relation.
   */
  customFacets?: Record<string, (where: Record<string, unknown>) => Promise<Record<string, number>>>
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
  /** Whether the model has an isActive column to filter on. Defaults to softDelete. */
  activeFlag?: boolean
  /**
   * Fields merged into the body before validation when the client did not
   * supply them. Used for owner keys the user should never have to type, such
   * as companyId on a single-entity install.
   */
  injectOnCreate?: () => Promise<Record<string, unknown>>
}

export interface DeleteUse {
  /** How to say one and several: 'requisition', 'requisitions'. */
  one: string
  many: string
  /** The model and foreign key holding the link, so it can be cleared or moved. */
  model?: string
  field?: string
  /**
   * 'blank' where the link is optional: an item simply has no department.
   * 'move' where it is not: a requisition must say who asked, so its
   * department changes to one the person picks.
   * 'refuse' where neither makes sense: a sales order line for size 40 cannot
   * be left sizeless or quietly become size 42, so the record stays while
   * anything uses it.
   */
  then: 'blank' | 'move' | 'refuse'
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

/** ['1 item', '2 machines', '1 operation'] → '1 item, 2 machines and 1 operation' */
function sentence(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

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
    // A model with no isActive column (sizes) ignores ?active rather than
    // passing a filter Prisma rejects, which is how the sizes screen crashed.
    activeFlag = softDelete,
    injectOnCreate,
    filters = {},
    facets = [],
    customFacets = {},
    uniqueFields = [],
    permanentDelete,
  } = options

  const router = Router({ mergeParams: true })

  // The factory is generic over 56 models, so the delegate is reached
  // dynamically. Prisma's per-model types cannot be expressed here.
  const delegate = () => (prisma as unknown as Record<string, any>)[model]

  /** Refuses a value another record already has, naming that record. */
  const assertUnique = async (
    data: Record<string, unknown>,
    exceptId?: string,
    before?: Record<string, unknown>,
  ) => {
    const same = (a: unknown, b: unknown) =>
      typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase()
    for (const field of uniqueFields) {
      const value = data[field]
      if (typeof value !== 'string' || !value.trim()) continue
      // Unchanged on an edit: a pair that was duplicated before this rule
      // existed can still be edited (and one of them renamed).
      if (before && same(value, before[field])) continue
      const clash = await delegate().findFirst({
        where: {
          [field]: { equals: value.trim(), mode: 'insensitive' },
          ...(exceptId ? { NOT: { id: exceptId } } : {}),
        },
      })
      if (clash) {
        const label = clash.code ? ` (${clash.code})` : ''
        const inactive = clash.isActive === false ? ', inactive — edit it to bring it back' : ''
        // A name clashes with a name; anything else (a GSTIN) is said with the
        // name of the record that already has it.
        const message =
          field === 'name'
            ? `${clash.name}${label} already exists${inactive}. If it is a different one, add something to tell them apart, such as the town.`
            : `${clash[field]} is already on ${clash.name ?? 'another record'}${label}${inactive}`
        throw new ZodError([{ code: 'custom', path: [field], message }])
      }
    }
  }

  /**
   * The where clause for a list request: active flag, search, and every
   * filter, except those that `skipFacet` says to leave out.
   */
  const buildWhere = (req: AuthRequest, skipFacet?: string) => {
    const and: Record<string, unknown>[] = []

    // ?active=true|false filters; omitting it returns both.
    if (activeFlag && req.query.active === 'true') and.push({ isActive: true })
    else if (activeFlag && req.query.active === 'false') and.push({ isActive: false })

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
        if (customFacets[field]) {
          counts[field] = await customFacets[field](buildWhere(req, field))
          return
        }
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
    await assertUnique(data as Record<string, unknown>)

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
    await assertUnique(data as Record<string, unknown>, req.params.id, before)

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

  /** What links to a record, counted, with what deleting it does to each. */
  const usesOf = async (id: string) => {
    if (!permanentDelete) {
      throw new AppError(`${entityType} records are deactivated, never deleted`, 400, 'NO_PERMANENT_DELETE')
    }
    const row = await delegate().findUnique({
      where: { id },
      select: { _count: { select: Object.fromEntries(Object.keys(permanentDelete).map((k) => [k, true])) } },
    })
    if (!row) throw new AppError(`${entityType} not found`, 404, 'NOT_FOUND')
    return Object.entries(permanentDelete)
      .filter(([key]) => row._count[key] > 0)
      .map(([key, use]) => {
        const n: number = row._count[key]
        return { ...use, key, count: n, label: `${n} ${n === 1 ? use.one : use.many}` }
      })
  }

  /*
   * What a permanent delete would do, asked before doing it, so the screen
   * can say "1 operation will move, 2 items will be left blank" and ask where
   * to move them. Registered as /:id/delete-check, clear of /:id.
   */
  router.get('/:id/delete-check', requirePermission(module, 'delete'), async (req: AuthRequest, res) => {
    const uses = await usesOf(req.params.id)
    res.json({
      success: true,
      data: {
        move: uses.filter((u) => u.then === 'move').map((u) => u.label),
        blank: uses.filter((u) => u.then === 'blank').map((u) => u.label),
        refuse: uses.filter((u) => u.then === 'refuse').map((u) => u.label),
      },
    })
  })

  router.delete('/:id', requirePermission(module, 'delete'), async (req: AuthRequest, res) => {
    const before = await delegate().findUnique({ where: { id: req.params.id } })
    if (!before) throw new AppError(`${entityType} not found`, 404, 'NOT_FOUND')

    /*
     * Gone for good. Everything linked to it is dealt with first, in the same
     * transaction as the delete, so a failure part-way leaves nothing half
     * moved: optional links are cleared, required ones move to the record
     * the person chose. Nothing is left to the foreign keys, which would
     * either refuse with a database error or clear a link without a word.
     */
    // A master with no active flag can only ever be deleted, so every delete
    // of one goes through the same checks.
    if (req.query.permanent === 'true' || (!softDelete && permanentDelete)) {
      const uses = await usesOf(req.params.id)
      const blocking = uses.filter((u) => u.then === 'refuse')
      if (blocking.length) {
        const label = before.name ?? before.label ?? before.code ?? entityType
        throw new AppError(
          `${label} is used by ${sentence(blocking.map((u) => u.label))}, so it cannot be deleted. Take it off those first.`,
          409,
          'IN_USE',
        )
      }
      const toMove = uses.filter((u) => u.then === 'move')
      const moveTo = typeof req.query.moveTo === 'string' ? req.query.moveTo : ''

      let target: Record<string, any> | null = null
      if (toMove.length) {
        if (!moveTo) {
          throw new AppError(
            `${before.name ?? entityType} has ${sentence(toMove.map((u) => u.label))} that must belong to a ${entityType.toLowerCase()}. Choose one to move ${toMove.length === 1 && toMove[0].count === 1 ? 'it' : 'them'} to.`,
            409,
            'NEEDS_MOVE_TARGET',
          )
        }
        if (moveTo === req.params.id) {
          throw new AppError(`Choose a different ${entityType.toLowerCase()} to move them to`, 400, 'BAD_MOVE_TARGET')
        }
        target = await delegate().findUnique({ where: { id: moveTo } })
        if (!target) {
          throw new AppError(`The ${entityType.toLowerCase()} to move them to no longer exists`, 400, 'BAD_MOVE_TARGET')
        }
      }

      await prisma.$transaction(async (tx) => {
        const t = tx as unknown as Record<string, any>
        for (const u of uses) {
          if (!u.model || !u.field) continue
          await t[u.model].updateMany({
            where: { [u.field]: req.params.id },
            data: { [u.field]: u.then === 'move' ? moveTo : null },
          })
        }
        await t[model].delete({ where: { id: req.params.id } })
        // A slow pooler once took ten seconds to answer; the default of five
        // would abandon a delete that was only waiting.
      }, { timeout: 20000 })

      const moved = toMove.map((u) => u.label)
      const blanked = uses.filter((u) => u.then === 'blank').map((u) => u.label)
      await writeAuditLog(req, {
        module,
        action: 'DELETE',
        entityType,
        entityId: req.params.id,
        before,
        after: { deleted: true, movedTo: target ? { id: target.id, name: target.name } : null, moved, blanked },
      })

      const parts = [
        moved.length ? `${sentence(moved)} moved to ${target?.name}` : '',
        blanked.length ? `${sentence(blanked)} left blank` : '',
      ].filter(Boolean)
      return res.json({
        success: true,
        message: `${before.name ?? entityType} deleted${parts.length ? `. ${parts.join('; ')}.` : ''}`,
      })
    }

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
