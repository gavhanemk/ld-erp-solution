import type { Prisma, StockOwnership } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { nextDocumentNumber } from '../lib/docNumber'
import { lockedBalanceOf, recordMovement, stockLockedUpTo } from './stock.service'
import { withdrawStickers } from './stickers.service'

/*
 * Opening stock put right after it is in, never by deleting it:
 *
 *  - A line that came in without a rate (valuation pending) has its rate set
 *    by someone with Inventory → approve. It is valued from the opening date:
 *    the opening movement takes the rate, and every issue from that stock
 *    since is priced again at the average it would have had.
 *  - Any other change — a line's quantity or rate — or taking a whole entry
 *    back is asked for with a reason, and posted only once someone with
 *    Inventory → approve, not the one who asked (unless an Admin), approves
 *    it. A correction posts the difference; a reversal posts the stock out
 *    again and voids its stickers. The entry and its lines stay, as history.
 */

const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000
const IMPORT_REF = 'OPENING_IMPORT'

type Key = { itemId: string; warehouseId: string; ownership: StockOwnership; ownerCustomerId: string | null; sizeId: string | null; grade: string }
const keyOf = (r: Key): Key => ({ itemId: r.itemId, warehouseId: r.warehouseId, ownership: r.ownership, ownerCustomerId: r.ownerCustomerId, sizeId: r.sizeId, grade: r.grade })
const keyText = (k: Key) => [k.itemId, k.warehouseId, k.ownership, k.ownerCustomerId ?? '', k.sizeId ?? '', k.grade].join('|')

/**
 * Every issue from this stock priced again, in the order the movements were
 * written: each at the average of what was there just before it, as it would
 * have been had the stock come in at its corrected rate. A transfer's other
 * half takes the new price in the store it went to, and that store is priced
 * again in turn. Returns how many movements changed.
 *
 * Costs worked out from an issue elsewhere (a cut panel, a job worker's
 * return) keep what they were given at the time.
 */
async function repriceFrom(tx: Prisma.TransactionClient, first: Key): Promise<number> {
  const queue = [first]
  const seen = new Set<string>()
  let changed = 0
  // A closed period's stock is what its books closed on: never priced again.
  const lock = await stockLockedUpTo(tx)
  const closed = (d: Date) => lock !== null && new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10) <= lock
  const refuseClosed = () => {
    throw new AppError(
      `Pricing this opening stock would change stock already moved in the closed period, up to ${lock}. Reopen the period in Accounts first.`,
      409,
      'PERIOD_LOCKED',
    )
  }
  while (queue.length && seen.size < 50) {
    const key = queue.shift()!
    if (seen.has(keyText(key))) continue
    seen.add(keyText(key))
    await lockedBalanceOf(tx, key)
    const rows = await tx.stockLedger.findMany({
      where: { itemId: key.itemId, warehouseId: key.warehouseId, ownership: key.ownership, ownerCustomerId: key.ownerCustomerId, sizeId: key.sizeId, grade: key.grade },
      orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, inQty: true, outQty: true, unitRate: true, transactionType: true, referenceType: true, referenceId: true, transactionDate: true },
    })
    let qty = 0
    let value = 0
    for (const r of rows) {
      const inQ = Number(r.inQty)
      const outQ = Number(r.outQty)
      if (inQ > 0) {
        qty = round3(qty + inQ)
        value += inQ * Number(r.unitRate ?? 0)
      }
      if (!(outQ > 0)) continue
      const rate = qty > 0.0005 ? round2(value / qty) : Number(r.unitRate ?? 0)
      if (Math.abs(rate - Number(r.unitRate ?? 0)) > 0.004) {
        if (closed(r.transactionDate)) refuseClosed()
        await tx.stockLedger.update({ where: { id: r.id }, data: { unitRate: rate } })
        changed++
        if (r.transactionType === 'TRANSFER') {
          // The same transfer's arrival in the other store: the same price, and that store priced again.
          const halves = await tx.stockLedger.findMany({
            where: { referenceType: r.referenceType, referenceId: r.referenceId, itemId: key.itemId, sizeId: key.sizeId, grade: key.grade, inQty: { gt: 0 }, NOT: { warehouseId: key.warehouseId } },
            select: { id: true, unitRate: true, itemId: true, warehouseId: true, ownership: true, ownerCustomerId: true, sizeId: true, grade: true, transactionDate: true },
          })
          for (const h of halves) {
            if (Math.abs(Number(h.unitRate ?? 0) - rate) <= 0.004) continue
            if (closed(h.transactionDate)) refuseClosed()
            await tx.stockLedger.update({ where: { id: h.id }, data: { unitRate: rate } })
            changed++
            queue.push(keyOf(h))
          }
        }
      }
      qty = round3(qty - outQ)
      value -= outQ * rate
    }
  }
  return changed
}

