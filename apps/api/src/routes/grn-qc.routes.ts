import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { requirePermission, type AuthRequest } from '../middleware/auth'
import { writeAuditLog } from '../lib/audit'
import { assertStockUnused, balanceOf, recordMovement } from '../services/stock.service'
import { lockRow } from '../lib/lockRow'
import { REJECTED_GRADE, heldOf, liveQcOf, readQc, type QcData, type QcLine } from '../services/grnQc.service'
import { z } from 'zod'
import { cancelQcSchema, createQcSchema } from '../schemas/grn-qc.schemas'
import { REASON_RULES } from '../services/purchaseNote.service'
import { returnReasonOptions } from '../lib/returnReasons'

/** A reason code in words, or null for a check recorded before there was one. */
const reasonLabel = (code?: string | null) =>
  code && code in REASON_RULES ? REASON_RULES[code as keyof typeof REASON_RULES].label : null

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

/**
 * Goods moved between good (A) and rejected (R) in the store they are in:
 * out of one grade, in to the other at the value they went out at — a hold,
 * not a loss.
 */
async function regrade(
  tx: Prisma.TransactionClient,
  a: { itemId: string; warehouseId: string; qty: number; from: string; to: string; referenceType: string; referenceId: string; when: Date; notes: string },
) {
  const out = await recordMovement(tx, {
    itemId: a.itemId,
    warehouseId: a.warehouseId,
    transactionType: 'TRANSFER',
    direction: 'OUT',
    qty: a.qty,
    grade: a.from,
    referenceType: a.referenceType,
    referenceId: a.referenceId,
    transactionDate: a.when,
    notes: a.notes,
    // The rolls do not move: they stay on the rack with their stickers, held
    // as rejected or put back as good. What a check finds is a fact, so holds
    // do not stop it, and it is entered now if its date is earlier.
    stickers: 'caller',
    ignoreReservations: true,
    earlierDate: 'move-up',
  })
  await recordMovement(tx, {
    itemId: a.itemId,
    warehouseId: a.warehouseId,
    transactionType: 'TRANSFER',
    direction: 'IN',
    qty: a.qty,
    unitRate: out.unitRate,
    grade: a.to,
    referenceType: a.referenceType,
    referenceId: a.referenceId,
    transactionDate: a.when,
    notes: a.notes,
    earlierDate: 'move-up',
  })
}

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
      acceptedQty: true,
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
    // Rejects kept where they were received, held as rejected (not issuable).
    hold: d?.hold ?? null,
    cancelled: d?.cancelled ?? null,
    lines: (d?.lines ?? []).map((l) => ({
      ...l,
      ...lineInfo.get(l.grnLineId),
      reasonLabel: l.reasonName ?? reasonLabel(l.reasonCode),
    })),
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
      // The return challan's own reasons, so a rejection is recorded in the
      // words the challan that sends it back will use.
      reasons: await returnReasonOptions(prisma),
    },
  })
})

// ── Recording a check ───────────────────────────────────────────────────────

