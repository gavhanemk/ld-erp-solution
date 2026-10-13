import { prisma, type Prisma } from '@ld-erp/database'
import type { PackType } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../utils/logger'
import { lockedBalanceOf } from './stock.service'
import {
  createPackages,
  packageRule,
  packageRules,
  positionsOf,
  round3,
  stickerDefaultsFrom,
  suggestQtys,
  type PackageSource,
} from './package.service'

/*
 * Stickers for stock coming in, made by themselves.
 *
 * The moment a GRN is saved or a stock-in approved, each item's stickers are
 * worked out from the item — its own "qty per sticker", one a roll or box, or
 * one for the lot — and made, ready to print. Nobody has to remember to go and
 * make them; printing happens from "Ready to print" whenever the storekeeper
 * is at the printer.
 */

/** The inward documents stickers are made for. */
export const INWARD_SOURCES = ['GRN', 'STOCK_IN', 'OPENING', 'CUSTOMER_GRN', 'JOB_WORK_RETURN', 'MR_RETURN'] as const
export type InwardSource = (typeof INWARD_SOURCES)[number]
/** What each one writes on the stock ledger. */
const LEDGER_REF: Record<InwardSource, string> = {
  GRN: 'GRN',
  STOCK_IN: 'STOCK_IN',
  OPENING: 'OPENING_STOCK',
  CUSTOMER_GRN: 'CUSTOMER_GRN',
  JOB_WORK_RETURN: 'JOB_WORK_RETURN',
  MR_RETURN: 'MR_RETURN',
}

/** One item's stickers in one store. */
export interface StickerGroup {
  itemId: string
  warehouseId: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId?: string | null
  packType: PackType
  qtys: number[]
  lotNo?: string | null
  notes?: string | null
  grnLineId?: string | null
  /** Keep this pack type and quantity as the item's own, for next time. */
  remember?: boolean
}

/** An inward document, and — when the document alone cannot say — what came in on it. */
export interface InwardQuery {
  sourceType: InwardSource
  sourceId: string
  /** A requisition can be returned to more than once, and its ledger rows share its id. */
  lines?: Array<{
    itemId: string
    warehouseId: string
    ownership: 'OWNED' | 'CUSTOMER_OWNED'
    ownerCustomerId?: string | null
    qty: number
    lotNo?: string | null
  }>
}

/**
 * Labels one item's stock in one store: the checks every way of making
 * stickers shares. A GRN line may not be labelled past what it brought in;
 * anything else may not be labelled past what is loose.
 */
