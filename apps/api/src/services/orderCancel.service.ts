import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { closeCheck } from './reconciliation.service'
import { lockMo } from './wip.service'
import { moStages } from './manufacturing.service'

/**
 * Calling off a sales order once work has started on it.
 *
 * A cancellation can be asked for at any stage of an open order. Asking puts
 * its manufacturing orders on hold: nothing more is issued, cut, moved
 * between stages, packed or sent for it, and the order is not changed. Its
 * state is laid out while it waits — what was issued and used, what is still
 * on the floor, pieces in work and in the store, requisitions still open,
 * purchase orders raised for them — and the material that is not needed goes
 * back to the store the ordinary way, a floor return, when the store has it
 * in hand. Nothing is put back into stock on paper.
 *
 * Someone who approves orders then approves it: the open requisitions close
 * (stock held for them is freed), the manufacturing orders close, and the
 * order is cancelled — or, when goods already went out, short-closed at what
 * was sent. Every issue, cutting, transfer and receipt stays on record and
 * linked to the order. Or the request is withdrawn and work carries on.
 */

type Db = PrismaClient | Prisma.TransactionClient

/** Open, so a cancellation can be asked for (a draft is simply cancelled). */
export const CANCELLABLE = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED']

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** The hold a request puts on its manufacturing orders; withdrawing it lifts only these. */
export const holdReasonFor = (soNumber: string, reason: string) => `Cancellation requested for ${soNumber}: ${reason}`
const holdPrefix = (soNumber: string) => `Cancellation requested for ${soNumber}`

/**
 * A cancellation waiting for a decision stops new work on its order.
 * `what` says what is refused, in a few words: "nothing more is issued for it".
 */
export async function assertNotCancelling(db: Db, soId: string | null | undefined, what: string) {
  if (!soId) return
  const so = await db.salesOrder.findUnique({ where: { id: soId }, select: { soNumber: true, status: true, cancelRequestedAt: true, cancelRequestReason: true } })
  if (so?.cancelRequestedAt && CANCELLABLE.includes(so.status)) {
    throw new AppError(
      `${so.soNumber} has a cancellation waiting for approval${so.cancelRequestReason ? ` (${so.cancelRequestReason})` : ''}, so ${what}. Approve or withdraw the cancellation first.`,
      409,
      'CANCEL_REQUESTED',
    )
  }
}

/** The sales order of a manufacturing order, for the check above. */
export async function soOfMo(db: Db, moId: string | null | undefined) {
  if (!moId) return null
  return (await db.manufacturingOrder.findUnique({ where: { id: moId }, select: { soId: true } }))?.soId ?? null
}

/**
 * Asks for the order to be cancelled: who, when, why. Its manufacturing
 * orders on the floor go on hold with that reason; one already on hold for
 * something else keeps its own hold.
 */
export async function requestCancellation(tx: Prisma.TransactionClient, soId: string, reason: string, userId: string) {
  const so = await tx.salesOrder.findUnique({
    where: { id: soId },
    select: {
      id: true,
      soNumber: true,
      status: true,
      cancelRequestedAt: true,
      manufacturingOrders: { where: { status: { notIn: ['DRAFT', 'CLOSED', 'COMPLETED'] } }, select: { id: true, moNumber: true, heldAt: true } },
    },
  })
  if (!so) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  if (!CANCELLABLE.includes(so.status)) {
    throw new AppError(
      so.status === 'DRAFT' ? `${so.soNumber} is still a draft: cancel it instead.` : `${so.soNumber} is ${so.status.toLowerCase()} already.`,
      409,
      'NOT_OPEN',
    )
  }
  if (so.cancelRequestedAt) throw new AppError(`A cancellation of ${so.soNumber} is already waiting for approval.`, 409, 'ALREADY_REQUESTED')
  const held: Array<{ id: string; moNumber: string; reason: string }> = []
  for (const mo of so.manufacturingOrders) {
    if (mo.heldAt) continue
    const why = holdReasonFor(so.soNumber, reason)
    await lockMo(tx, mo.id)
    await tx.manufacturingOrder.update({ where: { id: mo.id }, data: { heldAt: new Date(), heldById: userId, holdReason: why } })
    held.push({ id: mo.id, moNumber: mo.moNumber, reason: why })
  }
  const after = await tx.salesOrder.update({
    where: { id: so.id },
    data: { cancelRequestedAt: new Date(), cancelRequestedById: userId, cancelRequestReason: reason },
  })
  return { before: so, after, held }
}