router.post('/', requirePermission(MODULE, 'create'), async (req: AuthRequest, res) => {
  const data = createQcSchema.parse(req.body)
  const when = data.inspectionDate ?? new Date()

  const qc = await prisma.$transaction(async (tx) => {
    // Two clicks at once would both find no check and record two.
    await lockRow(tx, 'grn', data.grnId)
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
      // What came into stock: anything turned away at the gate never did, and
      // a check cannot hold back or move what is not there.
      const accepted = Number(l.acceptedQty)
      const rejected = round3(sent.get(l.id)?.rejectedQty ?? 0)
      if (rejected > accepted + 0.0005) {
        throw new AppError(
          `${l.item.name}: ${rejected} rejected, but only ${accepted} ${l.item.uom?.symbol ?? ''} came into stock on ${grn.grnNumber}.`.replace(
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
        approvedQty: round3(accepted - rejected),
        rejectedQty: rejected,
        reason: rejected > 0 ? sent.get(l.id)?.reason?.trim() || null : null,
        reasonCode: rejected > 0 ? (sent.get(l.id)?.reasonCode ?? null) : null,
        reasonName: rejected > 0 ? sent.get(l.id)?.reasonLabel || null : null,
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

    // With no reject godown named, rejected goods stay where they are, held as
    // rejected so they cannot be issued — until they go back or are used after all.
    const hold = rejecting.length && !rejectWarehouseId ? ('SAME_STORE' as const) : null
    const payload: QcData = { version: 1, rejectWarehouseId, hold, lines }
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
        ignoreReservations: true,
        earlierDate: 'move-up',
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
        earlierDate: 'move-up',
      })
    }

    for (const l of hold ? rejecting : []) {
      await regrade(tx, {
        itemId: l.itemId,
        warehouseId: l.warehouseId,
        qty: l.rejectedQty,
        from: 'A',
        to: REJECTED_GRADE,
        referenceType: 'GRN_QC',
        referenceId: created.id,
        when,
        notes: `Rejected on QC of ${grn.grnNumber}${l.reason ? `: ${l.reason}` : ''}`,
      })
    }

    return { created, grn, rejecting, rejectWarehouseId, hold }
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

  const lineWord = `${qc.rejecting.length} line${qc.rejecting.length === 1 ? '' : 's'}`
  res.status(201).json({
    success: true,
    data: { id: qc.created.id, result: qc.created.result },
    message: !qc.rejecting.length
      ? `QC recorded on ${qc.grn.grnNumber} — everything passed.`
      : where
        ? `QC recorded on ${qc.grn.grnNumber}. ${lineWord} part or fully rejected — moved to ${where}. Send them back on a return challan from the bill.`
        : `QC recorded on ${qc.grn.grnNumber}. ${lineWord} part or fully rejected — held as rejected in the store, so they cannot be issued. Decide on them in Purchase → Rejected Goods: send them back, or use them after all.`,
  })
})

// ── Taking a check back ─────────────────────────────────────────────────────

router.post('/:id/cancel', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const { reason } = cancelQcSchema.parse(req.body ?? {})

  const out = await prisma.$transaction(async (tx) => {
    await lockRow(tx, 'inwardQc', req.params.id)
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
    if (d.hold === 'SAME_STORE') {
      const touched = d.lines.find((l) => (l.usedQty ?? 0) > 0 || (l.returnedQty ?? 0) > 0)
      if (touched) {
        const sent = [...new Set((touched.events ?? []).filter((e) => e.kind === 'RETURNED').map((e) => e.refNumber).filter(Boolean))]
        throw new AppError(
          `Some of what this check rejected has already been ${(touched.returnedQty ?? 0) > 0 ? `sent back${sent.length ? ` on ${sent.join(', ')}` : ''}` : 'used after all'}, so the check stands.` +
            ((touched.returnedQty ?? 0) > 0 ? ' Cancel that return challan first.' : ''),
          409,
          'QC_REJECTS_SETTLED',
        )
      }
      for (const l of d.lines) {
        if (!(l.rejectedQty > 0)) continue
        await regrade(tx, {
          itemId: l.itemId,
          warehouseId: l.warehouseId,
          qty: l.rejectedQty,
          from: REJECTED_GRADE,
          to: 'A',
          referenceType: 'GRN_QC_CANCELLED',
          referenceId: row.id,
          when: now,
          notes: `QC of ${row.grn.grnNumber} cancelled: ${reason}`,
        })
      }
    }
    // From a reject godown the rejects come back only while every one of them
    // is still there. Sent back to the supplier, they are gone; and the
    // godown's other rejects, from other receipts, must not stand in for them
    // and become good stock.
    if (d.rejectWarehouseId && d.lines.some((l) => l.rejectedQty > 0)) {
      const sentBack = await tx.purchaseReturnLine.findMany({
        where: {
          warehouseId: d.rejectWarehouseId,
          billLine: { grnLineId: { in: d.lines.filter((l) => l.rejectedQty > 0).map((l) => l.grnLineId) } },
          purchaseReturn: { cancelledAt: null },
        },
        select: { purchaseReturn: { select: { returnNumber: true } } },
      })
      if (sentBack.length) {
        const nos = [...new Set(sentBack.map((r) => r.purchaseReturn.returnNumber))]
        throw new AppError(
          `Some of what this check rejected has already been sent back on ${nos.join(', ')}, so the check stands. Cancel that return challan first.`,
          409,
          'QC_REJECTS_SETTLED',
        )
      }
      await assertStockUnused(tx, {
        referenceId: row.id,
        label: `the check of ${row.grn.grnNumber}`,
        suggestion: 'Move back only what is still in the reject godown, with a stock transfer.',
      })
    }
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
        earlierDate: 'move-up',
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
        earlierDate: 'move-up',
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

// ── Rejected goods ──────────────────────────────────────────────────────────

/**
 * Everything a quality check rejected, and what became of it: still held,
 * used after all, or sent back to the supplier. `view=held` for only what is
 * still waiting for a decision.
 */
router.get('/rejected', requirePermission(MODULE, 'view'), async (req, res) => {
  const heldOnly = req.query.view !== 'all'
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''
  const checks = await prisma.inwardQC.findMany({
    where: { result: { in: ['CONDITIONAL_PASS', 'FAIL'] } },
    orderBy: { inspectionDate: 'desc' },
    take: 1000,
    select: {
      id: true,
      inspectionDate: true,
      inspectedBy: true,
      checklistData: true,
      grn: {
        select: {
          id: true,
          grnNumber: true,
          grnDate: true,
          challanNo: true,
          po: { select: { poNumber: true, supplier: { select: { id: true, name: true } } } },
        },
      },
    },
  })
  type Row = { check: (typeof checks)[number]; d: QcData; l: QcLine }
  const rows: Row[] = []
  for (const check of checks) {
    const d = readQc(check.checklistData)
    if (!d || d.cancelled) continue
    for (const l of d.lines) if (l.rejectedQty > 0) rows.push({ check, d, l })
  }
  const itemIds = [...new Set(rows.map((r) => r.l.itemId))]
  const storeIds = [...new Set(rows.flatMap((r) => [r.l.warehouseId, r.d.rejectWarehouseId].filter((x): x is string => !!x)))]
  const grnLineIds = rows.map((r) => r.l.grnLineId)
  const [items, stores, billLines] = await Promise.all([
    prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, uom: { select: { symbol: true } } } }),
    prisma.warehouse.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true } }),
    prisma.purchaseInvoiceLine.findMany({
      where: { grnLineId: { in: grnLineIds }, bill: { status: { not: 'CANCELLED' } } },
      select: { grnLineId: true, bill: { select: { id: true, billNumber: true, supplierInvoiceNo: true } } },
    }),
  ])
  const itemOf = new Map(items.map((i) => [i.id, i]))
  const storeOf = new Map(stores.map((s) => [s.id, s.name]))
  const billOf = new Map(billLines.map((b) => [b.grnLineId, b.bill]))
  const shaped = rows
    .map(({ check, d, l }) => {
      const item = itemOf.get(l.itemId)
      const held = d.hold === 'SAME_STORE' ? heldOf(l) : null
      return {
        qcId: check.id,
        grnLineId: l.grnLineId,
        checkedOn: check.inspectionDate,
        checkedBy: check.inspectedBy,
        grn: { id: check.grn.id, grnNumber: check.grn.grnNumber, grnDate: check.grn.grnDate, challanNo: check.grn.challanNo, poNumber: check.grn.po.poNumber },
        supplier: check.grn.po.supplier,
        item: { id: l.itemId, code: item?.code ?? '', name: item?.name ?? '', unit: item?.uom?.symbol ?? '' },
        store: { id: l.warehouseId, name: storeOf.get(l.warehouseId) ?? '' },
        // Where they are kept: held in the same store, or moved to a reject godown.
        heldIn: d.hold === 'SAME_STORE' ? 'SAME_STORE' : d.rejectWarehouseId ? 'GODOWN' : 'NOTED',
        godown: d.rejectWarehouseId ? (storeOf.get(d.rejectWarehouseId) ?? null) : null,
        rejected: l.rejectedQty,
        used: l.usedQty ?? 0,
        returned: l.returnedQty ?? 0,
        held,
        reason: l.reasonName ?? l.reason ?? null,
        note: l.reason ?? null,
        bill: billOf.get(l.grnLineId) ?? null,
        events: l.events ?? [],
      }
    })
    .filter((r) => !heldOnly || (r.held ?? r.rejected) > 0.0005)
    .filter((r) => !q || [r.grn.grnNumber, r.grn.challanNo, r.grn.poNumber, r.supplier.name, r.item.code, r.item.name, r.store.name, r.reason].some((v) => (v ?? '').toLowerCase().includes(q)))
  const all = rows.filter(({ d, l }) => d.hold === 'SAME_STORE' && heldOf(l) > 0.0005)
  res.json({
    success: true,
    data: shaped,
    summary: { heldLines: all.length, heldReceipts: new Set(all.map((r) => r.check.grn.id)).size },
  })
})

