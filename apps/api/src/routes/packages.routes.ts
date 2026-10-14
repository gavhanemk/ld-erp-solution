import { Router } from 'express'
import { z } from 'zod'
import { prisma, type Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { createTransfer, issueRequisition } from './inventory.routes'
import {
  createPackages,
  lockPackage,
  normaliseCode,
  normaliseRack,
  packageRule,
  positionOf,
  recordPackageMove,
  round3,
  packageRules,
  positionsOf,
  racksIn,
  setRack,
  stickerDefaultsFrom,
  suggestQtys,
  trackedCategoryIds,
  type PackageSource,
} from '../services/package.service'
import { OUTWARD, OUTWARD_TYPES, loadOutward } from '../services/outward.service'
import { INWARD_SOURCES, autoStickers, labelGroup, planStickers, restickStickers, sourceRefOf } from '../services/stickers.service'
import { lockedBalanceOf } from '../services/stock.service'
import { findOptions, findPackages, findSchema } from '../services/packageFind.service'

/*
 * Labelled packages of stock and what is done to them by scanning.
 *
 * Every action that moves stock goes through the same code as the screens
 * that do it without a scanner — an issue is a requisition issue, a move is a
 * stock transfer — so a scan can never do what the store could not.
 */

const router = Router()
const MODULE = 'inventory'

const PACK_TYPES = ['BOX', 'ROLL', 'CARTON', 'BAG', 'BUNDLE', 'PACKET', 'OTHER'] as const
const qty = z.number({ invalid_type_error: 'Quantity has to be a number' }).positive('Quantity has to be more than nought')

/** One item's stickers in one store. */
const groupSchema = z.object({
  itemId: z.string().min(1, 'Choose the item'),
  warehouseId: z.string().min(1, 'Choose the store'),
  ownership: z.enum(['OWNED', 'CUSTOMER_OWNED']).default('OWNED'),
  ownerCustomerId: z.string().optional().nullable(),
  packType: z.enum(PACK_TYPES),
  qtys: z.array(qty).min(1, 'Enter at least one package').max(500, 'Up to 500 packages at a time'),
  lotNo: z.string().max(50).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  grnLineId: z.string().optional().nullable(),
  /** Keep this pack type and quantity as the item's own, for next time. */
  remember: z.boolean().optional().default(false),
})

const planSchema = z.object({
  sourceType: z.enum(INWARD_SOURCES),
  sourceId: z.string().min(1),
  /**
   * What came in, when the document alone cannot say: a requisition can be
   * returned to more than once, and its ledger rows share its id.
   */
  lines: z
    .array(
      z.object({
        itemId: z.string().min(1),
        warehouseId: z.string().min(1),
        ownership: z.enum(['OWNED', 'CUSTOMER_OWNED']).default('OWNED'),
        ownerCustomerId: z.string().optional().nullable(),
        qty,
        lotNo: z.string().max(50).optional().nullable(),
      }),
    )
    .max(200)
    .optional(),
})
const batchSchema = z
  .object({
    sourceType: z.enum(INWARD_SOURCES),
    sourceId: z.string().min(1),
    groups: z.array(groupSchema).min(1, 'Choose at least one item to label').max(100),
  })
  .refine((d) => d.groups.reduce((s, g) => s + g.qtys.length, 0) <= 500, { message: 'Up to 500 stickers at a time', path: ['groups'] })
/** Stock that went out: the document, and for an issue made more than once, what this one handed over. */
const outwardSchema = z.object({
  type: z.enum(OUTWARD_TYPES),
  id: z.string().min(1),
  q: z.string().max(4000).optional().nullable(),
})
const outwardApplySchema = outwardSchema.extend({
  takes: z.array(z.object({ packageId: z.string().min(1), qty })).max(200),
})
const issueSchema = z.object({
  mrId: z.string().min(1, 'Choose the requisition'),
  lineId: z.string().min(1, 'Choose the requisition line'),
  qty,
})
const transferSchema = z.object({ toWarehouseId: z.string().min(1, 'Choose the store it goes to'), qty })
const splitSchema = z.object({ qtys: z.array(qty).min(1, 'Enter at least one new package').max(200) })
const correctSchema = z.object({
  qty: z.number().min(0, 'Quantity cannot be negative'),
  reason: z.string().trim().min(3, 'Say why the quantity is being corrected'),
})
const voidSchema = z.object({ reason: z.string().trim().min(3, 'Say why the label is being withdrawn') })
const rackSchema = z.object({ rack: z.string().max(40).nullable() })
const putAwaySchema = z.object({
  code: z.string().trim().min(1, 'Scan a sticker, or type its number').max(120),
  rack: z.string().trim().min(1, 'Type the rack first').max(40),
})
const restickSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  qtys: z.array(qty).min(1, 'Make at least one sticker').max(500, 'That is more than 500 stickers'),
  packType: z.enum(PACK_TYPES).optional().nullable(),
})

const pkgInclude = {
  item: {
    select: {
      id: true,
      code: true,
      name: true,
      categoryId: true,
      contentQty: true,
      contentUnit: true,
      uom: { select: { symbol: true } },
      category: { select: { name: true } },
    },
  },
  warehouse: { select: { id: true, name: true } },
  ownerCustomer: { select: { id: true, name: true } },
} satisfies Prisma.StockPackageInclude

/** Everything the scan screen shows about one package, and what can be done with it. */
async function detail(id: string) {
  const pkg = await prisma.stockPackage.findUnique({
    where: { id },
    include: {
      ...pkgInclude,
      parent: { select: { id: true, code: true } },
      children: { select: { id: true, code: true, qty: true, status: true }, orderBy: { createdAt: 'asc' } },
      moves: { orderBy: { createdAt: 'desc' }, take: 50, include: { createdBy: { select: { name: true } } } },
    },
  })
  if (!pkg) throw new AppError('That package does not exist', 404, 'NOT_FOUND')

  const spot = { itemId: pkg.itemId, warehouseId: pkg.warehouseId, ownership: pkg.ownership, ownerCustomerId: pkg.ownerCustomerId }
  const [position, stores, grn, wanting, racks] = await Promise.all([
    positionOf(prisma, spot),
    prisma.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    pkg.sourceType === 'GRN' && pkg.sourceId
      ? prisma.gRN.findUnique({ where: { id: pkg.sourceId }, select: { grnNumber: true, grnDate: true, po: { select: { supplier: { select: { name: true } } } } } })
      : null,
    // Requisitions this package could be issued against: approved, open, and
    // still owed this item from the same owner's stock.
    prisma.materialRequisitionLine.findMany({
      where: {
        itemId: pkg.itemId,
        ownership: pkg.ownership,
        ownerCustomerId: pkg.ownerCustomerId,
        mr: { status: 'APPROVED', closedAt: null, issuedAt: null },
      },
      select: {
        id: true,
        requestedQty: true,
        issuedQty: true,
        styleNo: true,
        purpose: true,
        warehouseId: true,
        mr: {
          select: {
            id: true,
            mrNumber: true,
            requiredDate: true,
            department: { select: { name: true } },
            mo: { select: { moNumber: true } },
            so: { select: { soNumber: true, customer: { select: { name: true } } } },
          },
        },
      },
      orderBy: { mr: { requestDate: 'asc' } },
      take: 30,
    }),
    // The racks already in use in its store, for the rack box to offer.
    racksIn(prisma, pkg.warehouseId),
  ])

  const storeName = new Map(stores.map((s) => [s.id, s.name]))
  return {
    ...pkg,
    qty: Number(pkg.qty),
    initialQty: Number(pkg.initialQty),
    unit: pkg.item.uom?.symbol ?? '',
    grn,
    position,
    stores,
    racks: racks.map((r) => r.rack),
    requisitions: wanting
      .map((l) => ({
        lineId: l.id,
        mrId: l.mr.id,
        mrNumber: l.mr.mrNumber,
        department: l.mr.department?.name ?? '',
        owed: round3(Number(l.requestedQty) - Number(l.issuedQty)),
        requiredDate: l.mr.requiredDate,
        styleNo: l.styleNo,
        purpose: l.purpose,
        moNumber: l.mr.mo?.moNumber ?? null,
        soNumber: l.mr.so?.soNumber ?? null,
        customer: l.mr.so?.customer?.name ?? null,
        sameStore: l.warehouseId === pkg.warehouseId,
      }))
      .filter((r) => r.owed > 0),
    moves: pkg.moves.map((m) => ({
      ...m,
      qty: Number(m.qty),
      balanceAfter: Number(m.balanceAfter),
      store: storeName.get(m.warehouseId) ?? '',
      toStore: m.toWarehouseId ? (storeName.get(m.toWarehouseId) ?? '') : null,
      by: m.createdBy?.name ?? null,
    })),
  }
}

