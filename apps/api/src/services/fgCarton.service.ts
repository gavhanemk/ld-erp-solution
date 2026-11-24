import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { lockedBalanceOf } from './stock.service'
import { dispatchChallan, loadOpenOrder, writeChallan } from '../routes/challan.routes'

/*
 * Finished-goods cartons: garments packed in the store, by item, size and
 * grade, under one carton sticker (CT-0001) — and then loaded onto a delivery
 * challan by scanning or picking the carton, the way tagged pieces are.
 *
 * The stock ledger stays the stock. A carton only says which of the store's
 * pieces are sealed in it, so it never holds more than the store has, and
 * pieces sealed in a carton do not leave the store any other way (see
 * recordMovement): they go with their carton, or the carton is opened first.
 */

/** CT-0001: the carton's sticker, read aloud or typed. */
export async function nextCartonCode(tx: Prisma.TransactionClient): Promise<string> {
  const [row] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('ld_erp.fg_carton_code_seq') AS n`
  return `CT-${String(Number(row.n)).padStart(4, '0')}`
}

/** "ct 12", "CT12", "CT-0012": the codes a typed or scanned carton number may be. */
export function cartonCodeCandidates(raw: string): string[] {
  const t = raw.trim().toUpperCase().replace(/\s+/g, '')
  const m = t.match(/^CT-?(\d+)$/)
  if (!m) return [t]
  const n = String(Number(m[1]))
  return [...new Set([`CT-${n.padStart(4, '0')}`, `CT-${n}`])]
}
export const looksLikeCarton = (raw: string) => /^CT-?\d{1,8}$/i.test(raw.trim().replace(/\s+/g, ''))

export const cartonInclude = {
  warehouse: { select: { id: true, name: true } },
  so: { select: { id: true, soNumber: true, customerPORef: true, customer: { select: { name: true } } } },
  dc: { select: { id: true, dcNumber: true, status: true } },
  createdBy: { select: { name: true } },
  lines: {
    select: {
      id: true,
      itemId: true,
      sizeId: true,
      grade: true,
      qty: true,
      item: { select: { code: true, name: true, description: true, color: true, style: { select: { code: true, name: true } } } },
      size: { select: { code: true, sequence: true } },
    },
    orderBy: [{ item: { code: 'asc' as const } }, { size: { sequence: 'asc' as const } }],
  },
} satisfies Prisma.FgCartonInclude
export type CartonFull = Prisma.FgCartonGetPayload<{ include: typeof cartonInclude }>

const spotKey = (itemId: string, warehouseId: string, sizeId: string, grade: string) => `${itemId}|${warehouseId}|${sizeId}|${grade}`

/**
 * Pieces sealed in cartons still in their store, by item, store, size and
 * grade. Cartons loaded on `exceptDcId` are left out: they leave on it.
 */
export async function packedBySpot(tx: Prisma.TransactionClient, itemIds: string[], exceptDcId?: string | null) {
  if (!itemIds.length) return new Map<string, number>()
  const rows = await tx.$queryRaw<Array<{ itemId: string; warehouseId: string; sizeId: string; grade: string; qty: number }>>`
    SELECT l."itemId", c."warehouseId", l."sizeId", l.grade, SUM(l.qty)::float8 AS qty
    FROM ld_erp.fg_carton_lines l JOIN ld_erp.fg_cartons c ON c.id = l."cartonId"
    WHERE c.status::text = 'PACKED' AND l."itemId" = ANY(${itemIds}::text[])
      AND (c."dcId" IS NULL OR c."dcId" <> ${exceptDcId ?? ''})
    GROUP BY 1, 2, 3, 4`
  return new Map(rows.map((r) => [spotKey(r.itemId, r.warehouseId, r.sizeId, r.grade), Number(r.qty)]))
}

export interface PackLine {
  itemId: string
  sizeId: string
  grade?: 'A' | 'B'
  qty: number
}

/**
 * A carton packed: from the store's finished pieces not already in a carton,
 * for an order when it is packed for one (its buyer and number go on the
 * sticker, and every item in it must be on that order).
 */
export async function packCarton(
  tx: Prisma.TransactionClient,
  input: { warehouseId: string; soId?: string | null; notes?: string | null; lines: PackLine[] },
  userId: string | null,
) {
  const store = await tx.warehouse.findUnique({ where: { id: input.warehouseId }, select: { name: true, isActive: true, departmentId: true } })
  if (!store) throw new AppError('That store does not exist.', 404, 'NOT_FOUND')
  if (!store.isActive) throw new AppError(`${store.name} is switched off.`, 400, 'INACTIVE')
  if (store.departmentId) throw new AppError(`${store.name} is a process floor: cartons are packed from finished goods in a store.`, 400, 'NOT_A_STORE')

  // One line a piece kind: the same item, size and grade typed twice is added up.
  const merged = new Map<string, PackLine & { grade: 'A' | 'B' }>()
  for (const l of input.lines) {
    if (!(l.qty > 0)) continue
    if (!Number.isInteger(l.qty)) throw new AppError('Pieces are counted whole.', 400, 'BAD_QTY')
    const grade = l.grade === 'B' ? 'B' : 'A'
    const k = `${l.itemId}|${l.sizeId}|${grade}`
    const had = merged.get(k)
    merged.set(k, { itemId: l.itemId, sizeId: l.sizeId, grade, qty: (had?.qty ?? 0) + l.qty })
  }
  if (!merged.size) throw new AppError('Put at least one piece in the carton.', 400, 'EMPTY')
  const lines = [...merged.values()]

  const [items, sizes] = await Promise.all([
    tx.item.findMany({
      where: { id: { in: [...new Set(lines.map((l) => l.itemId))] } },
      select: { id: true, code: true, name: true, type: true, isActive: true, style: { select: { code: true, sizeGroupId: true } } },
    }),
    tx.size.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.sizeId))] } }, select: { id: true, code: true, sizeGroupId: true } }),
  ])
  const itemOf = new Map(items.map((i) => [i.id, i]))
  const sizeOf = new Map(sizes.map((z) => [z.id, z]))
  for (const l of lines) {
    const it = itemOf.get(l.itemId)
    const sz = sizeOf.get(l.sizeId)
    if (!it) throw new AppError('One of those items does not exist.', 400, 'NO_ITEM')
    if (!sz) throw new AppError('One of those sizes does not exist.', 400, 'NO_SIZE')
    if (it.type !== 'FINISHED_GOOD') throw new AppError(`${it.code} is not a finished garment: only finished goods are packed in cartons.`, 400, 'NOT_FG')
    if (it.style?.sizeGroupId && sz.sizeGroupId !== it.style.sizeGroupId) throw new AppError(`Size ${sz.code} is not in ${it.style.code}'s size run.`, 400, 'WRONG_SIZE')
  }

  // Packed for an order: an order still open, with every item in the carton on it.
  let soNumber: string | null = null
  if (input.soId) {
    const order = await tx.salesOrder.findUnique({ where: { id: input.soId }, select: { soNumber: true, status: true, lines: { select: { itemId: true } } } })
    if (!order) throw new AppError('That sales order does not exist.', 404, 'NOT_FOUND')
    if (!['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'].includes(order.status)) {
      throw new AppError(`${order.soNumber} is ${order.status.toLowerCase().replace(/_/g, ' ')}: cartons are packed for an open order.`, 400, 'ORDER_NOT_OPEN')
    }
    const off = lines.find((l) => !order.lines.some((ol) => ol.itemId === l.itemId))
    if (off) throw new AppError(`${itemOf.get(off.itemId)!.code} is not on ${order.soNumber}.`, 400, 'NOT_ON_ORDER')
    soNumber = order.soNumber
  }

  // What is free to pack: the store's pieces under their stock lock, less those already sealed.
  const balances = new Map<string, number>()
  for (const l of lines) {
    const b = await lockedBalanceOf(tx, { itemId: l.itemId, warehouseId: input.warehouseId, sizeId: l.sizeId, grade: l.grade, ownership: 'OWNED', ownerCustomerId: null })
    balances.set(spotKey(l.itemId, input.warehouseId, l.sizeId, l.grade), b.qty)
  }
  const packed = await packedBySpot(tx, [...new Set(lines.map((l) => l.itemId))])
  for (const l of lines) {
    const k = spotKey(l.itemId, input.warehouseId, l.sizeId, l.grade)
    const have = balances.get(k) ?? 0
    const sealed = packed.get(k) ?? 0
    const free = Math.max(0, have - sealed)
    if (l.qty > free + 1e-9) {
      const it = itemOf.get(l.itemId)!
      const sz = sizeOf.get(l.sizeId)!
      throw new AppError(
        `Only ${free} pcs of ${it.code}${l.grade === 'B' ? ' B-grade' : ''} size ${sz.code} in ${store.name} are not already in a carton (${have} in stock, ${sealed} packed). You are packing ${l.qty}.`,
        400,
        'NOT_ENOUGH_FREE',
      )
    }
  }

  const code = await nextCartonCode(tx)
  const carton = await tx.fgCarton.create({
    data: {
      code,
      warehouseId: input.warehouseId,
      soId: input.soId ?? null,
      notes: input.notes?.trim() || null,
      createdById: userId,
      lines: { create: lines.map((l) => ({ itemId: l.itemId, sizeId: l.sizeId, grade: l.grade, qty: l.qty })) },
    },
    include: cartonInclude,
  })
  return { carton, soNumber }
}

