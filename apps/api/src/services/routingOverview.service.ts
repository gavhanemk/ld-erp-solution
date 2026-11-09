import type { Prisma, PrismaClient } from '@prisma/client'
import { trackedRoutings, type Applies } from './styleTrack.service'
import { styleOrderStages } from './styleOrders.service'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Masters → Routings, style by style: every routing that serves a style, the
 * one a new order for it takes, and the manufacturing orders that were given
 * each routing — with where each order has got to.
 *
 * Read only. It puts together what is already kept: a routing's style (or
 * the category, or any style, it is shared by), the routing a manufacturing
 * order copied its steps from and that routing's version then
 * (ManufacturingOrder.routingId / routingVersion), and each order's position
 * as the floor's stage sheets show it (styleOrderStages, the style page's own
 * figures). Which routing a new order takes is the style tracker's rule
 * (trackedRoutings): the style's own, else its category's, else one for any
 * style.
 */

/** An order still being made: not completed, not closed. */
const OPEN_MO: Prisma.EnumMOStatusFilter = { notIn: ['COMPLETED', 'CLOSED'] }

/** What the list can be narrowed to, and the counts it shows for each. */
export const SHOWS = ['ALL', 'OWN', 'SHARED', 'NONE', 'ON_ORDERS'] as const
export type Show = (typeof SHOWS)[number]

const routingSelect = {
  id: true,
  code: true,
  name: true,
  styleId: true,
  category: true,
  version: true,
  isActive: true,
  isLocked: true,
  updatedAt: true,
  updatedBy: { select: { name: true } },
  style: { select: { code: true } },
  fabric: { select: { name: true } },
  steps: {
    orderBy: { sequence: 'asc' as const },
    select: { sequence: true, isQcStep: true, execution: true, skip: true, operation: { select: { name: true } } },
  },
  _count: { select: { boms: true } },
} satisfies Prisma.RoutingSelect

type RoutingRow = Prisma.RoutingGetPayload<{ select: typeof routingSelect }>

const appliesOf = (r: { styleId: string | null; category: string | null }): Applies => (r.styleId ? 'STYLE' : r.category?.trim() ? 'CATEGORY' : 'ANY')

function shape(r: RoutingRow, styleId: string, takesNew: string | null) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    version: r.version,
    applies: appliesOf(r),
    category: r.category,
    /** Made for another style: only here because one of this style's orders was given it. */
    otherStyle: r.styleId && r.styleId !== styleId ? (r.style?.code ?? null) : null,
    isActive: r.isActive,
    isLocked: r.isLocked,
    fabric: r.fabric?.name ?? null,
    steps: r.steps.map((s) => ({ sequence: s.sequence, name: s.operation.name, isQcStep: s.isQcStep, execution: s.execution, skip: s.skip })),
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy?.name ?? null,
    boms: r._count.boms,
    /** The routing a new manufacturing order for this style takes. */
    takesNew: r.id === takesNew,
  }
}

