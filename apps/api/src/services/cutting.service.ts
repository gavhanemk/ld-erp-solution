import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { recordMovement } from './stock.service'

/**
 * Cutting, recorded against a manufacturing order.
 *
 * The store issues fabric to the cutting floor on a requisition; until now
 * nothing said what happened to it there. A cutting entry does: the fabric
 * used, the cut waste, and the pieces cut by size — so 960 m issued is
 * explained as 930 m in 600 shirts and 30 m of end bits, and whatever is left
 * goes back to the store on a floor return. When the cut panels go out for
 * outside work (embroidery), they are put into a store as a semi-finished
 * item, the customer's on a job-work order, so a job-work challan can carry
 * them.
 *
 * Numbered from the order (MO-2627-0001-C1, -C2), so no new number series is
 * needed. Cancelling takes any panels back out of stock.
 */

type Db = Prisma.TransactionClient

const round3 = (n: number) => Math.round(n * 1000) / 1000
const round2 = (n: number) => Math.round(n * 100) / 100
const isFabric = (cat: { name: string; parent: { name: string } | null } | null) =>
  /fabric/i.test(cat?.name ?? '') || /fabric/i.test(cat?.parent?.name ?? '')

export const cuttingSchema = z.object({
  cutDate: z.coerce.date().optional(),
  fabricItemId: z.string().min(1, 'Say which fabric was cut'),
  fabricUsed: z.number().min(0, 'Fabric used cannot be negative').max(9_999_999),
  wastage: z.number().min(0, 'Waste cannot be negative').max(9_999_999).optional(),
  noOfLayers: z.number().int().min(0).max(10_000).optional().nullable(),
  /** Pieces cut by size, for an order with sizes. */
  sizes: z.array(z.object({ sizeId: z.string().min(1), qty: z.number().int().min(0) })).optional(),
  /** Pieces cut, for an order without sizes. */
  pieces: z.number().int().min(0).optional(),
  /** Put the cut panels into a store, as this semi-finished item, to send for outside work. */
  panelItemId: z.string().optional().nullable(),
  panelWarehouseId: z.string().optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
})

/** Everything the cutting form needs for one order. */
export async function cuttingPrep(db: Db, moId: string) {
  const mo = await db.manufacturingOrder.findUnique({
    where: { id: moId },
    select: {
      id: true,
      moNumber: true,
      status: true,
      totalPlannedQty: true,
      totalCutQty: true,
      so: { select: { id: true, soNumber: true, isJobWork: true, customerId: true, customer: { select: { name: true } } } },
      lines: { select: { totalQty: true, sizes: { select: { sizeId: true, qty: true, size: { select: { code: true, sequence: true } } } } } },
      cuttingOrders: {
        where: { status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          cutOrderNumber: true,
          cutDate: true,
          fabricItemId: true,
          fabricIssued: true,
          fabricUsed: true,
          wastage: true,
          actualPieces: true,
          sizeBreakup: true,
          status: true,
          notes: true,
          fabricItem: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
          panelItem: { select: { code: true, name: true } },
          panelWarehouse: { select: { name: true } },
          createdBy: { select: { name: true } },
        },
      },
    },
  })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')

  // What was issued to this order, item by item, less what came back.
  const issued = await db.materialRequisitionLine.findMany({
    where: { mr: { moId: mo.id }, issuedQty: { gt: 0 } },
    select: {
      itemId: true,
      issuedQty: true,
      returnedQty: true,
      ownership: true,
      item: { select: { code: true, name: true, uom: { select: { symbol: true } }, category: { select: { name: true, parent: { select: { name: true } } } } } },
    },
  })
  const byItem = new Map<string, { itemId: string; code: string; name: string; uom: string | null; fabric: boolean; theirs: boolean; issued: number }>()
  for (const l of issued) {
    const row = byItem.get(l.itemId) ?? {
      itemId: l.itemId,
      code: l.item.code,
      name: l.item.name,
      uom: l.item.uom?.symbol ?? null,
      fabric: isFabric(l.item.category),
      theirs: false,
      issued: 0,
    }
    row.issued = round3(row.issued + Number(l.issuedQty) - Number(l.returnedQty))
    row.theirs = row.theirs || l.ownership === 'CUSTOMER_OWNED'
    byItem.set(l.itemId, row)
  }
  const fabrics = [...byItem.values()]
    .map((f) => {
      const accounted = round3(
        mo.cuttingOrders.filter((c) => c.fabricItemId === f.itemId).reduce((s, c) => s + Number(c.fabricUsed ?? 0) + Number(c.wastage ?? 0), 0),
      )
      return { ...f, accounted, left: round3(f.issued - accounted) }
    })
    .sort((a, b) => Number(b.fabric) - Number(a.fabric) || a.name.localeCompare(b.name))

  // Pieces by size: planned on the order, cut so far.
  const planned = new Map<string, { sizeId: string; code: string; sequence: number; planned: number; cut: number }>()
  for (const l of mo.lines) {
    for (const z of l.sizes) {
      const row = planned.get(z.sizeId) ?? { sizeId: z.sizeId, code: z.size.code, sequence: z.size.sequence, planned: 0, cut: 0 }
      row.planned += z.qty
      planned.set(z.sizeId, row)
    }
  }
  for (const c of mo.cuttingOrders) {
    for (const [sizeId, qty] of Object.entries((c.sizeBreakup ?? {}) as Record<string, number>)) {
      const row = planned.get(sizeId)
      if (row) row.cut += Number(qty)
    }
  }
  const sizes = [...planned.values()].sort((a, b) => a.sequence - b.sequence)

  const [panelItems, warehouses] = await Promise.all([
    db.item.findMany({ where: { type: 'SEMI_FINISHED', isActive: true }, select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }),
    db.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ])

  return {
    mo: { id: mo.id, moNumber: mo.moNumber, status: mo.status, totalPlannedQty: mo.totalPlannedQty, totalCutQty: mo.totalCutQty, so: mo.so },
    fabrics,
    sizes,
    cuttings: mo.cuttingOrders,
    panelItems,
    warehouses,
  }
}

