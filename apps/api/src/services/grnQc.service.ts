import type { Prisma } from '@prisma/client'
import { AppError } from '../middleware/errorHandler'

/**
 * Quality check on a goods receipt — optional, after the goods are in.
 *
 * Kept on `InwardQC`, one row per check, with the per-line figures in its
 * `checklistData`. The table was in the schema from the start and never used;
 * holding the lines as data on it meant QC needed no change to the shared
 * database.
 *
 * What QC does NOT touch is `GRNLine.rejectedQty`. That field means goods
 * refused at the gate — never put in stock, never billed — and the debit-note
 * rules for a receipt with no bill lean on exactly that. Goods rejected on QC
 * were received, are in stock and will be billed in full; they go back on a
 * return challan against the bill. Writing them into the gate field would let
 * the same goods be noted against the receipt and returned against the bill.
 *
 * A check is cancelled rather than deleted, so the history of who passed what
 * survives. `cancelled` on the data marks it; everything that asks for "the"
 * QC of a receipt means the one that is not cancelled.
 */

export interface QcLine {
  grnLineId: string
  itemId: string
  warehouseId: string
  receivedQty: number
  approvedQty: number
  rejectedQty: number
  reason: string | null
}

export interface QcData {
  version: 1
  rejectWarehouseId: string | null
  lines: QcLine[]
  cancelled?: { at: string; byId: string; byName: string; reason: string }
}

/** The data on a check, or null for a row written some other way. */
export function readQc(raw: unknown): QcData | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Partial<QcData>
  if (d.version !== 1 || !Array.isArray(d.lines)) return null
  return d as QcData
}

export const isLiveQc = (raw: unknown) => {
  const d = readQc(raw)
  return Boolean(d && !d.cancelled)
}

/** Worded once, so the screen and the reports say the same thing. */
export const QC_RESULT_WORDS: Record<string, string> = {
  PASS: 'Passed',
  CONDITIONAL_PASS: 'Part rejected',
  FAIL: 'Rejected',
}

/** The check that currently stands on a receipt, if any. */
export async function liveQcOf(tx: Prisma.TransactionClient, grnId: string) {
  const rows = await tx.inwardQC.findMany({
    where: { grnId },
    orderBy: { createdAt: 'desc' },
  })
  return rows.find((r) => isLiveQc(r.checklistData)) ?? null
}

/**
 * A receipt that has been through QC cannot be corrected, cancelled or
 * deleted underneath it — the check moved stock out of the receipt's own
 * godowns on the strength of its quantities. Cancel the check first.
 */
export async function refuseIfInspected(
  tx: Prisma.TransactionClient,
  grn: { id: string; grnNumber: string },
  what: 'corrected' | 'cancelled' | 'deleted'
) {
  const qc = await liveQcOf(tx, grn.id)
  if (!qc) return
  const day = qc.inspectionDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
  throw new AppError(
    `${grn.grnNumber} has been through QC (${day}), so it cannot be ${what}. Cancel the QC first — its rejected goods move back — then put the receipt right.`,
    409,
    'GRN_INSPECTED'
  )
}

/**
 * What live checks rejected, per receipt line, and where the goods were put.
 *
 * For the return challan: goods rejected on QC are the commonest thing sent
 * back, and they are sitting in the reject godown rather than the one the
 * receipt named.
 */
export async function qcRejectedByGrnLine(
  tx: Prisma.TransactionClient,
  grnLineIds: string[]
): Promise<Map<string, { qty: number; warehouseId: string | null }>> {
  const out = new Map<string, { qty: number; warehouseId: string | null }>()
  if (!grnLineIds.length) return out
  const checks = await tx.inwardQC.findMany({
    where: { grn: { lines: { some: { id: { in: grnLineIds } } } } },
    select: { checklistData: true },
  })
  const wanted = new Set(grnLineIds)
  for (const c of checks) {
    const d = readQc(c.checklistData)
    if (!d || d.cancelled) continue
    for (const l of d.lines) {
      if (!wanted.has(l.grnLineId) || !(l.rejectedQty > 0)) continue
      const prev = out.get(l.grnLineId)
      out.set(l.grnLineId, {
        qty: (prev?.qty ?? 0) + l.rejectedQty,
        warehouseId: d.rejectWarehouseId,
      })
    }
  }
  return out
}

/** The short form the receipt list carries: enough for a badge and an action. */
export function qcSummaryOf(
  rows: Array<{ id: string; result: string; inspectionDate: Date; checklistData: unknown }>
) {
  const live = rows.find((r) => isLiveQc(r.checklistData))
  if (!live) return null
  const d = readQc(live.checklistData)!
  return {
    id: live.id,
    result: live.result,
    inspectionDate: live.inspectionDate,
    rejectedQty: d.lines.reduce((s, l) => s + l.rejectedQty, 0),
  }
}