export async function labelGroup(
  tx: Prisma.TransactionClient,
  g: StickerGroup,
  source: { type: InwardSource | 'STOCK'; id: string | null; ref: string | null },
  userId: string | null,
) {
  const item = await tx.item.findUnique({ where: { id: g.itemId }, select: { name: true, categoryId: true, uom: { select: { symbol: true } } } })
  if (!item) throw new AppError('That item does not exist', 404, 'NOT_FOUND')
  const rule = await packageRule(tx, item.categoryId)
  if (!rule.tracked) {
    throw new AppError(
      `${item.name} is not kept in packages: "Track by package" is switched off for ${rule.category} in Masters → Item Categories.`,
      400,
      'NOT_TRACKED',
    )
  }
  const spot = {
    itemId: g.itemId,
    warehouseId: g.warehouseId,
    ownership: g.ownership,
    ownerCustomerId: g.ownership === 'CUSTOMER_OWNED' ? (g.ownerCustomerId ?? null) : null,
  }
  // Held to the end of the transaction, before anything is counted: what a
  // GRN line has had stickered, and what is loose, cannot change under us.
  await lockedBalanceOf(tx, spot)
  let sourceType: PackageSource = source.type
  let sourceId = source.id
  let sourceRef = source.ref
  if (g.grnLineId) {
    const line = await tx.gRNLine.findUnique({
      where: { id: g.grnLineId },
      select: { grnId: true, itemId: true, warehouseId: true, acceptedQty: true, grn: { select: { grnNumber: true } } },
    })
    if (!line || line.itemId !== g.itemId || line.warehouseId !== g.warehouseId) {
      throw new AppError('That GRN line is not for this item in this store.', 400, 'WRONG_LINE')
    }
    const done = await tx.stockPackage.aggregate({ where: { grnLineId: g.grnLineId, status: { not: 'VOID' } }, _sum: { initialQty: true } })
    const left = round3(Number(line.acceptedQty) - Number(done._sum.initialQty ?? 0))
    const total = round3(g.qtys.reduce((s, q) => s + q, 0))
    if (total > left + 1e-9) {
      throw new AppError(`Only ${left} ${item.uom?.symbol ?? ''} of ${item.name} on this GRN is still to be labelled, not ${total}.`, 400, 'OVER_GRN')
    }
    sourceType = 'GRN'
    sourceId = line.grnId
    sourceRef = line.grn.grnNumber
  }
  const created = await createPackages(tx, {
    spot,
    packType: g.packType,
    qtys: g.qtys,
    lotNo: g.lotNo,
    notes: g.notes,
    sourceType,
    sourceId,
    sourceRef,
    grnLineId: g.grnLineId ?? null,
    userId,
    unit: item.uom?.symbol ?? '',
    itemName: item.name,
  })
  // "Remember for this item": what one package is, and — when they were all
  // the same, give or take a smaller last one — how much a sticker holds.
  if (g.remember) {
    const head = g.qtys.slice(0, -1)
    const same = head.every((q) => q === g.qtys[0]) && g.qtys[g.qtys.length - 1] <= g.qtys[0]
    await tx.item.update({ where: { id: g.itemId }, data: { packType: g.packType, packQty: same && g.qtys.length > 1 ? g.qtys[0] : null } })
  }
  return created
}

/** The number printed on a sticker for the document its stock came in on. */
export async function sourceRefOf(type: InwardSource, id: string): Promise<string | null> {
  switch (type) {
    case 'GRN':
      return (await prisma.gRN.findUnique({ where: { id }, select: { grnNumber: true } }))?.grnNumber ?? null
    case 'STOCK_IN':
      return (await prisma.stockAdjustment.findUnique({ where: { id }, select: { adjustmentNumber: true } }))?.adjustmentNumber ?? null
    case 'OPENING':
      return 'Opening stock'
    case 'CUSTOMER_GRN':
      return (await prisma.customerGRN.findUnique({ where: { id }, select: { grnNumber: true } }))?.grnNumber ?? null
    case 'JOB_WORK_RETURN':
      return (await prisma.jobWorkReturn.findUnique({ where: { id }, select: { returnNumber: true } }))?.returnNumber ?? null
    case 'MR_RETURN':
      return (await prisma.materialRequisition.findUnique({ where: { id }, select: { mrNumber: true } }))?.mrNumber ?? null
  }
}

type Came = {
  itemId: string
  warehouseId: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId: string | null
  qty: number
  lotNo: string | null
  grnLineId: string | null
}

/** What came in on one inward document: its GRN lines, the lines given, or its rows on the stock ledger. */
async function whatCameIn(data: InwardQuery): Promise<Came[]> {
  if (data.sourceType === 'GRN') {
    const lines = await prisma.gRNLine.findMany({
      where: { grnId: data.sourceId, acceptedQty: { gt: 0 } },
      select: { id: true, itemId: true, warehouseId: true, acceptedQty: true, batchNumber: true },
      orderBy: { id: 'asc' },
    })
    return lines.map((l) => ({
      itemId: l.itemId,
      warehouseId: l.warehouseId,
      ownership: 'OWNED' as const,
      ownerCustomerId: null,
      qty: Number(l.acceptedQty),
      lotNo: l.batchNumber,
      grnLineId: l.id,
    }))
  }
  if (data.lines?.length) {
    return data.lines.map((l) => ({ ...l, ownerCustomerId: l.ownerCustomerId ?? null, lotNo: l.lotNo ?? null, grnLineId: null }))
  }
  // Every inward writes its rows on the ledger, so that is where to read it.
  const rows = await prisma.stockLedger.findMany({
    where: { referenceType: LEDGER_REF[data.sourceType], referenceId: data.sourceId, inQty: { gt: 0 }, sizeId: null },
    select: { itemId: true, warehouseId: true, ownership: true, ownerCustomerId: true, inQty: true, batchNumber: true },
    orderBy: { createdAt: 'asc' },
  })
  const byKey = new Map<string, Came>()
  for (const r of rows) {
    const key = [r.itemId, r.warehouseId, r.ownership, r.ownerCustomerId ?? '', r.batchNumber ?? ''].join('|')
    const had = byKey.get(key)
    if (had) had.qty = round3(had.qty + Number(r.inQty))
    else
      byKey.set(key, {
        itemId: r.itemId,
        warehouseId: r.warehouseId,
        ownership: r.ownership,
        ownerCustomerId: r.ownerCustomerId,
        qty: Number(r.inQty),
        lotNo: r.batchNumber,
        grnLineId: null,
      })
  }
  return [...byKey.values()]
}

