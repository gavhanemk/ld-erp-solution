import type { Prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { recordMovement, lockedBalanceOf } from './stock.service'
import { recordPackageMove, round3, splitOff, takeFromPackage, type StockSpot } from './package.service'

/*
 * A customer's receipt, from the count at the gate to the books.
 *
 *   DRAFT      the storekeeper is still entering it — nothing on the books
 *   SUBMITTED  received and counted, handed to QC — still nothing on the books
 *   INSPECTED  QC has said, line by line, what passed and what is rejected and
 *              why — waiting for stock approval, still nothing on the books
 *   POSTED     an approver approved it into stock: the stock and its stickers
 *              are made, once
 *   CANCELLED  taken back out; the number and the document stay
 *
 * Until it is approved the material is on our floor but not in stock, so no
 * requisition can draw on it: held in the way an ERP's "goods received,
 * blocked" stock is. Only what QC accepted becomes usable.
 *
 * What was rejected at the gate is booked in as well, because it is on our
 * floor and still the customer's, but held: grade R in the same store, which
 * no requisition, reservation, transfer or job-work challan takes (they all
 * take grade A). It leaves either released for use by an approver, with a
 * reason, or back to the customer on a return with the reason "Rejected".
 */

export const CGRN_STATUS = ['DRAFT', 'SUBMITTED', 'INSPECTED', 'POSTED', 'CANCELLED'] as const
export type CgrnStatus = (typeof CGRN_STATUS)[number]

/** The grade held stock carries on the ledger, as the purchase quality check holds its rejects. */
export const HELD = 'R'

export const CGRN_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Waiting for QC',
  INSPECTED: 'Waiting for stock approval',
  POSTED: 'Approved',
  CANCELLED: 'Cancelled',
}

/** The parts of a receipt the books need. */
interface GrnForStock {
  id: string
  grnNumber: string
  customerId: string
  warehouseId: string
  receiptDate: Date
  lines: Array<{ id: string; itemId: string; receivedQty: Prisma.Decimal | number; rejectedQty: Prisma.Decimal | number; batchNumber: string | null }>
}

/**
 * Puts a receipt on the books: what was accepted as usable grade A, what was
 * rejected as held grade R, both the customer's at no value. Called once, by
 * whatever posts the receipt, inside its transaction.
 *
 * `later`: posted after the day it came in (an approval), so a date earlier
 * than the item's last movement is written just after it instead of refused.
 */
export async function postGrnStock(tx: Prisma.TransactionClient, grn: GrnForStock, customerName: string, later: boolean) {
  for (const line of grn.lines) {
    const received = Number(line.receivedQty)
    const rejected = Math.min(received, Number(line.rejectedQty))
    const accepted = round3(received - rejected)
    const parts: Array<{ qty: number; grade: string; note: string }> = [
      { qty: accepted, grade: 'A', note: `${grn.grnNumber}: ${customerName}` },
      { qty: round3(rejected), grade: HELD, note: `${grn.grnNumber}: ${customerName} — rejected at receipt, held` },
    ]
    for (const p of parts) {
      if (p.qty <= 0.0005) continue
      await recordMovement(tx, {
        itemId: line.itemId,
        warehouseId: grn.warehouseId,
        transactionType: 'CUSTOMER_MATERIAL',
        direction: 'IN',
        qty: p.qty,
        // Not ours, so it carries no value to us and never reaches the stock
        // figure or the balance sheet.
        unitRate: 0,
        ownership: 'CUSTOMER_OWNED',
        ownerCustomerId: grn.customerId,
        grade: p.grade,
        batchNumber: line.batchNumber,
        referenceType: 'CUSTOMER_GRN',
        referenceId: grn.id,
        transactionDate: grn.receiptDate,
        notes: p.note,
        ...(later ? { earlierDate: 'move-up' as const } : {}),
      })
    }
  }
}

/**
 * Takes a posted receipt back off the books: whatever is still standing from
 * it, grade by grade — usable and held, after any releases — as it stands on
 * the ledger, so nothing it did not bring in is taken out.
 */
