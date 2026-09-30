import { Router } from 'express'
import { prisma, Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { isAdmin, requirePermission, userCan, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { nextDocumentNumber } from '../lib/docNumber'
import { getPrintHeader } from '../lib/printData'
import {
  balanceOf,
  lockedBalanceOf,
  onHand,
  recordMovement,
  reorderStatus,
  transferStock,
} from '../services/stock.service'
import { decidePending } from '../services/requisition.service'
import * as customerMaterialImport from '../services/customerMaterialImport.service'
import { inventoryDashboard } from '../services/inventoryDashboard.service'
import {
  adjustmentSchema,
  cancelCustomerGrnSchema,
  cancelCustomerReturnSchema,
  cancelJobWorkChallanSchema,
  cancelTransferSchema,
  createCustomerGrnSchema,
  createCustomerReturnSchema,
  createJobWorkChallanSchema,
  createJobWorkReturnSchema,
  createRequisitionSchema,
  requisitionSourcingSchema,
  issueRequisitionSchema,
  openingStockSchema,
  rejectRequisitionSchema,
  closeRequisitionSchema,
  transferSchema,
} from '../schemas/inventory.schemas'

const router = Router()
const MODULE = 'inventory'

/** Quantities are stored to three decimals; money to two. */
const round3 = (n: number) => Math.round(n * 1000) / 1000
const round2 = (n: number) => Math.round(n * 100) / 100

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

// ── What is on hand ─────────────────────────────────────────────────────────

router.get('/stock', requirePermission(MODULE, 'view'), async (req, res) => {
  const [rows, reorder] = await Promise.all([onHand(prisma, {
    itemId: str(req.query.itemId),
    warehouseId: str(req.query.warehouseId),
    categoryId: str(req.query.categoryId),
    ownership: str(req.query.ownership) as never,
    lowOnly: req.query.low === 'true',
    search: str(req.query.q),
  }), reorderStatus(prisma)])

  // What each item is, for the screen's filters: its type, its main category
  // and sub-category, and the department that uses it. Read once for every
  // item on the list, the ones to reorder with nothing anywhere included.
  const itemIds = [...new Set([...rows.map((r) => r.itemId), ...reorder.map((r) => r.itemId)])]
  const items = await prisma.item.findMany({
    where: { id: { in: itemIds } },
    select: {
      id: true,
      type: true,
      category: { select: { id: true, name: true, parent: { select: { id: true, name: true } } } },
      department: { select: { id: true, name: true } },
    },
  })
  const about = new Map(
    items.map((i) => {
      // An item filed under a sub-category has its main category above it;
      // one filed straight under a main category has no sub-category.
      const main = i.category.parent ?? { id: i.category.id, name: i.category.name }
      const sub = i.category.parent ? { id: i.category.id, name: i.category.name } : null
      return [
        i.id,
        {
          itemType: i.type,
          mainCategoryId: main.id,
          mainCategoryName: main.name,
          subCategoryId: sub?.id ?? null,
          subCategoryName: sub?.name ?? null,
          departmentId: i.department?.id ?? null,
          departmentName: i.department?.name ?? null,
        },
      ]
    }),
  )

  res.json({
    success: true,
    data: rows.map((r) => ({ ...r, ...about.get(r.itemId) })),
    // Every item that needs reordering, so the screen can show one with
    // nothing in any store (it has no row above) and count them as it filters.
    reorder: reorder.filter((r) => r.isLow).map((r) => ({ ...r, ...about.get(r.itemId) })),
    summary: {
      lines: rows.length,
      // Only our own stock has a value to us. A customer's fabric sitting in
      // our godown is not an asset and must never reach the balance sheet.
      totalValue: rows
        .filter((r) => r.ownership === 'OWNED')
        .reduce((sum, r) => sum + r.value, 0),
      // Items, not rows: an item in two stores is one thing to reorder. The
      // same count the dashboard shows.
      lowCount: reorder.filter((r) => r.isLow).length,
    },
  })
})

/**
 * The items that need reordering, and how far below they are.
 *
 * The same rule as the stock screen and the dashboard (`reorderStatus`), for
 * any screen that only wants to mark them: the items master shows its warning
 * on these and no others.
 */
router.get('/reorder', requirePermission(MODULE, 'view'), async (_req, res) => {
  const rows = (await reorderStatus(prisma)).filter((r) => r.isLow)
  res.json({ success: true, data: rows })
})

/** One item: where it is, and what has happened to it lately. */
router.get('/stock/:itemId', requirePermission(MODULE, 'view'), async (req, res) => {
  const item = await prisma.item.findUnique({
    where: { id: req.params.itemId },
    include: { uom: true, category: true },
  })
  if (!item) throw new AppError('Item not found', 404, 'NOT_FOUND')

  const [byWarehouse, movements] = await Promise.all([
    onHand(prisma, { itemId: item.id }),
    prisma.stockLedger.findMany({
      where: { itemId: item.id },
      include: {
        warehouse: { select: { id: true, name: true } },
        ownerCustomer: { select: { id: true, name: true } },
      },
      orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    }),
  ])

  const owned = byWarehouse.filter((r) => r.ownership === 'OWNED')

  res.json({
    success: true,
    data: {
      item,
      byWarehouse,
      totals: {
        qty: owned.reduce((s, r) => s + r.qty, 0),
        value: owned.reduce((s, r) => s + r.value, 0),
      },
      movements,
    },
  })
})

// ── The dashboard ───────────────────────────────────────────────────────────

/** Stock, movement, requisitions and job work in one call, for the inventory dashboard. */
router.get('/dashboard', requirePermission(MODULE, 'view'), async (req, res) => {
  const data = await inventoryDashboard({
    warehouseId: str(req.query.warehouseId),
    days: Number(req.query.days) || 30,
  })
  res.json({ success: true, data })
})

// ── The ledger ──────────────────────────────────────────────────────────────

/*
 * The ledger's filters. Each is a column of the movement, or of the item it
 * moved, and several values of one mean "any of these". They are applied in
 * SQL rather than in the browser: the ledger only ever grows, and a year of a
 * running mill is far more rows than a page should ever read.
 */
const LEDGER_FILTERS = [
  'store', 'movement', 'document', 'direction', 'owner', 'category', 'sub', 'department', 'itemType',
] as const
type LedgerFilter = (typeof LEDGER_FILTERS)[number]

/** What a movement is, for each filter. 'none' stands for "not set". */
const LEDGER_VALUE: Record<LedgerFilter, Prisma.Sql> = {
  store: Prisma.sql`s."warehouseId"`,
  movement: Prisma.sql`s."transactionType"::text`,
  document: Prisma.sql`COALESCE(s."referenceType", 'none')`,
  direction: Prisma.sql`CASE WHEN s."inQty" > 0 THEN 'in' ELSE 'out' END`,
  owner: Prisma.sql`s.ownership::text`,
  // An item filed under a sub-category belongs to that one's main category.
  category: Prisma.sql`COALESCE(c."parentId", c.id)`,
  sub: Prisma.sql`CASE WHEN c."parentId" IS NULL THEN 'none' ELSE c.id END`,
  department: Prisma.sql`COALESCE(i."departmentId", 'none')`,
  itemType: Prisma.sql`i.type::text`,
}

/** The name to show for a value, where the database holds it. */
const LEDGER_LABEL: Partial<Record<LedgerFilter, Prisma.Sql>> = {
  store: Prisma.sql`w.name`,
  category: Prisma.sql`COALESCE(pc.name, c.name)`,
  sub: Prisma.sql`CASE WHEN c."parentId" IS NULL THEN NULL ELSE c.name END`,
  department: Prisma.sql`d.name`,
}

const LEDGER_FROM = Prisma.sql`
  FROM ld_erp.stock_ledger s
  JOIN ld_erp.items i            ON i.id = s."itemId"
  JOIN ld_erp.item_categories c  ON c.id = i."categoryId"
  LEFT JOIN ld_erp.item_categories pc ON pc.id = c."parentId"
  LEFT JOIN ld_erp.departments d ON d.id = i."departmentId"
  JOIN ld_erp.warehouses w       ON w.id = s."warehouseId"
  LEFT JOIN ld_erp.customers oc  ON oc.id = s."ownerCustomerId"`

/** A filter's picked values from the query string: `store=a,b` or `store=a&store=b`. */
const pickedOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v])
    .filter((x): x is string => typeof x === 'string')
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean)

