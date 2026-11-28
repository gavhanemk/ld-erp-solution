import type { Prisma, ReallocationKind, StockPackage } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { financialYearOf, nextDocumentNumber } from '../lib/docNumber'
import { balanceOf, lockBalances, recordMovement, type StockKey } from './stock.service'
import { createPackages, recordPackageMove } from './package.service'
import { assertQtyFitsUnits } from './unitQuantity.service'
import { materialPlan } from './manufacturing.service'

/*
 * Brand stock (multi-brand phase 5): central stock earmarked for brands.
 *
 * A balance's stock is the company's, held as shares: central stock, for no
 * brand, and each brand's earmark. The stock ledger is the only record; a
 * share is its rows with that brand on them, and each share keeps its own
 * moving average (decision 5). Nothing here moves stock physically: a move
 * between shares is an out of one and an in to the other, in the same store,
 * at the giving share's average, so the company's stock and its value never
 * change.
 *
 *   - Earmark, move, release: a Stock Reallocation, raised by one person and
 *     approved by another (decision 8). An Admin may approve their own only
 *     as an override, with a reason kept on the document and in the audit.
 *   - Automatic: an MO's material issue takes its brand's own share first,
 *     then moves the rest from free central stock, only for an authorised MO
 *     and within what the MO still needs (decision 7).
 *   - Stickers and tags carry their share. Named stickers move whole; a part
 *     of a roll rides on it as a child sticker with the same lot, so stickers
 *     agree with the ledger share by share. Holds are never taken.
 *   - A customer's material is never a brand's.
 */

type Tx = Prisma.TransactionClient
export type Share = string | null

const round3 = (n: number) => Math.round(n * 1000) / 1000
const round2 = (n: number) => Math.round(n * 100) / 100

/** An MO may pull central stock automatically from Released to Packing (decision 7). */
export const AUTHORISED_MO_STATUSES = ['RELEASED', 'CUTTING', 'STITCHING', 'FINISHING', 'QC', 'PACKING'] as const
const STATUS_WORDS: Record<string, string> = {
  DRAFT: 'still a draft',
  RELEASED: 'released',
  COMPLETED: 'completed',
  CLOSED: 'closed',
}

/** What a share is called: the brand's name, or central stock. */
export async function shareName(tx: Tx, brandId: Share): Promise<string> {
  if (!brandId) return 'central stock'
  return (await tx.brand.findUnique({ where: { id: brandId }, select: { name: true } }))?.name ?? 'a brand'
}

/** Only an own brand in use can hold an earmark. */
export async function assertOwnBrand(tx: Tx, brandId: string): Promise<{ id: string; name: string }> {
  const b = await tx.brand.findUnique({ where: { id: brandId }, select: { id: true, name: true, type: true, isActive: true } })
  if (!b) throw new AppError('That brand does not exist', 404, 'NOT_FOUND')
  if (b.type === 'CUSTOM') throw new AppError(`${b.name} is a customer’s brand: stock is earmarked only for our own brands.`, 400, 'NOT_OWN_BRAND')
  if (!b.isActive) throw new AppError(`${b.name} is not in use.`, 400, 'BRAND_NOT_IN_USE')
  return { id: b.id, name: b.name }
}

/**
 * One share of a balance: what it holds, what is held on it for requisitions,
 * and what is free. Holds count on our usable stock without a size, as the
 * stock writer counts them; a requisition line's own holds can be named to
 * leave out.
 */
export async function shareFree(tx: Tx, key: StockKey & { brandId: Share }, exceptMrLines: string[] = []) {
  const bal = await balanceOf(tx, key)
  let held = 0
  if ((key.ownership ?? 'OWNED') === 'OWNED' && (key.grade ?? 'A') === 'A' && !key.sizeId) {
    const [row] = await tx.$queryRaw<Array<{ held: number }>>`
      SELECT COALESCE(SUM(qty), 0)::float8 AS held FROM ld_erp.stock_reservations
      WHERE status::text = 'ACTIVE' AND "itemId" = ${key.itemId} AND "warehouseId" = ${key.warehouseId}
        AND "brandId" IS NOT DISTINCT FROM ${key.brandId}::text
        AND NOT ("mrLineId" = ANY(${exceptMrLines}::text[]))`
    held = round3(Number(row?.held ?? 0))
  }
  return { qty: bal.qty, value: bal.value, avgRate: bal.avgRate, held, free: round3(Math.max(0, bal.qty - held)) }
}