/** The customer changed their mind: the request goes, and the holds it put on go with it. */
export async function withdrawCancellation(tx: Prisma.TransactionClient, soId: string) {
  const so = await tx.salesOrder.findUnique({
    where: { id: soId },
    select: { id: true, soNumber: true, status: true, cancelRequestedAt: true, cancelRequestReason: true, cancelRequestedById: true },
  })
  if (!so) throw new AppError('Sales order not found', 404, 'NOT_FOUND')
  if (!so.cancelRequestedAt || !CANCELLABLE.includes(so.status)) {
    throw new AppError(`No cancellation of ${so.soNumber} is waiting.`, 409, 'NOT_REQUESTED')
  }
  const held = await tx.manufacturingOrder.findMany({
    where: { soId: so.id, heldAt: { not: null }, holdReason: { startsWith: holdPrefix(so.soNumber) } },
    select: { id: true, moNumber: true },
  })
  if (held.length) {
    await tx.manufacturingOrder.updateMany({ where: { id: { in: held.map((m) => m.id) } }, data: { heldAt: null, heldById: null, holdReason: null } })
  }
  const after = await tx.salesOrder.update({
    where: { id: so.id },
    data: { cancelRequestedAt: null, cancelRequestedById: null, cancelRequestReason: null },
  })
  return { before: so, after, resumed: held }
}

/**
 * Everything a cancellation touches, as it stands now, for the person who
 * asks for it and the one who approves it.
 */