/** The movement an opening line posted: kept on the line, or found by the note it was written with. */
async function openingMovementOf(tx: Prisma.TransactionClient, line: { id: string; ledgerId: string | null; openingStockId: string; itemId: string; warehouseId: string; sizeId: string | null; grade: string; rowNo: number }, number: string) {
  const select = { id: true, itemId: true, warehouseId: true, ownership: true, ownerCustomerId: true, sizeId: true, grade: true, unitRate: true } as const
  if (line.ledgerId) {
    const row = await tx.stockLedger.findUnique({ where: { id: line.ledgerId }, select })
    if (row) return row
  }
  const said = [`${number} row ${line.rowNo}`, `${number} line ${line.rowNo}`]
  const row = await tx.stockLedger.findFirst({
    where: {
      referenceType: IMPORT_REF,
      referenceId: line.openingStockId,
      itemId: line.itemId,
      warehouseId: line.warehouseId,
      sizeId: line.sizeId,
      grade: line.grade,
      OR: said.flatMap((t) => [{ notes: t }, { notes: { startsWith: `${t} ·` } }]),
    },
    select,
  })
  if (!row) throw new AppError(`The stock movement of ${number} row ${line.rowNo} could not be found.`, 404, 'NO_MOVEMENT')
  return row
}

/** A line's own stickers that are still around (not voided): what stops its quantity being changed. */
async function stickersOf(tx: Prisma.TransactionClient, lineId: string) {
  return tx.stockPackage.findMany({
    where: { sourceLineId: lineId, status: { not: 'VOID' } },
    select: { id: true, code: true, status: true, qty: true, initialQty: true, _count: { select: { children: true } } },
  })
}

/**
 * The rate of a line that came in without one: set by someone with
 * Inventory → approve, valued from the opening date.
 */
export async function setOpeningRate(lineId: string, rate: number, userId: string | null) {
  if (!(rate > 0)) throw new AppError('Give the rate the stock is valued at: more than nought.', 400, 'BAD_RATE')
  return prisma.$transaction(
    async (tx) => {
      const line = await tx.openingStockLine.findUnique({ where: { id: lineId }, include: { openingStock: { select: { number: true, reversedAt: true } }, item: { select: { code: true } } } })
      if (!line) throw new AppError('That opening stock line does not exist.', 404, 'NOT_FOUND')
      if (line.openingStock.reversedAt) throw new AppError(`${line.openingStock.number} was reversed: its stock is no longer in.`, 400, 'REVERSED')
      if (!line.valuationPending) {
        throw new AppError(`This line is valued already, at ₹${Number(line.unitRate)}. A different rate is a correction: ask for one with a reason.`, 400, 'ALREADY_VALUED')
      }
      const moved = await openingMovementOf(tx, line, line.openingStock.number)
      await tx.stockLedger.update({ where: { id: moved.id }, data: { unitRate: round2(rate) } })
      const repriced = await repriceFrom(tx, keyOf(moved))
      const value = round2(Number(line.qty) * rate)
      await tx.openingStockLine.update({ where: { id: line.id }, data: { unitRate: round2(rate), value, valuationPending: false, ledgerId: moved.id } })
      return { number: line.openingStock.number, row: line.rowNo, item: line.item.code, rate: round2(rate), value, repriced, userId }
    },
    { timeout: 120_000, maxWait: 20_000 },
  )
}

