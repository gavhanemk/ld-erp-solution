import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

type Db = PrismaClient | Prisma.TransactionClient

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** Orders still being made: the ones production plans against. */
export const PLANNABLE_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] as const

/**
 * The approved BOM for a style in one colour: that colour's own, else the
 * style's colourless one, the most recently approved first. Null when the
 * style has none approved — the order can still be planned, but its
 * materials cannot be worked out.
 */
export async function findBom(db: Db, styleId: string, color: string | null) {
  const boms = await db.bOM.findMany({
    where: { styleId, status: 'APPROVED', isActive: true },
    select: { id: true, version: true, color: true, approvedAt: true },
    orderBy: [{ approvedAt: 'desc' }, { createdAt: 'desc' }],
  })
  const wanted = color?.trim().toLowerCase()
  return (wanted ? boms.find((b) => b.color?.trim().toLowerCase() === wanted) : undefined) ?? boms.find((b) => !b.color?.trim()) ?? null
}

/**
 * A sales order as production plans it: each line's style (the item's own,
 * else the style number typed on the line, when it is a style in the master),
 * its colour, the approved BOM, and per size what was ordered, what is
 * already planned on manufacturing orders that are not closed, and what is
 * left to plan.
 */
export async function orderForPlanning(db: Db, soId: string, exceptMoId?: string) {
  const so = await db.salesOrder.findUnique({
    where: { id: soId },
    select: {
      id: true,
      soNumber: true,
      status: true,
      isJobWork: true,
      orderDate: true,
      deliveryDate: true,
      brandId: true,
      customerId: true,
      customer: { select: { id: true, name: true } },
      brand: { select: { id: true, name: true } },
      lines: {
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          styleCode: true,
          color: true,
          totalQty: true,
          item: {
            select: { id: true, code: true, name: true, color: true, style: { select: { id: true, code: true, name: true } } },
          },
          sizes: { select: { sizeId: true, qty: true, size: { select: { code: true, sequence: true } } }, orderBy: { size: { sequence: 'asc' } } },
        },
      },
    },
  })
  if (!so) throw new AppError('Sales order not found', 404, 'NOT_FOUND')

  const typed = [...new Set(so.lines.filter((l) => !l.item.style && l.styleCode?.trim()).map((l) => l.styleCode!.trim()))]
  const typedStyles = typed.length
    ? await db.style.findMany({ where: { code: { in: typed, mode: 'insensitive' } }, select: { id: true, code: true, name: true } })
    : []
  const styleByCode = new Map(typedStyles.map((s) => [s.code.toLowerCase(), s]))

  const plannedRows = await db.mOLine.findMany({
    where: {
      soLineId: { in: so.lines.map((l) => l.id) },
      mo: { status: { not: 'CLOSED' }, ...(exceptMoId ? { id: { not: exceptMoId } } : {}) },
    },
    select: {
      soLineId: true,
      totalQty: true,
      sizes: { select: { sizeId: true, qty: true } },
      moId: true,
      mo: { select: { status: true, closedAt: true } },
      soLine: { select: { itemId: true } },
    },
  })
  // An order completed short (597 of 600) holds only what it packed: the
  // pieces it never made are free to plan again.
  const shortIds = [...new Set(plannedRows.filter((p) => p.mo.status === 'COMPLETED' && p.mo.closedAt).map((p) => p.moId))]
  const packedRows = shortIds.length
    ? await db.finishedGoodsReceiptLine.findMany({
        where: { receipt: { moId: { in: shortIds }, cancelledAt: null } },
        select: { qty: true, itemId: true, sizeId: true, receipt: { select: { moId: true } } },
      })
    : []
  const packedOf = (moId: string, itemId: string, sizeId: string | null) =>
    Math.round(
      packedRows
        .filter((r) => r.receipt.moId === moId && r.itemId === itemId && (sizeId === null || r.sizeId === sizeId))
        .reduce((t, r) => t + Number(r.qty), 0),
    )
  const planned = plannedRows.map((p) =>
    shortIds.includes(p.moId) && p.soLine
      ? {
          soLineId: p.soLineId,
          totalQty: Math.min(p.totalQty, packedOf(p.moId, p.soLine.itemId, null)),
          sizes: p.sizes.map((z) => ({ sizeId: z.sizeId, qty: Math.min(z.qty, packedOf(p.moId, p.soLine!.itemId, z.sizeId)) })),
        }
      : { soLineId: p.soLineId, totalQty: p.totalQty, sizes: p.sizes },
  )

  const lines = await Promise.all(
    so.lines.map(async (l) => {
      const style = l.item.style ?? (l.styleCode ? styleByCode.get(l.styleCode.trim().toLowerCase()) ?? null : null)
      const color = l.item.color ?? l.color ?? null
      const bom = style ? await findBom(db, style.id, color) : null
      const mine = planned.filter((p) => p.soLineId === l.id)
      const plannedBySize = new Map<string, number>()
      for (const p of mine) for (const s of p.sizes) plannedBySize.set(s.sizeId, (plannedBySize.get(s.sizeId) ?? 0) + s.qty)
      const plannedTotal = mine.reduce((s, p) => s + p.totalQty, 0)
      const ordered = Number(l.totalQty)
      return {
        soLineId: l.id,
        item: { id: l.item.id, code: l.item.code, name: l.item.name },
        style,
        color,
        bom,
        problem: !style
          ? `${l.item.code} is not linked to a style. Link it in Masters → Items, or type its style no. on the order.`
          : !bom
            ? `${style.code}${color ? ` ${color}` : ''} has no approved BOM, so its materials cannot be worked out.`
            : null,
        ordered,
        planned: plannedTotal,
        remaining: Math.max(0, ordered - plannedTotal),
        sizes: l.sizes.map((s) => {
          const was = plannedBySize.get(s.sizeId) ?? 0
          return { sizeId: s.sizeId, code: s.size.code, ordered: Number(s.qty), planned: was, remaining: Math.max(0, Number(s.qty) - was) }
        }),
      }
    }),
  )
  return { so, lines }
}