/** A search term read as a rack, "rack b3" as B3; never refused, as a search is not a rack being set. */
const rackOf = (q: string) => q.trim().toUpperCase().replace(/\s+/g, ' ').replace(/^RACK[\s:.-]*/, '').trim() || q

/** The filters the list and the item view share, from the query string. */
function listWhere(query: Record<string, unknown>): Prisma.StockPackageWhereInput {
  const str = (k: string) => (typeof query[k] === 'string' ? (query[k] as string).trim() : '')
  const q = str('q')
  const status = str('status') || 'IN_STOCK'
  const owner = str('owner')
  return {
    ...(status !== 'ALL' ? { status: status as 'IN_STOCK' } : {}),
    ...(str('warehouseId') ? { warehouseId: str('warehouseId') } : {}),
    ...(str('itemId') ? { itemId: str('itemId') } : {}),
    ...(str('sourceId') ? { sourceId: str('sourceId') } : {}),
    // 'OWNED' for our own; otherwise the customer whose material it is.
    ...(owner ? (owner === 'OWNED' ? { ownership: 'OWNED' as const } : { ownerCustomerId: owner }) : {}),
    ...(q
      ? {
          OR: [
            { code: { contains: normaliseCode(q).replace(/^PK-0*/, ''), mode: 'insensitive' as const } },
            { lotNo: { contains: q, mode: 'insensitive' as const } },
            { rack: { equals: rackOf(q), mode: 'insensitive' as const } },
            { item: { name: { contains: q, mode: 'insensitive' as const } } },
            { item: { code: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  }
}

/** The tiles: packages on the racks, and item-store pairs that no longer match the stock. */
async function summaryOf() {
  const groups = await prisma.stockPackage.groupBy({
    by: ['itemId', 'warehouseId', 'ownership', 'ownerCustomerId'],
    where: { status: 'IN_STOCK' },
    _sum: { qty: true },
    _count: true,
  })
  // Packages claiming more than the store holds: stock left without its
  // package being scanned.
  let mismatches = 0
  for (const g of groups) {
    const pos = await positionOf(prisma, { itemId: g.itemId, warehouseId: g.warehouseId, ownership: g.ownership, ownerCustomerId: g.ownerCustomerId })
    if (pos.loose < -0.0005) mismatches += 1
  }
  return {
    packages: groups.reduce((s, g) => s + g._count, 0),
    items: new Set(groups.map((g) => g.itemId)).size,
    stores: new Set(groups.map((g) => g.warehouseId)).size,
    mismatches,
  }
}

/** The packages themselves. One item's, oldest code first, when an item is named. */
router.get('/', requirePermission(MODULE, 'view'), async (req, res) => {
  const where = listWhere(req.query)
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50))
  const [total, rows, summary] = await Promise.all([
    prisma.stockPackage.count({ where }),
    prisma.stockPackage.findMany({
      where,
      include: pkgInclude,
      orderBy: req.query.itemId ? [{ code: 'asc' }] : [{ createdAt: 'desc' }, { code: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    summaryOf(),
  ])
  res.json({
    success: true,
    data: rows.map((r) => ({ ...r, qty: Number(r.qty), initialQty: Number(r.initialQty), unit: r.item.uom?.symbol ?? '' })),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    summary,
  })
})

/**
 * One line per item in a store: how many packages, how much is in them, which
 * lots. Fifty boxes of one button read as one line, opened to see the boxes.
 */
router.get('/groups', requirePermission(MODULE, 'view'), async (req, res) => {
  const rows = await prisma.stockPackage.findMany({
    where: listWhere(req.query),
    select: { itemId: true, warehouseId: true, ownerCustomerId: true, packType: true, lotNo: true, rack: true, qty: true, createdAt: true },
    take: 50_000,
  })
  const byKey = new Map<
    string,
    { itemId: string; warehouseId: string; ownerCustomerId: string | null; packages: number; qty: number; types: Map<string, number>; lots: Set<string>; racks: Set<string>; lastAt: Date }
  >()
  for (const r of rows) {
    const key = `${r.itemId}|${r.warehouseId}|${r.ownerCustomerId ?? ''}`
    let g = byKey.get(key)
    if (!g) {
      g = { itemId: r.itemId, warehouseId: r.warehouseId, ownerCustomerId: r.ownerCustomerId, packages: 0, qty: 0, types: new Map(), lots: new Set(), racks: new Set(), lastAt: r.createdAt }
      byKey.set(key, g)
    }
    g.packages += 1
    g.qty += Number(r.qty)
    g.types.set(r.packType, (g.types.get(r.packType) ?? 0) + 1)
    if (r.lotNo) g.lots.add(r.lotNo)
    if (r.rack) g.racks.add(r.rack)
    if (r.createdAt > g.lastAt) g.lastAt = r.createdAt
  }
  const groups = [...byKey.values()]
  const [items, stores, owners, summary] = await Promise.all([
    prisma.item.findMany({
      where: { id: { in: [...new Set(groups.map((g) => g.itemId))] } },
      select: { id: true, code: true, name: true, uom: { select: { symbol: true } }, category: { select: { name: true } } },
    }),
    prisma.warehouse.findMany({ where: { id: { in: [...new Set(groups.map((g) => g.warehouseId))] } }, select: { id: true, name: true } }),
    prisma.customer.findMany({
      where: { id: { in: [...new Set(groups.map((g) => g.ownerCustomerId).filter((x): x is string => Boolean(x)))] } },
      select: { id: true, name: true },
    }),
    summaryOf(),
  ])
  const itemOf = new Map(items.map((i) => [i.id, i]))
  const storeOf = new Map(stores.map((s) => [s.id, s.name]))
  const ownerOf = new Map(owners.map((c) => [c.id, c.name]))
  res.json({
    success: true,
    data: groups
      .map((g) => {
        const item = itemOf.get(g.itemId)
        return {
          key: `${g.itemId}|${g.warehouseId}|${g.ownerCustomerId ?? ''}`,
          itemId: g.itemId,
          itemCode: item?.code ?? '',
          item: item?.name ?? '',
          category: item?.category?.name ?? '',
          unit: item?.uom?.symbol ?? '',
          warehouseId: g.warehouseId,
          store: storeOf.get(g.warehouseId) ?? '',
          ownerCustomerId: g.ownerCustomerId,
          owner: g.ownerCustomerId ? (ownerOf.get(g.ownerCustomerId) ?? 'Customer') : null,
          packages: g.packages,
          qty: round3(g.qty),
          packTypes: [...g.types].sort((a, b) => b[1] - a[1]).map(([t]) => t),
          lots: [...g.lots].sort(),
          racks: [...g.racks].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
          lastAt: g.lastAt,
        }
      })
      .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime()),
    summary,
  })
})

/**
 * What can be labelled: GRN lines of packaged items not yet in packages, and
 * stock of those items already on the racks with no sticker.
 */
router.get('/to-label', requirePermission(MODULE, 'view'), async (req, res) => {
  const cats = await trackedCategoryIds(prisma)
  if (!cats.length) {
    res.json({ success: true, data: { tracked: false, grns: [], lines: [], loose: [] } })
    return
  }
  const grnId = typeof req.query.grnId === 'string' ? req.query.grnId : ''

  const grnLines = await prisma.gRNLine.findMany({
    where: {
      item: { categoryId: { in: cats } },
      acceptedQty: { gt: 0 },
      grn: { status: { notIn: ['DRAFT', 'CANCELLED'] }, ...(grnId ? { id: grnId } : { grnDate: { gte: new Date(Date.now() - 90 * 86_400_000) } }) },
    },
    select: {
      id: true,
      itemId: true,
      warehouseId: true,
      acceptedQty: true,
      batchNumber: true,
      item: { select: { code: true, name: true, categoryId: true, uom: { select: { symbol: true } } } },
      warehouse: { select: { name: true } },
      grn: { select: { id: true, grnNumber: true, grnDate: true, po: { select: { supplier: { select: { name: true } } } } } },
    },
    orderBy: { grn: { grnDate: 'desc' } },
  })
  const labelled = await prisma.stockPackage.groupBy({
    by: ['grnLineId'],
    where: { grnLineId: { in: grnLines.map((l) => l.id) }, status: { not: 'VOID' } },
    _sum: { initialQty: true },
  })
  const doneOf = new Map(labelled.map((l) => [l.grnLineId, Number(l._sum.initialQty ?? 0)]))

  // Stock of packaged items on the racks with no sticker yet, what came in
  // last at the top: stock just added is what somebody is looking for.
  const loose = await prisma.$queryRaw<
    Array<{ itemId: string; itemCode: string; item: string; categoryId: string; unit: string; warehouseId: string; store: string; ownership: string; ownerCustomerId: string | null; owner: string | null; qty: number; lastIn: Date | null }>
  >`
    SELECT s."itemId", i.code AS "itemCode", i.name AS item, i."categoryId", u.symbol AS unit,
           s."warehouseId", w.name AS store, s.ownership::text AS ownership, s."ownerCustomerId", c.name AS owner,
           MAX(s."createdAt") FILTER (WHERE s."inQty" > 0) AS "lastIn",
           (SUM(s."inQty" - s."outQty") - COALESCE((
              SELECT SUM(p.qty) FROM ld_erp.stock_packages p
              WHERE p."itemId" = s."itemId" AND p."warehouseId" = s."warehouseId" AND p.ownership = s.ownership
                AND p."ownerCustomerId" IS NOT DISTINCT FROM s."ownerCustomerId" AND p.status = 'IN_STOCK'), 0))::float8 AS qty
    FROM ld_erp.stock_ledger s
    JOIN ld_erp.items i ON i.id = s."itemId"
    JOIN ld_erp.uom u ON u.id = i."uomId"
    JOIN ld_erp.warehouses w ON w.id = s."warehouseId"
    LEFT JOIN ld_erp.customers c ON c.id = s."ownerCustomerId"
    WHERE i."categoryId" = ANY(${cats}::text[]) AND s."sizeId" IS NULL
    GROUP BY s."itemId", i.code, i.name, i."categoryId", u.symbol, s."warehouseId", w.name, s.ownership, s."ownerCustomerId", c.name
    HAVING SUM(s."inQty" - s."outQty") - COALESCE((
              SELECT SUM(p.qty) FROM ld_erp.stock_packages p
              WHERE p."itemId" = s."itemId" AND p."warehouseId" = s."warehouseId" AND p.ownership = s.ownership
                AND p."ownerCustomerId" IS NOT DISTINCT FROM s."ownerCustomerId" AND p.status = 'IN_STOCK'), 0) > 0.0005
    ORDER BY "lastIn" DESC NULLS LAST, i.name, w.name
  `
  // How each item's stickers start out — its remembered setting, or one per
  // roll or box — and how much of each GRN line is still loose: read for all
  // the items at once. One query an item made this list take half a minute.
  const itemIds = [...new Set([...grnLines.map((l) => l.itemId), ...loose.map((r) => r.itemId)])]
  const [ruleOf, items, positionOf] = await Promise.all([
    packageRules(prisma),
    prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, categoryId: true, packType: true, packQty: true, uom: { select: { symbol: true, name: true } } },
    }),
    positionsOf(
      prisma,
      grnLines.map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId, ownership: 'OWNED' as const, ownerCustomerId: null })),
    ),
  ])
  const defaults = new Map(items.map((i) => [i.id, stickerDefaultsFrom(i, ruleOf(i.categoryId))]))
  const defaultsOf = (itemId: string) => defaults.get(itemId) ?? { packType: 'BOX' as const, perPack: null }

  const lines = []
  for (const l of grnLines) {
    const remaining = round3(Number(l.acceptedQty) - (doneOf.get(l.id) ?? 0))
    if (remaining <= 0) continue
    const pos = positionOf({ itemId: l.itemId, warehouseId: l.warehouseId, ownership: 'OWNED', ownerCustomerId: null })
    lines.push({
      grnLineId: l.id,
      grnId: l.grn.id,
      grnNumber: l.grn.grnNumber,
      grnDate: l.grn.grnDate,
      supplier: l.grn.po?.supplier?.name ?? '',
      itemId: l.itemId,
      itemCode: l.item.code,
      item: l.item.name,
      unit: l.item.uom?.symbol ?? '',
      warehouseId: l.warehouseId,
      store: l.warehouse.name,
      lotNo: l.batchNumber,
      accepted: Number(l.acceptedQty),
      toLabel: Math.max(0, Math.min(remaining, pos.loose)),
      packType: defaultsOf(l.itemId).packType,
      perPack: defaultsOf(l.itemId).perPack,
    })
  }

  const looseRows = loose.map((r) => ({ ...r, qty: round3(r.qty), packType: defaultsOf(r.itemId).packType, perPack: defaultsOf(r.itemId).perPack }))

  const grns = [...new Map(lines.map((l) => [l.grnId, { id: l.grnId, grnNumber: l.grnNumber, grnDate: l.grnDate, supplier: l.supplier }])).values()]
  res.json({ success: true, data: { tracked: true, grns, lines, loose: looseRows } })
})