interface MoveArgs {
  itemId: string
  warehouseId: string
  sizeId?: string | null
  grade?: string | null
  qty: number
  from: Share
  to: Share
  referenceId: string
  number: string
  notes: string
  userId: string | null
  /**
   * 'move': stickers named move with the stock (where the share's stock is
   * on stickers, at least the stickered part of what moves must be named); a
   * part of a roll rides on it as a child sticker. 'oldest': the same, the
   * oldest rolls taken by themselves, for an automatic move of a typed issue.
   * 'leave': stickers stay as they are, for an automatic move of a scanned
   * roll, which comes down with the issue in the same step.
   */
  stickers: 'move' | 'oldest' | 'leave'
  packageCodes?: string[]
  garmentCodes?: string[]
  /** Requisition lines whose own holds this move may take (an automatic move for that line's issue). */
  reservedFor?: string[]
  transactionDate?: Date
}

/**
 * Moves stock from one share of a store's balance to another: out at the
 * giving share's average, in at the same rate. Refused for more than the
 * giving share has free, for a customer's material, in a transit store, and
 * for sealed cartons (the stock writer's own rules).
 */
export async function moveShare(tx: Tx, a: MoveArgs): Promise<{ unitRate: number; packageCodes: string[]; garmentCodes: string[] }> {
  if ((a.from ?? null) === (a.to ?? null)) throw new AppError('Stock is moved from one share to another, not to itself.', 400, 'SAME_SHARE')
  const qty = round3(a.qty)
  if (!(qty > 0)) throw new AppError('A reallocation moves more than nothing.', 400, 'INVALID_QTY')
  const grade = a.grade ?? 'A'
  const key: StockKey = { itemId: a.itemId, warehouseId: a.warehouseId, ownership: 'OWNED', ownerCustomerId: null, sizeId: a.sizeId ?? null, grade }
  await lockBalances(tx, [key])
  const [fromName, toName, item] = await Promise.all([
    shareName(tx, a.from),
    shareName(tx, a.to),
    tx.item.findUnique({ where: { id: a.itemId }, select: { name: true, uom: { select: { symbol: true } } } }),
  ])
  const unit = item?.uom?.symbol ?? ''

  // ── Stickers: plan first, so a refusal changes nothing ──
  const takes: Array<{ pkg: StockPackage; take: number }> = []
  if (a.stickers !== 'leave' && !a.sizeId) {
    const pkgs = await tx.stockPackage.findMany({
      where: { itemId: a.itemId, warehouseId: a.warehouseId, ownership: 'OWNED', status: 'IN_STOCK', grade, brandId: a.from },
      orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
    })
    const share = await balanceOf(tx, { ...key, brandId: a.from })
    const onStickers = round3(pkgs.reduce((t, p) => t + Number(p.qty), 0))
    const loose = round3(Math.max(0, share.qty - onStickers))
    // Rolls are asked for only when the share holds the stock and some of it is on stickers;
    // a share too short is refused by the ledger below, saying whose the rest is.
    const need = !pkgs.length || share.qty + 1e-9 < qty ? 0 : round3(Math.max(0, qty - loose))
    // Oldest first, by themselves: as many rolls as the stickered part needs.
    const named =
      a.stickers === 'oldest'
        ? (() => {
            const picked: string[] = []
            let covered = 0
            for (const p of pkgs) {
              if (covered >= need - 0.0005) break
              picked.push(p.code.toUpperCase())
              covered = round3(covered + Number(p.qty))
            }
            return picked
          })()
        : [...new Set((a.packageCodes ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean))]
    let left = a.stickers === 'oldest' ? need : qty
    for (const code of named) {
      const p = pkgs.find((x) => x.code.toUpperCase() === code || (x.barcode ?? '').toUpperCase() === code)
      if (!p) throw new AppError(`Sticker ${code} is not ${fromName} of ${item?.name ?? 'this item'} in this store.`, 400, 'WRONG_STICKER')
      if (left <= 0.0005) throw new AppError(`More stickers named than the ${qty} ${unit} moving: ${code} is not needed.`, 400, 'TOO_MANY_STICKERS')
      const take = round3(Math.min(Number(p.qty), left))
      takes.push({ pkg: p, take })
      left = round3(left - take)
    }
    const onNamed = round3((a.stickers === 'oldest' ? need : qty) - left)
    if (onNamed + 0.0005 < need) {
      throw new AppError(
        `${round3(onStickers)} ${unit} of ${fromName} of ${item?.name ?? 'this item'} here is on stickers and only ${loose} ${unit} is loose: name the rolls for at least ${need} ${unit} of the ${qty} ${unit} (scan them, or pick them; a roll can go in part).`,
        400,
        'STICKERS_NEEDED',
      )
    }
  }

  // ── Garment tags: the tagged part of what moves is named ──
  const tagIds: string[] = []
  if (a.sizeId) {
    const tags = await tx.garment.findMany({
      where: { itemId: a.itemId, sizeId: a.sizeId, grade, warehouseId: a.warehouseId, ownership: 'OWNED', status: 'IN_STOCK', brandId: a.from, dcId: null },
      select: { id: true, code: true },
    })
    const share = await balanceOf(tx, { ...key, brandId: a.from })
    const untagged = round3(Math.max(0, share.qty - tags.length))
    const need = Math.max(0, Math.ceil(qty - untagged - 1e-9))
    const named = [...new Set((a.garmentCodes ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean))]
    for (const code of named) {
      const t = tags.find((x) => x.code.toUpperCase() === code)
      if (!t) throw new AppError(`Tag ${code} is not one of ${fromName}’s pieces in this store.`, 400, 'WRONG_TAG')
      tagIds.push(t.id)
    }
    if (tagIds.length > qty + 1e-9) throw new AppError(`${tagIds.length} tags named for ${qty} pieces.`, 400, 'TOO_MANY_TAGS')
    if (tagIds.length < need) {
      throw new AppError(`${tags.length} of ${fromName}’s pieces here carry tags: name at least ${need} of the ${qty} moving.`, 400, 'TAGS_NEEDED')
    }
  }

  // ── The ledger: out of one share, into the other at the same rate ──
  const out = await recordMovement(tx, {
    ...key,
    brandId: a.from,
    transactionType: 'REALLOCATION',
    direction: 'OUT',
    qty,
    referenceType: 'STOCK_REALLOCATION',
    referenceId: a.referenceId,
    notes: `${a.number}: ${fromName} → ${toName}${a.notes ? ` (${a.notes})` : ''}`,
    stickers: 'caller',
    reservedFor: a.reservedFor,
    transactionDate: a.transactionDate,
    earlierDate: 'move-up',
  })
  await recordMovement(tx, {
    ...key,
    brandId: a.to,
    transactionType: 'REALLOCATION',
    direction: 'IN',
    qty,
    unitRate: out.unitRate,
    referenceType: 'STOCK_REALLOCATION',
    referenceId: a.referenceId,
    notes: `${a.number}: ${fromName} → ${toName}${a.notes ? ` (${a.notes})` : ''}`,
    transactionDate: a.transactionDate,
    earlierDate: 'move-up',
  })

  // ── Stickers change share: whole, or a part carried as a child on the roll ──
  const moved: string[] = []
  for (const { pkg, take } of takes) {
    const has = round3(Number(pkg.qty))
    if (take >= has - 0.0005) {
      await tx.stockPackage.update({ where: { id: pkg.id }, data: { brandId: a.to } })
      await recordPackageMove(tx, {
        packageId: pkg.id,
        type: 'EARMARKED',
        qty: 0,
        balanceAfter: has,
        warehouseId: pkg.warehouseId,
        referenceType: 'STOCK_REALLOCATION',
        referenceId: a.referenceId,
        referenceNumber: a.number,
        notes: `${fromName} → ${toName}: the whole roll, ${has} ${unit}`,
        userId: a.userId,
      })
      moved.push(pkg.code)
      continue
    }
    const rest = round3(has - take)
    const [part] = await createPackages(tx, {
      spot: { itemId: pkg.itemId, warehouseId: pkg.warehouseId, ownership: pkg.ownership, ownerCustomerId: pkg.ownerCustomerId },
      packType: pkg.packType,
      qtys: [take],
      lotNo: pkg.lotNo,
      rack: pkg.rack,
      notes: `${take} ${unit} of ${pkg.code}, ${toName}: it rides on that roll until the roll is cut (${a.number})`,
      sourceType: 'SPLIT',
      sourceId: pkg.sourceId,
      sourceRef: pkg.sourceRef,
      grnLineId: pkg.grnLineId,
      sourceLineId: pkg.sourceLineId ?? null,
      parentId: pkg.id,
      userId: a.userId,
      fromPackage: true,
      unit,
      itemName: item?.name ?? '',
      grade: pkg.grade,
    })
    await tx.stockPackage.update({ where: { id: part.id }, data: { brandId: a.to } })
    await tx.stockPackage.update({ where: { id: pkg.id }, data: { qty: rest } })
    await recordPackageMove(tx, {
      packageId: pkg.id,
      type: 'EARMARKED',
      qty: -take,
      balanceAfter: rest,
      warehouseId: pkg.warehouseId,
      referenceType: 'STOCK_REALLOCATION',
      referenceId: a.referenceId,
      referenceNumber: a.number,
      relatedPackageId: part.id,
      notes: `${take} ${unit} of this roll is now ${toName}, on sticker ${part.code}; ${rest} ${unit} stays ${fromName} on this sticker`,
      userId: a.userId,
    })
    await recordPackageMove(tx, {
      packageId: part.id,
      type: 'EARMARKED',
      qty: 0,
      balanceAfter: take,
      warehouseId: pkg.warehouseId,
      referenceType: 'STOCK_REALLOCATION',
      referenceId: a.referenceId,
      referenceNumber: a.number,
      relatedPackageId: pkg.id,
      notes: `${fromName} → ${toName}: ${take} ${unit} of roll ${pkg.code}, same lot${pkg.lotNo ? ` ${pkg.lotNo}` : ''}`,
      userId: a.userId,
    })
    moved.push(part.code)
  }

  // ── Tags change share ──
  const tagCodes: string[] = []
  if (tagIds.length) {
    await tx.garment.updateMany({ where: { id: { in: tagIds } }, data: { brandId: a.to } })
    const named = await tx.garment.findMany({ where: { id: { in: tagIds } }, select: { id: true, code: true } })
    await tx.garmentEvent.createMany({
      data: named.map((g) => ({
        garmentId: g.id,
        type: 'EARMARKED' as const,
        referenceType: 'STOCK_REALLOCATION',
        referenceId: a.referenceId,
        referenceNumber: a.number,
        notes: `${fromName} → ${toName}`,
        createdById: a.userId,
      })),
    })
    tagCodes.push(...named.map((g) => g.code))
  }
  return { unitRate: out.unitRate, packageCodes: moved, garmentCodes: tagCodes }
}