/**
 * What came in on one inward document, as stickers: one row per item and
 * store, with how much can still have stickers and the stickers it gets — the
 * item's own setting, or one a roll or box, or one for the lot.
 */
export async function planStickers(data: InwardQuery) {
  const sourceRef = await sourceRefOf(data.sourceType, data.sourceId)
  if (!sourceRef) throw new AppError('That document does not exist', 404, 'NOT_FOUND')
  const came = await whatCameIn(data)

  const [items, stores, owners] = await Promise.all([
    prisma.item.findMany({
      where: { id: { in: [...new Set(came.map((c) => c.itemId))] } },
      select: { id: true, code: true, name: true, categoryId: true, packType: true, packQty: true, contentQty: true, contentUnit: true, uom: { select: { symbol: true, name: true } } },
    }),
    prisma.warehouse.findMany({ where: { id: { in: [...new Set(came.map((c) => c.warehouseId))] } }, select: { id: true, name: true } }),
    prisma.customer.findMany({
      where: { id: { in: came.map((c) => c.ownerCustomerId).filter((x): x is string => !!x) } },
      select: { id: true, name: true },
    }),
  ])
  const itemOf = new Map(items.map((i) => [i.id, i]))
  const storeOf = new Map(stores.map((w) => [w.id, w.name]))
  const ownerOf = new Map(owners.map((c) => [c.id, c.name]))
  const spotOf = (c: Came) => ({ itemId: c.itemId, warehouseId: c.warehouseId, ownership: c.ownership, ownerCustomerId: c.ownerCustomerId })
  // Read for every line at once: rules, positions, and what this document has
  // had labelled already — a second look at the same GRN offers only the rest.
  const [ruleOf, positionOf, byLine, bySpot] = await Promise.all([
    packageRules(prisma),
    positionsOf(prisma, came.map(spotOf)),
    prisma.stockPackage.groupBy({
      by: ['grnLineId'],
      where: { grnLineId: { in: came.map((c) => c.grnLineId).filter((x): x is string => !!x) }, status: { not: 'VOID' } },
      _sum: { initialQty: true },
    }),
    prisma.stockPackage.groupBy({
      by: ['itemId', 'warehouseId', 'ownership', 'ownerCustomerId'],
      where: { sourceType: data.sourceType, sourceId: data.sourceId, status: { not: 'VOID' } },
      _sum: { initialQty: true },
    }),
  ])
  const doneByLine = new Map(byLine.map((r) => [r.grnLineId, Number(r._sum.initialQty ?? 0)]))
  const spotKey = (x: { itemId: string; warehouseId: string; ownership: string; ownerCustomerId: string | null }) =>
    [x.itemId, x.warehouseId, x.ownership, x.ownerCustomerId ?? ''].join('|')
  const doneBySpot = new Map(bySpot.map((r) => [spotKey(r), Number(r._sum.initialQty ?? 0)]))

  const targets = []
  const untracked: Array<{ itemId: string; code: string; name: string; category: string }> = []
  for (const c of came) {
    const item = itemOf.get(c.itemId)
    if (!item) continue
    const d = stickerDefaultsFrom(item, ruleOf(item.categoryId))
    if (!d.tracked) {
      if (!untracked.some((u) => u.itemId === item.id)) untracked.push({ itemId: item.id, code: item.code, name: item.name, category: d.category })
      continue
    }
    const done = c.grnLineId ? (doneByLine.get(c.grnLineId) ?? 0) : (doneBySpot.get(spotKey(c)) ?? 0)
    const pos = positionOf(spotOf(c))
    const max = round3(Math.min(c.qty - done, pos.loose))
    if (max <= 0.0005) continue
    targets.push({
      key: c.grnLineId ?? [c.itemId, c.warehouseId, c.ownership, c.ownerCustomerId ?? '', c.lotNo ?? ''].join('|'),
      itemId: c.itemId,
      itemCode: item.code,
      item: item.name,
      unit: item.uom?.symbol ?? '',
      warehouseId: c.warehouseId,
      store: storeOf.get(c.warehouseId) ?? '',
      ownership: c.ownership,
      ownerCustomerId: c.ownerCustomerId,
      owner: c.ownerCustomerId ? (ownerOf.get(c.ownerCustomerId) ?? null) : null,
      lotNo: c.lotNo,
      grnLineId: c.grnLineId,
      max,
      packType: d.packType,
      perPack: d.perPack,
      remembered: item.packType != null || item.packQty != null,
      /** What the document brought in, before any stickers: rechecked under the lock. */
      came: c.qty,
      // What one unit holds, for the sentence: "1 box on each (144 pcs)".
      content: item.contentQty && Number(item.contentQty) > 0 ? { each: Number(item.contentQty), unit: item.contentUnit || 'pcs' } : null,
      qtys: suggestQtys(max, d.perPack),
    })
  }
  return { sourceType: data.sourceType, sourceId: data.sourceId, sourceRef, targets, untracked }
}

