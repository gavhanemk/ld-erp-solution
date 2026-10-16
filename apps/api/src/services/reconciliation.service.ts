import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * Closing an order with everything accounted for.
 *
 * For the customer's material on a job-work order, item by item, counting only
 * what the documents tie to THIS order — a receipt against it, a requisition
 * for it or its manufacturing order, a return or job-work challan against it:
 *
 *   received on its posted customer GRNs   (usable, and held as rejected)
 *   − issued to its production, less what came back from the floor
 *   − sent back to the customer against it
 *   − used up at job workers on its challans
 *   = left for this order: still with us, in a store or at a job worker
 *
 * and, of what was issued, how much its cutting used and wasted, against what
 * the BOM allows for the pieces cut.
 *
 * Receipts with no order stay unassigned: they are never counted as any
 * order's, so two orders of one customer never both claim the same roll.
 * Beside the order, the customer's whole stock of the item — usable and held,
 * all orders and unassigned receipts — so a gap can be seen for what it is:
 * this order's receipts say more should be here than the customer has with
 * us at all, which only another order or a correction can explain.
 *
 * Then our own material that went into the order (trims, thread), at what it
 * cost us: the job charge covers it or it is billed, as the order says, but it
 * is never lost at the ₹0 the customer's finished goods carry.
 *
 * For the pieces: ordered, cut, packed good and B-grade, damaged at job
 * workers, sent. A gap is shown as a gap. The customer's material not all
 * accounted for stops the order being closed — `closeCheck` — unless a
 * manager records an exception.
 */
type Db = Prisma.TransactionClient

const round3 = (n: number) => Math.round(n * 1000) / 1000
const round2 = (n: number) => Math.round(n * 100) / 100