/** For printing: the stickers for the packages named. */
router.get('/labels', requirePermission(MODULE, 'view'), async (req, res) => {
  const ids = String(req.query.ids ?? '').split(',').filter(Boolean).slice(0, 500)
  if (!ids.length) throw new AppError('Choose the packages to print', 400, 'NO_IDS')
  const [company, rows] = await Promise.all([
    prisma.company.findFirst({ select: { name: true } }),
    prisma.stockPackage.findMany({ where: { id: { in: ids } }, include: pkgInclude, orderBy: { code: 'asc' } }),
  ])
  // A GRN's stickers, and the ones split from them, which keep its id.
  const fromGrn = (r: (typeof rows)[number]) => (r.sourceType === 'GRN' || r.grnLineId) && r.sourceId
  const grnIds = [...new Set(rows.filter(fromGrn).map((r) => r.sourceId as string))]
  const lineIds = [...new Set(rows.map((r) => r.grnLineId).filter((x): x is string => !!x))]
  const [grns, lines, siblings] = await Promise.all([
    prisma.gRN.findMany({
      where: { id: { in: grnIds } },
      select: { id: true, grnNumber: true, grnDate: true, challanNo: true, po: { select: { poNumber: true, supplier: { select: { name: true } } } } },
    }),
    // The style the goods were bought for, off the order line.
    prisma.gRNLine.findMany({
      where: { id: { in: lineIds } },
      select: { id: true, poLine: { select: { styleNo: true, style: { select: { code: true } } } } },
    }),
    // "Bundle 2 of 5": every sticker a receipt line was given, in order.
    prisma.stockPackage.findMany({
      where: { grnLineId: { in: lineIds }, parentId: null, status: { not: 'VOID' } },
      select: { id: true, grnLineId: true },
      orderBy: { code: 'asc' },
    }),
  ])
  const grnOf = new Map(grns.map((g) => [g.id, g]))
  const styleOf = new Map(lines.map((l) => [l.id, l.poLine?.style?.code ?? l.poLine?.styleNo ?? null]))
  const seqOf = new Map<string, { n: number; of: number }>()
  const byLine = new Map<string, string[]>()
  for (const p of siblings) byLine.set(p.grnLineId!, [...(byLine.get(p.grnLineId!) ?? []), p.id])
  for (const ids of byLine.values()) if (ids.length > 1) ids.forEach((id, i) => seqOf.set(id, { n: i + 1, of: ids.length }))
  res.json({
    success: true,
    data: {
      company: company?.name ?? '',
      packages: rows.map((r) => {
        const g = fromGrn(r) ? grnOf.get(r.sourceId as string) : undefined
        return {
          id: r.id,
          code: r.code,
          packType: r.packType,
          qty: Number(r.qty),
          unit: r.item.uom?.symbol ?? '',
          // What is inside, when the item says: 2 box of 144 is 288 pcs.
          content: r.item.contentQty && Number(r.item.contentQty) > 0 ? { qty: round3(Number(r.qty) * Number(r.item.contentQty)), unit: r.item.contentUnit || 'pcs' } : null,
          itemCode: r.item.code,
          item: r.item.name,
          category: r.item.category?.name ?? '',
          store: r.warehouse.name,
          lotNo: r.lotNo,
          owner: r.ownerCustomer?.name ?? null,
          // The document it came in on: a GRN, or a stock-in, a customer's receipt…
          grnNumber: g?.grnNumber ?? r.sourceRef ?? null,
          supplier: g?.po?.supplier?.name ?? null,
          date: g?.grnDate ?? r.createdAt,
          challanNo: g?.challanNo ?? null,
          poNumber: g?.po?.poNumber ?? null,
          styleNo: r.grnLineId ? (styleOf.get(r.grnLineId) ?? null) : null,
          seq: seqOf.get(r.id) ?? null,
        }
      }),
    },
  })
})

