import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { balanceOf, recordMovement } from '../services/stock.service'
import { liveQcOf, readQc, type QcData, type QcLine } from '../services/grnQc.service'
import { cancelQcSchema, createQcSchema } from '../schemas/grn-qc.schemas'

/**
 * Quality check on a goods receipt.
 *
 * Optional, and after the fact: the receipt has already put the goods in
 * stock. A check records, per line, how much passed and how much was
 * rejected and why — and moves the rejected quantity into a reject godown the
 * checker picks, so it stays on the books but cannot be issued to production
 * by mistake. From there it goes back to the supplier on a return challan
 * against the bill.
 *
 * One standing check per receipt. To change a check, cancel it (its goods
 * move back) and check again.
 */

const MODULE = 'purchase'
const router = Router()

const round3 = (n: number) => Math.round(n * 1000) / 1000

const grnSelect = {
  id: true,
  grnNumber: true,
  grnDate: true,
  status: true,
  challanNo: true,
  po: {
    select: {
      id: true,
      poNumber: true,
      supplier: { select: { id: true, code: true, name: true } },
    },
  },
  lines: {
    orderBy: { id: 'asc' as const },
    select: {
      id: true,
      itemId: true,
      warehouseId: true,
      receivedQty: true,
      unitRate: true,
      item: { select: { code: true, name: true, uom: { select: { symbol: true } } } },
      warehouse: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.GRNSelect

/** A check as the screen wants it: names alongside the ids. */
async function shapeQc(
  tx: Prisma.TransactionClient,
  row: {
    id: string
    inspectionDate: Date
    inspectedBy: string | null
    result: string
    remarks: string | null
    checklistData: unknown
    createdAt: Date
  },
  lineInfo: Map<
    string,
    { itemCode: string; itemName: string; uom: string | null; warehouseName: string }
  >
) {
  const d = readQc(row.checklistData)
  const rejectWarehouse = d?.rejectWarehouseId
    ? await tx.warehouse.findUnique({
        where: { id: d.rejectWarehouseId },
        select: { id: true, name: true },
      })
    : null
  return {
    id: row.id,
    inspectionDate: row.inspectionDate,
    inspectedBy: row.inspectedBy,
    result: row.result,
    remarks: row.remarks,
    createdAt: row.createdAt,
    rejectWarehouse,
    cancelled: d?.cancelled ?? null,
    lines: (d?.lines ?? []).map((l) => ({ ...l, ...lineInfo.get(l.grnLineId) })),
    rejectedQty: round3((d?.lines ?? []).reduce((s, l) => s + l.rejectedQty, 0)),
  }
}

// ── A receipt, ready to check ───────────────────────────────────────────────

router.get('/grn/:grnId', requirePermission(MODULE, 'view'), async (req, res) => {
  const grn = await prisma.gRN.findUnique({ where: { id: req.params.grnId }, select: grnSelect })
  if (!grn) throw new AppError('That goods receipt does not exist', 404, 'NOT_FOUND')

  const lineInfo = new Map(
    grn.lines.map((l) => [
      l.id,
      {
        itemCode: l.item.code,
        itemName: l.item.name,
        uom: l.item.uom?.symbol ?? null,
        warehouseName: l.warehouse.name,
      },
    ])
  )

  const lines = await Promise.all(
    grn.lines.map(async (l) => ({
      grnLineId: l.id,
      itemId: l.itemId,
      itemCode: l.item.code,
      itemName: l.item.name,
      uom: l.item.uom?.symbol ?? null,
      warehouseId: l.warehouseId,
      warehouseName: l.warehouse.name,
      receivedQty: Number(l.receivedQty),
      // What the godown holds now. Goods already issued to production cannot
      // be moved to the reject godown, and the checker is better told before
      // the save than by it.
      onHand: (await balanceOf(prisma, { itemId: l.itemId, warehouseId: l.warehouseId })).qty,
    }))
  )

  const rows = await prisma.inwardQC.findMany({
    where: { grnId: grn.id },
    orderBy: { createdAt: 'desc' },
  })
  const shaped = await Promise.all(rows.map((r) => shapeQc(prisma, r, lineInfo)))

  res.json({
    success: true,
    data: {
      grn: {
        id: grn.id,
        grnNumber: grn.grnNumber,
        grnDate: grn.grnDate,
        status: grn.status,
        challanNo: grn.challanNo,
        poNumber: grn.po.poNumber,
        supplier: grn.po.supplier,
      },
      lines,
      qc: shaped.find((q) => !q.cancelled) ?? null,
      history: shaped.filter((q) => q.cancelled),
    },
  })
})

// ── Recording a check ───────────────────────────────────────────────────────

router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createQcSchema.parse(req.body)
  const when = data.inspectionDate ?? new Date()

  const qc = await prisma.$transaction(async (tx) => {
    const grn = await tx.gRN.findUnique({ where: { id: data.grnId }, select: grnSelect })
    if (!grn) throw new AppError('That goods receipt does not exist', 404, 'NOT_FOUND')
    if (grn.status === 'CANCELLED') {
      throw new AppError(
        `${grn.grnNumber} is cancelled — there is nothing to check.`,
        409,
        'GRN_CANCELLED'
      )
    }
    if (await liveQcOf(tx, grn.id)) {
      throw new AppError(
        `${grn.grnNumber} has already been checked. Cancel that check first to record a new one.`,
        409,
        'QC_EXISTS'
      )
    }

    const sent = new Map(data.lines.map((l) => [l.grnLineId, l]))
    const ours = new Set(grn.lines.map((l) => l.id))
    if ([...sent.keys()].some((id) => !ours.has(id))) {
      throw new AppError(`One of those lines is not on ${grn.grnNumber}`, 400, 'WRONG_LINE')
    }

    // Every line of the receipt is on the check. A line the form did not send
    // passed in full — nothing about it was rejected.
    const lines: QcLine[] = grn.lines.map((l) => {
      const received = Number(l.receivedQty)
      const rejected = round3(sent.get(l.id)?.rejectedQty ?? 0)
      if (rejected > received + 0.0005) {
        throw new AppError(
          `${l.item.name}: ${rejected} rejected, but only ${received} ${l.item.uom?.symbol ?? ''} was received on ${grn.grnNumber}.`.replace(
            /\s+/g,
            ' '
          ),
          400,
          'QC_OVER'
        )
      }
      return {
        grnLineId: l.id,
        itemId: l.itemId,
        warehouseId: l.warehouseId,
        receivedQty: received,
        approvedQty: round3(received - rejected),
        rejectedQty: rejected,
        reason: rejected > 0 ? (sent.get(l.id)?.reason?.trim() ?? null) : null,
      }
    })

    const rejecting = lines.filter((l) => l.rejectedQty > 0)
    /*
     * Where rejected goods are moved, if anywhere.
     *
     * Optional: with one store there is nowhere else to put them, so a check
     * without a reject godown only records what was rejected and why. The
     * goods stay where they were received until the return challan takes
     * them out. When a reject godown is named, they are moved into it.
     */
    let rejectWarehouseId: string | null = null
    if (rejecting.length && data.rejectWarehouseId) {
      const target = await tx.warehouse.findUnique({
        where: { id: data.rejectWarehouseId ?? '' },
        select: { id: true, name: true, isActive: true },
      })
      if (!target) throw new AppError('That godown does not exist', 400, 'BAD_WAREHOUSE')
      if (!target.isActive) {
        throw new AppError(
          `${target.name} is no longer in use. Pick another godown.`,
          400,
          'WAREHOUSE_CLOSED'
        )
      }
      const same = rejecting.find((l) => l.warehouseId === target.id)
      if (same) {
        const name = grn.lines.find((g) => g.id === same.grnLineId)?.item.name ?? 'An item'
        throw new AppError(
          `${name} was received into ${target.name} itself. Rejected goods have to move to a different godown, or they would still be issued as good stock.`,
          400,
          'SAME_WAREHOUSE'
        )
      }
      rejectWarehouseId = target.id
    }

    const totalRejected = rejecting.reduce((s, l) => s + l.rejectedQty, 0)
    const totalReceived = lines.reduce((s, l) => s + l.receivedQty, 0)
    const result =
      totalRejected <= 0
        ? 'PASS'
        : totalRejected >= totalReceived - 0.0005
          ? 'FAIL'
          : 'CONDITIONAL_PASS'

    const payload: QcData = { version: 1, rejectWarehouseId, lines }
    const created = await tx.inwardQC.create({
      data: {
        grnId: grn.id,
        inspectionDate: when,
        inspectedBy: req.user?.name ?? null,
        result,
        remarks: data.remarks?.trim() || null,
        checklistData: payload as unknown as Prisma.InputJsonValue,
      },
    })

    // Out of the godown it was received into, into the reject godown, at the
    // value it was carried at — a move, not a loss. Nothing moves without one.
    for (const l of rejectWarehouseId ? rejecting : []) {
      const out = await recordMovement(tx, {
        itemId: l.itemId,
        warehouseId: l.warehouseId,
        transactionType: 'TRANSFER',
        direction: 'OUT',
        qty: l.rejectedQty,
        referenceType: 'GRN_QC',
        referenceId: created.id,
        transactionDate: when,
        notes: `Rejected on QC of ${grn.grnNumber}: ${l.reason ?? ''}`.trim(),
      })
      await recordMovement(tx, {
        itemId: l.itemId,
        warehouseId: rejectWarehouseId!,
        transactionType: 'TRANSFER',
        direction: 'IN',
        qty: l.rejectedQty,
        unitRate: out.unitRate,
        referenceType: 'GRN_QC',
        referenceId: created.id,
        transactionDate: when,
        notes: `Rejected on QC of ${grn.grnNumber}: ${l.reason ?? ''}`.trim(),
      })
    }

    return { created, grn, rejecting, rejectWarehouseId }
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'CREATE',
    entityType: 'InwardQC',
    entityId: qc.created.id,
    after: qc.created,
  })

  const where = qc.rejectWarehouseId
    ? (
        await prisma.warehouse.findUnique({
          where: { id: qc.rejectWarehouseId },
          select: { name: true },
        })
      )?.name
    : null

  res.status(201).json({
    success: true,
    data: { id: qc.created.id, result: qc.created.result },
    message: qc.rejecting.length
      ? `QC recorded on ${qc.grn.grnNumber}. ${qc.rejecting.length} line${qc.rejecting.length === 1 ? '' : 's'} part or fully rejected — moved to ${where}. Send them back on a return challan from the bill.`
      : `QC recorded on ${qc.grn.grnNumber} — everything passed.`,
  })
})

// ── Taking a check back ─────────────────────────────────────────────────────

router.post('/:id/cancel', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = cancelQcSchema.parse(req.body ?? {})

  const out = await prisma.$transaction(async (tx) => {
    const row = await tx.inwardQC.findUnique({
      where: { id: req.params.id },
      include: { grn: { select: { id: true, grnNumber: true } } },
    })
    if (!row) throw new AppError('That check does not exist', 404, 'NOT_FOUND')
    const d = readQc(row.checklistData)
    if (!d)
      throw new AppError(
        'That check was not recorded here and cannot be cancelled',
        409,
        'QC_FOREIGN'
      )
    if (d.cancelled) throw new AppError('That check is already cancelled', 409, 'QC_CANCELLED')

    // The rejected goods come back to the godown they were received into. If
    // some have already left the reject godown — on a return challan — the
    // move is refused by name, and that challan has to be cancelled first.
    const now = new Date()
    for (const l of d.lines) {
      if (!(l.rejectedQty > 0) || !d.rejectWarehouseId) continue
      const back = await recordMovement(tx, {
        itemId: l.itemId,
        warehouseId: d.rejectWarehouseId,
        transactionType: 'TRANSFER',
        direction: 'OUT',
        qty: l.rejectedQty,
        referenceType: 'GRN_QC_CANCELLED',
        referenceId: row.id,
        transactionDate: now,
        notes: `QC of ${row.grn.grnNumber} cancelled: ${reason}`,
      })
      await recordMovement(tx, {
        itemId: l.itemId,
        warehouseId: l.warehouseId,
        transactionType: 'TRANSFER',
        direction: 'IN',
        qty: l.rejectedQty,
        unitRate: back.unitRate,
        referenceType: 'GRN_QC_CANCELLED',
        referenceId: row.id,
        transactionDate: now,
        notes: `QC of ${row.grn.grnNumber} cancelled: ${reason}`,
      })
    }

    const next: QcData = {
      ...d,
      cancelled: {
        at: now.toISOString(),
        byId: req.user!.id,
        byName: req.user?.name ?? '',
        reason,
      },
    }
    const updated = await tx.inwardQC.update({
      where: { id: row.id },
      data: { checklistData: next as unknown as Prisma.InputJsonValue },
    })
    return {
      before: row,
      updated,
      grnNumber: row.grn.grnNumber,
      moved: d.lines.some((l) => l.rejectedQty > 0),
    }
  })

  await writeAuditLog(req, {
    module: MODULE,
    action: 'UPDATE',
    entityType: 'InwardQC',
    entityId: out.updated.id,
    before: out.before,
    after: out.updated,
  })

  res.json({
    success: true,
    data: { id: out.updated.id },
    message: out.moved
      ? `QC of ${out.grnNumber} cancelled — its rejected goods are back where they were received.`
      : `QC of ${out.grnNumber} cancelled.`,
  })
})

export default router