/** A carton opened: its pieces loose in the store again. Not one loaded on a challan. */
export async function openCarton(tx: Prisma.TransactionClient, id: string, reason: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.fg_cartons WHERE id = ${id} FOR UPDATE`
  const c = await tx.fgCarton.findUnique({ where: { id }, select: { code: true, status: true, dcId: true, dc: { select: { dcNumber: true } } } })
  if (!c) throw new AppError('That carton does not exist.', 404, 'NOT_FOUND')
  if (c.status !== 'PACKED') throw new AppError(`${c.code} is ${c.status === 'DISPATCHED' ? 'dispatched' : 'opened'} already.`, 409, 'NOT_PACKED')
  if (c.dcId) throw new AppError(`${c.code} is loaded on ${c.dc?.dcNumber ?? 'a challan'}: take it off the challan first.`, 409, 'ON_CHALLAN')
  return tx.fgCarton.update({ where: { id }, data: { status: 'OPENED', openedAt: new Date(), openReason: reason.trim() }, include: cartonInclude })
}

/** A carton by its scanned or typed code, locked for the rest of the transaction. */
async function lockCarton(tx: Prisma.TransactionClient, code: string): Promise<CartonFull> {
  const found = await tx.fgCarton.findFirst({ where: { code: { in: cartonCodeCandidates(code) } }, select: { id: true } })
  if (!found) throw new AppError(`No carton with the code ${code.trim().toUpperCase()}. Check the sticker.`, 404, 'NOT_FOUND')
  await tx.$queryRaw`SELECT id FROM ld_erp.fg_cartons WHERE id = ${found.id} FOR UPDATE`
  return tx.fgCarton.findUniqueOrThrow({ where: { id: found.id }, include: cartonInclude })
}

type Order = Awaited<ReturnType<typeof loadOpenOrder>>

/** A carton's pieces as challan lines: one a line of the order and grade, by size. */
function linesOf(order: Order, pieces: Array<{ itemId: string; sizeId: string; grade: string; qty: number }>) {
  const groups = new Map<string, { soLineId: string; grade: 'A' | 'B'; sizes: Map<string, number> }>()
  for (const p of pieces) {
    const line = order.lines.find((l) => l.itemId === p.itemId)
    if (!line) throw new AppError(`That item is not on ${order.soNumber}.`, 400, 'NOT_ON_ORDER')
    const grade = p.grade === 'B' ? 'B' : 'A'
    const key = `${line.id}|${grade}`
    const g = groups.get(key) ?? { soLineId: line.id, grade, sizes: new Map<string, number>() }
    g.sizes.set(p.sizeId, (g.sizes.get(p.sizeId) ?? 0) + p.qty)
    groups.set(key, g)
  }
  return [...groups.values()].map((g) => ({ soLineId: g.soLineId, grade: g.grade, sizes: [...g.sizes].map(([sizeId, qty]) => ({ sizeId, qty })) }))
}

/** A challan's lines written again from the cartons loaded on it. */
async function rebuildFromCartons(tx: Prisma.TransactionClient, dcId: string, userId: string) {
  const dc = await tx.deliveryChallan.findUniqueOrThrow({ where: { id: dcId } })
  const order = await loadOpenOrder(tx, dc.soId)
  const cartons = await tx.fgCarton.findMany({ where: { dcId, status: 'PACKED' }, select: { lines: { select: { itemId: true, sizeId: true, grade: true, qty: true } } } })
  await writeChallan(
    tx,
    order,
    {
      soId: dc.soId,
      warehouseId: dc.warehouseId!,
      dcDate: dc.dcDate,
      deliveryAddress: dc.deliveryAddress,
      transporter: dc.transporter,
      vehicleNumber: dc.vehicleNumber,
      lrNumber: dc.lrNumber,
      eWayBillNumber: dc.eWayBillNumber,
      cartons: cartons.length,
      packingNote: dc.packingNote,
      notes: dc.notes,
      lines: linesOf(order, cartons.flatMap((c) => c.lines)),
    },
    { id: dc.id },
    userId,
  )
}

/**
 * A carton scanned or picked onto a challan. With no challan yet, the first
 * carton starts a draft for the order, from the carton's store. A carton
 * packed for an order goes only on that order's challan.
 */
export async function addCartonToChallan(tx: Prisma.TransactionClient, data: { soId: string; dcId?: string | null; code: string }, userId: string) {
  const c = await lockCarton(tx, data.code)
  if (c.status !== 'PACKED') throw new AppError(`${c.code} is ${c.status === 'DISPATCHED' ? 'dispatched' : 'opened'} already.`, 409, 'NOT_PACKED')
  let dcId = data.dcId ?? null
  if (dcId) {
    await tx.$queryRaw`SELECT id FROM ld_erp.delivery_challans WHERE id = ${dcId} FOR UPDATE`
    const dc = await tx.deliveryChallan.findUnique({ where: { id: dcId }, select: { status: true, dcNumber: true, soId: true, warehouseId: true, _count: { select: { garments: true } } } })
    if (!dc) throw new AppError('That challan does not exist.', 404, 'NOT_FOUND')
    if (dc.status !== 'DRAFT') throw new AppError(`${dc.dcNumber} is already ${dc.status.toLowerCase()}; start a new challan.`, 409, 'NOT_DRAFT')
    if (dc.soId !== data.soId) throw new AppError(`${dc.dcNumber} is for another order.`, 400, 'WRONG_ORDER')
    if (c.dcId === dcId) throw new AppError(`${c.code} is already on ${dc.dcNumber}.`, 409, 'ALREADY_ON')
    if (dc.warehouseId !== c.warehouseId) throw new AppError(`${c.code} is in ${c.warehouse.name}; ${dc.dcNumber} sends from another store.`, 400, 'WRONG_STORE')
    if (dc._count.garments) throw new AppError(`${dc.dcNumber} has tagged pieces scanned on it: load cartons on a challan of their own.`, 400, 'MIXED')
  }
  if (c.dcId) throw new AppError(`${c.code} is already loaded on ${c.dc?.dcNumber ?? 'another challan'}.`, 409, 'ON_OTHER_CHALLAN')
  if (c.soId && c.soId !== data.soId) throw new AppError(`${c.code} was packed for ${c.so?.soNumber ?? 'another order'}.`, 400, 'OTHER_ORDER')

  const order = await loadOpenOrder(tx, data.soId)
  const off = c.lines.find((l) => !order.lines.some((ol) => ol.itemId === l.itemId))
  if (off) throw new AppError(`${c.code} holds ${off.item.code}, which is not on ${order.soNumber}.`, 400, 'NOT_ON_ORDER')

  if (!dcId) {
    const created = await writeChallan(tx, order, { soId: data.soId, warehouseId: c.warehouseId, cartons: 1, lines: linesOf(order, c.lines) }, null, userId)
    dcId = created.id
  }
  await tx.fgCarton.update({ where: { id: c.id }, data: { dcId } })
  await rebuildFromCartons(tx, dcId, userId)
  return { dcId, carton: c }
}

/** A carton taken back off a draft challan. The last one off cancels the empty draft. */
export async function removeCartonFromChallan(tx: Prisma.TransactionClient, dcId: string, cartonId: string, userId: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.delivery_challans WHERE id = ${dcId} FOR UPDATE`
  const dc = await tx.deliveryChallan.findUnique({ where: { id: dcId }, select: { status: true, dcNumber: true } })
  if (!dc) throw new AppError('That challan does not exist.', 404, 'NOT_FOUND')
  if (dc.status !== 'DRAFT') throw new AppError(`${dc.dcNumber} is already ${dc.status.toLowerCase()}.`, 409, 'NOT_DRAFT')
  const c = await tx.fgCarton.findUnique({ where: { id: cartonId }, select: { id: true, code: true, dcId: true } })
  if (!c || c.dcId !== dcId) throw new AppError(`That carton is not on ${dc.dcNumber}.`, 400, 'NOT_ON')
  await tx.fgCarton.update({ where: { id: c.id }, data: { dcId: null } })
  const left = await tx.fgCarton.count({ where: { dcId } })
  if (left) {
    await rebuildFromCartons(tx, dcId, userId)
    return { emptied: false, dcNumber: dc.dcNumber, code: c.code }
  }
  // Nothing left to send: the draft goes, rather than sitting empty.
  await tx.deliveryChallanLine.deleteMany({ where: { dcId } })
  await tx.deliveryChallan.update({
    where: { id: dcId },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: userId, cancelReason: 'Every carton was taken off' },
  })
  return { emptied: true, dcNumber: dc.dcNumber, code: c.code }
}