/**
 * Labels for stock going out: one for each line of an issue, a job-work
 * challan, a return or a transfer, with the document number as its QR, who it
 * went to, and how much. Stuck on what leaves, so the floor, the job worker or
 * the supplier can tell which document it came on.
 */
router.get('/outward-labels', requirePermission(MODULE, 'view'), async (req, res) => {
  const type = z.enum(OUTWARD_TYPES).parse(req.query.type)
  const id = z.string().min(1).parse(req.query.id)
  const doc = await loadOutward(type, id, typeof req.query.q === 'string' ? req.query.q : null)
  const company = await prisma.company.findFirst({ select: { name: true } })
  res.json({
    success: true,
    data: {
      company: company?.name ?? '',
      labels: doc.lines.map((l) => ({
        key: l.key,
        tag: OUTWARD[type].tag,
        docNumber: doc.number,
        item: l.item,
        itemCode: l.itemCode,
        qty: round3(l.qty),
        unit: l.unit,
        to: doc.to,
        from: l.from,
        owner: l.owner,
        date: new Date(),
      })),
    },
  })
})

/** What went out, and — where it left labelled stock without a scan — the packages it could have come from. */
async function outwardSpots(doc: Awaited<ReturnType<typeof loadOutward>>) {
  const seen = new Set<string>()
  const spots = []
  const positionOf = await positionsOf(
    prisma,
    doc.lines.map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId, ownership: l.ownership, ownerCustomerId: l.ownerCustomerId })),
  )
  for (const l of doc.lines) {
    const key = [l.itemId, l.warehouseId, l.ownership, l.ownerCustomerId ?? ''].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    const spot = { itemId: l.itemId, warehouseId: l.warehouseId, ownership: l.ownership, ownerCustomerId: l.ownerCustomerId }
    const pos = positionOf(spot)
    // Packages claiming more than the store now holds: what went out came from them.
    if (pos.loose >= -0.0005) continue
    const over = round3(-pos.loose)
    const packages = await prisma.stockPackage.findMany({
      where: { ...spot, status: 'IN_STOCK' },
      select: { id: true, code: true, qty: true, lotNo: true, packType: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
    })
    // Stock below nothing with no stickers on it at all is a count to make, not a package to pick.
    if (!packages.length) continue
    // The oldest first, as a store issues: a suggestion the person can change.
    let left = over
    spots.push({
      key,
      itemId: l.itemId,
      item: l.item,
      itemCode: l.itemCode,
      unit: l.unit,
      warehouseId: l.warehouseId,
      store: l.from,
      ownership: l.ownership,
      ownerCustomerId: l.ownerCustomerId,
      over,
      packages: packages.map((p) => {
        const take = round3(Math.max(0, Math.min(Number(p.qty), left)))
        left = round3(left - take)
        return { id: p.id, code: p.code, qty: Number(p.qty), lotNo: p.lotNo, packType: p.packType, take }
      }),
    })
  }
  return spots
}

/**
 * The window after stock goes out: its lines, for their labels, and the rolls
 * or boxes it must have come from where it was not scanned out.
 */
