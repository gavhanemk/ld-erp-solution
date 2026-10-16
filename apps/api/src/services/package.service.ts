import type { Prisma, PackType, PackageMoveType, StockOwnership } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { balanceOf, lockedBalanceOf } from './stock.service'

/*
 * Labelled packages of stock: rolls, boxes, cartons with a QR sticker each.
 *
 * The stock ledger stays the record of how much of an item a store holds.
 * Packages say how that stock sits on the rack. The one rule that keeps the
 * two honest: the packages of an item in a store never add up to more than
 * the ledger holds there. What is not in a package is "loose".
 */

export const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * PK-0123: what the sticker carries and what a person reads off it. Four
 * digits, short enough to say aloud, running longer past 9999. Stickers
 * printed before carry six (PK-000123); they still read — see codeCandidates.
 */
export async function nextPackageCode(tx: Prisma.TransactionClient): Promise<string> {
  const [row] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('ld_erp.stock_package_code_seq') AS n`
  return `PK-${String(Number(row.n)).padStart(4, '0')}`
}

/**
 * What a scanner or a person typed, as a package code.
 *
 * A handheld scanner types exactly what the sticker holds; a phone's own
 * camera app may hand over a link. Both are taken, and so is "pk 123" typed by
 * hand at the desk.
 */
export function normaliseCode(raw: string): string {
  let s = raw.trim()
  if (s.includes('/')) s = s.split('/').filter(Boolean).pop() ?? s
  s = s.toUpperCase().replace(/\s+/g, '')
  // "PK-0057", "pk57", or the bare number under the QR: "57".
  const digits = s.match(/^(?:PK-?)?(\d{1,9})$/)
  if (digits) return `PK-${String(Number(digits[1])).padStart(4, '0')}`
  return s
}

/**
 * The codes a scanned or typed sticker number can be on: PK-0123 now, or
 * PK-000123 on a sticker printed before codes were shortened. One number is
 * only ever one of the two — the count behind them never goes back.
 */
export function codeCandidates(raw: string): string[] {
  const code = normaliseCode(raw)
  const m = code.match(/^PK-(\d+)$/)
  if (!m) return [code]
  const n = String(Number(m[1]))
  return [...new Set([`PK-${n.padStart(4, '0')}`, `PK-${n.padStart(6, '0')}`])]
}

/**
 * A rack as typed or scanned, tidied so "b-3", "B 3" and "Rack B-3" are one
 * rack: capitals, single spaces, no leading "Rack". Blank is no rack.
 */
export function normaliseRack(raw: string | null | undefined): string | null {
  const s = (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/^RACK[\s:.-]*/, '')
    .trim()
  if (!s) return null
  if (s.length > 20) throw new AppError('A rack name is at most 20 letters, like B-3 or SHELF 12.', 400, 'BAD_RACK')
  return s
}

/**
 * Puts a package on a rack, or takes it off one (null), and notes it in the
 * package's history. Nothing happens when it is already there.
 */
export async function setRack(
  tx: Prisma.TransactionClient,
  pkg: { id: string; rack: string | null; qty: Prisma.Decimal | number; warehouseId: string },
  rack: string | null,
  by: { userId: string | null; referenceType?: string | null; referenceId?: string | null; referenceNumber?: string | null },
) {
  if ((pkg.rack ?? null) === rack) return false
  await tx.stockPackage.update({ where: { id: pkg.id }, data: { rack } })
  await recordPackageMove(tx, {
    packageId: pkg.id,
    type: 'RACKED',
    qty: 0,
    balanceAfter: Number(pkg.qty),
    warehouseId: pkg.warehouseId,
    notes: rack ? (pkg.rack ? `Rack ${pkg.rack} → ${rack}` : `Put on rack ${rack}`) : `Taken off rack ${pkg.rack}`,
    referenceType: by.referenceType ?? null,
    referenceId: by.referenceId ?? null,
    referenceNumber: by.referenceNumber ?? null,
    userId: by.userId,
  })
  return true
}

/** The racks in use in a store, for the rack box to offer. */
export async function racksIn(tx: Prisma.TransactionClient, warehouseId?: string | null) {
  const rows = await tx.stockPackage.groupBy({
    by: ['rack'],
    where: { status: 'IN_STOCK', rack: { not: null }, ...(warehouseId ? { warehouseId } : {}) },
    _count: true,
    orderBy: { rack: 'asc' },
  })
  return rows.map((r) => ({ rack: r.rack as string, packages: r._count }))
}

/** Held for the rest of the transaction, so two scans of one box cannot both take from it. */
export async function lockPackage(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.stock_packages WHERE id = ${id} FOR UPDATE`
  const pkg = await tx.stockPackage.findUnique({
    where: { id },
    include: { item: { select: { name: true, code: true, uom: { select: { symbol: true } } } }, warehouse: { select: { name: true } } },
  })
  if (!pkg) throw new AppError('That package does not exist', 404, 'NOT_FOUND')
  return pkg
}