function ledgerQuery(query: Record<string, unknown>) {
  const base: Prisma.Sql[] = []
  const itemId = str(query.itemId)
  if (itemId) base.push(Prisma.sql`s."itemId" = ${itemId}`)
  // The old single-value names still work, for links made before the filters.
  const legacy: Partial<Record<LedgerFilter, unknown>> = { store: query.warehouseId, movement: query.type }

  const from = str(query.from)
  const to = str(query.to)
  if (from && !Number.isNaN(Date.parse(from))) base.push(Prisma.sql`s."transactionDate" >= ${new Date(from)}`)
  // An end date means the whole of that day, not midnight at its start.
  if (to && !Number.isNaN(Date.parse(to)))
    base.push(Prisma.sql`s."transactionDate" <= ${new Date(new Date(to).setHours(23, 59, 59, 999))}`)

  // Every word has to be somewhere: "tape fabric" finds tape in the fabric godown.
  for (const word of (str(query.search) ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
    const like = `%${word}%`
    base.push(Prisma.sql`(
      i.name ILIKE ${like} OR i.code ILIKE ${like} OR w.name ILIKE ${like}
      OR COALESCE(s.notes, '') ILIKE ${like} OR COALESCE(oc.name, '') ILIKE ${like}
      OR c.name ILIKE ${like} OR COALESCE(pc.name, '') ILIKE ${like} OR COALESCE(d.name, '') ILIKE ${like})`)
  }

  const picked = Object.fromEntries(
    LEDGER_FILTERS.map((k) => [k, pickedOf(query[k] ?? legacy[k])]),
  ) as Record<LedgerFilter, string[]>

  /** Every condition, bar the one filter a dropdown is counting for. */
  const where = (skip?: LedgerFilter) => {
    const parts = [...base]
    for (const k of LEDGER_FILTERS) {
      if (k === skip || !picked[k].length) continue
      parts.push(Prisma.sql`${LEDGER_VALUE[k]} IN (${Prisma.join(picked[k])})`)
    }
    return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty
  }
  return { where, picked }
}

/**
 * Every movement, newest first.
 *
 * This is the answer to "why does it say 340 when I counted 300". It is read
 * only and always will be: a ledger somebody can edit is not a ledger.
 *
 * Alongside the page it returns what the filters leave in total (movements,
 * value in and out), the value in and out by day, and for each filter how many
 * movements each of its values would leave given the others.
 */
router.get('/ledger', requirePermission(MODULE, 'view'), async (req, res) => {
  // An export takes every row at once, up to a sensible ceiling.
  const exporting = req.query.export === '1'
  const page = exporting ? 1 : Math.max(1, Number(req.query.page) || 1)
  const limit = exporting ? 10000 : Math.min(200, Math.max(1, Number(req.query.limit) || 50))
  const { where, picked } = ledgerQuery(req.query as Record<string, unknown>)
  const all = where()

  const idsQuery = prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s.id ${LEDGER_FROM} ${all}
    ORDER BY s."transactionDate" DESC, s."createdAt" DESC
    LIMIT ${limit} OFFSET ${(page - 1) * limit}`

  /*
   * In and out are counted leaving the in/out filter aside, so picking "came
   * in" still says what went out; everything else is for what is on screen.
   */
  const dir = picked.direction.length
    ? Prisma.sql`${LEDGER_VALUE.direction} IN (${Prisma.join(picked.direction)})`
    : Prisma.sql`TRUE`
  const summaryQuery = prisma.$queryRaw<
    Array<{
      total: number; ins: number; outs: number; inValue: number; outValue: number
      items: number; stores: number; first: Date | null; last: Date | null
    }>
  >`
    SELECT
      COUNT(*) FILTER (WHERE ${dir})::int                            AS total,
      COUNT(*) FILTER (WHERE s."inQty" > 0)::int                     AS ins,
      COUNT(*) FILTER (WHERE s."inQty" <= 0)::int                    AS outs,
      COALESCE(SUM(s."inQty"  * COALESCE(s."unitRate", 0)), 0)::float8 AS "inValue",
      COALESCE(SUM(s."outQty" * COALESCE(s."unitRate", 0)), 0)::float8 AS "outValue",
      COUNT(DISTINCT s."itemId") FILTER (WHERE ${dir})::int          AS items,
      COUNT(DISTINCT s."warehouseId") FILTER (WHERE ${dir})::int     AS stores,
      MIN(s."transactionDate") FILTER (WHERE ${dir})                 AS first,
      MAX(s."transactionDate") FILTER (WHERE ${dir})                 AS last
    ${LEDGER_FROM} ${where('direction')}`

  if (exporting) {
    const [ids, [summary]] = await Promise.all([idsQuery, summaryQuery])
    res.json({ success: true, data: await ledgerRows(ids.map((r) => r.id)), summary })
    return
  }

  // By day, in India's day rather than the server's: a receipt at 1 am IST is
  // that day's receipt, not the day before's.
  const seriesQuery = prisma.$queryRaw<Array<{ day: string; inValue: number; outValue: number; moves: number }>>`
    SELECT
      to_char((s."transactionDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
      COALESCE(SUM(s."inQty"  * COALESCE(s."unitRate", 0)), 0)::float8 AS "inValue",
      COALESCE(SUM(s."outQty" * COALESCE(s."unitRate", 0)), 0)::float8 AS "outValue",
      COUNT(*)::int AS moves
    ${LEDGER_FROM} ${all}
    GROUP BY 1 ORDER BY 1`

  const facetQueries = LEDGER_FILTERS.map(
    (k) => prisma.$queryRaw<Array<{ value: string; label: string | null; count: number }>>`
      SELECT ${LEDGER_VALUE[k]} AS value, MAX(${LEDGER_LABEL[k] ?? Prisma.sql`NULL::text`}) AS label, COUNT(*)::int AS count
      ${LEDGER_FROM} ${where(k)}
      GROUP BY 1`,
  )

  const [ids, [summary], series, analysis, ...facetRows] = await Promise.all([
    idsQuery, summaryQuery, seriesQuery,
    req.query.analysis === '1' ? ledgerAnalysis(all) : Promise.resolve(undefined),
    ...facetQueries,
  ])
  const facets = Object.fromEntries(LEDGER_FILTERS.map((k, n) => [k, facetRows[n]]))

  res.json({
    success: true,
    data: await ledgerRows(ids.map((r) => r.id)),
    pagination: { page, limit, total: summary.total, pages: Math.ceil(summary.total / limit) || 1 },
    summary,
    series,
    facets,
    ...(analysis ? { analysis } : {}),
  })
})

type LedgerGroup = {
  value: string; label: string | null; moves: number; ins: number; outs: number; inValue: number; outValue: number
}

/**
 * For the ledger's dashboard: what the filters leave, cut by store, category,
 * department and document, and the items that moved the most value.
 */
async function ledgerAnalysis(all: Prisma.Sql) {
  const sums = Prisma.sql`
    COUNT(*)::int AS moves,
    COUNT(*) FILTER (WHERE s."inQty" > 0)::int AS ins,
    COUNT(*) FILTER (WHERE s."inQty" <= 0)::int AS outs,
    COALESCE(SUM(s."inQty"  * COALESCE(s."unitRate", 0)), 0)::float8 AS "inValue",
    COALESCE(SUM(s."outQty" * COALESCE(s."unitRate", 0)), 0)::float8 AS "outValue"`
  const moved = Prisma.sql`SUM((s."inQty" + s."outQty") * COALESCE(s."unitRate", 0))`
  const by = (k: LedgerFilter) => prisma.$queryRaw<LedgerGroup[]>`
    SELECT ${LEDGER_VALUE[k]} AS value, MAX(${LEDGER_LABEL[k] ?? Prisma.sql`NULL::text`}) AS label, ${sums}
    ${LEDGER_FROM} ${all}
    GROUP BY 1
    ORDER BY ${moved} DESC, moves DESC`
  const [byStore, byCategory, byDepartment, byDocument, topItems] = await Promise.all([
    by('store'), by('category'), by('department'), by('document'),
    prisma.$queryRaw<Array<LedgerGroup & { code: string; uom: string; inQty: number; outQty: number }>>`
      SELECT s."itemId" AS value, MAX(i.name) AS label, MAX(i.code) AS code, MAX(u.symbol) AS uom,
        COALESCE(SUM(s."inQty"), 0)::float8 AS "inQty", COALESCE(SUM(s."outQty"), 0)::float8 AS "outQty", ${sums}
      ${LEDGER_FROM}
      JOIN ld_erp.uom u ON u.id = i."uomId"
      ${all}
      GROUP BY 1
      ORDER BY ${moved} DESC, moves DESC
      LIMIT 10`,
  ])
  return { byStore, byCategory, byDepartment, byDocument, topItems }
}

/** The movements with these ids, in that order, with what each item is. */
async function ledgerRows(ids: string[]) {
  if (!ids.length) return []
  const rows = await prisma.stockLedger.findMany({
    where: { id: { in: ids } },
    include: {
      item: {
        select: {
          id: true, code: true, name: true, type: true,
          uom: { select: { symbol: true } },
          category: { select: { id: true, name: true, parent: { select: { id: true, name: true } } } },
          department: { select: { id: true, name: true } },
        },
      },
      warehouse: { select: { id: true, name: true } },
      ownerCustomer: { select: { id: true, name: true } },
    },
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.flatMap((id) => {
    const r = byId.get(id)
    if (!r) return []
    const cat = r.item.category
    const rate = r.unitRate === null ? null : Number(r.unitRate)
    const qty = Number(r.inQty) > 0 ? Number(r.inQty) : Number(r.outQty)
    return [{
      ...r,
      itemType: r.item.type,
      mainCategoryId: cat.parent?.id ?? cat.id,
      mainCategoryName: cat.parent?.name ?? cat.name,
      subCategoryId: cat.parent ? cat.id : null,
      subCategoryName: cat.parent ? cat.name : null,
      departmentId: r.item.department?.id ?? null,
      departmentName: r.item.department?.name ?? null,
      // What the movement was worth, at the rate it moved at.
      value: rate === null ? null : round2(qty * rate),
    }]
  })
}

/** Stock value, cut by warehouse and by category, for the accounts side. */
router.get('/valuation', requirePermission(MODULE, 'view'), async (_req, res) => {
  const rows = (await onHand(prisma)).filter((r) => r.ownership === 'OWNED')

  const group = (key: (r: (typeof rows)[number]) => string) => {
    const map = new Map<string, { name: string; qty: number; value: number; items: number }>()
    for (const r of rows) {
      const k = key(r)
      const cur = map.get(k) ?? { name: k, qty: 0, value: 0, items: 0 }
      cur.qty += r.qty
      cur.value += r.value
      cur.items += 1
      map.set(k, cur)
    }
    return [...map.values()].sort((a, b) => b.value - a.value)
  }

  res.json({
    success: true,
    data: {
      totalValue: rows.reduce((s, r) => s + r.value, 0),
      byWarehouse: group((r) => r.warehouseName),
      byCategory: group((r) => r.categoryName),
    },
  })
})

// ── Documents that move stock ───────────────────────────────────────────────

const itemSelect = {
  select: { id: true, code: true, name: true, uom: { select: { symbol: true } } },
}

const transferInclude = {
  fromWarehouse: { select: { id: true, name: true } },
  toWarehouse: { select: { id: true, name: true } },
  movedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  lines: { include: { item: itemSelect } },
}

const adjustmentInclude = {
  warehouse: { select: { id: true, name: true } },
  madeBy: { select: { id: true, name: true } },
  lines: { include: { item: itemSelect } },
}

/**
 * Refuses a count or an opening that lists the same item twice.
 *
 * Each line is set against the book figure as it stood before the document,
 * so two lines for one item were both applied: 500 on the book, two lines
 * of 400, and the book ended at 300. Adding the lines up would be a guess —
 * two racks of 400, or one rack counted twice? — so the person is asked to
 * enter the item once, with its total.
 */
async function refuseRepeatedItems(tx: Prisma.TransactionClient, itemIds: string[]) {
  const seen = new Map<string, number>()
  for (const [i, itemId] of itemIds.entries()) {
    const first = seen.get(itemId)
    if (first !== undefined) {
      const item = await tx.item.findUnique({ where: { id: itemId }, select: { name: true } })
      throw new AppError(
        `${item?.name ?? 'An item'} is on lines ${first + 1} and ${i + 1}. Enter it once, with the total.`,
        400,
        'REPEATED_ITEM',
      )
    }
    seen.set(itemId, i)
  }
}

/**
 * Opening stock.
 *
 * Allowed once per item and warehouse. Running it twice is almost always
 * somebody re-importing the same spreadsheet, and the second run would double
 * the mill's stock silently — so it is refused with the name of the item that
 * already has a balance.
 */
router.post('/opening', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = openingStockSchema.parse(req.body)
  const asOn = data.asOnDate ?? new Date()

  const result = await prisma.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.findUnique({ where: { id: data.warehouseId } })
    if (!warehouse) throw new AppError('That warehouse does not exist', 404, 'NOT_FOUND')

    await refuseRepeatedItems(tx, data.lines.map((l) => l.itemId))

    const reference = `OPEN-${Date.now()}`
    const written = []

    for (const line of data.lines) {
      // Locked, so two people entering the same opening at once cannot both
      // find it empty.
      const existing = await lockedBalanceOf(tx, {
        itemId: line.itemId,
        warehouseId: data.warehouseId,
      })
      if (existing.qty !== 0) {
        const item = await tx.item.findUnique({
          where: { id: line.itemId },
          select: { name: true },
        })
        throw new AppError(
          `${item?.name ?? 'That item'} already has ${existing.qty} in ${warehouse.name}. Opening stock can only be entered once — use a stock adjustment to correct it.`,
          409,
          'OPENING_ALREADY_SET',
        )
      }

      const { balance } = await recordMovement(tx, {
        itemId: line.itemId,
        warehouseId: data.warehouseId,
        transactionType: 'OPENING',
        direction: 'IN',
        qty: line.qty,
        unitRate: line.unitRate,
        batchNumber: line.batchNumber,
        referenceType: 'OPENING_STOCK',
        referenceId: reference,
        transactionDate: asOn,
        notes: data.notes ?? 'Opening stock',
      })

      written.push({ itemId: line.itemId, qty: line.qty, balance: balance.qty })
    }

    return { reference, lines: written }
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'OpeningStock',
    entityId: result.reference,
    after: result,
  })

  res.status(201).json({
    success: true,
    message: `Opening stock recorded for ${result.lines.length} ${result.lines.length === 1 ? 'item' : 'items'}.`,
    data: result,
  })
})

/**
 * A correction after a physical count.
 *
 * Guarded by the approve permission rather than create. An adjustment is the
 * one movement with no document behind it in the real world — it says the book
 * was wrong — so it should not be within reach of everyone who can receive
 * goods. The reason is mandatory and lands in the ledger against every line.
 */
router.post('/adjustments', requirePermission(MODULE, 'approve'), async (req: AuthRequest, res) => {
  const data = adjustmentSchema.parse(req.body)
  const when = data.adjustmentDate ?? new Date()

  const adjustment = await prisma.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.findUnique({ where: { id: data.warehouseId } })
    if (!warehouse) throw new AppError('That warehouse does not exist', 404, 'NOT_FOUND')

    await refuseRepeatedItems(tx, data.lines.map((l) => l.itemId))

    const counted = []

    for (const line of data.lines) {
      const key = { itemId: line.itemId, warehouseId: data.warehouseId }
      const before = await lockedBalanceOf(tx, key)
      const difference = Number((line.countedQty - before.qty).toFixed(3))

      if (difference > 0 && before.qty === 0 && line.unitRate === undefined) {
        const item = await tx.item.findUnique({
          where: { id: line.itemId },
          select: { name: true },
        })
        throw new AppError(
          `${item?.name ?? 'That item'} has nothing on hand to take a rate from. Enter a rate so the stock found can be valued.`,
          400,
          'NO_RATE',
        )
      }

      counted.push({
        itemId: line.itemId,
        bookQty: before.qty,
        countedQty: line.countedQty,
        difference,
        unitRate: difference > 0 ? (line.unitRate ?? before.avgRate) : before.avgRate,
      })
    }

    const adjustmentNumber = await nextDocumentNumber(tx, 'ADJ', when)

    const created = await tx.stockAdjustment.create({
      data: {
        adjustmentNumber,
        warehouseId: data.warehouseId,
        adjustmentDate: when,
        reason: data.reason,
        madeById: req.user?.id ?? null,
        // Every line that was counted is kept, including the ones that matched.
        // "We counted forty items and three were wrong" is the useful sentence
        // in a stock audit; recording only the three loses the forty.
        lines: { create: counted },
      },
    })

    for (const line of counted) {
      // A figure that matched the book needs no movement. The line above is
      // still the record that somebody counted it.
      if (line.difference === 0) continue

      await recordMovement(tx, {
        itemId: line.itemId,
        warehouseId: data.warehouseId,
        transactionType: 'ADJUSTMENT',
        direction: line.difference > 0 ? 'IN' : 'OUT',
        qty: Math.abs(line.difference),
        unitRate: line.difference > 0 ? line.unitRate : undefined,
        referenceType: 'STOCK_ADJUSTMENT',
        referenceId: created.id,
        transactionDate: when,
        notes: `${adjustmentNumber}: ${data.reason}`,
      })
    }

    return tx.stockAdjustment.findUniqueOrThrow({
      where: { id: created.id },
      include: adjustmentInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'StockAdjustment',
    entityId: adjustment.id,
    after: adjustment,
  })

  const corrected = adjustment.lines.filter((l) => Number(l.difference) !== 0).length

  res.status(201).json({
    success: true,
    message: corrected
      ? `${adjustment.adjustmentNumber} saved. ${corrected} ${corrected === 1 ? 'figure' : 'figures'} corrected.`
      : `${adjustment.adjustmentNumber} saved. Everything counted matched the book, so no stock moved.`,
    data: adjustment,
  })
})

router.get('/adjustments', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

  const where: Record<string, unknown> = {}
  if (str(req.query.warehouseId)) where.warehouseId = str(req.query.warehouseId)
  if (str(req.query.q)) {
    where.OR = [
      { adjustmentNumber: { contains: str(req.query.q), mode: 'insensitive' } },
      { reason: { contains: str(req.query.q), mode: 'insensitive' } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.stockAdjustment.findMany({
      where,
      include: adjustmentInclude,
      orderBy: [{ adjustmentDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stockAdjustment.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/adjustments/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const row = await prisma.stockAdjustment.findUnique({
    where: { id: req.params.id },
    include: adjustmentInclude,
  })
  if (!row) throw new AppError('That stock adjustment does not exist', 404, 'NOT_FOUND')
  res.json({ success: true, data: row })
})

/**
 * Moving stock between two of our own stores.
 *
 * Value travels with it: cloth carried across the yard is worth what it was
 * worth on the other side. The rate each line left at is copied onto the
 * document so the note prints the same figure a year later.
 */
router.post('/transfers', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = transferSchema.parse(req.body)
  const when = data.transferDate ?? new Date()

  const transfer = await prisma.$transaction(async (tx) => {
    const [from, to] = await Promise.all([
      tx.warehouse.findUnique({ where: { id: data.fromWarehouseId } }),
      tx.warehouse.findUnique({ where: { id: data.toWarehouseId } }),
    ])
    if (!from || !to) throw new AppError('One of those warehouses does not exist', 404, 'NOT_FOUND')

    const transferNumber = await nextDocumentNumber(tx, 'STN', when)

    const created = await tx.stockTransfer.create({
      data: {
        transferNumber,
        fromWarehouseId: data.fromWarehouseId,
        toWarehouseId: data.toWarehouseId,
        transferDate: when,
        notes: data.notes ?? null,
        movedById: req.user?.id ?? null,
        lines: { create: data.lines.map((l) => ({ itemId: l.itemId, qty: l.qty })) },
      },
      include: { lines: true },
    })

    for (const line of created.lines) {
      // Read what it is carried at before it moves. transferStock prices the
      // arriving stock at the same figure, so this is the rate the document
      // should remember.
      const carried = await balanceOf(tx, {
        itemId: line.itemId,
        warehouseId: data.fromWarehouseId,
      })

      await transferStock(tx, {
        itemId: line.itemId,
        fromWarehouseId: data.fromWarehouseId,
        toWarehouseId: data.toWarehouseId,
        qty: Number(line.qty),
        referenceType: 'STOCK_TRANSFER',
        referenceId: created.id,
        transactionDate: when,
        notes: `${transferNumber}: ${from.name} → ${to.name}`,
      })

      await tx.stockTransferLine.update({
        where: { id: line.id },
        data: { unitRate: carried.avgRate },
      })
    }

    return tx.stockTransfer.findUniqueOrThrow({
      where: { id: created.id },
      include: transferInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'StockTransfer',
    entityId: transfer.id,
    after: transfer,
  })

  res.status(201).json({
    success: true,
    message: `${transfer.transferNumber} saved. ${transfer.lines.length} ${transfer.lines.length === 1 ? 'item' : 'items'} moved from ${transfer.fromWarehouse.name} to ${transfer.toWarehouse.name}.`,
    data: transfer,
  })
})

router.get('/transfers', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

  const where: Record<string, unknown> = {}
  if (str(req.query.warehouseId)) {
    where.OR = [
      { fromWarehouseId: str(req.query.warehouseId) },
      { toWarehouseId: str(req.query.warehouseId) },
    ]
  }
  if (str(req.query.q)) where.transferNumber = { contains: str(req.query.q), mode: 'insensitive' }

  const [rows, total] = await Promise.all([
    prisma.stockTransfer.findMany({
      where,
      include: transferInclude,
      orderBy: [{ transferDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stockTransfer.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/transfers/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const row = await prisma.stockTransfer.findUnique({
    where: { id: req.params.id },
    include: transferInclude,
  })
  if (!row) throw new AppError('That stock transfer does not exist', 404, 'NOT_FOUND')
  res.json({ success: true, data: row })
})

/**
 * Taking a transfer back out.
 *
 * The goods walk back the way they came, so the reversal is a transfer in the
 * other direction rather than a quiet deletion. If the stock has since moved on
 * from the destination the stock service refuses and says how much is actually
 * there — which is the right answer, because the goods have gone and pretending
 * otherwise would leave the rack and the book disagreeing.
 */
router.patch(
  '/transfers/:id/cancel',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { reason } = cancelTransferSchema.parse(req.body ?? {})

    const after = await prisma.$transaction(async (tx) => {
      const before = await tx.stockTransfer.findUnique({
        where: { id: req.params.id },
        include: { lines: true, fromWarehouse: true, toWarehouse: true },
      })
      if (!before) throw new AppError('That stock transfer does not exist', 404, 'NOT_FOUND')

      if (before.cancelledAt) {
        throw new AppError(
          `${before.transferNumber} was already cancelled on ${before.cancelledAt.toLocaleDateString('en-IN')}.`,
          400,
          'ALREADY_CANCELLED',
        )
      }

      for (const line of before.lines) {
        await transferStock(tx, {
          itemId: line.itemId,
          // Back the way it came.
          fromWarehouseId: before.toWarehouseId,
          toWarehouseId: before.fromWarehouseId,
          qty: Number(line.qty),
          referenceType: 'STOCK_TRANSFER_CANCELLED',
          referenceId: before.id,
          transactionDate: new Date(),
          notes: `${before.transferNumber} cancelled: ${reason}`,
        })
      }

      return tx.stockTransfer.update({
        where: { id: before.id },
        data: {
          cancelledAt: new Date(),
          cancelledById: req.user?.id ?? null,
          cancelReason: reason,
        },
        include: transferInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'StockTransfer',
      entityId: after.id,
      after,
    })

    res.json({
      success: true,
      message: `${after.transferNumber} cancelled and the stock moved back to ${after.fromWarehouse.name}.`,
      data: after,
    })
  },
)

// ── Material requisitions ───────────────────────────────────────────────────

const mrInclude = {
  department: { select: { id: true, name: true, code: true } },
  mo: { select: { id: true, moNumber: true } },
  raisedBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  issuedBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
  lines: {
    include: {
      item: {
        select: {
          id: true, code: true, name: true, uom: { select: { symbol: true } },
          // For the list's item panel: category and sub-category in their own columns.
          category: { select: { name: true, parent: { select: { name: true } } } },
        },
      },
      warehouse: { select: { id: true, name: true } },
      // Whose material the line draws, when it is a customer's.
      ownerCustomer: { select: { id: true, name: true } },
    },
  },
}

router.get('/requisitions', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))

  const where: Record<string, unknown> = {}
  const status = str(req.query.status)
  if (status) {
    // Where a requisition stands, which is more than its approval status: an
    // approved one may be waiting, part handed over, complete, or closed.
    const open = { closedAt: null, issuedAt: null }
    const stages: Record<string, Record<string, unknown>> = {
      PENDING: { status: 'PENDING', closedAt: null },
      APPROVED: { status: 'APPROVED', ...open },
      PARTLY: { status: 'APPROVED', ...open, lines: { some: { issuedQty: { gt: 0 } } } },
      ISSUED: { issuedAt: { not: null } },
      CLOSED: { closedAt: { not: null } },
      REJECTED: { status: 'REJECTED' },
    }
    if (!stages[status]) {
      throw new AppError(`Unknown status '${status}'`, 400, 'INVALID_STATUS')
    }
    Object.assign(where, stages[status])
  }
  if (str(req.query.departmentId)) where.departmentId = str(req.query.departmentId)

  const q = str(req.query.q)
  if (q) {
    where.OR = [
      { mrNumber: { contains: q, mode: 'insensitive' } },
      { department: { name: { contains: q, mode: 'insensitive' } } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.materialRequisition.findMany({
      where,
      include: mrInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.materialRequisition.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

router.get('/requisitions/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const mr = await prisma.materialRequisition.findUnique({
    where: { id: req.params.id },
    include: mrInclude,
  })
  if (!mr) throw new AppError('Requisition not found', 404, 'NOT_FOUND')

  // What is actually on the rack right now, so whoever approves it is not
  // approving an issue the store cannot fulfil.
  const available = await Promise.all(
    mr.lines.map(async (l) => ({
      lineId: l.id,
      available: (await balanceOf(prisma, { itemId: l.itemId, warehouseId: l.warehouseId })).qty,
    })),
  )

  res.json({ success: true, data: { ...mr, available } })
})

router.post('/requisitions', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createRequisitionSchema.parse(req.body)

  const mr = await prisma.$transaction(async (tx) => {
    const [department, warehouse] = await Promise.all([
      tx.department.findUnique({ where: { id: data.departmentId } }),
      tx.warehouse.findUnique({ where: { id: data.warehouseId } }),
    ])
    if (!department) throw new AppError('That department does not exist', 404, 'NOT_FOUND')
    if (!warehouse) throw new AppError('That warehouse does not exist', 404, 'NOT_FOUND')

    const owners = [...new Set(data.lines.filter((l) => l.ownership === 'CUSTOMER_OWNED').map((l) => l.ownerCustomerId!))]
    if (owners.length) {
      const found = await tx.customer.count({ where: { id: { in: owners } } })
      if (found !== owners.length) throw new AppError('One of those customers does not exist', 404, 'NOT_FOUND')
    }

    const mrNumber = await nextDocumentNumber(tx, 'MR')

    return tx.materialRequisition.create({
      data: {
        mrNumber,
        departmentId: data.departmentId,
        moId: data.moId || null,
        requiredDate: data.requiredDate ?? null,
        notes: data.notes ?? null,
        raisedById: req.user!.id,
        lines: {
          create: data.lines.map((l) => ({
            itemId: l.itemId,
            requestedQty: l.requestedQty,
            // Whose material this line draws. Without it a request for a
            // customer's fabric would be issued out of our own balance of the
            // same cloth.
            ownership: l.ownership ?? 'OWNED',
            ownerCustomerId: l.ownership === 'CUSTOMER_OWNED' ? l.ownerCustomerId : null,
            // One store per requisition, chosen once on the header in the UI
            // and copied down, so there is still only one place it is stored.
            warehouseId: data.warehouseId,
            purpose: l.purpose ?? null,
          })),
        },
      },
      include: mrInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'MaterialRequisition',
    entityId: mr.id,
    after: mr,
  })

  res.status(201).json({ success: true, data: mr })
})

/**
 * The store's answer: which lines it will issue, and which have to be bought.
 *
 * Only on an approved requisition, and only until it is issued. Before approval
 * there is nothing to answer — the request may yet be refused. After issue the
 * stock has already moved, and saying a line should have been bought would be
 * rewriting what happened.
 *
 * A line marked PURCHASE is not issued by the store; it appears on the purchase
 * order form instead, and stays there until it has been ordered.
 */
router.patch(
  '/requisitions/:id/sourcing',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const data = requisitionSourcingSchema.parse(req.body)

    const after = await prisma.$transaction(async (tx) => {
      const mr = await tx.materialRequisition.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!mr) throw new AppError('Requisition not found', 404, 'NOT_FOUND')

      if (mr.status !== 'APPROVED') {
        throw new AppError(
          mr.status === 'PENDING'
            ? 'This requisition has not been approved yet, so there is nothing for the store to answer.'
            : 'This requisition was refused.',
          400,
          'NOT_APPROVED',
        )
      }
      if (mr.issuedAt) {
        throw new AppError(
          `${mr.mrNumber} was already issued on ${mr.issuedAt.toLocaleDateString('en-IN')}, so how it was answered can no longer be changed.`,
          400,
          'ALREADY_ISSUED',
        )
      }
      if (mr.closedAt) {
        throw new AppError(
          `${mr.mrNumber} was closed, so how it was answered can no longer be changed.`,
          400,
          'CLOSED',
        )
      }

      const own = new Map(mr.lines.map((l) => [l.id, l]))
      for (const l of data.lines) {
        const line = own.get(l.lineId)
        if (!line) {
          throw new AppError(
            `One of those lines is not on ${mr.mrNumber}. Reopen the requisition and try again.`,
            400,
            'WRONG_LINE',
          )
        }
        // Part of it has already left the rack, so it is the store's line now.
        if (l.fulfilment === 'PURCHASE' && Number(line.issuedQty) > 0) {
          throw new AppError(
            `Some of that line was already handed over from the store, so it cannot be switched to buying. Close the requisition and raise a new one for the rest.`,
            400,
            'PART_ISSUED',
          )
        }
      }

      /*
       * A line already ordered against cannot be handed back to the store.
       * The purchase order exists, the supplier may have despatched, and the
       * indent list would go on showing a request that has been placed.
       */
      const backToStock = data.lines.filter((l) => l.fulfilment === 'FROM_STOCK')
      if (backToStock.length) {
        const ordered = await tx.purchaseOrderLine.findMany({
          where: {
            mrLineId: { in: backToStock.map((l) => l.lineId) },
            po: { status: { not: 'CANCELLED' } },
          },
          select: { mrLineId: true, po: { select: { poNumber: true } } },
        })
        if (ordered.length) {
          throw new AppError(
            `That line is already on ${ordered[0].po.poNumber}. Cancel the order first if it is to come from the store instead.`,
            400,
            'ALREADY_ORDERED',
          )
        }
      }

      await Promise.all(
        data.lines.map((l) =>
          tx.materialRequisitionLine.update({
            where: { id: l.lineId },
            data: { fulfilment: l.fulfilment },
          }),
        ),
      )

      return tx.materialRequisition.findUnique({
        where: { id: mr.id },
        include: mrInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'MaterialRequisition',
      entityId: req.params.id,
      after,
    })

    const buying = data.lines.filter((l) => l.fulfilment === 'PURCHASE').length
    res.json({
      success: true,
      data: after,
      message: buying
        ? `${buying} ${buying === 1 ? 'line goes' : 'lines go'} to the buyer. ${
            buying === 1 ? 'It is' : 'They are'
          } waiting on the purchase order screen.`
        : 'Every line will be issued from the store.',
    })
  },
)

router.patch(
  '/requisitions/:id/approve',
  requirePermission(MODULE, 'approve'),
  async (req: AuthRequest, res) => {
    const before = await prisma.materialRequisition.findUnique({
      where: { id: req.params.id },
      include: mrInclude,
    })
    if (!before) throw new AppError('Requisition not found', 404, 'NOT_FOUND')

    if (before.status !== 'PENDING') {
      throw new AppError(
        `This requisition is already ${before.status.toLowerCase()}.`,
        400,
        'NOT_PENDING',
      )
    }

    // docs/04-business-rules.md, section 7. Nobody signs off their own request,
    // and this is the only place that rule can actually be held — except the
    // Admin, who may, because in a small mill the owner often raises and
    // approves in one go. The audit log says when that happened.
    const selfApproved = Boolean(before.raisedById && before.raisedById === req.user!.id)
    if (selfApproved && !isAdmin(req.user)) {
      throw new AppError(
        'You raised this requisition, so somebody else has to approve it.',
        403,
        'SELF_APPROVAL',
      )
    }

    // Only a requisition still pending is approved, checked in the same
    // statement that approves it, so an approve and a refuse arriving
    // together cannot both land.
    await decidePending(before.id, before.mrNumber, {
      status: 'APPROVED',
      approvedById: req.user!.id,
      approvedAt: new Date(),
    })
    const after = await prisma.materialRequisition.findUniqueOrThrow({
      where: { id: before.id },
      include: mrInclude,
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'APPROVE',
      entityType: 'MaterialRequisition',
      entityId: after.id,
      before,
      after: selfApproved ? { ...after, note: 'Approved by the Admin who raised it' } : after,
    })

    res.json({ success: true, message: `${after.mrNumber} approved.`, data: after })
  },
)

router.patch(
  '/requisitions/:id/reject',
  requirePermission(MODULE, 'approve'),
  async (req: AuthRequest, res) => {
    const { reason } = rejectRequisitionSchema.parse(req.body)

    const before = await prisma.materialRequisition.findUnique({
      where: { id: req.params.id },
      include: mrInclude,
    })
    if (!before) throw new AppError('Requisition not found', 404, 'NOT_FOUND')
    if (before.status !== 'PENDING') {
      throw new AppError(
        `This requisition is already ${before.status.toLowerCase()}.`,
        400,
        'NOT_PENDING',
      )
    }

    await decidePending(before.id, before.mrNumber, {
      status: 'REJECTED',
      approvedById: req.user!.id,
      approvedAt: new Date(),
      rejectionReason: reason,
    })
    const after = await prisma.materialRequisition.findUniqueOrThrow({
      where: { id: before.id },
      include: mrInclude,
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'REJECT',
      entityType: 'MaterialRequisition',
      entityId: after.id,
      before,
      after,
    })

    res.json({ success: true, message: `${after.mrNumber} refused.`, data: after })
  },
)

/** A quantity as the store says it: 12.5, not 12.500. */
const qtyText = (n: number) => String(Number(n.toFixed(3)))

/**
 * Holds a requisition for the rest of the transaction.
 *
 * Everything that changes what can still be issued (an issue, a close) takes
 * this first, so two of them cannot both work from the same "still to issue".
 * A second waits here and, once through, reads what the first left.
 */
async function lockRequisition(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.material_requisitions WHERE id = ${id} FOR UPDATE`
}

/**
 * Handing the material over. This is the moment stock actually leaves.
 *
 * The store can hand over part of it now and the rest later: 30 of the 50
 * metres today because that is what is on the rack, the other 20 when the
 * next roll comes in. Each issue takes what is given on each line, up to what
 * is still owed, and leaves the rest open. Once every line from the store has
 * been handed over in full, the requisition is complete. If the rest is no
 * longer wanted, it is closed instead (see /close).
 *
 * Within one issue, if any line is short on the rack the whole issue is
 * refused rather than half-done, so what the person pressed is what happened.
 */
router.post(
  '/requisitions/:id/issue',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const body = issueRequisitionSchema.parse(req.body ?? {})
    const when = body.issueDate ?? new Date()

    const result = await prisma.$transaction(async (tx) => {
      // Held before anything is read. Three clicks at once (a double-click,
      // two tabs, a retried request) used to all read "not issued yet" and all
      // take stock: 2 metres asked for, 6 left the store. Now the second waits
      // here and then sees what the first issued.
      await lockRequisition(tx, req.params.id)

      const mr = await tx.materialRequisition.findUnique({
        where: { id: req.params.id },
        include: {
          lines: {
            include: { item: { select: { name: true, uom: { select: { symbol: true } } } } },
          },
          department: true,
        },
      })
      if (!mr) throw new AppError('Requisition not found', 404, 'NOT_FOUND')

      if (mr.closedAt) {
        throw new AppError(
          `${mr.mrNumber} was closed on ${mr.closedAt.toLocaleDateString('en-IN')}, so nothing more can be issued against it.`,
          400,
          'CLOSED',
        )
      }
      if (mr.status !== 'APPROVED') {
        throw new AppError(
          mr.status === 'PENDING'
            ? 'This requisition has not been approved yet.'
            : 'This requisition was refused, so nothing can be issued against it.',
          400,
          'NOT_APPROVED',
        )
      }
      if (mr.issuedAt) {
        throw new AppError(
          `${mr.mrNumber} was issued in full on ${mr.issuedAt.toLocaleDateString('en-IN')}.`,
          409,
          'ALREADY_ISSUED',
        )
      }

      // docs/04-business-rules.md, section 7: raised, approved and issued by
      // three different people.
      if (mr.raisedById && mr.raisedById === req.user!.id) {
        throw new AppError(
          'You raised this requisition, so somebody else in the store has to hand the material over.',
          403,
          'SELF_ISSUE',
        )
      }
      if (mr.approvedById && mr.approvedById === req.user!.id) {
        throw new AppError(
          'You approved this requisition, so somebody else in the store has to hand the material over.',
          403,
          'SELF_ISSUE',
        )
      }

      const askedFor = new Map(body.lines?.map((l) => [l.lineId, l.issueQty]) ?? [])
      const handedOver: string[] = []

      for (const line of mr.lines) {
        /*
         * A line marked for purchase is not the store's to answer.
         *
         * It is on this requisition to tell the buyer what to order, and there
         * is nothing on the rack behind it. Skipped rather than refused: a
         * requisition routinely mixes the two.
         */
        if (line.fulfilment === 'PURCHASE') continue

        const unit = line.item.uom?.symbol ?? ''
        const owed = Number((Number(line.requestedQty) - Number(line.issuedQty)).toFixed(3))
        if (owed <= 0) continue

        // Not named in the request: everything still owed on it.
        const qty = askedFor.get(line.id) ?? owed
        if (qty <= 0) continue

        if (qty > owed + 1e-9) {
          throw new AppError(
            `${line.item.name}: only ${qtyText(owed)} ${unit} is still to be issued on this line, not ${qtyText(qty)}. Raise a new requisition for more.`.replace(
              /\s+/g,
              ' ',
            ),
            400,
            'OVER_ISSUE',
          )
        }

        // recordMovement refuses if the rack is short, and names the shortfall.
        await recordMovement(tx, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          transactionType: 'ISSUE',
          direction: 'OUT',
          qty,
          // Hand the ownership straight through. The stock service keeps a
          // customer's cloth and our own in separate balances, so issuing the
          // wrong one would take stock nobody asked for.
          ownership: line.ownership,
          ownerCustomerId: line.ownerCustomerId,
          referenceType: 'MATERIAL_REQUISITION',
          referenceId: mr.id,
          transactionDate: when,
          notes: `${mr.mrNumber} → ${mr.department.name}`,
        })

        await tx.materialRequisitionLine.update({
          where: { id: line.id },
          data: { issuedQty: { increment: qty } },
        })
        handedOver.push(`${qtyText(qty)} ${unit} ${line.item.name}`.replace(/\s+/g, ' '))
      }

      if (handedOver.length === 0) {
        throw new AppError(
          'Nothing to hand over: enter a quantity on at least one line.',
          400,
          'NOTHING_TO_ISSUE',
        )
      }

      // Complete once every line from the store has been handed over in full.
      // issuedBy is whoever handed over the last of it; each part is in the
      // stock ledger with its own date, and in the audit trail with its person.
      const lines = await tx.materialRequisitionLine.findMany({ where: { mrId: mr.id } })
      const stillOwed = lines.filter(
        (l) => l.fulfilment !== 'PURCHASE' && Number(l.issuedQty) < Number(l.requestedQty) - 1e-9,
      ).length
      if (stillOwed === 0) {
        await tx.materialRequisition.update({
          where: { id: mr.id },
          data: { issuedById: req.user!.id, issuedAt: when },
        })
      }

      const after = await tx.materialRequisition.findUniqueOrThrow({
        where: { id: mr.id },
        include: mrInclude,
      })
      return { after, handedOver, stillOwed }
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'MaterialRequisition',
      entityId: result.after.id,
      after: { ...result.after, handedOverNow: result.handedOver },
    })

    res.json({
      success: true,
      message:
        result.stillOwed === 0
          ? `${result.after.mrNumber} issued in full.`
          : `Issued against ${result.after.mrNumber}: ${result.handedOver.join(', ')}. ${result.stillOwed} ${result.stillOwed === 1 ? 'line is' : 'lines are'} still to be handed over.`,
      data: result.after,
    })
  },
)

/**
 * Cancelling a requisition, or closing one that is part issued.
 *
 * Material that is no longer wanted should not sit on the list for ever as
 * "approved, not collected". Nothing issued yet: it is cancelled. Some of it
 * issued: it is closed, and what was handed over stays handed over.
 *
 * The person who raised it can withdraw it; the store, or anybody who can
 * approve requisitions, can close one that is no longer needed. A reason is
 * always asked for. Refused and fully issued requisitions are already over.
 */
router.post(
  '/requisitions/:id/close',
  requirePermission(MODULE, 'view'),
  async (req: AuthRequest, res) => {
    const { reason } = closeRequisitionSchema.parse(req.body ?? {})

    const result = await prisma.$transaction(async (tx) => {
      await lockRequisition(tx, req.params.id)
      const before = await tx.materialRequisition.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!before) throw new AppError('Requisition not found', 404, 'NOT_FOUND')

      const mine = before.raisedById === req.user!.id
      if (!mine && !userCan(req.user, MODULE, 'edit') && !userCan(req.user, MODULE, 'approve')) {
        throw new AppError(
          'Only the person who raised it, the store, or an approver can cancel a requisition.',
          403,
          'NOT_ALLOWED',
        )
      }
      if (before.closedAt) {
        throw new AppError(`${before.mrNumber} is already closed.`, 409, 'CLOSED')
      }
      if (before.status === 'REJECTED') {
        throw new AppError(
          `${before.mrNumber} was refused, so there is nothing to cancel.`,
          400,
          'REJECTED',
        )
      }
      if (before.issuedAt) {
        throw new AppError(
          `${before.mrNumber} was issued in full, so there is nothing left to close.`,
          400,
          'ALREADY_ISSUED',
        )
      }

      await tx.materialRequisition.update({
        where: { id: before.id },
        data: { closedAt: new Date(), closedById: req.user!.id, closeReason: reason },
      })
      const after = await tx.materialRequisition.findUniqueOrThrow({
        where: { id: before.id },
        include: mrInclude,
      })
      const partly = before.lines.some((l) => Number(l.issuedQty) > 0)
      return { before, after, partly }
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'MaterialRequisition',
      entityId: result.after.id,
      before: result.before,
      after: result.after,
    })

    res.json({
      success: true,
      message: result.partly
        ? `${result.after.mrNumber} closed. What was handed over stays issued; the rest is no longer owed.`
        : `${result.after.mrNumber} cancelled.`,
      data: result.after,
    })
  },
)

// ── Printed store papers ────────────────────────────────────────────────────
//
// Three sheets the store works from on paper: the slip a department signs for
// what it was handed, the note that travels with goods between stores, and the
// sheet a keeper carries to the rack for a count. Each route gives the page
// everything it prints, letterhead included, in one call.

/** The material issue slip for a requisition: what was asked, given and still owed. */
router.get('/requisitions/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const mr = await prisma.materialRequisition.findUnique({
    where: { id: req.params.id },
    include: mrInclude,
  })
  if (!mr) throw new AppError('Requisition not found', 404, 'NOT_FOUND')

  // Each part handed over, with its date: the slip is signed for these.
  const handovers = await prisma.stockLedger.findMany({
    where: { referenceType: 'MATERIAL_REQUISITION', referenceId: mr.id, outQty: { gt: 0 } },
    select: {
      transactionDate: true,
      outQty: true,
      item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
      warehouse: { select: { name: true } },
    },
    orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }],
  })

  const header = await getPrintHeader('MR')
  res.json({ success: true, data: { ...header, mr, handovers } })
})