router.post('/outward/plan', requirePermission(MODULE, 'view'), async (req, res) => {
  const data = outwardSchema.parse(req.body)
  const doc = await loadOutward(data.type, data.id, data.q)
  res.json({
    success: true,
    data: {
      type: data.type,
      number: doc.number,
      to: doc.to,
      moves: OUTWARD[data.type].moves,
      lines: doc.lines.map((l) => ({ key: l.key, item: l.item, itemCode: l.itemCode, qty: round3(l.qty), unit: l.unit, from: l.from, owner: l.owner })),
      spots: await outwardSpots(doc),
    },
  })
})

/**
 * Takes what went out off the packages it came from, so their stickers say
 * what is really in them. Stock that left us empties or shrinks its package;
 * stock that only moved takes its package along — a whole roll moves, part of
 * one becomes a new roll in the other store. Returns the packages whose
 * stickers have changed, to print fresh.
 */
router.post('/outward/apply', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = outwardApplySchema.parse(req.body)
  const doc = await loadOutward(data.type, data.id, data.q)
  const { moves } = OUTWARD[data.type]
  if (moves && !doc.toWarehouseId) throw new AppError('Where it went is not on the document.', 400, 'NO_DESTINATION')
  const spots = new Set(doc.lines.map((l) => [l.itemId, l.warehouseId, l.ownership, l.ownerCustomerId ?? ''].join('|')))

  const result = await prisma.$transaction(
    async (tx) => {
      const reprint: string[] = []
      const taken = new Map<string, number>()
      for (const t of data.takes) {
        const pkg = await lockPackage(tx, t.packageId)
        const key = [pkg.itemId, pkg.warehouseId, pkg.ownership, pkg.ownerCustomerId ?? ''].join('|')
        const unit = pkg.item.uom?.symbol ?? ''
        if (!spots.has(key)) throw new AppError(`${pkg.code} is not stock that went out on ${doc.number}.`, 400, 'WRONG_PACKAGE')
        if (pkg.status !== 'IN_STOCK') throw new AppError(`${pkg.code} is no longer in stock.`, 400, 'NOT_IN_STOCK')
        if (t.qty > Number(pkg.qty) + 1e-9) throw new AppError(`${pkg.code} has only ${Number(pkg.qty)} ${unit} in it.`, 400, 'OVER_PACKAGE')

        // No more off the packages than left without a scan: the rest of the
        // labelled stock is still on the rack.
        if (!taken.has(key)) {
          // Locked first: two people bringing the same packages up to date at
          // once must not both take the same boxes off.
          await lockedBalanceOf(tx, { itemId: pkg.itemId, warehouseId: pkg.warehouseId, ownership: pkg.ownership, ownerCustomerId: pkg.ownerCustomerId })
          const pos = await positionOf(tx, { itemId: pkg.itemId, warehouseId: pkg.warehouseId, ownership: pkg.ownership, ownerCustomerId: pkg.ownerCustomerId })
          taken.set(key, round3(Math.max(0, -pos.loose)))
        }
        const room = taken.get(key)!
        if (t.qty > room + 1e-6) {
          throw new AppError(`Only ${room} ${unit} of ${pkg.item.name} went out without a scan, so ${t.qty} cannot come off ${pkg.code}.`, 400, 'OVER_OUTWARD')
        }
        taken.set(key, round3(room - t.qty))

        const left = round3(Number(pkg.qty) - t.qty)
        const ref = { referenceType: OUTWARD[data.type].ledger, referenceId: doc.id, referenceNumber: doc.number, userId: req.user?.id ?? null }
        if (!moves) {
          await tx.stockPackage.update({ where: { id: pkg.id }, data: { qty: left, status: left <= 0 ? 'EMPTY' : 'IN_STOCK' } })
          await recordPackageMove(tx, { packageId: pkg.id, type: 'ISSUED', qty: -t.qty, balanceAfter: left, warehouseId: pkg.warehouseId, notes: `To ${doc.to}`, ...ref })
          if (left > 0) reprint.push(pkg.id)
        } else if (left <= 0) {
          // The whole roll went: it keeps its sticker, now in the other store, off its old rack.
          await tx.stockPackage.update({ where: { id: pkg.id }, data: { warehouseId: doc.toWarehouseId!, rack: null } })
          await recordPackageMove(tx, {
            packageId: pkg.id,
            type: 'TRANSFERRED',
            qty: Number(pkg.qty),
            balanceAfter: Number(pkg.qty),
            warehouseId: pkg.warehouseId,
            toWarehouseId: doc.toWarehouseId,
            notes: `To ${doc.to}`,
            ...ref,
          })
        } else {
          // Part of it went: a new package in the other store, and the rest stays.
          await tx.stockPackage.update({ where: { id: pkg.id }, data: { qty: left } })
          const [child] = await createPackages(tx, {
            spot: { itemId: pkg.itemId, warehouseId: doc.toWarehouseId!, ownership: pkg.ownership, ownerCustomerId: pkg.ownerCustomerId },
            packType: pkg.packType,
            qtys: [t.qty],
            lotNo: pkg.lotNo,
            sourceType: 'SPLIT',
            sourceRef: doc.number,
            parentId: pkg.id,
            userId: req.user?.id ?? null,
            fromPackage: true,
            unit,
            itemName: pkg.item.name,
          })
          await recordPackageMove(tx, {
            packageId: pkg.id,
            type: 'SPLIT',
            qty: -t.qty,
            balanceAfter: left,
            warehouseId: pkg.warehouseId,
            toWarehouseId: doc.toWarehouseId,
            relatedPackageId: child.id,
            notes: `${child.code} to ${doc.to}`,
            ...ref,
          })
          reprint.push(pkg.id, child.id)
        }
      }
      return reprint
    },
    { timeout: 60_000, maxWait: 20_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'StockPackage', entityId: data.takes[0]?.packageId ?? doc.id, after: { outward: doc.number, takes: data.takes } })
  res.json({
    success: true,
    message: data.takes.length ? `Packages brought up to date with ${doc.number}.` : `Labels for ${doc.number}.`,
    data: { reprint: result },
  })
})

/**
 * Stickers made and never printed, a group a document and item, what came in
 * last first. With `sourceType` and `sourceId`, only that document's.
 */
