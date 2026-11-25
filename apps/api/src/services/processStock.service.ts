import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { nextDocumentNumber } from '../lib/docNumber'
import { balanceOf, lockedBalanceOf, transferStock } from './stock.service'
import { processLadder } from './processFloor.service'

/*
 * Work in progress and finished goods, process by process and size by size.
 *
 * The same stock ledger as everything else: a process's floor is a location,
 * and a garment's size is already part of every balance. What this adds is the
 * view — for an order and a style-colour, each size at each process, from
 * Cutting to the finished-goods store — and moving pieces on: the sizes taken
 * off one floor and put on the next, part of a lot at a time, never more than
 * is there.
 */

const round3 = (n: number) => Math.round(n * 1000) / 1000

type Column = { id: string; name: string; kind: 'FLOOR' | 'STORE'; process: string | null }

/**
 * Each order and style-colour's pieces: the sizes as rows, the places as
 * columns (the process floors in floor order, then any store or outside unit
 * holding some), usable stock in the cells, and what is held or B-grade.
 */
export async function processStock(filters: { orderNo?: string; itemId?: string; q?: string }) {
  const ladder = await processLadder()
  const floors = ladder.filter((p) => p.floor)
  const floorIds = floors.map((p) => p.floor!.id)

  const and: Prisma.StockLedgerWhereInput[] = [
    { OR: [{ item: { type: { in: ['FINISHED_GOOD', 'SEMI_FINISHED'] } } }, { warehouseId: { in: floorIds } }] },
    // A machine installed at a process is not work in progress.
    { item: { type: { not: 'FIXED_ASSET' } } },
  ]
  if (filters.itemId) and.push({ itemId: filters.itemId })
  if (filters.orderNo) and.push({ orderNo: { equals: filters.orderNo.trim(), mode: 'insensitive' } })
  if (filters.q?.trim()) {
    const q = filters.q.trim()
    and.push({
      OR: [
        { orderNo: { contains: q, mode: 'insensitive' } },
        { item: { name: { contains: q, mode: 'insensitive' } } },
        { item: { code: { contains: q, mode: 'insensitive' } } },
        { item: { style: { code: { contains: q, mode: 'insensitive' } } } },
        { item: { color: { contains: q, mode: 'insensitive' } } },
      ],
    })
  }

  const sums = await prisma.stockLedger.groupBy({
    by: ['itemId', 'orderNo', 'warehouseId', 'sizeId', 'grade'],
    where: { AND: and },
    _sum: { inQty: true, outQty: true },
  })
  const rows = sums
    .map((s) => ({ ...s, qty: round3(Number(s._sum.inQty ?? 0) - Number(s._sum.outQty ?? 0)) }))
    .filter((s) => s.qty !== 0)

  const [items, sizes, warehouses] = await Promise.all([
    prisma.item.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.itemId))] } },
      select: { id: true, code: true, name: true, type: true, color: true, uom: { select: { symbol: true } }, style: { select: { code: true, name: true } } },
    }),
    prisma.size.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.sizeId).filter((s): s is string => Boolean(s)))] } },
      select: { id: true, code: true, label: true, sequence: true },
    }),
    prisma.warehouse.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.warehouseId))] } },
      select: { id: true, name: true, departmentId: true },
    }),
  ])
  const itemById = new Map(items.map((i) => [i.id, i]))
  const sizeById = new Map(sizes.map((s) => [s.id, s]))

  // Every process floor, in floor order, then the stores and units holding any.
  const columns: Column[] = [
    ...floors.map((p) => ({ id: p.floor!.id, name: p.name, kind: 'FLOOR' as const, process: p.name })),
    ...warehouses
      .filter((w) => !w.departmentId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((w) => ({ id: w.id, name: w.name, kind: 'STORE' as const, process: null })),
  ]

  type Block = {
    key: string
    item: { id: string; code: string; name: string; type: string; color: string | null; style: string | null; unit: string | null }
    orderNo: string | null
    sizes: Array<{ id: string | null; code: string; sequence: number }>
    /** Usable pieces: size → place → qty. */
    cells: Record<string, Record<string, number>>
    totals: Record<string, number>
    total: number
    held: number
    bGrade: number
  }
  const blocks = new Map<string, Block>()
  for (const r of rows) {
    const item = itemById.get(r.itemId)
    if (!item) continue
    const key = `${r.itemId}|${r.orderNo ?? ''}`
    const b =
      blocks.get(key) ??
      ({
        key,
        item: { id: item.id, code: item.code, name: item.name, type: item.type, color: item.color, style: item.style?.code ?? null, unit: item.uom?.symbol ?? null },
        orderNo: r.orderNo,
        sizes: [],
        cells: {},
        totals: {},
        total: 0,
        held: 0,
        bGrade: 0,
      } satisfies Block)
    blocks.set(key, b)
    if (r.grade === 'R') {
      b.held = round3(b.held + r.qty)
      continue
    }
    if (r.grade === 'B') {
      b.bGrade = round3(b.bGrade + r.qty)
      continue
    }
    const sizeKey = r.sizeId ?? 'none'
    if (!b.sizes.some((s) => (s.id ?? 'none') === sizeKey)) {
      const s = r.sizeId ? sizeById.get(r.sizeId) : null
      b.sizes.push({ id: r.sizeId, code: s?.code ?? '—', sequence: s?.sequence ?? 999 })
    }
    b.cells[sizeKey] = b.cells[sizeKey] ?? {}
    b.cells[sizeKey][r.warehouseId] = round3((b.cells[sizeKey][r.warehouseId] ?? 0) + r.qty)
    b.totals[r.warehouseId] = round3((b.totals[r.warehouseId] ?? 0) + r.qty)
    b.total = round3(b.total + r.qty)
  }
  for (const b of blocks.values()) b.sizes.sort((x, y) => x.sequence - y.sequence || x.code.localeCompare(y.code))

  return {
    columns,
    blocks: [...blocks.values()].sort(
      (a, b) => (a.orderNo ? 0 : 1) - (b.orderNo ? 0 : 1) || (a.orderNo ?? '').localeCompare(b.orderNo ?? '') || a.item.code.localeCompare(b.item.code),
    ),
    processes: ladder.map((p) => ({ id: p.id, name: p.name, floorId: p.floor?.id ?? null })),
  }
}