/** The stock transfer note that goes with the goods. */
router.get('/transfers/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const transfer = await prisma.stockTransfer.findUnique({
    where: { id: req.params.id },
    include: {
      ...transferInclude,
      fromWarehouse: { select: { id: true, name: true, address: true } },
      toWarehouse: { select: { id: true, name: true, address: true } },
      lines: {
        include: {
          item: {
            select: {
              code: true,
              name: true,
              hsnCode: true,
              uom: { select: { symbol: true } },
            },
          },
        },
      },
    },
  })
  if (!transfer) throw new AppError('Transfer not found', 404, 'NOT_FOUND')

  const header = await getPrintHeader('STN')
  res.json({ success: true, data: { ...header, transfer } })
})

/**
 * The sheet a keeper takes to the rack.
 *
 * Every item in the store with its book figure, in category then name order so
 * the list follows the racks rather than the alphabet. `all=true` adds the
 * active items with nothing on the book there, so stock the book does not know
 * about has a line to be written on. The page decides whether to print the book
 * figure: a count made without seeing it is the honest one.
 */
router.get('/count-sheet', requirePermission(MODULE, 'view'), async (req, res) => {
  const warehouseId = str(req.query.warehouseId)
  if (!warehouseId) throw new AppError('Choose a store', 400, 'NO_STORE')
  const warehouse = await prisma.warehouse.findUnique({
    where: { id: warehouseId },
    select: { id: true, name: true, code: true, address: true },
  })
  if (!warehouse) throw new AppError('That store does not exist', 404, 'NOT_FOUND')

  const held = await onHand(prisma, { warehouseId, ownership: 'OWNED' })
  const rows = held.map((r) => ({
    itemId: r.itemId,
    code: r.itemCode,
    name: r.itemName,
    category: r.categoryName,
    uom: r.uom,
    bookQty: r.qty,
  }))

  if (req.query.all === 'true') {
    const shown = new Set(rows.map((r) => r.itemId))
    const others = await prisma.item.findMany({
      where: { isActive: true, id: { notIn: [...shown] } },
      select: {
        id: true,
        code: true,
        name: true,
        category: { select: { name: true } },
        uom: { select: { symbol: true } },
      },
    })
    for (const i of others) {
      rows.push({
        itemId: i.id,
        code: i.code,
        name: i.name,
        category: i.category.name,
        uom: i.uom.symbol,
        bookQty: 0,
      })
    }
  }

  rows.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))

  const header = await getPrintHeader('COUNT')
  res.json({ success: true, data: { ...header, warehouse, rows, printedAt: new Date() } })
})