/** The reallocation number series, made the first time one is raised in a year. */
async function nextNumber(tx: Tx, date: Date) {
  const company = await tx.company.findFirst({ select: { id: true, fyStartMonth: true } })
  if (company) {
    const financialYear = financialYearOf(date, company.fyStartMonth ?? 4)
    const have = await tx.numberSeries.findFirst({ where: { companyId: company.id, docType: 'SRA', financialYear }, select: { id: true } })
    if (!have) await tx.numberSeries.create({ data: { companyId: company.id, docType: 'SRA', prefix: 'SRA', separator: '-', financialYear, lastNumber: 0, padding: 4 } })
  }
  return nextDocumentNumber(tx, 'SRA', date)
}

const KIND_WORDS: Record<ReallocationKind, string> = {
  EARMARK: 'Earmark',
  MOVE: 'Move between brands',
  RELEASE: 'Release to central',
  AUTO: 'Automatic for an MO',
}

export interface RaiseInput {
  kind: 'EARMARK' | 'MOVE' | 'RELEASE'
  warehouseId: string
  fromBrandId: Share
  toBrandId: Share
  moId?: string | null
  reason: string
  lines: Array<{ itemId: string; sizeId?: string | null; grade?: string | null; qty: number; packageCodes?: string[]; garmentCodes?: string[] }>
}

