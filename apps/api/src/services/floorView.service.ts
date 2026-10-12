import type { Prisma, PrismaClient, WipBucket } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'
import { balancesOf } from './wip.service'
import { isLastStep, nextStepAfter } from './route.service'
import { stepFigures } from './floor.service'

/**
 * What the floor screens show, read off the production ledger: an order's
 * route with each step's figures, where every bundle is, its transfer cards
 * and job work orders, and what happened — for the whole order, or for one of
 * its job cards (one line: a style in one colour), which is what the
 * departments' sheets show.
 */

type Db = PrismaClient | Prisma.TransactionClient

/** One order's whole production picture, or one job card's. */
export async function flowSummary(db: Db, moId: string, only?: { moLineId: string; jobCardId: string }) {
  const mo = await db.manufacturingOrder.findUnique({
    where: { id: moId },
    select: {
      id: true,
      moNumber: true,
      status: true,
      progress: true,
      heldAt: true,
      holdReason: true,
      heldBy: { select: { name: true } },
      routingId: true,
      routingVersion: true,
      routing: { select: { code: true, name: true, version: true } },
      totalPlannedQty: true,
      totalCutQty: true,
      totalPackedQty: true,
      so: { select: { soNumber: true, isJobWork: true, customer: { select: { name: true } } } },
      lines: {
        select: {
          id: true,
          color: true,
          totalQty: true,
          style: { select: { code: true, name: true } },
          soLine: { select: { item: { select: { id: true, code: true, name: true } } } },
          sizes: { select: { sizeId: true, qty: true, size: { select: { code: true, sequence: true } } } },
        },
      },
      steps: {
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          sequence: true,
          name: true,
          kind: true,
          isQcStep: true,
          execution: true,
          skip: true,
          skippedAt: true,
          skipReason: true,
          skippedBy: { select: { name: true } },
          ratePerPiece: true,
          instructions: true,
          operationId: true,
          departmentId: true,
          department: { select: { id: true, name: true } },
          workstationId: true,
          workstation: { select: { id: true, name: true, type: true, supplier: { select: { id: true, name: true } } } },
        },
      },
    },
  })
  if (!mo) throw new AppError('Manufacturing order not found', 404, 'NOT_FOUND')
  const moLineId = only?.moLineId
  const planned = moLineId ? mo.lines.find((l) => l.id === moLineId)?.totalQty ?? 0 : mo.totalPlannedQty
  const ofLine = moLineId ? { moLineId } : {}

  const [figures, held, bundles, transfers, jobWorkOrders, events, lastAt] = await Promise.all([
    mo.steps.length ? stepFigures(db, mo.id, mo.steps, planned, moLineId) : Promise.resolve([]),
    balancesOf(db as Prisma.TransactionClient, mo.id, moLineId),
    db.productionBundle.findMany({
      where: { moId: mo.id, ...ofLine },
      orderBy: { bundleNo: 'asc' },
      select: {
        id: true,
        code: true,
        bundleNo: true,
        qty: true,
        moLineId: true,
        size: { select: { id: true, code: true, sequence: true } },
        cuttingOrder: { select: { cutOrderNumber: true, status: true, lotNo: true } },
      },
    }),
    db.processTransfer.findMany({
      where: only ? { jobCardId: only.jobCardId } : { moId: mo.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        transferNumber: true,
        status: true,
        isRework: true,
        dispatchDate: true,
        issuedBy: true,
        receivedBy: true,
        receivedAt: true,
        notes: true,
        cancelReason: true,
        fromStep: { select: { id: true, name: true } },
        toStep: { select: { id: true, name: true } },
        vendor: { select: { id: true, name: true } },
        jobWorkOrder: { select: { id: true, orderNumber: true } },
        lines: {
          orderBy: { bundle: { bundleNo: 'asc' } },
          select: { id: true, dispatchedQty: true, receivedQty: true, shortQty: true, settledQty: true, excessQty: true, bundle: { select: { id: true, code: true, size: { select: { code: true } } } } },
        },
      },
    }),
    db.jobWorkOrder.findMany({
      where: { moId: mo.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        rate: true,
        expectedBy: true,
        notes: true,
        createdAt: true,
        stepId: true,
        step: { select: { name: true } },
        vendor: { select: { id: true, name: true, gstin: true } },
        wipEvents: {
          where: { type: { in: ['DISPATCH', 'VENDOR_RETURN'] } },
          orderBy: { eventDate: 'asc' },
          select: {
            id: true,
            type: true,
            eventDate: true,
            theirChallanNo: true,
            chargeQty: true,
            chargeRate: true,
            billNo: true,
            billDate: true,
            reason: true,
            reversedAt: true,
            transfer: { select: { id: true, transferNumber: true, isRework: true, jobCardId: true } },
            entries: { where: ofLine, select: { bucket: true, qty: true, vendorId: true } },
          },
        },
      },
    }),
    db.wipEvent.findMany({
      where: { moId: mo.id, ...(moLineId ? { entries: { some: { moLineId } } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        type: true,
        eventDate: true,
        createdAt: true,
        personName: true,
        reason: true,
        notes: true,
        reversedAt: true,
        reversalOfId: true,
        stepId: true,
        step: { select: { name: true } },
        vendor: { select: { name: true } },
        transfer: { select: { transferNumber: true } },
        jobWorkOrder: { select: { orderNumber: true } },
        cuttingOrder: { select: { cutOrderNumber: true } },
        fgReceipt: { select: { fgrNumber: true } },
        createdBy: { select: { name: true } },
        entries: { where: ofLine, select: { qty: true, bucket: true } },
      },
    }),
    db.wipEntry.groupBy({ by: ['stepId'], where: { moId: mo.id, ...ofLine }, _max: { createdAt: true } }),
  ])

  const lastActivity = new Map(lastAt.map((r) => [r.stepId, r._max.createdAt]))
  const figureOf = new Map(figures.map((f) => [f.stepId, f]))
  const lineOf = new Map(mo.lines.map((l) => [l.id, l]))

  const steps = mo.steps.map((s) => {
    const next = nextStepAfter(mo.steps, s.id)
    const rework = held.filter((r) => r.bucket === 'REWORK' && r.reworkStepId === s.id && r.stepId !== s.id && !r.vendorId).reduce((t, r) => t + r.qty, 0)
    return {
      ...s,
      ratePerPiece: s.ratePerPiece == null ? null : Number(s.ratePerPiece),
      next: next ? { id: next.id, name: next.name, execution: next.execution } : null,
      last: isLastStep(mo.steps, s.id),
      lastActivity: lastActivity.get(s.id) ?? null,
      reworkForOthers: rework,
      figures: figureOf.get(s.id) ?? null,
    }
  })

  const placesOf = new Map<string, Array<{ stepId: string; bucket: WipBucket; vendorId: string | null; reworkStepId: string | null; qty: number }>>()
  for (const r of held) {
    const list = placesOf.get(r.bundleId) ?? []
    list.push({ stepId: r.stepId, bucket: r.bucket, vendorId: r.vendorId, reworkStepId: r.reworkStepId, qty: r.qty })
    placesOf.set(r.bundleId, list)
  }
  const bundleList = bundles
    .map((b) => {
      const line = lineOf.get(b.moLineId)
      return {
        id: b.id,
        code: b.code,
        bundleNo: b.bundleNo,
        qty: b.qty,
        size: b.size,
        line: line ? { id: line.id, style: line.style.code, color: line.color } : null,
        cutting: b.cuttingOrder.cutOrderNumber,
        lotNo: b.cuttingOrder.lotNo,
        cancelled: b.cuttingOrder.status === 'CANCELLED',
        places: placesOf.get(b.id) ?? [],
      }
    })
    .filter((b) => !b.cancelled || b.places.length)

  const jwos = jobWorkOrders.map((j) => {
    // On a job card, only what moved of its own bundles.
    const live = j.wipEvents.filter((e) => !e.reversedAt && e.entries.length)
    const sum = (types: string[], bucket: WipBucket, sign: 1 | -1, vendor: boolean) =>
      live
        .filter((e) => types.includes(e.type))
        .flatMap((e) => e.entries)
        .filter((x) => x.bucket === bucket && (vendor ? !!x.vendorId : !x.vendorId) && Math.sign(x.qty) === sign)
        .reduce((t, x) => t + Math.abs(x.qty), 0)
    const heldNow = held.filter((r) => r.stepId === j.stepId && r.vendorId === j.vendor.id).reduce((t, r) => t + r.qty, 0)
    const returns = live
      .filter((e) => e.type === 'VENDOR_RETURN')
      .map((e) => ({
        eventId: e.id,
        date: e.eventDate,
        theirChallanNo: e.theirChallanNo,
        accepted: e.entries.filter((x) => x.bucket === 'DONE' && x.qty > 0).reduce((t, x) => t + x.qty, 0),
        rejected: e.entries.filter((x) => x.bucket === 'REJECTED' && x.qty > 0).reduce((t, x) => t + x.qty, 0),
        damaged: e.entries.filter((x) => x.bucket === 'DAMAGED' && x.qty > 0).reduce((t, x) => t + x.qty, 0),
        chargeQty: e.chargeQty ?? 0,
        chargeRate: Number(e.chargeRate ?? 0),
        amount: Math.round((e.chargeQty ?? 0) * Number(e.chargeRate ?? 0) * 100) / 100,
        billNo: e.billNo,
        billDate: e.billDate,
        reason: e.reason,
      }))
    return {
      id: j.id,
      orderNumber: j.orderNumber,
      status: j.status,
      rate: Number(j.rate),
      expectedBy: j.expectedBy,
      notes: j.notes,
      createdAt: j.createdAt,
      step: { id: j.stepId, name: j.step.name },
      vendor: j.vendor,
      sent: sum(['DISPATCH'], 'WIP', 1, true),
      sentForRework: sum(['DISPATCH'], 'REWORK', 1, true),
      accepted: returns.reduce((t, r) => t + r.accepted, 0),
      rejected: returns.reduce((t, r) => t + r.rejected, 0),
      damaged: returns.reduce((t, r) => t + r.damaged, 0),
      held: heldNow,
      charged: Math.round(returns.reduce((t, r) => t + r.amount, 0) * 100) / 100,
      billed: Math.round(returns.filter((r) => r.billNo).reduce((t, r) => t + r.amount, 0) * 100) / 100,
      challans: j.wipEvents
        .filter((e) => e.type === 'DISPATCH' && e.transfer && (!only || e.transfer.jobCardId === only.jobCardId))
        .map((e) => ({ id: e.transfer!.id, number: e.transfer!.transferNumber, isRework: e.transfer!.isRework, date: e.eventDate, cancelled: !!e.reversedAt })),
      returns,
    }
  })

  return {
    mo: {
      id: mo.id,
      moNumber: mo.moNumber,
      status: mo.status,
      progress: mo.progress,
      held: mo.heldAt ? { at: mo.heldAt, reason: mo.holdReason, by: mo.heldBy?.name ?? null } : null,
      routing: mo.routing ? { id: mo.routingId, code: mo.routing.code, name: mo.routing.name, version: mo.routingVersion, latest: mo.routing.version } : null,
      totalPlannedQty: mo.totalPlannedQty,
      totalCutQty: mo.totalCutQty,
      totalPackedQty: mo.totalPackedQty,
      so: mo.so,
    },
    lines: mo.lines
      .filter((l) => !moLineId || l.id === moLineId)
      .map((l) => ({
        id: l.id,
        style: l.style,
        color: l.color,
        totalQty: l.totalQty,
        item: l.soLine?.item ?? null,
        sizes: l.sizes.map((z) => ({ id: z.sizeId, code: z.size.code, sequence: z.size.sequence, qty: z.qty })).sort((a, b) => a.sequence - b.sequence),
      })),
    steps,
    bundles: bundleList,
    transfers,
    jobWorkOrders: jwos,
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      date: e.eventDate,
      at: e.createdAt,
      step: e.step?.name ?? null,
      stepId: e.stepId,
      person: e.personName,
      by: e.createdBy.name,
      vendor: e.vendor?.name ?? null,
      document: e.transfer?.transferNumber ?? e.jobWorkOrder?.orderNumber ?? e.cuttingOrder?.cutOrderNumber ?? e.fgReceipt?.fgrNumber ?? null,
      reason: e.reason,
      notes: e.notes,
      undone: !!e.reversedAt,
      isUndo: !!e.reversalOfId,
      pieces: e.entries.filter((x) => x.qty > 0).reduce((t, x) => t + x.qty, 0),
    })),
  }
}