export async function orderReconciliation(db: Db, soId: string) {
  const so = await db.salesOrder.findUnique({
    where: { id: soId },
    select: {
      id: true,
      soNumber: true,
      status: true,
      isJobWork: true,
      ownMaterialBilling: true,
      customerId: true,
      customer: { select: { name: true } },
      lines: { select: { totalQty: true, deliveredQty: true } },
    },
  })
  if (!so) throw new AppError('Sales order not found', 404, 'NOT_FOUND')

  // Its requisitions: raised for it, or for one of its manufacturing orders.
  const forOrder = { OR: [{ soId }, { mo: { soId } }] }
  const itemSelect = { select: { code: true, name: true, uom: { select: { symbol: true } } } }

  const [grnLines, issueLines, cmrLines, cuttings, fgLines, damaged, openOrders, jwChallans, moLines, ownLines, mrs, ownBilled] = await Promise.all([
    db.customerGRNLine.findMany({
      where: { grn: { soId, status: 'POSTED' } },
      select: { itemId: true, challanQty: true, receivedQty: true, rejectedQty: true, releasedQty: true, item: itemSelect },
    }),
    db.materialRequisitionLine.findMany({
      where: { mr: forOrder, ownership: 'CUSTOMER_OWNED', ownerCustomerId: so.customerId },
      select: { itemId: true, issuedQty: true, returnedQty: true, item: itemSelect },
    }),
    db.customerMaterialReturnLine.findMany({
      where: { return: { cancelledAt: null, OR: [{ soId }, { grn: { soId } }] } },
      select: { itemId: true, qty: true, return: { select: { reason: true } } },
    }),
    db.cuttingOrder.findMany({
      where: { mo: { soId }, status: { not: 'CANCELLED' } },
      select: { fabricItemId: true, fabricUsed: true, wastage: true, actualPieces: true, sizeBreakup: true, moLineId: true, moId: true },
    }),
    db.finishedGoodsReceiptLine.findMany({ where: { receipt: { soId, cancelledAt: null } }, select: { qty: true, grade: true } }),
    db.jobWorkReturnLine.findMany({ where: { jobWorkReturn: { challan: { soId }, cancelledAt: null } }, select: { damagedQty: true } }),
    db.salesOrder.count({ where: { customerId: so.customerId, isJobWork: true, status: { notIn: ['COMPLETED', 'CANCELLED', 'DRAFT'] }, id: { not: soId } } }),
    db.jobWorkChallan.findMany({ where: { soId, cancelledAt: null }, select: { id: true } }),
    db.mOLine.findMany({
      where: { mo: { soId } },
      select: { id: true, moId: true, totalQty: true, bomId: true, sizes: { select: { sizeId: true, qty: true } } },
    }),
    // Our own material on its requisitions.
    db.materialRequisitionLine.findMany({
      where: { mr: forOrder, ownership: 'OWNED', issuedQty: { gt: 0 } },
      select: { itemId: true, issuedQty: true, returnedQty: true, item: itemSelect },
    }),
    db.materialRequisition.findMany({ where: forOrder, select: { id: true } }),
    // What of our own material its invoices have billed, as charges marked for it.
    db.salesInvoiceCharge.aggregate({ where: { ownMaterial: true, invoice: { soId, status: { not: 'CANCELLED' } } }, _sum: { amount: true } }),
  ])

  const itemIds = [...new Set([...grnLines.map((l) => l.itemId), ...issueLines.map((l) => l.itemId)])]

  // The customer's material used up at job workers on this order's challans:
  // the "used at the job worker" leg of a job-work receipt.
  const jwUsed = itemIds.length && jwChallans.length
    ? await db.stockLedger.groupBy({
        by: ['itemId'],
        where: {
          itemId: { in: itemIds },
          ownership: 'CUSTOMER_OWNED',
          ownerCustomerId: so.customerId,
          referenceType: 'JOB_WORK_RETURN',
          outQty: { gt: 0 },
          referenceId: { in: (await db.jobWorkReturn.findMany({ where: { challanId: { in: jwChallans.map((c) => c.id) }, cancelledAt: null }, select: { id: true } })).map((r) => r.id) },
        },
        _sum: { outQty: true },
      })
    : []

  // The customer's whole stock of these items with us, usable and held, and
  // what came in for them on receipts with no order or for other orders.
  const [pool, unassigned, otherOrders] = itemIds.length
    ? await Promise.all([
        db.stockLedger.groupBy({
          by: ['itemId', 'grade'],
          where: { itemId: { in: itemIds }, ownership: 'CUSTOMER_OWNED', ownerCustomerId: so.customerId },
          _sum: { inQty: true, outQty: true },
        }),
        db.customerGRNLine.groupBy({
          by: ['itemId'],
          where: { itemId: { in: itemIds }, grn: { customerId: so.customerId, status: 'POSTED', soId: null } },
          _sum: { receivedQty: true },
        }),
        db.customerGRNLine.groupBy({
          by: ['itemId'],
          where: { itemId: { in: itemIds }, grn: { customerId: so.customerId, status: 'POSTED', soId: { not: null, notIn: [soId] } } },
          _sum: { receivedQty: true },
        }),
      ])
    : [[], [], []]

  // What the BOM allows: per piece of each of its MO lines, for the whole
  // order and for the pieces actually cut, in the item's own unit.
  const bomIds = [...new Set(moLines.map((l) => l.bomId).filter((x): x is string => !!x))]
  const bomLines = bomIds.length
    ? await db.bOMLine.findMany({
        where: { bomId: { in: bomIds }, componentItemId: { in: itemIds } },
        select: { bomId: true, componentItemId: true, effectiveQty: true, sizes: { select: { sizeId: true, effectiveQty: true } } },
      })
    : []
  const perPiece = (bomId: string | null | undefined, itemId: string, sizeId?: string | null) => {
    const b = bomLines.find((x) => x.bomId === bomId && x.componentItemId === itemId)
    if (!b) return null
    const bySize = sizeId ? b.sizes.find((z) => z.sizeId === sizeId) : undefined
    return Number(bySize?.effectiveQty ?? b.effectiveQty)
  }
  const bomOf = (moLineId: string | null, moId: string) =>
    (moLineId ? moLines.find((l) => l.id === moLineId) : moLines.find((l) => l.moId === moId))?.bomId ?? null

  const fabric = itemIds.map((itemId) => {
    const info = grnLines.find((l) => l.itemId === itemId)?.item ?? issueLines.find((l) => l.itemId === itemId)!.item
    const g = grnLines.filter((l) => l.itemId === itemId)
    const received = round3(g.reduce((s, l) => s + Number(l.receivedQty), 0))
    const challan = round3(g.reduce((s, l) => s + Number(l.challanQty ?? l.receivedQty), 0))
    const rejected = round3(g.reduce((s, l) => s + Number(l.rejectedQty ?? 0), 0))
    const released = round3(g.reduce((s, l) => s + Number(l.releasedQty ?? 0), 0))
    const iss = issueLines.filter((l) => l.itemId === itemId)
    const issued = round3(iss.reduce((s, l) => s + Number(l.issuedQty), 0))
    const backFromFloor = round3(iss.reduce((s, l) => s + Number(l.returnedQty), 0))
    const issuedNet = round3(issued - backFromFloor)
    const cut = cuttings.filter((c) => c.fabricItemId === itemId)
    const used = round3(cut.reduce((s, c) => s + Number(c.fabricUsed ?? 0), 0))
    const waste = round3(cut.reduce((s, c) => s + Number(c.wastage ?? 0), 0))
    const back = cmrLines.filter((l) => l.itemId === itemId)
    const returned = round3(back.reduce((s, l) => s + Number(l.qty), 0))
    const returnedRejected = round3(back.filter((l) => l.return.reason === 'REJECTED').reduce((s, l) => s + Number(l.qty), 0))
    const usedAtJobWorkers = round3(Number(jwUsed.find((x) => x.itemId === itemId)?._sum.outQty ?? 0))

    // This order's own story: what its receipts brought, less what its documents took.
    const leftForOrder = round3(received - issuedNet - returned - usedAtJobWorkers)

    // The customer's whole stock of the item with us, usable and held.
    const gradeQty = (grade: string) => {
      const r = pool.find((x) => x.itemId === itemId && x.grade === grade)
      return round3(Number(r?._sum.inQty ?? 0) - Number(r?._sum.outQty ?? 0))
    }
    const usableNow = gradeQty('A')
    const heldNow = gradeQty('R')
    const withUsNow = round3(usableNow + heldNow)

    // More should be left for this order than the customer has with us at
    // all: another order, or a correction, took it.
    const unaccounted = round3(Math.max(0, leftForOrder - withUsNow))
    // This order used more than its own receipts brought: it drew on
    // receipts with no order, or another order's.
    const drewFromOthers = round3(Math.max(0, -leftForOrder))

    // The BOM's allowance for what was cut, and for the whole order.
    let bomForCut: number | null = null
    for (const c of cut) {
      const bomId = bomOf(c.moLineId, c.moId)
      const sizes = c.sizeBreakup && typeof c.sizeBreakup === 'object' ? Object.entries(c.sizeBreakup as Record<string, number>) : []
      const each = sizes.length
        ? sizes.reduce<number | null>((t, [sizeId, q]) => {
            const per = perPiece(bomId, itemId, sizeId)
            return per == null || t == null ? null : t + per * Number(q)
          }, 0)
        : (() => {
            const per = perPiece(bomId, itemId)
            return per == null ? null : per * c.actualPieces
          })()
      if (each == null) {
        bomForCut = null
        break
      }
      bomForCut = round3((bomForCut ?? 0) + each)
    }
    let bomForOrder: number | null = 0
    for (const l of moLines) {
      const per = perPiece(l.bomId, itemId)
      if (per == null) continue
      bomForOrder = round3(
        (bomForOrder ?? 0) +
          (l.sizes.length ? l.sizes.reduce((t, z) => t + (perPiece(l.bomId, itemId, z.sizeId) ?? per) * z.qty, 0) : per * l.totalQty),
      )
    }
    if (!bomLines.some((b) => b.componentItemId === itemId)) bomForOrder = null

    return {
      item: { id: itemId, code: info.code, name: info.name, uom: info.uom?.symbol ?? null },
      challan,
      shortOnChallan: round3(Math.max(0, challan - received)),
      received,
      rejected,
      released,
      issued,
      backFromFloor,
      issuedNet,
      used,
      waste,
      /** Issued and not yet explained by cutting or a floor return: on the floor. */
      issuedNotCut: round3(issuedNet - used - waste),
      returned,
      returnedRejected,
      usedAtJobWorkers,
      leftForOrder,
      drewFromOthers,
      /** The customer's whole stock of the item with us, all orders. */
      usableNow,
      heldNow,
      unassignedReceived: round3(Number(unassigned.find((x) => x.itemId === itemId)?._sum.receivedQty ?? 0)),
      otherOrdersReceived: round3(Number(otherOrders.find((x) => x.itemId === itemId)?._sum.receivedQty ?? 0)),
      unaccounted,
      /** What the BOM allows for the pieces cut (null: no BOM line for it), and the difference. */
      bomForCut: cut.length ? bomForCut : null,
      bomVariance: cut.length && bomForCut != null ? round3(used + waste - bomForCut) : null,
      /** What the BOM needs for the whole order (null: no BOM line for it). */
      bomForOrder,
    }
  })

  // Our own material on the order, at what it cost us: the issue rows' value,
  // less what came back from the floor at the value it came back at.
  const ownIds = [...new Set(ownLines.map((l) => l.itemId))]
  const ownValue = ownIds.length && mrs.length
    ? await db.stockLedger.findMany({
        where: {
          itemId: { in: ownIds },
          ownership: 'OWNED',
          referenceId: { in: mrs.map((m) => m.id) },
          referenceType: { in: ['MATERIAL_REQUISITION', 'MR_RETURN', 'MR_RETURN_CANCELLED'] },
        },
        select: { itemId: true, inQty: true, outQty: true, unitRate: true },
      })
    : []
  const ownMaterial = ownIds
    .map((itemId) => {
      const ls = ownLines.filter((l) => l.itemId === itemId)
      const qty = round3(ls.reduce((s, l) => s + Number(l.issuedQty) - Number(l.returnedQty), 0))
      const value = round2(ownValue.filter((r) => r.itemId === itemId).reduce((s, r) => s + (Number(r.outQty) - Number(r.inQty)) * Number(r.unitRate ?? 0), 0))
      const it = ls[0].item
      return { item: { id: itemId, code: it.code, name: it.name, uom: it.uom?.symbol ?? null }, qty, value }
    })
    .filter((m) => m.qty > 0.0005)

  const ownCost = round2(ownMaterial.reduce((s, m) => s + m.value, 0))
  const billed = round2(Number(ownBilled._sum.amount ?? 0))
  const ordered = so.lines.reduce((s, l) => s + Number(l.totalQty), 0)
  const sent = so.lines.reduce((s, l) => s + Number(l.deliveredQty), 0)
  const cut = cuttings.reduce((s, c) => s + c.actualPieces, 0)
  const good = fgLines.filter((l) => l.grade !== 'B').reduce((s, l) => s + Number(l.qty), 0)
  const bGrade = fgLines.filter((l) => l.grade === 'B').reduce((s, l) => s + Number(l.qty), 0)
  const damagedPieces = damaged.reduce((s, l) => s + Number(l.damagedQty), 0)

  return {
    order: { id: so.id, soNumber: so.soNumber, status: so.status, isJobWork: so.isJobWork, customer: so.customer.name },
    /** Other open job-work orders for the same customer: their receipts are theirs, never this one's. */
    sharedWithOtherOrders: openOrders,
    fabric,
    ownMaterial: {
      lines: ownMaterial,
      value: ownCost,
      /** IN_JOB_CHARGE: the job charge covers it. BILLED: it is billed to the customer as a charge. */
      billing: so.ownMaterialBilling,
      billed,
      /** At cost, what is still to bill when it is billed separately. */
      toBill: so.ownMaterialBilling === 'BILLED' ? round2(Math.max(0, ownCost - billed)) : 0,
    },
    pieces: {
      ordered,
      cut,
      good,
      bGrade,
      damaged: damagedPieces,
      /** Cut and not yet packed or written off as damaged: still on the floor. */
      inProcess: Math.max(0, cut - good - bGrade - damagedPieces),
      sent,
    },
    // Every metre of theirs has an end — used, wasted, sent back, used at a job
    // worker — as closing the order asks; and every piece cut is packed or written off.
    balanced:
      fabric.every((f) => Math.abs(f.unaccounted) < 0.001 && Math.abs(f.issuedNotCut) < 0.001 && f.leftForOrder <= 0.0005) &&
      (cut === 0 || cut === good + bGrade + damagedPieces),
  }
}