/**
 * Raises a reallocation, waiting for approval. Checked now against what is
 * free in the giving share, and again when it posts.
 */
export async function raiseReallocation(tx: Tx, input: RaiseInput, userId: string) {
  const from = input.fromBrandId ?? null
  const to = input.toBrandId ?? null
  if (input.kind === 'EARMARK' && (from !== null || to === null)) throw new AppError('An earmark takes central stock for a brand.', 400, 'BAD_SHARES')
  if (input.kind === 'MOVE' && (from === null || to === null || from === to)) throw new AppError('A move hands one brand’s stock to another brand.', 400, 'BAD_SHARES')
  if (input.kind === 'RELEASE' && (from === null || to !== null)) throw new AppError('A release gives a brand’s stock back to central.', 400, 'BAD_SHARES')
  if (from) await assertOwnBrand(tx, from)
  if (to) await assertOwnBrand(tx, to)
  const store = await tx.warehouse.findUnique({ where: { id: input.warehouseId }, select: { name: true, isActive: true, kind: true } })
  if (!store?.isActive) throw new AppError('That store is not in use.', 400, 'BAD_WAREHOUSE')
  if (store.kind === 'TRANSIT') throw new AppError(`${store.name} holds goods on the road: they keep their share until they arrive.`, 400, 'TRANSIT_STORE')
  if (!input.lines.length) throw new AppError('Name at least one item.', 400, 'NO_LINES')
  if (input.moId) {
    const mo = await tx.manufacturingOrder.findUnique({ where: { id: input.moId }, select: { brandId: true, moNumber: true } })
    if (!mo) throw new AppError('That MO does not exist', 404, 'NOT_FOUND')
    if (to && mo.brandId !== to) throw new AppError(`${mo.moNumber} is another brand’s order.`, 400, 'MO_BRAND')
  }
  await assertQtyFitsUnits(tx, input.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, what: 'Reallocation' })))
  // What is free in the giving share now: refused early, checked again when it posts.
  const byKey = new Map<string, { line: RaiseInput['lines'][number]; qty: number }>()
  for (const l of input.lines) {
    if (!(l.qty > 0)) throw new AppError('Each line moves more than nothing.', 400, 'INVALID_QTY')
    const k = `${l.itemId}|${l.sizeId ?? ''}|${l.grade ?? 'A'}`
    const e = byKey.get(k) ?? { line: l, qty: 0 }
    e.qty = round3(e.qty + l.qty)
    byKey.set(k, e)
  }
  const fromName = await shareName(tx, from)
  for (const { line, qty } of byKey.values()) {
    const s = await shareFree(tx, { itemId: line.itemId, warehouseId: input.warehouseId, ownership: 'OWNED', sizeId: line.sizeId ?? null, grade: line.grade ?? 'A', brandId: from })
    if (qty > s.free + 0.0005) {
      const it = await tx.item.findUnique({ where: { id: line.itemId }, select: { name: true, uom: { select: { symbol: true } } } })
      const unit = it?.uom?.symbol ?? ''
      throw new AppError(
        `${it?.name ?? 'That item'}: ${fromName} in ${store.name} has ${s.qty} ${unit}${s.held > 0 ? `, ${s.held} ${unit} of it held for requisitions` : ''}, so ${s.free} ${unit} is free, not ${qty}.`,
        400,
        'NOT_ENOUGH_IN_SHARE',
      )
    }
  }
  const now = new Date()
  const number = await nextNumber(tx, now)
  return tx.stockReallocation.create({
    data: {
      number,
      kind: input.kind,
      warehouseId: input.warehouseId,
      fromBrandId: from,
      toBrandId: to,
      moId: input.moId ?? null,
      reason: input.reason.trim(),
      requestedById: userId,
      lines: {
        create: input.lines.map((l) => ({
          itemId: l.itemId,
          sizeId: l.sizeId ?? null,
          grade: l.grade ?? 'A',
          qty: round3(l.qty),
          packageCodes: l.packageCodes ?? [],
          garmentCodes: l.garmentCodes ?? [],
        })),
      },
    },
    include: { lines: true },
  })
}