export async function cancellationImpact(db: Db, soId: string) {
  const so = await db.salesOrder.findUnique({
    where: { id: soId },
    select: {
      id: true,
      soNumber: true,
      status: true,
      isJobWork: true,
      customer: { select: { name: true } },
      cancelRequestedAt: true,
      cancelRequestReason: true,
      cancelRequestedBy: { select: { name: true } },
      cancelledAt: true,
      cancelReason: true,
      shortClosedAt: true,
      shortCloseReason: true,
      lines: { select: { totalQty: true, deliveredQty: true, pendingQty: true } },
      _count: { select: { deliveryChallans: { where: { status: { not: 'CANCELLED' } } } } },
      manufacturingOrders: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          moNumber: true,
          status: true,
          heldAt: true,
          holdReason: true,
          totalPlannedQty: true,
          totalCutQty: true,
          totalPackedQty: true,
          _count: { select: { steps: true } },
        },
      },
    },
  })
  if (!so) throw new AppError('Sales order not found', 404, 'NOT_FOUND')

  const moIds = so.manufacturingOrders.map((m) => m.id)
  const forOrder: Prisma.MaterialRequisitionWhereInput = { OR: [{ soId }, { mo: { soId } }] }
  const [mrs, cuttings, wip, packedSum, stages] = await Promise.all([
    db.materialRequisition.findMany({
      where: forOrder,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        mrNumber: true,
        status: true,
        closedAt: true,
        issuedAt: true,
        mo: { select: { moNumber: true } },
        department: { select: { name: true } },
        lines: {
          select: {
            id: true,
            itemId: true,
            ownership: true,
            requestedQty: true,
            issuedQty: true,
            returnedQty: true,
            item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
          },
        },
      },
    }),
    moIds.length
      ? db.cuttingOrder.findMany({ where: { moId: { in: moIds }, status: { not: 'CANCELLED' } }, select: { fabricItemId: true, fabricUsed: true, wastage: true } })
      : Promise.resolve([]),
    moIds.length ? db.wipEntry.groupBy({ by: ['moId', 'bucket', 'vendorId'], where: { moId: { in: moIds } }, _sum: { qty: true } }) : Promise.resolve([]),
    db.finishedGoodsReceiptLine.aggregate({ where: { receipt: { soId, cancelledAt: null } }, _sum: { qty: true } }),
    moStages(db, so.manufacturingOrders.map((m) => ({ ...m, soStatus: so.status }))),
  ])

  // ── Purchase raised for its requisitions, still open ──
  const lineIds = mrs.flatMap((m) => m.lines.map((l) => l.id))
  const [poLines, enquiryLines] = lineIds.length
    ? await Promise.all([
        db.purchaseOrderLine.findMany({
          where: { mrLineId: { in: lineIds }, shortClosed: false, po: { status: { notIn: ['CANCELLED', 'COMPLETED'] }, deletedAt: null } },
          select: {
            qty: true,
            receivedQty: true,
            item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
            po: { select: { id: true, poNumber: true, status: true, supplier: { select: { name: true } } } },
          },
        }),
        db.purchaseEnquiryLine.findMany({
          where: { mrLineId: { in: lineIds }, enquiry: { status: { in: ['DRAFT', 'SENT', 'QUOTED'] } } },
          select: { enquiry: { select: { id: true, enquiryNumber: true, status: true } } },
        }),
      ])
    : [[], []]

  // ── Materials, item by item: asked, issued, back from the floor, used in cutting, still out ──
  type Mat = {
    itemId: string
    item: { code: string; name: string; uom: string | null }
    customers: boolean
    asked: number
    issued: number
    returned: number
    toIssue: number
  }
  const mats = new Map<string, Mat>()
  for (const mr of mrs) {
    if (mr.status === 'REJECTED') continue
    const open = !mr.closedAt && !mr.issuedAt
    for (const l of mr.lines) {
      const m = mats.get(l.itemId) ?? {
        itemId: l.itemId,
        item: { code: l.item.code, name: l.item.name, uom: l.item.uom?.symbol ?? null },
        customers: false,
        asked: 0,
        issued: 0,
        returned: 0,
        toIssue: 0,
      }
      m.customers ||= l.ownership === 'CUSTOMER_OWNED'
      m.asked += Number(l.requestedQty)
      m.issued += Number(l.issuedQty)
      m.returned += Number(l.returnedQty)
      if (open) m.toIssue += Math.max(0, Number(l.requestedQty) - Number(l.issuedQty))
      mats.set(l.itemId, m)
    }
  }
  const usedOf = (itemId: string) =>
    cuttings.filter((c) => c.fabricItemId === itemId).reduce((s, c) => s + Number(c.fabricUsed ?? 0) + Number(c.wastage ?? 0), 0)
  const materials = [...mats.values()].map((m) => {
    const used = round3(usedOf(m.itemId))
    return {
      itemId: m.itemId,
      item: m.item,
      customers: m.customers,
      asked: round3(m.asked),
      issued: round3(m.issued),
      returned: round3(m.returned),
      /** Fabric cut, wastage in. Other material is not counted out as it is used. */
      usedInCutting: used,
      /** Issued and neither used in cutting nor back in the store: with production. */
      withProduction: round3(Math.max(0, m.issued - m.returned - used)),
      /** Asked for and not issued, on requisitions still open: not issued once approved. */
      toIssue: round3(m.toIssue),
    }
  })

  // ── Its manufacturing orders, with their pieces on the floor ──
  const q = (moId: string, buckets: string[], vendor?: boolean) =>
    wip
      .filter((w) => w.moId === moId && buckets.includes(w.bucket) && (vendor === undefined || (vendor ? !!w.vendorId : !w.vendorId)))
      .reduce((s, w) => s + Number(w._sum.qty ?? 0), 0)
  const mos = so.manufacturingOrders.map((mo) => {
    const routed = mo._count.steps > 0
    const floor = routed
      ? {
          onTheWay: q(mo.id, ['TRANSIT', 'SHORT']),
          inHand: q(mo.id, ['WIP', 'DONE'], false),
          atOutsideUnits: q(mo.id, ['WIP', 'DONE', 'REWORK'], true),
          inRework: q(mo.id, ['REWORK'], false),
          damaged: q(mo.id, ['DAMAGED', 'REJECTED']),
          bGrade: q(mo.id, ['B_GRADE']),
          scrapped: q(mo.id, ['SCRAPPED']),
        }
      : null
    const onFloor = floor
      ? floor.onTheWay + floor.inHand + floor.atOutsideUnits + floor.inRework + floor.damaged + floor.bGrade
      : Math.max(0, mo.totalCutQty - mo.totalPackedQty)
    const done = mo.status === 'CLOSED' || mo.status === 'COMPLETED'
    return {
      id: mo.id,
      moNumber: mo.moNumber,
      status: mo.status,
      stage: stages.get(mo.id)?.stage ?? mo.status,
      held: mo.heldAt ? (mo.holdReason ?? 'On hold') : null,
      planned: mo.totalPlannedQty,
      cut: mo.totalCutQty,
      packed: mo.totalPackedQty,
      onFloor,
      floor,
      /** What approving does to it: closes it, or it is finished already. */
      closes: !done,
    }
  })

  // ── Requisitions ──
  const requisitions = mrs.map((m) => {
    const issuedSome = m.lines.some((l) => Number(l.issuedQty) > 0)
    return {
      id: m.id,
      mrNumber: m.mrNumber,
      moNumber: m.mo?.moNumber ?? null,
      department: m.department?.name ?? null,
      state:
        m.status === 'REJECTED'
          ? 'Rejected'
          : m.closedAt
            ? 'Closed'
            : m.issuedAt
              ? 'Issued in full'
              : issuedSome
                ? 'Part issued'
                : m.status === 'PENDING'
                  ? 'Waiting for approval'
                  : 'Approved, not issued',
      /** Still asking: closes on approval, nothing more issued against it. */
      closes: m.status !== 'REJECTED' && !m.closedAt && !m.issuedAt,
      returnable: m.lines.some((l) => Number(l.issuedQty) - Number(l.returnedQty) > 0.0005),
    }
  })

  // ── Pieces ──
  const ordered = so.lines.reduce((s, l) => s + Number(l.totalQty), 0)
  const dispatched = so.lines.reduce((s, l) => s + Number(l.deliveredQty), 0)
  const pending = so.lines.reduce((s, l) => s + Number(l.pendingQty), 0)
  const packed = Number(packedSum._sum.qty ?? 0)
  const pieces = {
    ordered,
    dispatched,
    pending,
    planned: so.manufacturingOrders.filter((m) => m.status !== 'CLOSED').reduce((s, m) => s + m.totalPlannedQty, 0),
    cut: so.manufacturingOrders.reduce((s, m) => s + m.totalCutQty, 0),
    onFloor: mos.reduce((s, m) => s + m.onFloor, 0),
    packed,
    inStore: Math.max(0, packed - dispatched),
  }
  const sent = so._count.deliveryChallans > 0 || dispatched > 0

  // ── The customer's material on a job-work order: what still has no end ──
  const gaps = so.isJobWork && CANCELLABLE.includes(so.status) ? (await closeCheck(db, soId)).gaps : []

  // ── What approving does, and what to see to first ──
  const unit = (u: string | null) => (u ? ` ${u}` : '')
  const n = (x: number) => x.toLocaleString('en-IN', { maximumFractionDigits: 3 })
  const closingMos = mos.filter((m) => m.closes).map((m) => m.moNumber)
  const closingMrs = requisitions.filter((m) => m.closes).map((m) => m.mrNumber)
  const effects = [
    sent
      ? `${so.soNumber} is short-closed at the ${n(dispatched)} pieces sent; the other ${n(pending)} are not made or sent.`
      : `${so.soNumber} is cancelled.`,
    closingMos.length
      ? `${closingMos.join(', ')} ${closingMos.length === 1 ? 'closes' : 'close'}: work stops for good, and what was issued, cut and packed stays on record.`
      : null,
    closingMrs.length
      ? `${closingMrs.join(', ')} ${closingMrs.length === 1 ? 'closes' : 'close'}: nothing more is issued, and stock held for ${closingMrs.length === 1 ? 'it' : 'them'} is free again.`
      : null,
    poLines.length ? 'Purchase orders raised for its requisitions stay as they are, for Purchase to cancel with the supplier or keep for stock.' : null,
  ].filter((x): x is string => !!x)

  const warnings: string[] = []
  for (const m of materials) {
    // A job-work customer's material still on the floor is already said, as what stops approval.
    if (gaps.some((g) => g.itemId === m.itemId && g.kind === 'ON_FLOOR')) continue
    if (m.withProduction > 0.0005) {
      warnings.push(
        `${n(m.withProduction)}${unit(m.item.uom)} of ${m.item.name} is with production (issued, not used in cutting, not returned). Return what is not used from Inventory → Requisitions; it goes back into stock when the store receives it.`,
      )
    }
  }
  for (const m of mos) {
    if (m.closes && m.onFloor > 0) {
      const f = m.floor
      const where = f
        ? [
            f.onTheWay ? `${n(f.onTheWay)} on the way between stages` : '',
            f.atOutsideUnits ? `${n(f.atOutsideUnits)} at outside units` : '',
            f.damaged ? `${n(f.damaged)} damaged or rejected, not decided` : '',
          ].filter(Boolean)
        : []
      warnings.push(`${n(m.onFloor)} pieces of ${m.moNumber} are still on the floor${where.length ? ` (${where.join('; ')})` : ''}: they stay recorded on it when it closes.`)
    }
  }
  if (pieces.inStore > 0) {
    warnings.push(
      so.isJobWork
        ? `${n(pieces.inStore)} packed pieces are the customer's goods in our store; they stay there as theirs.`
        : `${n(pieces.inStore)} packed pieces are in the store; they stay in stock, free for other orders.`,
    )
  }
  for (const l of poLines) {
    const left = round3(Number(l.qty) - Number(l.receivedQty))
    if (left > 0.0005) warnings.push(`${l.po.poNumber} (${l.po.supplier.name}): ${n(left)}${unit(l.item.uom?.symbol ?? null)} of ${l.item.name} still to come.`)
  }
  const enquiries = [...new Map(enquiryLines.map((e) => [e.enquiry.id, e.enquiry])).values()]
  for (const e of enquiries) warnings.push(`${e.enquiryNumber} is still asking suppliers for rates: close it if it was only for this order.`)

  return {
    order: {
      id: so.id,
      soNumber: so.soNumber,
      status: so.status,
      isJobWork: so.isJobWork,
      customer: so.customer.name,
      sent,
    },
    request: so.cancelRequestedAt
      ? { at: so.cancelRequestedAt, by: so.cancelRequestedBy?.name ?? null, reason: so.cancelRequestReason, pending: CANCELLABLE.includes(so.status) }
      : null,
    /** Nothing made, asked for or sent: it can be cancelled straight away, no hold needed. */
    nothingStarted: !sent && !mos.some((m) => m.closes) && !mrs.some((m) => m.status !== 'REJECTED' && (!m.closedAt || m.lines.some((l) => Number(l.issuedQty) > 0))),
    pieces,
    mos,
    materials,
    requisitions,
    purchase: poLines.map((l) => ({
      poId: l.po.id,
      poNumber: l.po.poNumber,
      status: l.po.status,
      supplier: l.po.supplier.name,
      item: l.item.name,
      uom: l.item.uom?.symbol ?? null,
      ordered: Number(l.qty),
      received: Number(l.receivedQty),
    })),
    enquiries,
    /** The customer's material with no end yet: stops approval, unless a manager makes an exception. */
    gaps,
    effects,
    warnings,
  }
}