export async function routingsByStyle(db: Db, opts: { q?: string; show?: string; page: number; limit: number }) {
  const q = opts.q?.trim()
  const contains = q ? { contains: q, mode: 'insensitive' as const } : undefined
  // A style is found by its own words, by the name of a routing made for it,
  // or by the number of an order or sales order made for it.
  const styles = await db.style.findMany({
    where: {
      isActive: true,
      ...(contains
        ? {
            OR: [
              { code: contains },
              { name: contains },
              { category: contains },
              { routings: { some: { OR: [{ name: contains }, { code: contains }] } } },
              { moLines: { some: { mo: { OR: [{ moNumber: contains }, { so: { soNumber: contains } }] } } } },
            ],
          }
        : {}),
    },
    select: { id: true, code: true, name: true, category: true, brandType: true },
    orderBy: { code: 'asc' },
  })
  const ids = styles.map((s) => s.id)

  const [routings, follows, openLines] = await Promise.all([
    db.routing.findMany({
      where: { OR: [{ styleId: { in: ids } }, { styleId: null }] },
      select: routingSelect,
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
    }),
    trackedRoutings(db, styles),
    db.mOLine.findMany({ where: { styleId: { in: ids }, mo: { status: OPEN_MO } }, select: { styleId: true } }),
  ])
  const openOf = new Map<string, number>()
  for (const l of openLines) openOf.set(l.styleId, (openOf.get(l.styleId) ?? 0) + 1)

  const all = styles.map((s) => {
    const followed = follows.get(s.id) ?? null
    const kind: Exclude<Show, 'ALL' | 'ON_ORDERS'> = followed?.applies === 'STYLE' ? 'OWN' : followed ? 'SHARED' : 'NONE'
    return { style: s, followed, kind, open: openOf.get(s.id) ?? 0 }
  })
  const counts: Record<Show, number> = {
    ALL: all.length,
    OWN: all.filter((r) => r.kind === 'OWN').length,
    SHARED: all.filter((r) => r.kind === 'SHARED').length,
    NONE: all.filter((r) => r.kind === 'NONE').length,
    ON_ORDERS: all.filter((r) => r.open > 0).length,
  }
  const show = SHOWS.find((k) => k === opts.show) ?? 'ALL'
  const wanted = show === 'ALL' ? all : show === 'ON_ORDERS' ? all.filter((r) => r.open > 0) : all.filter((r) => r.kind === show)
  const start = (opts.page - 1) * opts.limit
  const page = wanted.slice(start, start + opts.limit)

  // The page's orders, each with where it stands, then which routing and sales order each was made under.
  const stages = await Promise.all(page.map((r) => styleOrderStages(db, r.style.id)))
  const moIds = [...new Set(stages.flat().map((o) => o.moId))]
  const mos = moIds.length
    ? await db.manufacturingOrder.findMany({
        where: { id: { in: moIds } },
        select: { id: true, routingId: true, routingVersion: true, so: { select: { soNumber: true, customer: { select: { name: true } } } } },
      })
    : []
  const moOf = new Map(mos.map((m) => [m.id, m]))
  // A routing an order of the style was given that is neither the style's own nor shared: another style's.
  const known = new Map(routings.map((r) => [r.id, r]))
  const missing = [...new Set(mos.map((m) => m.routingId).filter((id): id is string => !!id && !known.has(id)))]
  if (missing.length) for (const r of await db.routing.findMany({ where: { id: { in: missing } }, select: routingSelect })) known.set(r.id, r)

  const rows = page.map((r, i) => {
    const orders = stages[i].map((o) => {
      const mo = moOf.get(o.moId)
      return {
        lineId: o.lineId,
        moId: o.moId,
        moNumber: o.moNumber,
        status: o.status,
        open: o.status !== 'COMPLETED' && o.status !== 'CLOSED',
        color: o.color,
        planned: o.planned,
        staged: o.staged,
        done: o.done,
        total: o.total,
        at: o.at?.name ?? null,
        routingId: mo?.routingId ?? null,
        routingVersion: mo?.routingVersion ?? null,
        so: mo?.so ? { soNumber: mo.so.soNumber, customer: mo.so.customer.name } : null,
      }
    })
    // The style's own routings, stopped ones too; the shared one it follows
    // when it has none in use; and any other routing one of its orders was given.
    const takesNew = r.followed?.routing.id ?? null
    const ownIds = routings.filter((x) => x.styleId === r.style.id).map((x) => x.id)
    const shownIds = [...ownIds, ...(takesNew && !ownIds.includes(takesNew) ? [takesNew] : [])]
    for (const o of orders) if (o.routingId && !shownIds.includes(o.routingId)) shownIds.push(o.routingId)
    return {
      style: r.style,
      kind: r.kind,
      routings: shownIds.map((id) => known.get(id)).filter((x): x is RoutingRow => !!x).map((x) => shape(x, r.style.id, takesNew)),
      orders,
    }
  })

  return { rows, counts, total: wanted.length }
}
