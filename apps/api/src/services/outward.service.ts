import { prisma } from '@ld-erp/database'
import type { StockOwnership } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/*
 * Stock going out, as the stickers see it: what left on which document, from
 * which store, and to whom. One shape for every kind of outward, so the label
 * for what goes out and the fresh sticker for what is left are made the same
 * way whether it was an issue to the floor or a return to the supplier.
 */

export const OUTWARD_TYPES = ['MR', 'JOB_WORK', 'PURCHASE_RETURN', 'CUSTOMER_RETURN', 'TRANSFER'] as const
export type OutwardType = (typeof OUTWARD_TYPES)[number]

/**
 * How each one shows on the stock ledger, and whether its stock leaves us or
 * only moves to another store — a roll sent to the job worker's floor is still
 * a roll, and its sticker goes with it.
 */
export const OUTWARD: Record<OutwardType, { ledger: string; moves: boolean; tag: string }> = {
  MR: { ledger: 'MATERIAL_REQUISITION', moves: false, tag: 'ISSUED' },
  JOB_WORK: { ledger: 'JOB_WORK_CHALLAN', moves: true, tag: 'JOB WORK' },
  PURCHASE_RETURN: { ledger: 'PurchaseReturn', moves: false, tag: 'RETURN' },
  CUSTOMER_RETURN: { ledger: 'CUSTOMER_RETURN', moves: false, tag: 'RETURN' },
  TRANSFER: { ledger: 'STOCK_TRANSFER', moves: true, tag: 'TRANSFER' },
}

export interface OutwardLine {
  key: string
  itemId: string
  itemCode: string
  item: string
  unit: string
  qty: number
  warehouseId: string
  from: string
  ownership: StockOwnership
  ownerCustomerId: string | null
  owner: string | null
}

export interface OutwardDoc {
  type: OutwardType
  id: string
  number: string
  /** Who or where it went: a department, a job worker, a supplier, a customer, a store. */
  to: string
  /** The store it went into, when it only moved. */
  toWarehouseId: string | null
  lines: OutwardLine[]
}

const item = { select: { id: true, code: true, name: true, uom: { select: { symbol: true } } } } as const

/**
 * "line:qty" or "line:qty:store", comma separated: what one issue handed over,
 * when the document has been issued against more than once.
 */
export function parseQ(q: string | undefined | null): Map<string, { qty: number; warehouseId: string | null }> {
  const out = new Map<string, { qty: number; warehouseId: string | null }>()
  for (const part of String(q ?? '').split(',')) {
    const [key, qty, wh] = part.split(':')
    const n = Number(qty)
    if (key && n > 0) {
      const had = out.get(key)
      out.set(key, { qty: (had?.qty ?? 0) + n, warehouseId: wh || had?.warehouseId || null })
    }
  }
  return out
}

