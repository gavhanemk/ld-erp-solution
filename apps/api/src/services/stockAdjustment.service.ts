import { prisma } from '@ld-erp/database'
import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { recordMovement, sharesOf } from './stock.service'
import { afterAdjustmentDecided } from './garmentHooks.service'
import { afterCountDecided } from './stockCountHooks.service'
import { autoStickers } from './stickers.service'

/**
 * A stock adjustment is a count the store keeper made; it changes stock only
 * once a store manager approves it. Approving and refusing live here so the
 * inventory screen and the approvals inbox, two doors into the same decision,
 * apply the same rules.
 *
 * The difference posted is the one worked out when the count was made —
 * "the book said 35, we counted 33" — not one recomputed at approval, because
 * the count is a fact about that moment. If stock has since moved so far that
 * a shortfall can no longer be taken out, the stock service refuses and says
 * what is there, and the manager can refuse the count and have it redone.
 */

const include = {
  warehouse: { select: { id: true, name: true } },
  lines: {
    include: {
      item: { select: { name: true } },
      ownerCustomer: { select: { name: true } },
    },
  },
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

type AdjLine = { itemId: string; ownership: 'OWNED' | 'CUSTOMER_OWNED'; ownerCustomerId: string | null; sizeId: string | null; grade: string; difference: Prisma.Decimal | number }

/**
 * Which shares a count's shortage comes out of (multi-brand phase 5): what
 * the count named as missing first — rolls it did not scan, tagged pieces
 * written off — from the share each is on; the rest from central stock
 * first, then from the brands' earmarks, largest first. A gain always goes
 * to central. A customer's goods are never a brand's.
 */
export async function shortageShares(
  tx: Prisma.TransactionClient,
  adjustmentId: string,
  warehouseId: string,
  line: AdjLine,
): Promise<Array<{ brandId: string | null; qty: number; named: boolean }>> {
  const need = round3(Math.abs(Number(line.difference)))
  if (line.ownership !== 'OWNED') return [{ brandId: null, qty: need, named: false }]
  const named = new Map<string | null, number>()
  if (!line.sizeId) {
    const count = await tx.stockCount.findFirst({ where: { adjustmentId }, select: { missing: true } })
    const ids = Array.isArray(count?.missing) ? (count!.missing as string[]) : []
    if (ids.length) {
      const pkgs = await tx.stockPackage.findMany({ where: { id: { in: ids }, itemId: line.itemId, warehouseId, status: 'IN_STOCK', grade: line.grade }, select: { brandId: true, qty: true } })
      for (const p of pkgs) named.set(p.brandId, round3((named.get(p.brandId) ?? 0) + Number(p.qty)))
    }
  } else {
    const tags = await tx.garment.groupBy({
      by: ['brandId'],
      where: { adjustmentId, itemId: line.itemId, sizeId: line.sizeId, grade: line.grade, warehouseId, status: 'IN_STOCK' },
      _count: true,
    })
    for (const t of tags) named.set(t.brandId, t._count)
  }
  const parts: Array<{ brandId: string | null; qty: number; named: boolean }> = []
  const taken = new Map<string | null, number>()
  let left = need
  for (const [brandId, q] of named) {
    if (left <= 0.0005) break
    const take = round3(Math.min(q, left))
    parts.push({ brandId, qty: take, named: true })
    taken.set(brandId, round3((taken.get(brandId) ?? 0) + take))
    left = round3(left - take)
  }
  if (left > 0.0005) {
    const shares = (await sharesOf(tx, { itemId: line.itemId, warehouseId, ownership: 'OWNED', ownerCustomerId: null, sizeId: line.sizeId, grade: line.grade }))
      .map((x) => ({ ...x, qty: round3(x.qty - (taken.get(x.brandId) ?? 0)) }))
      .filter((x) => x.qty > 0.0005)
      .sort((a, b) => Number(b.brandId === null) - Number(a.brandId === null) || b.qty - a.qty)
    for (const sh of shares) {
      if (left <= 0.0005) break
      const take = round3(Math.min(sh.qty, left))
      const same = parts.find((p) => p.brandId === sh.brandId && !p.named)
      if (same) same.qty = round3(same.qty + take)
      else parts.push({ brandId: sh.brandId, qty: take, named: false })
      left = round3(left - take)
    }
  }
  // More than the book holds: central, and the stock writer says what is there.
  if (left > 0.0005) parts.push({ brandId: null, qty: left, named: false })
  return parts
}

/**
 * What approving a count would take from each brand's earmark, for the
 * approver to see before deciding: only lines where a brand loses stock.
 */
export async function brandLosses(tx: Prisma.TransactionClient, adjustmentId: string) {
  const adj = await tx.stockAdjustment.findUnique({ where: { id: adjustmentId }, select: { warehouseId: true, status: true, lines: true } })
  if (!adj || adj.status !== 'PENDING') return []
  const brands = new Map((await tx.brand.findMany({ select: { id: true, name: true } })).map((b) => [b.id, b.name]))
  const out: Array<{ lineId: string; itemId: string; sizeId: string | null; brandId: string; brand: string; qty: number; named: boolean }> = []
  for (const l of adj.lines) {
    if (!(Number(l.difference) < 0)) continue
    for (const p of await shortageShares(tx, adjustmentId, adj.warehouseId, l)) {
      if (p.brandId) out.push({ lineId: l.id, itemId: l.itemId, sizeId: l.sizeId, brandId: p.brandId, brand: brands.get(p.brandId) ?? 'a brand', qty: p.qty, named: p.named })
    }
  }
  return out
}

export async function approveAdjustment(id: string, userId: string, admin = false) {
  const result = await prisma.$transaction((tx) => approveAdjustmentIn(tx, id, userId, admin), { timeout: 60_000, maxWait: 20_000 })
  // A stock-in brings stock in: its stickers are made now, ready to print,
  // whichever screen it was approved from.
  const stickers = result.after.kind === 'STOCK_IN' ? await autoStickers({ sourceType: 'STOCK_IN', sourceId: result.after.id }, userId) : null
  return { ...result, stickers }
}

/** The approval inside the caller's transaction. */
export async function approveAdjustmentIn(tx: Prisma.TransactionClient, id: string, userId: string, admin = false) {
  await tx.$queryRaw`SELECT id FROM ld_erp.stock_adjustments WHERE id = ${id} FOR UPDATE`
  const before = await tx.stockAdjustment.findUnique({ where: { id }, include })
  if (!before) throw new AppError('That stock adjustment does not exist', 404, 'NOT_FOUND')
  if (before.status !== 'PENDING') {
    throw new AppError(
      `${before.adjustmentNumber} is already ${before.status === 'APPROVED' ? 'approved' : 'refused'}.`,
      409,
      'ALREADY_DECIDED',
    )
  }
  if (!admin && before.madeById === userId) {
    throw new AppError(
      'You counted this, so somebody else has to approve it.',
      403,
      'OWN_ADJUSTMENT',
    )
  }

  for (const line of before.lines) {
    const difference = Number(line.difference)
    if (difference === 0) continue
    const owner = line.ownership === 'CUSTOMER_OWNED' ? ` (${line.ownerCustomer?.name ?? 'customer'}'s)` : ''
    // A gain is central stock; a shortage comes off the shares as `shortageShares` sets out.
    const parts = difference > 0 ? [{ brandId: null as string | null, qty: Math.abs(difference) }] : await shortageShares(tx, before.id, before.warehouseId, line)
    for (const part of parts) {
    const brandWord = part.brandId ? ` — ${(await tx.brand.findUnique({ where: { id: part.brandId }, select: { name: true } }))?.name ?? 'a brand'}’s earmark` : ''
    await recordMovement(tx, {
      brandId: part.brandId,
      itemId: line.itemId,
      warehouseId: before.warehouseId,
      ownership: line.ownership,
      ownerCustomerId: line.ownerCustomerId,
      sizeId: line.sizeId,
      grade: line.grade,
      transactionType: 'ADJUSTMENT',
      direction: difference > 0 ? 'IN' : 'OUT',
      qty: part.qty,
      // A customer's cloth carries no value of ours, found or lost.
      unitRate: difference > 0 ? (line.ownership === 'CUSTOMER_OWNED' ? 0 : Number(line.unitRate ?? 0)) : undefined,
      // A stock-in reads as one in the ledger and the reports, not as a count.
      referenceType: before.kind === 'STOCK_IN' ? 'STOCK_IN' : 'STOCK_ADJUSTMENT',
      referenceId: before.id,
      transactionDate: before.adjustmentDate,
      notes: `${before.adjustmentNumber}${owner}${brandWord}: ${before.reason}`,
      // Approved now: entered just after the last movement if its count date is earlier.
      earlierDate: 'move-up',
      // What was counted is a fact; holds on the stock do not change it.
      ignoreReservations: true,
      // A scanned count withdraws the stickers it did not find, just below;
      // a typed one has its stickers taken down to what is left.
      stickers: before.source === 'SCAN_COUNT' ? 'caller' : 'auto',
    })
    }
  }

  const after = await tx.stockAdjustment.update({
    where: { id },
    data: { status: 'APPROVED', approvedById: userId, approvedAt: new Date() },
    include,
  })
  // Tagged garments waiting on this write-off are written off with it.
  await afterAdjustmentDecided(tx, id, true, userId)
  // A scanned count's stickers that were not found go with it.
  await afterCountDecided(tx, id, true, userId)
  return { before, after }
}

export async function rejectAdjustment(id: string, userId: string, reason: string) {
  // All in one: refused, its garments freed and its count closed together, or
  // none of it — a failure half-way used to leave it refused with its garments
  // still held.
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM ld_erp.stock_adjustments WHERE id = ${id} FOR UPDATE`
    const before = await tx.stockAdjustment.findUnique({ where: { id } })
    if (!before) throw new AppError('That stock adjustment does not exist', 404, 'NOT_FOUND')
    if (before.status !== 'PENDING') {
      throw new AppError(
        `${before.adjustmentNumber} is already ${before.status === 'APPROVED' ? 'approved' : 'refused'}.`,
        409,
        'ALREADY_DECIDED',
      )
    }
    await tx.stockAdjustment.update({
      where: { id },
      data: { status: 'REJECTED', approvedById: userId, approvedAt: new Date(), rejectReason: reason },
    })
    // Tagged garments it was writing off are free again; a scanned count it came from is closed.
    await afterAdjustmentDecided(tx, id, false, userId)
    await afterCountDecided(tx, id, false, userId)
    const after = await tx.stockAdjustment.findUniqueOrThrow({ where: { id }, include })
    return { before, after }
  })
}