export async function reverseGrnStock(tx: Prisma.TransactionClient, grn: { id: string; grnNumber: string; customerId: string }, reason: string) {
  const left = await tx.stockLedger.groupBy({
    by: ['itemId', 'warehouseId', 'grade'],
    where: { referenceId: grn.id, referenceType: { in: ['CUSTOMER_GRN', 'CUSTOMER_GRN_RELEASE'] } },
    _sum: { inQty: true, outQty: true },
  })
  for (const r of left) {
    const qty = round3(Number(r._sum.inQty ?? 0) - Number(r._sum.outQty ?? 0))
    if (qty <= 0.0005) continue
    await recordMovement(tx, {
      itemId: r.itemId,
      warehouseId: r.warehouseId,
      transactionType: 'RETURN',
      direction: 'OUT',
      qty,
      ownership: 'CUSTOMER_OWNED',
      ownerCustomerId: grn.customerId,
      grade: r.grade,
      referenceType: 'CUSTOMER_GRN_CANCELLED',
      referenceId: grn.id,
      transactionDate: new Date(),
      notes: `${grn.grnNumber} cancelled: ${reason}`,
      earlierDate: 'move-up',
      // Its stickers were withdrawn just before, by the caller.
      stickers: 'caller',
      ignoreReservations: true,
    })
  }
}

/**
 * Moves stock from one grade to the other in the same store: out of one, in
 * to the other at what it went out at. The rolls do not move — they stay on
 * the rack with their stickers, held or passed — so their stickers are the
 * caller's to change.
 */
export async function regradeStock(
  tx: Prisma.TransactionClient,
  a: StockSpot & { qty: number; from: string; to: string; referenceType: string; referenceId: string; notes: string },
) {
  const out = await recordMovement(tx, {
    itemId: a.itemId,
    warehouseId: a.warehouseId,
    ownership: a.ownership,
    ownerCustomerId: a.ownerCustomerId,
    transactionType: 'TRANSFER',
    direction: 'OUT',
    qty: a.qty,
    grade: a.from,
    referenceType: a.referenceType,
    referenceId: a.referenceId,
    transactionDate: new Date(),
    notes: a.notes,
    stickers: 'caller',
    ignoreReservations: true,
    earlierDate: 'move-up',
  })
  await recordMovement(tx, {
    itemId: a.itemId,
    warehouseId: a.warehouseId,
    ownership: a.ownership,
    ownerCustomerId: a.ownerCustomerId,
    transactionType: 'TRANSFER',
    direction: 'IN',
    qty: a.qty,
    unitRate: out.unitRate,
    grade: a.to,
    referenceType: a.referenceType,
    referenceId: a.referenceId,
    transactionDate: new Date(),
    notes: a.notes,
    earlierDate: 'move-up',
  })
}

/**
 * Held stickers of one spot, this receipt's own first and oldest first, for
 * `qty`: whole ones while they fit, and the last one split so exactly `qty`
 * is taken. Locked, so two people releasing or returning at once cannot take
 * the same roll. Returns the packages taken (whole, or the split-off part;
 * the rest of a split roll goes on a new held sticker, to print).
 */