router.get('/ready', requirePermission(MODULE, 'view'), async (req, res) => {
  const sourceType = typeof req.query.sourceType === 'string' ? req.query.sourceType : ''
  const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : ''
  const rows = await prisma.stockPackage.findMany({
    where: { status: 'IN_STOCK', printCount: 0, ...(sourceType && sourceId ? { sourceType, sourceId } : {}) },
    select: {
      id: true,
      qty: true,
      packType: true,
      sourceType: true,
      sourceId: true,
      sourceRef: true,
      createdAt: true,
      item: { select: { id: true, code: true, name: true, uom: { select: { symbol: true } } } },
      warehouse: { select: { name: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { code: 'asc' }],
  })
  // `each`: what every sticker in the group holds, when they all hold the same.
  const groups = new Map<
    string,
    { key: string; sourceRef: string | null; date: Date; itemCode: string; item: string; store: string; unit: string; qty: number; each: number | null; packType: string; ids: string[] }
  >()
  for (const r of rows) {
    const key = [r.sourceType, r.sourceId ?? '', r.item.id, r.warehouse.name].join('|')
    const q = Number(r.qty)
    const g = groups.get(key) ?? { key, sourceRef: r.sourceRef, date: r.createdAt, itemCode: r.item.code, item: r.item.name, store: r.warehouse.name, unit: r.item.uom?.symbol ?? '', qty: 0, each: q, packType: r.packType, ids: [] }
    if (g.each !== null && Math.abs(g.each - q) > 1e-9) g.each = null
    g.qty = round3(g.qty + q)
    g.ids.push(r.id)
    groups.set(key, g)
  }
  res.json({ success: true, data: { count: rows.length, groups: [...groups.values()] } })
})

/**
 * Stickers found by what people remember of them — item, lot, rack, the GRN,
 * challan, PO or supplier it came on, the requisition, MO or order it went
 * to — typed as one line, or picked detail by detail.
 */
router.get('/find', requirePermission(MODULE, 'view'), async (req, res) => {
  const out = await findPackages(findSchema.parse(req.query))
  res.json({ success: true, data: out.rows, total: out.total, inStock: out.inStock })
})

/** What the find-by-details dropdowns offer. */
router.get('/find/options', requirePermission(MODULE, 'view'), async (_req, res) => {
  res.json({ success: true, data: await findOptions() })
})

/** The racks in use, in one store or all of them, for the rack box to offer. */
router.get('/racks', requirePermission(MODULE, 'view'), async (req, res) => {
  const warehouseId = typeof req.query.warehouseId === 'string' ? req.query.warehouseId : null
  res.json({ success: true, data: await racksIn(prisma, warehouseId) })
})

/**
 * Putting stock away: the rack is typed once, then each sticker scanned goes
 * on it. Only packages in stock; the rack is within the package's own store.
 */
router.post('/put-away', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = putAwaySchema.parse(req.body)
  const rack = normaliseRack(data.rack)
  if (!rack) throw new AppError('Type the rack first', 400, 'NO_RACK')
  const code = normaliseCode(data.code)
  const out = await prisma.$transaction(async (tx) => {
    const found = await tx.stockPackage.findUnique({ where: { code }, select: { id: true } })
    if (!found) throw new AppError(`No package with the code ${code}. Check the sticker, or type the number under the QR.`, 404, 'NOT_FOUND')
    const pkg = await lockPackage(tx, found.id)
    if (pkg.status !== 'IN_STOCK') {
      throw new AppError(`${pkg.code} is ${pkg.status === 'EMPTY' ? 'empty' : pkg.status === 'SPLIT' ? 'split into other packages' : 'withdrawn'}, so it is not on any rack.`, 400, 'NOT_IN_STOCK')
    }
    const was = pkg.rack
    const changed = await setRack(tx, pkg, rack, { userId: req.user?.id ?? null })
    return { pkg, was, changed }
  })
  const p = out.pkg
  res.json({
    success: true,
    message: out.changed ? `${p.code} put on rack ${rack}${out.was ? ` (was ${out.was})` : ''}.` : `${p.code} is already on rack ${rack}.`,
    data: { id: p.id, code: p.code, item: p.item.name, qty: Number(p.qty), unit: p.item.uom?.symbol ?? '', store: p.warehouse.name, rack, was: out.was, changed: out.changed },
  })
})

/** A scanned or typed code: the package behind it. */
router.get('/scan/:code', requirePermission(MODULE, 'view'), async (req, res) => {
  const code = normaliseCode(decodeURIComponent(req.params.code))
  const pkg = await prisma.stockPackage.findUnique({ where: { code }, select: { id: true } })
  if (!pkg) throw new AppError(`No package with the code ${code}. Check the sticker, or type the number under the QR.`, 404, 'NOT_FOUND')
  res.json({ success: true, data: await detail(pkg.id) })
})

router.get('/:id', requirePermission(MODULE, 'view'), async (req, res) => {
  res.json({ success: true, data: await detail(req.params.id) })
})

const labelledMessage = (created: Array<{ code: string }>) =>
  `${created.length} ${created.length === 1 ? 'package' : 'packages'} labelled: ${created[0].code}${created.length > 1 ? ` to ${created[created.length - 1].code}` : ''}.`

/** Labelling stock: one package per quantity given. */
router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = groupSchema.parse(req.body)
  const created = await prisma.$transaction((tx) => labelGroup(tx, data, { type: 'STOCK', id: null, ref: null }, req.user?.id ?? null), {
    timeout: 60_000,
    maxWait: 20_000,
  })
  await writeAuditLog(req, { module: MODULE, action: 'CREATE', entityType: 'StockPackage', entityId: created[0].id, after: { codes: created.map((c) => c.code) } })
  res.status(201).json({ success: true, message: labelledMessage(created), data: created.map((c) => ({ id: c.id, code: c.code, qty: Number(c.qty) })) })
})

/**
 * Every sticker from the window at once: one transaction, so a GRN of five
 * items either gets all its stickers or none, and one print tab for them all.
 */
router.post('/plan', requirePermission(MODULE, 'view'), async (req, res) => {
  res.json({ success: true, data: await planStickers(planSchema.parse(req.body)) })
})

/**
 * "Print stickers" on a document: makes any of its stickers not made yet, by
 * the item rules, and hands back every sticker it has, to print.
 */
router.post('/auto', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = planSchema.parse(req.body)
  const made = await autoStickers(data, req.user?.id ?? null)
  const all = await prisma.stockPackage.findMany({
    where: { sourceType: data.sourceType, sourceId: data.sourceId, status: 'IN_STOCK' },
    select: { id: true },
    orderBy: { code: 'asc' },
  })
  res.json({ success: true, message: made.count ? `${made.count} new stickers made.` : '', data: { made: made.count, ids: all.map((p) => p.id) } })
})

/**
 * The stickers of one line made again in the number and sizes chosen — before
 * printing, or any time while they are still whole on the rack.
 */
router.post('/restick', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = restickSchema.parse(req.body)
  const result = await prisma.$transaction((tx) => restickStickers(tx, data.ids, data.qtys, data.packType ?? null, req.user?.id ?? null), {
    timeout: 60_000,
    maxWait: 20_000,
  })
  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'StockPackage',
    entityId: result.created[0].id,
    before: { codes: result.before },
    after: { codes: result.created.map((c) => c.code), qtys: data.qtys },
  })
  const n = result.created.length
  res.json({
    success: true,
    message: `${n} ${n === 1 ? 'sticker' : 'stickers'} made in place of ${result.before.length}, ready to print.`,
    data: { ids: result.created.map((c) => c.id) },
  })
})

/** Counted once the print box opens on them: that is a print, opening the page is not. */
router.post('/printed', requirePermission(MODULE, 'view'), async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }).parse(req.body)
  const r = await prisma.stockPackage.updateMany({ where: { id: { in: ids } }, data: { printCount: { increment: 1 }, lastPrintedAt: new Date() } })
  res.json({ success: true, data: { updated: r.count } })
})