export type MaterialGap = { itemId: string; item: string; unit: string; kind: 'MISSING' | 'ON_FLOOR' | 'WITH_US'; qty: number; text: string }

/**
 * What of the customer's material on a job-work order has no end yet, item by
 * item. Every metre they sent for it should finish used in its cutting,
 * wasted there, sent back to them or used at a job worker; until then the
 * order is not closed:
 *
 *   MISSING   its receipts say more should be with us than the customer has
 *             with us at all — another order or a correction took it
 *   ON_FLOOR  issued to production and neither cut nor brought back
 *   WITH_US   still in our store for this order — send it back to them
 */
export function materialGaps(r: Awaited<ReturnType<typeof orderReconciliation>>): MaterialGap[] {
  if (!r.order.isJobWork) return []
  return r.fabric.flatMap((f) => {
    const unit = f.item.uom ?? ''
    const q = (n: number) => `${n.toLocaleString('en-IN', { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`
    const gaps: MaterialGap[] = []
    const base = { itemId: f.item.id, item: f.item.name, unit }
    if (f.unaccounted > 0.0005) gaps.push({ ...base, kind: 'MISSING', qty: f.unaccounted, text: `${q(f.unaccounted)} of ${f.item.name} is missing: the customer has less with us than this order's receipts leave` })
    if (f.issuedNotCut > 0.0005) gaps.push({ ...base, kind: 'ON_FLOOR', qty: f.issuedNotCut, text: `${q(f.issuedNotCut)} of ${f.item.name} was issued to production and neither cut nor brought back` })
    const withUs = round3(Math.max(0, f.leftForOrder - f.unaccounted))
    if (withUs > 0.0005) gaps.push({ ...base, kind: 'WITH_US', qty: withUs, text: `${q(withUs)} of ${f.item.name} is still with us for this order, in a store or at a job worker${f.rejected - f.released - f.returnedRejected > 0.0005 ? ' (rejected material included)' : ''}: send it back to the customer` })
    return gaps
  })
}

/**
 * Whether a job-work order can be closed or cancelled as its material stands:
 * the gaps that stop it, and — not stopping it — our own material still to
 * bill when the order says it is billed separately.
 */
export async function closeCheck(db: Db, soId: string) {
  const r = await orderReconciliation(db, soId)
  const gaps = materialGaps(r)
  const notes: string[] = []
  if (r.order.isJobWork && r.ownMaterial.billing === 'BILLED' && r.ownMaterial.toBill > 0.005) {
    notes.push(`₹${r.ownMaterial.toBill.toLocaleString('en-IN', { maximumFractionDigits: 2 })} of our own material used on it is not billed yet.`)
  }
  return { gaps, notes, isJobWork: r.order.isJobWork }
}
