import { Prisma, type PrismaClient } from '@prisma/client'
import { compareRoutings, type ComparableRouting } from '@ld-erp/shared'
import { routingInclude } from './routing.service'

type Db = PrismaClient | Prisma.TransactionClient
export async function similarRoutings(db: Db, current: ComparableRouting & { excludeId?: string }) {
  if (!current.steps.length) {
    const style = current.styleId
      ? await db.style.findUnique({ where: { id: current.styleId }, select: { category: true } })
      : null
    const category = current.category || style?.category
    const scopes: Prisma.RoutingWhereInput[] = [
      ...(current.styleId ? [{ styleId: current.styleId }] : []),
      ...(category
        ? [{ styleId: null, category: { equals: category, mode: 'insensitive' as const } }]
        : []),
      { styleId: null, category: null },
    ]
    const groups = await Promise.all(
      scopes.map((scope) =>
        db.routing.findMany({
          where: {
            ...scope,
            id: current.excludeId ? { not: current.excludeId } : undefined,
            isActive: true,
            OR: [
              { fabricItemId: null },
              ...(current.fabricItemId ? [{ fabricItemId: current.fabricItemId }] : []),
            ],
          },
          include: routingInclude,
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: 3,
        })
      )
    )
    return groups
      .flat()
      .slice(0, 8)
      .map((routing) => ({ routing, kind: 'SUGGESTED', comparison: null }))
  }
  // Narrow by indexed process IDs and multiset overlap in SQL. No arbitrary recent-N
  // cutoff: an older exact match must remain discoverable among thousands of routes.
  const ids = current.steps.map((s) => s.operationId)
  const candidates = await db.$queryRaw<Array<{ routingId: string }>>(Prisma.sql`
    WITH wanted AS (
      SELECT id, count(*)::int AS n FROM unnest(ARRAY[${Prisma.join(ids)}]::text[]) AS id GROUP BY id
    ), overlap AS (
      SELECT s."routingId", s."operationId", LEAST(count(*)::int, w.n) AS n
      FROM routing_steps s JOIN wanted w ON w.id = s."operationId"
      GROUP BY s."routingId", s."operationId", w.n
    ), matched AS (
      SELECT "routingId", sum(n) AS n FROM overlap GROUP BY "routingId"
    )
    SELECT m."routingId" FROM matched m
    JOIN routing_steps s ON s."routingId" = m."routingId"
    WHERE m."routingId" <> ${current.excludeId || ''}
    GROUP BY m."routingId", m.n
    HAVING m.n / greatest(count(*), ${ids.length})::numeric >= 0.7
    ORDER BY m."routingId"
  `)
  const best: Array<{
    id: string
    comparison: ReturnType<typeof compareRoutings>
    updatedAt: number
  }> = []
  // Compare compact data in bounded batches; only hydrate labels for the best eight.
  for (let i = 0; i < candidates.length; i += 200) {
    const rows = await db.routing.findMany({
      where: { id: { in: candidates.slice(i, i + 200).map((r) => r.routingId) } },
      select: {
        id: true,
        styleId: true,
        category: true,
        fabricItemId: true,
        updatedAt: true,
        steps: true,
      },
    })
    for (const row of rows) {
      const comparison = compareRoutings(current, {
        ...row,
        steps: row.steps.map((s) => ({
          ...s,
          smv: s.smv == null ? null : Number(s.smv),
          ratePerPiece: s.ratePerPiece == null ? null : Number(s.ratePerPiece),
        })),
      })
      if (comparison.similar)
        best.push({ id: row.id, comparison, updatedAt: row.updatedAt.getTime() })
    }
    best.sort(
      (a, b) =>
        Number(b.comparison.exact) - Number(a.comparison.exact) ||
        b.comparison.overlap - a.comparison.overlap ||
        b.comparison.unchanged - a.comparison.unchanged ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id)
    )
    best.splice(8)
  }
  const rows = await db.routing.findMany({
    where: { id: { in: best.map((r) => r.id) } },
    include: routingInclude,
  })
  return best
    .map((m) => ({
      routing: rows.find((r) => r.id === m.id)!,
      kind: m.comparison.kind,
      comparison: m.comparison,
    }))
    .filter((m) => m.routing)
}