router.post('/batch', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = batchSchema.parse(req.body)
  const sourceRef = await sourceRefOf(data.sourceType, data.sourceId)
  if (!sourceRef) throw new AppError('That document does not exist', 404, 'NOT_FOUND')
  const created = await prisma.$transaction(
    async (tx) => {
      const all = []
      for (const g of data.groups) all.push(...(await labelGroup(tx, g, { type: data.sourceType, id: data.sourceId, ref: sourceRef }, req.user?.id ?? null)))
      return all
    },
    { timeout: 120_000, maxWait: 20_000 },
  )
  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'StockPackage',
    entityId: created[0].id,
    after: { from: sourceRef, codes: created.map((c) => c.code) },
  })
  res.status(201).json({ success: true, message: labelledMessage(created), data: created.map((c) => ({ id: c.id, code: c.code, qty: Number(c.qty) })) })
})

/** Putting one package on a rack, or taking it off (rack null). */
router.post('/:id/rack', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const rack = normaliseRack(rackSchema.parse(req.body).rack)
  const pkg = await prisma.$transaction(async (tx) => {
    const p = await lockPackage(tx, req.params.id)
    if (p.status !== 'IN_STOCK') throw new AppError(`${p.code} has nothing in it, so it is not on any rack.`, 400, 'NOT_IN_STOCK')
    await setRack(tx, p, rack, { userId: req.user?.id ?? null })
    return p
  })
  res.json({
    success: true,
    message: rack ? `${pkg.code} is on rack ${rack}.` : `${pkg.code} is no longer on a rack.`,
    data: await detail(pkg.id),
  })
})

/** Issuing from a scanned package against a requisition. The rest stays in the package. */
router.post('/:id/issue', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = issueSchema.parse(req.body)
  const result = await prisma.$transaction(
    async (tx) => {
      const pkg = await lockPackage(tx, req.params.id)
      const unit = pkg.item.uom?.symbol ?? ''
      if (pkg.status !== 'IN_STOCK') throw new AppError(`${pkg.code} is ${pkg.status === 'EMPTY' ? 'empty' : pkg.status === 'SPLIT' ? 'split into other packages' : 'withdrawn'}; nothing can be issued from it.`, 400, 'NOT_IN_STOCK')
      if (data.qty > Number(pkg.qty) + 1e-9) throw new AppError(`${pkg.code} has only ${Number(pkg.qty)} ${unit} in it.`, 400, 'OVER_PACKAGE')
      const line = await tx.materialRequisitionLine.findUnique({ where: { id: data.lineId }, select: { mrId: true, itemId: true, ownership: true, ownerCustomerId: true } })
      if (!line || line.mrId !== data.mrId) throw new AppError('That line is not on this requisition.', 400, 'WRONG_LINE')
      if (line.itemId !== pkg.itemId) throw new AppError(`That requisition line is not for ${pkg.item.name}.`, 400, 'WRONG_ITEM')
      if (line.ownership !== pkg.ownership || (line.ownerCustomerId ?? null) !== (pkg.ownerCustomerId ?? null)) {
        throw new AppError("That requisition wants a different owner's stock than this package holds.", 400, 'WRONG_OWNER')
      }

      // The issue itself, with every rule the Issue screen has.
      const issued = await issueRequisition(tx, data.mrId, { lines: [{ lineId: data.lineId, issueQty: data.qty, warehouseId: pkg.warehouseId }] }, req.user)

      const left = round3(Number(pkg.qty) - data.qty)
      await tx.stockPackage.update({ where: { id: pkg.id }, data: { qty: left, status: left <= 0 ? 'EMPTY' : 'IN_STOCK' } })
      await recordPackageMove(tx, {
        packageId: pkg.id,
        type: 'ISSUED',
        qty: -data.qty,
        balanceAfter: left,
        warehouseId: pkg.warehouseId,
        referenceType: 'MATERIAL_REQUISITION',
        referenceId: data.mrId,
        referenceNumber: issued.after.mrNumber,
        notes: `To ${issued.after.department?.name ?? 'production'}`,
        userId: req.user?.id ?? null,
      })
      return { pkg, left, unit, mrNumber: issued.after.mrNumber }
    },
    { timeout: 60_000, maxWait: 20_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'StockPackage', entityId: result.pkg.id, after: { issued: data.qty, against: result.mrNumber, left: result.left } })
  res.json({
    success: true,
    message: `${data.qty} ${result.unit} issued from ${result.pkg.code} against ${result.mrNumber}. ${result.left > 0 ? `${result.left} ${result.unit} left in it.` : 'The package is now empty.'}`,
    data: await detail(result.pkg.id),
  })
})

/**
 * Moving a package to another store. The whole of it moves with its label;
 * part of it moves as a new package with its own label, which needs printing.
 */
router.post('/:id/transfer', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = transferSchema.parse(req.body)
  const result = await prisma.$transaction(
    async (tx) => {
      const pkg = await lockPackage(tx, req.params.id)
      const unit = pkg.item.uom?.symbol ?? ''
      if (pkg.status !== 'IN_STOCK') throw new AppError(`${pkg.code} has nothing in it to move.`, 400, 'NOT_IN_STOCK')
      if (data.toWarehouseId === pkg.warehouseId) throw new AppError(`${pkg.code} is already in ${pkg.warehouse.name}.`, 400, 'SAME_STORE')
      if (data.qty > Number(pkg.qty) + 1e-9) throw new AppError(`${pkg.code} has only ${Number(pkg.qty)} ${unit} in it.`, 400, 'OVER_PACKAGE')

      const note = await createTransfer(
        tx,
        {
          fromWarehouseId: pkg.warehouseId,
          toWarehouseId: data.toWarehouseId,
          notes: `Package ${pkg.code}`,
          lines: [{ itemId: pkg.itemId, qty: data.qty, ownership: pkg.ownership, ownerCustomerId: pkg.ownerCustomerId }],
        },
        req.user?.id ?? null,
      )
      const whole = Math.abs(data.qty - Number(pkg.qty)) < 1e-9
      let moved = pkg.id
      if (whole) {
        // A rack belongs to the store it is in: put away again on arrival.
        await tx.stockPackage.update({ where: { id: pkg.id }, data: { warehouseId: data.toWarehouseId, rack: null } })
        await recordPackageMove(tx, {
          packageId: pkg.id,
          type: 'TRANSFERRED',
          qty: 0,
          balanceAfter: Number(pkg.qty),
          warehouseId: pkg.warehouseId,
          toWarehouseId: data.toWarehouseId,
          referenceType: 'STOCK_TRANSFER',
          referenceId: note.id,
          referenceNumber: note.transferNumber,
          userId: req.user?.id ?? null,
        })
      } else {
        // Part of it: the part that goes becomes a package of its own, at the other store.
        const left = round3(Number(pkg.qty) - data.qty)
        await tx.stockPackage.update({ where: { id: pkg.id }, data: { qty: left } })
        const [child] = await createPackages(tx, {
          spot: { itemId: pkg.itemId, warehouseId: data.toWarehouseId, ownership: pkg.ownership, ownerCustomerId: pkg.ownerCustomerId },
          packType: pkg.packType,
          qtys: [data.qty],
          lotNo: pkg.lotNo,
          notes: `Part of ${pkg.code}, moved on ${note.transferNumber}`,
          sourceType: 'SPLIT',
          sourceId: pkg.sourceId,
          sourceRef: pkg.sourceRef,
          grnLineId: pkg.grnLineId,
          parentId: pkg.id,
          userId: req.user?.id ?? null,
          fromPackage: true,
          unit,
          itemName: pkg.item.name,
        })
        await recordPackageMove(tx, {
          packageId: pkg.id,
          type: 'SPLIT',
          qty: -data.qty,
          balanceAfter: left,
          warehouseId: pkg.warehouseId,
          toWarehouseId: data.toWarehouseId,
          referenceType: 'STOCK_TRANSFER',
          referenceId: note.id,
          referenceNumber: note.transferNumber,
          relatedPackageId: child.id,
          userId: req.user?.id ?? null,
        })
        moved = child.id
      }
      return { pkg, note, whole, moved, unit, to: note.toWarehouse.name }
    },
    { timeout: 60_000, maxWait: 20_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'StockPackage', entityId: result.pkg.id, after: { moved: data.qty, to: result.to, note: result.note.transferNumber } })
  const child = result.whole ? null : await prisma.stockPackage.findUnique({ where: { id: result.moved }, select: { id: true, code: true } })
  res.json({
    success: true,
    message: result.whole
      ? `${result.pkg.code} moved to ${result.to} on ${result.note.transferNumber}.`
      : `${data.qty} ${result.unit} moved to ${result.to} as a new package ${child?.code}. Print its label and stick it on.`,
    data: { ...(await detail(result.pkg.id)), newPackage: child },
  })
})

