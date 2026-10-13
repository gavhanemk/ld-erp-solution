import type { Prisma, PackType, PackageMoveType, StockOwnership } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { balanceOf } from './stock.service'

/*
 * Labelled packages of stock: rolls, boxes, cartons with a QR sticker each.
 *
 * The stock ledger stays the record of how much of an item a store holds.
 * Packages say how that stock sits on the rack. The one rule that keeps the
 * two honest: the packages of an item in a store never add up to more than
 * the ledger holds there. What is not in a package is "loose".
 */

export const round3 = (n: number) => Math.round(n * 1000) / 1000

/** PK-000123: what the sticker carries and what a person reads off it. */
export async function nextPackageCode(tx: Prisma.TransactionClient): Promise<string> {
  const [row] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('ld_erp.stock_package_code_seq') AS n`
  return `PK-${String(Number(row.n)).padStart(6, '0')}`
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
  const digits = s.match(/^PK-?(\d{1,9})$/)
  if (digits) return `PK-${digits[1].padStart(6, '0')}`
  return s
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
  const [ledger, packed] = await Promise.all([
    balanceOf(tx, { itemId: spot.itemId, warehouseId: spot.warehouseId, ownership: spot.ownership, ownerCustomerId: spot.ownerCustomerId }),
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
  return {
    inStore: round3(ledger.qty),
    inPackages,
    packages: packed._count,
    loose: round3(ledger.qty - inPackages),
    avgRate: ledger.avgRate,
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
    notes?: string | null
    sourceType: 'GRN' | 'STOCK' | 'SPLIT'
    sourceId?: string | null
    grnLineId?: string | null
    parentId?: string | null
    userId: string | null
    /** Skip the loose check: a split re-labels stock that is already in a package. */
    fromPackage?: boolean
    unit: string
    itemName: string
  },
) {
  const qtys = input.qtys.map(round3)
  if (!qtys.length) throw new AppError('Enter at least one package.', 400, 'NO_PACKAGES')
  if (qtys.some((q) => !(q > 0))) throw new AppError('Every package needs a quantity above nought.', 400, 'BAD_QTY')
  const total = round3(qtys.reduce((s, q) => s + q, 0))

  if (!input.fromPackage) {
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
        notes: input.notes || null,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        grnLineId: input.grnLineId ?? null,
        parentId: input.parentId ?? null,
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