/**
 * Makes the stickers for what came in on a document, by the item rules, with
 * nobody asked. Called straight after a GRN is saved, a stock-in approved and
 * the rest. Never throws: the stock is in whatever happens here, and anything
 * missed still shows under "No stickers".
 */
export async function autoStickers(query: InwardQuery, userId: string | null): Promise<{ count: number; ids: string[]; sourceRef: string | null }> {
  try {
    const plan = await planStickers(query)
    const targets = plan.targets.filter((t) => t.qtys.length)
    if (!targets.length) return { count: 0, ids: [], sourceRef: plan.sourceRef }
    const created = await prisma.$transaction(
      async (tx) => {
        const all = []
        for (const t of targets) {
          // Counted again now the stock is locked: a second "Print stickers"
          // pressed at the same moment has to see the first one's stickers,
          // or the same 12 rolls get 24.
          const spot = { itemId: t.itemId, warehouseId: t.warehouseId, ownership: t.ownership, ownerCustomerId: t.ownerCustomerId }
          await lockedBalanceOf(tx, spot)
          const done = await tx.stockPackage.aggregate({
            where: t.grnLineId
              ? { grnLineId: t.grnLineId, status: { not: 'VOID' } }
              : { ...spot, sourceType: query.sourceType, sourceId: query.sourceId, status: { not: 'VOID' } },
            _sum: { initialQty: true },
          })
          const remaining = round3(t.came - Number(done._sum.initialQty ?? 0))
          if (remaining <= 0.0005) continue
          const planned = round3(t.qtys.reduce((s, q) => s + q, 0))
          if (remaining < planned - 1e-9) t.qtys = suggestQtys(remaining, t.perPack)
          all.push(
            ...(await labelGroup(
              tx,
              {
                itemId: t.itemId,
                warehouseId: t.warehouseId,
                ownership: t.ownership,
                ownerCustomerId: t.ownerCustomerId,
                packType: t.packType,
                qtys: t.qtys,
                lotNo: t.lotNo,
                grnLineId: t.grnLineId,
              },
              { type: query.sourceType, id: query.sourceId, ref: plan.sourceRef },
              userId,
            )),
          )
        }
        return all
      },
      { timeout: 120_000, maxWait: 20_000 },
    )
    return { count: created.length, ids: created.map((c) => c.id), sourceRef: plan.sourceRef }
  } catch (err) {
    logger.warn(`Stickers were not made for ${query.sourceType} ${query.sourceId}: ${err instanceof Error ? err.message : String(err)}`)
    return { count: 0, ids: [], sourceRef: null }
  }
}