/** What a package was labelled from: a GRN, stock already on the rack, a split, or another inward. */
export type PackageSource = 'GRN' | 'STOCK' | 'SPLIT' | 'STOCK_IN' | 'OPENING' | 'CUSTOMER_GRN' | 'JOB_WORK_RETURN' | 'MR_RETURN'

export interface StockSpot {
  itemId: string
  warehouseId: string
  ownership: StockOwnership
  ownerCustomerId: string | null
}

/**
 * The stock of an item in one store, and how much of it is in packages.
 *
 * `loose` is what can still be labelled. Negative means the packages claim
 * more than the store holds: something left without being scanned.
 */
export async function positionOf(tx: Prisma.TransactionClient, spot: StockSpot) {
  // Usable and held together, as `positionsOf` and the sticker sync count
  // them: a held roll is still a roll on the rack with its sticker.
  const key = { itemId: spot.itemId, warehouseId: spot.warehouseId, ownership: spot.ownership, ownerCustomerId: spot.ownerCustomerId }
  const [ledger, held, packed] = await Promise.all([
    balanceOf(tx, key),
    balanceOf(tx, { ...key, grade: 'R' }),
    tx.stockPackage.aggregate({
      where: {
        itemId: spot.itemId,
        warehouseId: spot.warehouseId,
        ownership: spot.ownership,
        ownerCustomerId: spot.ownerCustomerId,
        status: 'IN_STOCK',
      },
      _sum: { qty: true },
      _count: true,
    }),
  ])
  const inPackages = round3(Number(packed._sum.qty ?? 0))
  const inStore = round3(ledger.qty + held.qty)
  return {
    inStore,
    inPackages,
    packages: packed._count,
    loose: round3(inStore - inPackages),
    avgRate: ledger.avgRate,
  }
}

type PackageRule = { tracked: boolean; packType: PackType | null; category: string }

/**
 * Every category's rule from one read, for a screen that asks about dozens of
 * items: one query rather than one an item.
 */
export async function packageRules(tx: Prisma.TransactionClient): Promise<(categoryId: string) => PackageRule> {
  const all = await tx.itemCategory.findMany({ select: { id: true, name: true, parentId: true, trackPackages: true, packType: true } })
  const byId = new Map(all.map((c) => [c.id, c]))
  const memo = new Map<string, PackageRule>()
  return (categoryId) => {
    const had = memo.get(categoryId)
    if (had) return had
    let c = byId.get(categoryId)
    const own = c?.name ?? ''
    let packType: PackType | null = null
    let rule: PackageRule = { tracked: false, packType: null, category: own }
    for (let i = 0; c && i < 10; i++) {
      packType ??= c.packType
      if (c.trackPackages) {
        rule = { tracked: true, packType: packType ?? null, category: own }
        break
      }
      c = c.parentId ? byId.get(c.parentId) : undefined
    }
    if (!rule.tracked) rule = { tracked: false, packType, category: own }
    memo.set(categoryId, rule)
    return rule
  }
}

const spotKey = (s: StockSpot) => [s.itemId, s.warehouseId, s.ownership, s.ownerCustomerId ?? ''].join('|')

/**
 * `positionOf` for many spots in two queries: the ledger and the packages,
 * each summed per item, store and owner. The same figures — our own grade A
 * stock with no size, as a package holds.
 */
