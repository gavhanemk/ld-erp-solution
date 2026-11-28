import type { Prisma, StockOwnership, TransferStatus } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { lockRow } from '../lib/lockRow'
import { recordMovement, transferStock } from './stock.service'
import { cutOffForMove, lockPackage, positionOf, recordPackageMove, takeFromPackage } from './package.service'
import { moveTags, tagsForRoadStep, transferTagsIn } from './garmentTransfer.service'

/*
 * Transfers that go on the road first.
 *
 * A direct transfer takes stock out of one store and puts it into the other in
 * one act. One sent in transit takes it out of the store it leaves into a
 * transit store (kind TRANSIT) when it is sent, and the store it goes to says
 * what arrived: all of it, part of it now and the rest later, some damaged.
 * What does not arrive is settled: sent back to the store it left, or written
 * off as lost with a store manager's approval. Until nothing of it has
 * arrived it can be cancelled, and the goods go back.
 *
 * On the road the goods stay what they were: ours or the customer's, the same
 * size and grade, at the rate they left at. One transit store carries every
 * consignment, so each leaves it at its own transfer's rate (stock.service
 * `atRate`) and two of the same cloth sent at different rates never blend.
 * Nothing else may move stock in or out of a transit store, so what it holds
 * is always exactly what is still on the road.
 *
 * Every step is written as a receipt on the transfer, kept as history, and
 * every stock row of every step carries the transfer's id, so reports name
 * the transfer whichever step it was. Tagged garments travel as themselves:
 * each step names the tags it covers wherever the stock alone cannot say
 * which pieces (garmentTransfer.service).
 */

const round3 = (n: number) => Math.round(n * 1000) / 1000
const indianDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10)

/** Still something on the road. */
export const OPEN_TRANSIT: TransferStatus[] = ['DISPATCHED', 'PARTLY_RECEIVED']

type Qty = Prisma.Decimal | number | string
type LineFigures = { qty: Qty; receivedQty: Qty; damagedQty: Qty; returnedQty: Qty; lostQty: Qty }

/** What of a line is still on the road. */
export const onTheWay = (l: LineFigures) =>
  round3(Number(l.qty) - Number(l.receivedQty) - Number(l.damagedQty) - Number(l.returnedQty) - Number(l.lostQty))

/** A transfer in transit's status, read from its lines. */
export function statusOf(lines: LineFigures[]): TransferStatus {
  const open = lines.some((l) => onTheWay(l) > 0.0005)
  const touched = lines.some((l) => Number(l.receivedQty) + Number(l.damagedQty) + Number(l.returnedQty) + Number(l.lostQty) > 0.0005)
  if (open) return touched ? 'PARTLY_RECEIVED' : 'DISPATCHED'
  const whole = lines.every((l) => Number(l.damagedQty) + Number(l.returnedQty) + Number(l.lostQty) <= 0.0005)
  return whole ? 'RECEIVED' : 'DISCREPANCY'
}