/** Usable pieces of one size of an item at a place, for one order or for all. */
async function availableOf(
  tx: Prisma.TransactionClient,
  k: { itemId: string; warehouseId: string; sizeId: string | null; orderNo: string | null },
) {
  // Holds the place's lock until the move is written, so two moves cannot both take the same pieces.
  const all = await lockedBalanceOf(tx, { itemId: k.itemId, warehouseId: k.warehouseId, ownership: 'OWNED', sizeId: k.sizeId, grade: 'A' })
  if (!k.orderNo) return all.qty
  const rows = await tx.stockLedger.aggregate({
    where: {
      itemId: k.itemId,
      warehouseId: k.warehouseId,
      ownership: 'OWNED',
      sizeId: k.sizeId,
      grade: 'A',
      orderNo: { equals: k.orderNo, mode: 'insensitive' },
    },
    _sum: { inQty: true, outQty: true },
  })
  const forOrder = round3(Number(rows._sum.inQty ?? 0) - Number(rows._sum.outQty ?? 0))
  return Math.min(forOrder, all.qty)
}

export interface MoveInput {
  itemId: string
  fromWarehouseId: string
  toWarehouseId: string
  orderNo?: string | null
  lotNo?: string | null
  bundleNo?: string | null
  date?: Date
  notes?: string | null
  lines: Array<{ sizeId: string | null; qty: number }>
}