/**
 * What a manufacturing order needs, from the BOM of each of its lines.
 *
 * For every BOM line: the pieces of each size times that size's quantity per
 * piece (the line's own where the BOM gives none by size), wastage already
 * in. Grouped by material, by whose it is — a customer-supplied line draws on
 * the customer's own stock — and by the department the BOM gives it to, which
 * is who asks the store for it. Beside each: what is in stock, store by
 * store, what this order has already asked for, and what has been issued.
 *
 * Whose it is: on a job-work order the customer sends the cloth, so a
 * material is the customer's when the BOM says so, when this customer has
 * sent us that material before (a customer GRN), or when it is fabric (filed
 * under a Fabric category). Thread, interlining, trims and packing are ours
 * unless the customer sent them. `swap` turns a row the other way — the
 * plan's "ours / customer's" switch — keyed by item and department.
 */
export async function materialPlan(db: Db, moId: string, opts: { swap?: Set<string> } = {}) {
  const mo = await db.manufacturingOrder.findUnique({
    where: { id: moId },
    select: {
      id: true,
      moNumber: true,
      status: true,
      so: { select: { id: true, soNumber: true, customerId: true, isJobWork: true, customer: { select: { name: true } } } },
      lines: {
        select: {
          id: true,
          color: true,
          totalQty: true,
          style: { select: { code: true } },
          sizes: { select: { sizeId: true, qty: true } },
          bom: {
            select: {
              id: true,
              version: true,
              color: true,
              lines: {
                orderBy: { sortOrder: 'asc' },
                select: {
                  effectiveQty: true,
                  customerSupplied: true,
                  department: { select: { id: true, name: true } },
                  componentItem: {
                    select: {
                      id: true,
                      code: true,
                      name: true,
                      type: true,
                      uom: { select: { symbol: true } },
                      category: { select: { name: true, parent: { select: { name: true } } } },
                    },
                  },
                  sizes: { select: { sizeId: true, effectiveQty: true } },
                },
              },
            },
          },
        },
      },
    },
  })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')

  // What this customer has sent us before: on a job-work order, theirs to use.
  const supplied = new Set<string>(
    mo.so?.isJobWork
      ? (
          await db.customerGRNLine.findMany({
            where: { grn: { customerId: mo.so.customerId, cancelledAt: null } },
            select: { itemId: true },
            distinct: ['itemId'],
          })
        ).map((l) => l.itemId)
      : [],
  )

  type Row = {
    key: string
    /** Item and department: what the "ours / customer's" switch is keyed by. */
    baseKey: string
    /** Whose the plan would say without the switch. */
    defaultOwnership: 'OWNED' | 'CUSTOMER_OWNED'
    item: { id: string; code: string; name: string; type: string; uom: string | null; category: string }
    ownership: 'OWNED' | 'CUSTOMER_OWNED'
    ownerCustomerId: string | null
    department: { id: string; name: string } | null
    styles: Set<string>
    required: number
  }
  const rows = new Map<string, Row>()
  const missing: Array<{ style: string; color: string; pieces: number }> = []

  for (const line of mo.lines) {
    if (!line.bom) {
      missing.push({ style: line.style.code, color: line.color, pieces: line.totalQty })
      continue
    }
    for (const b of line.bom.lines) {
      const bySize = new Map(b.sizes.map((s) => [s.sizeId, Number(s.effectiveQty)]))
      const required = line.sizes.length
        ? line.sizes.reduce((s, sz) => s + sz.qty * (bySize.get(sz.sizeId) ?? Number(b.effectiveQty)), 0)
        : line.totalQty * Number(b.effectiveQty)
      const baseKey = `${b.componentItem.id}|${b.department?.id ?? ''}`
      const cat = b.componentItem.category
      const isFabric = /fabric/i.test(cat?.name ?? '') || /fabric/i.test(cat?.parent?.name ?? '')
      const byDefault = !!mo.so && (b.customerSupplied || (mo.so.isJobWork && (supplied.has(b.componentItem.id) || isFabric)))
      const theirs = !!mo.so && (opts.swap?.has(baseKey) ? !byDefault : byDefault)
      const ownership = theirs ? 'CUSTOMER_OWNED' : 'OWNED'
      const ownerCustomerId = theirs ? mo.so!.customerId : null
      const key = `${b.componentItem.id}|${ownership}|${ownerCustomerId ?? ''}|${b.department?.id ?? ''}`
      const row = rows.get(key) ?? {
        key,
        baseKey,
        defaultOwnership: (byDefault ? 'CUSTOMER_OWNED' : 'OWNED') as Row['defaultOwnership'],
        item: {
          id: b.componentItem.id,
          code: b.componentItem.code,
          name: b.componentItem.name,
          type: b.componentItem.type,
          uom: b.componentItem.uom?.symbol ?? null,
          category: [cat?.parent?.name, cat?.name].filter(Boolean).join(' › '),
        },
        ownership,
        ownerCustomerId,
        department: b.department,
        styles: new Set<string>(),
        required: 0,
      }
      row.required += required
      row.styles.add(line.style.code)
      rows.set(key, row)
    }
  }

  const itemIds = [...new Set([...rows.values()].map((r) => r.item.id))]
  const [stock, warehouses, asked] = await Promise.all([
    itemIds.length
      ? db.stockLedger.groupBy({
          by: ['itemId', 'warehouseId', 'ownership', 'ownerCustomerId'],
          // Goods a quality check rejected are held apart, not in stock to ask for.
          where: { itemId: { in: itemIds }, grade: { not: 'R' } },
          _sum: { inQty: true, outQty: true },
        })
      : Promise.resolve([]),
    db.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    db.materialRequisitionLine.findMany({
      where: { mr: { moId: mo.id, status: { not: 'REJECTED' } } },
      select: {
        itemId: true,
        ownership: true,
        ownerCustomerId: true,
        requestedQty: true,
        issuedQty: true,
        returnedQty: true,
        mr: { select: { departmentId: true, closedAt: true } },
      },
    }),
  ])
  const storeName = new Map(warehouses.map((w) => [w.id, w.name]))

  // Rows of the same material and owner: a requisition counts against its own
  // department's row, but where the material has one row only it counts
  // whichever department asked, so changing the department on the plan never
  // makes the same cloth look un-asked-for.
  const rowsOf = new Map<string, number>()
  for (const r of rows.values()) {
    const k = `${r.item.id}|${r.ownership}|${r.ownerCustomerId ?? ''}`
    rowsOf.set(k, (rowsOf.get(k) ?? 0) + 1)
  }

  const data = [...rows.values()].map((r) => {
    const stores = stock
      .filter((s) => s.itemId === r.item.id && s.ownership === r.ownership && (s.ownerCustomerId ?? null) === r.ownerCustomerId)
      .map((s) => ({ id: s.warehouseId, name: storeName.get(s.warehouseId) ?? 'Store', qty: round3(Number(s._sum.inQty ?? 0) - Number(s._sum.outQty ?? 0)) }))
      .filter((s) => s.qty > 0 && storeName.has(s.id))
      .sort((a, b) => b.qty - a.qty)
    const inStock = round3(stores.reduce((s, x) => s + x.qty, 0))
    const single = rowsOf.get(`${r.item.id}|${r.ownership}|${r.ownerCustomerId ?? ''}`) === 1
    const mine = asked.filter(
      (a) =>
        a.itemId === r.item.id &&
        a.ownership === r.ownership &&
        (a.ownerCustomerId ?? null) === r.ownerCustomerId &&
        (single || a.mr.departmentId === (r.department?.id ?? null)),
    )
    // A requisition closed part issued counts at what was issued; an open one at what was asked.
    const requested = round3(mine.reduce((s, a) => s + Number(a.mr.closedAt ? a.issuedQty : a.requestedQty), 0))
    // Issued less what came back from the floor unused.
    const issued = round3(mine.reduce((s, a) => s + Number(a.issuedQty) - Number(a.returnedQty), 0))
    const required = round3(r.required)
    const toRequest = round3(Math.max(0, required - requested))
    return {
      key: r.key,
      baseKey: r.baseKey,
      defaultOwnership: r.defaultOwnership,
      issued,
      item: r.item,
      ownership: r.ownership,
      ownerCustomerId: r.ownerCustomerId,
      department: r.department,
      styles: [...r.styles],
      required,
      inStock,
      requested,
      toRequest,
      short: round3(Math.max(0, toRequest - inStock)),
      stores,
      defaultStoreId: stores[0]?.id ?? warehouses[0]?.id ?? null,
    }
  })

  return { mo: { id: mo.id, moNumber: mo.moNumber, status: mo.status, so: mo.so }, rows: data, missing, warehouses }
}