// ── A customer's material, and fabric out at a job worker ───────────────────
//
// Two directions that look alike and are not. A customer's fabric is in our
// godown and is not ours: it is held apart from our own balance of the same
// cloth, carries no value, and never reaches the stock figure. Our fabric at a
// job worker is ours the whole time; it has simply moved to a store standing
// for their floor.

const partySelect = { select: { id: true, name: true, code: true } }
const itemLineSelect = {
  select: { id: true, code: true, name: true, hsnCode: true, uom: { select: { symbol: true } } },
}

const customerGrnInclude = {
  customer: partySelect,
  so: { select: { id: true, soNumber: true } },
  warehouse: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  lines: { include: { item: itemLineSelect } },
}

const jobWorkInclude = {
  jobWorker: partySelect,
  fromWarehouse: { select: { id: true, name: true } },
  toWarehouse: { select: { id: true, name: true } },
  sentBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  lines: { include: { item: itemLineSelect } },
  returns: {
    include: {
      receivedBy: { select: { id: true, name: true } },
      lines: {
        include: { item: itemLineSelect, warehouse: { select: { id: true, name: true } } },
      },
    },
    orderBy: { returnDate: 'asc' as const },
  },
}

/**
 * Booking in a customer's material.
 *
 * The rate is zero and that is the whole point. Rule 6.5 says a customer's
 * fabric in our godown is left out of the stock value, and a zero rate achieves
 * that everywhere the ledger is read rather than only on the two screens that
 * remember to filter. The quantity is real; the value is not ours to claim.
 */