export async function positionsOf(tx: Prisma.TransactionClient, spots: StockSpot[]) {
  const itemIds = [...new Set(spots.map((s) => s.itemId))]
  const [ledger, packed] = itemIds.length
    ? await Promise.all([
        tx.$queryRaw<Array<{ itemId: string; warehouseId: string; ownership: StockOwnership; ownerCustomerId: string | null; qty: number }>>`
          SELECT "itemId", "warehouseId", ownership::text AS ownership, "ownerCustomerId", COALESCE(SUM("inQty" - "outQty"), 0)::float8 AS qty
          FROM ld_erp.stock_ledger
          WHERE "itemId" = ANY(${itemIds}::text[]) AND "sizeId" IS NULL AND grade IN ('A', 'R')
          GROUP BY 1, 2, 3, 4`,
        tx.stockPackage.groupBy({
          by: ['itemId', 'warehouseId', 'ownership', 'ownerCustomerId'],
          where: { itemId: { in: itemIds }, status: 'IN_STOCK' },
          _sum: { qty: true },
        }),
      ])
    : [[], []]
  const inStore = new Map(ledger.map((r) => [spotKey(r), round3(Number(r.qty))]))
  const inPackages = new Map(packed.map((r) => [spotKey(r), round3(Number(r._sum.qty ?? 0))]))
  return (s: StockSpot) => {
    const store = inStore.get(spotKey(s)) ?? 0
    const pk = inPackages.get(spotKey(s)) ?? 0
    return { inStore: store, inPackages: pk, loose: round3(store - pk) }
  }
}

/**
 * Whether an item's stock is kept in packages, and what one usually is.
 *
 * Switched on per category. A sub-category without its own setting follows
 * the category it sits under, so turning on "Fabric" covers every fabric.
 */
export async function packageRule(
  tx: Prisma.TransactionClient,
  categoryId: string,
): Promise<{ tracked: boolean; packType: PackType | null; category: string }> {
  const all = await tx.itemCategory.findMany({ select: { id: true, name: true, parentId: true, trackPackages: true, packType: true } })
  const byId = new Map(all.map((c) => [c.id, c]))
  let c = byId.get(categoryId)
  const own = c?.name ?? ''
  let packType: PackType | null = null
  for (let i = 0; c && i < 10; i++) {
    packType ??= c.packType
    if (c.trackPackages) return { tracked: true, packType: packType ?? null, category: own }
    c = c.parentId ? byId.get(c.parentId) : undefined
  }
  return { tracked: false, packType, category: own }
}

/** Units that are themselves a package: 12 rolls are 12 stickers, not one. */
const UNIT_PACK: Array<[RegExp, PackType]> = [
  [/^(roll|rolls|rl|rls|than|thans|reel|reels)$/, 'ROLL'],
  [/^(box|boxes|bx)$/, 'BOX'],
  [/^(carton|cartons|ctn|ctns)$/, 'CARTON'],
  [/^(bag|bags)$/, 'BAG'],
  [/^(bundle|bundles|bdl|bdls)$/, 'BUNDLE'],
  [/^(packet|packets|pkt|pkts|pack|packs)$/, 'PACKET'],
  [/^(cone|cones|spool|spools|tube|tubes|drum|drums|can|cans)$/, 'OTHER'],
]

/**
 * How an item's stickers start out in the sticker window: what one package is
 * and how much one sticker holds.
 *
 * The item's own remembered setting first. Without one, a unit that is itself
 * a package — rolls, boxes — gets a sticker each; anything measured — metres,
 * kilos, pieces — one sticker for the lot, which the person splits if it came
 * in several. The window always lets them change it.
 */
type StickerItem = { categoryId: string; packType: PackType | null; packQty: Prisma.Decimal | number | null; uom: { symbol: string; name?: string | null } | null }
export type StickerDefaults = { packType: PackType; perPack: number | null; tracked: boolean; category: string }

export async function stickerDefaults(tx: Prisma.TransactionClient, item: StickerItem): Promise<StickerDefaults> {
  return stickerDefaultsFrom(item, await packageRule(tx, item.categoryId))
}

/** The same, from a rule already in hand: see `packageRules`. */
export function stickerDefaultsFrom(item: StickerItem, rule: PackageRule): StickerDefaults {
  const unit = [item.uom?.symbol, item.uom?.name].map((u) => (u ?? '').trim().toLowerCase())
  const byUnit = UNIT_PACK.find(([re]) => unit.some((u) => re.test(u)))?.[1] ?? null
  const remembered = item.packQty != null && Number(item.packQty) > 0 ? Number(item.packQty) : null
  return {
    packType: item.packType ?? (byUnit && byUnit !== 'OTHER' ? byUnit : null) ?? rule.packType ?? byUnit ?? 'BOX',
    perPack: remembered ?? (byUnit ? 1 : null),
    tracked: rule.tracked,
    category: rule.category,
  }
}

/** 12 at 1 a sticker → twelve 1s; 25 at 10 → 10, 10, 5; nothing to go by → one for the lot. */
export function suggestQtys(total: number, perPack: number | null): number[] {
  const t = round3(total)
  if (!(t > 0)) return []
  if (!perPack || perPack >= t) return [t]
  const n = Math.floor(t / perPack + 1e-9)
  if (n > 500) return [t]
  const rest = round3(t - n * perPack)
  return [...Array.from({ length: n }, () => perPack), ...(rest > 0.0005 ? [rest] : [])]
}

