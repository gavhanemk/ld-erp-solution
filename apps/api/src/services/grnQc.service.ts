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
  /** The checker's own words — "shade mismatch", "holes in 3 rolls". */
  reason: string | null
  /**
   * Why it was rejected, as one of the return challan's reasons, so the
   * challan that sends it back starts on the same one. Absent on checks
   * recorded before the checker picked one.
   */
  reasonCode?: string | null
  /** The mill's own name for that reason, when one from Dropdown Lists was picked. */
  reasonName?: string | null
  /** Of what was rejected: taken back into good stock after all. */
  usedQty?: number
  /** Of what was rejected: sent back to the supplier on return challans. */
  returnedQty?: number
  /** What became of the rejected goods, in order. */
  events?: QcEvent[]
}

/** One decision on rejected goods. */
export interface QcEvent {
  at: string
  by: string
  kind: 'USED' | 'RETURNED' | 'RETURN_CANCELLED'
  qty: number
  note?: string | null
  /** The return challan, for a send-back. */
  ref?: string | null
  refNumber?: string | null
}

export interface QcData {
  version: 1
  rejectWarehouseId: string | null
  /**
   * SAME_STORE: the rejected goods stay where they were received, held as
   * rejected (grade R) so they cannot be issued. Checks recorded before this
   * have no hold: they either moved to a reject godown or only noted.
   */
  hold?: 'SAME_STORE' | null
  lines: QcLine[]
  cancelled?: { at: string; byId: string; byName: string; reason: string }
}

/**
 * The grade rejected goods are held under, in the store they came into.
 * Every balance that issues stock reads grade A, so held goods cannot be
 * issued by mistake, yet they stay on the books where they physically are.
 */
export const REJECTED_GRADE = 'R'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** Rejected goods still held: rejected, less used after all, less sent back. */
export const heldOf = (l: QcLine) => r3(l.rejectedQty - (l.usedQty ?? 0) - (l.returnedQty ?? 0))

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
): Promise<
  Map<
    string,
    {
      qty: number
      warehouseId: string | null
      reasonCode: string | null
      reasonName: string | null
      note: string | null
    }
  >
> {
  const out = new Map<
    string,
    {
      qty: number
      warehouseId: string | null
      reasonCode: string | null
      reasonName: string | null
      note: string | null
    }
  >()
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
      // Held in the store: only what is still held is there to send back.
      const qty = d.hold === 'SAME_STORE' ? heldOf(l) : l.rejectedQty
      if (!(qty > 0)) continue
      out.set(l.grnLineId, {
        qty: (prev?.qty ?? 0) + qty,
        warehouseId: d.rejectWarehouseId,
        reasonCode: l.reasonCode ?? prev?.reasonCode ?? null,
        reasonName: l.reasonName ?? prev?.reasonName ?? null,
        note: l.reason ?? prev?.note ?? null,
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

/**
 * A return challan sending back goods a check rejected and held in the
 * store: of `qty` going back on this receipt line from this store, how much
 * comes out of the held rejected goods — all of it, up to what is held. The
 * check records it as sent back. The rest of the challan, if any, is good
 * stock going back for another reason.
 */
export async function creditReturn(
  tx: Prisma.TransactionClient,
  a: { grnLineId: string; warehouseId: string; qty: number; returnId: string; returnNumber: string; by: string },
): Promise<number> {
  const line = await tx.gRNLine.findUnique({ where: { id: a.grnLineId }, select: { grnId: true } })
  if (!line) return 0
  const qc = await liveQcOf(tx, line.grnId)
  const d = qc ? readQc(qc.checklistData) : null
  if (!qc || !d || d.hold !== 'SAME_STORE') return 0
  const l = d.lines.find((x) => x.grnLineId === a.grnLineId && x.warehouseId === a.warehouseId)
  if (!l) return 0
  const take = r3(Math.min(a.qty, heldOf(l)))
  if (!(take > 0)) return 0
  l.returnedQty = r3((l.returnedQty ?? 0) + take)
  l.events = [...(l.events ?? []), { at: new Date().toISOString(), by: a.by, kind: 'RETURNED', qty: take, ref: a.returnId, refNumber: a.returnNumber }]
  await tx.inwardQC.update({ where: { id: qc.id }, data: { checklistData: d as unknown as Prisma.InputJsonValue } })
  return take
}

/** A return challan cancelled: what it sent back from held rejected goods is held again. */
export async function uncreditReturn(
  tx: Prisma.TransactionClient,
  a: { grnLineIds: string[]; returnId: string; returnNumber: string; by: string },
) {
  if (!a.grnLineIds.length) return
  const checks = await tx.inwardQC.findMany({
    where: { grn: { lines: { some: { id: { in: a.grnLineIds } } } } },
    select: { id: true, checklistData: true },
  })
  for (const c of checks) {
    const d = readQc(c.checklistData)
    if (!d || d.cancelled || d.hold !== 'SAME_STORE') continue
    let changed = false
    for (const l of d.lines) {
      const sent = (l.events ?? []).filter((e) => e.kind === 'RETURNED' && e.ref === a.returnId).reduce((s, e) => s + e.qty, 0)
      const undone = (l.events ?? []).filter((e) => e.kind === 'RETURN_CANCELLED' && e.ref === a.returnId).reduce((s, e) => s + e.qty, 0)
      const back = r3(sent - undone)
      if (!(back > 0)) continue
      l.returnedQty = r3(Math.max(0, (l.returnedQty ?? 0) - back))
      l.events = [...(l.events ?? []), { at: new Date().toISOString(), by: a.by, kind: 'RETURN_CANCELLED', qty: back, ref: a.returnId, refNumber: a.returnNumber }]
      changed = true
    }
    if (changed) await tx.inwardQC.update({ where: { id: c.id }, data: { checklistData: d as unknown as Prisma.InputJsonValue } })
  }
}