export type ChangeLine = { lineId: string; qty?: number | null; rate?: number | null }

/** A correction or a reversal asked for, with its reason: nothing is posted until it is approved. */
export async function requestChange(
  input: { openingStockId: string; kind: 'CORRECTION' | 'REVERSAL'; reason: string; lines?: ChangeLine[] },
  userId: string | null,
) {
  const reason = input.reason.trim()
  if (reason.length < 3) throw new AppError('Say why: the reason is kept with the request.', 400, 'NO_REASON')
  return prisma.$transaction(async (tx) => {
    const doc = await tx.openingStock.findUnique({
      where: { id: input.openingStockId },
      select: { id: true, number: true, reversedAt: true, lines: { select: { id: true, rowNo: true, qty: true, unitRate: true } } },
    })
    if (!doc) throw new AppError('That opening stock entry does not exist.', 404, 'NOT_FOUND')
    if (doc.reversedAt) throw new AppError(`${doc.number} is reversed already.`, 400, 'REVERSED')
    const waiting = await tx.openingStockChange.findFirst({ where: { openingStockId: doc.id, status: 'PENDING' }, select: { number: true } })
    if (waiting) throw new AppError(`${waiting.number} is already waiting on ${doc.number}: it is approved or withdrawn first.`, 400, 'PENDING_CHANGE')

    let lines: Array<{ lineId: string; qty: number; rate: number; was: { qty: number; rate: number }; row: number }> | null = null
    if (input.kind === 'CORRECTION') {
      const byId = new Map(doc.lines.map((l) => [l.id, l]))
      const asked = [...new Map((input.lines ?? []).map((l) => [l.lineId, l])).values()]
      lines = []
      for (const a of asked) {
        const l = byId.get(a.lineId)
        if (!l) throw new AppError(`A line asked for is not part of ${doc.number}.`, 400, 'NOT_ITS_LINE')
        const qty = a.qty ?? Number(l.qty)
        const rate = a.rate ?? Number(l.unitRate)
        if (!(qty >= 0) || !(rate >= 0)) throw new AppError(`Row ${l.rowNo}: quantity and rate are nought or more.`, 400, 'BAD_FIGURE')
        if (Math.abs(qty - Number(l.qty)) < 0.0005 && Math.abs(rate - Number(l.unitRate)) < 0.005) continue
        if (Math.abs(qty - Number(l.qty)) >= 0.0005) {
          const own = await stickersOf(tx, l.id)
          if (own.length) {
            throw new AppError(
              `Row ${l.rowNo} is on ${own.length} ${own.length === 1 ? 'sticker' : 'stickers'} (${own.slice(0, 3).map((p) => p.code).join(', ')}${own.length > 3 ? '…' : ''}). Take them off first (Change → packaging pending), then correct its quantity.`,
              400,
              'ON_STICKERS',
            )
          }
        }
        lines.push({ lineId: l.id, qty: round3(qty), rate: round2(rate), was: { qty: Number(l.qty), rate: Number(l.unitRate) }, row: l.rowNo })
      }
      if (!lines.length) throw new AppError('Nothing to correct: give a line a different quantity or rate.', 400, 'NO_CHANGE')
    }
    const number = await nextDocumentNumber(tx, 'OSC', new Date())
    return tx.openingStockChange.create({
      data: { number, openingStockId: doc.id, kind: input.kind, reason, lines: lines ?? undefined, requestedById: userId },
      select: { id: true, number: true, kind: true, status: true },
    })
  })
}