/** Records one cutting against an order, inside the caller's transaction. */
export async function createCutting(tx: Db, moId: string, data: z.infer<typeof cuttingSchema>, userId: string) {
  await tx.$queryRaw`SELECT id FROM ld_erp.manufacturing_orders WHERE id = ${moId} FOR UPDATE`
  const prep = await cuttingPrep(tx, moId)
  const { mo } = prep
  if (mo.status === 'DRAFT' || mo.status === 'CLOSED' || mo.status === 'COMPLETED') {
    throw new AppError(`${mo.moNumber} is ${mo.status.toLowerCase()}, so nothing is being cut for it`, 409, 'NOT_OPEN')
  }

  const fabric = prep.fabrics.find((f) => f.itemId === data.fabricItemId)
  if (!fabric) {
    throw new AppError(`That fabric has not been issued to ${mo.moNumber}. Issue it on the order's requisition first.`, 400, 'FABRIC_NOT_ISSUED')
  }
  const wastage = data.wastage ?? 0
  if (round3(data.fabricUsed + wastage) > fabric.left + 1e-9) {
    throw new AppError(
      `Only ${fabric.left} ${fabric.uom ?? ''} of ${fabric.name} issued to ${mo.moNumber} is not yet accounted for; this cutting uses ${round3(data.fabricUsed + wastage)} with the waste.`.replace(/\s+/g, ' '),
      400,
      'MORE_THAN_ISSUED',
    )
  }

  // Pieces: by size when the order has sizes, never more than planned.
  let pieces: number
  const breakup: Record<string, number> = {}
  if (prep.sizes.length) {
    for (const z of data.sizes ?? []) {
      if (z.qty <= 0) continue
      const s = prep.sizes.find((x) => x.sizeId === z.sizeId)
      if (!s) throw new AppError(`That size is not on ${mo.moNumber}`, 400, 'BAD_SIZE')
      if (s.cut + z.qty > s.planned) {
        throw new AppError(`Size ${s.code}: ${s.planned} planned and ${s.cut} already cut, so ${z.qty} more is too many`, 400, 'MORE_THAN_PLANNED')
      }
      breakup[z.sizeId] = z.qty
    }
    pieces = Object.values(breakup).reduce((s, n) => s + n, 0)
  } else {
    pieces = data.pieces ?? 0
    if (mo.totalCutQty + pieces > mo.totalPlannedQty) {
      throw new AppError(`${mo.totalPlannedQty} planned and ${mo.totalCutQty} already cut, so ${pieces} more is too many`, 400, 'MORE_THAN_PLANNED')
    }
  }
  if (pieces <= 0 && data.fabricUsed <= 0) throw new AppError('Enter the pieces cut and the fabric used', 400, 'NOTHING_CUT')

  // Panels into a store, to go out for outside work.
  const panelsIn = !!(data.panelItemId && data.panelWarehouseId && pieces > 0)
  if (data.panelItemId || data.panelWarehouseId) {
    if (!data.panelItemId || !data.panelWarehouseId) throw new AppError('Say both the panel item and the store to put them in', 400, 'PANELS_INCOMPLETE')
    const item = await tx.item.findUnique({ where: { id: data.panelItemId }, select: { type: true, code: true, isActive: true } })
    if (!item || item.type !== 'SEMI_FINISHED' || !item.isActive) {
      throw new AppError('Cut panels go into stock as an active semi-finished item. Make one in Masters → Items.', 400, 'NOT_SEMI_FINISHED')
    }
  }

  const count = await tx.cuttingOrder.count({ where: { moId } })
  const cutOrderNumber = `${mo.moNumber}-C${count + 1}`
  const created = await tx.cuttingOrder.create({
    data: {
      cutOrderNumber,
      moId,
      cutDate: data.cutDate ?? new Date(),
      fabricItemId: data.fabricItemId,
      fabricIssued: fabric.issued,
      fabricUsed: data.fabricUsed,
      wastage,
      noOfLayers: data.noOfLayers ?? null,
      plannedPieces: mo.totalPlannedQty,
      actualPieces: pieces,
      sizeBreakup: Object.keys(breakup).length ? breakup : undefined,
      status: 'COMPLETED',
      notes: data.notes ?? null,
      panelItemId: panelsIn ? data.panelItemId : null,
      panelWarehouseId: panelsIn ? data.panelWarehouseId : null,
      createdById: userId,
    },
  })
  await tx.manufacturingOrder.update({ where: { id: moId }, data: { totalCutQty: { increment: pieces } } })

  if (panelsIn) {
    // The customer's panels on a job-work order (their fabric), at no value
    // of ours; our own at the value of the fabric that went into them.
    const theirs = !!(mo.so?.isJobWork && fabric.theirs)
    let rate = 0
    if (!theirs) {
      const issues = await tx.stockLedger.findMany({
        where: { referenceType: 'MATERIAL_REQUISITION', itemId: data.fabricItemId, outQty: { gt: 0 }, referenceId: { in: (await tx.materialRequisition.findMany({ where: { moId }, select: { id: true } })).map((m) => m.id) } },
        select: { outQty: true, unitRate: true },
      })
      const qty = issues.reduce((s, r) => s + Number(r.outQty), 0)
      const value = issues.reduce((s, r) => s + Number(r.outQty) * Number(r.unitRate ?? 0), 0)
      rate = qty > 0 && pieces > 0 ? round2(((value / qty) * data.fabricUsed) / pieces) : 0
    }
    const parts = Object.keys(breakup).length ? Object.entries(breakup).map(([sizeId, qty]) => ({ sizeId, qty })) : [{ sizeId: null as string | null, qty: pieces }]
    for (const p of parts) {
      await recordMovement(tx, {
        itemId: data.panelItemId!,
        warehouseId: data.panelWarehouseId!,
        sizeId: p.sizeId,
        ...(theirs ? { ownership: 'CUSTOMER_OWNED' as const, ownerCustomerId: mo.so!.customerId } : {}),
        transactionType: 'PRODUCTION',
        direction: 'IN',
        qty: p.qty,
        unitRate: rate,
        referenceType: 'CUTTING',
        referenceId: created.id,
        transactionDate: created.cutDate,
        notes: `Cut on ${cutOrderNumber}`,
      })
    }
  }
  return created
}