/** One outward document, its lines as they left. `q` narrows a requisition to one issue. */
export async function loadOutward(type: OutwardType, id: string, q?: string | null): Promise<OutwardDoc> {
  const given = parseQ(q)
  const notFound = () => new AppError('That document does not exist', 404, 'NOT_FOUND')

  if (type === 'MR') {
    const mr = await prisma.materialRequisition.findUnique({
      where: { id },
      select: {
        mrNumber: true,
        department: { select: { name: true } },
        lines: {
          select: {
            id: true,
            itemId: true,
            issuedQty: true,
            returnedQty: true,
            warehouseId: true,
            ownership: true,
            ownerCustomerId: true,
            item,
            warehouse: { select: { id: true, name: true } },
            ownerCustomer: { select: { name: true } },
          },
        },
      },
    })
    if (!mr) throw notFound()
    const stores = new Map(
      (await prisma.warehouse.findMany({ where: { id: { in: [...given.values()].map((g) => g.warehouseId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map(
        (w) => [w.id, w.name],
      ),
    )
    const lines: OutwardLine[] = []
    for (const l of mr.lines) {
      const g = given.get(l.id)
      const qty = given.size ? (g?.qty ?? 0) : Number(l.issuedQty) - Number(l.returnedQty)
      if (!(qty > 0)) continue
      const wh = g?.warehouseId ?? l.warehouseId
      lines.push({
        key: l.id,
        itemId: l.itemId,
        itemCode: l.item.code,
        item: l.item.name,
        unit: l.item.uom?.symbol ?? '',
        qty,
        warehouseId: wh,
        from: stores.get(wh) ?? l.warehouse.name,
        ownership: l.ownership,
        ownerCustomerId: l.ownerCustomerId,
        owner: l.ownerCustomer?.name ?? null,
      })
    }
    return { type, id, number: mr.mrNumber, to: mr.department.name, toWarehouseId: null, lines }
  }

  if (type === 'JOB_WORK') {
    const c = await prisma.jobWorkChallan.findUnique({
      where: { id },
      select: {
        challanNumber: true,
        process: true,
        jobWorker: { select: { name: true } },
        fromWarehouse: { select: { id: true, name: true } },
        toWarehouseId: true,
        lines: { select: { id: true, itemId: true, qty: true, ownership: true, ownerCustomerId: true, sizeId: true, item, ownerCustomer: { select: { name: true } } } },
      },
    })
    if (!c) throw notFound()
    return {
      type,
      id,
      number: c.challanNumber,
      to: `${c.jobWorker.name} · ${c.process}`,
      toWarehouseId: c.toWarehouseId,
      lines: c.lines
        .filter((l) => !l.sizeId)
        .map((l) => ({
          key: l.id,
          itemId: l.itemId,
          itemCode: l.item.code,
          item: l.item.name,
          unit: l.item.uom?.symbol ?? '',
          qty: Number(l.qty),
          warehouseId: c.fromWarehouse.id,
          from: c.fromWarehouse.name,
          ownership: l.ownership,
          ownerCustomerId: l.ownerCustomerId,
          owner: l.ownerCustomer?.name ?? null,
        })),
    }
  }

  if (type === 'PURCHASE_RETURN') {
    const r = await prisma.purchaseReturn.findUnique({
      where: { id },
      select: {
        returnNumber: true,
        supplier: { select: { name: true } },
        lines: { select: { id: true, itemId: true, qty: true, item, warehouse: { select: { id: true, name: true } } } },
      },
    })
    if (!r) throw notFound()
    return {
      type,
      id,
      number: r.returnNumber,
      to: r.supplier.name,
      toWarehouseId: null,
      lines: r.lines.map((l) => ({
        key: l.id,
        itemId: l.itemId,
        itemCode: l.item.code,
        item: l.item.name,
        unit: l.item.uom?.symbol ?? '',
        qty: Number(l.qty),
        warehouseId: l.warehouse.id,
        from: l.warehouse.name,
        ownership: 'OWNED' as const,
        ownerCustomerId: null,
        owner: null,
      })),
    }
  }

  if (type === 'CUSTOMER_RETURN') {
    const r = await prisma.customerMaterialReturn.findUnique({
      where: { id },
      select: {
        returnNumber: true,
        customerId: true,
        customer: { select: { name: true } },
        warehouse: { select: { id: true, name: true } },
        lines: { select: { id: true, itemId: true, qty: true, item } },
      },
    })
    if (!r) throw notFound()
    return {
      type,
      id,
      number: r.returnNumber,
      to: r.customer.name,
      toWarehouseId: null,
      lines: r.lines.map((l) => ({
        key: l.id,
        itemId: l.itemId,
        itemCode: l.item.code,
        item: l.item.name,
        unit: l.item.uom?.symbol ?? '',
        qty: Number(l.qty),
        warehouseId: r.warehouse.id,
        from: r.warehouse.name,
        ownership: 'CUSTOMER_OWNED' as const,
        ownerCustomerId: r.customerId,
        owner: r.customer.name,
      })),
    }
  }

  const t = await prisma.stockTransfer.findUnique({
    where: { id },
    select: {
      transferNumber: true,
      fromWarehouse: { select: { id: true, name: true } },
      toWarehouse: { select: { id: true, name: true } },
      lines: { select: { id: true, itemId: true, qty: true, ownership: true, ownerCustomerId: true, sizeId: true, item, ownerCustomer: { select: { name: true } } } },
    },
  })
  if (!t) throw notFound()
  return {
    type,
    id,
    number: t.transferNumber,
    to: t.toWarehouse.name,
    toWarehouseId: t.toWarehouse.id,
    lines: t.lines
      .filter((l) => !l.sizeId)
      .map((l) => ({
        key: l.id,
        itemId: l.itemId,
        itemCode: l.item.code,
        item: l.item.name,
        unit: l.item.uom?.symbol ?? '',
        qty: Number(l.qty),
        warehouseId: t.fromWarehouse.id,
        from: t.fromWarehouse.name,
        ownership: l.ownership,
        ownerCustomerId: l.ownerCustomerId,
        owner: l.ownerCustomer?.name ?? null,
      })),
  }
}