/**
 * One customer receipt, written and put on the books: the document, its lines,
 * and a CUSTOMER_OWNED movement for each. Shared by the form and the import,
 * so a receipt from a spreadsheet is checked and booked exactly as one typed in.
 */
async function createCustomerGrn(
  tx: Prisma.TransactionClient,
  data: ReturnType<typeof createCustomerGrnSchema.parse>,
  userId: string | null,
) {
  const when = data.receiptDate ?? new Date()
  const [customer, warehouse] = await Promise.all([
    tx.customer.findUnique({ where: { id: data.customerId }, select: { id: true, name: true, isActive: true } }),
    tx.warehouse.findUnique({ where: { id: data.warehouseId }, select: { id: true, name: true, isActive: true } }),
  ])
  if (!customer) throw new AppError('That customer does not exist', 404, 'NOT_FOUND')
  if (!warehouse) throw new AppError('That store does not exist', 404, 'NOT_FOUND')
  if (!warehouse.isActive) {
    throw new AppError(
      `${warehouse.name} is no longer in use. Pick another store for these goods.`,
      400,
      'WAREHOUSE_INACTIVE',
    )
  }

  if (data.soId) {
    const so = await tx.salesOrder.findUnique({
      where: { id: data.soId },
      select: { id: true, customerId: true, soNumber: true },
    })
    if (!so) throw new AppError('That sales order does not exist', 404, 'NOT_FOUND')
    if (so.customerId !== data.customerId) {
      throw new AppError(
        `${so.soNumber} belongs to a different customer. Pick the right order, or leave it blank.`,
        400,
        'ORDER_NOT_THEIRS',
      )
    }
  }

  const grnNumber = await nextDocumentNumber(tx, 'CGRN', when)

  const created = await tx.customerGRN.create({
    data: {
      grnNumber,
      customerId: data.customerId,
      soId: data.soId ?? null,
      warehouseId: data.warehouseId,
      receiptDate: when,
      challanNumber: data.challanNumber ?? null,
      challanDate: data.challanDate ?? null,
      gateEntryNumber: data.gateEntryNumber ?? null,
      gateEntryDate: data.gateEntryDate ?? null,
      vehicleNo: data.vehicleNo ?? null,
      transporter: data.transporter ?? null,
      notes: data.notes ?? null,
      receivedById: userId,
      lines: {
        create: data.lines.map((l) => ({
          itemId: l.itemId,
          challanQty: l.challanQty,
          receivedQty: l.receivedQty,
          batchNumber: l.batchNumber ?? null,
          markings: l.markings ?? null,
        })),
      },
    },
    include: { lines: true },
  })

  for (const line of created.lines) {
    await recordMovement(tx, {
      itemId: line.itemId,
      warehouseId: data.warehouseId,
      transactionType: 'CUSTOMER_MATERIAL',
      direction: 'IN',
      qty: Number(line.receivedQty),
      // Not ours, so it carries no value to us and never reaches the stock
      // figure or the balance sheet.
      unitRate: 0,
      ownership: 'CUSTOMER_OWNED',
      ownerCustomerId: data.customerId,
      batchNumber: line.batchNumber,
      referenceType: 'CUSTOMER_GRN',
      referenceId: created.id,
      transactionDate: when,
      notes: `${grnNumber}: ${customer.name}`,
    })
  }

  return tx.customerGRN.findUniqueOrThrow({
    where: { id: created.id },
    include: customerGrnInclude,
  })
}

router.post('/customer-grn', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createCustomerGrnSchema.parse(req.body)
  const grn = await prisma.$transaction((tx) => createCustomerGrn(tx, data, req.user?.id ?? null))

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'CustomerGRN',
    entityId: grn.id,
    after: grn,
  })

  const short = grn.lines.reduce(
    (n, l) => n + (Number(l.receivedQty) !== Number(l.challanQty) ? 1 : 0),
    0,
  )

  res.status(201).json({
    success: true,
    message: short
      ? `${grn.grnNumber} saved. ${short} ${short === 1 ? 'line does' : 'lines do'} not match their challan — worth telling ${grn.customer.name}.`
      : `${grn.grnNumber} saved. ${grn.customer.name}'s material is in ${grn.warehouse.name}.`,
    data: grn,
  })
})