async function heldPackagesFor(
  tx: Prisma.TransactionClient,
  spot: StockSpot,
  qty: number,
  preferSourceId: string | null,
  userId: string | null,
  why: string,
  /**
   * Going back to the customer: part of a roll comes off its own sticker,
   * which stays on the held rest, and is not returned here. Left out, part
   * of a roll is cut off with a sticker of its own, as a release needs: the
   * released part is usable and the rest is still held.
   */
  leaving?: { move: Parameters<typeof takeFromPackage>[3] },
) {
  await lockedBalanceOf(tx, { ...spot, grade: HELD })
  const held = await tx.stockPackage.findMany({
    where: { itemId: spot.itemId, warehouseId: spot.warehouseId, ownership: spot.ownership, ownerCustomerId: spot.ownerCustomerId, status: 'IN_STOCK', grade: HELD },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!held.length) return []
  await tx.$queryRaw`SELECT id FROM ld_erp.stock_packages WHERE id = ANY(${held.map((h) => h.id)}::text[]) FOR UPDATE`
  const rows = await tx.stockPackage.findMany({
    where: { id: { in: held.map((h) => h.id) }, status: 'IN_STOCK', grade: HELD },
    include: { item: { select: { name: true, uom: { select: { symbol: true } } } } },
    orderBy: { createdAt: 'asc' },
  })
  rows.sort((a, b) => Number(b.sourceId === preferSourceId) - Number(a.sourceId === preferSourceId))

  const taken: Array<{ id: string; code: string; qty: number }> = []
  let left = round3(qty)
  for (const p of rows) {
    if (left <= 0.0005) break
    const has = Number(p.qty)
    if (has <= left + 0.0005) {
      taken.push({ id: p.id, code: p.code, qty: has })
      left = round3(left - has)
      continue
    }
    if (leaving) {
      // Part of a roll going back: the rest stays held on the same sticker.
      await takeFromPackage(tx, p, left, leaving.move)
      left = 0
      continue
    }
    // Part of a roll released: the part taken and the rest, still held, each
    // get a sticker of their own, and the old one is retired.
    const { part } = await splitOff(tx, p, left, { notes: why, userId, unit: p.item.uom?.symbol ?? '' })
    taken.push(part)
    left = 0
  }
  return taken
}

/** What is still held on each line of a posted receipt: rejected, less released, less sent back as rejected against it. */
export async function heldByLine(tx: Prisma.TransactionClient, grnId: string) {
  const [lines, back] = await Promise.all([
    tx.customerGRNLine.findMany({ where: { grnId }, select: { id: true, itemId: true, rejectedQty: true, releasedQty: true } }),
    tx.customerMaterialReturnLine.findMany({
      where: { return: { grnId, reason: 'REJECTED', cancelledAt: null } },
      select: { itemId: true, qty: true },
    }),
  ])
  return new Map(
    lines.map((l) => {
      const rejected = Number(l.rejectedQty)
      const released = Number(l.releasedQty)
      const returned = round3(back.filter((b) => b.itemId === l.itemId).reduce((s, b) => s + Number(b.qty), 0))
      return [l.id, { rejected, released, returned, held: round3(Math.max(0, rejected - released - returned)) }]
    }),
  )
}

/**
 * Releasing held material for use after a second look: the ledger moves it
 * from held to usable, the line records how much, and its stickers stop being
 * held — split where only part of a roll is released.
 */
export async function releaseHeld(
  tx: Prisma.TransactionClient,
  grn: { id: string; grnNumber: string; customerId: string; warehouseId: string },
  line: { id: string; itemId: string; itemName: string; unit: string },
  qty: number,
  reason: string,
  userId: string | null,
) {
  const held = (await heldByLine(tx, grn.id)).get(line.id)
  if (!held || held.held <= 0.0005) throw new AppError(`Nothing of ${line.itemName} on ${grn.grnNumber} is on hold.`, 400, 'NOTHING_HELD')
  if (qty > held.held + 0.0005) {
    throw new AppError(`Only ${held.held} ${line.unit} of ${line.itemName} on ${grn.grnNumber} is still on hold, so ${qty} cannot be released.`, 400, 'OVER_HELD')
  }
  const spot: StockSpot = { itemId: line.itemId, warehouseId: grn.warehouseId, ownership: 'CUSTOMER_OWNED', ownerCustomerId: grn.customerId }
  const notes = `${grn.grnNumber}: ${qty} ${line.unit} released from hold — ${reason}`
  const taken = await heldPackagesFor(tx, spot, qty, grn.id, userId, `released from hold on ${grn.grnNumber}`)
  for (const p of taken) {
    await tx.stockPackage.update({ where: { id: p.id }, data: { grade: 'A' } })
    await recordPackageMove(tx, { packageId: p.id, type: 'RELEASED', qty: 0, balanceAfter: p.qty, warehouseId: grn.warehouseId, referenceType: 'CUSTOMER_GRN', referenceId: grn.id, referenceNumber: grn.grnNumber, notes: reason, userId })
  }
  await regradeStock(tx, { ...spot, qty, from: HELD, to: 'A', referenceType: 'CUSTOMER_GRN_RELEASE', referenceId: grn.id, notes })
  await tx.customerGRNLine.update({ where: { id: line.id }, data: { releasedQty: { increment: qty } } })
  return { released: qty, packages: taken.map((p) => p.code) }
}

/**
 * The held stickers that go back to the customer on a "Rejected" return,
 * emptied here, so the labels match the held stock left behind.
 */
export async function takeHeldPackages(
  tx: Prisma.TransactionClient,
  spot: StockSpot,
  qty: number,
  doc: { type: string; id: string; number: string; grnId: string | null },
  userId: string | null,
) {
  const move = { referenceType: doc.type, referenceId: doc.id, referenceNumber: doc.number, notes: 'Back to the customer as rejected', userId }
  const taken = await heldPackagesFor(tx, spot, qty, doc.grnId, userId, `going back on ${doc.number}`, { move })
  for (const p of taken) {
    await tx.stockPackage.update({ where: { id: p.id }, data: { qty: 0, status: 'EMPTY' } })
    await recordPackageMove(tx, { packageId: p.id, type: 'ISSUED', qty: -p.qty, balanceAfter: 0, warehouseId: spot.warehouseId, ...move })
  }
  return taken
}