async function lockReallocation(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.stock_reallocations WHERE id = ${id} FOR UPDATE`
  const doc = await tx.stockReallocation.findUnique({ where: { id }, include: { lines: true } })
  if (!doc) throw new AppError('That reallocation does not exist', 404, 'NOT_FOUND')
  return doc
}

/**
 * Approves and posts a reallocation (decision 8): by someone other than its
 * maker. An Admin may approve their own only as an override, with a reason
 * of at least ten characters, kept on the document and in the audit trail.
 */
export async function approveReallocation(tx: Tx, id: string, user: { id: string; admin: boolean }, overrideReason?: string | null) {
  const doc = await lockReallocation(tx, id)
  if (doc.status !== 'PENDING') throw new AppError(`${doc.number} is ${doc.status.toLowerCase()}, not waiting for approval.`, 409, 'NOT_PENDING')
  const own = doc.requestedById === user.id
  const said = (overrideReason ?? '').trim()
  if (own && !user.admin) {
    throw new AppError(`You raised ${doc.number}, so someone else approves it.`, 403, 'SELF_APPROVAL')
  }
  if (own && said.length < 10) {
    throw new AppError(`You raised ${doc.number}. An Admin may approve their own only as an override: say why, in a sentence.`, 400, 'OVERRIDE_REASON_REQUIRED')
  }
  const toName = await shareName(tx, doc.toBrandId)
  for (const l of doc.lines) {
    const r = await moveShare(tx, {
      itemId: l.itemId,
      warehouseId: doc.warehouseId,
      sizeId: l.sizeId,
      grade: l.grade,
      qty: Number(l.qty),
      from: doc.fromBrandId,
      to: doc.toBrandId,
      referenceId: doc.id,
      number: doc.number,
      notes: doc.reason,
      userId: user.id,
      stickers: 'move',
      packageCodes: l.packageCodes,
      garmentCodes: l.garmentCodes,
    })
    // The stickers and tags that now carry the earmark, parts included: what a reversal names.
    await tx.stockReallocationLine.update({ where: { id: l.id }, data: { unitRate: r.unitRate, packageCodes: r.packageCodes, garmentCodes: r.garmentCodes } })
  }
  const now = new Date()
  await tx.stockReallocation.update({
    where: { id },
    data: { status: 'POSTED', approvedById: user.id, approvedAt: now, postedAt: now, selfApproved: own, overrideReason: own ? said : null },
  })
  return { ...doc, toName, selfApproved: own }
}

export async function rejectReallocation(tx: Tx, id: string, userId: string, reason: string) {
  const doc = await lockReallocation(tx, id)
  if (doc.status !== 'PENDING') throw new AppError(`${doc.number} is ${doc.status.toLowerCase()}, not waiting for approval.`, 409, 'NOT_PENDING')
  if (doc.requestedById === userId) throw new AppError(`You raised ${doc.number}: withdraw it instead.`, 400, 'OWN_REJECT')
  await tx.stockReallocation.update({ where: { id }, data: { status: 'REJECTED', rejectedById: userId, rejectedAt: new Date(), rejectReason: reason.trim() } })
  return doc
}

export async function cancelReallocation(tx: Tx, id: string, user: { id: string; admin: boolean }) {
  const doc = await lockReallocation(tx, id)
  if (doc.status !== 'PENDING') throw new AppError(`${doc.number} is ${doc.status.toLowerCase()}: only one waiting for approval is withdrawn.`, 409, 'NOT_PENDING')
  if (doc.requestedById !== user.id && !user.admin) throw new AppError(`Only whoever raised ${doc.number} withdraws it.`, 403, 'NOT_YOURS')
  await tx.stockReallocation.update({ where: { id }, data: { status: 'CANCELLED' } })
  return doc
}

/**
 * Puts a posted earmark, move or release back: the same stock out of the
 * share it went to and into the one it came from, at the receiving share's
 * average, with the stickers and tags it moved. Refused when some of it has
 * gone since. An automatic move goes back only with its issue.
 */
export async function reverseReallocation(tx: Tx, id: string, userId: string, reason: string) {
  const doc = await lockReallocation(tx, id)
  if (doc.status !== 'POSTED') throw new AppError(`${doc.number} is ${doc.status.toLowerCase()}: only a posted one is reversed.`, 409, 'NOT_POSTED')
  if (doc.kind === 'AUTO') throw new AppError(`${doc.number} was made by a material issue: it goes back when that issue's stock returns from the floor.`, 409, 'AUTO_REVERSE')
  for (const l of doc.lines) {
    // Only the stickers and tags of this one still on the rack in that share.
    const live = await tx.stockPackage.findMany({ where: { code: { in: l.packageCodes }, status: 'IN_STOCK', brandId: doc.toBrandId }, select: { code: true, qty: true } })
    await moveShare(tx, {
      itemId: l.itemId,
      warehouseId: doc.warehouseId,
      sizeId: l.sizeId,
      grade: l.grade,
      qty: Number(l.qty),
      from: doc.toBrandId,
      to: doc.fromBrandId,
      referenceId: doc.id,
      number: `${doc.number}-R`,
      notes: reason.trim(),
      userId,
      stickers: 'move',
      packageCodes: live.map((p) => p.code),
      garmentCodes: l.garmentCodes,
    })
  }
  await tx.stockReallocation.update({ where: { id }, data: { status: 'REVERSED', reversedById: userId, reversedAt: new Date(), reverseReason: reason.trim() } })
  return doc
}

