import type { MOStatus, Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { netSizeChanges } from './sizeChanges.service'

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
 * Lines planned before their style had an approved BOM take the one approved
 * since. A line keeps the BOM it was given; only a line with none looks
 * again, so an order made a minute before its BOM was approved still gets
 * its materials worked out. One order, or every open one when no id is given.
 * Returns how many lines were linked.
 */
export async function attachLateBoms(db: Db, moId?: string) {
  const lines = await db.mOLine.findMany({
    where: { bomId: null, mo: { ...(moId ? { id: moId } : {}), status: { notIn: ['COMPLETED', 'CLOSED'] } } },
    select: { id: true, styleId: true, color: true },
  })
  let linked = 0
  for (const l of lines) {
    const bom = await findBom(db, l.styleId, l.color || null)
    if (!bom) continue
    await db.mOLine.update({ where: { id: l.id }, data: { bomId: bom.id } })
    linked++
  }
  return linked
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
      id: true,
      soLineId: true,
      totalQty: true,
      sizes: { select: { sizeId: true, qty: true } },
      moId: true,
      mo: { select: { status: true, closedAt: true } },
      soLine: { select: { itemId: true } },
    },
  })
  // An order completed short (597 of 600) holds only what it packed: the
  // pieces it never made are free to plan again. Size by size it holds what
  // it packed, up to each size as made: its plan moved by any size jumps at
  // stitching (cut as M, made as L), so an L made in place of an M counts
  // as an L.
  const shortIds = [...new Set(plannedRows.filter((p) => p.mo.status === 'COMPLETED' && p.mo.closedAt).map((p) => p.moId))]
  const jumpsOf = new Map(await Promise.all(shortIds.map(async (moId) => [moId, await netSizeChanges(db, { moId })] as const)))
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
          // Sizes changed at stitching on an order completed short: only the line's total is still to make.
          jumped: p.sizes.some((z) => (jumpsOf.get(p.moId)?.(p.id, z.sizeId) ?? 0) !== 0),
          totalQty: Math.min(p.totalQty, packedOf(p.moId, p.soLine.itemId, null)),
          sizes: p.sizes.map((z) => {
            const revised = Math.max(0, z.qty + (jumpsOf.get(p.moId)?.(p.id, z.sizeId) ?? 0))
            return { sizeId: z.sizeId, qty: Math.min(revised, packedOf(p.moId, p.soLine!.itemId, z.sizeId)) }
          }),
        }
      : { soLineId: p.soLineId, jumped: false, totalQty: p.totalQty, sizes: p.sizes },
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
      const remaining = Math.max(0, ordered - plannedTotal)
      // What each size has left, in the order's size run, never more in all
      // than the line has left: after a size jump one size can be made over
      // its order and another under, and only the line's total is still to
      // make (ordered M 200 / L 150, packed M 175 / L 170 on an order
      // completed short: 5 left, all M — not 25 M).
      let left = mine.some((p) => p.jumped) ? remaining : Number.POSITIVE_INFINITY
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
        remaining,
        sizes: l.sizes.map((s) => {
          const was = plannedBySize.get(s.sizeId) ?? 0
          const own = Math.min(Math.max(0, Number(s.qty) - was), left)
          left -= own
          return { sizeId: s.sizeId, code: s.size.code, ordered: Number(s.qty), planned: was, remaining: own }
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
 * in. A material that differs by size counts each size as now made, after
 * any size jumps at stitching; cloth, cut before, counts the sizes planned.
 * Grouped by material, by whose it is — a customer-supplied line draws on
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
  const jumped = await netSizeChanges(db, { moId })
  const mo = await db.manufacturingOrder.findUnique({
    where: { id: moId },
    select: {
      id: true,
      moNumber: true,
      status: true,
      so: { select: { id: true, soNumber: true, customerId: true, isJobWork: true, customer: { select: { name: true } } } },
      steps: { select: { departmentId: true, sequence: true, sizeChanges: { where: { undoneAt: null }, select: { id: true }, take: 1 } } },
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
  // Where sizes first changed on this order's route, and where each department first works on it:
  // what a department uses before that step was used in the sizes as cut.
  const jumpAt = Math.min(Infinity, ...mo.steps.filter((s) => s.sizeChanges.length).map((s) => s.sequence))
  const firstStepOf = new Map<string, number>()
  for (const s of mo.steps) firstStepOf.set(s.departmentId, Math.min(firstStepOf.get(s.departmentId) ?? Infinity, s.sequence))

  // What this customer has sent us before: on a job-work order, theirs to use.
  const supplied = new Set<string>(
    mo.so?.isJobWork
      ? (
          await db.customerGRNLine.findMany({
            where: { grn: { customerId: mo.so.customerId, status: 'POSTED' } },
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
    // Each size as it is now made: the plan moved by size jumps at stitching
    // (20 cut as M made as L: M 180, L 170). The line's total is the same.
    const revised = line.sizes.map((sz) => ({ sizeId: sz.sizeId, qty: Math.max(0, sz.qty + jumped(line.id, sz.sizeId)) }))
    for (const b of line.bom.lines) {
      const cat = b.componentItem.category
      const isFabric = /fabric/i.test(cat?.name ?? '') || /fabric/i.test(cat?.parent?.name ?? '')
      const bySize = new Map(b.sizes.map((s) => [s.sizeId, Number(s.effectiveQty)]))
      // A material that differs by size (a size label) follows the sizes as
      // made, so the labels for a size jumped into can be asked for. Cloth,
      // and whatever Cutting draws, was used before any size changed, in the
      // sizes planned, so it stays on the plan. A material the same for every
      // size comes to the same total either way.
      const cutBefore = isFabric || /cutting/i.test(b.department?.name ?? '') || (!!b.department && (firstStepOf.get(b.department.id) ?? Infinity) < jumpAt)
      const counts = b.sizes.length && !cutBefore ? revised : line.sizes
      const required = line.sizes.length
        ? counts.reduce((s, sz) => s + sz.qty * (bySize.get(sz.sizeId) ?? Number(b.effectiveQty)), 0)
        : line.totalQty * Number(b.effectiveQty)
      const baseKey = `${b.componentItem.id}|${b.department?.id ?? ''}`
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

/**
 * Where a manufacturing order stands, in the words its list and its window
 * show. Its own status says draft, released, completed or closed, and
 * "released" covers everything from asking the store for materials to the
 * last pieces being packed. The stage splits that the way the work goes, the
 * same steps as the order's window:
 *
 *   materials not asked for → asked, the store yet to issue → part issued →
 *   every material issued in full → in production (cutting recorded) →
 *   packing (pieces booked into finished goods) → completed.
 *
 * One more, off the road: its sales order is short-closed or cancelled and
 * nothing was made on it (ORDER_CLOSED), so it is only waiting to be closed.
 *
 * Worked out from what has been done, never stored, so it cannot go stale.
 */
export const MO_STAGES = ['DRAFT', 'NOT_ASKED', 'ASKED', 'PART_ISSUED', 'ISSUED', 'IN_PRODUCTION', 'PACKING', 'ORDER_CLOSED', 'COMPLETED', 'CLOSED'] as const
export type MoStage = (typeof MO_STAGES)[number]

/** Released and not finished. */
const ON_FLOOR: MOStatus[] = ['RELEASED', 'CUTTING', 'STITCHING', 'FINISHING', 'QC', 'PACKING']

/** A requisition still asking: not rejected, and not closed with nothing issued. */
const askingMr: Prisma.MaterialRequisitionWhereInput = {
  status: { not: 'REJECTED' },
  OR: [{ closedAt: null }, { lines: { some: { issuedQty: { gt: 0 } } } }],
}
/** A requisition the store has issued something against. */
const issuedMr: Prisma.MaterialRequisitionWhereInput = { lines: { some: { issuedQty: { gt: 0 } } } }
const liveCutting: Prisma.CuttingOrderWhereInput = { status: { not: 'CANCELLED' } }

/** On the floor with nothing cut or packed: still at its materials. */
const atMaterials: Prisma.ManufacturingOrderWhereInput = {
  status: { in: ON_FLOOR },
  totalPackedQty: { lte: 0 },
  totalCutQty: { lte: 0 },
  cuttingOrders: { none: liveCutting },
}

/** Sales orders that are over: nothing more is made for them. */
const CLOSED_ORDER = ['COMPLETED', 'CANCELLED']
const soClosed: Prisma.ManufacturingOrderWhereInput = { so: { status: { in: ['COMPLETED', 'CANCELLED'] } } }
const soOpen: Prisma.ManufacturingOrderWhereInput = { OR: [{ soId: null }, { so: { status: { notIn: ['COMPLETED', 'CANCELLED'] } } }] }

/**
 * Which of these manufacturing orders work has started on, and what: material
 * issued to it, cutting recorded, or pieces packed, the first found, in a few
 * words. One with none of these has made nothing, and closes with its sales
 * order when that is cancelled or short-closed.
 */
export async function workStarted(db: Db, moIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!moIds.length) return out
  const [made, cut, issued] = await Promise.all([
    db.manufacturingOrder.findMany({
      where: { id: { in: moIds }, OR: [{ totalPackedQty: { gt: 0 } }, { totalCutQty: { gt: 0 } }, { fgReceipts: { some: { cancelledAt: null } } }] },
      select: { id: true, totalPackedQty: true },
    }),
    db.cuttingOrder.findMany({ where: { moId: { in: moIds }, ...liveCutting }, select: { moId: true, cutOrderNumber: true } }),
    db.materialRequisition.findMany({ where: { moId: { in: moIds }, ...issuedMr }, select: { moId: true, mrNumber: true } }),
  ])
  for (const m of made) out.set(m.id, m.totalPackedQty > 0 ? 'pieces packed' : 'pieces cut')
  for (const c of cut) if (!out.has(c.moId)) out.set(c.moId, `cutting on ${c.cutOrderNumber}`)
  for (const r of issued) if (r.moId && !out.has(r.moId)) out.set(r.moId, `material issued on ${r.mrNumber}`)
  return out
}

/**
 * How many of the materials its BOM asks for are issued in full, by the rule
 * the window's Materials step ticks by: issued, less returned, at least what
 * is required.
 */
async function materialsInFull(db: Db, moId: string) {
  const { rows } = await materialPlan(db, moId)
  const needed = rows.filter((r) => r.required > 0)
  const inFull = needed.filter((r) => r.issued >= r.required - 0.0005).length
  return { items: needed.length, inFull, all: needed.length > 0 && inFull >= needed.length }
}

/** `fn` over `list` a few at a time, so a long list does not take every connection at once. */
async function fewAtATime<T, R>(list: T[], fn: (t: T) => Promise<R>, size = 8): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < list.length; i += size) out.push(...(await Promise.all(list.slice(i, i + size).map(fn))))
  return out
}

export interface MoStageOf {
  stage: MoStage
  /** Part issued or issued: the materials its BOM asks for, and how many are issued in full. */
  materialItems?: number
  materialItemsInFull?: number
}

/** The stage of each of these orders, by id. `soStatus`: its sales order's, when it has one. */
export async function moStages(
  db: Db,
  mos: Array<{ id: string; status: MOStatus; totalCutQty: number; totalPackedQty: number; soStatus?: string | null }>,
): Promise<Map<string, MoStageOf>> {
  const out = new Map<string, MoStageOf>()
  const open: typeof mos = []
  for (const mo of mos) {
    if (mo.status === 'COMPLETED' || mo.status === 'CLOSED') out.set(mo.id, { stage: mo.status })
    else if (mo.status === 'DRAFT') out.set(mo.id, { stage: mo.soStatus && CLOSED_ORDER.includes(mo.soStatus) ? 'ORDER_CLOSED' : 'DRAFT' })
    else if (mo.totalPackedQty > 0) out.set(mo.id, { stage: 'PACKING' })
    else open.push(mo)
  }
  if (!open.length) return out
  const ids = open.map((m) => m.id)
  const [cutOn, askedOn, issuedOn] = await Promise.all([
    db.cuttingOrder.findMany({ where: { moId: { in: ids }, ...liveCutting }, select: { moId: true }, distinct: ['moId'] }),
    db.materialRequisition.findMany({ where: { moId: { in: ids }, ...askingMr }, select: { moId: true }, distinct: ['moId'] }),
    db.materialRequisition.findMany({ where: { moId: { in: ids }, ...issuedMr }, select: { moId: true }, distinct: ['moId'] }),
  ])
  const cut = new Set(cutOn.map((c) => c.moId))
  const asked = new Set(askedOn.map((m) => m.moId))
  const issued = new Set(issuedOn.map((m) => m.moId))
  const toCount: string[] = []
  for (const mo of open) {
    if (mo.totalCutQty > 0 || cut.has(mo.id)) out.set(mo.id, { stage: 'IN_PRODUCTION' })
    else if (issued.has(mo.id)) toCount.push(mo.id)
    // Nothing made on it, and its sales order is over: only waiting to be closed.
    else if (mo.soStatus && CLOSED_ORDER.includes(mo.soStatus)) out.set(mo.id, { stage: 'ORDER_CLOSED' })
    else out.set(mo.id, { stage: asked.has(mo.id) ? 'ASKED' : 'NOT_ASKED' })
  }
  const counted = await fewAtATime(toCount, (id) => materialsInFull(db, id))
  toCount.forEach((id, i) => {
    const c = counted[i]
    out.set(id, { stage: c.all ? 'ISSUED' : 'PART_ISSUED', materialItems: c.items, materialItemsInFull: c.inFull })
  })
  return out
}

/**
 * The orders at a stage, for the list's Status filter. Part issued and issued
 * differ only by what the BOM asks for, so those are counted order by order
 * among the ones with something issued; `within` (search, brand, sales
 * order) narrows them first.
 */
export async function stageWhere(db: Db, stage: MoStage, within: Prisma.ManufacturingOrderWhereInput = {}): Promise<Prisma.ManufacturingOrderWhereInput> {
  switch (stage) {
    case 'DRAFT':
      return { AND: [{ status: 'DRAFT' }, soOpen] }
    case 'COMPLETED':
    case 'CLOSED':
      return { status: stage }
    case 'ORDER_CLOSED':
      return {
        AND: [
          soClosed,
          { OR: [{ status: 'DRAFT' }, { AND: [atMaterials, { materialRequisitions: { none: issuedMr } }] }] },
        ],
      }
    case 'PACKING':
      return { status: { in: ON_FLOOR }, totalPackedQty: { gt: 0 } }
    case 'IN_PRODUCTION':
      return { status: { in: ON_FLOOR }, totalPackedQty: { lte: 0 }, OR: [{ totalCutQty: { gt: 0 } }, { cuttingOrders: { some: liveCutting } }] }
    case 'NOT_ASKED':
      return { AND: [atMaterials, soOpen, { materialRequisitions: { none: askingMr } }] }
    case 'ASKED':
      return { AND: [atMaterials, soOpen, { materialRequisitions: { some: askingMr, none: issuedMr } }] }
    case 'PART_ISSUED':
    case 'ISSUED': {
      const some = await db.manufacturingOrder.findMany({
        where: { AND: [within, atMaterials, { materialRequisitions: { some: issuedMr } }] },
        select: { id: true },
      })
      const counted = await fewAtATime(some, (m) => materialsInFull(db, m.id))
      return { id: { in: some.filter((_, i) => counted[i].all === (stage === 'ISSUED')).map((m) => m.id) } }
    }
  }
}