/** Takes a cutting back: its pieces off the order, its panels out of the store. */
export async function cancelCutting(tx: Db, id: string, reason: string) {
  const before = await tx.cuttingOrder.findUnique({ where: { id } })
  if (!before) throw new AppError('Cutting not found', 404, 'NOT_FOUND')
  if (before.status === 'CANCELLED') throw new AppError(`${before.cutOrderNumber} is already cancelled`, 409, 'ALREADY_CANCELLED')
  const ins = await tx.stockLedger.findMany({ where: { referenceType: 'CUTTING', referenceId: id, inQty: { gt: 0 } } })
  for (const row of ins) {
    await recordMovement(tx, {
      itemId: row.itemId,
      warehouseId: row.warehouseId,
      sizeId: row.sizeId,
      grade: row.grade,
      ownership: row.ownership,
      ownerCustomerId: row.ownerCustomerId,
      transactionType: 'ADJUSTMENT',
      direction: 'OUT',
      qty: Number(row.inQty),
      referenceType: 'CUTTING_CANCEL',
      referenceId: id,
      notes: `Cancelled ${before.cutOrderNumber}: ${reason}`,
    })
  }
  await tx.manufacturingOrder.update({ where: { id: before.moId }, data: { totalCutQty: { decrement: before.actualPieces } } })
  return tx.cuttingOrder.update({
    where: { id },
    data: { status: 'CANCELLED', notes: [before.notes, `Cancelled: ${reason}`].filter(Boolean).join(' · ') },
  })
}