/** Every category whose items are kept in packages, including sub-categories that inherit it. */
export async function trackedCategoryIds(tx: Prisma.TransactionClient): Promise<string[]> {
  const all = await tx.itemCategory.findMany({ select: { id: true, parentId: true, trackPackages: true } })
  const byId = new Map(all.map((c) => [c.id, c]))
  return all
    .filter((c) => {
      let x: typeof c | undefined = c
      for (let i = 0; x && i < 10; i++) {
        if (x.trackPackages) return true
        x = x.parentId ? byId.get(x.parentId) : undefined
      }
      return false
    })
    .map((c) => c.id)
}

export async function recordPackageMove(
  tx: Prisma.TransactionClient,
  m: {
    packageId: string
    type: PackageMoveType
    qty: number
    balanceAfter: number
    warehouseId: string
    toWarehouseId?: string | null
    referenceType?: string | null
    referenceId?: string | null
    referenceNumber?: string | null
    relatedPackageId?: string | null
    notes?: string | null
    userId?: string | null
  },
) {
  return tx.stockPackageMove.create({
    data: {
      packageId: m.packageId,
      type: m.type,
      qty: round3(m.qty),
      balanceAfter: round3(m.balanceAfter),
      warehouseId: m.warehouseId,
      toWarehouseId: m.toWarehouseId ?? null,
      referenceType: m.referenceType ?? null,
      referenceId: m.referenceId ?? null,
      referenceNumber: m.referenceNumber ?? null,
      relatedPackageId: m.relatedPackageId ?? null,
      notes: m.notes ?? null,
      createdById: m.userId ?? null,
    },
  })
}

/**
 * New packages for stock already in a store: one per quantity given.
 *
 * Refused if they would take more than is loose — labelled stock cannot be
 * labelled twice, and a sticker for stock the store does not have would send
 * somebody looking for a box that is not there.
 */
export async function createPackages(
  tx: Prisma.TransactionClient,
  input: {
    spot: StockSpot
    packType: PackType
    qtys: number[]
    lotNo?: string | null
    /** The rack it sits on: a split keeps the rack of the package it was cut from. */
    rack?: string | null
    notes?: string | null
    sourceType: PackageSource
    sourceId?: string | null
    /** The document's number, printed on the sticker. */
    sourceRef?: string | null
    grnLineId?: string | null
    parentId?: string | null
    userId: string | null
    /** Skip the loose check: a split re-labels stock that is already in a package. */
    fromPackage?: boolean
    unit: string
    itemName: string
    /** 'R' for held stock (rejected at receipt): never issued until released. */
    grade?: string
  },
) {
  const qtys = input.qtys.map(round3)
  if (!qtys.length) throw new AppError('Enter at least one package.', 400, 'NO_PACKAGES')
  if (qtys.some((q) => !(q > 0))) throw new AppError('Every package needs a quantity above nought.', 400, 'BAD_QTY')
  const total = round3(qtys.reduce((s, q) => s + q, 0))

  if (!input.fromPackage) {
    // The same lock every stock movement of this item and store takes: two
    // people stickering the same stock at once wait for each other, so the
    // second sees what the first made and cannot sticker it again.
    await lockedBalanceOf(tx, input.spot)
    const pos = await positionOf(tx, input.spot)
    if (total > pos.loose + 1e-9) {
      throw new AppError(
        pos.loose > 0
          ? `Only ${pos.loose} ${input.unit} of ${input.itemName} in this store is not yet in a package, so ${total} ${input.unit} cannot be labelled.`
          : `All the ${input.itemName} in this store is already in packages (${pos.inPackages} ${input.unit} in ${pos.packages}).`,
        400,
        'NOT_ENOUGH_LOOSE',
      )
    }
  }

  const created = []
  for (const q of qtys) {
    const code = await nextPackageCode(tx)
    const pkg = await tx.stockPackage.create({
      data: {
        code,
        itemId: input.spot.itemId,
        warehouseId: input.spot.warehouseId,
        ownership: input.spot.ownership,
        ownerCustomerId: input.spot.ownerCustomerId,
        packType: input.packType,
        initialQty: q,
        qty: q,
        lotNo: input.lotNo || null,
        rack: input.rack || null,
        notes: input.notes || null,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        sourceRef: input.sourceRef ?? null,
        grnLineId: input.grnLineId ?? null,
        parentId: input.parentId ?? null,
        grade: input.grade ?? 'A',
        createdById: input.userId,
      },
    })
    await recordPackageMove(tx, {
      packageId: pkg.id,
      type: input.parentId ? 'SPLIT_FROM' : 'CREATED',
      qty: q,
      balanceAfter: q,
      warehouseId: pkg.warehouseId,
      relatedPackageId: input.parentId ?? null,
      notes: input.notes ?? null,
      userId: input.userId,
    })
    created.push(pkg)
  }
  return created
}