/**
 * Packed pieces on a manufacturing order are the finished goods booked in
 * against it, not a figure anybody types. Fully packed, it is completed; a
 * receipt cancelled after that reopens it.
 */
export async function syncMoPacked(tx: Prisma.TransactionClient, moId: string) {
  const mo = await tx.manufacturingOrder.findUniqueOrThrow({ where: { id: moId }, select: { status: true, totalPlannedQty: true, closedAt: true } })
  const agg = await tx.finishedGoodsReceiptLine.aggregate({
    where: { receipt: { moId, cancelledAt: null } },
    _sum: { qty: true },
  })
  const packed = Math.round(Number(agg._sum.qty ?? 0))
  const done = mo.totalPlannedQty > 0 && packed >= mo.totalPlannedQty
  // Completed short on purpose stays completed, whatever is packed later.
  const status =
    mo.status === 'CLOSED' || mo.status === 'DRAFT' || (mo.status === 'COMPLETED' && mo.closedAt)
      ? mo.status
      : done
        ? 'COMPLETED'
        : mo.status === 'COMPLETED'
          ? 'RELEASED'
          : mo.status
  await tx.manufacturingOrder.update({
    where: { id: moId },
    data: {
      totalPackedQty: packed,
      status,
      actualEndDate: status === 'COMPLETED' ? (mo.status === 'COMPLETED' ? undefined : new Date()) : null,
    },
  })
}