/**
 * Decision 7: central stock moves to an MO's brand by itself only for an
 * authorised MO — Released through Packing, not on hold (cancellations and
 * completed or closed orders are out by their status) — on an approved
 * requisition, and within what the MO still needs of the item. Refused with
 * what to do instead: an approved earmark for anything else.
 */
export async function assertAutoAllowed(
  tx: Tx,
  a: {
    mo: { id: string; moNumber: string; status: string; heldAt: Date | null; holdReason: string | null; brandId: string }
    mrStatus: string
    itemId: string
    itemName: string
    unit: string
    /** Coming from central now. */
    autoQty: number
    /** Of this issue, from the brand's own share and from earlier parts of the same issue. */
    alreadyThisIssue: number
  },
) {
  const brand = await shareName(tx, a.mo.brandId)
  const instead = `Earmark it for ${brand} first (Inventory → Brand Stock, approved by someone else), then issue.`
  if (!(AUTHORISED_MO_STATUSES as readonly string[]).includes(a.mo.status)) {
    throw new AppError(
      `${a.mo.moNumber} is ${STATUS_WORDS[a.mo.status] ?? a.mo.status.toLowerCase()}: central stock moves to ${brand} by itself only for an MO from Released to Packing. ${instead}`,
      409,
      'MO_NOT_AUTHORISED',
    )
  }
  if (a.mo.heldAt) {
    throw new AppError(`${a.mo.moNumber} is on hold${a.mo.holdReason ? ` (${a.mo.holdReason})` : ''}: nothing moves to it from central stock until it is resumed.`, 409, 'MO_ON_HOLD')
  }
  if (a.mrStatus !== 'APPROVED') throw new AppError('The requisition is not approved: central stock does not move for it.', 409, 'NOT_APPROVED')
  const plan = await materialPlan(tx, a.mo.id)
  const rows = plan.rows.filter((r) => r.item.id === a.itemId && r.ownership === 'OWNED')
  const required = round3(rows.reduce((t, r) => t + r.required, 0))
  const issued = round3(rows.reduce((t, r) => t + r.issued, 0))
  const room = round3(Math.max(0, required - issued - a.alreadyThisIssue))
  if (a.autoQty > room + 0.0005) {
    throw new AppError(
      required > 0
        ? `${a.mo.moNumber} needs ${required} ${a.unit} of ${a.itemName}; ${issued} ${a.unit} is issued already${a.alreadyThisIssue > 0 ? ` and ${round3(a.alreadyThisIssue)} ${a.unit} goes now from ${brand}’s own stock` : ''}. Another ${round3(a.autoQty)} ${a.unit} from central stock would go past what it needs by ${round3(a.autoQty - room)} ${a.unit}. ${instead}`
        : `${a.mo.moNumber}'s plan does not call for ${a.itemName}, so central stock does not move to ${brand} for it by itself. ${instead}`,
      409,
      'OVER_REQUIREMENT',
    )
  }
}