type Splittable = {
  id: string
  code: string
  qty: Prisma.Decimal | number
  itemId: string
  warehouseId: string
  ownership: StockOwnership
  ownerCustomerId: string | null
  packType: PackType
  lotNo: string | null
  rack: string | null
  sourceId: string | null
  sourceRef: string | null
  grnLineId: string | null
  grade: string
}

/**
 * Part of a roll going and the rest staying. A sticker says what its roll
 * held, so it is never left on a roll that now holds less: the part taken and
 * the rest each get a sticker of their own, and the old one is retired (SPLIT,
 * nothing in it) — scanned again, it names what replaced it. Taking all of it
 * splits nothing: the package itself is the part.
 *
 * Returns the part, for the caller to issue, move, release or send back, and
 * the rest, which stays on the same rack waiting on "Ready to print".
 */
export async function splitOff(
  tx: Prisma.TransactionClient,
  pkg: Splittable,
  take: number,
  why: { notes: string; userId: string | null; unit?: string; referenceType?: string | null; referenceId?: string | null; referenceNumber?: string | null },
): Promise<{ part: { id: string; code: string; qty: number }; rest: { id: string; code: string; qty: number } | null }> {
  const has = round3(Number(pkg.qty))
  const t = round3(take)
  if (t >= has - 0.0005) return { part: { id: pkg.id, code: pkg.code, qty: has }, rest: null }
  const left = round3(has - t)
  const unit = why.unit ? ` ${why.unit}` : ''
  const from = {
    spot: { itemId: pkg.itemId, warehouseId: pkg.warehouseId, ownership: pkg.ownership, ownerCustomerId: pkg.ownerCustomerId },
    packType: pkg.packType,
    lotNo: pkg.lotNo,
    rack: pkg.rack,
    sourceType: 'SPLIT' as const,
    sourceId: pkg.sourceId,
    sourceRef: pkg.sourceRef,
    grnLineId: pkg.grnLineId,
    parentId: pkg.id,
    userId: why.userId,
    fromPackage: true,
    unit: why.unit ?? '',
    itemName: '',
    grade: pkg.grade,
  }
  const [part] = await createPackages(tx, { ...from, qtys: [t], notes: `${t}${unit} of ${pkg.code}: ${why.notes}` })
  const [rest] = await createPackages(tx, { ...from, qtys: [left], notes: `The rest of ${pkg.code} after ${t}${unit} went (${why.notes})` })
  await tx.stockPackage.update({ where: { id: pkg.id }, data: { qty: 0, status: 'SPLIT' } })
  await recordPackageMove(tx, {
    packageId: pkg.id,
    type: 'SPLIT',
    qty: -has,
    balanceAfter: 0,
    warehouseId: pkg.warehouseId,
    referenceType: why.referenceType ?? null,
    referenceId: why.referenceId ?? null,
    referenceNumber: why.referenceNumber ?? null,
    relatedPackageId: rest.id,
    notes: `Sticker retired: ${t}${unit} became ${part.code} (${why.notes}); the ${left}${unit} left became ${rest.code}`,
    userId: why.userId,
  })
  return { part: { id: part.id, code: part.code, qty: t }, rest: { id: rest.id, code: rest.code, qty: left } }
}

/**
 * What took over from a retired sticker: the packages cut from it that are
 * still on stock, followed through later splits.
 */
export async function replacementsOf(tx: Prisma.TransactionClient, id: string) {
  const found: Array<{ code: string; qty: number }> = []
  for (let parents = [id], i = 0; parents.length && i < 20; i++) {
    const children = await tx.stockPackage.findMany({ where: { parentId: { in: parents } }, select: { id: true, code: true, qty: true, status: true }, orderBy: { code: 'asc' } })
    children.filter((c) => c.status === 'IN_STOCK').forEach((c) => found.push({ code: c.code, qty: Number(c.qty) }))
    parents = children.filter((c) => c.status === 'SPLIT').map((c) => c.id)
  }
  return found
}