/** The loaded challan sent: its lines must still be what its cartons hold. */
export async function dispatchCartons(
  tx: Prisma.TransactionClient,
  dcId: string,
  data: { vehicleNumber?: string | null; transporter?: string | null; lrNumber?: string | null },
  userId: string,
) {
  await tx.$queryRaw`SELECT id FROM ld_erp.delivery_challans WHERE id = ${dcId} FOR UPDATE`
  const dc = await tx.deliveryChallan.findUnique({ where: { id: dcId }, include: { lines: { select: { qty: true } } } })
  if (!dc) throw new AppError('That challan does not exist.', 404, 'NOT_FOUND')
  if (dc.status !== 'DRAFT') throw new AppError(`${dc.dcNumber} is already ${dc.status.toLowerCase()}.`, 409, 'NOT_DRAFT')
  const cartons = await tx.fgCarton.findMany({ where: { dcId, status: 'PACKED' }, select: { lines: { select: { qty: true } } } })
  if (!cartons.length) throw new AppError(`No cartons are loaded on ${dc.dcNumber}.`, 400, 'NO_CARTONS')
  const pieces = cartons.reduce((t, c) => t + c.lines.reduce((u, l) => u + l.qty, 0), 0)
  const onLines = dc.lines.reduce((t, l) => t + Number(l.qty), 0)
  if (Math.abs(onLines - pieces) > 1e-9) {
    throw new AppError(`${dc.dcNumber} lists ${onLines} pcs, but its ${cartons.length} cartons hold ${pieces}. Take a carton off and scan it again.`, 409, 'COUNT_MISMATCH')
  }
  await tx.deliveryChallan.update({
    where: { id: dcId },
    data: {
      vehicleNumber: data.vehicleNumber?.trim().toUpperCase() || dc.vehicleNumber,
      transporter: data.transporter?.trim() || dc.transporter,
      lrNumber: data.lrNumber?.trim() || dc.lrNumber,
      cartons: cartons.length,
    },
  })
  await dispatchChallan(tx, dcId, userId)
  return { dcNumber: dc.dcNumber, cartons: cartons.length, pieces }
}