/** The automatic reallocation an MO's issue makes, posted at once, and the move itself. */
export async function autoForIssue(
  tx: Tx,
  a: {
    mo: { id: string; moNumber: string; brandId: string }
    mr: { id: string; mrNumber: string }
    itemId: string
    warehouseId: string
    qty: number
    reservedFor: string[]
    userId: string
    transactionDate?: Date
    /** 'oldest' for a typed issue (its rolls move with it), 'leave' for a scanned roll that comes down with the issue. */
    stickers: 'oldest' | 'leave'
  },
) {
  const now = new Date()
  const number = await nextNumber(tx, now)
  const doc = await tx.stockReallocation.create({
    data: {
      number,
      kind: 'AUTO',
      status: 'POSTED',
      warehouseId: a.warehouseId,
      fromBrandId: null,
      toBrandId: a.mo.brandId,
      moId: a.mo.id,
      mrId: a.mr.id,
      reason: `Automatic: ${a.mr.mrNumber} issued for ${a.mo.moNumber}`,
      requestedById: a.userId,
      postedAt: now,
      lines: { create: [{ itemId: a.itemId, qty: round3(a.qty) }] },
    },
    include: { lines: true },
  })
  const r = await moveShare(tx, {
    itemId: a.itemId,
    warehouseId: a.warehouseId,
    qty: a.qty,
    from: null,
    to: a.mo.brandId,
    referenceId: doc.id,
    number,
    notes: `${a.mr.mrNumber} for ${a.mo.moNumber}`,
    userId: a.userId,
    stickers: a.stickers,
    reservedFor: a.reservedFor,
    transactionDate: a.transactionDate,
  })
  await tx.stockReallocationLine.update({ where: { id: doc.lines[0].id }, data: { unitRate: r.unitRate, packageCodes: r.packageCodes } })
  return { number, unitRate: r.unitRate }
}