/** The transit store goods go on the road through: the one named, or the only one there is. */
export async function transitStoreFor(tx: Prisma.TransactionClient, given?: string | null) {
  const stores = await tx.warehouse.findMany({ where: { kind: 'TRANSIT', isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  if (given) {
    const w = stores.find((s) => s.id === given)
    if (!w) throw new AppError('That store is not an active transit store. Pick one whose kind is In transit.', 400, 'NOT_TRANSIT_STORE')
    return w
  }
  if (!stores.length) {
    throw new AppError('There is no transit store yet. Add one in Masters → Warehouses with the kind "In transit", then send it again.', 400, 'NO_TRANSIT_STORE')
  }
  if (stores.length > 1) {
    throw new AppError(`Say which transit store it goes through: ${stores.map((s) => s.name).join(', ')}.`, 400, 'TRANSIT_STORE_NEEDED')
  }
  return stores[0]
}

const lineInclude = { item: { select: { name: true, uom: { select: { symbol: true } } } } } as const

/** The transfer, locked for the rest of the transaction, with something still on the road. */
async function openTransfer(tx: Prisma.TransactionClient, id: string) {
  await lockRow(tx, 'stockTransfer', id)
  const t = await tx.stockTransfer.findUnique({
    where: { id },
    include: {
      lines: { include: lineInclude, orderBy: { id: 'asc' } },
      fromWarehouse: { select: { id: true, name: true } },
      toWarehouse: { select: { id: true, name: true } },
      transitWarehouse: { select: { id: true, name: true } },
    },
  })
  if (!t) throw new AppError('That stock transfer does not exist', 404, 'NOT_FOUND')
  if (t.mode !== 'IN_TRANSIT' || !t.transitWarehouseId || !t.transitWarehouse) {
    throw new AppError(`${t.transferNumber} went straight to ${t.toWarehouse.name}: nothing of it is on the road.`, 400, 'NOT_IN_TRANSIT')
  }
  if (t.cancelledAt) throw new AppError(`${t.transferNumber} was cancelled.`, 400, 'ALREADY_CANCELLED')
  if (!OPEN_TRANSIT.includes(t.status)) {
    throw new AppError(`${t.transferNumber} is closed: nothing of it is on the way any more.`, 400, 'TRANSFER_CLOSED')
  }
  return t as typeof t & { transitWarehouseId: string; transitWarehouse: { id: string; name: string } }
}
type OpenTransfer = Awaited<ReturnType<typeof openTransfer>>
type Line = OpenTransfer['lines'][number]

/**
 * The rate a line's goods went on the road at, read from its own arrival in
 * the transit store: a late opening rate reprices that row and this follows.
 */
async function roadRate(tx: Prisma.TransactionClient, t: OpenTransfer, line: Line) {
  const row = await tx.stockLedger.findFirst({
    where: {
      referenceType: 'STOCK_TRANSFER',
      referenceId: t.id,
      warehouseId: t.transitWarehouseId,
      itemId: line.itemId,
      ownership: line.ownership,
      ownerCustomerId: line.ownerCustomerId,
      sizeId: line.sizeId,
      grade: line.grade,
      brandId: line.brandId,
      inQty: { gt: 0 },
    },
    orderBy: { createdAt: 'asc' },
    select: { unitRate: true },
  })
  return Number(row?.unitRate ?? line.unitRate ?? 0)
}

/** The day a step is dated: never before the goods were sent. */
function stepDate(t: OpenTransfer, asked: Date | undefined, what: string) {
  const when = asked ?? new Date()
  if (indianDay(when) < indianDay(t.transferDate)) {
    throw new AppError(`${t.transferNumber} was sent on ${indianDay(t.transferDate)}: it cannot be ${what} before that.`, 400, 'BEFORE_SENT')
  }
  return when
}

/** The lines asked for, each checked against what is still on its way. */
type Asked = { lineId: string; qty?: number | null; damagedQty?: number | null; garmentCodes?: string[] | null; damagedGarmentCodes?: string[] | null }

function linesAsked(t: OpenTransfer, asked: Asked[], verb: string) {
  const byId = new Map(t.lines.map((l) => [l.id, l]))
  const seen = new Set<string>()
  const out: Array<{ line: Line; qty: number; damaged: number; codes: string[]; damagedCodes: string[] }> = []
  for (const a of asked) {
    const line = byId.get(a.lineId)
    if (!line) throw new AppError(`That line is not on ${t.transferNumber}.`, 400, 'WRONG_LINE')
    if (seen.has(a.lineId)) throw new AppError(`${line.item.name} is on the list twice. Enter it once, with the total.`, 400, 'LINE_TWICE')
    seen.add(a.lineId)
    const qty = round3(Number(a.qty ?? 0))
    const damaged = round3(Number(a.damagedQty ?? 0))
    if (qty < 0 || damaged < 0) throw new AppError('A quantity cannot be negative.', 400, 'NEGATIVE_QTY')
    if (!(qty + damaged > 0)) continue
    const left = onTheWay(line)
    const unit = line.item.uom?.symbol ?? ''
    if (qty + damaged > left + 0.0005) {
      throw new AppError(
        `Only ${left} ${unit} of ${line.item.name} is still on the way on ${t.transferNumber}, so ${round3(qty + damaged)} ${unit} cannot be ${verb}.`.replace(/\s+/g, ' '),
        400,
        'MORE_THAN_ON_THE_WAY',
      )
    }
    out.push({ line, qty, damaged, codes: a.garmentCodes ?? [], damagedCodes: a.damagedGarmentCodes ?? [] })
  }
  if (!out.length) throw new AppError(`Say how much is ${verb}: nothing was entered.`, 400, 'NOTHING_ENTERED')
  return out
}

/**
 * The transfer's stickers waiting in the transit store move on with the goods:
 * to the store they arrived at (damaged ones held as R), back to the store
 * they left, or taken down when the goods were lost. Whole packages go first,
 * oldest first; part of one goes as a new package with its own sticker, to
 * print. Goods sent without stickers (or before their labels window was done)
 * have none here, and nothing is moved for them. Returns the new packages.
 */
async function stickersOnward(
  tx: Prisma.TransactionClient,
  t: OpenTransfer,
  line: Line,
  qty: number,
  o: { toWarehouseId: string | null; grade?: string; referenceType: string; notes: string; userId: string | null },
): Promise<string[]> {
  let left = round3(qty)
  if (!(left > 0)) return []
  // Its own: the packages its labels window sent into the transit store.
  const sent = await tx.stockPackageMove.findMany({
    where: { referenceId: t.id, type: 'TRANSFERRED', toWarehouseId: t.transitWarehouseId },
    select: { packageId: true },
    distinct: ['packageId'],
  })
  if (!sent.length) return []
  const candidates = await tx.stockPackage.findMany({
    where: {
      id: { in: sent.map((s) => s.packageId) },
      warehouseId: t.transitWarehouseId,
      status: 'IN_STOCK',
      itemId: line.itemId,
      ownership: line.ownership as StockOwnership,
      ownerCustomerId: line.ownerCustomerId,
      brandId: line.brandId,
    },
    orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
    select: { id: true },
  })
  const ref = { referenceType: o.referenceType, referenceId: t.id, referenceNumber: t.transferNumber, userId: o.userId }
  const reprint: string[] = []
  for (const c of candidates) {
    if (left <= 0.0005) break
    const pkg = await lockPackage(tx, c.id)
    if (pkg.status !== 'IN_STOCK' || pkg.warehouseId !== t.transitWarehouseId) continue
    const take = round3(Math.min(Number(pkg.qty), left))
    if (o.toWarehouseId === null) {
      await takeFromPackage(tx, pkg, take, { notes: o.notes, ...ref })
    } else {
      const unit = pkg.item.uom?.symbol ?? ''
      const cut = await cutOffForMove(tx, pkg, take, { notes: o.notes, unit, toWarehouseId: o.toWarehouseId, ...ref })
      const part = cut ?? { id: pkg.id, code: pkg.code, qty: round3(Number(pkg.qty)) }
      await tx.stockPackage.update({ where: { id: part.id }, data: { warehouseId: o.toWarehouseId, rack: null, ...(o.grade ? { grade: o.grade } : {}) } })
      await recordPackageMove(tx, {
        packageId: part.id,
        type: 'TRANSFERRED',
        qty: part.qty,
        balanceAfter: part.qty,
        warehouseId: t.transitWarehouseId,
        toWarehouseId: o.toWarehouseId,
        notes: o.notes,
        ...ref,
      })
      if (cut) reprint.push(cut.id)
    }
    left = round3(left - take)
  }
  return reprint
}

/**
 * Its stickers went on the road with it before anything is done at the other
 * end. Sent from a store that labels the item, the labels window after the
 * send moves the rolls that went into the transit store; each receipt, send-
 * back or write-off then takes them on from there. Skipped, the rolls would
 * still be in the store they left, claiming stock that has gone, and nothing
 * done later could tell which of them went where. So a step waits for it:
 * only when the store it left still shows more on its stickers than it holds
 * and this transfer moved none of that item's stickers.
 */
async function assertStickersOnTheRoad(tx: Prisma.TransactionClient, t: OpenTransfer, lines: Line[]) {
  for (const line of lines) {
    const moved = await tx.stockPackageMove.count({
      where: { referenceId: t.id, type: 'TRANSFERRED', toWarehouseId: t.transitWarehouseId, package: { itemId: line.itemId } },
    })
    if (moved) continue
    const pos = await positionOf(tx, { itemId: line.itemId, warehouseId: t.fromWarehouseId, ownership: line.ownership as StockOwnership, ownerCustomerId: line.ownerCustomerId })
    if (pos.loose >= -0.0005) continue
    const unit = line.item.uom?.symbol ?? ''
    throw new AppError(
      `The stickers of ${t.transferNumber} were not moved when it was sent: ${t.fromWarehouse.name}'s stickers still claim ${round3(-pos.loose)} ${unit} of ${line.item.name} it no longer holds. Open its labels window first (Stock Documents → Transfers → ${t.transferNumber} → Stickers for what went), so the rolls travel with the goods.`.replace(/\s+/g, ' '),
      409,
      'STICKERS_NOT_ON_THE_ROAD',
    )
  }
}

/** The line's figures put on, and the transfer's status read again from all its lines. */
async function settleStatus(tx: Prisma.TransactionClient, transferId: string) {
  const lines = await tx.stockTransferLine.findMany({ where: { transferId }, select: { qty: true, receivedQty: true, damagedQty: true, returnedQty: true, lostQty: true } })
  const status = statusOf(lines)
  await tx.stockTransfer.update({ where: { id: transferId }, data: { status } })
  return status
}

// The share travels with the goods: it waits on the road, and arrives, as itself.
const keyOf = (l: Line) => ({ ownership: l.ownership, ownerCustomerId: l.ownerCustomerId, sizeId: l.sizeId, grade: l.grade, brandId: l.brandId })
const tagKeyOf = (l: Line) => ({ itemId: l.itemId, ...keyOf(l) })

/** The tags one step covers on each line, checked before any stock moves. */
async function stepTags(t: OpenTransfer, tx: Prisma.TransactionClient, doing: Array<{ line: Line; qty: number; damaged: number; codes: string[]; damagedCodes: string[] }>, verb: string) {
  const out = new Map<string, Awaited<ReturnType<typeof tagsForRoadStep>>>()
  for (const d of doing) {
    out.set(
      d.line.id,
      await tagsForRoadStep(tx, {
        transferId: t.id,
        transitWarehouseId: t.transitWarehouseId,
        key: tagKeyOf(d.line),
        onTheWay: onTheWay(d.line),
        qty: d.qty,
        damaged: d.damaged,
        codes: d.codes,
        damagedCodes: d.damagedCodes,
        label: d.line.item.name,
        verb,
      }),
    )
  }
  return out
}

/**
 * The store it went to says what arrived. Good goods arrive as the grade they
 * left as; damaged ones as R, held in the same store until someone decides
 * what to do with them. What has not come yet stays on the road.
 */
export async function receiveTransfer(
  tx: Prisma.TransactionClient,
  id: string,
  data: { receivedAt?: Date; notes?: string | null; lines: Asked[] },
  userId: string | null,
) {
  const t = await openTransfer(tx, id)
  const when = stepDate(t, data.receivedAt, 'received')
  const doing = linesAsked(t, data.lines, 'received')
  await assertStickersOnTheRoad(tx, t, doing.map((d) => d.line))
  const tags = await stepTags(t, tx, doing, 'received')
  const receipt = await tx.stockTransferReceipt.create({
    data: {
      transferId: t.id,
      kind: 'RECEIVED',
      receivedAt: when,
      byId: userId,
      notes: data.notes ?? null,
      lines: { create: doing.map((d) => ({ transferLineId: d.line.id, qty: d.qty, damagedQty: d.damaged })) },
    },
  })
  const reprint: string[] = []
  for (const d of doing) {
    const atRate = await roadRate(tx, t, d.line)
    const base = {
      itemId: d.line.itemId,
      fromWarehouseId: t.transitWarehouseId,
      toWarehouseId: t.toWarehouseId,
      ...keyOf(d.line),
      atRate,
      referenceType: 'STOCK_TRANSFER_RECEIVED',
      referenceId: t.id,
      transactionDate: when,
      stickers: 'caller' as const,
    }
    if (d.qty > 0) {
      await transferStock(tx, { ...base, qty: d.qty, notes: `${t.transferNumber}: arrived at ${t.toWarehouse.name}` })
      reprint.push(...(await stickersOnward(tx, t, d.line, d.qty, { toWarehouseId: t.toWarehouseId, referenceType: 'STOCK_TRANSFER_RECEIVED', notes: `arrived at ${t.toWarehouse.name}`, userId })))
    }
    if (d.damaged > 0) {
      await transferStock(tx, { ...base, qty: d.damaged, toGrade: 'R', notes: `${t.transferNumber}: arrived damaged at ${t.toWarehouse.name}, held as rejected` })
      reprint.push(...(await stickersOnward(tx, t, d.line, d.damaged, { toWarehouseId: t.toWarehouseId, grade: 'R', referenceType: 'STOCK_TRANSFER_RECEIVED', notes: `arrived damaged at ${t.toWarehouse.name}`, userId })))
    }
    // Its tags arrive with it; a damaged piece's tag is held as R like the piece.
    const tg = tags.get(d.line.id)!
    await moveTags(tx, tg.good, t.toWarehouseId, { transferId: t.id, transferNumber: t.transferNumber, notes: `arrived at ${t.toWarehouse.name}` }, userId)
    await moveTags(tx, tg.damaged, t.toWarehouseId, { transferId: t.id, transferNumber: t.transferNumber, notes: `arrived damaged at ${t.toWarehouse.name}` }, userId, { grade: 'R' })
    await tx.stockTransferLine.update({ where: { id: d.line.id }, data: { receivedQty: { increment: d.qty }, damagedQty: { increment: d.damaged } } })
  }
  const status = await settleStatus(tx, t.id)
  return { id: receipt.id, reprint, status, received: doing }
}

/** What did not arrive goes back to the store it left: it never went, or it came back. */
export async function sendBackTransfer(
  tx: Prisma.TransactionClient,
  id: string,
  data: { date?: Date; notes?: string | null; lines: Asked[] },
  userId: string | null,
) {
  const t = await openTransfer(tx, id)
  const when = stepDate(t, data.date, 'sent back')
  const doing = linesAsked(t, data.lines, 'sent back')
  await assertStickersOnTheRoad(tx, t, doing.map((d) => d.line))
  const tags = await stepTags(t, tx, doing, 'sent back')
  const receipt = await tx.stockTransferReceipt.create({
    data: { transferId: t.id, kind: 'RETURNED', receivedAt: when, byId: userId, notes: data.notes ?? null, lines: { create: doing.map((d) => ({ transferLineId: d.line.id, qty: d.qty })) } },
  })
  const reprint: string[] = []
  for (const d of doing) {
    await transferStock(tx, {
      itemId: d.line.itemId,
      fromWarehouseId: t.transitWarehouseId,
      toWarehouseId: t.fromWarehouseId,
      qty: d.qty,
      ...keyOf(d.line),
      atRate: await roadRate(tx, t, d.line),
      referenceType: 'STOCK_TRANSFER_RETURNED',
      referenceId: t.id,
      transactionDate: when,
      notes: `${t.transferNumber}: sent back to ${t.fromWarehouse.name}${data.notes ? ` — ${data.notes}` : ''}`,
      stickers: 'caller',
    })
    reprint.push(...(await stickersOnward(tx, t, d.line, d.qty, { toWarehouseId: t.fromWarehouseId, referenceType: 'STOCK_TRANSFER_RETURNED', notes: `sent back to ${t.fromWarehouse.name}`, userId })))
    await moveTags(tx, tags.get(d.line.id)!.good, t.fromWarehouseId, { transferId: t.id, transferNumber: t.transferNumber, notes: `sent back to ${t.fromWarehouse.name}` }, userId)
    await tx.stockTransferLine.update({ where: { id: d.line.id }, data: { returnedQty: { increment: d.qty } } })
  }
  const status = await settleStatus(tx, t.id)
  return { id: receipt.id, reprint, status, settled: doing }
}

/**
 * What was lost on the way, written off with a store manager's approval and a
 * reason. It leaves the transit store at its transfer's rate: that value is
 * what the loss cost, and stock is lower by exactly it.
 */
export async function writeOffTransfer(
  tx: Prisma.TransactionClient,
  id: string,
  data: { date?: Date; reason: string; lines: Asked[] },
  userId: string | null,
) {
  const t = await openTransfer(tx, id)
  const when = stepDate(t, data.date, 'written off')
  const doing = linesAsked(t, data.lines, 'written off')
  await assertStickersOnTheRoad(tx, t, doing.map((d) => d.line))
  const tags = await stepTags(t, tx, doing, 'written off')
  const receipt = await tx.stockTransferReceipt.create({
    data: { transferId: t.id, kind: 'WRITTEN_OFF', receivedAt: when, byId: userId, notes: data.reason, lines: { create: doing.map((d) => ({ transferLineId: d.line.id, qty: d.qty })) } },
  })
  let value = 0
  for (const d of doing) {
    const moved = await recordMovement(tx, {
      itemId: d.line.itemId,
      warehouseId: t.transitWarehouseId,
      transactionType: 'ADJUSTMENT',
      direction: 'OUT',
      qty: d.qty,
      ...keyOf(d.line),
      atRate: await roadRate(tx, t, d.line),
      referenceType: 'STOCK_TRANSFER_LOST',
      referenceId: t.id,
      transactionDate: when,
      notes: `${t.transferNumber}: lost on the way — ${data.reason}`,
      stickers: 'caller',
    })
    value += d.qty * moved.unitRate
    await stickersOnward(tx, t, d.line, d.qty, { toWarehouseId: null, referenceType: 'STOCK_TRANSFER_LOST', notes: `Lost on the way: ${data.reason}`, userId })
    // A lost piece's tag is written off with it.
    await moveTags(tx, tags.get(d.line.id)!.good, t.transitWarehouseId, { transferId: t.id, transferNumber: t.transferNumber, notes: `Lost on the way: ${data.reason}` }, userId, { status: 'SCRAPPED' })
    await tx.stockTransferLine.update({ where: { id: d.line.id }, data: { lostQty: { increment: d.qty } } })
  }
  const status = await settleStatus(tx, t.id)
  return { id: receipt.id, status, settled: doing, value: Math.round(value * 100) / 100 }
}

/**
 * Taking back a transfer still on the road, before anything of it arrived:
 * the goods go back to the store they left at the rate they left at, and
 * their stickers with them. Once part has been received or settled, what is
 * left goes back by sending it back instead.
 */
export async function cancelInTransit(tx: Prisma.TransactionClient, id: string, reason: string, userId: string | null) {
  const t = await openTransfer(tx, id)
  if (t.status !== 'DISPATCHED' || t.lines.some((l) => onTheWay(l) < Number(l.qty) - 0.0005)) {
    throw new AppError(
      `Part of ${t.transferNumber} has already been received or settled, so it cannot be cancelled. Send back what is still on the way instead.`,
      409,
      'PART_RECEIVED',
    )
  }
  for (const line of t.lines) {
    const qty = round3(Number(line.qty))
    await transferStock(tx, {
      itemId: line.itemId,
      fromWarehouseId: t.transitWarehouseId,
      toWarehouseId: t.fromWarehouseId,
      qty,
      ...keyOf(line),
      atRate: await roadRate(tx, t, line),
      referenceType: 'STOCK_TRANSFER_CANCELLED',
      referenceId: t.id,
      transactionDate: new Date(),
      notes: `${t.transferNumber} cancelled: ${reason}`,
      earlierDate: 'move-up',
      stickers: 'caller',
    })
    await stickersOnward(tx, t, line, qty, { toWarehouseId: t.fromWarehouseId, referenceType: 'STOCK_TRANSFER_CANCELLED', notes: `${t.transferNumber} cancelled: back to ${t.fromWarehouse.name}`, userId })
    await moveTags(tx, await transferTagsIn(tx, t.id, t.transitWarehouseId, tagKeyOf(line)), t.fromWarehouseId, { transferId: t.id, transferNumber: t.transferNumber, notes: `${t.transferNumber} cancelled: back to ${t.fromWarehouse.name}` }, userId)
  }
  await tx.stockTransfer.update({
    where: { id: t.id },
    data: { cancelledAt: new Date(), cancelledById: userId, cancelReason: reason, status: 'CANCELLED' },
  })
  return t
}