const useSchema = z.object({
  grnLineId: z.string().min(1),
  qty: z.number().positive('Say how much is used after all'),
  reason: z.string().trim().min(5, 'Say why it can be used after all — at least a few words').max(500),
})

/**
 * Rejected goods used after all — the shade is close enough for this order,
 * the supplier agreed a rate cut — back into good stock where they are.
 */
router.post('/:id/use', requirePermission(MODULE, 'edit'), async (req: AuthRequest, res) => {
  const data = useSchema.parse(req.body)
  const out = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM ld_erp.inward_qc WHERE id = ${req.params.id} FOR UPDATE`
    const row = await tx.inwardQC.findUnique({ where: { id: req.params.id }, include: { grn: { select: { grnNumber: true } } } })
    if (!row) throw new AppError('That check does not exist', 404, 'NOT_FOUND')
    const d = readQc(row.checklistData)
    if (!d || d.cancelled) throw new AppError('That check is cancelled', 409, 'QC_CANCELLED')
    if (d.hold !== 'SAME_STORE') {
      throw new AppError('These rejected goods were moved to a reject godown. Move them back with a stock transfer.', 409, 'NOT_HELD')
    }
    const l = d.lines.find((x) => x.grnLineId === data.grnLineId)
    if (!l || !(l.rejectedQty > 0)) throw new AppError('That line was not rejected on this check', 400, 'NOT_REJECTED')
    const held = heldOf(l)
    if (data.qty > held + 0.0005) throw new AppError(`Only ${held} is still held as rejected on this line.`, 400, 'MORE_THAN_HELD')
    const qty = round3(data.qty)
    const now = new Date()
    await regrade(tx, {
      itemId: l.itemId,
      warehouseId: l.warehouseId,
      qty,
      from: REJECTED_GRADE,
      to: 'A',
      referenceType: 'GRN_QC_USED',
      referenceId: row.id,
      when: now,
      notes: `Rejected on QC of ${row.grn.grnNumber}, used after all: ${data.reason}`,
    })
    l.usedQty = round3((l.usedQty ?? 0) + qty)
    l.events = [...(l.events ?? []), { at: now.toISOString(), by: req.user?.name ?? '', kind: 'USED', qty, note: data.reason }]
    await tx.inwardQC.update({ where: { id: row.id }, data: { checklistData: d as unknown as Prisma.InputJsonValue } })
    const item = await tx.item.findUnique({ where: { id: l.itemId }, select: { name: true, uom: { select: { symbol: true } } } })
    return { row, qty, item, left: heldOf(l) }
  })
  await writeAuditLog(req, { module: MODULE, action: 'UPDATE', entityType: 'InwardQC', entityId: out.row.id, after: { used: out.qty, grnLineId: data.grnLineId, reason: data.reason } })
  const unit = out.item?.uom?.symbol ?? ''
  res.json({
    success: true,
    message: `${out.qty} ${unit} of ${out.item?.name ?? 'the item'} from ${out.row.grn.grnNumber} is back in good stock.${out.left > 0 ? ` ${out.left} ${unit} is still held as rejected.` : ''}`,
  })
})

export default router