/**
 * Where material coming back from the floor goes: to the shares it was
 * issued from, what each still has out, the MO's brand first. Each part
 * comes back at that share's issue rate.
 */
export async function returnShares(
  tx: Tx,
  a: { mrId: string; itemId: string; ownership: string; ownerCustomerId: string | null; qty: number; brandFirst: Share },
): Promise<Array<{ brandId: Share; qty: number; rate: number }>> {
  const rows = await tx.$queryRaw<Array<{ brandId: string | null; issued: number; issuedValue: number; returned: number }>>`
    SELECT "brandId",
           COALESCE(SUM("outQty") FILTER (WHERE "referenceType" = 'MATERIAL_REQUISITION'), 0)::float8 AS issued,
           COALESCE(SUM("outQty" * COALESCE("unitRate", 0)) FILTER (WHERE "referenceType" = 'MATERIAL_REQUISITION'), 0)::float8 AS "issuedValue",
           COALESCE(SUM("inQty") FILTER (WHERE "referenceType" = 'MR_RETURN'), 0)::float8
             - COALESCE(SUM("outQty") FILTER (WHERE "referenceType" = 'MR_RETURN_CANCELLED'), 0)::float8 AS returned
    FROM ld_erp.stock_ledger
    WHERE "referenceId" = ${a.mrId} AND "itemId" = ${a.itemId}
      AND ownership = ${a.ownership}::ld_erp."StockOwnership" AND "ownerCustomerId" IS NOT DISTINCT FROM ${a.ownerCustomerId}::text
      AND "referenceType" IN ('MATERIAL_REQUISITION', 'MR_RETURN', 'MR_RETURN_CANCELLED')
    GROUP BY "brandId"`
  const open = rows
    .map((r) => ({ brandId: r.brandId, out: round3(r.issued - r.returned), rate: r.issued > 0 ? round2(r.issuedValue / r.issued) : 0 }))
    .filter((r) => r.out > 0.0005)
    .sort((x, y) => Number(y.brandId === a.brandFirst) - Number(x.brandId === a.brandFirst))
  const parts: Array<{ brandId: Share; qty: number; rate: number }> = []
  let left = round3(a.qty)
  for (const o of open) {
    if (left <= 0.0005) break
    const q = round3(Math.min(o.out, left))
    parts.push({ brandId: o.brandId, qty: q, rate: o.rate })
    left = round3(left - q)
  }
  // Issued before shares existed, or more than the rows show: central, at the issues' rate overall.
  if (left > 0.0005) {
    const all = rows.reduce((t, r) => t + r.issued, 0)
    const value = rows.reduce((t, r) => t + r.issuedValue, 0)
    parts.push({ brandId: null, qty: left, rate: all > 0 ? round2(value / all) : 0 })
  }
  return parts
}

export { KIND_WORDS }