/** " 12 stickers made, ready to print." — added to the message of whatever brought the stock in. */
export const stickersNote = (count: number) => (count > 0 ? ` ${count} ${count === 1 ? 'sticker' : 'stickers'} made, ready to print.` : '')

/**
 * A document's stock going out again — a GRN cancelled or deleted, a
 * customer's receipt cancelled: its stickers still in stock are withdrawn, so
 * none is left on the books for goods that are not there. Inside the cancel's
 * own transaction, so the two cannot come apart.
 */
export async function withdrawStickers(
  tx: Prisma.TransactionClient,
  source: { type: InwardSource; id: string; ref: string },
  reason: string,
  userId: string | null,
): Promise<number> {
  const live = await tx.stockPackage.findMany({
    where: { sourceType: source.type, sourceId: source.id, status: 'IN_STOCK' },
    select: { id: true, qty: true, warehouseId: true },
  })
  for (const p of live) {
    await tx.stockPackage.update({ where: { id: p.id }, data: { status: 'VOID', qty: 0 } })
    await tx.stockPackageMove.create({
      data: {
        packageId: p.id,
        type: 'VOIDED',
        qty: -Number(p.qty),
        balanceAfter: 0,
        warehouseId: p.warehouseId,
        referenceType: source.type,
        referenceId: source.id,
        referenceNumber: source.ref,
        notes: reason,
        createdById: userId,
      },
    })
  }
  return live.length
}

/**
 * A GRN corrected: no line may keep stickers for more than it now brought in.
 * The newest stickers still whole come off first, until what is stickered
 * fits; the automatic stickers afterwards make any the line is now short of.
 */
export async function trimGrnStickers(tx: Prisma.TransactionClient, grn: { id: string; grnNumber: string }, userId: string | null): Promise<number> {
  const lines = await tx.gRNLine.findMany({ where: { grnId: grn.id }, select: { id: true, acceptedQty: true } })
  const accepted = new Map(lines.map((l) => [l.id, Number(l.acceptedQty)]))
  const stickers = await tx.stockPackage.findMany({
    where: { sourceType: 'GRN', sourceId: grn.id, status: { not: 'VOID' } },
    select: { id: true, grnLineId: true, initialQty: true, qty: true, status: true, warehouseId: true },
    orderBy: { createdAt: 'desc' },
  })
  let withdrawn = 0
  const byLine = new Map<string, typeof stickers>()
  for (const p of stickers) byLine.set(p.grnLineId ?? '', [...(byLine.get(p.grnLineId ?? '') ?? []), p])
  for (const [lineId, list] of byLine) {
    // A line taken off the receipt brought in nothing.
    const allowed = accepted.get(lineId) ?? 0
    let stickered = round3(list.reduce((s, p) => s + Number(p.initialQty), 0))
    for (const p of list) {
      if (stickered <= allowed + 1e-9) break
      // Only a whole one: a sticker already issued from is stock that moved on.
      if (p.status !== 'IN_STOCK' || Number(p.qty) < Number(p.initialQty) - 1e-9) continue
      await tx.stockPackage.update({ where: { id: p.id }, data: { status: 'VOID', qty: 0 } })
      await tx.stockPackageMove.create({
        data: {
          packageId: p.id,
          type: 'VOIDED',
          qty: -Number(p.qty),
          balanceAfter: 0,
          warehouseId: p.warehouseId,
          referenceType: 'GRN',
          referenceId: grn.id,
          referenceNumber: grn.grnNumber,
          notes: `${grn.grnNumber} corrected to less than its stickers held`,
          createdById: userId,
        },
      })
      stickered = round3(stickered - Number(p.initialQty))
      withdrawn++
    }
  }
  return withdrawn
}