/** Approved by someone with Inventory → approve, not the one who asked unless an Admin: then posted. */
export async function approveChange(id: string, user: { id: string; isAdmin: boolean }, note?: string | null) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM ld_erp.opening_stock_changes WHERE id = ${id} FOR UPDATE`
      const change = await tx.openingStockChange.findUnique({ where: { id }, include: { openingStock: { select: { id: true, number: true, reversedAt: true } } } })
      if (!change) throw new AppError('That request does not exist.', 404, 'NOT_FOUND')
      if (change.status !== 'PENDING') throw new AppError(`${change.number} is ${change.status.toLowerCase()} already.`, 400, 'NOT_PENDING')
      if (change.requestedById === user.id && !user.isAdmin) {
        throw new AppError('You asked for this one: someone else with Inventory → approve approves it.', 403, 'OWN_REQUEST')
      }
      const doc = change.openingStock
      if (doc.reversedAt) throw new AppError(`${doc.number} is reversed already.`, 400, 'REVERSED')
      let repriced = 0

      if (change.kind === 'CORRECTION') {
        for (const c of (change.lines ?? []) as Array<{ lineId: string; qty: number; rate: number; row: number }>) {
          const line = await tx.openingStockLine.findUnique({ where: { id: c.lineId } })
          if (!line) throw new AppError(`Row ${c.row} of ${doc.number} no longer exists.`, 404, 'NOT_FOUND')
          const diff = round3(c.qty - Number(line.qty))
          const rateChanged = Math.abs(c.rate - Number(line.unitRate)) >= 0.005
          const moved = await openingMovementOf(tx, line, doc.number)
          if (rateChanged) {
            // From the opening date: the opening movement at the corrected rate, and what was issued from it since.
            await tx.stockLedger.update({ where: { id: moved.id }, data: { unitRate: c.rate } })
          }
          if (Math.abs(diff) >= 0.0005) {
            if ((await stickersOf(tx, line.id)).length) {
              throw new AppError(`Row ${c.row} is on stickers now: take them off first (Change → packaging pending), then approve.`, 400, 'ON_STICKERS')
            }
            await recordMovement(tx, {
              itemId: line.itemId,
              warehouseId: line.warehouseId,
              transactionType: 'OPENING',
              direction: diff > 0 ? 'IN' : 'OUT',
              qty: Math.abs(diff),
              unitRate: diff > 0 ? c.rate : undefined,
              referenceType: 'OPENING_CORRECTION',
              referenceId: change.id,
              batchNumber: line.lotNo,
              orderNo: line.orderNo,
              sizeId: line.sizeId,
              grade: line.grade,
              transactionDate: line.openingDate,
              earlierDate: 'move-up',
              notes: `${change.number}: ${doc.number} row ${c.row} ${Number(line.qty)} → ${c.qty}`.slice(0, 500),
              stickers: 'caller',
            })
          }
          if (rateChanged || Math.abs(diff) >= 0.0005) repriced += await repriceFrom(tx, keyOf(moved))
          await tx.openingStockLine.update({
            where: { id: line.id },
            data: { qty: c.qty, unitRate: c.rate, value: round2(c.qty * c.rate), valuationPending: c.rate > 0 ? false : line.valuationPending, ledgerId: moved.id },
          })
        }
      } else {
        // The whole entry taken back: every line's stock out again, its stickers voided.
        const lines = await tx.openingStockLine.findMany({ where: { openingStockId: doc.id }, orderBy: { rowNo: 'asc' } })
        for (const line of lines) {
          const used = (await stickersOf(tx, line.id)).find((p) => p.status !== 'IN_STOCK' || Math.abs(Number(p.qty) - Number(p.initialQty)) > 1e-9 || p._count.children)
          if (used) {
            throw new AppError(`${used.code} (row ${line.rowNo}) has been issued from, moved or split since: the entry can no longer be taken back whole. Correct its lines instead.`, 400, 'USED')
          }
        }
        for (const line of lines) {
          if (!(Number(line.qty) > 0)) continue
          try {
            await recordMovement(tx, {
              itemId: line.itemId,
              warehouseId: line.warehouseId,
              transactionType: 'OPENING',
              direction: 'OUT',
              qty: Number(line.qty),
              referenceType: 'OPENING_REVERSAL',
              referenceId: change.id,
              batchNumber: line.lotNo,
              orderNo: line.orderNo,
              sizeId: line.sizeId,
              grade: line.grade,
              earlierDate: 'move-up',
              notes: `${change.number}: ${doc.number} row ${line.rowNo} reversed`.slice(0, 500),
              stickers: 'caller',
            })
          } catch (err) {
            if (err instanceof AppError && ['INSUFFICIENT_STOCK', 'RESERVED_STOCK', 'PACKED_IN_CARTONS'].includes(err.code ?? '')) {
              throw new AppError(`Row ${line.rowNo}: ${err.message} Some of it has been used since, so the entry cannot be taken back whole. Correct its lines instead.`, 400, 'USED')
            }
            throw err
          }
        }
        await withdrawStickers(tx, { type: 'OPENING', id: doc.id, ref: doc.number }, `${change.number}: ${doc.number} reversed`, user.id)
        // Taken back: the same stock may be brought in again, correctly.
        for (const line of lines) await tx.openingStockLine.update({ where: { id: line.id }, data: { dedupeKey: `${line.dedupeKey}|reversed:${change.id}` } })
        await tx.openingStock.update({ where: { id: doc.id }, data: { reversedAt: new Date(), reversedById: user.id } })
      }

      const done = await tx.openingStockChange.update({
        where: { id },
        data: { status: 'APPROVED', decidedById: user.id, decidedAt: new Date(), decisionNote: note?.trim() || null },
        select: { id: true, number: true, kind: true, status: true },
      })
      return { ...done, entry: doc.number, repriced }
    },
    { timeout: 300_000, maxWait: 20_000 },
  )
}

/** Turned down by an approver, with why; nothing posted. */
export async function rejectChange(id: string, userId: string, note: string) {
  if (note.trim().length < 3) throw new AppError('Say why it is turned down.', 400, 'NO_REASON')
  const change = await prisma.openingStockChange.findUnique({ where: { id }, select: { status: true, number: true } })
  if (!change) throw new AppError('That request does not exist.', 404, 'NOT_FOUND')
  if (change.status !== 'PENDING') throw new AppError(`${change.number} is ${change.status.toLowerCase()} already.`, 400, 'NOT_PENDING')
  return prisma.openingStockChange.update({ where: { id }, data: { status: 'REJECTED', decidedById: userId, decidedAt: new Date(), decisionNote: note.trim() }, select: { id: true, number: true, status: true } })
}

/** Taken back by the one who asked (or an Admin) before it is decided. */
export async function withdrawChange(id: string, user: { id: string; isAdmin: boolean }) {
  const change = await prisma.openingStockChange.findUnique({ where: { id }, select: { status: true, number: true, requestedById: true } })
  if (!change) throw new AppError('That request does not exist.', 404, 'NOT_FOUND')
  if (change.status !== 'PENDING') throw new AppError(`${change.number} is ${change.status.toLowerCase()} already.`, 400, 'NOT_PENDING')
  if (change.requestedById !== user.id && !user.isAdmin) throw new AppError('Only the one who asked can withdraw it.', 403, 'NOT_YOURS')
  return prisma.openingStockChange.update({ where: { id }, data: { status: 'WITHDRAWN', decidedAt: new Date() }, select: { id: true, number: true, status: true } })
}

/** An entry's requests, newest first, or every request still waiting. */
export async function listChanges(filter: { openingStockId?: string; status?: string }) {
  return prisma.openingStockChange.findMany({
    where: { ...(filter.openingStockId ? { openingStockId: filter.openingStockId } : {}), ...(filter.status ? { status: filter.status } : {}) },
    orderBy: { requestedAt: 'desc' },
    take: 200,
    select: {
      id: true,
      number: true,
      kind: true,
      status: true,
      reason: true,
      lines: true,
      requestedAt: true,
      decidedAt: true,
      decisionNote: true,
      requestedById: true,
      requestedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
      openingStock: { select: { id: true, number: true } },
    },
  })
}
