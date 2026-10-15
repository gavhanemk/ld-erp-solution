import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * Closing an order with everything accounted for.
 *
 * For the customer's fabric on a job-work order, item by item:
 *
 *   received on the order's customer GRNs
 *   = issued to its manufacturing (less what came back from the floor)
 *   + returned to the customer on its material returns
 *   ± count differences on that customer's stock
 *   + what of theirs is still in our stores
 *
 * and, of what was issued, how much the cutting used and wasted.
 *
 * For the pieces: ordered, cut, packed good and B-grade, damaged at job
 * workers, sent. A gap is shown as a gap — the order can still be closed, but
 * nobody closes it without seeing it.
 *
 * Count differences and stock held are the customer's, not the order's: with
 * two job-work orders open for the same customer they cover both, and the
 * screen says so.
 */
type Db = Prisma.TransactionClient

const round3 = (n: number) => Math.round(n * 1000) / 1000

export async function orderReconciliation(db: Db, soId: string) {
  const so = await db.salesOrder.findUnique({
    where: { id: soId },
    select: {
      id: true,
      soNumber: true,
      status: true,
      isJobWork: true,
      customerId: true,
      customer: { select: { name: true } },
      lines: { select: { totalQty: true, deliveredQty: true } },
    },
  })
  if (!so) throw new AppError('Sales order not found', 404, 'NOT_FOUND')

  const [grnLines, issueLines, cmrLines, cuttings, fgLines, damaged, openOrders] = await Promise.all([
    db.customerGRNLine.findMany({
      where: { grn: { soId, cancelledAt: null } },
      select: { itemId: true, challanQty: true, receivedQty: true, rejectedQty: true, item: { select: { code: true, name: true, uom: { select: { symbol: true } } } } },
    }),
    db.materialRequisitionLine.findMany({
      where: { mr: { soId }, ownership: 'CUSTOMER_OWNED', ownerCustomerId: so.customerId },
      select: { itemId: true, issuedQty: true, returnedQty: true, item: { select: { code: true, name: true, uom: { select: { symbol: true } } } } },
    }),
    db.customerMaterialReturnLine.findMany({
      where: { return: { cancelledAt: null, OR: [{ soId }, { grn: { soId } }] } },
      select: { itemId: true, qty: true },
    }),
    db.cuttingOrder.findMany({
      where: { mo: { soId }, status: { not: 'CANCELLED' } },
      select: { fabricItemId: true, fabricUsed: true, wastage: true, actualPieces: true },
    }),
    db.finishedGoodsReceiptLine.findMany({ where: { receipt: { soId, cancelledAt: null } }, select: { qty: true, grade: true } }),
    db.jobWorkReturnLine.findMany({ where: { jobWorkReturn: { challan: { soId }, cancelledAt: null } }, select: { damagedQty: true } }),
    db.salesOrder.count({ where: { customerId: so.customerId, isJobWork: true, status: { notIn: ['COMPLETED', 'CANCELLED', 'DRAFT'] }, id: { not: soId } } }),
  ])

  // The customer's stock, now and its count differences, for the items in play.
  const itemIds = [...new Set([...grnLines.map((l) => l.itemId), ...issueLines.map((l) => l.itemId)])]
  const [held, adjusted] = itemIds.length
    ? await Promise.all([
        db.stockLedger.groupBy({
          by: ['itemId'],
          where: { itemId: { in: itemIds }, ownership: 'CUSTOMER_OWNED', ownerCustomerId: so.customerId },
          _sum: { inQty: true, outQty: true },
        }),
        db.stockLedger.groupBy({
          by: ['itemId'],
          where: { itemId: { in: itemIds }, ownership: 'CUSTOMER_OWNED', ownerCustomerId: so.customerId, referenceType: 'STOCK_ADJUSTMENT' },
          _sum: { inQty: true, outQty: true },
        }),
      ])
    : [[], []]

  const fabric = itemIds.map((itemId) => {
    const info = grnLines.find((l) => l.itemId === itemId)?.item ?? issueLines.find((l) => l.itemId === itemId)!.item
    const g = grnLines.filter((l) => l.itemId === itemId)
    const received = round3(g.reduce((s, l) => s + Number(l.receivedQty), 0))
    const challan = round3(g.reduce((s, l) => s + Number(l.challanQty ?? l.receivedQty), 0))
    const rejected = round3(g.reduce((s, l) => s + Number(l.rejectedQty ?? 0), 0))
    const iss = issueLines.filter((l) => l.itemId === itemId)
    const issued = round3(iss.reduce((s, l) => s + Number(l.issuedQty), 0))
    const backFromFloor = round3(iss.reduce((s, l) => s + Number(l.returnedQty), 0))
    const issuedNet = round3(issued - backFromFloor)
    const cut = cuttings.filter((c) => c.fabricItemId === itemId)
    const used = round3(cut.reduce((s, c) => s + Number(c.fabricUsed ?? 0), 0))
    const waste = round3(cut.reduce((s, c) => s + Number(c.wastage ?? 0), 0))
    const returned = round3(cmrLines.filter((l) => l.itemId === itemId).reduce((s, l) => s + Number(l.qty), 0))
    const h = held.find((x) => x.itemId === itemId)
    const heldNow = round3(Number(h?._sum.inQty ?? 0) - Number(h?._sum.outQty ?? 0))
    const a = adjusted.find((x) => x.itemId === itemId)
    const adj = round3(Number(a?._sum.inQty ?? 0) - Number(a?._sum.outQty ?? 0))
    // What the order received and cannot yet say where it went.
    const unaccounted = round3(received - issuedNet - returned + adj - heldNow)
    return {
      item: { id: itemId, code: info.code, name: info.name, uom: info.uom?.symbol ?? null },
      challan,
      shortOnChallan: round3(Math.max(0, challan - received)),
      received,
      rejected,
      issued,
      backFromFloor,
      issuedNet,
      used,
      waste,
      /** Issued and not yet explained by cutting or a floor return. */
      issuedNotCut: round3(issuedNet - used - waste),
      returned,
      adjusted: adj,
      heldNow,
      unaccounted,
    }
  })

  const ordered = so.lines.reduce((s, l) => s + Number(l.totalQty), 0)
  const sent = so.lines.reduce((s, l) => s + Number(l.deliveredQty), 0)
  const cut = cuttings.reduce((s, c) => s + c.actualPieces, 0)
  const good = fgLines.filter((l) => l.grade !== 'B').reduce((s, l) => s + Number(l.qty), 0)
  const bGrade = fgLines.filter((l) => l.grade === 'B').reduce((s, l) => s + Number(l.qty), 0)
  const damagedPieces = damaged.reduce((s, l) => s + Number(l.damagedQty), 0)

  return {
    order: { id: so.id, soNumber: so.soNumber, status: so.status, isJobWork: so.isJobWork, customer: so.customer.name },
    /** Other open job-work orders for the same customer share its stock figures. */
    sharedWithOtherOrders: openOrders,
    fabric,
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
    balanced: fabric.every((f) => Math.abs(f.unaccounted) < 0.001) && (cut === 0 || cut === good + bGrade + damagedPieces),
  }
}