router.get('/customer-grn', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

  const where: Record<string, unknown> = {}
  if (str(req.query.customerId)) where.customerId = str(req.query.customerId)
  if (str(req.query.warehouseId)) where.warehouseId = str(req.query.warehouseId)
  if (str(req.query.q)) {
    where.OR = [
      { grnNumber: { contains: str(req.query.q), mode: 'insensitive' } },
      { challanNumber: { contains: str(req.query.q), mode: 'insensitive' } },
      { customer: { name: { contains: str(req.query.q), mode: 'insensitive' } } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.customerGRN.findMany({
      where,
      include: customerGrnInclude,
      orderBy: [{ receiptDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.customerGRN.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

/*
 * Every line of every receipt, one row each, with the receipt's own details
 * and what the item is — for the screen's table, filters, figures and export,
 * which all work on the same rows. Alongside, what of each customer's is still
 * in our stores now, from the ledger. Ahead of /customer-grn/:id.
 */
router.get('/customer-grn/lines', requirePermission(MODULE, 'view'), async (_req, res) => {
  const [receipts, held] = await Promise.all([
    prisma.customerGRN.findMany({
      orderBy: [{ receiptDate: 'desc' }, { createdAt: 'desc' }],
      take: 2000,
      include: {
        customer: { select: { id: true, name: true } },
        so: { select: { id: true, soNumber: true } },
        warehouse: { select: { id: true, name: true } },
        receivedBy: { select: { id: true, name: true } },
        lines: {
          include: {
            item: {
              select: {
                id: true, code: true, name: true, type: true, uom: { select: { symbol: true } },
                category: { select: { id: true, name: true, parent: { select: { id: true, name: true } } } },
                department: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    }),
    onHand(prisma, { ownership: 'CUSTOMER_OWNED' }),
  ])

  type ItemAbout = {
    type: string
    category: { id: string; name: string; parent: { id: string; name: string } | null }
    department: { id: string; name: string } | null
  }
  const about = (it: ItemAbout) => ({
    itemType: it.type,
    mainCategoryId: it.category.parent?.id ?? it.category.id,
    mainCategoryName: it.category.parent?.name ?? it.category.name,
    subCategoryId: it.category.parent ? it.category.id : null,
    subCategoryName: it.category.parent ? it.category.name : null,
    departmentId: it.department?.id ?? null,
    departmentName: it.department?.name ?? null,
  })

  const data = receipts.flatMap((r) =>
    r.lines.map((l) => ({
      id: l.id,
      receiptId: r.id,
      grnNumber: r.grnNumber,
      receiptDate: r.receiptDate,
      challanNumber: r.challanNumber,
      challanDate: r.challanDate,
      gateEntryNumber: r.gateEntryNumber,
      vehicleNo: r.vehicleNo,
      transporter: r.transporter,
      notes: r.notes,
      cancelledAt: r.cancelledAt,
      cancelReason: r.cancelReason,
      customerId: r.customer.id,
      customerName: r.customer.name,
      soNumber: r.so?.soNumber ?? null,
      warehouseId: r.warehouse.id,
      warehouseName: r.warehouse.name,
      receivedByName: r.receivedBy?.name ?? null,
      lineCount: r.lines.length,
      itemId: l.item.id,
      itemCode: l.item.code,
      itemName: l.item.name,
      uom: l.item.uom?.symbol ?? '',
      ...about(l.item),
      challanQty: Number(l.challanQty),
      receivedQty: Number(l.receivedQty),
      batchNumber: l.batchNumber,
      markings: l.markings,
    })),
  )

  const heldIds = [...new Set(held.map((h) => h.itemId))]
  const heldItems = await prisma.item.findMany({
    where: { id: { in: heldIds } },
    select: {
      id: true, type: true,
      category: { select: { id: true, name: true, parent: { select: { id: true, name: true } } } },
      department: { select: { id: true, name: true } },
    },
  })
  const heldAbout = new Map(heldItems.map((i) => [i.id, about(i)]))

  res.json({
    success: true,
    data,
    held: held.map((h) => ({
      itemId: h.itemId,
      itemCode: h.itemCode,
      itemName: h.itemName,
      uom: h.uom,
      warehouseId: h.warehouseId,
      warehouseName: h.warehouseName,
      customerId: h.ownerCustomerId,
      customerName: h.ownerName,
      qty: h.qty,
      lastMovedAt: h.lastMovedAt,
      ...heldAbout.get(h.itemId),
    })),
  })
})

// ── Customer receipts from a spreadsheet ────────────────────────────────────

router.get('/customer-grn/import-template', requirePermission(MODULE, 'create'), async (req, res) => {
  const withCurrent = req.query.withCurrent === 'true'
  const buffer = await customerMaterialImport.buildTemplate(withCurrent)
  const name = withCurrent ? 'customer-material-with-receipts.xlsx' : 'customer-material-import-template.xlsx'
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.send(buffer)
})

router.post('/customer-grn/import', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const { fileName, file, confirm } = customerMaterialImport.importBody.parse(req.body)
  const rows = await customerMaterialImport.readSheet(Buffer.from(file, 'base64'), fileName)
  const { plans, receipts } = await customerMaterialImport.planImport(rows)
  const summary = {
    rows: plans.length,
    receipts: receipts.length,
    lines: receipts.reduce((n, r) => n + (r.lines as unknown[]).length, 0),
    skipped: plans.filter((p) => p.skipped).length,
    problems: plans.filter((p) => p.problems.length > 0).length,
  }
  if (!confirm) return res.json({ success: true, data: { summary, rows: plans } })
  if (summary.problems) {
    throw new AppError('Some rows have problems. Fix them in the sheet and try again; nothing was imported.', 400, 'IMPORT_PROBLEMS')
  }

  // All or nothing: one bad receipt and none of them are booked.
  const created = await prisma.$transaction(
    async (tx) => {
      const out: Array<{ code: string; name: string }> = []
      for (const r of receipts) {
        const grn = await createCustomerGrn(tx, createCustomerGrnSchema.parse(r), req.user?.id ?? null)
        out.push({ code: grn.grnNumber, name: `${grn.customer.name} · ${grn.lines.length} ${grn.lines.length === 1 ? 'item' : 'items'}` })
      }
      return out
    },
    { timeout: 120000, maxWait: 20000 },
  )

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'CustomerGRNImport',
    entityId: `IMPORT-${Date.now()}`,
    after: { fileName, created },
  })
  res.status(201).json({
    success: true,
    message: created.length
      ? `Imported ${created.length} ${created.length === 1 ? 'receipt' : 'receipts'}.`
      : 'Nothing to import: every receipt in the sheet is already in the system.',
    data: { summary, created },
  })
})

router.get('/customer-grn/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const row = await prisma.customerGRN.findUnique({
    where: { id: req.params.id },
    include: customerGrnInclude,
  })
  if (!row) throw new AppError('That receipt does not exist', 404, 'NOT_FOUND')
  res.json({ success: true, data: row })
})

/**
 * Sending a customer's material back out again because the receipt was wrong.
 *
 * If any of it has already been issued to the floor the stock service refuses
 * and says how much is actually left, which is the right answer: the cloth is
 * cut, and a tidy document would not put it back together.
 */
router.patch(
  '/customer-grn/:id/cancel',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { reason } = cancelCustomerGrnSchema.parse(req.body ?? {})

    const after = await prisma.$transaction(async (tx) => {
      const before = await tx.customerGRN.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!before) throw new AppError('That receipt does not exist', 404, 'NOT_FOUND')
      if (before.cancelledAt) {
        throw new AppError(
          `${before.grnNumber} was already cancelled on ${before.cancelledAt.toLocaleDateString('en-IN')}.`,
          400,
          'ALREADY_CANCELLED',
        )
      }

      for (const line of before.lines) {
        const qty = Number(line.receivedQty)
        if (qty <= 0) continue

        await recordMovement(tx, {
          itemId: line.itemId,
          warehouseId: before.warehouseId,
          transactionType: 'RETURN',
          direction: 'OUT',
          qty,
          ownership: 'CUSTOMER_OWNED',
          ownerCustomerId: before.customerId,
          referenceType: 'CUSTOMER_GRN_CANCELLED',
          referenceId: before.id,
          transactionDate: new Date(),
          notes: `${before.grnNumber} cancelled: ${reason}`,
        })
      }

      return tx.customerGRN.update({
        where: { id: before.id },
        data: {
          cancelledAt: new Date(),
          cancelledById: req.user?.id ?? null,
          cancelReason: reason,
        },
        include: customerGrnInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'CustomerGRN',
      entityId: after.id,
      after,
    })

    res.json({
      success: true,
      message: `${after.grnNumber} cancelled and the material taken back off the books.`,
      data: after,
    })
  },
)

// ── A customer's material going back to them ────────────────────────────────

const RETURN_REASON_LABEL: Record<string, string> = {
  LEFTOVER: 'Left over after their order',
  REJECTED: 'Rejected at inspection',
  EXCESS: 'More than their challan',
  OTHER: 'Other',
}

/**
 * Sending a customer's own material back to them unworked.
 *
 * Every line moves CUSTOMER_OWNED stock of that customer out of the one store.
 * The stock service refuses more than their balance there and names what is
 * left, so a return can never take our own cloth, or another customer's.
 */
router.post('/customer-return', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createCustomerReturnSchema.parse(req.body)
  const when = data.returnDate ?? new Date()

  const created = await prisma.$transaction(async (tx) => {
    const [customer, warehouse] = await Promise.all([
      tx.customer.findUnique({ where: { id: data.customerId }, select: { id: true, name: true } }),
      tx.warehouse.findUnique({ where: { id: data.warehouseId }, select: { id: true, name: true } }),
    ])
    if (!customer) throw new AppError('That customer does not exist', 404, 'NOT_FOUND')
    if (!warehouse) throw new AppError('That store does not exist', 404, 'NOT_FOUND')

    if (data.grnId) {
      const grn = await tx.customerGRN.findUnique({
        where: { id: data.grnId },
        select: { customerId: true, grnNumber: true, cancelledAt: true },
      })
      if (!grn) throw new AppError('That receipt does not exist', 404, 'NOT_FOUND')
      if (grn.customerId !== data.customerId) {
        throw new AppError(`${grn.grnNumber} is a different customer's receipt.`, 400, 'RECEIPT_NOT_THEIRS')
      }
      if (grn.cancelledAt) {
        throw new AppError(`${grn.grnNumber} was cancelled, so nothing came in on it.`, 400, 'RECEIPT_CANCELLED')
      }
    }

    const items = await tx.item.findMany({
      where: { id: { in: data.lines.map((l) => l.itemId) } },
      select: { id: true, hsnCode: true },
    })
    const hsnOf = new Map(items.map((i) => [i.id, i.hsnCode]))

    const returnNumber = await nextDocumentNumber(tx, 'CMR', when)
    const doc = await tx.customerMaterialReturn.create({
      data: {
        returnNumber,
        customerId: data.customerId,
        grnId: data.grnId ?? null,
        warehouseId: data.warehouseId,
        returnDate: when,
        reason: data.reason,
        vehicleNo: data.vehicleNo ?? null,
        transporter: data.transporter ?? null,
        lrNumber: data.lrNumber ?? null,
        notes: data.notes ?? null,
        createdById: req.user?.id ?? null,
        lines: {
          create: data.lines.map((l) => ({
            itemId: l.itemId,
            qty: l.qty,
            hsnCode: hsnOf.get(l.itemId) ?? null,
            notes: l.notes ?? null,
          })),
        },
      },
      include: { lines: true },
    })

    for (const line of doc.lines) {
      await recordMovement(tx, {
        itemId: line.itemId,
        warehouseId: data.warehouseId,
        transactionType: 'RETURN',
        direction: 'OUT',
        qty: Number(line.qty),
        ownership: 'CUSTOMER_OWNED',
        ownerCustomerId: data.customerId,
        referenceType: 'CUSTOMER_RETURN',
        referenceId: doc.id,
        transactionDate: when,
        notes: `${returnNumber}: back to ${customer.name} (${RETURN_REASON_LABEL[data.reason].toLowerCase()})`,
      })
    }

    return { ...doc, customerName: customer.name }
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'CustomerMaterialReturn',
    entityId: created.id,
    after: created,
  })

  res.status(201).json({
    success: true,
    message: `${created.returnNumber} saved. ${created.lines.length} ${created.lines.length === 1 ? 'item has' : 'items have'} gone back to ${created.customerName} and off our books.`,
    data: created,
  })
})

/*
 * Every line of every return, one row each, with the return's details and
 * what the item is — for the Returns tab, its filters, figures and export.
 */
router.get('/customer-return/lines', requirePermission(MODULE, 'view'), async (_req, res) => {
  const returns = await prisma.customerMaterialReturn.findMany({
    orderBy: [{ returnDate: 'desc' }, { createdAt: 'desc' }],
    take: 2000,
    include: {
      customer: { select: { id: true, name: true } },
      grn: { select: { id: true, grnNumber: true } },
      warehouse: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      lines: {
        include: {
          item: {
            select: {
              id: true, code: true, name: true, uom: { select: { symbol: true } },
              category: { select: { id: true, name: true, parent: { select: { id: true, name: true } } } },
              department: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  })

  const data = returns.flatMap((r) =>
    r.lines.map((l) => ({
      id: l.id,
      returnId: r.id,
      returnNumber: r.returnNumber,
      returnDate: r.returnDate,
      reason: r.reason,
      reasonLabel: RETURN_REASON_LABEL[r.reason] ?? r.reason,
      grnNumber: r.grn?.grnNumber ?? null,
      vehicleNo: r.vehicleNo,
      transporter: r.transporter,
      lrNumber: r.lrNumber,
      notes: r.notes,
      cancelledAt: r.cancelledAt,
      cancelReason: r.cancelReason,
      customerId: r.customer.id,
      customerName: r.customer.name,
      warehouseId: r.warehouse.id,
      warehouseName: r.warehouse.name,
      createdByName: r.createdBy?.name ?? null,
      lineCount: r.lines.length,
      itemId: l.item.id,
      itemCode: l.item.code,
      itemName: l.item.name,
      uom: l.item.uom?.symbol ?? '',
      hsnCode: l.hsnCode,
      mainCategoryId: l.item.category.parent?.id ?? l.item.category.id,
      mainCategoryName: l.item.category.parent?.name ?? l.item.category.name,
      subCategoryName: l.item.category.parent ? l.item.category.name : null,
      departmentId: l.item.department?.id ?? null,
      departmentName: l.item.department?.name ?? null,
      qty: Number(l.qty),
      lineNotes: l.notes,
    })),
  )

  res.json({ success: true, data })
})

/**
 * The delivery challan that goes with the customer's material. Under Rule 55
 * a movement that is not a supply still travels on a challan naming both
 * parties, with each item's HSN and quantity.
 */
router.get('/customer-return/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const doc = await prisma.customerMaterialReturn.findUnique({
    where: { id: req.params.id },
    include: {
      customer: {
        select: {
          id: true, name: true, code: true, gstin: true, phone: true,
          billingAddress: true, billingCity: true, billingState: true, billingStateCode: true, billingPincode: true,
          shippingAddress: true, shippingCity: true, shippingState: true, shippingStateCode: true, shippingPincode: true,
        },
      },
      grn: { select: { grnNumber: true, receiptDate: true, challanNumber: true, challanDate: true } },
      warehouse: { select: { id: true, name: true, address: true } },
      createdBy: { select: { id: true, name: true } },
      cancelledBy: { select: { id: true, name: true } },
      lines: { include: { item: itemLineSelect } },
    },
  })
  if (!doc) throw new AppError('That return does not exist', 404, 'NOT_FOUND')

  const header = await getPrintHeader('CMR')
  res.json({ success: true, data: { ...header, doc: { ...doc, reasonLabel: RETURN_REASON_LABEL[doc.reason] ?? doc.reason } } })
})

/**
 * Taking a return back: the lorry never left, or the customer sent it back.
 * The material comes back onto our racks under the customer's name.
 */
router.patch(
  '/customer-return/:id/cancel',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { reason } = cancelCustomerReturnSchema.parse(req.body ?? {})

    const after = await prisma.$transaction(async (tx) => {
      const before = await tx.customerMaterialReturn.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!before) throw new AppError('That return does not exist', 404, 'NOT_FOUND')
      if (before.cancelledAt) {
        throw new AppError(
          `${before.returnNumber} was already cancelled on ${before.cancelledAt.toLocaleDateString('en-IN')}.`,
          400,
          'ALREADY_CANCELLED',
        )
      }

      for (const line of before.lines) {
        await recordMovement(tx, {
          itemId: line.itemId,
          warehouseId: before.warehouseId,
          transactionType: 'CUSTOMER_MATERIAL',
          direction: 'IN',
          qty: Number(line.qty),
          unitRate: 0,
          ownership: 'CUSTOMER_OWNED',
          ownerCustomerId: before.customerId,
          referenceType: 'CUSTOMER_RETURN_CANCELLED',
          referenceId: before.id,
          transactionDate: new Date(),
          notes: `${before.returnNumber} cancelled: ${reason}`,
        })
      }

      return tx.customerMaterialReturn.update({
        where: { id: before.id },
        data: { cancelledAt: new Date(), cancelledById: req.user?.id ?? null, cancelReason: reason },
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'CustomerMaterialReturn',
      entityId: after.id,
      after,
    })

    res.json({
      success: true,
      message: `${after.returnNumber} cancelled. The material is back on our racks under the customer's name.`,
      data: after,
    })
  },
)

/**
 * Sending our own fabric out to an outside unit.
 *
 * The stock does not leave the ledger — it moves to a store standing for that
 * unit's floor, because rule 6.5 says fabric at a job worker is still ours and
 * rule 6.4 says stock always lives in a warehouse. Which means the whole
 * existing machinery answers "how much of ours is sitting at Ritesh Enterprises"
 * with no new reporting at all.
 */
router.post('/job-work', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createJobWorkChallanSchema.parse(req.body)
  const when = data.challanDate ?? new Date()

  const challan = await prisma.$transaction(async (tx) => {
    const [worker, from, to] = await Promise.all([
      tx.supplier.findUnique({
        where: { id: data.jobWorkerId },
        select: { id: true, name: true, isActive: true },
      }),
      tx.warehouse.findUnique({ where: { id: data.fromWarehouseId }, select: { id: true, name: true } }),
      tx.warehouse.findUnique({
        where: { id: data.toWarehouseId },
        select: { id: true, name: true, isActive: true },
      }),
    ])
    if (!worker) throw new AppError('That job worker does not exist', 404, 'NOT_FOUND')
    if (!from || !to) throw new AppError('One of those stores does not exist', 404, 'NOT_FOUND')
    if (!to.isActive) {
      throw new AppError(`${to.name} is no longer in use.`, 400, 'WAREHOUSE_INACTIVE')
    }

    const challanNumber = await nextDocumentNumber(tx, 'JW', when)

    // The HSN is copied onto the line now. A job work challan has to carry it,
    // and correcting the item master next month must not change what a challan
    // already sent out says.
    const items = await tx.item.findMany({
      where: { id: { in: data.lines.map((l) => l.itemId) } },
      select: { id: true, hsnCode: true },
    })
    const hsnOf = new Map(items.map((i) => [i.id, i.hsnCode]))

    const created = await tx.jobWorkChallan.create({
      data: {
        challanNumber,
        jobWorkerId: data.jobWorkerId,
        process: data.process,
        fromWarehouseId: data.fromWarehouseId,
        toWarehouseId: data.toWarehouseId,
        challanDate: when,
        expectedBackOn: data.expectedBackOn ?? null,
        vehicleNo: data.vehicleNo ?? null,
        transporter: data.transporter ?? null,
        lrNumber: data.lrNumber ?? null,
        notes: data.notes ?? null,
        sentById: req.user?.id ?? null,
        lines: {
          create: data.lines.map((l) => ({
            itemId: l.itemId,
            qty: l.qty,
            hsnCode: hsnOf.get(l.itemId) ?? null,
          })),
        },
      },
      include: { lines: true },
    })

    for (const line of created.lines) {
      const carried = await balanceOf(tx, {
        itemId: line.itemId,
        warehouseId: data.fromWarehouseId,
      })

      await transferStock(tx, {
        itemId: line.itemId,
        fromWarehouseId: data.fromWarehouseId,
        toWarehouseId: data.toWarehouseId,
        qty: Number(line.qty),
        referenceType: 'JOB_WORK_CHALLAN',
        referenceId: created.id,
        transactionDate: when,
        notes: `${challanNumber}: ${data.process} at ${worker.name}`,
      })

      await tx.jobWorkChallanLine.update({
        where: { id: line.id },
        data: { unitRate: carried.avgRate },
      })
    }

    return tx.jobWorkChallan.findUniqueOrThrow({
      where: { id: created.id },
      include: jobWorkInclude,
    })
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'JobWorkChallan',
    entityId: challan.id,
    after: challan,
  })

  res.status(201).json({
    success: true,
    message: `${challan.challanNumber} saved. ${challan.lines.length} ${challan.lines.length === 1 ? 'item is' : 'items are'} now at ${challan.jobWorker.name} and still ours.`,
    data: challan,
  })
})

router.get('/job-work', requirePermission(MODULE, 'view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))

  const where: Record<string, unknown> = {}
  if (str(req.query.jobWorkerId)) where.jobWorkerId = str(req.query.jobWorkerId)
  if (str(req.query.status)) where.status = str(req.query.status)
  if (str(req.query.q)) {
    where.OR = [
      { challanNumber: { contains: str(req.query.q), mode: 'insensitive' } },
      { process: { contains: str(req.query.q), mode: 'insensitive' } },
      { jobWorker: { name: { contains: str(req.query.q), mode: 'insensitive' } } },
    ]
  }

  const [rows, total] = await Promise.all([
    prisma.jobWorkChallan.findMany({
      where,
      include: jobWorkInclude,
      orderBy: [{ challanDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.jobWorkChallan.count({ where }),
  ])

  res.json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  })
})

/*
 * Every line of every job-work challan, one row each: the challan's details,
 * what the item is, and how much of it has been settled by returns, wasted,
 * and is still out. The screen's table, filters, figures, export and dashboard
 * all read these same rows. Ahead of /job-work/:id.
 */
router.get('/job-work/lines', requirePermission(MODULE, 'view'), async (_req, res) => {
  const challans = await prisma.jobWorkChallan.findMany({
    orderBy: [{ challanDate: 'desc' }, { createdAt: 'desc' }],
    take: 2000,
    include: {
      jobWorker: { select: { id: true, name: true, code: true, city: true } },
      fromWarehouse: { select: { id: true, name: true } },
      toWarehouse: { select: { id: true, name: true } },
      sentBy: { select: { id: true, name: true } },
      lines: {
        include: {
          item: {
            select: {
              id: true, code: true, name: true, type: true, uom: { select: { symbol: true } },
              category: { select: { id: true, name: true, parent: { select: { id: true, name: true } } } },
              department: { select: { id: true, name: true } },
            },
          },
          returnLines: {
            include: {
              item: { select: { id: true, name: true, uom: { select: { symbol: true } } } },
              jobWorkReturn: { select: { returnNumber: true, returnDate: true } },
            },
          },
        },
      },
    },
  })

  const r3 = (v: number) => Math.round(v * 1000) / 1000
  const data = challans.flatMap((c) =>
    c.lines.map((l) => {
      const it = l.item
      const sent = Number(l.qty)
      const settled = l.returnLines.reduce((t, r) => t + Number(r.consumedQty), 0)
      const wasted = l.returnLines.reduce((t, r) => t + Number(r.wastedQty), 0)
      // What came back as itself, and what came back made into something else.
      const madeBy = new Map<string, { itemName: string; uom: string; qty: number }>()
      for (const r of l.returnLines) {
        if (r.itemId === l.itemId) continue
        const cur = madeBy.get(r.itemId) ?? { itemName: r.item.name, uom: r.item.uom?.symbol ?? '', qty: 0 }
        cur.qty += Number(r.receivedQty)
        madeBy.set(r.itemId, cur)
      }
      const dates = l.returnLines.map((r) => r.jobWorkReturn.returnDate.getTime())
      return {
        id: l.id,
        challanId: c.id,
        challanNumber: c.challanNumber,
        challanDate: c.challanDate,
        process: c.process,
        status: c.status,
        cancelReason: c.cancelReason,
        expectedBackOn: c.expectedBackOn,
        vehicleNo: c.vehicleNo,
        transporter: c.transporter,
        lrNumber: c.lrNumber,
        notes: c.notes,
        sentByName: c.sentBy?.name ?? null,
        lineCount: c.lines.length,
        jobWorkerId: c.jobWorker.id,
        jobWorkerName: c.jobWorker.name,
        jobWorkerCity: c.jobWorker.city,
        fromWarehouseId: c.fromWarehouse.id,
        fromWarehouseName: c.fromWarehouse.name,
        toWarehouseId: c.toWarehouse.id,
        toWarehouseName: c.toWarehouse.name,
        itemId: it.id,
        itemCode: it.code,
        itemName: it.name,
        itemType: it.type,
        uom: it.uom?.symbol ?? '',
        hsnCode: l.hsnCode,
        mainCategoryId: it.category.parent?.id ?? it.category.id,
        mainCategoryName: it.category.parent?.name ?? it.category.name,
        subCategoryId: it.category.parent ? it.category.id : null,
        subCategoryName: it.category.parent ? it.category.name : null,
        departmentId: it.department?.id ?? null,
        departmentName: it.department?.name ?? null,
        sentQty: sent,
        unitRate: Number(l.unitRate ?? 0),
        settledQty: r3(settled),
        backSameQty: r3(l.returnLines.filter((r) => r.itemId === l.itemId).reduce((t, r) => t + Number(r.receivedQty), 0)),
        madeInto: [...madeBy.values()].map((m) => ({ ...m, qty: r3(m.qty) })),
        wastedQty: r3(wasted),
        // A cancelled challan brought everything back to the store it left.
        stillOutQty: c.status === 'CANCELLED' ? 0 : Math.max(0, r3(sent - settled)),
        returnNumbers: [...new Set(l.returnLines.map((r) => r.jobWorkReturn.returnNumber))],
        lastReturnAt: dates.length ? new Date(Math.max(...dates)) : null,
        // Each return on its own day, for charting what came back when.
        settledBy: l.returnLines.map((r) => ({ at: r.jobWorkReturn.returnDate, qty: Number(r.consumedQty) })),
      }
    }),
  )

  res.json({ success: true, data })
})

/**
 * The delivery challan that travels with our goods to a job worker.
 *
 * Rule 55 of the CGST Rules asks it to name both parties with their GSTIN and
 * address, and each item with its HSN, quantity and value — without it the
 * movement reads as a taxable sale. Everything the page prints comes in this
 * one call, letterhead included.
 */
router.get('/job-work/:id/print', requirePermission(MODULE, 'view'), async (req, res) => {
  const challan = await prisma.jobWorkChallan.findUnique({
    where: { id: req.params.id },
    include: {
      jobWorker: {
        select: {
          id: true, name: true, code: true, gstin: true, phone: true, address: true,
          city: true, state: true, stateCode: true, pincode: true,
        },
      },
      fromWarehouse: { select: { id: true, name: true, address: true } },
      toWarehouse: { select: { id: true, name: true } },
      sentBy: { select: { id: true, name: true } },
      cancelledBy: { select: { id: true, name: true } },
      lines: { include: { item: itemLineSelect } },
    },
  })
  if (!challan) throw new AppError('That challan does not exist', 404, 'NOT_FOUND')

  const header = await getPrintHeader('JW')
  res.json({ success: true, data: { ...header, challan } })
})

router.get('/job-work/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  const row = await prisma.jobWorkChallan.findUnique({
    where: { id: req.params.id },
    include: jobWorkInclude,
  })
  if (!row) throw new AppError('That challan does not exist', 404, 'NOT_FOUND')
  res.json({ success: true, data: row })
})

/**
 * How much of each challan line is still out, counted from the returns rather
 * than kept as a running total on the line — the same reasoning as the purchase
 * order's received quantity. A counter and the documents it counts drift apart
 * the first time one is cancelled.
 */
async function stillOut(tx: Prisma.TransactionClient, challanId: string) {
  const challan = await tx.jobWorkChallan.findUnique({
    where: { id: challanId },
    include: { lines: { include: { item: { select: { name: true } } } } },
  })
  if (!challan) throw new AppError('That challan does not exist', 404, 'NOT_FOUND')

  const sums = await tx.jobWorkReturnLine.groupBy({
    by: ['challanLineId'],
    where: { challanLineId: { in: challan.lines.map((l) => l.id) } },
    _sum: { consumedQty: true },
  })
  const consumed = new Map(sums.map((s) => [s.challanLineId, Number(s._sum.consumedQty ?? 0)]))

  return challan.lines.map((l) => ({
    line: l,
    consumed: consumed.get(l.id) ?? 0,
    outstanding: round3(Number(l.qty) - (consumed.get(l.id) ?? 0)),
  }))
}

/**
 * Goods coming back from an outside unit.
 *
 * Two movements per line, not one, because what comes back is often not what
 * went out: forty metres of fabric return as three hundred cut panels. The
 * material consumed leaves the job worker's balance and whatever arrived comes
 * into ours, and the value of the one carries into the other so nothing is
 * created or destroyed by the conversion. What the unit could not return at all
 * is named as waste rather than quietly absorbed.
 */
router.post(
  '/job-work/:id/returns',
  requirePermission(MODULE, 'create'),
  async (req: AuthRequest, res) => {
    const data = createJobWorkReturnSchema.parse({ ...req.body, challanId: req.params.id })
    const when = data.returnDate ?? new Date()

    const result = await prisma.$transaction(async (tx) => {
      const challan = await tx.jobWorkChallan.findUnique({
        where: { id: req.params.id },
        include: { lines: { include: { item: { select: { name: true } } } }, jobWorker: true },
      })
      if (!challan) throw new AppError('That challan does not exist', 404, 'NOT_FOUND')
      if (challan.cancelledAt) {
        throw new AppError(
          `${challan.challanNumber} was cancelled, so nothing can come back against it.`,
          400,
          'CHALLAN_CANCELLED',
        )
      }

      const outstanding = new Map(
        (await stillOut(tx, challan.id)).map((o) => [o.line.id, o]),
      )

      // Check every line before writing anything, so a return does not book
      // three lines in and then refuse the fourth.
      for (const line of data.lines) {
        const o = outstanding.get(line.challanLineId)
        if (!o) {
          throw new AppError(
            `One of those lines is not on ${challan.challanNumber}.`,
            400,
            'LINE_NOT_ON_CHALLAN',
          )
        }
        if (round3(line.consumedQty) > o.outstanding) {
          throw new AppError(
            o.outstanding > 0
              ? `${o.line.item.name}: only ${o.outstanding} is still out at ${challan.jobWorker.name}, and you are settling ${line.consumedQty}.`
              : `${o.line.item.name}: everything sent has already come back.`,
            400,
            'OVER_RETURN',
          )
        }
      }

      const returnNumber = await nextDocumentNumber(tx, 'JWR', when)

      const created = await tx.jobWorkReturn.create({
        data: {
          returnNumber,
          challanId: challan.id,
          returnDate: when,
          vehicleNo: data.vehicleNo ?? null,
          lrNumber: data.lrNumber ?? null,
          theirChallanNo: data.theirChallanNo ?? null,
          notes: data.notes ?? null,
          receivedById: req.user?.id ?? null,
          lines: {
            create: data.lines.map((l) => ({
              challanLineId: l.challanLineId,
              consumedQty: l.consumedQty,
              itemId: l.itemId,
              receivedQty: l.receivedQty,
              wastedQty: l.wastedQty ?? 0,
              warehouseId: l.warehouseId,
              notes: l.notes ?? null,
            })),
          },
        },
        include: { lines: true },
      })

      for (const line of created.lines) {
        const o = outstanding.get(line.challanLineId)!
        const consumed = Number(line.consumedQty)
        const received = Number(line.receivedQty)

        // What was used up leaves the unit's floor. The stock service prices
        // this at the running average, which is what it left our store at.
        const out = await recordMovement(tx, {
          itemId: o.line.itemId,
          warehouseId: challan.toWarehouseId,
          transactionType: 'PRODUCTION',
          direction: 'OUT',
          qty: consumed,
          referenceType: 'JOB_WORK_RETURN',
          referenceId: created.id,
          transactionDate: when,
          notes: `${returnNumber} against ${challan.challanNumber}`,
        })

        if (received <= 0) continue

        // Whatever arrived comes into our store, carrying the value of the
        // material it was made from. Forty metres at ₹200 returning as three
        // hundred panels makes each panel worth ₹26.67, and the mill's stock
        // value does not move because cloth was cut.
        const carriedValue = round2(consumed * out.unitRate)

        await recordMovement(tx, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          transactionType: 'PRODUCTION',
          direction: 'IN',
          qty: received,
          unitRate: round2(carriedValue / received),
          referenceType: 'JOB_WORK_RETURN',
          referenceId: created.id,
          transactionDate: when,
          notes: `${returnNumber}: ${challan.process} at ${challan.jobWorker.name}`,
        })
      }

      // Closed only when nothing is still out. Counted again after the writes
      // rather than worked out from what we just did.
      const after = await stillOut(tx, challan.id)
      const anyOut = after.some((o) => o.outstanding > 0)
      const anyBack = after.some((o) => o.consumed > 0)

      await tx.jobWorkChallan.update({
        where: { id: challan.id },
        data: { status: anyOut ? (anyBack ? 'PARTLY_BACK' : 'SENT') : 'CLOSED' },
      })

      return {
        challan: await tx.jobWorkChallan.findUniqueOrThrow({
          where: { id: challan.id },
          include: jobWorkInclude,
        }),
        returnNumber,
      }
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'CREATE',
      entityType: 'JobWorkReturn',
      entityId: result.challan.id,
      after: result.challan,
    })

    res.status(201).json({
      success: true,
      message:
        result.challan.status === 'CLOSED'
          ? `${result.returnNumber} saved. Everything sent on ${result.challan.challanNumber} is now back.`
          : `${result.returnNumber} saved. Some of ${result.challan.challanNumber} is still out.`,
      data: result.challan,
    })
  },
)

/**
 * Cancelling a challan walks the goods back from the job worker's floor.
 *
 * Refused once anything has come back against it: the consignment is part
 * finished, and unpicking it with one button would be a lie about what happened.
 */
router.patch(
  '/job-work/:id/cancel',
  requirePermission(MODULE, 'edit'),
  async (req: AuthRequest, res) => {
    const { reason } = cancelJobWorkChallanSchema.parse(req.body ?? {})

    const after = await prisma.$transaction(async (tx) => {
      const before = await tx.jobWorkChallan.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!before) throw new AppError('That challan does not exist', 404, 'NOT_FOUND')
      if (before.cancelledAt) {
        throw new AppError(`${before.challanNumber} is already cancelled.`, 400, 'ALREADY_CANCELLED')
      }

      const returned = await tx.jobWorkReturn.count({ where: { challanId: before.id } })
      if (returned > 0) {
        throw new AppError(
          `Some of ${before.challanNumber} has already come back, so it cannot be cancelled. Record what is left as a return instead.`,
          400,
          'ALREADY_PARTLY_BACK',
        )
      }

      for (const line of before.lines) {
        await transferStock(tx, {
          itemId: line.itemId,
          fromWarehouseId: before.toWarehouseId,
          toWarehouseId: before.fromWarehouseId,
          qty: Number(line.qty),
          referenceType: 'JOB_WORK_CHALLAN_CANCELLED',
          referenceId: before.id,
          transactionDate: new Date(),
          notes: `${before.challanNumber} cancelled: ${reason}`,
        })
      }

      return tx.jobWorkChallan.update({
        where: { id: before.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledById: req.user?.id ?? null,
          cancelReason: reason,
        },
        include: jobWorkInclude,
      })
    })

    await writeAuditLog(req, {
      module: MODULE,
      action: 'UPDATE',
      entityType: 'JobWorkChallan',
      entityId: after.id,
      after,
    })

    res.json({
      success: true,
      message: `${after.challanNumber} cancelled and the goods brought back to ${after.fromWarehouse.name}.`,
      data: after,
    })
  },
)

export default router