/**
 * Moves pieces from one process (or place) to the next, size by size: taken
 * off the first, put on the second, at what they were carried at. A transfer
 * document like any other, with the order, lot and bundle on each line.
 */
export async function moveStock(tx: Prisma.TransactionClient, input: MoveInput, userId: string | null) {
  if (input.fromWarehouseId === input.toWarehouseId) throw new AppError('From and To are the same place.', 400, 'SAME_WAREHOUSE')
  const lines = input.lines.filter((l) => l.qty > 0).map((l) => ({ ...l, qty: round3(l.qty) }))
  if (!lines.length) throw new AppError('Enter how many pieces of at least one size move.', 400, 'NOTHING_TO_MOVE')

  const [from, to, item] = await Promise.all([
    tx.warehouse.findUnique({ where: { id: input.fromWarehouseId }, select: { id: true, name: true } }),
    tx.warehouse.findUnique({ where: { id: input.toWarehouseId }, select: { id: true, name: true } }),
    tx.item.findUnique({ where: { id: input.itemId }, select: { code: true } }),
  ])
  if (!from || !to) throw new AppError('One of those places no longer exists.', 404, 'NOT_FOUND')
  if (!item) throw new AppError('That item no longer exists.', 404, 'NOT_FOUND')
  const orderNo = input.orderNo?.trim() || null

  // Never more than is there: per size, and per order when one is named.
  const sizeCodes = new Map(
    (await tx.size.findMany({ where: { id: { in: lines.map((l) => l.sizeId).filter((s): s is string => Boolean(s)) } }, select: { id: true, code: true } })).map((s) => [s.id, s.code]),
  )
  for (const l of lines) {
    const available = await availableOf(tx, { itemId: input.itemId, warehouseId: from.id, sizeId: l.sizeId, orderNo })
    if (l.qty > available) {
      const size = l.sizeId ? `size ${sizeCodes.get(l.sizeId) ?? ''} ` : ''
      throw new AppError(
        `${from.name} has ${available} ${size}of ${item.code}${orderNo ? ` for ${orderNo}` : ''}, not ${l.qty}.`,
        400,
        'INSUFFICIENT_STOCK',
      )
    }
  }

  const when = input.date ?? new Date()
  const transferNumber = await nextDocumentNumber(tx, 'STN', when)
  const transfer = await tx.stockTransfer.create({
    data: {
      transferNumber,
      fromWarehouseId: from.id,
      toWarehouseId: to.id,
      transferDate: when,
      notes: input.notes ?? null,
      movedById: userId,
      lines: {
        create: lines.map((l) => ({
          itemId: input.itemId,
          qty: l.qty,
          sizeId: l.sizeId,
          orderNo,
          lotNo: input.lotNo?.trim() || null,
          bundleNo: input.bundleNo?.trim() || null,
        })),
      },
    },
    include: { lines: true },
  })

  for (const line of transfer.lines) {
    const carried = await balanceOf(tx, { itemId: input.itemId, warehouseId: from.id, ownership: 'OWNED', sizeId: line.sizeId, grade: 'A' })
    await transferStock(tx, {
      itemId: input.itemId,
      fromWarehouseId: from.id,
      toWarehouseId: to.id,
      qty: Number(line.qty),
      referenceType: 'STOCK_TRANSFER',
      referenceId: transfer.id,
      sizeId: line.sizeId,
      grade: 'A',
      batchNumber: line.lotNo,
      orderNo,
      transactionDate: when,
      notes: [`${transferNumber}: ${from.name} → ${to.name}`, orderNo, line.bundleNo ? `bundle ${line.bundleNo}` : null].filter(Boolean).join(' · '),
      stickers: 'caller',
    })
    await tx.stockTransferLine.update({ where: { id: line.id }, data: { unitRate: carried.avgRate } })
  }

  return { id: transfer.id, transferNumber, from: from.name, to: to.name, pieces: round3(lines.reduce((s, l) => s + l.qty, 0)) }
}