/** Splitting or repacking: new packages cut from this one, each with its own label. */
router.post('/:id/split', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = splitSchema.parse(req.body)
  const result = await prisma.$transaction(
    async (tx) => {
      const pkg = await lockPackage(tx, req.params.id)
      const unit = pkg.item.uom?.symbol ?? ''
      if (pkg.status !== 'IN_STOCK') throw new AppError(`${pkg.code} has nothing in it to split.`, 400, 'NOT_IN_STOCK')
      const total = round3(data.qtys.reduce((s, q) => s + q, 0))
      if (total > Number(pkg.qty) + 1e-9) throw new AppError(`${pkg.code} has ${Number(pkg.qty)} ${unit}; the new packages add up to ${total}.`, 400, 'OVER_PACKAGE')
      const left = round3(Number(pkg.qty) - total)
      const children = await createPackages(tx, {
        spot: { itemId: pkg.itemId, warehouseId: pkg.warehouseId, ownership: pkg.ownership, ownerCustomerId: pkg.ownerCustomerId },
        packType: pkg.packType,
        qtys: data.qtys,
        lotNo: pkg.lotNo,
        rack: pkg.rack,
        notes: `Split from ${pkg.code}`,
        sourceType: 'SPLIT',
        sourceId: pkg.sourceId,
        sourceRef: pkg.sourceRef,
        grnLineId: pkg.grnLineId,
        parentId: pkg.id,
        userId: req.user?.id ?? null,
        fromPackage: true,
        unit,
        itemName: pkg.item.name,
      })
      await tx.stockPackage.update({ where: { id: pkg.id }, data: { qty: left, status: left <= 0 ? 'SPLIT' : 'IN_STOCK' } })
      await recordPackageMove(tx, {
        packageId: pkg.id,
        type: 'SPLIT',
        qty: -total,
        balanceAfter: left,
        warehouseId: pkg.warehouseId,
        notes: `Into ${children.map((c) => c.code).join(', ')}`,
        userId: req.user?.id ?? null,
      })
      return { pkg, children, left, unit }
    },
    { timeout: 60_000, maxWait: 20_000 },
  )
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'StockPackage', entityId: result.pkg.id, after: { splitInto: result.children.map((c) => c.code) } })
  res.json({
    success: true,
    message: `${result.pkg.code} split into ${result.children.length} new ${result.children.length === 1 ? 'package' : 'packages'}${result.left > 0 ? `; ${result.left} ${result.unit} stays in it` : ''}. Print the new labels.`,
    data: { ...(await detail(result.pkg.id)), newPackages: result.children.map((c) => ({ id: c.id, code: c.code, qty: Number(c.qty) })) },
  })
})

/**
 * Setting a package's quantity to what is actually in it. The store's stock is
 * not changed here — that is a stock count — so a package can be brought down
 * to match, or up only as far as loose stock allows.
 */
router.post('/:id/correct', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = correctSchema.parse(req.body)
  const result = await prisma.$transaction(async (tx) => {
    const pkg = await lockPackage(tx, req.params.id)
    const unit = pkg.item.uom?.symbol ?? ''
    if (pkg.status === 'VOID') throw new AppError(`${pkg.code} was withdrawn.`, 400, 'VOID')
    const change = round3(data.qty - Number(pkg.qty))
    if (change > 0) {
      const pos = await positionOf(tx, { itemId: pkg.itemId, warehouseId: pkg.warehouseId, ownership: pkg.ownership, ownerCustomerId: pkg.ownerCustomerId })
      if (change > pos.loose + 1e-9) {
        throw new AppError(
          `${pkg.warehouse.name} has only ${Math.max(0, pos.loose)} ${unit} of ${pkg.item.name} outside packages, so this one cannot go up by ${change}. If there is more on the rack than the books say, record a stock count first.`,
          400,
          'NOT_ENOUGH_LOOSE',
        )
      }
    }
    await tx.stockPackage.update({ where: { id: pkg.id }, data: { qty: data.qty, status: data.qty > 0 ? 'IN_STOCK' : 'EMPTY' } })
    await recordPackageMove(tx, { packageId: pkg.id, type: 'CORRECTED', qty: change, balanceAfter: data.qty, warehouseId: pkg.warehouseId, notes: data.reason, userId: req.user?.id ?? null })
    return { pkg, unit, change }
  })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'StockPackage', entityId: result.pkg.id, before: { qty: Number(result.pkg.qty) }, after: { qty: data.qty, reason: data.reason } })
  res.json({ success: true, message: `${result.pkg.code} now holds ${data.qty} ${result.unit}.`, data: await detail(result.pkg.id) })
})

/** Withdrawing a label: printed by mistake, or the package is not on the rack. Stock is not touched. */
router.post('/:id/void', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = voidSchema.parse(req.body)
  const pkg = await prisma.$transaction(async (tx) => {
    const p = await lockPackage(tx, req.params.id)
    if (p.status === 'VOID') throw new AppError(`${p.code} is already withdrawn.`, 400, 'VOID')
    await tx.stockPackage.update({ where: { id: p.id }, data: { qty: 0, status: 'VOID' } })
    await recordPackageMove(tx, { packageId: p.id, type: 'VOIDED', qty: -Number(p.qty), balanceAfter: 0, warehouseId: p.warehouseId, notes: data.reason, userId: req.user?.id ?? null })
    return p
  })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'StockPackage', entityId: pkg.id, before: { status: pkg.status, qty: Number(pkg.qty) }, after: { status: 'VOID', reason: data.reason } })
  res.json({ success: true, message: `${pkg.code} withdrawn. Its stock is now loose in ${pkg.warehouse.name}; label it again if needed.`, data: await detail(pkg.id) })
})

export default router
